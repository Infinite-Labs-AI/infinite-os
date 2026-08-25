import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { connectorFor, type SyncRequest } from "./index.js";
import { writeStripeMrrMovementsAtClose } from "./stripe-mrr-movements.js";
import {
  applyReconciliation,
  computeReconciliationPlan,
  stripeRemotePricesFromSubscriptions,
  StripeReconciliationClaimLostError,
  type StripeReconcileRemoteSubscription,
} from "./stripe-reconcile.js";
import {
  STRIPE_DELTA_EVENT_PREFIXES,
  STRIPE_DELTA_MAX_REFETCH_PER_RUN,
  STRIPE_DELTA_RELEVANT_EVENT_TYPE_COUNT,
  STRIPE_EVENTS_TYPES_FILTER_CAP,
  STRIPE_EVENT_OVERLAP_MS,
  STRIPE_EVENT_SAFETY_LAG_MS,
  STRIPE_FULL_REFRESH_INTERVAL_MS,
  STRIPE_INVOICE_PREVIEW_OBJECT_KIND,
  StripeRequestTelemetry,
  planStripeDeltaSegment,
  selectStripeSyncLane,
  stripeDeltaFanout,
  stripeDeltaMapBounded,
  stripeDeltaMergeEventPages,
  stripeEndpointClass,
  stripeEventObjectKind,
  type StripeEventApi,
} from "./stripe-delta.js";

const TEST_ENCRYPTION_KEY = "stripe-delta-test-encryption-key";

// ---------------------------------------------------------------------------------------------
// Lane selection (pure) — the decision table the scheduler relies on.
// ---------------------------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-08-04T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("Stripe sync lane selection", () => {
  const healthy = {
    delta_data_as_of: iso(NOW_MS - 15 * 60 * 1000),
    last_full_refresh_at: iso(NOW_MS - 3 * 60 * 60 * 1000),
    continuous_coverage_from: iso(NOW_MS - 20 * 24 * 60 * 60 * 1000),
  };

  it("takes FULL on a fresh source that has never been imported", () => {
    expect(selectStripeSyncLane({ nowMs: NOW_MS, watermark: null, openSegment: null })).toEqual({
      lane: "full",
      reason: "no_watermark",
      coverageGapReason: null,
    });
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, last_full_refresh_at: null },
      openSegment: null,
    })).toEqual({ lane: "full", reason: "no_completed_full_import", coverageGapReason: null });
  });

  it("takes DELTA inside the full-refresh interval when the chain is healthy", () => {
    expect(selectStripeSyncLane({ nowMs: NOW_MS, watermark: healthy, openSegment: null })).toEqual({
      lane: "delta",
      reason: "delta_healthy",
      coverageGapReason: null,
    });
  });

  it("takes FULL once the daily refresh interval has elapsed", () => {
    const stale = {
      ...healthy,
      last_full_refresh_at: iso(NOW_MS - STRIPE_FULL_REFRESH_INTERVAL_MS),
    };
    expect(selectStripeSyncLane({ nowMs: NOW_MS, watermark: stale, openSegment: null })).toEqual({
      lane: "full",
      reason: "full_refresh_interval_elapsed",
      coverageGapReason: null,
    });
  });

  it("takes FULL and names the gap when the delta chain cannot be continued", () => {
    // Watermark older than the 28-day safe event-retention floor: the intervening event stream is
    // gone from Stripe, so the snapshot is repairable but the SEQUENCE is not.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, delta_data_as_of: iso(NOW_MS - 29 * 24 * 60 * 60 * 1000) },
      openSegment: null,
    })).toEqual({
      lane: "full",
      reason: "delta_coverage_gap",
      coverageGapReason: "delta_watermark_beyond_event_retention",
    });

    // Sub-second watermark: it does not describe an interval Stripe was ever asked for.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, delta_data_as_of: "2026-08-04T11:45:00.789Z" },
      openSegment: null,
    }).coverageGapReason).toBe("delta_watermark_unaligned");

    // An open segment that begins AFTER everything durably observed leaves a hole nobody polls.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: healthy,
      openSegment: {
        id: "seg_1",
        segment_from: iso(NOW_MS - 10 * 60 * 1000),
        segment_to_exclusive: iso(NOW_MS - 5 * 60 * 1000),
        pagination_cursor: "evt_9",
        status: "open",
      },
    })).toEqual({
      lane: "full",
      reason: "delta_coverage_gap",
      coverageGapReason: "delta_segment_chain_broken",
    });
  });

  it("prefers the gap reason over the interval when both apply", () => {
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: {
        delta_data_as_of: null,
        last_full_refresh_at: iso(NOW_MS - 3 * STRIPE_FULL_REFRESH_INTERVAL_MS),
        continuous_coverage_from: null,
      },
      openSegment: null,
    })).toEqual({
      lane: "full",
      reason: "delta_coverage_gap",
      coverageGapReason: "delta_watermark_missing",
    });
  });

  it("upgrades a DELTA-healthy source to FULL when a reconciliation is due", () => {
    // Reconciliation needs the COMPLETE remote set; the delta lane only retrieves the objects its
    // events named, so a plan built from it would read every untouched object as deleted.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: healthy,
      openSegment: null,
      reconciliationDue: true,
    })).toEqual({ lane: "full", reason: "reconciliation_due", coverageGapReason: null });
  });

  it("keeps the more fundamental reason when the run was going to be FULL anyway", () => {
    // `reconciliation_due` is the LAST reason checked precisely so it stays diagnostic: seeing it
    // always means "the delta chain was healthy and reconciliation is what upgraded this run".
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, last_full_refresh_at: iso(NOW_MS - STRIPE_FULL_REFRESH_INTERVAL_MS) },
      openSegment: null,
      reconciliationDue: true,
    }).reason).toBe("full_refresh_interval_elapsed");
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, delta_data_as_of: iso(NOW_MS - 29 * 24 * 60 * 60 * 1000) },
      openSegment: null,
      reconciliationDue: true,
    }).reason).toBe("delta_coverage_gap");
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: null,
      openSegment: null,
      reconciliationDue: true,
    }).reason).toBe("no_watermark");
  });

  it("honours a parked fan-out demand, and only a RECOGNISED one", () => {
    // A delta run that refused to issue 1,000 retrieves parks this; the next tick must take the
    // full lane and SAY SO, rather than silently retrying the same unbounded fan-out every 15 min.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, pending_full_refresh_reason: "delta_fanout_exceeded" },
      openSegment: null,
    })).toEqual({ lane: "full", reason: "delta_fanout_exceeded", coverageGapReason: null });
    // The marker is a CLOSED union: unrecognised text must not be able to pin a source to the
    // expensive lane forever.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: { ...healthy, pending_full_refresh_reason: "something_invented" },
      openSegment: null,
    }).reason).toBe("delta_healthy");
    // …and a broken chain still outranks it: that is the more fundamental failure.
    expect(selectStripeSyncLane({
      nowMs: NOW_MS,
      watermark: {
        ...healthy,
        delta_data_as_of: iso(NOW_MS - 29 * 24 * 60 * 60 * 1000),
        pending_full_refresh_reason: "delta_fanout_exceeded",
      },
      openSegment: null,
    }).reason).toBe("delta_coverage_gap");
  });
});

// ---------------------------------------------------------------------------------------------
// Segment planning (pure).
// ---------------------------------------------------------------------------------------------

describe("Stripe delta segment planning", () => {
  it("opens a lagged, second-aligned half-open window reaching back past the EARLIEST cutoff", () => {
    const deltaAsOf = Date.parse("2026-08-04T11:50:00.000Z");
    const invoiceCutoff = Date.parse("2026-08-04T11:30:00.000Z");
    const trialClosedThrough = Date.parse("2026-08-04T11:40:00.000Z");
    const plan = planStripeDeltaSegment({
      // Deliberately sub-second: the durable bounds must not inherit it.
      cursorEndMs: Date.parse("2026-08-04T12:00:00.789Z"),
      fromCandidatesMs: [deltaAsOf, invoiceCutoff, trialClosedThrough],
      openSegment: null,
    });
    expect(plan.segmentFrom).toBe(iso(invoiceCutoff - STRIPE_EVENT_OVERLAP_MS));
    expect(plan.segmentToExclusive).toBe(
      iso(Date.parse("2026-08-04T12:00:00.000Z") - STRIPE_EVENT_SAFETY_LAG_MS),
    );
    expect(plan.paginationCursor).toBeNull();
  });

  it("resumes an interrupted segment VERBATIM instead of redefining what it covers", () => {
    const plan = planStripeDeltaSegment({
      cursorEndMs: Date.parse("2026-08-04T12:00:00.000Z"),
      fromCandidatesMs: [Date.parse("2026-08-04T11:50:00.000Z")],
      openSegment: {
        id: "seg_open",
        segment_from: "2026-08-04T10:00:00.000Z",
        segment_to_exclusive: "2026-08-04T11:00:00.000Z",
        pagination_cursor: "evt_resume",
        status: "open",
      },
    });
    expect(plan).toMatchObject({
      segmentFrom: "2026-08-04T10:00:00.000Z",
      segmentToExclusive: "2026-08-04T11:00:00.000Z",
      paginationCursor: "evt_resume",
      resumedSegmentId: "seg_open",
    });
  });

  it("abandons a persisted segment whose bounds are not whole seconds", () => {
    const plan = planStripeDeltaSegment({
      cursorEndMs: Date.parse("2026-08-04T12:00:00.000Z"),
      fromCandidatesMs: [Date.parse("2026-08-04T11:50:00.000Z")],
      openSegment: {
        id: "seg_bad",
        segment_from: "2026-08-04T10:00:00.789Z",
        segment_to_exclusive: "2026-08-04T11:00:00.789Z",
        pagination_cursor: "evt_unsafe",
        status: "open",
      },
    });
    expect(plan.paginationCursor).toBeNull();
    expect(plan.resumedSegmentId).toBeNull();
    expect(plan.segmentFrom).toBe(iso(Date.parse("2026-08-04T11:50:00.000Z") - STRIPE_EVENT_OVERLAP_MS));
  });

  it("never inverts or collapses the window on a cutoff younger than the safety lag", () => {
    const cursorEndMs = Date.parse("2026-08-04T12:00:00.000Z");
    const plan = planStripeDeltaSegment({
      cursorEndMs,
      fromCandidatesMs: [cursorEndMs],
      openSegment: null,
    });
    expect(plan.segmentFromMs).toBeLessThan(plan.segmentToExclusiveMs);
  });
});

// ---------------------------------------------------------------------------------------------
// Event relevance + fan-out (pure).
// ---------------------------------------------------------------------------------------------

function event(over: Partial<StripeEventApi> & { type: string }): StripeEventApi {
  return {
    id: `evt_${over.type}`,
    created: 1_780_000_000,
    api_version: "2025-06-30.basil",
    livemode: true,
    data: { object: { id: "obj_1" } },
    ...over,
  };
}

describe("Stripe delta event fan-out", () => {
  it("pins WHY the poll is unfiltered: our event set exceeds Stripe's 20-type filter cap", () => {
    // docs.stripe.com/api/events/list — `types[]` accepts at most 20 entries. Splitting our set
    // across several filtered polls would multiply reads against the very allowance the delta
    // lane exists to protect, so we poll once unfiltered and filter locally.
    expect(STRIPE_DELTA_RELEVANT_EVENT_TYPE_COUNT).toBeGreaterThan(STRIPE_EVENTS_TYPES_FILTER_CAP);
    expect(STRIPE_DELTA_EVENT_PREFIXES.map(([prefix]) => prefix)).toEqual([
      "customer.subscription.",
      "customer.discount.",
      "customer.",
      "invoice.",
      "credit_note.",
      "price.",
      "coupon.",
      "product.",
    ]);
  });

  it("classifies the customer sub-families in the right order", () => {
    expect(stripeEventObjectKind("customer.subscription.updated")).toBe("subscription");
    expect(stripeEventObjectKind("customer.discount.created")).toBe("discount");
    expect(stripeEventObjectKind("customer.updated")).toBe("customer");
    expect(stripeEventObjectKind("customer.source.updated")).toBeNull();
    expect(stripeEventObjectKind("invoiceitem.created")).toBeNull();
    expect(stripeEventObjectKind("charge.succeeded")).toBeNull();
  });

  it("maps every family to the objects that must be re-fetched", () => {
    const fanout = stripeDeltaFanout([
      event({ type: "customer.subscription.updated", id: "evt_1", data: { object: { id: "sub_1" } } }),
      event({ type: "customer.updated", id: "evt_2", data: { object: { id: "cus_1" } } }),
      event({
        type: "customer.discount.created",
        id: "evt_3",
        data: { object: { id: "di_1", customer: "cus_2", subscription: "sub_2" } },
      }),
      event({ type: "invoice.paid", id: "evt_4", data: { object: { id: "in_1" } } }),
      event({
        type: "credit_note.created",
        id: "evt_5",
        data: { object: { id: "cn_1", invoice: { id: "in_2" } } },
      }),
      event({ type: "price.updated", id: "evt_6", data: { object: { id: "price_1" } } }),
      event({ type: "coupon.updated", id: "evt_7", data: { object: { id: "coupon_1" } } }),
      event({ type: "product.updated", id: "evt_8", data: { object: { id: "prod_1" } } }),
      event({ type: "charge.refunded", id: "evt_9", data: { object: { id: "ch_1" } } }),
      event({ type: "charge.refunded", id: "evt_10", data: { object: { id: "ch_2" } } }),
    ]);

    expect(fanout.subscriptionIds).toEqual(["sub_1", "sub_2"]);
    expect(fanout.customerIds).toEqual(["cus_1", "cus_2"]);
    expect(fanout.revalueCustomerIds).toEqual(["cus_2"]);
    expect(fanout.invoiceIds).toEqual(["in_1", "in_2"]);
    expect(fanout.priceIds).toEqual(["price_1"]);
    expect(fanout.couponIds).toEqual(["coupon_1"]);
    expect(fanout.productIds).toEqual(["prod_1"]);
    expect(fanout.ignoredEventTypes).toEqual({ "charge.refunded": 2 });
    expect(fanout.evidence).toHaveLength(8);
    expect(fanout.evidence[0]).toMatchObject({
      stripeEventId: "evt_1",
      eventType: "customer.subscription.updated",
      objectKind: "subscription",
      objectExternalId: "sub_1",
      livemode: true,
    });
  });

  it("keeps `previous_attributes` as evidence without letting it establish state", () => {
    const fanout = stripeDeltaFanout([
      event({
        type: "customer.subscription.updated",
        id: "evt_prev",
        data: { object: { id: "sub_1", status: "active" }, previous_attributes: { status: "trialing" } },
      }),
    ]);
    expect(fanout.evidence[0]?.previousAttributes).toEqual({ status: "trialing" });
    // The refetch target is the object itself — evidence never substitutes for retrieval.
    expect(fanout.subscriptionIds).toEqual(["sub_1"]);
  });

  it("de-duplicates re-delivered event ids inside one window", () => {
    const duplicate = event({
      type: "customer.subscription.updated",
      id: "evt_dupe",
      data: { object: { id: "sub_1" } },
    });
    const fanout = stripeDeltaFanout([duplicate, { ...duplicate }]);
    expect(fanout.evidence).toHaveLength(1);
    expect(fanout.subscriptionIds).toEqual(["sub_1"]);
  });

  it("fails closed on a relevant event that cannot be keyed to an object", () => {
    expect(() => stripeDeltaFanout([
      event({ type: "invoice.paid", id: "evt_bad", data: { object: {} } }),
    ])).toThrow(/carried no object id/);
    expect(() => stripeDeltaFanout([
      event({ type: "credit_note.created", id: "evt_cn", data: { object: { id: "cn_1" } } }),
    ])).toThrow(/named no invoice/);
  });

  // -------------------------------------------------------------------------------------------
  // `invoice.upcoming` — the id-less PREVIEW that would otherwise poison every real account.
  //
  // Stripe emits it a few days before EVERY subscription renewal, and its `data.object` is a
  // simulated invoice with no `id`. Matched by the `invoice.` prefix, it used to hit the id-less
  // guard and THROW, which fails the run — and because the watermark only advances on a completed
  // segment, every retry re-read the same window for up to 28 days. Every account with a
  // subscription died within days of its first renewal.
  // -------------------------------------------------------------------------------------------
  it("classifies an id-less `invoice.upcoming` as a preview NON-CHANGE, never a dropped change", () => {
    const fanout = stripeDeltaFanout([
      event({
        type: "invoice.upcoming",
        id: "evt_upcoming",
        // No `id` — the invoice does not exist yet. `customer` is what the preview is FOR.
        data: { object: { customer: "cus_1", subscription: "sub_1", amount_due: 8000 } },
      }),
    ]);
    // Nothing to re-fetch: there is no object to retrieve, and the real invoice.* events follow.
    expect(fanout.invoiceIds).toEqual([]);
    expect(fanout.subscriptionIds).toEqual([]);
    expect(fanout.customerIds).toEqual([]);
    expect(fanout.previewEventTypes).toEqual({ "invoice.upcoming": 1 });
    // …and NOT confused with an ignored family: this one describes objects we very much store.
    expect(fanout.ignoredEventTypes).toEqual({});
    // Kept as evidence, keyed to the customer, under the preview sentinel kind.
    expect(fanout.evidence).toHaveLength(1);
    expect(fanout.evidence[0]).toMatchObject({
      stripeEventId: "evt_upcoming",
      eventType: "invoice.upcoming",
      objectKind: STRIPE_INVOICE_PREVIEW_OBJECT_KIND,
      objectExternalId: "cus_1",
    });
  });

  it("still fails loudly on an id-less shape that is NOT a documented preview", () => {
    // The classification above is narrow ON PURPOSE. Every other id-less relevant event remains a
    // change we cannot key and therefore cannot re-fetch — the loud failure is the point.
    for (const type of ["invoice.updated", "invoice.finalized", "customer.subscription.updated"]) {
      expect(() => stripeDeltaFanout([
        event({ type, id: `evt_${type}`, data: { object: { customer: "cus_1" } } }),
      ])).toThrow(/carried no object id/);
    }
    // …and a preview that names neither an object nor a customer is itself an unrecognised shape.
    expect(() => stripeDeltaFanout([
      event({ type: "invoice.upcoming", id: "evt_headless", data: { object: {} } }),
    ])).toThrow(/named neither an object nor a customer/);
  });

  it("leaves the rest of the prefix-matched invoice family fanning out to a real invoice", () => {
    // Deliberate: these cost ONE extra retrieve of an object we already store, which beats missing
    // a state change. Pinned so a future "tighten the prefix" change has to argue with this test.
    const fanout = stripeDeltaFanout([
      event({ type: "invoice.sent", id: "evt_sent", data: { object: { id: "in_1" } } }),
      event({ type: "invoice.overdue", id: "evt_overdue", data: { object: { id: "in_2" } } }),
      event({
        type: "invoice.finalization_failed",
        id: "evt_ff",
        data: { object: { id: "in_3" } },
      }),
    ]);
    expect(fanout.invoiceIds).toEqual(["in_1", "in_2", "in_3"]);
    expect(fanout.previewEventTypes).toEqual({});
  });
});

describe("Stripe delta event-page merge", () => {
  const page = (id: string): StripeEventApi => ({
    id,
    type: "customer.subscription.updated",
    created: 1_700_000_000,
    data: { object: { id: "sub_1" } },
  });

  it("de-dupes the overlap by event id, first observation winning", () => {
    const merged = stripeDeltaMergeEventPages(
      [page("evt_a"), page("evt_b")],
      [page("evt_b"), page("evt_late")],
    );
    expect(merged.map((event) => event.id)).toEqual(["evt_a", "evt_b", "evt_late"]);
  });

  it("keeps an id-less event so the fan-out is the one that fails on it", () => {
    const headless = { ...page("evt_x"), id: "" } as StripeEventApi;
    expect(stripeDeltaMergeEventPages([headless], [])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Telemetry + bounded concurrency (pure).
// ---------------------------------------------------------------------------------------------

describe("Stripe request telemetry", () => {
  it("collapses object ids into endpoint classes", () => {
    expect(stripeEndpointClass("/v1/invoices/in_1abc")).toBe("/v1/invoices/{id}");
    expect(stripeEndpointClass("/v1/invoices")).toBe("/v1/invoices");
    expect(stripeEndpointClass("/v1/invoices/in_1/lines")).toBe("/v1/invoices/{id}/{id}");
    expect(stripeEndpointClass("/v1/events")).toBe("/v1/events");
  });

  it("produces a stable jsonb-shaped snapshot", () => {
    const telemetry = new StripeRequestTelemetry();
    telemetry.setLane("delta", "delta_healthy");
    telemetry.recordRequest("/v1/events");
    telemetry.recordPage("/v1/events");
    telemetry.recordRequest("/v1/subscriptions/sub_1");
    telemetry.recordRateLimited("/v1/subscriptions/sub_1", "read_rate_limit");
    telemetry.recordObjectsRefetched(2);
    telemetry.recordEventsObserved(3);

    expect(telemetry.snapshot()).toEqual({
      version: "stripe-request-telemetry-v1",
      lane: "delta",
      laneReason: "delta_healthy",
      requests: 2,
      pages: 1,
      objectsRefetched: 2,
      eventsObserved: 3,
      rateLimited: 1,
      rateLimitedReasons: { read_rate_limit: 1 },
      byEndpointClass: {
        "/v1/events": { requests: 1, pages: 1, rateLimited: 0 },
        "/v1/subscriptions/{id}": { requests: 1, pages: 0, rateLimited: 1 },
      },
      // NULL, not a zeroed record: "did not reconcile" must stay distinguishable from
      // "reconciled and found nothing" — only the second is evidence for relaxing the cadence.
      reconciliation: null,
    });
  });

  it("keeps a due-but-unapplied reconciliation honest, then stamps the outcome", () => {
    const telemetry = new StripeRequestTelemetry();
    telemetry.setLane("full", "reconciliation_due");
    telemetry.setReconciliationDue("interval_elapsed");
    // A run that dies before CLOSE leaves `applied: false` — it never claims a comparison it did
    // not finish.
    expect(telemetry.snapshot().reconciliation).toEqual({
      due: true,
      reason: "interval_elapsed",
      applied: false,
      driftCount: 0,
      repairedCount: 0,
      recordedOnlyCount: 0,
      healedByLoadCount: 0,
      countsByKind: {},
      unevaluatedDeletions: 0,
      unevaluatedDeletionReasons: {},
    });

    telemetry.recordReconciliationOutcome({
      driftCount: 3,
      repairedCount: 2,
      recordedOnlyCount: 1,
      healedByLoadCount: 1,
      countsByKind: { missing_local: 1, missing_remote: 1, state_mismatch: 1 },
      unevaluatedDeletionReasons: [
        "customer:remote_customer_set_not_a_complete_list",
        "invoice:remote_invoice_set_not_a_complete_list",
        "customer:remote_customer_set_not_a_complete_list",
      ],
    });
    expect(telemetry.snapshot().reconciliation).toEqual({
      due: true,
      // The PLAN-time reason survives the CLOSE-time stamp.
      reason: "interval_elapsed",
      applied: true,
      driftCount: 3,
      repairedCount: 2,
      recordedOnlyCount: 1,
      healedByLoadCount: 1,
      countsByKind: { missing_local: 1, missing_remote: 1, state_mismatch: 1 },
      unevaluatedDeletions: 3,
      unevaluatedDeletionReasons: {
        "customer:remote_customer_set_not_a_complete_list": 2,
        "invoice:remote_invoice_set_not_a_complete_list": 1,
      },
    });
  });
});

describe("bounded refetch concurrency", () => {
  it("preserves input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await stripeDeltaMapBounded([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end against a REAL PGlite data dir. The pure tests above cannot see what the connector
// actually WRITES — canonical rows, evidence, segments, watermarks, or the movement ledger.
// ---------------------------------------------------------------------------------------------

const CURSOR_END = "2026-08-04T12:00:00.000Z";
const CURSOR_END_MS = Date.parse(CURSOR_END);
const SEGMENT_TO = iso(CURSOR_END_MS - STRIPE_EVENT_SAFETY_LAG_MS);

type FetchHandler = (url: URL) => unknown;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A handler may return a raw `Response` to model a non-2xx (the 404 a deleted invoice returns). */
async function withMockStripe<T>(handler: FetchHandler, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const value = handler(new URL(String(input)));
    return Promise.resolve(value instanceof Response ? value : jsonResponse(value));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function subscriptionApi(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_delta",
    livemode: true,
    currency: "usd",
    customer: { id: "cus_delta", email: "founder@example.test", name: "Founder", metadata: {} },
    status: "active",
    created: 1_760_000_000,
    current_period_start: Math.floor(CURSOR_END_MS / 1000) - 5 * 24 * 60 * 60,
    current_period_end: Math.floor(CURSOR_END_MS / 1000) + 25 * 24 * 60 * 60,
    trial_start: null,
    trial_end: null,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    discounts: [],
    items: { has_more: false, data: [subscriptionItemApi()] },
    ...over,
  };
}

function subscriptionItemApi(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "si_delta",
    quantity: 1,
    discounts: [],
    price: {
      id: "price_delta",
      product: "prod_delta",
      currency: "usd",
      unit_amount: 8000,
      billing_scheme: "per_unit",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    },
    ...over,
  };
}

function subscriptionEvent(id: string, subscription: Record<string, unknown>, createdOffsetS: number) {
  return {
    id,
    type: "customer.subscription.updated",
    created: Math.floor(Date.parse(SEGMENT_TO) / 1000) - createdOffsetS,
    api_version: "2025-06-30.basil",
    livemode: true,
    data: { object: subscription, previous_attributes: { status: "active" } },
  };
}

describe("Stripe delta lane against real PGlite", () => {
  let dataDir: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-stripe-delta-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 180_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedSource(workspaceId: string, sourceId: string): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const datasets = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId],
    );
    await db.query(
      `insert into sources (
         id, workspace_id, dataset_id, provider, connection_name, account_external_id, status
       ) values ($1,$2,$3,'stripe','Stripe',$1,'connected')`,
      [sourceId, workspaceId, datasets[0]?.id],
    );
    await db.query(
      `insert into connection_credentials (
         id, workspace_id, source_id, credential_kind, encrypted_payload
       ) values ($1,$2,$3,'api_key',$4)`,
      [
        `cred_${randomUUID()}`,
        workspaceId,
        sourceId,
        encryptCredentialPayload(
          { mode: "live", secretKey: "sk_test", apiBaseUrl: "https://stripe.test" },
          TEST_ENCRYPTION_KEY,
        ),
      ],
    );
  }

  /**
   * Pretend a full import AND a reconciliation already landed, so lane selection resolves to
   * DELTA. `reconciled_at` is load-bearing here: a source that has never been reconciled is
   * `never_reconciled`-due, which FORCES the full lane no matter how healthy its delta chain is.
   */
  async function seedHealthyWatermark(
    workspaceId: string,
    sourceId: string,
    over: { deltaDataAsOf?: string; lastFullRefreshAt?: string; reconciledAt?: string } = {},
  ): Promise<void> {
    await db.query(
      `insert into stripe_sync_watermarks (
         id, workspace_id, source_id, delta_data_as_of, last_full_refresh_at,
         continuous_coverage_from, reconciled_at
       ) values ($1,$2,$3,$4,$5,$4,$6)
       on conflict (workspace_id, source_id) do update set
         delta_data_as_of = excluded.delta_data_as_of,
         last_full_refresh_at = excluded.last_full_refresh_at,
         reconciled_at = excluded.reconciled_at`,
      [
        `wm_${randomUUID()}`,
        workspaceId,
        sourceId,
        over.deltaDataAsOf ?? iso(CURSOR_END_MS - 20 * 60 * 1000),
        over.lastFullRefreshAt ?? iso(CURSOR_END_MS - 3 * 60 * 60 * 1000),
        over.reconciledAt ?? iso(CURSOR_END_MS - 3 * 60 * 60 * 1000),
      ],
    );
  }

  function request(workspaceId: string, sourceId: string): SyncRequest {
    return {
      workspaceId,
      sourceId,
      provider: "stripe",
      syncRunId: `run_${randomUUID()}`,
      encryptionKey: TEST_ENCRYPTION_KEY,
      // Pins `plan.cursorEnd` so the window arithmetic (and therefore every persisted bound) is
      // deterministic instead of wall-clock dependent.
      windowUntil: CURSOR_END,
    };
  }

  async function runSync(
    workspaceId: string,
    sourceId: string,
    handler: FetchHandler,
  ): Promise<SyncRequest> {
    const syncRequest = request(workspaceId, sourceId);
    await withMockStripe(handler, () => connectorFor("stripe").sync(db, syncRequest));
    return syncRequest;
  }

  /** Router for a DELTA run: connection test + one unfiltered events page + retrievals. */
  function deltaRouter(options: {
    events: unknown[];
    hasMore?: boolean;
    subscriptions?: Record<string, Record<string, unknown>>;
    subscriptionItems?: Record<string, { data: unknown[]; has_more: boolean }>;
    invoices?: Record<string, Record<string, unknown>>;
    customers?: Record<string, Record<string, unknown>>;
    onUrl?: (url: URL) => void;
  }): FetchHandler {
    return (url) => {
      options.onUrl?.(url);
      const path = url.pathname;
      if (path === "/v1/customers") return { data: [], has_more: false };
      if (path === "/v1/events") {
        expect(url.searchParams.getAll("types[]")).toEqual([]);
        expect(url.searchParams.get("type")).toBeNull();
        return { data: options.events, has_more: options.hasMore ?? false };
      }
      if (path === "/v1/subscription_items") {
        const subscriptionId = url.searchParams.get("subscription") ?? "";
        return options.subscriptionItems?.[subscriptionId] ?? { data: [], has_more: false };
      }
      const [, , collection, id] = path.split("/");
      if (collection === "subscriptions" && id) {
        const found = options.subscriptions?.[id];
        if (!found) throw new Error(`unexpected subscription retrieve: ${id}`);
        return found;
      }
      if (collection === "invoices" && id) {
        const found = options.invoices?.[id];
        if (!found) throw new Error(`unexpected invoice retrieve: ${id}`);
        return found;
      }
      if (collection === "customers" && id) {
        const found = options.customers?.[id];
        if (!found) throw new Error(`unexpected customer retrieve: ${id}`);
        return found;
      }
      if (collection === "coupons" && id) return { id, duration: "forever", percent_off: 10 };
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    };
  }

  it("runs a delta segment end to end: canonical rows, evidence, segment, watermark, ledger", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    // Prior settled state: this customer was worth $80/mo at the last close.
    await db.query(
      `insert into stripe_customer_mrr_states (
         id, workspace_id, source_id, stripe_customer_id, currency, monthly_amount_minor,
         has_ever_positive, evidence_hash, last_complete_observed_at, classifier_version
       ) values ($1,$2,$3,'cus_delta','usd',8000,true,'prior-8000',$4,'stripe_customer_mrr_v1')`,
      [`state_${randomUUID()}`, workspaceId, sourceId, iso(CURSOR_END_MS - 60 * 60 * 1000)],
    );

    const urls: URL[] = [];
    await runSync(workspaceId, sourceId, deltaRouter({
      // TWO events for the same subscription inside one window: $80 -> $100 -> $60. Settled-state
      // semantics mean the ledger records ONE fact against the retrieved CURRENT value, not the
      // intermediate spike — while BOTH events are kept as immutable evidence.
      events: [
        subscriptionEvent("evt_spike", subscriptionApi({
          items: { has_more: false, data: [subscriptionItemApi({ price: { ...(subscriptionItemApi().price as Record<string, unknown>), unit_amount: 10000 } })] },
        }), 120),
        subscriptionEvent("evt_settle", subscriptionApi(), 60),
      ],
      subscriptions: {
        sub_delta: subscriptionApi({
          items: {
            has_more: false,
            data: [subscriptionItemApi({
              price: { ...(subscriptionItemApi().price as Record<string, unknown>), unit_amount: 6000 },
            })],
          },
        }),
      },
      onUrl: (url) => urls.push(url),
    }));

    // The events poll used the half-open second-aligned window, unfiltered.
    const eventsUrl = urls.find((url) => url.pathname === "/v1/events");
    expect(eventsUrl?.searchParams.get("created[lt]")).toBe(String(Date.parse(SEGMENT_TO) / 1000));
    expect(eventsUrl?.searchParams.has("created[lte]")).toBe(false);

    // Canonical state came from the RETRIEVE, not from either event payload.
    const items = await db.query<{ unit_amount: string }>(
      `select unit_amount::text from stripe_subscription_items
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(items).toEqual([{ unit_amount: "6000" }]);

    // Both events are immutable evidence, keyed to the object they describe.
    const evidence = await db.query<{
      stripe_event_id: string; object_kind: string; object_external_id: string;
      previous_attributes: unknown;
    }>(
      `select stripe_event_id, object_kind, object_external_id, previous_attributes
         from stripe_event_evidence
        where workspace_id = $1 and source_id = $2 order by stripe_event_id`,
      [workspaceId, sourceId],
    );
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      stripe_event_id: "evt_settle",
      object_kind: "subscription",
      object_external_id: "sub_delta",
      previous_attributes: { status: "active" },
    });

    const segments = await db.query<{
      segment_from: Date; segment_to_exclusive: Date; status: string;
      event_count: number; refetch_count: number; pagination_cursor: string | null;
    }>(
      `select segment_from, segment_to_exclusive, status, event_count, refetch_count,
              pagination_cursor
         from stripe_event_segments where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.status).toBe("closed");
    expect(segments[0]?.event_count).toBe(2);
    expect(segments[0]?.refetch_count).toBe(1);
    expect(segments[0]?.pagination_cursor).toBeNull();
    expect(new Date(segments[0]!.segment_to_exclusive).toISOString()).toBe(SEGMENT_TO);

    const watermarks = await db.query<{ delta_data_as_of: Date; last_full_refresh_at: Date }>(
      `select delta_data_as_of, last_full_refresh_at from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);

    // ONE settled-state movement fact, from $80 to the retrieved $60.
    const movements = await db.query<{
      movement_kind: string; from_amount_minor: string; to_amount_minor: string; provenance: string;
    }>(
      `select movement_kind, from_amount_minor::text, to_amount_minor::text, provenance
         from stripe_customer_mrr_movements where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movement_kind: "contraction",
      provenance: "forward_observed_v1",
    });
    expect(Number(movements[0]!.from_amount_minor)).toBe(8000);
    expect(Number(movements[0]!.to_amount_minor)).toBe(6000);
  }, 120_000);

  it("persists per-run request telemetry on the sync run", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    const syncRequest = await runSync(workspaceId, sourceId, deltaRouter({
      events: [subscriptionEvent("evt_tel", subscriptionApi(), 60)],
      subscriptions: { sub_delta: subscriptionApi() },
    }));

    const runs = await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [syncRequest.syncRunId],
    );
    const telemetry = runs[0]?.request_telemetry as Record<string, unknown>;
    expect(telemetry).toMatchObject({
      version: "stripe-request-telemetry-v1",
      lane: "delta",
      laneReason: "delta_healthy",
      eventsObserved: 1,
      objectsRefetched: 1,
      rateLimited: 0,
    });
    const byClass = telemetry.byEndpointClass as Record<string, { requests: number }>;
    expect(byClass["/v1/events"]?.requests).toBe(1);
    expect(byClass["/v1/subscriptions/{id}"]?.requests).toBe(1);
  }, 120_000);

  it("stops mid-window without claiming it, then RESUMES the same segment from its cursor", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    const priorWatermark = iso(CURSOR_END_MS - 20 * 60 * 1000);

    // A busy window: every page reports has_more, so the bounded-page run stops short of the end.
    let page = 0;
    const eventUrls: URL[] = [];
    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") {
        eventUrls.push(url);
        page += 1;
        return {
          data: [subscriptionEvent(`evt_page_${page}`, subscriptionApi(), 600 - page)],
          has_more: true,
        };
      }
      const [, , collection, id] = url.pathname.split("/");
      if (collection === "subscriptions" && id) return subscriptionApi();
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });
    expect(page).toBe(5);
    expect(eventUrls.at(-1)?.searchParams.get("starting_after")).toBe("evt_page_4");

    const segments = await db.query<{
      segment_from: Date; segment_to_exclusive: Date; status: string;
      pagination_cursor: string | null; event_count: number;
    }>(
      `select segment_from, segment_to_exclusive, status, pagination_cursor, event_count
         from stripe_event_segments where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments[0]).toMatchObject({ status: "open", pagination_cursor: "evt_page_5" });
    const openedFrom = new Date(segments[0]!.segment_from).toISOString();

    const watermarks = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    // Unadvanced: a partially-read window must never be claimed as observed.
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(priorWatermark);

    // RESUME: same bounds, same cursor, and the segment finally closes.
    const resumeUrls: URL[] = [];
    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") {
        resumeUrls.push(url);
        return {
          data: [subscriptionEvent("evt_page_6", subscriptionApi(), 10)],
          has_more: false,
        };
      }
      const [, , collection, id] = url.pathname.split("/");
      if (collection === "subscriptions" && id) return subscriptionApi();
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });
    expect(resumeUrls[0]?.searchParams.get("starting_after")).toBe("evt_page_5");
    expect(resumeUrls[0]?.searchParams.get("created[gte]"))
      .toBe(String(Date.parse(openedFrom) / 1000));

    const closed = await db.query<{ status: string; event_count: number; count: string }>(
      `select status, event_count, count(*) over ()::text as count
         from stripe_event_segments where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.status).toBe("closed");
    // Resuming ACCUMULATES: 5 events on the first pass, 1 more after the cursor.
    expect(closed[0]?.event_count).toBe(6);

    const advanced = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(advanced[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);
  }, 120_000);

  it("re-reading the deliberate overlap is idempotent — no duplicate evidence or movements", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    await db.query(
      `insert into stripe_customer_mrr_states (
         id, workspace_id, source_id, stripe_customer_id, currency, monthly_amount_minor,
         has_ever_positive, evidence_hash, last_complete_observed_at, classifier_version
       ) values ($1,$2,$3,'cus_delta','usd',5000,true,'prior-5000',$4,'stripe_customer_mrr_v1')`,
      [`state_${randomUUID()}`, workspaceId, sourceId, iso(CURSOR_END_MS - 60 * 60 * 1000)],
    );

    const router = deltaRouter({
      events: [subscriptionEvent("evt_overlap", subscriptionApi(), 60)],
      subscriptions: { sub_delta: subscriptionApi() },
    });
    await runSync(workspaceId, sourceId, router);
    // Second run replays the SAME window (the watermark seeding is restored), which is exactly
    // what the 5-minute overlap does on every real run.
    await seedHealthyWatermark(workspaceId, sourceId);
    await runSync(workspaceId, sourceId, router);

    const evidence = await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_event_evidence where workspace_id = $1",
      [workspaceId],
    );
    expect(evidence[0]?.count).toBe("1");

    const segments = await db.query<{ count: string; event_count: number }>(
      `select count(*)::text as count, max(event_count) as event_count
         from stripe_event_segments where workspace_id = $1`,
      [workspaceId],
    );
    expect(segments[0]?.count).toBe("1");
    // Replaying a CLOSED window replaces the count rather than doubling it.
    expect(segments[0]?.event_count).toBe(1);

    const movements = await db.query<{ movement_kind: string }>(
      "select movement_kind from stripe_customer_mrr_movements where workspace_id = $1",
      [workspaceId],
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]?.movement_kind).toBe("expansion");
  }, 120_000);

  it("revalues a referencing subscription from a coupon event via the local reverse index", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    // Baseline: a subscription we already know references coupon_ten. Stripe emits NO event on
    // the subscription when the coupon changes, so only our own tables can connect the two.
    await db.query(
      `insert into stripe_subscriptions (
         id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
         created_at_source, items_sync_complete, discounts_sync_complete, livemode
       ) values ($1,$2,$3,'sub_delta','cus_delta','active',now(),true,true,true)`,
      [`sub_${randomUUID()}`, workspaceId, sourceId],
    );
    await db.query(
      `insert into stripe_subscription_discounts (
         id, workspace_id, source_id, stripe_subscription_id, target_type, target_id,
         stripe_discount_id, stripe_coupon_id, position, is_complete
       ) values ($1,$2,$3,'sub_delta','subscription','sub_delta','di_1','coupon_ten',0,true)`,
      [`sdisc_${randomUUID()}`, workspaceId, sourceId],
    );

    const retrieved: string[] = [];
    await runSync(workspaceId, sourceId, deltaRouter({
      events: [{
        id: "evt_coupon",
        type: "coupon.updated",
        created: Math.floor(Date.parse(SEGMENT_TO) / 1000) - 60,
        api_version: "2025-06-30.basil",
        livemode: true,
        data: { object: { id: "coupon_ten", duration: "forever", percent_off: 25 } },
      }],
      subscriptions: {
        sub_delta: subscriptionApi({
          discounts: [{
            id: "di_1",
            start: Math.floor(CURSOR_END_MS / 1000) - 86_400,
            end: null,
            source: {
              type: "coupon",
              coupon: { id: "coupon_ten", duration: "forever", percent_off: 25, currency: "usd" },
            },
          }],
        }),
      },
      onUrl: (url) => {
        const [, , collection, id] = url.pathname.split("/");
        if (collection === "subscriptions" && id) retrieved.push(id);
      },
    }));

    expect(retrieved).toEqual(["sub_delta"]);
    const discounts = await db.query<{ percent_off: string; stripe_coupon_id: string }>(
      `select percent_off::text, stripe_coupon_id from stripe_subscription_discounts
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(discounts).toEqual([{ percent_off: "25", stripe_coupon_id: "coupon_ten" }]);
  }, 120_000);

  it("pages subscription items on a delta refetch — embedded items truncate", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    await runSync(workspaceId, sourceId, deltaRouter({
      events: [subscriptionEvent("evt_items", subscriptionApi(), 60)],
      subscriptions: {
        // The retrieve embeds only the first item and flags has_more; trusting it would replace
        // the complete child set with a partial one.
        sub_delta: subscriptionApi({ items: { has_more: true, data: [subscriptionItemApi()] } }),
      },
      subscriptionItems: {
        sub_delta: {
          has_more: false,
          data: [
            subscriptionItemApi(),
            subscriptionItemApi({
              id: "si_delta_2",
              price: {
                id: "price_delta_2",
                product: "prod_delta",
                currency: "usd",
                unit_amount: 1500,
                billing_scheme: "per_unit",
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              },
            }),
          ],
        },
      },
    }));

    const items = await db.query<{ stripe_subscription_item_id: string }>(
      `select stripe_subscription_item_id from stripe_subscription_items
        where workspace_id = $1 and source_id = $2 order by stripe_subscription_item_id`,
      [workspaceId, sourceId],
    );
    expect(items.map((row) => row.stripe_subscription_item_id)).toEqual(["si_delta", "si_delta_2"]);
  }, 120_000);

  it("takes the FULL lane on a fresh source and stamps the watermark that unlocks delta", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    const paths: string[] = [];
    await runSync(workspaceId, sourceId, (url) => {
      paths.push(`${url.pathname}?${url.searchParams.getAll("types[]").length > 0 ? "typed" : "plain"}`);
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/invoices") return { data: [], has_more: false };
      if (url.pathname === "/v1/subscriptions") return { data: [subscriptionApi()], has_more: false };
      if (url.pathname === "/v1/events") return { data: [], has_more: false };
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });

    // A full refresh LISTS; it does not open a delta segment.
    expect(paths).toContain("/v1/subscriptions?plain");
    const segments = await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_event_segments where workspace_id = $1",
      [workspaceId],
    );
    expect(segments[0]?.count).toBe("0");

    const watermarks = await db.query<{
      delta_data_as_of: Date; last_full_refresh_at: Date; continuous_coverage_from: Date;
    }>(
      `select delta_data_as_of, last_full_refresh_at, continuous_coverage_from
         from stripe_sync_watermarks where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.last_full_refresh_at).toISOString()).toBe(CURSOR_END);
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);
    expect(new Date(watermarks[0]!.continuous_coverage_from).toISOString()).toBe(SEGMENT_TO);

    // …and the next run inside the interval is now a DELTA run (unfiltered events poll).
    const plan = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(plan.stripeSyncLane).toEqual({
      lane: "delta",
      reason: "delta_healthy",
      coverageGapReason: null,
    });
  }, 120_000);

  it("forces FULL, records the gap, and RESETS continuous coverage when the chain is broken", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const staleCoverage = iso(CURSOR_END_MS - 90 * 24 * 60 * 60 * 1000);
    await db.query(
      `insert into stripe_sync_watermarks (
         id, workspace_id, source_id, delta_data_as_of, last_full_refresh_at,
         continuous_coverage_from
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        `wm_${randomUUID()}`,
        workspaceId,
        sourceId,
        // Older than the 28-day safe event-retention floor: the sequence is unrecoverable.
        iso(CURSOR_END_MS - 40 * 24 * 60 * 60 * 1000),
        iso(CURSOR_END_MS - 60 * 60 * 1000),
        staleCoverage,
      ],
    );

    const plan = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(plan.stripeSyncLane).toEqual({
      lane: "full",
      reason: "delta_coverage_gap",
      coverageGapReason: "delta_watermark_beyond_event_retention",
    });

    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/invoices") return { data: [], has_more: false };
      if (url.pathname === "/v1/subscriptions") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") return { data: [], has_more: false };
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });

    const watermarks = await db.query<{ continuous_coverage_from: Date }>(
      `select continuous_coverage_from from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    // Reset, never back-dated: history before the gap can no longer be claimed as continuous.
    expect(new Date(watermarks[0]!.continuous_coverage_from).toISOString()).toBe(SEGMENT_TO);
    expect(new Date(watermarks[0]!.continuous_coverage_from).toISOString())
      .not.toBe(staleCoverage);
  }, 120_000);

  it("serializes the lanes: a competing run cannot interleave writes on one source", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    // ADMISSION. The source lease is lane-agnostic: whichever run claims first owns the source,
    // and the other is rejected before it can fetch or write anything.
    await db.query("update sources set status = 'syncing' where id = $1", [sourceId]);
    await expect(
      runSync(workspaceId, sourceId, deltaRouter({ events: [] })),
    ).rejects.toThrow(/already syncing/);
    await db.query("update sources set status = 'connected' where id = $1", [sourceId]);

    // CLOSE OWNERSHIP. Even if a run is superseded mid-flight (the boot sweep resets a stale
    // `syncing` source), its CLOSE refuses to advance the watermark on the new owner's behalf.
    const { writeStripeSyncLaneAtClose, StripeDeltaCloseClaimLostError } =
      await import("./stripe-delta.js");
    const orphanRunId = `run_${randomUUID()}`;
    await db.query(
      "insert into sync_runs (id, workspace_id, source_id, status) values ($1,$2,$3,'failed')",
      [orphanRunId, workspaceId, sourceId],
    );
    await expect(db.withTransaction((tx) => writeStripeSyncLaneAtClose(
      tx,
      { workspaceId, sourceId, syncRunId: orphanRunId },
      {
        lane: "delta",
        segmentFrom: iso(CURSOR_END_MS - 60 * 60 * 1000),
        segmentToExclusive: SEGMENT_TO,
        paginationCursor: null,
        segmentComplete: true,
        eventCount: 0,
        refetchCount: 0,
        evidence: [],
        resetContinuousCoverage: false,
        pendingFullRefreshReason: null,
      },
    ))).rejects.toBeInstanceOf(StripeDeltaCloseClaimLostError);

    const segments = await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_event_segments where workspace_id = $1",
      [workspaceId],
    );
    expect(segments[0]?.count).toBe("0");
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // Reconciliation, wired into the FULL lane.
  // -------------------------------------------------------------------------------------------

  /** Router for a FULL refresh: connection test + the three lists the full extractor reads. */
  function fullRouter(options: {
    subscriptions?: unknown[];
    invoices?: unknown[];
    events?: unknown[];
  } = {}): FetchHandler {
    return (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/invoices") return { data: options.invoices ?? [], has_more: false };
      if (url.pathname === "/v1/subscriptions") {
        return { data: options.subscriptions ?? [subscriptionApi()], has_more: false };
      }
      if (url.pathname === "/v1/events") return { data: options.events ?? [], has_more: false };
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    };
  }

  function readDrift(workspaceId: string, sourceId: string) {
    return db.query<{
      entity_kind: string; object_external_id: string; drift_kind: string; repaired: boolean;
      detail: Record<string, unknown> | null; run_started_at: Date;
    }>(
      `select entity_kind, object_external_id, drift_kind, repaired, detail, run_started_at
         from stripe_reconciliation_drift where workspace_id = $1 and source_id = $2
        order by entity_kind, object_external_id, drift_kind`,
      [workspaceId, sourceId],
    );
  }

  function readReconciliationWatermarks(workspaceId: string, sourceId: string) {
    return db.one<{ reconciled_at: Date | null; last_drift_at: Date | null }>(
      `select reconciled_at, last_drift_at from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
  }

  it("bootstraps a fresh source, repairs the one writer gap, then settles to ZERO drift", async () => {
    // `never_reconciled` makes the very FIRST sync of every source a reconciling run. LOAD has
    // already committed the rows the snapshot describes, so the only difference it can find is
    // where the LOAD writers disagree with the object Stripe returned — here exactly one: the
    // subscription lane's customer upsert does not carry `name` at all, so a customer known only
    // through subscriptions never gets one. Reconciliation fills it in ONCE and it stays filled.
    // That "settles to zero on the second pass" property is the whole point: a difference that
    // reappeared every run would be a writer/reconciler divergence, not drift.
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    const plan = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(plan.stripeSyncLane).toMatchObject({ lane: "full", reason: "no_watermark" });

    const syncRequest = await runSync(workspaceId, sourceId, fullRouter());

    const bootstrapDrift = await readDrift(workspaceId, sourceId);
    expect(bootstrapDrift.map((row) => [row.entity_kind, row.object_external_id, row.drift_kind]))
      .toEqual([["customer", "cus_delta", "state_mismatch"]]);
    // No PRE-LOAD projection on a bootstrap (there is no prior snapshot to have drifted FROM), so
    // the comparison is the live one and the marker says this reconciliation wrote the fix.
    expect(bootstrapDrift[0]?.detail).toEqual({ fields: ["name"], repair: "direct" });
    expect(bootstrapDrift[0]?.repaired).toBe(true);

    const watermarks = await readReconciliationWatermarks(workspaceId, sourceId);
    expect(new Date(watermarks!.reconciled_at!).toISOString()).toBe(CURSOR_END);
    expect(watermarks?.last_drift_at).not.toBeNull();

    const runs = await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [syncRequest.syncRunId],
    );
    expect((runs[0]?.request_telemetry as Record<string, unknown>).reconciliation).toMatchObject({
      due: true,
      reason: "never_reconciled",
      applied: true,
      driftCount: 1,
      repairedCount: 1,
      countsByKind: { missing_local: 0, missing_remote: 0, state_mismatch: 1 },
      // Honest about what it could NOT prove: the full refresh never lists customers, invoices or
      // prices, so deletion is unevaluable for all three.
      unevaluatedDeletions: 3,
      unevaluatedDeletionReasons: {
        "customer:remote_customer_set_not_a_complete_list": 1,
        "invoice:remote_invoice_set_not_a_complete_list": 1,
        "price:remote_price_set_not_a_complete_list": 1,
      },
    });

    // SECOND PASS over the SAME remote state: what the reconciler wrote is exactly what it next
    // expects to see, so it now reports the clean run the cadence decision is allowed to count.
    await db.query(
      `update stripe_sync_watermarks set reconciled_at = $3
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId, iso(CURSOR_END_MS - 25 * 60 * 60 * 1000)],
    );
    const second = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(second.stripeSyncLane).toMatchObject({ lane: "full", reason: "reconciliation_due" });
    const secondRun = await runSync(workspaceId, sourceId, fullRouter());
    expect(await readDrift(workspaceId, sourceId)).toHaveLength(1);
    const secondRuns = await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [secondRun.syncRunId],
    );
    expect((secondRuns[0]?.request_telemetry as Record<string, unknown>).reconciliation)
      .toMatchObject({ due: true, reason: "interval_elapsed", applied: true, driftCount: 0 });
  }, 120_000);

  it("upgrades a DELTA-healthy source to the FULL lane on a due reconciliation, then records and repairs drift", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    // Full refresh 3h ago (inside the daily interval) + a healthy delta chain: this run would be
    // DELTA. The last reconciliation was 25h ago, so the daily interval has elapsed.
    await seedHealthyWatermark(workspaceId, sourceId, {
      reconciledAt: iso(CURSOR_END_MS - 25 * 60 * 60 * 1000),
    });

    // A subscription Stripe no longer lists. Full replacement has never deleted a parent row, so
    // the reconciler must RECORD it and repair nothing — deleting it would mint instant churn.
    await db.query(
      `insert into stripe_subscriptions (
         id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
         items_sync_complete, discounts_sync_complete, livemode
       ) values ($1,$2,$3,'sub_ghost','cus_ghost','active',true,true,true)`,
      [`sub_${randomUUID()}`, workspaceId, sourceId],
    );
    // A stale customer projection. The LOAD writer COALESCES email (and never writes `name` from
    // the subscription lane at all), so a value REMOVED in Stripe survives every full sync — this
    // is precisely the class of staleness only a full-set comparison can clear.
    await db.query(
      `insert into stripe_customers (id, workspace_id, source_id, stripe_customer_id, email, name)
       values ($1,$2,$3,'cus_delta','stale@old.test','Old Name')`,
      [`cus_${randomUUID()}`, workspaceId, sourceId],
    );

    const plan = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(plan.stripeSyncLane).toEqual({
      lane: "full",
      reason: "reconciliation_due",
      coverageGapReason: null,
    });

    const syncRequest = await runSync(workspaceId, sourceId, fullRouter({
      // Stripe now reports this customer with no email and no name.
      subscriptions: [subscriptionApi({ customer: { id: "cus_delta", metadata: {} } })],
    }));

    const drift = await readDrift(workspaceId, sourceId);
    // MEASURED PRE-LOAD. The source claims a completed prior import but has no local subscription,
    // item or price — objects the delta lane should have created and did not. The LOAD's full
    // replacement heals all three before CLOSE opens, which is precisely why the comparison is
    // taken against the pre-LOAD projection: measured post-LOAD they are invisible, and the
    // relax-daily-to-weekly gate would read "clean" off a run that found three real misses.
    expect(drift.map((row) => [row.entity_kind, row.object_external_id, row.drift_kind, row.repaired]))
      .toEqual([
        ["customer", "cus_delta", "state_mismatch", true],
        ["price", "price_delta", "missing_local", false],
        ["subscription", "sub_delta", "missing_local", false],
        ["subscription", "sub_ghost", "missing_remote", false],
        ["subscription_item", "si_delta", "missing_local", false],
      ]);
    // The writer gap (email/name) SURVIVED the load, so it is repaired directly…
    expect(drift[0]?.detail).toEqual({ fields: ["email", "name"], repair: "direct" });
    // …while the three misses the full replacement healed are recorded, not repaired, and say so.
    expect(drift[1]?.detail).toMatchObject({ repair: "full_replacement" });
    expect(drift[2]?.detail).toMatchObject({ repair: "full_replacement" });
    expect(drift[4]?.detail).toMatchObject({ repair: "full_replacement" });
    expect(drift[3]?.detail).toMatchObject({
      reason: "parent_rows_are_never_deleted_by_full_replacement",
      childRowsNotCompared: true,
      // Unrepairable by contract — a different thing from "already healed".
      repair: "none",
    });
    // Every drift row is tied back to the comparison that produced it.
    expect(drift.every((row) => new Date(row.run_started_at).toISOString() === CURSOR_END))
      .toBe(true);

    const customer = await db.one<{ email: string | null; name: string | null }>(
      `select email, name from stripe_customers
        where workspace_id = $1 and source_id = $2 and stripe_customer_id = 'cus_delta'`,
      [workspaceId, sourceId],
    );
    expect(customer).toEqual({ email: null, name: null });
    // RECORDED, NOT REPAIRED: the ghost subscription is still there.
    const ghost = await db.one<{ status: string }>(
      `select status from stripe_subscriptions
        where workspace_id = $1 and source_id = $2 and stripe_subscription_id = 'sub_ghost'`,
      [workspaceId, sourceId],
    );
    expect(ghost?.status).toBe("active");

    const watermarks = await readReconciliationWatermarks(workspaceId, sourceId);
    expect(new Date(watermarks!.reconciled_at!).toISOString()).toBe(CURSOR_END);
    expect(watermarks?.last_drift_at).not.toBeNull();

    const runs = await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [syncRequest.syncRunId],
    );
    const telemetry = runs[0]?.request_telemetry as Record<string, unknown>;
    expect(telemetry).toMatchObject({ lane: "full", laneReason: "reconciliation_due" });
    expect(telemetry.reconciliation).toMatchObject({
      due: true,
      reason: "interval_elapsed",
      applied: true,
      driftCount: 5,
      repairedCount: 1,
      recordedOnlyCount: 4,
      // The number the old post-LOAD-only comparison could never report.
      healedByLoadCount: 3,
      countsByKind: { missing_local: 3, missing_remote: 1, state_mismatch: 1 },
    });
  }, 120_000);

  it("repairs a drifted amount BEFORE the movement classifier reads it, inside one CLOSE", async () => {
    // THE ORDERING CONTRACT. `writeStripeCloseSuccess` runs reconciliation first and the MRR
    // classifier second, in ONE transaction, so a repaired value is the value the immutable ledger
    // fact is minted from. Driven directly here rather than through `sync()` because on a FULL run
    // LOAD has already rewritten canonical state by the time CLOSE opens — the state this pins is
    // the one the DELTA lane leaves behind (a missed event, an object edited outside the event
    // stream) and that only the daily full-set comparison can find.
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    // Settled truth at the last close: $80/mo — matching the canonical state the bootstrap sync
    // below writes, so that sync mints no movement of its own.
    await db.query(
      `insert into stripe_customer_mrr_states (
         id, workspace_id, source_id, stripe_customer_id, currency, monthly_amount_minor,
         has_ever_positive, evidence_hash, last_complete_observed_at, classifier_version
       ) values ($1,$2,$3,'cus_delta','usd',8000,true,'prior-8000',$4,'stripe_customer_mrr_v1')`,
      [`state_${randomUUID()}`, workspaceId, sourceId, iso(CURSOR_END_MS - 60 * 60 * 1000)],
    );
    // Canonical state as the delta lane left it: `subscriptionItemApi()` prices at $80, and WRONG.
    await runSync(workspaceId, sourceId, fullRouter());

    // Stripe's actual current truth is $60.
    const remoteSubscription = {
      subscriptionId: "sub_delta",
      customerId: "cus_delta",
      liveMode: true,
      status: "active",
      createdAt: new Date(1_760_000_000 * 1000).toISOString(),
      currentPeriodStart: iso((Math.floor(CURSOR_END_MS / 1000) - 5 * 24 * 60 * 60) * 1000),
      currentPeriodEnd: iso((Math.floor(CURSOR_END_MS / 1000) + 25 * 24 * 60 * 60) * 1000),
      trialStart: null,
      trialEnd: null,
      cancelAt: null,
      canceledAt: null,
      endedAt: null,
      itemsSynced: true,
      discountsSynced: true,
      discounts: [],
      items: [{
        itemId: "si_delta",
        priceId: "price_delta",
        productId: "prod_delta",
        currency: "usd",
        unitAmount: 6000,
        defaultCurrency: "usd",
        defaultUnitAmount: 6000,
        priceCurrencyOptions: {},
        currencyOptionResolved: true,
        quantity: 1,
        recurringInterval: "month",
        recurringIntervalCount: 1,
        recurringUsageType: "licensed",
        billingScheme: "per_unit",
        customUnitAmount: false,
        transformQuantityDivideBy: null,
        transformQuantityRound: null,
        // The value view fails CLOSED on anything else: only `licensed_per_unit` is valuable.
        pricingState: "licensed_per_unit",
        discounts: [],
      }],
    } satisfies StripeReconcileRemoteSubscription;

    const syncRunId = `run_${randomUUID()}`;
    await db.query(
      "insert into sync_runs (id, workspace_id, source_id, status) values ($1,$2,$3,'running')",
      [syncRunId, workspaceId, sourceId],
    );
    const scope = { workspaceId, sourceId, runStartedAt: CURSOR_END };
    await db.withTransaction(async (tx) => {
      const reconciliationPlan = await computeReconciliationPlan(tx, scope, {
        customers: { rows: [], listComplete: false },
        subscriptions: { rows: [remoteSubscription], listComplete: true },
        invoices: { rows: [], listComplete: false },
        prices: stripeRemotePricesFromSubscriptions([remoteSubscription]),
      });
      // The item AND the price it derives from both moved: the reconciler names each one.
      expect(reconciliationPlan.differences
        .map((difference) => [
          difference.entityKind,
          difference.objectExternalId,
          difference.driftKind,
        ]))
        .toEqual([
          ["price", "price_delta", "state_mismatch"],
          ["subscription_item", "si_delta", "state_mismatch"],
        ]);
      const outcome = await applyReconciliation(tx, reconciliationPlan, { ...scope, syncRunId });
      expect(outcome.countsByKind.state_mismatch).toBe(2);
      // SAME TRANSACTION, immediately after — exactly the order writeStripeCloseSuccess uses.
      await writeStripeMrrMovementsAtClose(tx, { workspaceId, sourceId, syncRunId });
    });

    const movements = await db.query<{
      movement_kind: string; from_amount_minor: string; to_amount_minor: string;
    }>(
      `select movement_kind, from_amount_minor::text, to_amount_minor::text
         from stripe_customer_mrr_movements where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    // The fact is minted from the REPAIRED $60, not the drifted $80 the classifier would have read
    // had reconciliation run after it (which would have produced NO movement at all).
    expect(movements).toHaveLength(1);
    expect(movements[0]?.movement_kind).toBe("contraction");
    expect(Number(movements[0]!.from_amount_minor)).toBe(8000);
    expect(Number(movements[0]!.to_amount_minor)).toBe(6000);
  }, 120_000);

  it("rolls the WHOLE close back when the reconciliation claim is lost mid-CLOSE", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    // Steal the claim while the run is still fetching: the boot sweep resets a stale `syncing`
    // source and lets a competing run take over, exactly as modelled here.
    const syncRequest = request(workspaceId, sourceId);
    const router = fullRouter();
    await expect(withMockStripe(
      (url) => {
        const response = router(url);
        void db.query(
          "update sync_runs set status = 'failed' where id = $1",
          [syncRequest.syncRunId],
        );
        return response;
      },
      () => connectorFor("stripe").sync(db, syncRequest),
    )).rejects.toThrow();

    // Reconciliation is the FIRST thing CLOSE does, so a lost claim aborts before any other close
    // write — and because it propagates instead of being swallowed, NOTHING from the close landed.
    expect(await readDrift(workspaceId, sourceId)).toEqual([]);
    expect(await readReconciliationWatermarks(workspaceId, sourceId)).toBeNull();
    const movements = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_customer_mrr_movements
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(movements[0]?.count).toBe("0");
    const invoiceState = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_invoice_sync_state
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(invoiceState[0]?.count).toBe("0");
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // Unclassified lifecycle evidence — the live 2026-08-04 diagnosability gap.
  // -------------------------------------------------------------------------------------------

  it("parks an unclassifiable lifecycle event as evidence instead of leaving only a counter", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    // A status-less `updated` with NO trial start in the window: genuinely undecidable, so it MUST
    // stay incomplete. Before this change it vanished into `incomplete_event_count = 1` with no
    // way to see which event, or why.
    const eventCreated = Math.floor(Date.parse(SEGMENT_TO) / 1000) - 3600;
    await runSync(workspaceId, sourceId, fullRouter({
      events: [{
        id: "evt_orphan_update",
        type: "customer.subscription.updated",
        created: eventCreated,
        api_version: "2025-06-30.basil",
        livemode: true,
        data: {
          object: {
            id: "sub_delta",
            customer: "cus_delta",
            status: "trialing",
            trial_start: eventCreated - 86_400,
            trial_end: eventCreated + 6 * 86_400,
          },
          // No `status` key: Stripe reporting that the status did not change.
          previous_attributes: { default_payment_method: "pm_new" },
        },
      }],
    }));

    const coverage = await db.one<{
      incomplete_event_count: number; incomplete_reasons: string[];
    }>(
      `select incomplete_event_count, incomplete_reasons from stripe_trial_history_coverage
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(coverage).toMatchObject({
      incomplete_event_count: 1,
      incomplete_reasons: ["unclassified_lifecycle_evidence"],
    });

    const evidence = await db.query<{
      stripe_event_id: string; event_type: string; object_kind: string;
      object_external_id: string; payload: Record<string, unknown>;
    }>(
      `select stripe_event_id, event_type, object_kind, object_external_id, payload
         from stripe_event_evidence where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      stripe_event_id: "evt_orphan_update",
      event_type: "customer.subscription.updated",
      object_kind: "unclassified_lifecycle",
      object_external_id: "sub_delta",
    });
    // The payload is the NORMALIZED row the classifier actually consumed — which is what explains
    // its verdict: `previous_status` is null because Stripe's diff carried no `status`.
    expect(evidence[0]?.payload).toMatchObject({
      current_status: "trialing",
      previous_status: null,
      stripe_subscription_id: "sub_delta",
    });
  }, 120_000);

  it("propagates a lost claim from applyReconciliation instead of advancing anything", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const orphanRunId = `run_${randomUUID()}`;
    await db.query(
      "insert into sync_runs (id, workspace_id, source_id, status) values ($1,$2,$3,'failed')",
      [orphanRunId, workspaceId, sourceId],
    );

    const scope = { workspaceId, sourceId, runStartedAt: CURSOR_END };
    await expect(db.withTransaction(async (tx) => {
      const reconciliationPlan = await computeReconciliationPlan(tx, scope, {
        customers: { rows: [], listComplete: false },
        subscriptions: { rows: [], listComplete: true },
        invoices: { rows: [], listComplete: false },
        prices: { rows: [], listComplete: false },
      });
      await applyReconciliation(tx, reconciliationPlan, { ...scope, syncRunId: orphanRunId });
    })).rejects.toBeInstanceOf(StripeReconciliationClaimLostError);

    expect(await readReconciliationWatermarks(workspaceId, sourceId)).toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // `invoice.upcoming` — end to end. The pure test above proves the classification; this proves
  // the RUN survives it, because surviving is the whole point: a throw here fails the sync, the
  // watermark never advances, and the same window is re-read on every 15-minute tick for 28 days.
  // -------------------------------------------------------------------------------------------

  it("completes a delta window containing an id-less `invoice.upcoming` and advances", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    const paths: string[] = [];
    await runSync(workspaceId, sourceId, deltaRouter({
      events: [{
        id: "evt_upcoming",
        type: "invoice.upcoming",
        created: Math.floor(Date.parse(SEGMENT_TO) / 1000) - 120,
        api_version: "2025-06-30.basil",
        livemode: true,
        // A real Stripe upcoming-invoice preview: no `id`, because the invoice does not exist yet.
        data: {
          object: {
            object: "invoice",
            customer: "cus_delta",
            subscription: "sub_delta",
            amount_due: 8000,
            currency: "usd",
          },
        },
      }],
      onUrl: (url) => paths.push(url.pathname),
    }));

    // NOTHING was re-fetched: there is no object to retrieve.
    expect(paths.filter((path) => path.startsWith("/v1/invoices"))).toEqual([]);
    expect(paths.filter((path) => path.startsWith("/v1/subscriptions"))).toEqual([]);

    const segments = await db.query<{ status: string; event_count: number; refetch_count: number }>(
      `select status, event_count, refetch_count from stripe_event_segments
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments[0]).toMatchObject({ status: "closed", event_count: 1, refetch_count: 0 });

    const watermarks = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);

    const evidence = await db.query<{ object_kind: string; object_external_id: string }>(
      `select object_kind, object_external_id from stripe_event_evidence
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(evidence).toEqual([
      { object_kind: "invoice_preview", object_external_id: "cus_delta" },
    ]);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // `invoice.deleted` — the other 28-day poison. Deleting a DRAFT invoice is a routine dashboard
  // action; the refetch 404s and, without classification, fails the run forever.
  // -------------------------------------------------------------------------------------------

  async function seedLocalInvoice(
    workspaceId: string,
    sourceId: string,
    invoiceId: string,
  ): Promise<void> {
    await db.query(
      `insert into stripe_invoices (
         id, workspace_id, source_id, stripe_invoice_id, stripe_customer_id, status,
         currency, amount_paid, amount_due
       ) values ($1,$2,$3,$4,'cus_delta','draft','usd',0,8000)`,
      [`inv_${randomUUID()}`, workspaceId, sourceId, invoiceId],
    );
    await db.query(
      `insert into stripe_invoice_lines (
         id, workspace_id, source_id, stripe_line_id, stripe_invoice_id, amount_cents, currency
       ) values ($1,$2,$3,$4,$5,8000,'usd')`,
      [`line_${randomUUID()}`, workspaceId, sourceId, `il_${invoiceId}`, invoiceId],
    );
  }

  function invoiceEvent(id: string, type: string, invoiceId: string) {
    return {
      id,
      type,
      created: Math.floor(Date.parse(SEGMENT_TO) / 1000) - 60,
      api_version: "2025-06-30.basil",
      livemode: true,
      data: { object: { id: invoiceId, object: "invoice", customer: "cus_delta", status: "draft" } },
    };
  }

  it("treats a 404 on an invoice its own `invoice.deleted` event named as an observed deletion", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    await seedLocalInvoice(workspaceId, sourceId, "in_draft");

    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") {
        return { data: [invoiceEvent("evt_deleted", "invoice.deleted", "in_draft")], has_more: false };
      }
      if (url.pathname === "/v1/invoices/in_draft") {
        return new Response(JSON.stringify({ error: { message: "No such invoice" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });

    // The row (and its lines) are gone — revenue-safe, because Stripe only permits deleting an
    // invoice that was never finalized, so it never reached `status = 'paid'`.
    const invoices = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_invoices
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(invoices[0]?.count).toBe("0");
    const lines = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_invoice_lines
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(lines[0]?.count).toBe("0");

    // …and the window CLOSED, so the watermark advanced instead of replaying this event for 28 days.
    const segments = await db.query<{ status: string }>(
      `select status from stripe_event_segments where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments[0]?.status).toBe("closed");
    const watermarks = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);
    // The deletion is on the record: the `invoice.deleted` event is kept as evidence.
    const evidence = await db.query<{ event_type: string; object_external_id: string }>(
      `select event_type, object_external_id from stripe_event_evidence
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(evidence).toEqual([{ event_type: "invoice.deleted", object_external_id: "in_draft" }]);
  }, 120_000);

  it("fails the run on a 404 with NO deleted event — an unexplained disappearance is an anomaly", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    await seedLocalInvoice(workspaceId, sourceId, "in_ghost");
    const priorWatermark = iso(CURSOR_END_MS - 20 * 60 * 1000);

    await expect(runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") {
        return { data: [invoiceEvent("evt_updated", "invoice.updated", "in_ghost")], has_more: false };
      }
      if (url.pathname === "/v1/invoices/in_ghost") {
        return new Response(JSON.stringify({ error: { message: "No such invoice" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    })).rejects.toThrow(/404/);

    // Nothing was deleted and nothing was claimed.
    const invoices = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_invoices
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(invoices[0]?.count).toBe("1");
    const watermarks = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(priorWatermark);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // Stale OPEN segment retirement. Without it, one aged segment is a permanent full-refresh loop:
  // the gap check fires every tick, the full lane runs, and the full lane never retires segments.
  // -------------------------------------------------------------------------------------------

  async function seedOpenSegment(
    workspaceId: string,
    sourceId: string,
    fromMs: number,
    toMs: number,
  ): Promise<void> {
    await db.query(
      `insert into stripe_event_segments (
         id, workspace_id, source_id, segment_from, segment_to_exclusive,
         pagination_cursor, status, parser_version
       ) values ($1,$2,$3,$4,$5,'evt_stuck','open','stripe-delta-events-v1')`,
      [`seg_${randomUUID()}`, workspaceId, sourceId, iso(fromMs), iso(toMs)],
    );
  }

  const staleSegmentCases: [string, () => { fromMs: number; toMs: number }][] = [
    // Aged past the 30-day HARD event-retention floor: nothing can ever poll it again.
    ["delta_segment_beyond_event_retention", () => ({
      fromMs: CURSOR_END_MS - 35 * 24 * 60 * 60 * 1000,
      toMs: CURSOR_END_MS - 34 * 24 * 60 * 60 * 1000,
    })],
    // Starts AFTER everything durably observed: a hole nothing will ever poll.
    ["delta_segment_chain_broken", () => ({
      fromMs: CURSOR_END_MS - 10 * 60 * 1000,
      toMs: CURSOR_END_MS - 6 * 60 * 1000,
    })],
  ];

  for (const [expectedGap, bounds] of staleSegmentCases) {
    it(`heals \`${expectedGap}\` in ONE full run instead of looping the full lane forever`, async () => {
      const workspaceId = `ws_${randomUUID()}`;
      const sourceId = `src_${randomUUID()}`;
      await seedSource(workspaceId, sourceId);
      await seedHealthyWatermark(workspaceId, sourceId);
      const { fromMs, toMs } = bounds();
      await seedOpenSegment(workspaceId, sourceId, fromMs, toMs);

      const plan = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
      expect(plan.stripeSyncLane).toEqual({
        lane: "full",
        reason: "delta_coverage_gap",
        coverageGapReason: expectedGap,
      });

      await runSync(workspaceId, sourceId, fullRouter());

      // RETIRED — and as `superseded`, not `closed`: the delta lane never observed those events.
      const segments = await db.query<{ status: string; closed_at: Date | null }>(
        `select status, closed_at from stripe_event_segments
          where workspace_id = $1 and source_id = $2`,
        [workspaceId, sourceId],
      );
      expect(segments[0]?.status).toBe("superseded");
      expect(segments[0]?.closed_at).not.toBeNull();

      // The loop is broken: the very next tick is a healthy DELTA run.
      const next = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
      expect(next.stripeSyncLane).toEqual({
        lane: "delta",
        reason: "delta_healthy",
        coverageGapReason: null,
      });
    }, 120_000);
  }

  // -------------------------------------------------------------------------------------------
  // Trial bootstrap crawl — the delta lane must not stamp coverage over a crawl in flight.
  // -------------------------------------------------------------------------------------------

  it("leaves an in-progress trial bootstrap crawl resumable instead of stamping over it", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    // A multi-run backfill of trial lifecycle history, mid-crawl: `closed_through_exclusive` is
    // still null and `current_segment_starting_after` is the ONLY thing that can resume it.
    const crawlFrom = iso(CURSOR_END_MS - 27 * 24 * 60 * 60 * 1000);
    const crawlTo = iso(CURSOR_END_MS - 10 * 60 * 1000);
    await db.query(
      `insert into stripe_trial_history_coverage (
         id, workspace_id, source_id, current_segment_from, current_segment_to_exclusive,
         current_segment_starting_after, parser_version
       ) values ($1,$2,$3,$4,$5,'evt_crawl_cursor','stripe-trial-events-v1')`,
      [`cov_${randomUUID()}`, workspaceId, sourceId, crawlFrom, crawlTo],
    );

    await runSync(workspaceId, sourceId, deltaRouter({
      events: [subscriptionEvent("evt_delta_trial", subscriptionApi(), 60)],
      subscriptions: { sub_delta: subscriptionApi() },
    }));

    const coverage = await db.one<{
      current_segment_from: Date | null;
      current_segment_starting_after: string | null;
      closed_through_exclusive: Date | null;
      continuous_coverage_from: Date | null;
    }>(
      `select current_segment_from, current_segment_starting_after, closed_through_exclusive,
              continuous_coverage_from
         from stripe_trial_history_coverage where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    // UNTOUCHED. The crawl still resumes exactly where it stopped, and no coverage was claimed.
    expect(coverage?.current_segment_starting_after).toBe("evt_crawl_cursor");
    expect(new Date(String(coverage?.current_segment_from)).toISOString()).toBe(crawlFrom);
    expect(coverage?.closed_through_exclusive).toBeNull();
    expect(coverage?.continuous_coverage_from).toBeNull();

    // The delta lane still did its own job: canonical state + its own watermark advanced.
    const watermarks = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);
  }, 120_000);

  it("still advances trial coverage when the crawl is COMPLETE and the window contains its cutoff", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    // Crawl finished: no resume cursor, and a durable closed-through bound the window reaches back
    // below. This is the case the delta lane exists to ride, and it must keep working.
    const closedThrough = iso(CURSOR_END_MS - 20 * 60 * 1000);
    await db.query(
      `insert into stripe_trial_history_coverage (
         id, workspace_id, source_id, closed_through_exclusive, continuous_coverage_from,
         parser_version
       ) values ($1,$2,$3,$4,$5,'stripe-trial-events-v1')`,
      [
        `cov_${randomUUID()}`,
        workspaceId,
        sourceId,
        closedThrough,
        iso(CURSOR_END_MS - 27 * 24 * 60 * 60 * 1000),
      ],
    );

    await runSync(workspaceId, sourceId, deltaRouter({
      events: [subscriptionEvent("evt_delta_trial2", subscriptionApi(), 60)],
      subscriptions: { sub_delta: subscriptionApi() },
    }));

    const coverage = await db.one<{
      closed_through_exclusive: Date; current_segment_starting_after: string | null;
    }>(
      `select closed_through_exclusive, current_segment_starting_after
         from stripe_trial_history_coverage where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(String(coverage?.closed_through_exclusive)).toISOString()).toBe(SEGMENT_TO);
    expect(coverage?.current_segment_starting_after).toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // Refetch fan-out budget.
  // -------------------------------------------------------------------------------------------

  it("refuses an over-budget fan-out WHOLE and hands the window to the full lane", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    const priorWatermark = iso(CURSOR_END_MS - 20 * 60 * 1000);

    // One event per customer, one past the budget. (A single `price.updated` reaching this many
    // subscriptions through the local reverse index is the real-world shape; the event count is
    // just the cheapest way to build the same fan-out.)
    const events = Array.from({ length: STRIPE_DELTA_MAX_REFETCH_PER_RUN + 1 }, (_, index) => ({
      id: `evt_cust_${index}`,
      type: "customer.updated",
      created: Math.floor(Date.parse(SEGMENT_TO) / 1000) - 60,
      api_version: "2025-06-30.basil",
      livemode: true,
      data: { object: { id: `cus_${index}`, metadata: {} } },
    }));

    const paths: string[] = [];
    await runSync(workspaceId, sourceId, (url) => {
      paths.push(url.pathname);
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") return { data: events, has_more: false };
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });

    // NOT ONE retrieve was issued — a half-applied window is the outcome worth avoiding.
    expect(paths.filter((path) => path.startsWith("/v1/customers/"))).toEqual([]);
    const customers = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_customers
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(customers[0]?.count).toBe("0");

    // The window was NOT claimed…
    const watermarks = await db.query<{
      delta_data_as_of: Date; pending_full_refresh_reason: string | null;
    }>(
      `select delta_data_as_of, pending_full_refresh_reason from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(priorWatermark);
    expect(watermarks[0]?.pending_full_refresh_reason).toBe("delta_fanout_exceeded");
    // …but the events were kept: we already paid to receive them, and evidence is insert-only.
    const evidence = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_event_evidence
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(evidence[0]?.count).toBe(String(STRIPE_DELTA_MAX_REFETCH_PER_RUN + 1));

    // The NEXT tick takes the full lane, and names why.
    const next = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(next.stripeSyncLane).toEqual({
      lane: "full",
      reason: "delta_fanout_exceeded",
      coverageGapReason: null,
    });

    // …and running it clears the demand and retires the abandoned window.
    await runSync(workspaceId, sourceId, fullRouter());
    const cleared = await db.one<{ pending_full_refresh_reason: string | null }>(
      `select pending_full_refresh_reason from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(cleared?.pending_full_refresh_reason).toBeNull();
    const segments = await db.query<{ status: string }>(
      `select status from stripe_event_segments where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments[0]?.status).toBe("superseded");
  }, 180_000);

  it("leaves an UNDER-budget fan-out completely unchanged", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    const events = Array.from({ length: 3 }, (_, index) => ({
      id: `evt_small_${index}`,
      type: "customer.updated",
      created: Math.floor(Date.parse(SEGMENT_TO) / 1000) - 60,
      api_version: "2025-06-30.basil",
      livemode: true,
      data: { object: { id: `cus_small_${index}`, metadata: {} } },
    }));
    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") return { data: events, has_more: false };
      const [, , collection, id] = url.pathname.split("/");
      if (collection === "customers" && id) return { id, metadata: {} };
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });

    const customers = await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_customers
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(customers[0]?.count).toBe("3");
    const watermarks = await db.query<{
      delta_data_as_of: Date; pending_full_refresh_reason: string | null;
    }>(
      `select delta_data_as_of, pending_full_refresh_reason from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);
    expect(watermarks[0]?.pending_full_refresh_reason).toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // Resumed-segment late-event blindness.
  // -------------------------------------------------------------------------------------------

  it("catches an event indexed LATE into a window the cursor had already paged past", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    // Pass 1: five busy pages, so the run stops mid-window and leaves an OPEN segment.
    let page = 0;
    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") {
        page += 1;
        return {
          data: [subscriptionEvent(`evt_p${page}`, subscriptionApi(), 600 - page)],
          has_more: true,
        };
      }
      const [, , collection, id] = url.pathname.split("/");
      if (collection === "subscriptions" && id) return subscriptionApi();
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });
    expect(page).toBe(5);

    // Pass 2 RESUMES from the cursor. `starting_after` walks strictly OLDER entries, so
    // `evt_late` — indexed after pass 1 had already paged past its position — is invisible to it
    // and visible ONLY to the fresh first-page re-list.
    const eventCalls: URL[] = [];
    await runSync(workspaceId, sourceId, (url) => {
      if (url.pathname === "/v1/customers") return { data: [], has_more: false };
      if (url.pathname === "/v1/events") {
        eventCalls.push(url);
        const resuming = url.searchParams.get("starting_after") !== null;
        return {
          data: resuming
            ? [subscriptionEvent("evt_p6", subscriptionApi(), 10)]
            // The re-list sees the whole window afresh: the late arrival plus the overlap.
            : [
              subscriptionEvent("evt_late", subscriptionApi(), 300),
              subscriptionEvent("evt_p6", subscriptionApi(), 10),
            ],
          has_more: false,
        };
      }
      const [, , collection, id] = url.pathname.split("/");
      if (collection === "subscriptions" && id) return subscriptionApi();
      throw new Error(`unexpected Stripe URL: ${url.toString()}`);
    });

    // Exactly TWO reads on the resumed pass: the cursor page and one top-up re-list.
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]?.searchParams.get("starting_after")).toBe("evt_p5");
    expect(eventCalls[1]?.searchParams.get("starting_after")).toBeNull();
    // Same bounds — the re-list re-reads the window, it never redefines it.
    expect(eventCalls[1]?.searchParams.get("created[gte]"))
      .toBe(eventCalls[0]?.searchParams.get("created[gte]"));
    expect(eventCalls[1]?.searchParams.get("created[lt]"))
      .toBe(eventCalls[0]?.searchParams.get("created[lt]"));

    const evidence = await db.query<{ stripe_event_id: string }>(
      `select stripe_event_id from stripe_event_evidence
        where workspace_id = $1 and source_id = $2 order by stripe_event_id`,
      [workspaceId, sourceId],
    );
    expect(evidence.map((row) => row.stripe_event_id))
      .toEqual(["evt_late", "evt_p1", "evt_p2", "evt_p3", "evt_p4", "evt_p5", "evt_p6"]);
    // Counted ONCE despite the deliberate overlap: 5 on the first pass, 2 distinct on the second.
    const segments = await db.query<{ status: string; event_count: number }>(
      `select status, event_count from stripe_event_segments
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments[0]).toMatchObject({ status: "closed", event_count: 7 });
  }, 120_000);

  it("costs a NON-resumed delta run no extra read", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);

    let eventCalls = 0;
    await runSync(workspaceId, sourceId, deltaRouter({
      events: [subscriptionEvent("evt_plain", subscriptionApi(), 60)],
      subscriptions: { sub_delta: subscriptionApi() },
      onUrl: (url) => {
        if (url.pathname === "/v1/events") eventCalls += 1;
      },
    }));
    expect(eventCalls).toBe(1);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // One realistic mixed window. Distilled from the sequence a live account actually emits around a
  // renewal — the preview three days out, the invoice lifecycle, the subscription edit, and the
  // `invoiceitem.*` / `customer.source.*` noise that must be dropped. Individually each shape is
  // pinned above; this proves they compose in ONE window without any of them poisoning it.
  // -------------------------------------------------------------------------------------------

  it("survives a realistic mixed window: preview + invoice lifecycle + edit + noise", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await seedHealthyWatermark(workspaceId, sourceId);
    const at = (offset: number) => Math.floor(Date.parse(SEGMENT_TO) / 1000) - offset;
    const base = { api_version: "2025-06-30.basil", livemode: true };

    await runSync(workspaceId, sourceId, deltaRouter({
      events: [
        // Three days before the renewal Stripe previews the invoice it has not created yet.
        {
          ...base,
          id: "evt_seq_upcoming",
          type: "invoice.upcoming",
          created: at(900),
          data: { object: { object: "invoice", customer: "cus_delta", amount_due: 8000 } },
        },
        // Then the real invoice appears and is paid.
        {
          ...base,
          id: "evt_seq_created",
          type: "invoice.created",
          created: at(600),
          data: { object: { id: "in_seq", customer: "cus_delta", status: "draft" } },
        },
        {
          ...base,
          id: "evt_seq_paid",
          type: "invoice.paid",
          created: at(500),
          data: { object: { id: "in_seq", customer: "cus_delta", status: "paid" } },
        },
        // A subscription edit lands in the same window.
        subscriptionEvent("evt_seq_sub", subscriptionApi(), 400),
        // Noise the local filter must drop: neither family is stored by this engine.
        {
          ...base,
          id: "evt_seq_item",
          type: "invoiceitem.created",
          created: at(300),
          data: { object: { id: "ii_seq" } },
        },
        {
          ...base,
          id: "evt_seq_card",
          type: "customer.source.updated",
          created: at(200),
          data: { object: { id: "card_seq" } },
        },
      ],
      subscriptions: { sub_delta: subscriptionApi() },
      invoices: {
        in_seq: {
          id: "in_seq",
          customer: { id: "cus_delta", email: "founder@example.test", metadata: {} },
          status: "paid",
          currency: "usd",
          amount_paid: 8000,
          amount_due: 8000,
          created: at(600),
          status_transitions: { paid_at: at(500) },
          lines: { has_more: false, data: [] },
        },
      },
    }));

    // The invoice was retrieved ONCE despite two events naming it, and landed as canonical truth.
    const invoices = await db.query<{ stripe_invoice_id: string; status: string }>(
      `select stripe_invoice_id, status from stripe_invoices
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(invoices).toEqual([{ stripe_invoice_id: "in_seq", status: "paid" }]);

    // Evidence keeps every RELEVANT event (including the preview) and none of the noise.
    const evidence = await db.query<{ stripe_event_id: string; object_kind: string }>(
      `select stripe_event_id, object_kind from stripe_event_evidence
        where workspace_id = $1 and source_id = $2 order by stripe_event_id`,
      [workspaceId, sourceId],
    );
    expect(evidence).toEqual([
      { stripe_event_id: "evt_seq_created", object_kind: "invoice" },
      { stripe_event_id: "evt_seq_paid", object_kind: "invoice" },
      { stripe_event_id: "evt_seq_sub", object_kind: "subscription" },
      { stripe_event_id: "evt_seq_upcoming", object_kind: "invoice_preview" },
    ]);

    const segments = await db.query<{ status: string; event_count: number }>(
      `select status, event_count from stripe_event_segments
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(segments[0]).toMatchObject({ status: "closed", event_count: 6 });
    const watermarks = await db.query<{ delta_data_as_of: Date }>(
      `select delta_data_as_of from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(new Date(watermarks[0]!.delta_data_as_of).toISOString()).toBe(SEGMENT_TO);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // The marquee drift case: a subscription whose local amount is STALE, through a real `sync()`.
  // Measured post-LOAD this is invisible — the full replacement rewrites the item before CLOSE
  // opens — so the ledger reported clean and the relax-to-weekly gate would have gone green on
  // evidence it never had.
  // -------------------------------------------------------------------------------------------

  it("records the drift a full replacement healed before CLOSE could see it", async () => {
    const workspaceId = `ws_${randomUUID()}`;
    const sourceId = `src_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    // A prior full import established canonical state at $80…
    await runSync(workspaceId, sourceId, fullRouter());
    expect((await readDrift(workspaceId, sourceId)).length).toBe(1); // the known customer-name gap

    // …then the delta lane MISSED a price change: local still says $80, Stripe says $60.
    await db.query(
      `update stripe_sync_watermarks set reconciled_at = $3, last_full_refresh_at = $3
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId, iso(CURSOR_END_MS - 25 * 60 * 60 * 1000)],
    );
    const remoteSixty = subscriptionApi({
      items: {
        has_more: false,
        data: [subscriptionItemApi({
          price: { ...(subscriptionItemApi().price as Record<string, unknown>), unit_amount: 6000 },
        })],
      },
    });

    const plan = await connectorFor("stripe").planSync(db, request(workspaceId, sourceId));
    expect(plan.stripeSyncLane).toMatchObject({ lane: "full" });
    const syncRequest = await runSync(
      workspaceId,
      sourceId,
      fullRouter({ subscriptions: [remoteSixty] }),
    );

    const drift = await readDrift(workspaceId, sourceId);
    const fresh = drift.filter((row) => new Date(row.run_started_at).toISOString() === CURSOR_END
      && row.entity_kind !== "customer");
    expect(fresh.map((row) => [row.entity_kind, row.object_external_id, row.drift_kind, row.repaired]))
      .toEqual([
        ["price", "price_delta", "state_mismatch", false],
        ["subscription_item", "si_delta", "state_mismatch", false],
      ]);
    // Healed by this run's own LOAD, and the ledger says so rather than pretending it was clean.
    expect(fresh[0]?.detail).toMatchObject({
      fields: ["unit_amount"], repair: "full_replacement",
    });
    expect(fresh[1]?.detail).toMatchObject({
      // The subscription item carries the price's default alongside its own resolved amount.
      fields: ["default_unit_amount", "unit_amount"], repair: "full_replacement",
    });

    const telemetry = (await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [syncRequest.syncRunId],
    ))[0]?.request_telemetry as Record<string, unknown>;
    expect(telemetry.reconciliation).toMatchObject({
      applied: true,
      healedByLoadCount: 2,
    });

    // SECOND PASS over the SAME remote state: nothing drifted, so the ledger is silent and the
    // cadence decision finally has a clean run it is entitled to count.
    await db.query(
      `update stripe_sync_watermarks set reconciled_at = $3, last_full_refresh_at = $3
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId, iso(CURSOR_END_MS - 25 * 60 * 60 * 1000)],
    );
    const secondRun = await runSync(
      workspaceId,
      sourceId,
      fullRouter({ subscriptions: [remoteSixty] }),
    );
    expect(await readDrift(workspaceId, sourceId)).toHaveLength(drift.length);
    const secondTelemetry = (await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [secondRun.syncRunId],
    ))[0]?.request_telemetry as Record<string, unknown>;
    expect(secondTelemetry.reconciliation).toMatchObject({
      applied: true,
      driftCount: 0,
      healedByLoadCount: 0,
    });
  }, 180_000);
});
