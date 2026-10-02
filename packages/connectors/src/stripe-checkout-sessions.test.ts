import { describe, expect, it } from "vitest";

import {
  STRIPE_CHECKOUT_SESSION_LIST_OVERLAP_MS,
  STRIPE_CHECKOUT_SESSION_MAX_LIFETIME_MS,
  StripeCheckoutSessionShapeError,
  planStripeCheckoutSessionListStep,
  stripeCheckoutSessionCheckpointForStep,
  stripeCheckoutSessionDeltaAdvance,
  stripeCheckoutSessionRow,
  stripeCheckoutSessionRowsDeduped,
  stripeCheckoutSessionRowsFromEvents,
  type StripeCheckoutSessionSyncStateRow,
} from "./stripe-checkout-sessions.js";
import { STRIPE_PAYMENT_EVIDENCE_EVENT_TYPES } from "./stripe-delta.js";

const NOW = "2026-10-02T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const NOW_S = NOW_MS / 1000;

/** A full-shape Checkout Session, buyer PII included ON PURPOSE so minimisation is proven. */
function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cs_live_a1",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 21725,
    amount_subtotal: 20000,
    currency: "usd",
    customer: null,
    customer_details: {
      email: "buyer@example.test",
      name: "Buyer Person",
      phone: "+15555550100",
      address: { line1: "1 Main St", city: "Springfield", postal_code: "12345", country: "US" },
    },
    shipping_details: { name: "Buyer Person", address: { line1: "1 Main St" } },
    custom_fields: [{ key: "note", text: { value: "leave at door" } }],
    metadata: { order_note: "secret merchant note" },
    invoice: null,
    payment_intent: "pi_a1",
    subscription: null,
    payment_link: "plink_a1",
    created: NOW_S - 3600,
    expires_at: NOW_S + 82800,
    livemode: true,
    ...over,
  };
}

function state(over: Partial<StripeCheckoutSessionSyncStateRow> = {}): StripeCheckoutSessionSyncStateRow {
  return {
    capability_state: "available",
    missing_permission: null,
    backfill_state: "complete",
    backfill_anchor: "2026-09-30T00:00:00.000Z",
    backfill_starting_after: null,
    backfill_reached_created_at: "2025-01-01T00:00:00.000Z",
    window_from: null,
    window_to: null,
    window_starting_after: null,
    listed_through: "2026-10-02T11:30:00.000Z",
    ...over,
  };
}

describe("Stripe Checkout session row (minimised)", () => {
  it("keeps exactly the revenue fields and nothing that identifies the buyer", () => {
    const row = stripeCheckoutSessionRow(session(), NOW, "list");
    expect(row).toEqual({
      kind: "checkout_session",
      externalId: "cs_live_a1",
      sessionId: "cs_live_a1",
      mode: "payment",
      status: "complete",
      paymentStatus: "paid",
      amountTotal: 21725,
      amountSubtotal: 20000,
      currency: "usd",
      customerId: null,
      invoiceId: null,
      paymentIntentId: "pi_a1",
      subscriptionId: null,
      sessionCreatedAt: new Date((NOW_S - 3600) * 1000).toISOString(),
      livemode: true,
      observedAt: NOW,
      observedVia: "list",
    });
    const stored = JSON.stringify(row);
    for (const leaked of ["buyer@example.test", "Buyer Person", "+1555", "Main St", "leave at door", "secret", "plink_"]) {
      expect(stored).not.toContain(leaked);
    }
  });

  it("reduces an EXPANDED reference to its id", () => {
    const row = stripeCheckoutSessionRow(session({
      customer: { id: "cus_a1", email: "buyer@example.test" },
      invoice: { id: "in_a1", customer_email: "buyer@example.test" },
    }), NOW, "list");
    expect(row.customerId).toBe("cus_a1");
    expect(row.invoiceId).toBe("in_a1");
    expect(JSON.stringify(row)).not.toContain("buyer@example.test");
  });

  it("never invents an amount: absent or non-integer stays null, not 0", () => {
    const row = stripeCheckoutSessionRow(
      session({ amount_total: undefined, amount_subtotal: "200" }),
      NOW,
      "list",
    );
    expect(row.amountTotal).toBeNull();
    expect(row.amountSubtotal).toBeNull();
  });

  it("refuses a session missing a field every Session carries", () => {
    for (const field of ["id", "mode", "status", "payment_status", "created", "livemode"]) {
      expect(() => stripeCheckoutSessionRow(session({ [field]: undefined }), NOW, "list"), field)
        .toThrow(StripeCheckoutSessionShapeError);
    }
  });
});

describe("Stripe Checkout session rows from delta events", () => {
  const event = (id: string, type: string, created: number, object: unknown) => ({
    id, type, created, livemode: true, data: { object },
  });

  it("covers exactly the session events the delta lane also keeps as evidence", () => {
    for (const type of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ]) {
      expect(STRIPE_PAYMENT_EVIDENCE_EVENT_TYPES.get(type)).toBe("checkout_session");
    }
  });

  it("projects session events observed at the EVENT time, oldest first, and skips everything else", () => {
    const { rows } = stripeCheckoutSessionRowsFromEvents([
      event("evt_2", "checkout.session.async_payment_succeeded", NOW_S - 60, session({ payment_status: "paid" })),
      event("evt_1", "checkout.session.completed", NOW_S - 600, session({ payment_status: "unpaid" })),
      event("evt_x", "checkout.session.expired", NOW_S - 30, session({ status: "expired" })),
      event("evt_y", "charge.succeeded", NOW_S - 30, { id: "ch_1" }),
    ]);
    expect(rows.map((row) => [row.paymentStatus, row.observedAt, row.observedVia])).toEqual([
      ["unpaid", new Date((NOW_S - 600) * 1000).toISOString(), "event"],
      ["paid", new Date((NOW_S - 60) * 1000).toISOString(), "event"],
    ]);
    // De-dupe keeps the NEWEST observation of one session.
    expect(stripeCheckoutSessionRowsDeduped(rows).map((row) => row.paymentStatus)).toEqual(["paid"]);
  });

  it("fails inside the window but counts and skips a malformed session in the REACH-BACK part", () => {
    const broken = event("evt_b", "checkout.session.completed", NOW_S - 600, session({ mode: undefined }));
    expect(() => stripeCheckoutSessionRowsFromEvents([broken], { fanoutFromMs: (NOW_S - 900) * 1000 }))
      .toThrow(StripeCheckoutSessionShapeError);
    const reachBack = stripeCheckoutSessionRowsFromEvents([broken], { fanoutFromMs: (NOW_S - 300) * 1000 });
    expect(reachBack.rows).toEqual([]);
    expect(reachBack.unparseableReachBackEventTypes).toEqual({ "checkout.session.completed": 1 });
  });

  it("lets a list read at the run's end win a tie with an event stamped the same instant", () => {
    const fromEvent = stripeCheckoutSessionRow(session({ payment_status: "unpaid" }), NOW, "event");
    const fromList = stripeCheckoutSessionRow(session({ payment_status: "paid" }), NOW, "list");
    expect(stripeCheckoutSessionRowsDeduped([fromEvent, fromList])).toEqual([fromList]);
  });
});

describe("Stripe Checkout session list-step planning", () => {
  it("starts the history crawl on a source that has never listed, anchored at now (whole seconds)", () => {
    const step = planStripeCheckoutSessionListStep({ state: null, lane: "delta", cursorEndMs: NOW_MS + 250 });
    expect(step).toEqual({
      kind: "backfill",
      anchorMs: NOW_MS,
      startingAfter: null,
      params: { limit: "100", status: "complete", "created[lt]": String(NOW_S) },
    });
  });

  it("resumes an unfinished crawl from its cursor under its ORIGINAL anchor, on either lane", () => {
    for (const lane of ["full", "delta"] as const) {
      const step = planStripeCheckoutSessionListStep({
        state: state({
          backfill_state: "in_progress",
          backfill_anchor: "2026-09-30T00:00:00.000Z",
          backfill_starting_after: "cs_live_cursor",
          listed_through: null,
        }),
        lane,
        cursorEndMs: NOW_MS,
      });
      expect(step).toMatchObject({
        kind: "backfill",
        anchorMs: Date.parse("2026-09-30T00:00:00.000Z"),
        startingAfter: "cs_live_cursor",
      });
    }
  });

  it("costs a steady-state DELTA run no list read: the session events keep the table current", () => {
    expect(planStripeCheckoutSessionListStep({ state: state(), lane: "delta", cursorEndMs: NOW_MS }))
      .toEqual({ kind: "none" });
  });

  it("opens a FULL-run window reaching back past the cutoff by more than a session's lifetime", () => {
    expect(STRIPE_CHECKOUT_SESSION_LIST_OVERLAP_MS).toBeGreaterThan(STRIPE_CHECKOUT_SESSION_MAX_LIFETIME_MS);
    const step = planStripeCheckoutSessionListStep({ state: state(), lane: "full", cursorEndMs: NOW_MS });
    const fromMs = Date.parse("2026-10-02T11:30:00.000Z") - STRIPE_CHECKOUT_SESSION_LIST_OVERLAP_MS;
    expect(step).toEqual({
      kind: "window",
      fromMs,
      toMs: NOW_MS,
      startingAfter: null,
      params: {
        limit: "100",
        status: "complete",
        "created[gte]": String(fromMs / 1000),
        "created[lt]": String(NOW_S),
      },
    });
  });

  it("resumes an OPEN window verbatim on either lane", () => {
    for (const lane of ["full", "delta"] as const) {
      const step = planStripeCheckoutSessionListStep({
        state: state({
          window_from: "2026-09-29T10:00:00.000Z",
          window_to: "2026-10-01T12:00:00.000Z",
          window_starting_after: "cs_live_w",
        }),
        lane,
        cursorEndMs: NOW_MS,
      });
      expect(step).toMatchObject({
        kind: "window",
        fromMs: Date.parse("2026-09-29T10:00:00.000Z"),
        toMs: Date.parse("2026-10-01T12:00:00.000Z"),
        startingAfter: "cs_live_w",
      });
    }
  });

  it("refuses to invent a lower bound when a completed crawl has no cutoff", () => {
    expect(() => planStripeCheckoutSessionListStep({
      state: state({ listed_through: null }),
      lane: "full",
      cursorEndMs: NOW_MS,
    })).toThrow(/no listed_through/);
  });
});

describe("Stripe Checkout session checkpoints", () => {
  const backfillStep = {
    kind: "backfill" as const,
    anchorMs: NOW_MS,
    startingAfter: null,
    params: {},
  };
  const rowsCreated = (...createdS: number[]) =>
    createdS.map((created, index) => stripeCheckoutSessionRow(session({ id: `cs_${index}`, created }), NOW, "list"));

  it("keeps an unfinished crawl resumable and remembers the oldest session reached across runs", () => {
    const checkpoint = stripeCheckoutSessionCheckpointForStep({
      step: backfillStep,
      page: { complete: false, nextStartingAfter: "cs_1" },
      rows: rowsCreated(NOW_S - 100, NOW_S - 5_000),
      priorReachedCreatedAt: null,
    });
    expect(checkpoint).toEqual({
      capability: { state: "available" },
      backfill: {
        state: "in_progress",
        anchor: NOW,
        startingAfter: "cs_1",
        reachedCreatedAt: new Date((NOW_S - 5_000) * 1000).toISOString(),
      },
    });
    // No coverage claim until the crawl reaches the start of the account.
    expect(checkpoint.listedThrough).toBeUndefined();
  });

  it("claims coverage through the ANCHOR when the crawl completes", () => {
    const checkpoint = stripeCheckoutSessionCheckpointForStep({
      step: backfillStep,
      page: { complete: true, nextStartingAfter: null },
      rows: [],
      priorReachedCreatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(checkpoint.backfill).toEqual({
      state: "complete",
      anchor: NOW,
      startingAfter: null,
      reachedCreatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(checkpoint.listedThrough).toBe(NOW);
  });

  it("closes a finished window and advances the claim to its end; an unfinished one stays open", () => {
    const step = {
      kind: "window" as const,
      fromMs: NOW_MS - 90_000_000,
      toMs: NOW_MS,
      startingAfter: null,
      params: {},
    };
    expect(stripeCheckoutSessionCheckpointForStep({
      step, page: { complete: true, nextStartingAfter: null }, rows: [], priorReachedCreatedAt: null,
    })).toEqual({
      capability: { state: "available" },
      window: { from: null, to: null, startingAfter: null },
      listedThrough: NOW,
    });
    expect(stripeCheckoutSessionCheckpointForStep({
      step, page: { complete: false, nextStartingAfter: "cs_9" }, rows: [], priorReachedCreatedAt: null,
    })).toEqual({
      capability: { state: "available" },
      window: {
        from: new Date(NOW_MS - 90_000_000).toISOString(),
        to: NOW,
        startingAfter: "cs_9",
      },
    });
  });

  it("advances on a closed delta window ONLY when it contains the claim and nothing else owns it", () => {
    const segmentToExclusive = "2026-10-02T11:55:00.000Z";
    const claimMs = Date.parse("2026-10-02T11:30:00.000Z");
    expect(stripeCheckoutSessionDeltaAdvance({ state: state(), fanoutFromMs: claimMs - 1, segmentToExclusive }))
      .toBe(segmentToExclusive);
    // The window starts after the claim: completions in between were never observed.
    expect(stripeCheckoutSessionDeltaAdvance({ state: state(), fanoutFromMs: claimMs + 1_000, segmentToExclusive }))
      .toBeNull();
    // Crawl unfinished, a list window open, or no state at all: the list lane owns the claim.
    expect(stripeCheckoutSessionDeltaAdvance({
      state: state({ backfill_state: "in_progress" }), fanoutFromMs: claimMs, segmentToExclusive,
    })).toBeNull();
    expect(stripeCheckoutSessionDeltaAdvance({
      state: state({ window_from: "2026-10-01T00:00:00.000Z", window_to: NOW }), fanoutFromMs: claimMs, segmentToExclusive,
    })).toBeNull();
    expect(stripeCheckoutSessionDeltaAdvance({ state: null, fanoutFromMs: claimMs, segmentToExclusive })).toBeNull();
  });
});
