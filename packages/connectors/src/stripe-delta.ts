import { randomUUID } from "node:crypto";
import type { InfiniteOsDb } from "@infinite-os/db";

/**
 * Stripe DELTA-FIRST sync lane.
 *
 * After one full import, steady-state Stripe sync stops re-listing the account. Each run polls
 * ONE UNFILTERED `/v1/events` stream over a fixed half-open second-aligned window, stores the
 * relevant events as immutable evidence, dedupes the changed-object keys, re-fetches only those
 * objects' CURRENT state through the SAME extract-row builders the full sync uses, and advances
 * a watermark. Full refresh drops to at most daily plus documented triggers.
 *
 * WHY UNFILTERED. Stripe's `/v1/events` list accepts at most 20 entries in `types[]`
 * (docs.stripe.com/api/events/list). Our relevant set is larger than that — see
 * STRIPE_DELTA_RELEVANT_EVENT_TYPE_COUNT_RATIONALE and the test that pins it — so a filtered
 * poll would have to be split into several requests, multiplying reads against an allowance
 * that is the whole reason this lane exists (500 reads per transaction rolling, 10,000/month
 * minimum allocation: docs.stripe.com/rate-limits). One unfiltered poll, filtered locally, is
 * strictly cheaper.
 *
 * EVIDENCE CONTRACT. Stored event payloads are IMMUTABLE HISTORICAL EVIDENCE (occurrence time,
 * type, `previous_attributes`). They NEVER establish current canonical state: current state
 * comes only from object retrieval or reconciliation, and those always win. The MRR movement
 * classifier deliberately keeps its SETTLED-STATE semantics (an intra-window $50 -> $80 -> $60
 * settles to one $50 -> $60 contraction) and does not read this evidence today; it is stored so
 * a future classifier upgrade does not need a retention-expired event stream.
 */

// ---------------------------------------------------------------------------------------------
// Windowing constants
// ---------------------------------------------------------------------------------------------

/**
 * The Stripe Events list is eventually consistent: an event can become listable a short while
 * after its `created` second. Without a lag a window would close over instants Stripe had not
 * finished indexing, and a late-indexed event would fall into a permanent hole. Both margins are
 * EMPIRICAL, not documented Stripe guarantees — tune them from late-event telemetry.
 *
 * These two constants are the unified successors of the per-lane
 * `STRIPE_{INVOICE,TRIAL}_EVENT_{SAFETY_LAG,OVERLAP}_MS` pairs, which all held the same value.
 */
export const STRIPE_EVENT_SAFETY_LAG_MS = 5 * 60 * 1000;
export const STRIPE_EVENT_OVERLAP_MS = 5 * 60 * 1000;

/** Stripe retains events for 30 days; we treat 28 as the safe floor and 30 as the hard floor. */
export const STRIPE_EVENT_SAFE_RETENTION_DAYS = 28;
export const STRIPE_EVENT_HARD_RETENTION_DAYS = 30;

/**
 * Cadence of the FULL refresh once delta is healthy. A full replacement costs ~30 reads; at
 * daily that is ~900 reads/month, which leaves the bulk of a minimum-allocation account's
 * 10,000 rolling monthly reads to the 15-minute delta lane (~1 events page + a handful of
 * retrieves per run). Anything faster than daily eats the delta lane's budget for a snapshot
 * the delta lane already maintains.
 */
export const STRIPE_FULL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bounded pages per run: the segment is durable and resumable, so a busy account catches up. */
export const STRIPE_DELTA_MAX_PAGES = 5;

/** Stripe publishes no batch-retrieve endpoint, so changed objects are fetched one by one. */
export const STRIPE_DELTA_REFETCH_CONCURRENCY = 4;

/**
 * PER-RUN REFETCH BUDGET. Concurrency bounds how many retrieves are in flight, NOT how many are
 * issued: Stripe emits no event on the subscriptions a `price.*` or `coupon.*` edit affects, so the
 * local reverse index can legitimately fan ONE event out to every subscription that references the
 * changed object. A single price edit on a 1,000-subscriber account would issue 1,000+ retrieves in
 * one run.
 *
 * 200 is the crossover, not a guess: a FULL refresh of a whole account costs ~30 reads (the
 * subscription/invoice list pages plus item pages), so a delta run past ~200 individual retrieves
 * is already >6x more expensive than the snapshot it is trying to avoid — and it would do that
 * against the 500-reads-per-rolling-transaction allowance this lane exists to protect. Past the
 * budget the FULL lane is STRICTLY cheaper and strictly more complete, so the delta run aborts
 * BEFORE issuing any retrieve (a half-applied window is the one outcome worth avoiding) and marks
 * the source for the full lane.
 */
export const STRIPE_DELTA_MAX_REFETCH_PER_RUN = 200;

export const STRIPE_DELTA_PARSER_VERSION = "stripe-delta-events-v1";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Second-align a millisecond instant DOWN — Stripe `created` filters are whole seconds. */
export function stripeEventSecondBoundary(timestampMs: number): number {
  return Math.floor(timestampMs / 1_000) * 1_000;
}

export function isStripeEventSecondBoundary(timestampMs: number): boolean {
  return Number.isFinite(timestampMs) && timestampMs % 1_000 === 0;
}

export function stripeTimestampMs(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------------------------
// Request telemetry
// ---------------------------------------------------------------------------------------------

export interface StripeEndpointTelemetry {
  requests: number;
  pages: number;
  rateLimited: number;
}

/**
 * The reconciliation half of the run's telemetry. Null on every run that did not reconcile, which
 * keeps "did not reconcile" distinguishable from "reconciled and found nothing" — the second is
 * the healthy signal the relax-daily-to-weekly decision counts, the first is not.
 *
 * `unevaluatedDeletions` is deliberately surfaced next to the drift counts: a clean run whose
 * remote sets were mostly partial has proven far less than a clean run against complete lists, and
 * a reader that could not tell them apart would relax the cadence on evidence it never had.
 */
export interface StripeReconciliationTelemetry {
  due: boolean;
  /** `StripeReconciliationDueReason` from ./stripe-reconcile.ts, kept as a string to avoid a cycle. */
  reason: string | null;
  applied: boolean;
  driftCount: number;
  repairedCount: number;
  recordedOnlyCount: number;
  /**
   * Drift this run's own full replacement had already healed before CLOSE measured it — visible
   * only because the comparison is taken against a PRE-LOAD projection. Zero total drift is the
   * relax-to-weekly signal; this is the count that used to be silently missing from it.
   */
  healedByLoadCount: number;
  countsByKind: Record<string, number>;
  unevaluatedDeletions: number;
  unevaluatedDeletionReasons: Record<string, number>;
}

export interface StripeRequestTelemetrySnapshot {
  version: "stripe-request-telemetry-v1";
  lane: StripeSyncLane | null;
  laneReason: StripeLaneReason | null;
  requests: number;
  pages: number;
  objectsRefetched: number;
  eventsObserved: number;
  rateLimited: number;
  rateLimitedReasons: Record<string, number>;
  byEndpointClass: Record<string, StripeEndpointTelemetry>;
  reconciliation: StripeReconciliationTelemetry | null;
}

/**
 * Collapse a concrete Stripe path to its ENDPOINT CLASS: `/v1/invoices/in_123` -> `/v1/invoices/{id}`.
 * Object ids are high-cardinality and would make the telemetry unaggregatable.
 */
export function stripeEndpointClass(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return `/${segments.map((segment, index) => (index >= 2 ? "{id}" : segment)).join("/")}`;
}

/**
 * Per-run Stripe request accounting. Every method is a total counter mutation: telemetry must
 * never be able to fail a sync, so nothing here throws, allocates unboundedly, or does I/O.
 */
export class StripeRequestTelemetry {
  private lane: StripeSyncLane | null = null;
  private laneReason: StripeLaneReason | null = null;
  private requests = 0;
  private pages = 0;
  private objectsRefetched = 0;
  private eventsObserved = 0;
  private rateLimited = 0;
  private reconciliation: StripeReconciliationTelemetry | null = null;
  private readonly rateLimitedReasons = new Map<string, number>();
  private readonly byEndpointClass = new Map<string, StripeEndpointTelemetry>();

  setLane(lane: StripeSyncLane, reason: StripeLaneReason): void {
    this.lane = lane;
    this.laneReason = reason;
  }

  /** Stamped at PLAN time. A run that ends before CLOSE keeps `applied: false` — it never lies. */
  setReconciliationDue(reason: string): void {
    this.reconciliation = {
      due: true,
      reason,
      applied: false,
      driftCount: 0,
      repairedCount: 0,
      recordedOnlyCount: 0,
      healedByLoadCount: 0,
      countsByKind: {},
      unevaluatedDeletions: 0,
      unevaluatedDeletionReasons: {},
    };
  }

  /** Stamped at CLOSE, from the outcome `applyReconciliation` returned. */
  recordReconciliationOutcome(outcome: {
    driftCount: number;
    repairedCount: number;
    recordedOnlyCount: number;
    healedByLoadCount: number;
    countsByKind: Record<string, number>;
    unevaluatedDeletionReasons: string[];
  }): void {
    const reasons: Record<string, number> = {};
    for (const reason of outcome.unevaluatedDeletionReasons) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    this.reconciliation = {
      due: true,
      reason: this.reconciliation?.reason ?? null,
      applied: true,
      driftCount: outcome.driftCount,
      repairedCount: outcome.repairedCount,
      recordedOnlyCount: outcome.recordedOnlyCount,
      healedByLoadCount: outcome.healedByLoadCount,
      countsByKind: { ...outcome.countsByKind },
      unevaluatedDeletions: outcome.unevaluatedDeletionReasons.length,
      unevaluatedDeletionReasons: Object.fromEntries(
        Object.entries(reasons).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
  }

  recordRequest(path: string): void {
    this.requests += 1;
    this.bucket(path).requests += 1;
  }

  /** A LIST response that was one page of a paginated read. */
  recordPage(path: string): void {
    this.pages += 1;
    this.bucket(path).pages += 1;
  }

  recordRateLimited(path: string, reason: string | null): void {
    this.rateLimited += 1;
    this.bucket(path).rateLimited += 1;
    const key = reason && reason.trim() !== "" ? reason.trim() : "unreported";
    this.rateLimitedReasons.set(key, (this.rateLimitedReasons.get(key) ?? 0) + 1);
  }

  recordObjectsRefetched(count: number): void {
    if (Number.isFinite(count) && count > 0) this.objectsRefetched += count;
  }

  recordEventsObserved(count: number): void {
    if (Number.isFinite(count) && count > 0) this.eventsObserved += count;
  }

  snapshot(): StripeRequestTelemetrySnapshot {
    return {
      version: "stripe-request-telemetry-v1",
      lane: this.lane,
      laneReason: this.laneReason,
      requests: this.requests,
      pages: this.pages,
      objectsRefetched: this.objectsRefetched,
      eventsObserved: this.eventsObserved,
      rateLimited: this.rateLimited,
      rateLimitedReasons: Object.fromEntries([...this.rateLimitedReasons.entries()].sort()),
      byEndpointClass: Object.fromEntries(
        [...this.byEndpointClass.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      reconciliation: this.reconciliation === null ? null : { ...this.reconciliation },
    };
  }

  private bucket(path: string): StripeEndpointTelemetry {
    const key = stripeEndpointClass(path);
    const existing = this.byEndpointClass.get(key);
    if (existing) return existing;
    const created: StripeEndpointTelemetry = { requests: 0, pages: 0, rateLimited: 0 };
    this.byEndpointClass.set(key, created);
    return created;
  }
}

// ---------------------------------------------------------------------------------------------
// Lane selection
// ---------------------------------------------------------------------------------------------

export type StripeSyncLane = "full" | "delta";

export type StripeLaneReason =
  | "no_watermark"
  | "no_completed_full_import"
  | "full_refresh_interval_elapsed"
  | "delta_coverage_gap"
  // A previous DELTA run refused to fan out (see STRIPE_DELTA_MAX_REFETCH_PER_RUN) and parked a
  // durable demand for the full lane. DEMAND OUTRANKS CADENCE: this is checked before the daily
  // interval so the telemetry names why the run is full, not merely that a day elapsed.
  | "delta_fanout_exceeded"
  // A due full-set reconciliation forced the FULL lane on a source whose delta chain was HEALTHY.
  // Reported only in that case: when the run was going to be full anyway the more fundamental
  // reason wins, so `reconciliation_due` always means "delta was fine, reconciliation forced it".
  | "reconciliation_due"
  | "delta_healthy";

export type StripeCoverageGapReason =
  | "delta_watermark_missing"
  | "delta_watermark_unaligned"
  | "delta_watermark_beyond_event_retention"
  | "delta_segment_chain_broken"
  | "delta_segment_beyond_event_retention";

/**
 * The one durable demand a DELTA run can park for the next tick. Kept as a closed union rather than
 * free text so a marker can never be invented at a call site and silently pin a source to the
 * expensive lane forever.
 */
export type StripePendingFullRefreshReason = "delta_fanout_exceeded";

export function isStripePendingFullRefreshReason(
  value: unknown,
): value is StripePendingFullRefreshReason {
  return value === "delta_fanout_exceeded";
}

export interface StripeSyncWatermarkRow {
  delta_data_as_of: string | Date | null;
  last_full_refresh_at: string | Date | null;
  continuous_coverage_from: string | Date | null;
  /** Set by a delta run that refused to fan out; CLEARED by the full run that satisfies it. */
  pending_full_refresh_reason?: string | null;
}

export interface StripeEventSegmentRow {
  id: string;
  segment_from: string | Date;
  segment_to_exclusive: string | Date;
  pagination_cursor: string | null;
  /**
   * `open` = still resumable. `closed` = the delta lane observed the whole window through the event
   * stream. `superseded` = a FULL refresh re-derived canonical state across it, so the window no
   * longer needs polling (see the retirement in `writeStripeSyncLaneAtClose`).
   */
  status: "open" | "closed" | "superseded";
}

export interface StripeLaneDecision {
  lane: StripeSyncLane;
  reason: StripeLaneReason;
  /** Non-null only when the delta chain was found broken; recorded, never papered over. */
  coverageGapReason: StripeCoverageGapReason | null;
}

/**
 * Decide FULL vs DELTA. The scheduler stays dumb — it calls on a fixed interval and the
 * engine picks the lane, so the schedule never has to model Stripe state.
 *
 * FULL when: (a) there is no watermark row at all, (b) no completed full import
 * (`last_full_refresh_at` is null), (c) a delta coverage gap is detected, (d) a previous delta run
 * parked a `pending_full_refresh_reason` (today only `delta_fanout_exceeded`), (e) the last full
 * refresh is older than STRIPE_FULL_REFRESH_INTERVAL_MS, or (f) a full-set RECONCILIATION is due.
 * Otherwise DELTA.
 *
 * A coverage gap means the event chain cannot be continued: the watermark is missing, not
 * second-aligned (so it does not describe an interval Stripe was actually asked for), older than
 * the safe event retention floor, or an OPEN segment starts after the watermark (a hole) or has
 * itself aged past the hard retention floor. Gaps force a full refresh AND reset
 * `continuous_coverage_from` — the snapshot is repairable, the intervening event SEQUENCE is not
 * (Stripe list endpoints filter on `created`, never `updated`).
 *
 * RECONCILIATION RIDES THE FULL LANE, NEVER THE DELTA LANE. A drift comparison needs the complete
 * remote set; the delta lane only ever retrieves the handful of objects its events named, so a
 * plan computed from it would read every untouched object as `missing_remote`. `reconciliationDue`
 * therefore FORCES the full lane — it is the last reason checked so that a run which was already
 * full keeps its more fundamental reason, and `reconciliation_due` unambiguously means "the delta
 * chain was healthy and reconciliation is what upgraded this run".
 */
export function selectStripeSyncLane(input: {
  nowMs: number;
  watermark: StripeSyncWatermarkRow | null;
  openSegment: StripeEventSegmentRow | null;
  /** Decided by `reconciliationDue` in ./stripe-reconcile.ts; the integrator wires the triggers. */
  reconciliationDue?: boolean;
}): StripeLaneDecision {
  const { nowMs, watermark, openSegment, reconciliationDue = false } = input;
  if (!watermark) return { lane: "full", reason: "no_watermark", coverageGapReason: null };

  const lastFullMs = stripeTimestampMs(watermark.last_full_refresh_at);
  if (lastFullMs === null) {
    return { lane: "full", reason: "no_completed_full_import", coverageGapReason: null };
  }

  const gap = stripeDeltaCoverageGap({ nowMs, watermark, openSegment });
  if (gap) return { lane: "full", reason: "delta_coverage_gap", coverageGapReason: gap };

  // A parked demand from a delta run that refused to fan out. Checked BEFORE the cadence so the
  // reported reason is the demand rather than the calendar, and AFTER the gap so the more
  // fundamental "the chain is broken" reason still wins.
  if (isStripePendingFullRefreshReason(watermark.pending_full_refresh_reason)) {
    return { lane: "full", reason: "delta_fanout_exceeded", coverageGapReason: null };
  }

  if (nowMs - lastFullMs >= STRIPE_FULL_REFRESH_INTERVAL_MS) {
    return { lane: "full", reason: "full_refresh_interval_elapsed", coverageGapReason: null };
  }
  if (reconciliationDue) {
    return { lane: "full", reason: "reconciliation_due", coverageGapReason: null };
  }
  return { lane: "delta", reason: "delta_healthy", coverageGapReason: null };
}

export function stripeDeltaCoverageGap(input: {
  nowMs: number;
  watermark: StripeSyncWatermarkRow;
  openSegment: StripeEventSegmentRow | null;
}): StripeCoverageGapReason | null {
  const { nowMs, watermark, openSegment } = input;
  const safeFloorMs = nowMs - STRIPE_EVENT_SAFE_RETENTION_DAYS * DAY_MS;
  const hardFloorMs = nowMs - STRIPE_EVENT_HARD_RETENTION_DAYS * DAY_MS;

  const deltaAsOfMs = stripeTimestampMs(watermark.delta_data_as_of);
  if (deltaAsOfMs === null) return "delta_watermark_missing";
  if (!isStripeEventSecondBoundary(deltaAsOfMs)) return "delta_watermark_unaligned";
  if (deltaAsOfMs < safeFloorMs) return "delta_watermark_beyond_event_retention";

  if (openSegment) {
    const fromMs = stripeTimestampMs(openSegment.segment_from);
    const toMs = stripeTimestampMs(openSegment.segment_to_exclusive);
    if (fromMs === null || toMs === null) return "delta_segment_chain_broken";
    if (!isStripeEventSecondBoundary(fromMs) || !isStripeEventSecondBoundary(toMs)) {
      return "delta_segment_chain_broken";
    }
    if (fromMs >= toMs) return "delta_segment_chain_broken";
    // A segment that starts AFTER everything we have durably observed leaves a hole between the
    // watermark and the segment: nothing will ever poll that interval again.
    if (fromMs > deltaAsOfMs) return "delta_segment_chain_broken";
    if (fromMs < hardFloorMs) return "delta_segment_beyond_event_retention";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Segment planning
// ---------------------------------------------------------------------------------------------

export interface StripeDeltaSegmentPlan {
  segmentFrom: string;
  segmentToExclusive: string;
  segmentFromMs: number;
  segmentToExclusiveMs: number;
  /** Resume cursor of THIS segment's unfiltered events stream, or null for a fresh window. */
  paginationCursor: string | null;
  resumedSegmentId: string | null;
}

/**
 * Compute the delta window.
 *
 * A resumable OPEN segment is replayed VERBATIM (same bounds, same cursor) so a bounded-page run
 * makes forward progress without ever redefining what it claimed to cover. Otherwise a fresh
 * half-open window opens that (a) reaches BACK below every dependent lane's durable cutoff by
 * the overlap and (b) stops SHORT of now by the safety lag.
 *
 * `fromCandidatesMs` is the set of durable cutoffs that this ONE poll is allowed to advance:
 * the delta watermark, the invoice-events cutoff, and the trial-lifecycle closed-through bound.
 * Taking their MINIMUM is what makes it safe for a single unfiltered poll to close all three —
 * a window that starts at the earliest of them cannot leave a hole in any of them.
 */
export function planStripeDeltaSegment(input: {
  cursorEndMs: number;
  fromCandidatesMs: number[];
  openSegment: StripeEventSegmentRow | null;
}): StripeDeltaSegmentPlan {
  const { cursorEndMs, fromCandidatesMs, openSegment } = input;
  if (!Number.isFinite(cursorEndMs)) throw new Error("Stripe delta cursor end is invalid");
  const segmentToExclusiveMs = stripeEventSecondBoundary(cursorEndMs - STRIPE_EVENT_SAFETY_LAG_MS);
  const safeFloorMs = stripeEventSecondBoundary(
    segmentToExclusiveMs - STRIPE_EVENT_SAFE_RETENTION_DAYS * DAY_MS,
  );

  if (openSegment) {
    const fromMs = stripeTimestampMs(openSegment.segment_from);
    const toMs = stripeTimestampMs(openSegment.segment_to_exclusive);
    const resumable = fromMs !== null && toMs !== null
      && isStripeEventSecondBoundary(fromMs) && isStripeEventSecondBoundary(toMs)
      && fromMs < toMs
      && toMs <= segmentToExclusiveMs
      && fromMs >= stripeEventSecondBoundary(
        segmentToExclusiveMs - STRIPE_EVENT_HARD_RETENTION_DAYS * DAY_MS,
      );
    if (resumable) {
      return {
        segmentFrom: new Date(fromMs).toISOString(),
        segmentToExclusive: new Date(toMs).toISOString(),
        segmentFromMs: fromMs,
        segmentToExclusiveMs: toMs,
        paginationCursor: openSegment.pagination_cursor,
        resumedSegmentId: openSegment.id,
      };
    }
  }

  const finite = fromCandidatesMs.filter((value) => Number.isFinite(value));
  const anchorMs = finite.length > 0 ? Math.min(...finite) : safeFloorMs;
  const segmentFromMs = Math.max(
    safeFloorMs,
    stripeEventSecondBoundary(anchorMs - STRIPE_EVENT_OVERLAP_MS),
  );
  // Never invert (or collapse) the window on a source whose cutoff is younger than the lag: the
  // durable segment records exactly the interval Stripe was asked for, and `from < to` is a
  // table check, not a convention.
  const boundedToMs = Math.max(segmentToExclusiveMs, segmentFromMs + 1_000);
  return {
    segmentFrom: new Date(segmentFromMs).toISOString(),
    segmentToExclusive: new Date(boundedToMs).toISOString(),
    segmentFromMs,
    segmentToExclusiveMs: boundedToMs,
    paginationCursor: null,
    resumedSegmentId: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Event relevance + change fan-out
// ---------------------------------------------------------------------------------------------

export type StripeEventObjectKind =
  | "subscription"
  | "discount"
  | "customer"
  | "invoice"
  | "credit_note"
  | "price"
  | "coupon"
  | "product";

export interface StripeEventApi {
  id: string;
  type: string;
  created: number;
  api_version?: string | null;
  livemode?: boolean;
  data?: {
    object?: unknown;
    previous_attributes?: Record<string, unknown> | null;
  };
}

/**
 * The event families this lane consumes, by prefix, in MATCH ORDER — `customer.subscription.*`
 * and `customer.discount.*` must be tested before the bare `customer.*` family.
 *
 * Concrete member types (the reason the poll is unfiltered — this list is far past Stripe's
 * documented 20-entry `types[]` cap):
 *   customer.subscription.{created,updated,deleted,paused,resumed,trial_will_end}   (6)
 *   customer.discount.{created,updated,deleted}                                     (3)
 *   customer.{created,updated,deleted}                                              (3)
 *   invoice.{created,updated,finalized,paid,payment_succeeded,payment_failed,
 *            voided,marked_uncollectible,deleted}                                   (9)
 *   credit_note.{created,updated,voided}                                            (3)
 *   price.{created,updated,deleted}                                                 (3)
 *   coupon.{created,updated,deleted}                                                (3)
 *   product.{created,updated,deleted}                                               (3)
 *                                                                             total  33
 */
export const STRIPE_DELTA_EVENT_PREFIXES: ReadonlyArray<readonly [string, StripeEventObjectKind]> = [
  ["customer.subscription.", "subscription"],
  ["customer.discount.", "discount"],
  ["customer.", "customer"],
  ["invoice.", "invoice"],
  ["credit_note.", "credit_note"],
  ["price.", "price"],
  ["coupon.", "coupon"],
  ["product.", "product"],
] as const;

/** Pinned by test: our relevant event set exceeds Stripe's documented 20-type `types[]` cap. */
export const STRIPE_DELTA_RELEVANT_EVENT_TYPE_COUNT = 33;
export const STRIPE_EVENTS_TYPES_FILTER_CAP = 20;

/**
 * Sentinel `object_kind` for a PREVIEW event. It is not an entity family: no row of that kind
 * exists remotely or locally, and it is never a re-fetch target. (`unclassified_lifecycle`, written
 * by the trial lane in index.ts, is the other sentinel in the same table.)
 */
export const STRIPE_INVOICE_PREVIEW_OBJECT_KIND = "invoice_preview";

/**
 * PREVIEW EVENT TYPES — matched by the prefixes above but classified as NON-CHANGES.
 *
 * `invoice.upcoming` is emitted a few days before EVERY subscription renewal and carries a
 * SIMULATED invoice. Stripe documents it verbatim (docs.stripe.com/api/events/types):
 *   "Occurs X number of days before a subscription is scheduled to create an invoice that is
 *    automatically charged … Note: The received `Invoice` object will not have an invoice ID."
 * There is nothing to re-fetch — `/v1/invoices/{id}` cannot be called without an id, and the object
 * it previews has no canonical state yet — so fanning it out is impossible and dropping it loses
 * nothing: the real `invoice.created` / `invoice.finalized` / `invoice.paid` events arrive on their
 * own once Stripe actually creates the invoice.
 *
 * This is a CLASSIFICATION, not a fallback: the id-less guard below still fails loudly for any
 * OTHER id-less shape, and a preview that names neither an object nor a customer is itself
 * unexpected enough to throw.
 *
 * THE REST OF THE PREFIX-MATCHED `invoice.*` FAMILY IS DELIBERATELY LEFT ALONE. Types outside the
 * documented nine (`invoice.sent`, `invoice.overdue`, `invoice.overpaid`, `invoice.will_be_due`,
 * `invoice.finalization_failed`, `invoice.payment_action_required`, …) all carry a REAL, persisted
 * invoice with an id: matching them costs one extra retrieve of an object we already store, which
 * is strictly better than missing a state change, so the broad prefix match stays.
 */
export const STRIPE_DELTA_PREVIEW_EVENT_TYPES: ReadonlySet<string> = new Set(["invoice.upcoming"]);

/** `customer.*` families we deliberately ignore — they touch nothing this engine stores. */
const STRIPE_IGNORED_CUSTOMER_SUBFAMILIES = [
  "customer.source.",
  "customer.tax_id.",
  "customer.card.",
  "customer.bank_account.",
] as const;

export function stripeEventObjectKind(eventType: string): StripeEventObjectKind | null {
  if (STRIPE_IGNORED_CUSTOMER_SUBFAMILIES.some((prefix) => eventType.startsWith(prefix))) {
    return null;
  }
  for (const [prefix, kind] of STRIPE_DELTA_EVENT_PREFIXES) {
    if (eventType.startsWith(prefix)) return kind;
  }
  return null;
}

/** Entity families plus the preview sentinel, which is evidence-only and never re-fetched. */
export type StripeEventEvidenceKind =
  | StripeEventObjectKind
  | typeof STRIPE_INVOICE_PREVIEW_OBJECT_KIND;

export interface StripeDeltaEvidenceRow {
  stripeEventId: string;
  eventType: string;
  eventCreatedAt: string;
  apiVersion: string | null;
  livemode: boolean | null;
  objectKind: StripeEventEvidenceKind;
  objectExternalId: string;
  payload: Record<string, unknown>;
  previousAttributes: Record<string, unknown> | null;
}

export interface StripeDeltaFanout {
  evidence: StripeDeltaEvidenceRow[];
  invoiceIds: string[];
  subscriptionIds: string[];
  customerIds: string[];
  priceIds: string[];
  couponIds: string[];
  productIds: string[];
  /** Customers whose subscription set must be revalued (a discount attached/detached). */
  revalueCustomerIds: string[];
  /** Event types seen in the unfiltered stream and dropped locally, with counts. */
  ignoredEventTypes: Record<string, number>;
  /**
   * Relevant-family PREVIEW events (see STRIPE_DELTA_PREVIEW_EVENT_TYPES), with counts. Kept
   * separate from `ignoredEventTypes` on purpose: an ignored type touches nothing we store, while
   * a preview describes an object we very much store — it just has no state to read yet.
   */
  previewEventTypes: Record<string, number>;
}

class StripeDeltaEventError extends Error {}

/**
 * The fan-out map. Subresource changes do NOT emit parent-resource events, so each family names
 * exactly what has to be re-fetched:
 *   subscription events -> that subscription (and, at retrieval, ALL of its item pages)
 *   customer events     -> that customer
 *   discount events     -> the customer AND every locally-known subscription of that customer
 *                          (a discount attach/detach changes recurring value, not the customer)
 *   invoice events      -> that invoice
 *   credit note events  -> the invoice it credits (credited amounts live on our invoice row)
 *   price / coupon      -> the object's referencing subscriptions, via the LOCAL reverse index
 *   product             -> evidence only, and only when we already store that product
 */
export function stripeDeltaFanout(events: StripeEventApi[]): StripeDeltaFanout {
  const evidence: StripeDeltaEvidenceRow[] = [];
  const seenEventIds = new Set<string>();
  const invoiceIds = new Set<string>();
  const subscriptionIds = new Set<string>();
  const customerIds = new Set<string>();
  const priceIds = new Set<string>();
  const couponIds = new Set<string>();
  const productIds = new Set<string>();
  const revalueCustomerIds = new Set<string>();
  const ignoredEventTypes: Record<string, number> = {};
  const previewEventTypes: Record<string, number> = {};

  for (const event of events) {
    const eventId = nonEmpty(event.id);
    if (!eventId) throw new StripeDeltaEventError("Stripe event arrived without an id");
    // Stripe may re-deliver an event across pages/windows; the evidence table is insert-only and
    // keyed on the event id, but de-duping here also keeps the refetch set honest.
    if (seenEventIds.has(eventId)) continue;
    seenEventIds.add(eventId);

    const eventType = nonEmpty(event.type);
    if (!eventType) throw new StripeDeltaEventError(`Stripe event ${eventId} arrived without a type`);
    const kind = stripeEventObjectKind(eventType);
    if (!kind) {
      ignoredEventTypes[eventType] = (ignoredEventTypes[eventType] ?? 0) + 1;
      continue;
    }

    const object = asObject(event.data?.object);
    const objectId = nonEmpty(object.id);

    // PREVIEW: a documented NON-CHANGE. Recorded as evidence (the simulated invoice is genuinely
    // interesting forward-looking data we already paid to receive) and deliberately NOT fanned out.
    // Checked before the id guard because the whole point of a preview is that its object does not
    // exist yet — see STRIPE_DELTA_PREVIEW_EVENT_TYPES for why this is classification, not masking.
    if (STRIPE_DELTA_PREVIEW_EVENT_TYPES.has(eventType)) {
      const previewKey = objectId ?? referenceId(object.customer);
      if (!previewKey) {
        throw new StripeDeltaEventError(
          `Stripe preview event ${eventId} (${eventType}) named neither an object nor a customer;`
          + " refusing to classify an unrecognised shape",
        );
      }
      previewEventTypes[eventType] = (previewEventTypes[eventType] ?? 0) + 1;
      evidence.push({
        stripeEventId: eventId,
        eventType,
        eventCreatedAt: unixSecondsToIso(event.created, eventId),
        apiVersion: nonEmpty(event.api_version) ?? null,
        livemode: typeof event.livemode === "boolean" ? event.livemode : null,
        objectKind: STRIPE_INVOICE_PREVIEW_OBJECT_KIND,
        objectExternalId: previewKey,
        payload: object,
        previousAttributes: event.data?.previous_attributes
          ? asObject(event.data.previous_attributes)
          : null,
      });
      continue;
    }

    if (!objectId) {
      // A relevant event we cannot key to an object can never be re-fetched. Failing here is the
      // point: silently dropping it would quietly desynchronise canonical state.
      throw new StripeDeltaEventError(
        `Stripe event ${eventId} (${eventType}) carried no object id; refusing to drop a change`,
      );
    }

    evidence.push({
      stripeEventId: eventId,
      eventType,
      eventCreatedAt: unixSecondsToIso(event.created, eventId),
      apiVersion: nonEmpty(event.api_version) ?? null,
      livemode: typeof event.livemode === "boolean" ? event.livemode : null,
      objectKind: kind,
      objectExternalId: objectId,
      payload: object,
      previousAttributes: event.data?.previous_attributes
        ? asObject(event.data.previous_attributes)
        : null,
    });

    switch (kind) {
      case "subscription":
        subscriptionIds.add(objectId);
        break;
      case "customer":
        customerIds.add(objectId);
        break;
      case "discount": {
        const customerId = referenceId(object.customer);
        if (customerId) {
          customerIds.add(customerId);
          revalueCustomerIds.add(customerId);
        }
        const subscriptionId = referenceId(object.subscription);
        if (subscriptionId) subscriptionIds.add(subscriptionId);
        break;
      }
      case "invoice":
        invoiceIds.add(objectId);
        break;
      case "credit_note": {
        const invoiceId = referenceId(object.invoice);
        if (!invoiceId) {
          throw new StripeDeltaEventError(
            `Stripe credit note event ${eventId} named no invoice; refusing to drop a change`,
          );
        }
        invoiceIds.add(invoiceId);
        break;
      }
      case "price":
        priceIds.add(objectId);
        break;
      case "coupon":
        couponIds.add(objectId);
        break;
      case "product":
        productIds.add(objectId);
        break;
    }
  }

  return {
    evidence,
    invoiceIds: [...invoiceIds].sort(),
    subscriptionIds: [...subscriptionIds].sort(),
    customerIds: [...customerIds].sort(),
    priceIds: [...priceIds].sort(),
    couponIds: [...couponIds].sort(),
    productIds: [...productIds].sort(),
    revalueCustomerIds: [...revalueCustomerIds].sort(),
    ignoredEventTypes,
    previewEventTypes,
  };
}

/**
 * Merge two reads of the SAME window into one stream, de-duplicated by event id, first observation
 * winning. Used by the resumed-segment top-up re-list, whose whole purpose is to overlap the pages
 * the cursor already walked — so duplicates are the expected case, not an anomaly. Counting them
 * twice would inflate the segment's `event_count` (the durable record of how much that window
 * actually contained).
 */
export function stripeDeltaMergeEventPages(
  primary: StripeEventApi[],
  extra: StripeEventApi[],
): StripeEventApi[] {
  const seen = new Set<string>();
  const merged: StripeEventApi[] = [];
  for (const event of [...primary, ...extra]) {
    const id = nonEmpty(event.id);
    // An id-less event is not de-dupable; it is kept so the fan-out can fail loudly on it there,
    // where the diagnosis (which event, which type) is available.
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    merged.push(event);
  }
  return merged;
}

/**
 * How many objects this fan-out would RETRIEVE. Products are excluded: `product.*` events are
 * evidence-only (there is no product row builder), so they never cost a read.
 */
export function stripeDeltaRefetchCount(targets: StripeDeltaRefetchTargets): number {
  return targets.invoiceIds.length + targets.subscriptionIds.length + targets.customerIds.length;
}

export interface StripeDeltaRefetchTargets {
  invoiceIds: string[];
  subscriptionIds: string[];
  customerIds: string[];
  /** Product ids we actually store; product evidence for anything else is dropped. */
  storedProductIds: string[];
}

/**
 * Resolve the LOCAL REVERSE INDEX. Stripe emits no event on the subscriptions affected by a
 * price or coupon edit, so the only way to revalue them is to ask our own tables which
 * subscriptions reference the changed object.
 */
export async function stripeDeltaResolveRefetchTargets(
  db: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
  fanout: StripeDeltaFanout,
): Promise<StripeDeltaRefetchTargets> {
  const subscriptionIds = new Set(fanout.subscriptionIds);

  if (fanout.priceIds.length > 0) {
    const rows = await db.query<{ stripe_subscription_id: string }>(
      `select distinct stripe_subscription_id
         from stripe_subscription_items
        where workspace_id = $1 and source_id = $2 and stripe_price_id = any($3::text[])`,
      [scope.workspaceId, scope.sourceId, fanout.priceIds],
    );
    for (const row of rows) subscriptionIds.add(row.stripe_subscription_id);
  }

  if (fanout.couponIds.length > 0) {
    const rows = await db.query<{ stripe_subscription_id: string }>(
      `select distinct stripe_subscription_id
         from stripe_subscription_discounts
        where workspace_id = $1 and source_id = $2 and stripe_coupon_id = any($3::text[])`,
      [scope.workspaceId, scope.sourceId, fanout.couponIds],
    );
    for (const row of rows) subscriptionIds.add(row.stripe_subscription_id);
  }

  if (fanout.revalueCustomerIds.length > 0) {
    const rows = await db.query<{ stripe_subscription_id: string }>(
      `select distinct stripe_subscription_id
         from stripe_subscriptions
        where workspace_id = $1 and source_id = $2 and stripe_customer_id = any($3::text[])`,
      [scope.workspaceId, scope.sourceId, fanout.revalueCustomerIds],
    );
    for (const row of rows) subscriptionIds.add(row.stripe_subscription_id);
  }

  let storedProductIds: string[] = [];
  if (fanout.productIds.length > 0) {
    const rows = await db.query<{ stripe_product_id: string }>(
      `select stripe_product_id
         from stripe_products
        where workspace_id = $1 and source_id = $2 and stripe_product_id = any($3::text[])`,
      [scope.workspaceId, scope.sourceId, fanout.productIds],
    );
    storedProductIds = rows.map((row) => row.stripe_product_id).sort();
  }

  return {
    invoiceIds: [...fanout.invoiceIds],
    subscriptionIds: [...subscriptionIds].sort(),
    customerIds: [...fanout.customerIds],
    storedProductIds,
  };
}

/**
 * Products are stored as a name/active label hung off invoice and subscription writes; there is
 * no product row builder and no metric reads a product field, so a `product.*` event is recorded
 * as evidence when we track that product and otherwise dropped entirely. Known limitation: a
 * product RENAME lands only on the next invoice/subscription write that mentions it.
 */
export function stripeDeltaFilterProductEvidence(
  fanout: StripeDeltaFanout,
  storedProductIds: string[],
): StripeDeltaEvidenceRow[] {
  const stored = new Set(storedProductIds);
  return fanout.evidence.filter(
    (row) => row.objectKind !== "product" || stored.has(row.objectExternalId),
  );
}

/** Run `worker` over `items` with at most `limit` in flight, preserving input order in the result. */
export async function stripeDeltaMapBounded<In, Out>(
  items: In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as In, index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------------------------
// CLOSE checkpoint
// ---------------------------------------------------------------------------------------------

export class StripeDeltaCloseClaimLostError extends Error {}

export interface StripeDeltaCheckpoint {
  lane: "delta";
  segmentFrom: string;
  segmentToExclusive: string;
  paginationCursor: string | null;
  segmentComplete: boolean;
  eventCount: number;
  refetchCount: number;
  evidence: StripeDeltaEvidenceRow[];
  /** Reset continuous coverage to `segmentFrom` (a gap was recorded on the way into this run). */
  resetContinuousCoverage: boolean;
  /**
   * Park a durable demand for the FULL lane. Non-null only when this delta run refused to apply the
   * window (today: the refetch fan-out exceeded its budget), in which case `segmentComplete` is
   * false and the watermark deliberately does not advance.
   */
  pendingFullRefreshReason: StripePendingFullRefreshReason | null;
}

export interface StripeFullRefreshCheckpoint {
  lane: "full";
  /** Wall-clock instant of the full replacement (`plan.cursorEnd`). */
  fullRefreshAt: string;
  /** Second-aligned lagged bound: what this run can honestly claim to have observed through. */
  deltaDataAsOf: string;
  resetContinuousCoverage: boolean;
  coverageGapReason: StripeCoverageGapReason | null;
}

export type StripeSyncLaneCheckpoint = StripeDeltaCheckpoint | StripeFullRefreshCheckpoint;

/**
 * Persist the lane's durable state inside the connector's single CLOSE transaction.
 *
 * Ownership is re-verified UNDER the source row lock for the same reason the MRR movement writer
 * does it: the boot sweep can reset a `syncing` source to `connected`, letting a competing claim
 * supersede this run mid-LOAD. Advancing a watermark on behalf of a run that no longer owns the
 * source would let the next delta window skip an interval nobody polled.
 */
export async function writeStripeSyncLaneAtClose(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string; syncRunId: string },
  checkpoint: StripeSyncLaneCheckpoint,
): Promise<void> {
  const locked = await tx.query<{ id: string }>(
    `select id from sources
      where id = $1 and workspace_id = $2 and provider = 'stripe'
      for update`,
    [scope.sourceId, scope.workspaceId],
  );
  if (!locked[0]) throw new Error("Stripe delta CLOSE source is missing or outside workspace scope");

  const owningRuns = await tx.query<{ id: string }>(
    `select id from sync_runs
      where id = $1 and workspace_id = $2 and source_id = $3 and status = 'running'`,
    [scope.syncRunId, scope.workspaceId, scope.sourceId],
  );
  if (!owningRuns[0]) {
    throw new StripeDeltaCloseClaimLostError(
      "Stripe delta CLOSE aborted: the sync claim belongs to another run",
    );
  }

  const prior = await tx.one<StripeSyncWatermarkRow>(
    `select delta_data_as_of, last_full_refresh_at, continuous_coverage_from,
            pending_full_refresh_reason
       from stripe_sync_watermarks
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
  const priorContinuousFrom = isoOrNull(prior?.continuous_coverage_from);

  if (checkpoint.lane === "full") {
    const continuousFrom = checkpoint.resetContinuousCoverage || !priorContinuousFrom
      ? checkpoint.deltaDataAsOf
      : priorContinuousFrom;
    // RETIRE THE SUPERSEDED OPEN SEGMENTS. Without this a single stale OPEN segment is a permanent
    // full-refresh loop: `stripeDeltaCoverageGap` reports `delta_segment_beyond_event_retention`
    // (or `delta_segment_chain_broken`) every tick, that forces the FULL lane, and the full lane —
    // which opens no segments of its own — leaves the offending row exactly where it was. A full
    // replacement re-derives canonical state for the whole account, so every window it covers is
    // SUPERSEDED: its remaining purpose is gone, and the next tick can select delta again.
    //
    // `superseded`, not `closed`: `closed` is the delta lane's claim to have OBSERVED that whole
    // window through the event stream, which this run did not do.
    await tx.query(
      `update stripe_event_segments
          set status = 'superseded', closed_at = coalesce(closed_at, now()), updated_at = now()
        where workspace_id = $1 and source_id = $2 and status = 'open'
          and segment_to_exclusive <= $3::timestamptz`,
      [scope.workspaceId, scope.sourceId, checkpoint.deltaDataAsOf],
    );
    await upsertWatermark(tx, scope, {
      deltaDataAsOf: checkpoint.deltaDataAsOf,
      lastFullRefreshAt: checkpoint.fullRefreshAt,
      continuousCoverageFrom: continuousFrom,
      // The full refresh IS the satisfaction of any parked demand, so it always clears the marker.
      pendingFullRefreshReason: null,
    });
    return;
  }

  const segmentId = `stripe_event_segment_${randomUUID()}`;
  const status = checkpoint.segmentComplete ? "closed" : "open";
  const published = await tx.query<{ id: string }>(
    `insert into stripe_event_segments (
       id, workspace_id, source_id, segment_from, segment_to_exclusive,
       pagination_cursor, status, event_count, refetch_count, closed_at, parser_version
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               case when $7 = 'closed' then now() else null end, $10)
     on conflict (workspace_id, source_id, segment_from, segment_to_exclusive)
     do update set
       pagination_cursor = excluded.pagination_cursor,
       status = excluded.status,
       -- Resuming an OPEN segment reads only the events AFTER its cursor, so the counts
       -- accumulate. Re-reading an already CLOSED window (the deliberate overlap) replays the
       -- same events, so its counts replace rather than double.
       event_count = case when stripe_event_segments.status = 'open'
                      then stripe_event_segments.event_count + excluded.event_count
                      else excluded.event_count end,
       refetch_count = case when stripe_event_segments.status = 'open'
                        then stripe_event_segments.refetch_count + excluded.refetch_count
                        else excluded.refetch_count end,
       closed_at = case when excluded.status = 'closed'
                     then coalesce(stripe_event_segments.closed_at, now()) else null end,
       parser_version = excluded.parser_version,
       updated_at = now()
     returning id`,
    [
      segmentId,
      scope.workspaceId,
      scope.sourceId,
      checkpoint.segmentFrom,
      checkpoint.segmentToExclusive,
      checkpoint.paginationCursor,
      status,
      checkpoint.eventCount,
      checkpoint.refetchCount,
      STRIPE_DELTA_PARSER_VERSION,
    ],
  );
  const publishedSegmentId = published[0]?.id;
  if (!publishedSegmentId) throw new Error("Stripe delta CLOSE did not publish its segment");

  await insertStripeEventEvidence(tx, scope, publishedSegmentId, checkpoint.evidence);

  // The watermark advances ONLY on a complete segment. A bounded-page run that stopped mid-window
  // has not observed the whole interval; claiming it would open a hole the next window skips.
  const continuousFrom = checkpoint.resetContinuousCoverage || !priorContinuousFrom
    ? checkpoint.segmentFrom
    : priorContinuousFrom;
  await upsertWatermark(tx, scope, {
    deltaDataAsOf: checkpoint.segmentComplete ? checkpoint.segmentToExclusive : null,
    lastFullRefreshAt: null,
    continuousCoverageFrom: continuousFrom,
    pendingFullRefreshReason: checkpoint.pendingFullRefreshReason,
  });
}

const EVIDENCE_INSERT_CHUNK = 100;

async function insertStripeEventEvidence(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
  segmentId: string,
  rows: StripeDeltaEvidenceRow[],
): Promise<void> {
  const COLUMNS = 13;
  for (let offset = 0; offset < rows.length; offset += EVIDENCE_INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + EVIDENCE_INSERT_CHUNK);
    const values = chunk
      .map((_, index) => {
        const base = index * COLUMNS;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},`
          + `$${base + 6}::timestamptz,$${base + 7},$${base + 8},$${base + 9},$${base + 10},`
          + `$${base + 11}::jsonb,$${base + 12}::jsonb,$${base + 13})`;
      })
      .join(",");
    const params: unknown[] = [];
    for (const row of chunk) {
      params.push(
        `stripe_event_evidence_${randomUUID()}`,
        scope.workspaceId,
        scope.sourceId,
        row.stripeEventId,
        row.eventType,
        row.eventCreatedAt,
        row.apiVersion,
        row.livemode,
        row.objectKind,
        row.objectExternalId,
        JSON.stringify(row.payload),
        row.previousAttributes === null ? null : JSON.stringify(row.previousAttributes),
        segmentId,
      );
    }
    await tx.query(
      `insert into stripe_event_evidence (
         id, workspace_id, source_id, stripe_event_id, event_type, event_created_at,
         api_version, livemode, object_kind, object_external_id, payload,
         previous_attributes, segment_id
       ) values ${values}
       -- IMMUTABLE. A replayed event keeps the payload of its FIRST observation; nothing here
       -- may overwrite historical evidence.
       on conflict (workspace_id, source_id, stripe_event_id) do nothing`,
      params,
    );
  }
}

async function upsertWatermark(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
  values: {
    deltaDataAsOf: string | null;
    lastFullRefreshAt: string | null;
    continuousCoverageFrom: string | null;
    pendingFullRefreshReason: StripePendingFullRefreshReason | null;
  },
): Promise<void> {
  await tx.query(
    `insert into stripe_sync_watermarks (
       id, workspace_id, source_id, delta_data_as_of, last_full_refresh_at,
       continuous_coverage_from, pending_full_refresh_reason, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7, now())
     on conflict (workspace_id, source_id)
     do update set
       -- MONOTONIC: greatest() ignores nulls, so an incomplete segment (null) never regresses
       -- the durable freshness claim.
       delta_data_as_of = greatest(
         stripe_sync_watermarks.delta_data_as_of, excluded.delta_data_as_of
       ),
       last_full_refresh_at = coalesce(
         excluded.last_full_refresh_at, stripe_sync_watermarks.last_full_refresh_at
       ),
       continuous_coverage_from = excluded.continuous_coverage_from,
       -- LAST WRITE WINS, deliberately: a delta run PARKS the demand and the full run that
       -- satisfies it CLEARS it. Coalescing either way would either strand a source on the
       -- expensive lane forever or let a healthy delta tick erase a demand nothing has met.
       pending_full_refresh_reason = excluded.pending_full_refresh_reason,
       updated_at = now()`,
    [
      `stripe_sync_watermark_${randomUUID()}`,
      scope.workspaceId,
      scope.sourceId,
      values.deltaDataAsOf,
      values.lastFullRefreshAt,
      values.continuousCoverageFrom,
      values.pendingFullRefreshReason,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// State reads
// ---------------------------------------------------------------------------------------------

export async function readStripeSyncWatermark(
  db: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
): Promise<StripeSyncWatermarkRow | null> {
  return db.one<StripeSyncWatermarkRow>(
    `select delta_data_as_of, last_full_refresh_at, continuous_coverage_from,
            pending_full_refresh_reason
       from stripe_sync_watermarks
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
}

export async function readStripeOpenEventSegment(
  db: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
): Promise<StripeEventSegmentRow | null> {
  return db.one<StripeEventSegmentRow>(
    `select id, segment_from, segment_to_exclusive, pagination_cursor, status
       from stripe_event_segments
      where workspace_id = $1 and source_id = $2 and status = 'open'
      order by segment_to_exclusive desc
      limit 1`,
    [scope.workspaceId, scope.sourceId],
  );
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asObject(value: unknown): Record<string, unknown> & { id?: string } {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown> & { id?: string })
    : {};
}

/** An expandable Stripe reference is either a bare id string or an expanded object. */
function referenceId(value: unknown): string | null {
  if (typeof value === "string") return nonEmpty(value);
  return nonEmpty(asObject(value).id);
}

function unixSecondsToIso(value: unknown, eventId: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StripeDeltaEventError(`Stripe event ${eventId} carried no created timestamp`);
  }
  return new Date(value * 1_000).toISOString();
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  const ms = stripeTimestampMs(value ?? null);
  return ms === null ? null : new Date(ms).toISOString();
}
