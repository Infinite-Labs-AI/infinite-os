import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import {
  __testOnlySyncExtractedBatch,
  connectorFor,
  type ExtractedRecord,
  type SyncPlan,
  type SyncRequest
} from "./index.js";
import { writeStripeMrrMovementsAtClose } from "./stripe-mrr-movements.js";

// End-to-end proof of the CHUNKED batch loader against a REAL (WASM Postgres)
// PGlite data dir. The mock-db unit tests in index.test.ts only assert SQL TEXT
// and ordering; they cannot catch a broken multi-row VALUES statement, a
// RETURNING-order misalignment, a wrong chunk boundary, or the per-chunk failure
// semantics. This suite exercises all of that on the desktop's actual backend.

const CHUNK_SIZE = 500; // must match SYNC_BATCH_CHUNK_SIZE in index.ts
const STRIPE_TEST_KEY = "stripe-reconciliation-pglite-test-key";

function makeRecords(count: number, prefix: string): ExtractedRecord<{ marker: string }>[] {
  return Array.from({ length: count }, (_, i) => ({
    externalId: `${prefix}_ext_${i}`,
    objectType: "test_object",
    payloadVersion: "live-v1",
    sourceUpdatedAt: null,
    payload: { marker: `${prefix}_${i}` }
  }));
}

function makePlan(cursorEnd: string): SyncPlan {
  return {
    cursorKey: "test_cursor",
    cursorStart: null,
    cursorEnd,
    refreshWindowDays: 7,
    mode: "live"
  };
}

describe("chunked syncExtractedBatch against real PGlite", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-sync-chunking-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Seed the FK chain (workspace -> dataset -> source) for a self-contained source id.
  async function seedSource(
    workspaceId: string,
    sourceId: string,
    provider: "posthog" | "stripe" = "posthog"
  ): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'web'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1, $2, $3, $4, 'conn', $1, 'connected')`,
      [sourceId, workspaceId, ds[0]?.id, provider]
    );
  }

  async function seedStripeSource(workspaceId: string, sourceId: string): Promise<void> {
    await seedSource(workspaceId, sourceId, "stripe");
    await db.query(
      `insert into connection_credentials
        (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'api_key',$4)`,
      [
        `cred_${randomUUID()}`,
        workspaceId,
        sourceId,
        encryptCredentialPayload(
          { mode: "live", secretKey: "sk_test", apiBaseUrl: "https://stripe.test" },
          STRIPE_TEST_KEY
        )
      ]
    );
  }

  function stripeRequest(
    workspaceId: string,
    sourceId: string,
    windowUntil: string
  ): SyncRequest {
    return {
      workspaceId,
      sourceId,
      provider: "stripe",
      syncRunId: `run_${randomUUID()}`,
      encryptionKey: STRIPE_TEST_KEY,
      windowSince: "2019-01-01",
      windowUntil
    };
  }

  async function withStripeFetch<T>(
    invoicePage: (url: URL) => Record<string, unknown>,
    run: () => Promise<T>,
    subscriptionPage: (url: URL) => Record<string, unknown> = () => ({ data: [], has_more: false }),
    lifecycleEventPage: (url: URL) => Record<string, unknown> = () => ({ data: [], has_more: false }),
    // invoice.paid event LIST pages. Defaults to empty so existing tests are unaffected.
    paidEventPage: (url: URL) => Record<string, unknown> = () => ({ data: [], has_more: false }),
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      let body: Record<string, unknown>;
      if (url.pathname === "/v1/customers") {
        body = { data: [] };
      } else if (url.pathname === "/v1/subscriptions") {
        body = subscriptionPage(url);
      } else if (url.pathname === "/v1/events") {
        body = url.searchParams.get("type") === "invoice.paid"
          ? paidEventPage(url)
          : lifecycleEventPage(url);
      } else if (url.pathname === "/v1/invoices") {
        body = invoicePage(url);
      } else if (url.pathname.startsWith("/v1/invoices/")) {
        // Per-invoice retrieval issued for each id discovered from an invoice.paid event.
        const invoiceId = decodeURIComponent(url.pathname.slice("/v1/invoices/".length));
        body = {
          id: invoiceId,
          customer: { id: "cus_late_indexed" },
          parent: { subscription_details: { subscription: "sub_late_indexed" } },
          status: "paid",
          currency: "usd",
          amount_paid: 2_500,
          amount_due: 0,
          created: 1_500_000_000,
          status_transitions: { paid_at: 1_500_000_100 },
          lines: { data: [], has_more: false },
        };
      } else {
        throw new Error(`unexpected Stripe PGlite test URL: ${url.toString()}`);
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function readStripeState(sourceId: string): Promise<{
    backfill_state: string;
    backfill_completed_at: string | Date | null;
    latest_successful_stripe_cutoff: string | Date | null;
    last_successful_sync_at: string | Date | null;
  }> {
    const rows = await db.query<{
      backfill_state: string;
      backfill_completed_at: string | Date | null;
      latest_successful_stripe_cutoff: string | Date | null;
      last_successful_sync_at: string | Date | null;
    }>(
      `select backfill_state, backfill_completed_at, latest_successful_stripe_cutoff,
              last_successful_sync_at
         from stripe_invoice_sync_state
        where source_id = $1`,
      [sourceId]
    );
    if (!rows[0]) throw new Error(`missing Stripe sync state for ${sourceId}`);
    return rows[0];
  }

  function timestampMs(value: string | Date | null): number {
    return value instanceof Date ? value.getTime() : new Date(value ?? "").getTime();
  }

  function expectCloseTime(value: string | Date | null, before: number, after: number): void {
    expect(timestampMs(value)).toBeGreaterThanOrEqual(before);
    expect(timestampMs(value)).toBeLessThanOrEqual(after + 1_000);
  }

  it("uses successful CLOSE time for Stripe sync/completion while preserving the historical data cutoff", async () => {
    const workspaceId = "ws_stripe_close_clock";
    const sourceId = "src_stripe_close_clock";
    await seedStripeSource(workspaceId, sourceId);

    const before = Date.now();
    await withStripeFetch(
      () => ({ data: [], has_more: false }),
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-02-01"))
    );
    const after = Date.now();

    const state = await readStripeState(sourceId);
    expect(state.backfill_state).toBe("complete");
    expect(new Date(state.latest_successful_stripe_cutoff ?? "").toISOString()).toBe(
      "2020-02-01T00:00:00.000Z"
    );
    expectCloseTime(state.last_successful_sync_at, before, after);
    expectCloseTime(state.backfill_completed_at, before, after);
  });

  it("keeps partial Stripe lifecycle LOAD evidence invisible until the resumed segment CLOSE succeeds", async () => {
    const workspaceId = "ws_stripe_trial_segment";
    const sourceId = "src_stripe_trial_segment";
    await seedStripeSource(workspaceId, sourceId);
    const eventCreated = Math.floor(Date.parse("2026-07-20T00:00:00.000Z") / 1000);
    let partialPage = 0;
    let trialUnitAmount = 5_000;
    const currentTrialSubscription = () => ({
      data: [{
        id: "sub_trial_segment",
        livemode: true,
        customer: { id: "cus_trial_segment", metadata: {} },
        status: "trialing",
        currency: "usd",
        created: eventCreated,
        trial_start: eventCreated,
        trial_end: eventCreated + 86_400,
        discounts: [],
        items: {
          data: [{
            id: "si_trial_segment",
            quantity: 1,
            discounts: [],
            price: {
              id: "price_trial_segment",
              product: "prod_trial_segment",
              currency: "usd",
              unit_amount: trialUnitAmount,
              billing_scheme: "per_unit",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
            },
          }],
          has_more: false,
        },
      }],
      has_more: false,
    });

    await withStripeFetch(
      () => ({ data: [], has_more: false }),
      () => connectorFor("stripe").sync(
        db,
        stripeRequest(workspaceId, sourceId, "2026-08-04T00:00:00.000Z"),
      ),
      currentTrialSubscription,
      () => {
        partialPage += 1;
        return {
          data: [{
            id: `evt_partial_${partialPage}`,
            type: "customer.subscription.trial_will_end",
            created: eventCreated + partialPage,
            api_version: "2025-06-30.basil",
            livemode: true,
            data: {
              object: {
                id: "sub_trial_segment",
                customer: "cus_trial_segment",
                status: "trialing",
                trial_end: eventCreated + 86_400,
              },
            },
          }],
          has_more: true,
        };
      },
    );

    expect(partialPage).toBe(5);
    expect(await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_subscription_lifecycle_events where source_id = $1",
      [sourceId],
    )).toEqual([{ count: "5" }]);
    expect(await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_subscription_lifecycle_events where source_id = $1 and segment_closed_at is not null",
      [sourceId],
    )).toEqual([{ count: "0" }]);
    expect(await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_trial_history_segments where source_id = $1",
      [sourceId],
    )).toEqual([{ count: "0" }]);
    expect(await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_trial_spells where source_id = $1",
      [sourceId],
    )).toEqual([{ count: "0" }]);
    const partialCoverage = await db.query<{
      current_segment_from: string | Date | null;
      current_segment_to_exclusive: string | Date | null;
      current_segment_starting_after: string | null;
      closed_through_exclusive: string | Date | null;
    }>(
      `select current_segment_from, current_segment_to_exclusive,
              current_segment_starting_after, closed_through_exclusive
         from stripe_trial_history_coverage where source_id = $1`,
      [sourceId],
    );
    expect(partialCoverage[0]?.current_segment_from).not.toBeNull();
    expect(partialCoverage[0]?.current_segment_to_exclusive).not.toBeNull();
    expect(partialCoverage[0]?.current_segment_starting_after).toBe("evt_partial_5");
    expect(partialCoverage[0]?.closed_through_exclusive).toBeNull();

    let resumedAfter: string | null = null;
    await withStripeFetch(
      () => ({ data: [], has_more: false }),
      () => connectorFor("stripe").sync(
        db,
        {
          ...stripeRequest(workspaceId, sourceId, "2026-08-05T00:00:00.000Z"),
          syncRunId: `run_${randomUUID()}`,
        },
      ),
      currentTrialSubscription,
      (url) => {
        resumedAfter = url.searchParams.get("starting_after");
        return {
          data: [{
            id: "evt_trial_start_segment",
            type: "customer.subscription.created",
            created: eventCreated,
            api_version: "2025-06-30.basil",
            livemode: true,
            data: {
              object: {
                id: "sub_trial_segment",
                customer: "cus_trial_segment",
                status: "trialing",
                trial_start: eventCreated,
                trial_end: eventCreated + 86_400,
              },
            },
          }],
          has_more: false,
        };
      },
    );

    expect(resumedAfter).toBe("evt_partial_5");
    expect(await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_subscription_lifecycle_events where source_id = $1 and segment_closed_at is not null",
      [sourceId],
    )).toEqual([{ count: "6" }]);
    expect(await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_trial_history_segments where source_id = $1",
      [sourceId],
    )).toEqual([{ count: "1" }]);
    const spells = await db.query<{
      start_event_id: string;
      stripe_subscription_id: string;
      livemode: boolean | null;
      business_eligible_at_capture: boolean;
      frozen_currency: string | null;
      frozen_net_monthly_amount_minor: string | null;
      frozen_value_provenance: string | null;
    }>(
      `select start_event_id, stripe_subscription_id, livemode, business_eligible_at_capture,
              frozen_currency, frozen_net_monthly_amount_minor::text,
              frozen_value_provenance
         from stripe_trial_spells where source_id = $1`,
      [sourceId],
    );
    expect(spells).toEqual([{
      start_event_id: "evt_trial_start_segment",
      stripe_subscription_id: "sub_trial_segment",
      livemode: true,
      business_eligible_at_capture: true,
      frozen_currency: "usd",
      frozen_net_monthly_amount_minor: "5000.000000000000",
      frozen_value_provenance: "first_complete_current_observation_v1",
    }]);
    const closedCoverage = await db.query<{
      current_segment_from: string | Date | null;
      current_segment_starting_after: string | null;
      closed_through_exclusive: string | Date | null;
    }>(
      `select current_segment_from, current_segment_starting_after, closed_through_exclusive
         from stripe_trial_history_coverage where source_id = $1`,
      [sourceId],
    );
    expect(closedCoverage[0]?.current_segment_from).toBeNull();
    expect(closedCoverage[0]?.current_segment_starting_after).toBeNull();
    expect(closedCoverage[0]?.closed_through_exclusive).not.toBeNull();

    trialUnitAmount = 9_000;
    await withStripeFetch(
      () => ({ data: [], has_more: false }),
      () => connectorFor("stripe").sync(
        db,
        {
          ...stripeRequest(workspaceId, sourceId, "2026-08-06T00:00:00.000Z"),
          syncRunId: `run_${randomUUID()}`,
        },
      ),
      currentTrialSubscription,
    );
    expect(await db.query<{ frozen_value: string }>(
      `select frozen_net_monthly_amount_minor::text as frozen_value
         from stripe_trial_spells where source_id = $1`,
      [sourceId],
    )).toEqual([{ frozen_value: "5000.000000000000" }]);
  });

  it("clears completion on stale re-entry, stamps re-completion at CLOSE, and preserves it on event closes", async () => {
    const workspaceId = "ws_stripe_reentry_clock";
    const sourceId = "src_stripe_reentry_clock";
    await seedStripeSource(workspaceId, sourceId);
    await db.query(
      `insert into stripe_invoice_sync_state
        (id, workspace_id, source_id, backfill_state, backfill_completed_at,
         latest_successful_stripe_cutoff, last_successful_sync_at)
       values ($1,$2,$3,'complete','2024-01-01T00:00:00Z','2020-01-01T00:00:00Z','2024-01-01T00:00:00Z')`,
      [`state_${randomUUID()}`, workspaceId, sourceId]
    );

    let page = 0;
    const reentryBefore = Date.now();
    await withStripeFetch(
      () => {
        page += 1;
        return {
          data: [{
            id: `in_reentry_${page}`,
            customer: { id: "cus_reentry" },
            parent: { subscription_details: { subscription: "sub_reentry" } },
            status: "paid",
            currency: "usd",
            amount_paid: 100,
            amount_due: 0,
            created: 1_500_000_000 - page,
            status_transitions: { paid_at: 1_500_000_100 },
            lines: { data: [], has_more: false }
          }],
          has_more: true
        };
      },
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-03-01"))
    );
    const reentryAfter = Date.now();
    const inProgress = await readStripeState(sourceId);
    expect(inProgress.backfill_state).toBe("in_progress");
    expect(inProgress.backfill_completed_at).toBeNull();
    expectCloseTime(inProgress.last_successful_sync_at, reentryBefore, reentryAfter);

    const completeBefore = Date.now();
    await withStripeFetch(
      () => ({ data: [], has_more: false }),
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-03-02"))
    );
    const completeAfter = Date.now();
    const completed = await readStripeState(sourceId);
    expect(completed.backfill_state).toBe("complete");
    expectCloseTime(completed.backfill_completed_at, completeBefore, completeAfter);
    const completionMs = timestampMs(completed.backfill_completed_at);

    const eventBefore = Date.now();
    await withStripeFetch(
      () => {
        throw new Error("routine event sync must not perform a full invoice crawl");
      },
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-03-03"))
    );
    const eventAfter = Date.now();
    const eventClosed = await readStripeState(sourceId);
    expect(timestampMs(eventClosed.backfill_completed_at)).toBe(completionMs);
    expectCloseTime(eventClosed.last_successful_sync_at, eventBefore, eventAfter);
    // The durable cutoff LAGS the cursor end by the event propagation safety lag (5 min,
    // second-aligned). Stamping the cursor end itself would claim coverage of instants Stripe
    // had not finished indexing, and the next window would start above them — a permanent hole.
    expect(new Date(eventClosed.latest_successful_stripe_cutoff ?? "").toISOString()).toBe(
      "2020-03-02T23:55:00.000Z"
    );
  });

  it("never loses an invoice.paid event indexed after the window that contained it", async () => {
    // The propagation hole this proves closed: run 1 closes a window at T, an event whose
    // `created` is just below T only becomes listable afterwards, and run 2's window used to
    // start exactly at T — so that event was never fetched by any window, forever, and the
    // cutoff kept advancing so no staleness check ever fired.
    const workspaceId = "ws_stripe_event_overlap";
    const sourceId = "src_stripe_event_overlap";
    await seedStripeSource(workspaceId, sourceId);
    await db.query(
      `insert into stripe_invoice_sync_state
        (id, workspace_id, source_id, backfill_state, backfill_completed_at,
         latest_successful_stripe_cutoff, last_successful_sync_at)
       values ($1,$2,$3,'complete','2024-01-01T00:00:00Z','2020-03-01T00:00:00Z','2024-01-01T00:00:00Z')`,
      [`state_${randomUUID()}`, workspaceId, sourceId]
    );

    const windows: Array<{ gte: number; lte: number }> = [];
    // `created` is 2 SECONDS BELOW run 1's lagged window end, yet the provider only starts
    // returning it on run 2 — exactly the eventual-consistency case.
    const lateIndexedCreated = Math.floor(Date.parse("2020-03-01T23:54:58.000Z") / 1000);
    let eventListCalls = 0;
    const eventRoute = (url: URL) => {
      windows.push({
        gte: Number(url.searchParams.get("created[gte]")),
        lte: Number(url.searchParams.get("created[lte]")),
      });
      eventListCalls += 1;
      if (eventListCalls === 1) return { data: [], has_more: false };
      return {
        data: [{
          id: "evt_late_indexed",
          type: "invoice.paid",
          created: lateIndexedCreated,
          data: { object: { id: "in_late_indexed" } },
        }],
        has_more: false,
      };
    };

    await withStripeFetch(
      () => {
        throw new Error("event-only close must not list invoices");
      },
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-03-02")),
      undefined,
      undefined,
      eventRoute,
    );

    const afterFirst = await readStripeState(sourceId);
    const firstCutoffMs = new Date(afterFirst.latest_successful_stripe_cutoff ?? "").getTime();
    // (a) the cutoff LAGS the cursor end rather than matching it.
    expect(new Date(firstCutoffMs).toISOString()).toBe("2020-03-01T23:55:00.000Z");

    await withStripeFetch(
      () => {
        throw new Error("event-only close must not list invoices");
      },
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-03-03")),
      undefined,
      undefined,
      eventRoute,
    );

    expect(windows).toHaveLength(2);
    // (b) run 2's window reaches BACK BELOW run 1's stored cutoff — the windows overlap.
    expect(windows[1]!.gte * 1000).toBe(firstCutoffMs - 5 * 60 * 1000);
    expect(windows[1]!.gte * 1000).toBeLessThan(firstCutoffMs);
    // Second-aligned on both edges, matching what Stripe was actually asked for.
    expect(windows.every((w) => Number.isInteger(w.gte) && Number.isInteger(w.lte))).toBe(true);
    // (c) the late-indexed event lands: its invoice is now normalized truth.
    expect(lateIndexedCreated * 1000).toBeLessThan(firstCutoffMs);
    expect(lateIndexedCreated).toBeGreaterThanOrEqual(windows[1]!.gte);
    expect(await db.query<{ stripe_invoice_id: string }>(
      "select stripe_invoice_id from stripe_invoices where source_id = $1",
      [sourceId],
    )).toEqual([{ stripe_invoice_id: "in_late_indexed" }]);
  });

  it("an invoice-derived subscription row never clobbers real subscription truth", async () => {
    // The shipped bug: the invoice write path upserted stripe_subscriptions with a hardcoded
    // status='active' and current_period_end=excluded (null in an invoice payload), and
    // OVERWROTE on conflict. Within one sync the subscription chunk re-corrected it — but LOAD
    // is chunked into SEPARATE transactions, so a chunk failure committed the corruption and a
    // canceled subscription was counted as paying. Proven here against real Postgres.
    const workspaceId = "ws_stripe_placeholder";
    const sourceId = "src_stripe_placeholder";
    await seedStripeSource(workspaceId, sourceId);
    await db.query(
      `insert into stripe_subscriptions
        (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
         current_period_start, current_period_end, created_at_source, items_sync_complete, livemode)
       values ($1,$2,$3,'sub_real','cus_real','canceled','2026-06-01T00:00:00Z',
               '2026-07-01T00:00:00Z','2026-05-01T00:00:00Z', true, true)`,
      [`sub_${randomUUID()}`, workspaceId, sourceId]
    );

    await withStripeFetch(
      () => ({
        data: [{
          id: "in_for_real_sub",
          customer: { id: "cus_real" },
          parent: { subscription_details: { subscription: "sub_real" } },
          status: "paid",
          currency: "usd",
          amount_paid: 4_900,
          amount_due: 0,
          created: 1_500_000_000,
          status_transitions: { paid_at: 1_500_000_100 },
          lines: { data: [], has_more: false },
        }],
        has_more: false,
      }),
      // /v1/subscriptions returns NOTHING, so nothing re-corrects the row this run — exactly the
      // separate-transaction / phantom-subscription situation.
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2026-08-01")),
    );

    expect(await db.query<{
      status: string;
      current_period_end: string | Date | null;
      livemode: boolean | null;
    }>(
      `select status, current_period_end, livemode
         from stripe_subscriptions where source_id = $1 and stripe_subscription_id = 'sub_real'`,
      [sourceId],
    )).toMatchObject([{ status: "canceled", livemode: true }]);
    const preserved = await db.query<{ current_period_end: string | Date | null }>(
      `select current_period_end from stripe_subscriptions
        where source_id = $1 and stripe_subscription_id = 'sub_real'`,
      [sourceId],
    );
    expect(preserved[0]?.current_period_end).not.toBeNull();
  });

  it("writes a phantom invoice-only subscription as inert 'unknown', not as a paying subscriber", async () => {
    // An invoice can name a subscription that /v1/subscriptions never lists (deleted, or outside
    // the crawl). That row used to land status='active' with items_sync_complete=false, which the
    // recurring-value / lifecycle views' fail-closed bool_or turns into a workspace-wide NULL for
    // current_paid_subscribers. 'unknown' is in neither the active set ('active','past_due') nor
    // the terminal set ('canceled','unpaid'), so it contributes to nothing.
    const workspaceId = "ws_stripe_phantom";
    const sourceId = "src_stripe_phantom";
    await seedStripeSource(workspaceId, sourceId);

    await withStripeFetch(
      () => ({
        data: [{
          id: "in_phantom",
          customer: { id: "cus_phantom" },
          parent: { subscription_details: { subscription: "sub_phantom" } },
          status: "paid",
          currency: "usd",
          amount_paid: 4_900,
          amount_due: 0,
          created: 1_500_000_000,
          status_transitions: { paid_at: 1_500_000_100 },
          lines: { data: [], has_more: false },
        }],
        has_more: false,
      }),
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2026-08-01")),
    );

    expect(await db.query<{ status: string }>(
      `select status from stripe_subscriptions
        where source_id = $1 and stripe_subscription_id = 'sub_phantom'`,
      [sourceId],
    )).toEqual([{ status: "unknown" }]);
    expect(await db.query<{ count: string }>(
      `select count(*)::text as count from stripe_subscriptions
        where source_id = $1 and status in ('active','past_due','canceled','unpaid')`,
      [sourceId],
    )).toEqual([{ count: "0" }]);
  });

  it("rolls back Stripe sync/completion timestamps when a later CLOSE statement fails", async () => {
    const workspaceId = "ws_stripe_close_rollback";
    const sourceId = "src_stripe_close_rollback";
    await seedStripeSource(workspaceId, sourceId);
    await db.query(
      `insert into stripe_invoice_sync_state
        (id, workspace_id, source_id, backfill_state, backfill_completed_at,
         latest_successful_stripe_cutoff, last_successful_sync_at)
       values ($1,$2,$3,'complete','2024-01-01T00:00:00Z','2020-03-01T00:00:00Z','2024-01-02T00:00:00Z')`,
      [`state_${randomUUID()}`, workspaceId, sourceId]
    );
    const before = await readStripeState(sourceId);
    const failedRequest = stripeRequest(workspaceId, sourceId, "2020-03-02");

    await db.query(
      `alter table sync_cursors add constraint stripe_close_rollback_test
       check (cursor_value <> '2020-03-02')`
    );
    try {
      await expect(withStripeFetch(
        () => {
          throw new Error("event-only close must not list invoices");
        },
        () => connectorFor("stripe").sync(db, failedRequest)
      )).rejects.toThrow();
    } finally {
      await db.query("alter table sync_cursors drop constraint stripe_close_rollback_test");
    }

    const after = await readStripeState(sourceId);
    expect(timestampMs(after.backfill_completed_at)).toBe(timestampMs(before.backfill_completed_at));
    expect(timestampMs(after.last_successful_sync_at)).toBe(timestampMs(before.last_successful_sync_at));
    expect(timestampMs(after.latest_successful_stripe_cutoff)).toBe(
      timestampMs(before.latest_successful_stripe_cutoff)
    );
    const failureState = await db.query<{
      source_status: string;
      consecutive_sync_failures: number;
      run_status: string;
      batch_status: string;
      error_count: string;
    }>(
      `select s.status as source_status, s.consecutive_sync_failures,
              (select status from sync_runs where id = $2) as run_status,
              (select status from sync_batches where sync_run_id = $2) as batch_status,
              (select count(*)::text from sync_errors where sync_run_id = $2) as error_count
         from sources s where s.id = $1`,
      [sourceId, failedRequest.syncRunId]
    );
    expect(failureState).toEqual([{
      source_status: "connected",
      consecutive_sync_failures: 1,
      run_status: "failed",
      batch_status: "failed",
      error_count: "1"
    }]);
  });

  it("classifies the syncing target source at CLOSE, uses CLOSE time, and replays idempotently", async () => {
    const workspaceId = "ws_stripe_mrr_close";
    const sourceId = "src_stripe_mrr_close";
    await seedStripeSource(workspaceId, sourceId);
    let unitAmount = 5_000;
    const subscriptionPage = () => ({
      data: [{
        id: "sub_mrr_close",
        customer: { id: "cus_mrr_close", metadata: {} },
        status: "active",
        currency: "usd",
        created: 1_720_612_800,
        current_period_start: 1_722_009_600,
        current_period_end: 1_724_688_000,
        discounts: [],
        items: {
          data: [{
            id: "si_mrr_close",
            quantity: 1,
            discounts: [],
            price: {
              id: "price_mrr_close",
              product: "prod_mrr_close",
              currency: "usd",
              unit_amount: unitAmount,
              billing_scheme: "per_unit",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }
            }
          }],
          has_more: false
        }
      }],
      has_more: false
    });
    const invoicePage = () => ({
      data: [{
        id: "in_mrr_close",
        customer: { id: "cus_mrr_close", metadata: {} },
        parent: { subscription_details: { subscription: "sub_mrr_close" } },
        status: "paid",
        currency: "usd",
        amount_paid: 5_000,
        amount_due: 5_000,
        created: 1_720_612_800,
        status_transitions: { paid_at: 1_720_612_900 },
        lines: { data: [], has_more: false }
      }],
      has_more: false
    });

    await withStripeFetch(
      invoicePage,
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-04-01")),
      subscriptionPage,
    );
    const bootstrap = await db.query<{
      movement_kind: string;
      to_amount_minor: string;
      effective_at: string | Date;
      observed_at: string | Date;
    }>(
      `select movement_kind, to_amount_minor::text, effective_at, observed_at
         from stripe_customer_mrr_movements where source_id = $1`,
      [sourceId]
    );
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]).toMatchObject({ movement_kind: "new", to_amount_minor: "5000.000000000000" });
    expect(new Date(bootstrap[0]?.effective_at ?? "").toISOString()).toBe("2024-07-10T12:01:40.000Z");
    expect(new Date(bootstrap[0]?.observed_at ?? "").getUTCFullYear()).toBeGreaterThan(2020);

    unitAmount = 6_000;
    const beforeExpansion = Date.now();
    await withStripeFetch(
      invoicePage,
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-04-02")),
      subscriptionPage,
    );
    const movements = await db.query<{
      movement_kind: string;
      delta_amount_minor: string;
      effective_at: string | Date;
    }>(
      `select movement_kind, delta_amount_minor::text, effective_at
         from stripe_customer_mrr_movements where source_id = $1 order by observed_at`,
      [sourceId]
    );
    expect(movements.map((row) => [row.movement_kind, row.delta_amount_minor])).toEqual([
      ["new", "5000.000000000000"],
      ["expansion", "1000.000000000000"],
    ]);
    expect(timestampMs(movements[1]?.effective_at ?? null)).toBeGreaterThanOrEqual(beforeExpansion);
    const state = await db.query<{ monthly_amount_minor: string }>(
      `select monthly_amount_minor::text from stripe_customer_mrr_states where source_id = $1`,
      [sourceId]
    );
    expect(state).toEqual([{ monthly_amount_minor: "6000.000000000000" }]);

    await withStripeFetch(
      invoicePage,
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-04-03")),
      subscriptionPage,
    );
    const replayCount = await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_customer_mrr_movements where source_id = $1",
      [sourceId]
    );
    expect(replayCount[0]?.count).toBe("2");

    unitAmount = 7_000;
    await db.query(
      `alter table sync_cursors add constraint stripe_mrr_close_rollback_test
       check (cursor_value <> '2020-04-04')`
    );
    try {
      await expect(withStripeFetch(
        invoicePage,
        () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-04-04")),
        subscriptionPage,
      )).rejects.toThrow();
    } finally {
      await db.query("alter table sync_cursors drop constraint stripe_mrr_close_rollback_test");
    }
    const rolledBack = await db.query<{ amount: string; movement_count: string }>(
      `select s.monthly_amount_minor::text as amount,
              (select count(*)::text from stripe_customer_mrr_movements m
                where m.source_id = s.source_id) as movement_count
         from stripe_customer_mrr_states s where s.source_id = $1`,
      [sourceId]
    );
    expect(rolledBack).toEqual([{ amount: "6000.000000000000", movement_count: "2" }]);
  });

  it("does not bootstrap new when the earliest positive invoice belongs to an older subscription", async () => {
    const workspaceId = "ws_stripe_mrr_old_payment";
    const sourceId = "src_stripe_mrr_old_payment";
    await seedStripeSource(workspaceId, sourceId);
    const pricedItem = (id: string, amount: number) => ({
      id: `si_${id}`,
      quantity: 1,
      discounts: [],
      price: {
        id: `price_${id}`,
        product: `prod_${id}`,
        currency: "usd",
        unit_amount: amount,
        billing_scheme: "per_unit",
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }
      }
    });
    const subscriptionPage = () => ({
      data: [
        {
          id: "sub_old_paid",
          customer: { id: "cus_old_paid", metadata: {} },
          status: "canceled",
          currency: "usd",
          created: 1_700_000_000,
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          canceled_at: 1_702_592_000,
          ended_at: 1_702_592_000,
          discounts: [],
          items: { data: [pricedItem("old_paid", 3_000)], has_more: false }
        },
        {
          id: "sub_current_paid",
          customer: { id: "cus_old_paid", metadata: {} },
          status: "active",
          currency: "usd",
          created: 1_720_000_000,
          current_period_start: 1_720_000_000,
          current_period_end: 1_722_592_000,
          discounts: [],
          items: { data: [pricedItem("current_paid", 5_000)], has_more: false }
        }
      ],
      has_more: false
    });
    const invoice = (id: string, subscriptionId: string, paidAt: number) => ({
      id,
      customer: { id: "cus_old_paid", metadata: {} },
      parent: { subscription_details: { subscription: subscriptionId } },
      status: "paid",
      currency: "usd",
      amount_paid: 1_000,
      amount_due: 1_000,
      created: paidAt - 100,
      status_transitions: { paid_at: paidAt },
      lines: { data: [], has_more: false }
    });
    const invoicePage = () => ({
      data: [
        invoice("in_old_paid", "sub_old_paid", 1_700_000_100),
        invoice("in_current_paid", "sub_current_paid", 1_720_000_100)
      ],
      has_more: false
    });

    await withStripeFetch(
      invoicePage,
      () => connectorFor("stripe").sync(db, stripeRequest(workspaceId, sourceId, "2020-05-01")),
      subscriptionPage,
    );
    const facts = await db.query<{ count: string }>(
      "select count(*)::text as count from stripe_customer_mrr_movements where source_id = $1",
      [sourceId]
    );
    const state = await db.query<{ amount: string; has_ever_positive: boolean }>(
      `select monthly_amount_minor::text as amount, has_ever_positive
         from stripe_customer_mrr_states where source_id = $1 and currency = 'usd'`,
      [sourceId]
    );
    expect(facts[0]?.count).toBe("0");
    expect(state).toEqual([{ amount: "5000.000000000000", has_ever_positive: true }]);
  });

  it("admits only one same-source loader between chunks, without failure side effects", async () => {
    const workspaceId = "ws_same_source_admission";
    const sourceId = "src_same_source_admission";
    await seedStripeSource(workspaceId, sourceId);
    await db.query(
      `insert into stripe_customer_mrr_states (
         id, workspace_id, source_id, stripe_customer_id, currency,
         monthly_amount_minor, has_ever_positive, evidence_hash,
         last_complete_observed_at, classifier_version
       ) values ($1,$2,$3,'cus_admission','usd',0,false,'initial-zero',
                 '2026-01-01T00:00:00Z','stripe_customer_mrr_v1')`,
      [`state_${randomUUID()}`, workspaceId, sourceId]
    );

    let releaseFirstLoader!: () => void;
    const firstLoaderReleased = new Promise<void>((resolve) => {
      releaseFirstLoader = resolve;
    });
    let signalFirstChunkCommitted!: () => void;
    const firstChunkCommitted = new Promise<void>((resolve) => {
      signalFirstChunkCommitted = resolve;
    });
    let firstChunkSignaled = false;
    const pausedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "withTransaction") {
          return async <T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T> => {
            const result = await target.withTransaction(fn);
            const rawCount = await target.query<{ count: string }>(
              "select count(*)::text as count from raw_records where source_id = $1",
              [sourceId]
            );
            if (!firstChunkSignaled && rawCount[0]?.count === String(CHUNK_SIZE)) {
              firstChunkSignaled = true;
              signalFirstChunkCommitted();
              await firstLoaderReleased;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as InfiniteOsDb;

    const firstRunId = `run_${randomUUID()}`;
    const firstRequest: SyncRequest = {
      workspaceId,
      sourceId,
      provider: "stripe",
      syncRunId: firstRunId
    };
    let recurringTruthWritten = false;
    const firstRun = __testOnlySyncExtractedBatch(
      pausedDb,
      firstRequest,
      makePlan("2026-08-01T00:00:00.000Z"),
      makeRecords(CHUNK_SIZE + 1, "same_source_a"),
      async (tx, _records, rawIds) => {
        if (recurringTruthWritten) return;
        recurringTruthWritten = true;
        await tx.query(
          `insert into stripe_customers (
             id, workspace_id, source_id, raw_record_id, stripe_customer_id,
             metrics_classification, created_at_source
           ) values ($1,$2,$3,$4,'cus_admission','business','2026-01-01T00:00:00Z')`,
          [`cus_${randomUUID()}`, workspaceId, sourceId, rawIds[0]]
        );
        await tx.query(
          `insert into stripe_subscriptions (
             id, workspace_id, source_id, raw_record_id, stripe_subscription_id,
             stripe_customer_id, status, current_period_start, current_period_end,
             created_at_source, items_sync_complete, discounts_sync_complete
           ) values ($1,$2,$3,$4,'sub_admission','cus_admission','active',
                     '2026-07-01T00:00:00Z','2026-09-01T00:00:00Z',
                     '2026-01-01T00:00:00Z',true,true)`,
          [`sub_${randomUUID()}`, workspaceId, sourceId, rawIds[0]]
        );
        await tx.query(
          `insert into stripe_subscription_items (
             id, workspace_id, source_id, raw_record_id,
             stripe_subscription_item_id, stripe_subscription_id, currency,
             unit_amount, quantity, recurring_interval, recurring_interval_count,
             recurring_usage_type, billing_scheme, custom_unit_amount,
             pricing_state, default_currency, default_unit_amount,
             price_currency_options, currency_option_resolved
           ) values ($1,$2,$3,$4,'si_admission','sub_admission','usd',5000,1,
                     'month',1,'licensed','per_unit',false,'licensed_per_unit',
                     'usd',5000,'{}'::jsonb,true)`,
          [`si_${randomUUID()}`, workspaceId, sourceId, rawIds[0]]
        );
      },
      (tx, request) => writeStripeMrrMovementsAtClose(tx, request)
    );

    await firstChunkCommitted;
    const beforeOverlap = await db.query<{
      status: string;
      consecutive_sync_failures: number;
      raw_count: string;
    }>(
      `select s.status, s.consecutive_sync_failures,
              (select count(*)::text from raw_records r where r.source_id = s.id) as raw_count
         from sources s where s.id = $1`,
      [sourceId]
    );
    expect(beforeOverlap).toEqual([{
      status: "syncing",
      consecutive_sync_failures: 0,
      raw_count: String(CHUNK_SIZE)
    }]);

    const overlapRunId = `run_${randomUUID()}`;
    let overlapLiveCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      overlapLiveCalls += 1;
      throw new Error("overlapping run reached the live Stripe API");
    }) as typeof fetch;
    let overlapOutcome: { admitted: boolean; message: string };
    try {
      overlapOutcome = await connectorFor("stripe").sync(
        db,
        {
          ...stripeRequest(workspaceId, sourceId, "2026-08-02T00:00:00.000Z"),
          syncRunId: overlapRunId
        }
      ).then(
        () => ({ admitted: true, message: "" }),
        (error: unknown) => ({
          admitted: false,
          message: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const afterOverlap = await db.query<{
      status: string;
      consecutive_sync_failures: number;
      raw_count: string;
      overlap_runs: string;
      overlap_batches: string;
      overlap_errors: string;
      first_run_status: string;
      first_batch_status: string;
    }>(
      `select s.status, s.consecutive_sync_failures,
              (select count(*)::text from raw_records r where r.source_id = s.id) as raw_count,
              (select count(*)::text from sync_runs r where r.id = $2) as overlap_runs,
              (select count(*)::text from sync_batches b where b.sync_run_id = $2) as overlap_batches,
              (select count(*)::text from sync_errors e where e.sync_run_id = $2) as overlap_errors,
              (select status from sync_runs r where r.id = $3) as first_run_status,
              (select status from sync_batches b where b.sync_run_id = $3) as first_batch_status
         from sources s where s.id = $1`,
      [sourceId, overlapRunId, firstRunId]
    );

    releaseFirstLoader();
    await firstRun;

    expect(overlapOutcome.admitted).toBe(false);
    expect(overlapOutcome.message).toContain("already syncing");
    expect(overlapLiveCalls).toBe(0);
    expect(afterOverlap).toEqual([{
      status: "syncing",
      consecutive_sync_failures: 0,
      raw_count: String(CHUNK_SIZE),
      overlap_runs: "0",
      overlap_batches: "0",
      overlap_errors: "0",
      first_run_status: "running",
      first_batch_status: "running"
    }]);

    const movementAndState = await db.query<{
      movement_count: string;
      state_count: string;
      movement_kind: string;
      state_amount: string;
    }>(
      `select
         (select count(*)::text from stripe_customer_mrr_movements where source_id = $1) as movement_count,
         (select count(*)::text from stripe_customer_mrr_states where source_id = $1) as state_count,
         (select movement_kind from stripe_customer_mrr_movements where source_id = $1) as movement_kind,
         (select monthly_amount_minor::text from stripe_customer_mrr_states where source_id = $1) as state_amount`,
      [sourceId]
    );
    expect(movementAndState).toEqual([{
      movement_count: "1",
      state_count: "1",
      movement_kind: "new",
      state_amount: "5000.000000000000"
    }]);

    const nextRunId = `run_${randomUUID()}`;
    let postCloseLiveCalls = 0;
    const postCloseOriginalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      postCloseLiveCalls += 1;
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url
      );
      const body = url.pathname === "/v1/customers"
        ? { data: [] }
        : { data: [], has_more: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    try {
      await connectorFor("stripe").sync(
        db,
        {
          ...stripeRequest(workspaceId, sourceId, "2026-08-03T00:00:00.000Z"),
          syncRunId: nextRunId
        }
      );
    } finally {
      globalThis.fetch = postCloseOriginalFetch;
    }
    expect(postCloseLiveCalls).toBeGreaterThan(0);
    const nextRun = await db.query<{ status: string }>(
      "select status from sync_runs where id = $1",
      [nextRunId]
    );
    expect(nextRun).toEqual([{ status: "succeeded" }]);
  });

  it("rejects batch admission outside the source workspace or provider scope", async () => {
    const workspaceId = "ws_admission_scope";
    const sourceId = "src_admission_scope";
    await seedSource(workspaceId, sourceId, "stripe");

    const wrongWorkspaceRunId = `run_${randomUUID()}`;
    const wrongProviderRunId = `run_${randomUUID()}`;
    await expect(__testOnlySyncExtractedBatch(
      db,
      {
        workspaceId: "ws_not_the_source_owner",
        sourceId,
        provider: "stripe",
        syncRunId: wrongWorkspaceRunId
      },
      makePlan("2026-08-01T00:00:00.000Z"),
      [],
      async () => {}
    )).rejects.toThrow("outside the requested workspace or provider scope");
    await expect(__testOnlySyncExtractedBatch(
      db,
      {
        workspaceId,
        sourceId,
        provider: "posthog",
        syncRunId: wrongProviderRunId
      },
      makePlan("2026-08-01T00:00:00.000Z"),
      [],
      async () => {}
    )).rejects.toThrow("outside the requested workspace or provider scope");

    const source = await db.query<{
      status: string;
      consecutive_sync_failures: number;
      rejected_runs: string;
    }>(
      `select status, consecutive_sync_failures,
              (select count(*)::text from sync_runs
                where id = any($2::text[])) as rejected_runs
         from sources where id = $1`,
      [sourceId, [wrongWorkspaceRunId, wrongProviderRunId]]
    );
    expect(source).toEqual([{
      status: "connected",
      consecutive_sync_failures: 0,
      rejected_runs: "0"
    }]);
  });

  it("cleans up the exact claim when batch OPEN fails before a batch row commits", async () => {
    const workspaceId = "ws_open_failure_cleanup";
    const sourceId = "src_open_failure_cleanup";
    await seedSource(workspaceId, sourceId);
    const syncRunId = `run_${randomUUID()}`;
    await db.query(
      `alter table sync_batches add constraint open_failure_cleanup_test
       check (cursor_end <> '2026-08-09T00:00:00.000Z')`
    );
    try {
      await expect(__testOnlySyncExtractedBatch(
        db,
        { workspaceId, sourceId, provider: "posthog", syncRunId },
        makePlan("2026-08-09T00:00:00.000Z"),
        makeRecords(1, "open_failure"),
        async () => {}
      )).rejects.toThrow();
    } finally {
      await db.query("alter table sync_batches drop constraint open_failure_cleanup_test");
    }

    const state = await db.query<{
      source_status: string;
      consecutive_sync_failures: number;
      run_status: string;
      batch_count: string;
      error_count: string;
    }>(
      `select s.status as source_status, s.consecutive_sync_failures,
              (select status from sync_runs where id = $2) as run_status,
              (select count(*)::text from sync_batches where sync_run_id = $2) as batch_count,
              (select count(*)::text from sync_errors where sync_run_id = $2) as error_count
         from sources s where s.id = $1`,
      [sourceId, syncRunId]
    );
    expect(state).toEqual([{
      source_status: "connected",
      consecutive_sync_failures: 1,
      run_status: "failed",
      batch_count: "0",
      error_count: "1"
    }]);
  });

  it("retires stale running batches when a boot-recovered source admits its next owner", async () => {
    const workspaceId = "ws_stale_owner_recovery";
    const sourceId = "src_stale_owner_recovery";
    await seedSource(workspaceId, sourceId);
    const staleRunId = `run_${randomUUID()}`;
    const staleBatchId = `batch_${randomUUID()}`;
    await db.query(
      `insert into sync_runs (id, workspace_id, source_id, status)
       values ($1,$2,$3,'running')`,
      [staleRunId, workspaceId, sourceId]
    );
    await db.query(
      `insert into sync_batches (
         id, sync_run_id, workspace_id, source_id, status, batch_type
       ) values ($1,$2,$3,$4,'running','stale-test')`,
      [staleBatchId, staleRunId, workspaceId, sourceId]
    );
    await db.query("update sources set status = 'syncing' where id = $1", [sourceId]);
    // This is the boot recovery contract: it repairs source schedulability; the next
    // claim owns stale run/batch retirement.
    await db.query("update sources set status = 'connected' where status = 'syncing'");

    const nextRunId = `run_${randomUUID()}`;
    await __testOnlySyncExtractedBatch(
      db,
      { workspaceId, sourceId, provider: "posthog", syncRunId: nextRunId },
      makePlan("2026-08-10T00:00:00.000Z"),
      [],
      async () => {}
    );

    const stale = await db.query<{
      run_status: string;
      run_finished: boolean;
      batch_status: string;
      batch_finished: boolean;
    }>(
      `select r.status as run_status, r.finished_at is not null as run_finished,
              b.status as batch_status, b.finished_at is not null as batch_finished
         from sync_runs r join sync_batches b on b.sync_run_id = r.id
        where r.id = $1`,
      [staleRunId]
    );
    expect(stale).toEqual([{
      run_status: "failed",
      run_finished: true,
      batch_status: "failed",
      batch_finished: true
    }]);
  });

  it("claims before live provider work and restores a transient planning failure without erasing its streak", async () => {
    const workspaceId = "ws_pre_extract_claim_failure";
    const sourceId = "src_pre_extract_claim_failure";
    await seedStripeSource(workspaceId, sourceId);
    const syncRunId = `run_${randomUUID()}`;
    let statusDuringLiveCall: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const source = await db.query<{ status: string }>(
        "select status from sources where id = $1",
        [sourceId]
      );
      statusDuringLiveCall = source[0]?.status ?? null;
      throw new TypeError("simulated transient Stripe network failure");
    }) as typeof fetch;
    try {
      await expect(connectorFor("stripe").sync(
        db,
        {
          ...stripeRequest(workspaceId, sourceId, "2026-08-04T00:00:00.000Z"),
          syncRunId
        }
      )).rejects.toThrow("simulated transient Stripe network failure");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(statusDuringLiveCall).toBe("syncing");
    const result = await db.query<{
      status: string;
      consecutive_sync_failures: number;
      run_status: string;
      error_count: string;
    }>(
      `select s.status, s.consecutive_sync_failures,
              (select status from sync_runs where id = $2) as run_status,
              (select count(*)::text from sync_errors where sync_run_id = $2) as error_count
         from sources s where s.id = $1`,
      [sourceId, syncRunId]
    );
    expect(result).toEqual([{
      status: "connected",
      consecutive_sync_failures: 1,
      run_status: "failed",
      error_count: "1"
    }]);
  });

  // A truth-writer that lands one record_lineage row per record keyed on the
  // record's externalId AND its resolved rawId — so we can later JOIN lineage back
  // to raw_records and prove rawIds[i] really points at records[i]'s raw row.
  function lineageWriteTruth(
    request: SyncRequest,
    seenChunks: number[]
  ): (tx: InfiniteOsDb, records: ExtractedRecord<unknown>[], rawIds: string[]) => Promise<void> {
    return async (tx, records, rawIds) => {
      expect(records.length).toBe(rawIds.length);
      expect(records.length).toBeLessThanOrEqual(CHUNK_SIZE);
      seenChunks.push(records.length);
      for (let i = 0; i < records.length; i += 1) {
        await tx.query(
          `insert into record_lineage (
             id, workspace_id, canonical_table, canonical_id, provider,
             provider_table, provider_row_id, raw_record_id, normalization_version
           )
           values ($1, $2, 'test_truth', $3, 'posthog', 'test_truth', $3, $4, 'live-v1')
           on conflict (workspace_id, provider_table, provider_row_id, raw_record_id)
           do update set normalization_version = excluded.normalization_version`,
          [`lin_${randomUUID()}`, request.workspaceId, records[i].externalId, rawIds[i]]
        );
      }
    };
  }

  it("splits a large batch across multiple transactions, keeps rawId alignment, and lands every row", async () => {
    const workspaceId = "ws_chunk_large";
    const sourceId = "src_chunk_large";
    await seedSource(workspaceId, sourceId);

    const records = makeRecords(1150, "large");
    const request: SyncRequest = {
      workspaceId,
      sourceId,
      provider: "posthog",
      syncRunId: `run_${randomUUID()}`
    };
    const cursorEnd = "2026-07-08T00:00:00.000Z";
    const seenChunks: number[] = [];

    const result = await __testOnlySyncExtractedBatch(
      db,
      request,
      makePlan(cursorEnd),
      records,
      lineageWriteTruth(request, seenChunks)
    );

    // 1150 records at chunk size 500 => three writeTruth invocations of 500/500/150.
    expect(seenChunks).toEqual([500, 500, 150]);

    expect(result).toMatchObject({
      provider: "posthog",
      recordsExtracted: 1150,
      recordsLoaded: 1150,
      cursorKey: "test_cursor",
      cursorValue: cursorEnd
    });

    const rawCount = await db.query<{ count: string }>(
      "select count(*)::text as count from raw_records where source_id = $1",
      [sourceId]
    );
    expect(rawCount[0]?.count).toBe("1150");

    // Every sync_batch_records row reached provider_truth_written.
    const sbr = await db.query<{ total: string; done: string }>(
      `select count(*)::text as total,
              count(*) filter (where sbr.record_status = 'provider_truth_written')::text as done
         from sync_batch_records sbr
         join sync_batches sb on sb.id = sbr.sync_batch_id
        where sb.source_id = $1`,
      [sourceId]
    );
    expect(sbr[0]?.total).toBe("1150");
    expect(sbr[0]?.done).toBe("1150");

    // ALIGNMENT: no lineage row is orphaned or points at the wrong raw record.
    const misaligned = await db.query<{ count: string }>(
      `select count(*)::text as count
         from record_lineage rl
         left join raw_records rr on rr.id = rl.raw_record_id
        where rl.workspace_id = $1
          and (rr.id is null or rr.external_id <> rl.provider_row_id)`,
      [workspaceId]
    );
    expect(misaligned[0]?.count).toBe("0");

    const lineageCount = await db.query<{ count: string }>(
      "select count(*)::text as count from record_lineage where workspace_id = $1",
      [workspaceId]
    );
    expect(lineageCount[0]?.count).toBe("1150");

    // Bookkeeping finalized.
    const batch = await db.query<{ status: string; records_written: number; records_seen: number }>(
      "select status, records_written, records_seen from sync_batches where source_id = $1",
      [sourceId]
    );
    expect(batch).toHaveLength(1);
    expect(batch[0]?.status).toBe("succeeded");
    expect(Number(batch[0]?.records_written)).toBe(1150);
    expect(Number(batch[0]?.records_seen)).toBe(1150);

    const run = await db.query<{ status: string; records_extracted: number; records_loaded: number }>(
      "select status, records_extracted, records_loaded from sync_runs where id = $1",
      [request.syncRunId]
    );
    expect(run[0]?.status).toBe("succeeded");
    expect(Number(run[0]?.records_extracted)).toBe(1150);
    expect(Number(run[0]?.records_loaded)).toBe(1150);

    const cursor = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'test_cursor'",
      [sourceId]
    );
    expect(new Date(cursor[0]?.cursor_value ?? "").toISOString()).toBe(cursorEnd);

    const source = await db.query<{ status: string; last_synced_at: string | null }>(
      "select status, last_synced_at from sources where id = $1",
      [sourceId]
    );
    expect(source[0]?.status).toBe("connected");
    expect(source[0]?.last_synced_at).not.toBeNull();
  });

  it("re-running the same batch is idempotent: on-conflict de-dupes and rawIds resolve to the EXISTING rows", async () => {
    const workspaceId = "ws_chunk_idem";
    const sourceId = "src_chunk_idem";
    await seedSource(workspaceId, sourceId);

    const records = makeRecords(700, "idem"); // two chunks (500 + 200)
    const cursorEnd = "2026-07-08T01:00:00.000Z";

    const firstRequest: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    await __testOnlySyncExtractedBatch(db, firstRequest, makePlan(cursorEnd), records, lineageWriteTruth(firstRequest, []));

    const rawIdsAfterFirst = await db.query<{ id: string; external_id: string }>(
      "select id, external_id from raw_records where source_id = $1 order by external_id",
      [sourceId]
    );
    expect(rawIdsAfterFirst).toHaveLength(700);

    // Second run of the IDENTICAL records (new sync run). raw_records must de-dupe on
    // its natural key, and the rawIds the loader resolves must be the EXISTING ids
    // (proving the RETURNING-key map — not the proposed ids — drove alignment on
    // conflict). If it had used fresh proposed ids, lineage rows would orphan.
    const secondRequest: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    await __testOnlySyncExtractedBatch(db, secondRequest, makePlan(cursorEnd), records, lineageWriteTruth(secondRequest, []));

    const rawCount = await db.query<{ count: string }>(
      "select count(*)::text as count from raw_records where source_id = $1",
      [sourceId]
    );
    expect(rawCount[0]?.count).toBe("700"); // no duplicates created

    // raw_records ids are unchanged (existing rows kept their ids on conflict).
    const rawIdsAfterSecond = await db.query<{ id: string; external_id: string }>(
      "select id, external_id from raw_records where source_id = $1 order by external_id",
      [sourceId]
    );
    expect(rawIdsAfterSecond.map((r) => r.id)).toEqual(rawIdsAfterFirst.map((r) => r.id));

    // No orphaned / misaligned lineage after the re-run.
    const misaligned = await db.query<{ count: string }>(
      `select count(*)::text as count
         from record_lineage rl
         left join raw_records rr on rr.id = rl.raw_record_id
        where rl.workspace_id = $1
          and (rr.id is null or rr.external_id <> rl.provider_row_id)`,
      [workspaceId]
    );
    expect(misaligned[0]?.count).toBe("0");
  });

  it("resolves intra-chunk duplicate records (same natural key) to the SAME raw_record id", async () => {
    const workspaceId = "ws_chunk_dupe";
    const sourceId = "src_chunk_dupe";
    await seedSource(workspaceId, sourceId);

    // records[0] and records[2] share objectType + externalId + payload => same key.
    const shared: ExtractedRecord<{ marker: string }> = {
      externalId: "dupe_ext",
      objectType: "test_object",
      payloadVersion: "live-v1",
      sourceUpdatedAt: null,
      payload: { marker: "same" }
    };
    const records: ExtractedRecord<{ marker: string }>[] = [
      shared,
      { externalId: "other_ext", objectType: "test_object", payloadVersion: "live-v1", sourceUpdatedAt: null, payload: { marker: "other" } },
      { ...shared }
    ];
    const request: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    const capturedRawIds: string[] = [];

    await __testOnlySyncExtractedBatch(db, request, makePlan("2026-07-08T02:00:00.000Z"), records, async (_tx, _records, rawIds) => {
      capturedRawIds.push(...rawIds);
    });

    // Only two distinct raw rows inserted (the dupe collapsed on its natural key).
    const rawCount = await db.query<{ count: string }>(
      "select count(*)::text as count from raw_records where source_id = $1",
      [sourceId]
    );
    expect(rawCount[0]?.count).toBe("2");

    // But EVERY record got a rawId, and the two dupes share the SAME id.
    expect(capturedRawIds).toHaveLength(3);
    expect(capturedRawIds[0]).toBe(capturedRawIds[2]);
    expect(capturedRawIds[1]).not.toBe(capturedRawIds[0]);
  });

  it("on a TRANSIENT chunk failure: earlier chunks stay committed, batch/run/sync_errors marked failed, streak increments, source NOT parked (stays connected), and it rethrows", async () => {
    const workspaceId = "ws_chunk_fail";
    const sourceId = "src_chunk_fail";
    await seedSource(workspaceId, sourceId);

    const records = makeRecords(600, "fail"); // chunk 1 = 500, chunk 2 = 100
    const request: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    const boom = new Error("writeTruth exploded in chunk 2"); // generic Error => retryable => transient

    await expect(
      __testOnlySyncExtractedBatch(db, request, makePlan("2026-07-08T03:00:00.000Z"), records, async (_tx, chunk) => {
        // Fail only when the SECOND chunk (which starts at fail_ext_500) is written.
        if (chunk.some((r) => r.externalId === "fail_ext_500")) {
          throw boom;
        }
      })
    ).rejects.toThrow("writeTruth exploded in chunk 2");

    // Chunk 1 committed (500 rows); chunk 2 rolled back (its 100 rows gone).
    const rawCount = await db.query<{ count: string }>(
      "select count(*)::text as count from raw_records where source_id = $1",
      [sourceId]
    );
    expect(rawCount[0]?.count).toBe("500");

    // Failure is durably observable (the old single-tx rollback left nothing behind).
    const batch = await db.query<{ status: string }>(
      "select status from sync_batches where source_id = $1",
      [sourceId]
    );
    expect(batch[0]?.status).toBe("failed");

    const run = await db.query<{ status: string; error: string | null }>(
      "select status, error from sync_runs where id = $1",
      [request.syncRunId]
    );
    expect(run[0]?.status).toBe("failed");
    expect(run[0]?.error).toContain("writeTruth exploded");

    // A load-phase failure is now ALSO recorded in sync_errors (equally loud as plan/extract).
    const errs = await db.query<{ error_code: string; retryable: boolean }>(
      "select error_code, retryable from sync_errors where sync_run_id = $1",
      [request.syncRunId]
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]?.retryable).toBe(true);

    // PROPORTIONATE: a single transient hiccup does NOT park a valid source. The streak advances
    // to 1 (below threshold 3), and the source is restored to `connected` — in rotation, will
    // retry next tick — NOT left stranded at `syncing`, NOT flipped to `error`.
    const source = await db.query<{ status: string; consecutive_sync_failures: number }>(
      "select status, consecutive_sync_failures from sources where id = $1",
      [sourceId]
    );
    expect(source[0]?.status).toBe("connected");
    expect(Number(source[0]?.consecutive_sync_failures)).toBe(1);
  });

  it("a TRANSIENT chunk failure that crosses the streak threshold DOES park the source", async () => {
    const workspaceId = "ws_chunk_park";
    const sourceId = "src_chunk_park";
    await seedSource(workspaceId, sourceId);
    // Two independent transient failures already accrued (gate open: no prior counted timestamp).
    await db.query(
      "update sources set consecutive_sync_failures = 2, last_counted_sync_failure_at = null where id = $1",
      [sourceId]
    );

    const records = makeRecords(10, "park");
    const request: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };

    await expect(
      __testOnlySyncExtractedBatch(db, request, makePlan("2026-07-08T04:00:00.000Z"), records, async () => {
        throw new Error("transient chunk boom"); // retryable => transient
      })
    ).rejects.toThrow("transient chunk boom");

    // Third counted transient failure → path is genuinely dead → parked as `error`.
    const source = await db.query<{ status: string; consecutive_sync_failures: number }>(
      "select status, consecutive_sync_failures from sources where id = $1",
      [sourceId]
    );
    expect(source[0]?.status).toBe("error");
    expect(Number(source[0]?.consecutive_sync_failures)).toBe(3);
  });

  it("a TERMINAL chunk failure (auth rejection) parks immediately on the first failure", async () => {
    const workspaceId = "ws_chunk_terminal";
    const sourceId = "src_chunk_terminal";
    await seedSource(workspaceId, sourceId);

    const records = makeRecords(10, "term");
    const request: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };

    await expect(
      __testOnlySyncExtractedBatch(db, request, makePlan("2026-07-08T05:00:00.000Z"), records, async () => {
        // A Meta auth rejection surfaced during the write — OAuthException + terminal code 190 in
        // the message classifies as terminal, so it parks without waiting for the streak.
        throw new Error('load failed: {"error":{"type":"OAuthException","code":190,"message":"expired"}}');
      })
    ).rejects.toThrow(/OAuthException/);

    const source = await db.query<{ status: string }>("select status from sources where id = $1", [sourceId]);
    expect(source[0]?.status).toBe("error");
  });

  // The single safety property that makes WINDOWED backfill robust: many bounded [since, until]
  // windows can land OUT OF ORDER (or a window run can be retried) without ever regressing the
  // cursor. Proven against real PGlite because the monotonic guard lives in the SQL (greatest()),
  // which the mock-db text assertions cannot execute.
  it("out-of-order / retried windows never regress the cursor (monotonic greatest())", async () => {
    const workspaceId = "ws_chunk_monotonic";
    const sourceId = "src_chunk_monotonic";
    await seedSource(workspaceId, sourceId);

    async function readCursor(): Promise<string | undefined> {
      const rows = await db.query<{ cursor_value: string }>(
        "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'test_cursor'",
        [sourceId]
      );
      return rows[0]?.cursor_value;
    }

    const laterCursor = "2026-07-08T00:00:00.000Z";
    const earlierCursor = "2026-06-01T00:00:00.000Z";
    const evenLaterCursor = "2026-08-01T00:00:00.000Z";

    // 1. A LATER window lands first → cursor advances to it.
    const reqLater: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    await __testOnlySyncExtractedBatch(db, reqLater, makePlan(laterCursor), makeRecords(3, "win_later"), async () => {});
    expect(await readCursor()).toBe(laterCursor);

    // 2. An EARLIER window lands out of order → greatest() keeps the later value (NO regression).
    const reqEarlier: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    await __testOnlySyncExtractedBatch(db, reqEarlier, makePlan(earlierCursor), makeRecords(3, "win_earlier"), async () => {});
    expect(await readCursor()).toBe(laterCursor);

    // 3. But BOTH windows' rows persisted — forward progress, not silent zero-progress.
    const rawCount = await db.query<{ count: string }>(
      "select count(*)::text as count from raw_records where source_id = $1",
      [sourceId]
    );
    expect(rawCount[0]?.count).toBe("6");

    // 4. Monotonic, not frozen: an EVEN-LATER window still advances the cursor.
    const reqEvenLater: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    await __testOnlySyncExtractedBatch(db, reqEvenLater, makePlan(evenLaterCursor), makeRecords(2, "win_even_later"), async () => {});
    expect(await readCursor()).toBe(evenLaterCursor);

    // 5. Re-running the earlier window (a retry) is still a no-op on the cursor.
    const reqRetry: SyncRequest = { workspaceId, sourceId, provider: "posthog", syncRunId: `run_${randomUUID()}` };
    await __testOnlySyncExtractedBatch(db, reqRetry, makePlan(earlierCursor), makeRecords(3, "win_earlier"), async () => {});
    expect(await readCursor()).toBe(evenLaterCursor);
  });
});

// ── GA4 snapshot replacement against real PGlite ────────────────────────────────────────────────
//
// The defect this proves fixed (verified in prod 2026-08-18): the GA4 rolling-window re-pull was
// UPSERT-ONLY, so when Google restated a day's attribution — the same conversions moving from
// "(not set)"/"Unassigned" keys to resolved "(direct)"/"Direct" keys — the obsolete rows stayed
// and every windowed total double-counted (overview said 10 key_events where GA and the page fact
// both said 6). The connector now deletes, at successful CLOSE, fact rows inside the refreshed
// window whose keys the fresh provider snapshot no longer contains — and NEVER prunes from a
// report that returned zero rows (fail closed) or from a run that failed before CLOSE.
describe("GA4 snapshot replacement against real PGlite", () => {
  const GA4_TEST_KEY = "ga4-snapshot-replacement-pglite-test-key";
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-ga4-replacement-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedGa4Source(workspaceId: string, sourceId: string): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'web'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1, $2, $3, 'google_analytics_4', 'conn', $1, 'connected')`,
      [sourceId, workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into connection_credentials
        (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'oauth_access_token',$4)`,
      [
        `cred_${randomUUID()}`,
        workspaceId,
        sourceId,
        encryptCredentialPayload(
          { mode: "live", propertyId: "properties/123", accessToken: "ga4-token", apiBaseUrl: "https://ga4.test" },
          GA4_TEST_KEY
        )
      ]
    );
  }

  interface Ga4MockRow {
    dimensionValues: Array<{ value: string }>;
    metricValues: Array<{ value: string }>;
  }

  // Positional fixtures matching the connector's request field orders.
  function overviewRow(date: string, utmSource: string, channel: string, keyEvents: number, sessions: number): Ga4MockRow {
    return {
      dimensionValues: [
        { value: date.replaceAll("-", "") },
        { value: "United Kingdom" },
        { value: "/" },
        { value: utmSource },
        { value: utmSource === "(not set)" ? "(not set)" : "(none)" },
        { value: "(not set)" },
        { value: channel },
        { value: "infinite.fast" },
        { value: "desktop" }
      ],
      metricValues: [
        { value: String(sessions) },
        { value: String(sessions) },
        { value: String(sessions) },
        { value: "0" },
        { value: String(sessions * 2) },
        { value: String(sessions) },
        { value: "1" },
        { value: "60" },
        { value: String(keyEvents) }
      ]
    };
  }

  function pageRow(date: string, path: string, keyEvents: number): Ga4MockRow {
    return {
      dimensionValues: [
        { value: date.replaceAll("-", "") },
        { value: "infinite.fast" },
        { value: path },
        { value: "Title" }
      ],
      metricValues: [
        { value: "10" },
        { value: "5" },
        { value: "4" },
        { value: "60" },
        { value: String(keyEvents) }
      ]
    };
  }

  function eventRow(date: string, eventName: string, eventCount: number, keyEvents: number): Ga4MockRow {
    return {
      dimensionValues: [
        { value: date.replaceAll("-", "") },
        { value: "infinite.fast" },
        { value: eventName }
      ],
      metricValues: [
        { value: String(eventCount) },
        { value: String(keyEvents) }
      ]
    };
  }

  interface Ga4MockReports {
    overview: Ga4MockRow[];
    page: Ga4MockRow[];
    event: Ga4MockRow[];
  }

  async function withGa4Fetch<T>(reports: Ga4MockReports, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { dimensions?: Array<{ name: string }> })
        : null;
      const dims = (body?.dimensions ?? []).map((entry) => entry.name);
      let rows: Ga4MockRow[] = [];
      if (dims.includes("pagePath")) {
        rows = reports.page;
      } else if (dims.includes("eventName")) {
        rows = reports.event;
      } else if (dims.includes("landingPagePlusQueryString")) {
        rows = reports.overview;
      }
      // (single `date` dim = the testConnection probe → empty rows.)
      return new Response(
        JSON.stringify({ rows, metadata: { timeZone: "Europe/London", currencyCode: "GBP" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function ga4Request(workspaceId: string, sourceId: string, window?: { since: string; until: string }): SyncRequest {
    return {
      workspaceId,
      sourceId,
      provider: "google_analytics_4",
      syncRunId: `run_${randomUUID()}`,
      encryptionKey: GA4_TEST_KEY,
      ...(window ? { windowSince: window.since, windowUntil: window.until } : {})
    };
  }

  async function factState(sourceId: string): Promise<{
    overview: Array<{ reporting_date: string | Date; utm_source: string; key_events: number }>;
    pages: Array<{ reporting_date: string | Date; page_path: string; key_events: number }>;
    events: Array<{ reporting_date: string | Date; event_name: string; event_count: number; key_events: number }>;
  }> {
    const overview = await db.query<{ reporting_date: string | Date; utm_source: string; key_events: number }>(
      `select reporting_date, utm_source, key_events from ga4_report_snapshot_fact
        where source_id = $1 order by reporting_date, utm_source`,
      [sourceId]
    );
    const pages = await db.query<{ reporting_date: string | Date; page_path: string; key_events: number }>(
      `select reporting_date, page_path, key_events from ga4_page_report_fact
        where source_id = $1 order by reporting_date, page_path`,
      [sourceId]
    );
    const events = await db.query<{ reporting_date: string | Date; event_name: string; event_count: number; key_events: number }>(
      `select reporting_date, event_name, event_count, key_events from ga4_event_report_fact
        where source_id = $1 order by reporting_date, event_name`,
      [sourceId]
    );
    return { overview, pages, events };
  }

  function dateOnly(value: string | Date): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }

  it("prunes restated '(not set)' keys the later snapshot omits — across all three fact tables", async () => {
    const workspaceId = "ws_ga4_replacement";
    const sourceId = "src_ga4_replacement";
    await seedGa4Source(workspaceId, sourceId);
    const window = { since: "2026-08-04T00:00:00.000Z", until: "2026-08-13T00:00:00.000Z" };

    // Sync 1 — the pre-restatement snapshot: conversions attributed to "(not set)"/"Unassigned",
    // plus a page and an event row that will later disappear from the provider snapshot.
    await withGa4Fetch(
      {
        overview: [
          overviewRow("2026-08-11", "(not set)", "Unassigned", 1, 1),
          overviewRow("2026-08-12", "(not set)", "Unassigned", 3, 3)
        ],
        page: [
          pageRow("2026-08-11", "/", 1),
          pageRow("2026-08-12", "/", 3),
          pageRow("2026-08-12", "/old-page", 0)
        ],
        event: [
          eventRow("2026-08-11", "download_click", 2, 1),
          eventRow("2026-08-12", "download_click", 3, 3),
          eventRow("2026-08-12", "ghost_event", 1, 0)
        ]
      },
      () => connectorFor("google_analytics_4").sync(db, ga4Request(workspaceId, sourceId, window))
    );

    const afterFirst = await factState(sourceId);
    expect(afterFirst.overview).toHaveLength(2);
    expect(afterFirst.pages).toHaveLength(3);
    expect(afterFirst.events).toHaveLength(3);

    // Sync 2 — the restated snapshot: the SAME conversions now under "(direct)"/"Direct"; the
    // "(not set)" keys, /old-page, and ghost_event are gone from the provider response.
    await withGa4Fetch(
      {
        overview: [
          overviewRow("2026-08-11", "(direct)", "Direct", 1, 1),
          overviewRow("2026-08-12", "(direct)", "Direct", 3, 3)
        ],
        page: [
          pageRow("2026-08-11", "/", 1),
          pageRow("2026-08-12", "/", 3)
        ],
        event: [
          eventRow("2026-08-11", "download_click", 2, 1),
          eventRow("2026-08-12", "download_click", 3, 3)
        ]
      },
      () => connectorFor("google_analytics_4").sync(db, ga4Request(workspaceId, sourceId, window))
    );

    const afterSecond = await factState(sourceId);
    // The obsolete keys are GONE — no double count. The window totals now reconcile: 1 + 3.
    expect(
      afterSecond.overview.map((row) => [dateOnly(row.reporting_date), row.utm_source, row.key_events])
    ).toEqual([
      ["2026-08-11", "(direct)", 1],
      ["2026-08-12", "(direct)", 3]
    ]);
    expect(afterSecond.pages.map((row) => row.page_path)).toEqual(["/", "/"]);
    expect(afterSecond.events.map((row) => row.event_name)).toEqual(["download_click", "download_click"]);
    const overviewTotal = afterSecond.overview.reduce((sum, row) => sum + row.key_events, 0);
    const pageTotal = afterSecond.pages.reduce((sum, row) => sum + row.key_events, 0);
    const eventTotal = afterSecond.events.reduce((sum, row) => sum + row.key_events, 0);
    expect(overviewTotal).toBe(4);
    expect(pageTotal).toBe(4);
    expect(eventTotal).toBe(4);

    // Provider metadata persisted at CLOSE: the property time zone and the data-through date.
    const sourceMeta = await db.query<{
      provider_time_zone: string | null;
      provider_data_through_date: string | Date | null;
    }>(
      "select provider_time_zone, provider_data_through_date from sources where id = $1",
      [sourceId]
    );
    expect(sourceMeta[0]?.provider_time_zone).toBe("Europe/London");
    expect(dateOnly(sourceMeta[0]?.provider_data_through_date ?? "")).toBe("2026-08-12");

    // Sync 3 — FAIL CLOSED: the provider returns zero rows for the same historical window (an
    // empty response is indistinguishable from a provider fault). Nothing is pruned.
    await withGa4Fetch(
      { overview: [], page: [], event: [] },
      () => connectorFor("google_analytics_4").sync(db, ga4Request(workspaceId, sourceId, window))
    );
    const afterEmpty = await factState(sourceId);
    expect(afterEmpty.overview).toHaveLength(2);
    expect(afterEmpty.pages).toHaveLength(2);
    expect(afterEmpty.events).toHaveLength(2);
  });

  it("prunes on the steady-state (rolling 'today' window) path too", async () => {
    // The heartbeat lane: no request window → GA is asked for [daysAgo(N), 'today'] and the prune
    // bound resolves the keyword. Dates are RELATIVE to now so this holds regardless of the clock.
    const workspaceId = "ws_ga4_steady_replacement";
    const sourceId = "src_ga4_steady_replacement";
    await seedGa4Source(workspaceId, sourceId);
    const dayString = (daysBack: number) =>
      new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const restatedDay = dayString(2);

    await withGa4Fetch(
      {
        overview: [
          overviewRow(restatedDay, "(not set)", "Unassigned", 2, 2),
          overviewRow(restatedDay, "google", "Organic Search", 1, 4)
        ],
        page: [pageRow(restatedDay, "/", 3)],
        event: [eventRow(restatedDay, "download_click", 3, 3)]
      },
      () => connectorFor("google_analytics_4").sync(db, ga4Request(workspaceId, sourceId))
    );
    expect((await factState(sourceId)).overview).toHaveLength(2);

    await withGa4Fetch(
      {
        overview: [
          overviewRow(restatedDay, "(direct)", "Direct", 2, 2),
          overviewRow(restatedDay, "google", "Organic Search", 1, 4)
        ],
        page: [pageRow(restatedDay, "/", 3)],
        event: [eventRow(restatedDay, "download_click", 3, 3)]
      },
      () => connectorFor("google_analytics_4").sync(db, ga4Request(workspaceId, sourceId))
    );

    const after = await factState(sourceId);
    expect(after.overview.map((row) => row.utm_source).sort()).toEqual(["(direct)", "google"]);
    expect(after.overview.reduce((sum, row) => sum + row.key_events, 0)).toBe(3);
  });

  it("lands event-name facts and serves them through queryable.vw_site_events", async () => {
    const workspaceId = "ws_ga4_event_grain";
    const sourceId = "src_ga4_event_grain";
    await seedGa4Source(workspaceId, sourceId);
    const window = { since: "2026-08-10T00:00:00.000Z", until: "2026-08-13T00:00:00.000Z" };

    await withGa4Fetch(
      {
        overview: [overviewRow("2026-08-12", "(direct)", "Direct", 6, 6)],
        page: [pageRow("2026-08-12", "/", 6)],
        event: [
          eventRow("2026-08-12", "download_click", 9, 4),
          eventRow("2026-08-12", "purchase", 2, 2),
          // A dev-host row: the view must exclude it while the fact table keeps it.
          {
            dimensionValues: [{ value: "20260812" }, { value: "localhost" }, { value: "download_click" }],
            metricValues: [{ value: "7" }, { value: "7" }]
          }
        ]
      },
      () => connectorFor("google_analytics_4").sync(db, ga4Request(workspaceId, sourceId, window))
    );

    const facts = await db.query<{ event_name: string; host_name: string; event_count: number; key_events: number }>(
      `select event_name, host_name, event_count, key_events from ga4_event_report_fact
        where source_id = $1 order by host_name, event_name`,
      [sourceId]
    );
    expect(facts).toEqual([
      { event_name: "download_click", host_name: "infinite.fast", event_count: 9, key_events: 4 },
      { event_name: "purchase", host_name: "infinite.fast", event_count: 2, key_events: 2 },
      { event_name: "download_click", host_name: "localhost", event_count: 7, key_events: 7 }
    ]);

    // The view: aliased measure columns (metric id == view column), dev hosts excluded, so a
    // per-event key-events read ("downloads only") exists even with a second key event configured.
    const viewRows = await db.query<{ event_name: string; site_event_count: number; site_key_events: number }>(
      `select event_name, site_event_count, site_key_events from queryable.vw_site_events
        where workspace_id = $1 order by event_name`,
      [workspaceId]
    );
    expect(viewRows).toEqual([
      { event_name: "download_click", site_event_count: 9, site_key_events: 4 },
      { event_name: "purchase", site_event_count: 2, site_key_events: 2 }
    ]);
  });
});

describe("PostHog CLOSE hook refreshes the day-grain rollups against real PGlite (0063)", () => {
  const POSTHOG_TEST_KEY = "posthog-rollup-pglite-test-key";
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-posthog-rollups-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  // A FIXTURE PostHog source: the connector's fixture lane runs the whole OPEN/LOAD/CLOSE pipeline
  // through createConnector, so the closeSuccess hook fires exactly as it does for a live sync.
  async function seedFixturePosthogSource(workspaceId: string, sourceId: string): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'web'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1, $2, $3, 'posthog', 'conn', $1, 'connected')`,
      [sourceId, workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into connection_credentials
        (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'fixture',$4)`,
      [
        `cred_${randomUUID()}`,
        workspaceId,
        sourceId,
        encryptCredentialPayload({ mode: "fixture" }, POSTHOG_TEST_KEY)
      ]
    );
  }

  function posthogRequest(
    workspaceId: string,
    sourceId: string,
    window?: { since: string; until: string }
  ): SyncRequest {
    return {
      workspaceId,
      sourceId,
      provider: "posthog",
      syncRunId: `run_${randomUUID()}`,
      encryptionKey: POSTHOG_TEST_KEY,
      ...(window ? { windowSince: window.since, windowUntil: window.until } : {})
    };
  }

  async function rollupRows(sourceId: string): Promise<Array<{ occurred_on: string; event_name: string; event_count: string }>> {
    return db.query<{ occurred_on: string; event_name: string; event_count: string }>(
      `select occurred_on::text as occurred_on, event_name, event_count::text as event_count
         from posthog_event_daily where source_id = $1 order by occurred_on, event_name`,
      [sourceId]
    );
  }

  async function viewTotal(workspaceId: string): Promise<string> {
    const rows = await db.query<{ n: string }>(
      `select coalesce(sum(posthog_event_count), 0)::text as n
         from queryable.vw_posthog_events where workspace_id = $1`,
      [workspaceId]
    );
    return rows[0]?.n ?? "0";
  }

  it("a successful sync lands the rollup for the synced source and the view serves it; a re-sync never duplicates the grain", async () => {
    const workspaceId = "ws_ph_rollup_close";
    const sourceId = "src_ph_rollup_close";
    await seedFixturePosthogSource(workspaceId, sourceId);

    // First sync: no stored cursor → the hook rolls up everything the source has (from 2000-01-01).
    await connectorFor("posthog").sync(db, posthogRequest(workspaceId, sourceId));

    // The fixture is two non-internal `signup` events on 2026-06-01 and 2026-06-02 (distinct
    // landing/utm grains) — one rollup row per day, view total = 2.
    expect(await rollupRows(sourceId)).toEqual([
      { occurred_on: "2026-06-01", event_name: "signup", event_count: "1" },
      { occurred_on: "2026-06-02", event_name: "signup", event_count: "1" }
    ]);
    expect(await viewTotal(workspaceId)).toBe("2");
    const truthCount = await db.query<{ n: string }>(
      "select count(*)::text as n from posthog_event_truth where source_id = $1",
      [sourceId]
    );
    expect(truthCount[0]?.n).toBe("2");

    // Second sync over an OVERLAPPING window that covers both fixture days (a plain incremental
    // re-sync would refresh only [stored cursor, now] and never touch June — vacuous): the same
    // fixture rows upsert into truth, the refresh deletes and re-derives both days, and the rollup
    // keeps exactly one row per grain — no doubling, no drift.
    await connectorFor("posthog").sync(
      db,
      posthogRequest(workspaceId, sourceId, {
        since: "2026-06-01T00:00:00.000Z",
        until: "2026-06-30T00:00:00.000Z"
      })
    );
    expect(await rollupRows(sourceId)).toEqual([
      { occurred_on: "2026-06-01", event_name: "signup", event_count: "1" },
      { occurred_on: "2026-06-02", event_name: "signup", event_count: "1" }
    ]);
    expect(await viewTotal(workspaceId)).toBe("2");
  });

  it("a windowed (backfill child) sync refreshes exactly its [since, until] days", async () => {
    const workspaceId = "ws_ph_rollup_window";
    const sourceId = "src_ph_rollup_window";
    await seedFixturePosthogSource(workspaceId, sourceId);

    // The window covers ONLY 2026-06-01: the 06-02 fixture row lands in truth (the extraction is
    // not upper-bounded) but its day is outside this run's window, so it is NOT rolled up here —
    // a later run whose window covers it will. Unrolled ≠ fabricated: the view is simply short.
    await connectorFor("posthog").sync(
      db,
      posthogRequest(workspaceId, sourceId, {
        since: "2026-06-01T00:00:00.000Z",
        until: "2026-06-01T23:59:59.000Z"
      })
    );
    expect(await rollupRows(sourceId)).toEqual([
      { occurred_on: "2026-06-01", event_name: "signup", event_count: "1" }
    ]);
    expect(await viewTotal(workspaceId)).toBe("1");

    // The next window picks the remaining day up.
    await connectorFor("posthog").sync(
      db,
      posthogRequest(workspaceId, sourceId, {
        since: "2026-06-02T00:00:00.000Z",
        until: "2026-06-03T00:00:00.000Z"
      })
    );
    expect(await rollupRows(sourceId)).toEqual([
      { occurred_on: "2026-06-01", event_name: "signup", event_count: "1" },
      { occurred_on: "2026-06-02", event_name: "signup", event_count: "1" }
    ]);
    expect(await viewTotal(workspaceId)).toBe("2");
  });

  it("the refresh is transactional with CLOSE: a later CLOSE statement failing leaves NO rollup rows", async () => {
    const workspaceId = "ws_ph_rollup_rollback";
    const sourceId = "src_ph_rollup_rollback";
    await seedFixturePosthogSource(workspaceId, sourceId);
    const until = "2026-07-01T00:00:00.000Z";

    // Make the CLOSE transaction's cursor advance (which runs AFTER closeSuccess) fail: the refresh
    // already ran inside the same transaction, so it must roll back with it.
    await db.query(
      `alter table sync_cursors add constraint posthog_close_rollback_test
       check (cursor_value <> '${until}')`
    );
    try {
      await expect(
        connectorFor("posthog").sync(
          db,
          posthogRequest(workspaceId, sourceId, { since: "2026-01-01T00:00:00.000Z", until })
        )
      ).rejects.toThrow();
    } finally {
      await db.query("alter table sync_cursors drop constraint posthog_close_rollback_test");
    }

    // LOAD committed the truth rows (documented per-chunk semantics) ...
    const truthCount = await db.query<{ n: string }>(
      "select count(*)::text as n from posthog_event_truth where source_id = $1",
      [sourceId]
    );
    expect(truthCount[0]?.n).toBe("2");
    // ... but the rollup — part of the failed CLOSE — has nothing from this run, and the run is failed.
    expect(await rollupRows(sourceId)).toEqual([]);
    expect(await viewTotal(workspaceId)).toBe("0");
    const runs = await db.query<{ status: string }>(
      "select status from sync_runs where source_id = $1",
      [sourceId]
    );
    expect(runs).toEqual([{ status: "failed" }]);
  });
});
