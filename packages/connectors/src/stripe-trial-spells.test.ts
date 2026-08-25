import { describe, expect, it } from "vitest";

type TrialEvent = {
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
};

async function classifier() {
  const modulePath = "./stripe-trial-spells.js";
  const loaded = await import(modulePath).catch(() => null);
  expect(loaded, "stripe trial classifier module must exist").not.toBeNull();
  return loaded as {
    classifyStripeTrialEvents(input: {
      observedAt: string;
      events: TrialEvent[];
    }): {
      spells: Array<Record<string, unknown>>;
      unknownEventIds: string[];
      unavailableReason: string | null;
    };
  };
}

function event(overrides: Partial<TrialEvent> = {}): TrialEvent {
  return {
    eventId: "evt_start",
    eventType: "customer.subscription.updated",
    eventCreatedAt: "2026-08-01T00:00:00.000Z",
    subscriptionId: "sub_trial",
    customerId: "cus_trial",
    livemode: true,
    currentStatus: "trialing",
    previousStatus: "active",
    businessEligibleAtCapture: true,
    ...overrides,
  };
}

describe("Stripe trial spell classifier", () => {
  it("deduplicates replayed starts and preserves two distinct starts on one subscription", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-09-20T00:00:00.000Z",
      events: [
        event(),
        event(),
        event({
          eventId: "evt_end_1",
          eventCreatedAt: "2026-08-08T00:00:00.000Z",
          currentStatus: "active",
          previousStatus: "trialing",
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
        event({
          eventId: "evt_start_2",
          eventCreatedAt: "2026-09-01T00:00:00.000Z",
          currentStatus: "trialing",
          previousStatus: "active",
        }),
      ],
    });

    expect(result.unavailableReason).toBeNull();
    expect(result.spells).toHaveLength(2);
    expect(result.spells.map((spell) => spell.startEventId)).toEqual(["evt_start", "evt_start_2"]);
    expect(result.spells[0]).toMatchObject({
      startAt: "2026-08-01T00:00:00.000Z",
      effectiveEndAt: "2026-08-08T00:00:00.000Z",
      endAuthority: "observed_trial_transition",
    });
    expect(result.spells[1]).toMatchObject({ effectiveEndAt: null });
  });

  it("sorts newest-first delivery chronologically and treats an in-trial extension as schedule evidence", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-09-20T00:00:00.000Z",
      events: [
        event({
          eventId: "evt_end",
          eventCreatedAt: "2026-08-10T00:00:00.000Z",
          currentStatus: "paused",
          previousStatus: "trialing",
          trialEnd: "2026-08-10T00:00:00.000Z",
        }),
        event({
          eventId: "evt_extend",
          eventCreatedAt: "2026-08-03T00:00:00.000Z",
          currentStatus: "trialing",
          previousStatus: "trialing",
          trialEnd: "2026-08-10T00:00:00.000Z",
        }),
        event({ trialEnd: "2026-08-08T00:00:00.000Z" }),
      ],
    });

    expect(result.spells).toHaveLength(1);
    expect(result.spells[0]).toMatchObject({
      startEventId: "evt_start",
      scheduledTrialEnd: "2026-08-10T00:00:00.000Z",
      effectiveEndAt: "2026-08-10T00:00:00.000Z",
      terminalStatus: "paused",
    });
  });

  it("uses terminal ended_at before transition time and never uses cancellation-request time", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event(),
        event({
          eventId: "evt_cancel_request",
          eventCreatedAt: "2026-08-02T00:00:00.000Z",
          currentStatus: "trialing",
          previousStatus: "trialing",
          canceledAt: "2026-08-02T00:00:00.000Z",
        }),
        event({
          eventId: "evt_deleted",
          eventType: "customer.subscription.deleted",
          eventCreatedAt: "2026-08-05T00:00:00.000Z",
          currentStatus: "canceled",
          previousStatus: null,
          endedAt: "2026-08-04T23:59:00.000Z",
        }),
      ],
    });

    expect(result.spells[0]).toMatchObject({
      effectiveEndAt: "2026-08-04T23:59:00.000Z",
      endAuthority: "terminal_ended_at",
    });
  });

  it("fails ambiguous updates unknown instead of inventing a start and keeps trial_will_end diagnostic", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event({ previousStatus: null }),
        event({
          eventId: "evt_warning",
          eventType: "customer.subscription.trial_will_end",
          eventCreatedAt: "2026-08-04T00:00:00.000Z",
          currentStatus: "trialing",
          previousStatus: null,
          trialEnd: "2026-08-07T00:00:00.000Z",
        }),
      ],
    });

    expect(result.spells).toEqual([]);
    expect(result.unknownEventIds).toContain("evt_start");
    expect(result.unknownEventIds).not.toContain("evt_warning");
  });

  it("fails a source observation closed when explicit live and test events are mixed", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [event(), event({ eventId: "evt_test", subscriptionId: "sub_test", livemode: false })],
    });

    expect(result.spells).toEqual([]);
    expect(result.unavailableReason).toBe("mixed_livemode_source");
  });

  it("accepts exact duplicate delivery but fails conflicting payloads for one event id deterministically", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const exact = event();
    expect(classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [exact, { ...exact }],
    }).spells).toHaveLength(1);

    const conflict = event({ currentStatus: "active" });
    for (const events of [[exact, conflict], [conflict, exact]]) {
      const result = classifyStripeTrialEvents({
        observedAt: "2026-08-20T00:00:00.000Z",
        events,
      });
      expect(result.spells).toEqual([]);
      expect(result.unknownEventIds).toEqual(["evt_start"]);
      expect(result.unavailableReason).toBe("duplicate_event_conflict");
    }
  });

  it("fails missing mode and ambiguous paused/deleted snapshots closed", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const missingMode = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [event({ livemode: null })],
    });
    expect(missingMode.spells).toEqual([]);
    expect(missingMode.unavailableReason).toBe("missing_livemode_source");

    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event(),
        event({
          eventId: "evt_ambiguous_pause",
          eventType: "customer.subscription.paused",
          eventCreatedAt: "2026-08-05T00:00:00.000Z",
          currentStatus: "paused",
          previousStatus: null,
        }),
        event({
          eventId: "evt_ambiguous_delete",
          eventType: "customer.subscription.deleted",
          eventCreatedAt: "2026-08-06T00:00:00.000Z",
          currentStatus: "canceled",
          previousStatus: null,
          endedAt: null,
        }),
      ],
    });
    expect(result.spells[0]).toMatchObject({ effectiveEndAt: null });
    expect(result.unknownEventIds).toEqual(["evt_ambiguous_delete", "evt_ambiguous_pause"]);
  });

  // -------------------------------------------------------------------------------------------
  // Status-less mid-trial updates. LIVE SYMPTOM (2026-08-04): one such event in a 28-day history
  // set `incomplete_event_count = 1` and fail-closed the founder's ENTIRE trial funnel.
  // -------------------------------------------------------------------------------------------

  it("treats a status-less update on an OPEN trial as a no-op, not as unclassifiable", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    // The exact prod shape: `created` at status `trialing`, then an ordinary update 66 seconds
    // later whose `previous_attributes` carried no `status` (a payment method attached, metadata
    // edited, an item swapped) — Stripe reporting "the status did not change".
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event({
          eventId: "evt_created",
          eventType: "customer.subscription.created",
          eventCreatedAt: "2026-08-01T00:00:00.000Z",
          previousStatus: null,
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
        event({
          eventId: "evt_noop_update",
          eventCreatedAt: "2026-08-01T00:01:06.000Z",
          previousStatus: null,
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
        event({
          eventId: "evt_converted",
          eventCreatedAt: "2026-08-08T00:00:00.000Z",
          currentStatus: "active",
          previousStatus: "trialing",
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
      ],
    });

    expect(result.unknownEventIds).toEqual([]);
    expect(result.unavailableReason).toBeNull();
    expect(result.spells).toHaveLength(1);
    expect(result.spells[0]).toMatchObject({
      startEventId: "evt_created",
      startAt: "2026-08-01T00:00:00.000Z",
      effectiveEndAt: "2026-08-08T00:00:00.000Z",
      endEventId: "evt_converted",
      terminalStatus: "active",
    });
  });

  it("still fails closed on a status-less update with NO open spell to interpret it against", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    // Without an open spell the event is genuinely undecidable: it may be the `active -> trialing`
    // transition that STARTED a trial, and silently dropping that would undercount acquisition.
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [event({ eventId: "evt_orphan_update", previousStatus: null })],
    });

    expect(result.spells).toEqual([]);
    expect(result.unknownEventIds).toEqual(["evt_orphan_update"]);
  });

  it("carries a trial extension from a status-less mid-trial update", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event({
          eventId: "evt_created",
          eventType: "customer.subscription.created",
          eventCreatedAt: "2026-08-01T00:00:00.000Z",
          previousStatus: null,
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
        event({
          eventId: "evt_extended",
          eventCreatedAt: "2026-08-03T00:00:00.000Z",
          previousStatus: null,
          trialEnd: "2026-08-15T00:00:00.000Z",
        }),
      ],
    });

    expect(result.unknownEventIds).toEqual([]);
    expect(result.spells[0]).toMatchObject({
      scheduledTrialEnd: "2026-08-15T00:00:00.000Z",
      effectiveEndAt: null,
    });
  });

  it("does not call a status-less update a transition when it shares a second with the start", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    // A checkout burst can emit `created` and a follow-up `updated` in the SAME second. Counting
    // the status-less update as causal made that second "ambiguous" and blanked the whole source.
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event({
          eventId: "evt_created",
          eventType: "customer.subscription.created",
          eventCreatedAt: "2026-08-01T00:00:00.000Z",
          previousStatus: null,
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
        event({
          eventId: "evt_same_second_noop",
          eventCreatedAt: "2026-08-01T00:00:00.000Z",
          previousStatus: null,
          trialEnd: "2026-08-08T00:00:00.000Z",
        }),
      ],
    });

    expect(result.unavailableReason).toBeNull();
    expect(result.unknownEventIds).toEqual([]);
    expect(result.spells).toHaveLength(1);
  });

  it("does not infer causal start/end order from lexical event ids inside one second", async () => {
    const { classifyStripeTrialEvents } = await classifier();
    const result = classifyStripeTrialEvents({
      observedAt: "2026-08-20T00:00:00.000Z",
      events: [
        event({ eventId: "evt_z_start" }),
        event({
          eventId: "evt_a_end",
          eventCreatedAt: "2026-08-01T00:00:00.000Z",
          currentStatus: "active",
          previousStatus: "trialing",
        }),
      ],
    });
    expect(result.spells).toEqual([]);
    expect(result.unknownEventIds).toEqual(["evt_a_end", "evt_z_start"]);
    expect(result.unavailableReason).toBe("same_second_transition_ambiguity");
  });
});
