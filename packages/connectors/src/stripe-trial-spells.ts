export interface StripeTrialLifecycleEvidence {
  eventId: string;
  eventType: string;
  eventCreatedAt: string;
  subscriptionId: string;
  customerId: string | null;
  livemode: boolean | null;
  currentStatus: string | null;
  previousStatus: string | null;
  trialEnd?: string | null;
  endedAt?: string | null;
  canceledAt?: string | null;
  businessEligibleAtCapture: boolean;
}

export interface StripeTrialSpellClassification {
  subscriptionId: string;
  customerId: string | null;
  startEventId: string;
  startAt: string;
  scheduledTrialEnd: string | null;
  effectiveEndAt: string | null;
  endEventId: string | null;
  endAuthority: "terminal_ended_at" | "scheduled_trial_end" | "observed_trial_transition" | null;
  terminalStatus: string | null;
  livemode: boolean | null;
  businessEligibleAtCapture: boolean;
}

export interface StripeTrialClassificationResult {
  spells: StripeTrialSpellClassification[];
  unknownEventIds: string[];
  unavailableReason: string | null;
}

function iso(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nonFutureAtOrBefore(value: string | null | undefined, lower: string, upper: string): string | null {
  if (!value) return null;
  const normalized = iso(value);
  if (!normalized) return null;
  const timestamp = new Date(normalized).getTime();
  if (timestamp < new Date(lower).getTime() || timestamp > new Date(upper).getTime()) return null;
  return normalized;
}

export function classifyStripeTrialEvents(input: {
  observedAt: string;
  events: StripeTrialLifecycleEvidence[];
}): StripeTrialClassificationResult {
  const observedAt = iso(input.observedAt);
  if (!observedAt) throw new Error("Stripe trial observation time is invalid");

  const eventsById = new Map<string, StripeTrialLifecycleEvidence[]>();
  for (const event of input.events) {
    const grouped = eventsById.get(event.eventId) ?? [];
    grouped.push(event);
    eventsById.set(event.eventId, grouped);
  }
  const conflictingIds: string[] = [];
  const uniqueEvents: StripeTrialLifecycleEvidence[] = [];
  for (const [eventId, duplicates] of eventsById) {
    const fingerprints = new Set(duplicates.map((event) => JSON.stringify({
      eventType: event.eventType,
      eventCreatedAt: event.eventCreatedAt,
      subscriptionId: event.subscriptionId,
      customerId: event.customerId,
      livemode: event.livemode,
      currentStatus: event.currentStatus,
      previousStatus: event.previousStatus,
      trialEnd: event.trialEnd ?? null,
      endedAt: event.endedAt ?? null,
      canceledAt: event.canceledAt ?? null,
      businessEligibleAtCapture: event.businessEligibleAtCapture,
    })));
    if (fingerprints.size > 1) conflictingIds.push(eventId);
    else if (duplicates[0]) uniqueEvents.push(duplicates[0]);
  }
  if (conflictingIds.length > 0) {
    return {
      spells: [],
      unknownEventIds: conflictingIds.sort(),
      unavailableReason: "duplicate_event_conflict",
    };
  }
  const explicitModes = new Set(uniqueEvents.flatMap((event) => (
    typeof event.livemode === "boolean" ? [event.livemode] : []
  )));
  if (explicitModes.size > 1) {
    return { spells: [], unknownEventIds: [], unavailableReason: "mixed_livemode_source" };
  }
  if (uniqueEvents.some((event) => event.livemode === null)) {
    return { spells: [], unknownEventIds: [], unavailableReason: "missing_livemode_source" };
  }

  const causalBySubscriptionSecond = new Map<string, string[]>();
  for (const event of uniqueEvents) {
    const causal = (
      event.eventType === "customer.subscription.created" && event.currentStatus === "trialing"
    ) || (
      event.eventType === "customer.subscription.updated"
      // A null `previousStatus` means Stripe's `previous_attributes` carried no `status`, i.e. it
      // reported NO status change — so this update is not a transition and must not make its
      // second "ambiguous". Without this guard an ordinary mid-trial update landing in the same
      // second as the subscription's own `created` event (a routine checkout burst) would return
      // `same_second_transition_ambiguity` and blank the entire funnel. The main loop below still
      // fails closed on the one genuinely undecidable case (null previous, no open spell).
      && event.previousStatus !== null
      && (
        (event.currentStatus === "trialing" && event.previousStatus !== "trialing")
        || (event.previousStatus === "trialing" && event.currentStatus !== "trialing")
      )
    ) || event.eventType === "customer.subscription.deleted"
      || event.eventType === "customer.subscription.paused";
    const createdAt = iso(event.eventCreatedAt);
    if (!causal || !createdAt) continue;
    const key = `${event.subscriptionId}\u0000${createdAt}`;
    const ids = causalBySubscriptionSecond.get(key) ?? [];
    ids.push(event.eventId);
    causalBySubscriptionSecond.set(key, ids);
  }
  const sameSecondAmbiguities = [...causalBySubscriptionSecond.values()]
    .filter((ids) => ids.length > 1)
    .flat()
    .sort();
  if (sameSecondAmbiguities.length > 0) {
    return {
      spells: [],
      unknownEventIds: sameSecondAmbiguities,
      unavailableReason: "same_second_transition_ambiguity",
    };
  }

  const events = uniqueEvents
    .map((event) => ({ ...event, normalizedCreatedAt: iso(event.eventCreatedAt) }))
    .sort((left, right) => {
      const byTime = String(left.normalizedCreatedAt).localeCompare(String(right.normalizedCreatedAt));
      return byTime !== 0 ? byTime : left.eventId.localeCompare(right.eventId);
    });
  const spells: StripeTrialSpellClassification[] = [];
  const openBySubscription = new Map<string, StripeTrialSpellClassification>();
  const unknownEventIds = new Set<string>();

  for (const event of events) {
    if (!event.normalizedCreatedAt || event.normalizedCreatedAt > observedAt || !event.subscriptionId) {
      unknownEventIds.add(event.eventId);
      continue;
    }
    const open = openBySubscription.get(event.subscriptionId);
    const isCreatedStart = event.eventType === "customer.subscription.created"
      && event.currentStatus === "trialing";
    const isUpdatedStart = event.eventType === "customer.subscription.updated"
      && event.currentStatus === "trialing"
      && event.previousStatus !== null
      && event.previousStatus !== "trialing";

    if (isCreatedStart || isUpdatedStart) {
      if (open) {
        unknownEventIds.add(event.eventId);
        continue;
      }
      const spell: StripeTrialSpellClassification = {
        subscriptionId: event.subscriptionId,
        customerId: event.customerId,
        startEventId: event.eventId,
        startAt: event.normalizedCreatedAt,
        scheduledTrialEnd: nonFutureAtOrBefore(event.trialEnd, event.normalizedCreatedAt, observedAt)
          ?? (event.trialEnd ? iso(event.trialEnd) : null),
        effectiveEndAt: null,
        endEventId: null,
        endAuthority: null,
        terminalStatus: null,
        livemode: event.livemode,
        businessEligibleAtCapture: event.businessEligibleAtCapture,
      };
      spells.push(spell);
      openBySubscription.set(event.subscriptionId, spell);
      continue;
    }

    if (event.eventType === "customer.subscription.updated" && event.currentStatus === "trialing") {
      // `previousStatus` is `data.previous_attributes.status`, which Stripe populates ONLY when the
      // status actually changed — so a null here almost always means "this update did not touch
      // the status". It is not PROOF of that, though: we store only the extracted status, never
      // whether `previous_attributes` was observable at all, so a null is also what an unreadable
      // diff would look like. The open spell settles it:
      //
      //   • An OPEN spell is independent evidence that this subscription was ALREADY trialing
      //     before the event, so the event cannot be a trial START. It is an ordinary mid-trial
      //     update (a payment method attached, metadata edited, an item swapped, a schedule
      //     applied) — INTERPRETABLE, therefore skippable. This is the live 2026-08-04 symptom:
      //     one such event, 66 seconds after the trial's own `created` event, fail-closed the
      //     ENTIRE trial acquisition/conversion funnel for the founder's account.
      //   • With NO open spell we cannot rule out an `active -> trialing` transition whose start
      //     we would silently drop, so it STAYS unclassified. Fail closed.
      if (event.previousStatus === null && !open) {
        unknownEventIds.add(event.eventId);
        continue;
      }
      // A mid-trial update carries the CURRENT `trial_end`, which is how a trial extension or
      // shortening reaches the spell. Applies to both the proven no-op (`previousStatus` is
      // "trialing") and the open-spell null case above — they are the same event shape.
      if (open) {
        const scheduled = event.trialEnd ? iso(event.trialEnd) : null;
        if (scheduled && scheduled >= open.startAt) open.scheduledTrialEnd = scheduled;
      }
      continue;
    }

    if (event.eventType === "customer.subscription.trial_will_end") {
      const scheduled = event.trialEnd ? iso(event.trialEnd) : null;
      if (open && scheduled && scheduled >= open.startAt) open.scheduledTrialEnd = scheduled;
      continue;
    }

    const isUnambiguousPause = event.eventType === "customer.subscription.paused"
      && event.previousStatus === "trialing"
      && event.currentStatus === "paused";
    const isUnambiguousDelete = event.eventType === "customer.subscription.deleted"
      && (event.previousStatus === "trialing" || Boolean(event.endedAt));
    const observedEnd = Boolean(open) && (
      isUnambiguousDelete
      || isUnambiguousPause
      || (
        event.eventType === "customer.subscription.updated"
        && event.previousStatus === "trialing"
        && event.currentStatus !== null
        && event.currentStatus !== "trialing"
      )
    );
    if (!observedEnd || !open) {
      if (open && (
        event.eventType === "customer.subscription.deleted"
        || event.eventType === "customer.subscription.paused"
      )) unknownEventIds.add(event.eventId);
      continue;
    }

    let effectiveEndAt: string;
    let endAuthority: StripeTrialSpellClassification["endAuthority"];
    if (event.endedAt) {
      const endedAt = nonFutureAtOrBefore(
        event.endedAt,
        open.startAt,
        event.normalizedCreatedAt,
      );
      if (!endedAt) {
        unknownEventIds.add(event.eventId);
        continue;
      }
      effectiveEndAt = endedAt;
      endAuthority = "terminal_ended_at";
    } else {
      const trialEnd = nonFutureAtOrBefore(
        event.trialEnd,
        open.startAt,
        event.normalizedCreatedAt,
      );
      if (trialEnd) {
        effectiveEndAt = trialEnd;
        endAuthority = "observed_trial_transition";
      } else {
        effectiveEndAt = event.normalizedCreatedAt;
        endAuthority = "observed_trial_transition";
      }
    }
    open.effectiveEndAt = effectiveEndAt;
    open.endEventId = event.eventId;
    open.endAuthority = endAuthority;
    open.terminalStatus = event.currentStatus;
    open.scheduledTrialEnd = event.trialEnd ? iso(event.trialEnd) : open.scheduledTrialEnd;
    openBySubscription.delete(event.subscriptionId);
  }

  return {
    spells,
    unknownEventIds: [...unknownEventIds].sort(),
    unavailableReason: null,
  };
}
