import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import {
  applyReconciliation,
  computeReconciliationPlan,
  readStripeReconciliationWatermarks,
  reconciliationDue,
  StripeReconciliationClaimLostError,
  STRIPE_RECONCILIATION_INTERVAL_MS,
  stripeDiscountExternalId,
  stripeRemotePricesFromSubscriptions,
  type StripeReconcileRemoteInvoice,
  type StripeReconcileRemoteSubscription,
  type StripeReconcileRemoteSubscriptionItem,
  type StripeReconciliationOutcome,
  type StripeReconciliationPlan,
  type StripeReconciliationRemoteState,
} from "./stripe-reconcile.js";

// ---------------------------------------------------------------------------
// Scheduling (pure).
// ---------------------------------------------------------------------------

const NOW = "2026-08-04T12:00:00.000Z";

describe("Stripe reconciliation scheduling", () => {
  it("is due when a source has never been reconciled", () => {
    expect(reconciliationDue(null, NOW)).toEqual({
      due: true,
      reason: "never_reconciled",
      intervalMs: STRIPE_RECONCILIATION_INTERVAL_MS,
    });
    expect(reconciliationDue({ reconciledAt: null }, NOW).reason).toBe("never_reconciled");
  });

  it("holds inside the daily interval and fires once it has elapsed", () => {
    expect(reconciliationDue({ reconciledAt: "2026-08-04T10:00:00.000Z" }, NOW)).toEqual({
      due: false,
      reason: null,
      intervalMs: STRIPE_RECONCILIATION_INTERVAL_MS,
    });
    expect(reconciliationDue({ reconciledAt: "2026-08-03T11:00:00.000Z" }, NOW).reason)
      .toBe("interval_elapsed");
    // Exactly at the boundary counts as elapsed.
    expect(reconciliationDue({ reconciledAt: "2026-08-03T12:00:00.000Z" }, NOW).due).toBe(true);
  });

  it("relaxes to weekly purely by widening the interval (the drift-telemetry gate)", () => {
    const weekly = 7 * 24 * 60 * 60 * 1000;
    expect(reconciliationDue(
      { reconciledAt: "2026-08-03T11:00:00.000Z" },
      NOW,
      { intervalMs: weekly },
    )).toEqual({ due: false, reason: null, intervalMs: weekly });
    expect(reconciliationDue(
      { reconciledAt: "2026-07-26T11:00:00.000Z" },
      NOW,
      { intervalMs: weekly },
    ).reason).toBe("interval_elapsed");
  });

  it("fires immediately on each documented trigger, with a deterministic precedence", () => {
    const fresh = { reconciledAt: "2026-08-04T11:00:00.000Z" };
    expect(reconciliationDue(fresh, NOW, { triggers: { retentionCoverageGap: true } }).reason)
      .toBe("retention_coverage_gap");
    expect(reconciliationDue(fresh, NOW, { triggers: { credentialOutageRecovered: true } }).reason)
      .toBe("credential_outage_recovery");
    expect(reconciliationDue(fresh, NOW, { triggers: { apiVersionChanged: true } }).reason)
      .toBe("api_version_change");
    expect(reconciliationDue(fresh, NOW, { triggers: { invariantFailure: true } }).reason)
      .toBe("invariant_failure");
    // Precedence is fixed so the recorded reason never depends on evaluation order.
    expect(reconciliationDue(fresh, NOW, {
      triggers: {
        invariantFailure: true,
        retentionCoverageGap: true,
        apiVersionChanged: true,
        credentialOutageRecovered: true,
      },
    }).reason).toBe("invariant_failure");
  });

  it("throws on unusable inputs instead of silently defaulting", () => {
    expect(() => reconciliationDue({ reconciledAt: NOW }, "not-a-date")).toThrow(/unparseable/);
    expect(() => reconciliationDue({ reconciledAt: "nope" }, NOW)).toThrow(/unparseable/);
    expect(() => reconciliationDue({ reconciledAt: NOW }, NOW, { intervalMs: 0 }))
      .toThrow(/invalid Stripe reconciliation interval/);
  });
});

// ---------------------------------------------------------------------------
// Remote fixtures.
// ---------------------------------------------------------------------------

function remoteItem(
  over: Partial<StripeReconcileRemoteSubscriptionItem> = {},
): StripeReconcileRemoteSubscriptionItem {
  return {
    itemId: "si_1",
    priceId: "price_1",
    productId: "prod_1",
    currency: "usd",
    unitAmount: 5000,
    defaultCurrency: "usd",
    defaultUnitAmount: 5000,
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
    pricingState: "complete",
    discounts: [],
    ...over,
  };
}

function remoteSubscription(
  over: Partial<StripeReconcileRemoteSubscription> = {},
): StripeReconcileRemoteSubscription {
  return {
    subscriptionId: "sub_1",
    customerId: "cus_1",
    liveMode: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    trialStart: null,
    trialEnd: null,
    cancelAt: null,
    canceledAt: null,
    endedAt: null,
    itemsSynced: true,
    discountsSynced: true,
    items: [remoteItem()],
    discounts: [],
    ...over,
  };
}

function remoteInvoice(
  over: Partial<StripeReconcileRemoteInvoice> = {},
): StripeReconcileRemoteInvoice {
  return {
    invoiceId: "in_1",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    subscriptionOrigin: "subscription",
    status: "paid",
    currency: "usd",
    amountPaid: 5000,
    amountDue: 5000,
    postPaymentCreditedMinor: 0,
    prePaymentCreditedMinor: 0,
    paidAt: "2026-08-01T00:05:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    externalOrderId: null,
    ...over,
  };
}

function remoteState(
  over: {
    subscriptions?: StripeReconcileRemoteSubscription[];
    invoices?: StripeReconcileRemoteInvoice[];
    customerIds?: string[];
    listComplete?: Partial<Record<"customers" | "subscriptions" | "invoices", boolean>>;
  } = {},
): StripeReconciliationRemoteState {
  const subscriptions = over.subscriptions ?? [remoteSubscription()];
  const invoices = over.invoices ?? [remoteInvoice()];
  const customerIds = over.customerIds ?? ["cus_1"];
  return {
    customers: {
      rows: customerIds.map((customerId) => ({
        customerId,
        email: `${customerId}@example.com`,
        name: "Acme",
        metricsClassification: null,
        metadataAuthoritative: true,
      })),
      listComplete: over.listComplete?.customers ?? true,
    },
    subscriptions: {
      rows: subscriptions,
      listComplete: over.listComplete?.subscriptions ?? true,
    },
    invoices: {
      rows: invoices,
      listComplete: over.listComplete?.invoices ?? true,
    },
    prices: stripeRemotePricesFromSubscriptions(subscriptions),
  };
}

describe("Stripe remote price derivation", () => {
  it("derives prices from subscription items but never claims list completeness", () => {
    const derived = stripeRemotePricesFromSubscriptions([
      remoteSubscription({ items: [remoteItem(), remoteItem({ itemId: "si_2" })] }),
      remoteSubscription({
        subscriptionId: "sub_2",
        items: [remoteItem({ itemId: "si_3", priceId: "price_2", defaultUnitAmount: 900 })],
      }),
    ]);
    // A price absent from a DERIVED set is unreferenced, not deleted — deletion is not evaluable.
    expect(derived.listComplete).toBe(false);
    expect(derived.rows.map((row) => row.priceId)).toEqual(["price_1", "price_2"]);
    expect(derived.rows[1]?.unitAmount).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// Real PGlite: plan → apply → drift rows → watermarks → health view.
// ---------------------------------------------------------------------------

interface DriftRow {
  entity_kind: string;
  object_external_id: string;
  drift_kind: string;
  repaired: boolean;
  detail: Record<string, unknown> | null;
  run_started_at: string | Date;
}

describe("Stripe reconciliation against a real PGlite engine DB", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-stripe-reconcile-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
    // 0058 (lane B) owns `stripe_sync_watermarks`; 0059 (this lane) owns the drift table + health
    // view and its view body joins the watermarks. Prove both landed rather than discovering it
    // through a confusing downstream failure.
    const tables = await db.query<{ name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('stripe_sync_watermarks', 'stripe_reconciliation_drift')
        order by table_name`,
    );
    expect(tables.map((row) => row.name))
      .toEqual(["stripe_reconciliation_drift", "stripe_sync_watermarks"]);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedStripeSource(workspaceId: string, sourceId: string): Promise<void> {
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
  }

  async function reconcile(
    workspaceId: string,
    sourceId: string,
    remote: StripeReconciliationRemoteState,
    runStartedAt: string,
    options: { ownedRun?: boolean } = {},
  ): Promise<{ plan: StripeReconciliationPlan; outcome: StripeReconciliationOutcome }> {
    const syncRunId = `run_${randomUUID()}`;
    await db.query(
      "insert into sync_runs (id, workspace_id, source_id, status) values ($1,$2,$3,$4)",
      [syncRunId, workspaceId, sourceId, options.ownedRun === false ? "failed" : "running"],
    );
    const scope = { workspaceId, sourceId, runStartedAt };
    const result = await db.withTransaction(async (tx) => {
      const plan = await computeReconciliationPlan(tx, scope, remote);
      const outcome = await applyReconciliation(tx, plan, { ...scope, syncRunId });
      return { plan, outcome };
    });
    await db.query(
      "update sync_runs set status = 'succeeded', finished_at = now() where id = $1",
      [syncRunId],
    );
    return result;
  }

  function readDrift(workspaceId: string, sourceId: string, runStartedAt?: string) {
    return db.query<DriftRow>(
      `select entity_kind, object_external_id, drift_kind, repaired, detail, run_started_at
         from stripe_reconciliation_drift
        where workspace_id = $1 and source_id = $2
          and ($3::timestamptz is null or run_started_at = $3::timestamptz)
        order by entity_kind, object_external_id, drift_kind`,
      [workspaceId, sourceId, runStartedAt ?? null],
    );
  }

  function readWatermarks(workspaceId: string, sourceId: string) {
    return db.one<{ reconciled_at: string | Date | null; last_drift_at: string | Date | null }>(
      `select reconciled_at, last_drift_at from stripe_sync_watermarks
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
  }

  it("bootstraps every missing local row, then reports ZERO drift against the same remote set", async () => {
    const ws = "ws_recon_bootstrap";
    const src = "src_recon_bootstrap";
    await seedStripeSource(ws, src);

    const first = await reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z");
    expect(first.outcome.countsByKind).toEqual({
      missing_local: 5, // customer + subscription + price + subscription_item + invoice
      missing_remote: 0,
      state_mismatch: 0,
    });
    expect(first.outcome.repairedCount).toBe(5);
    expect(first.outcome.recordedOnlyCount).toBe(0);
    expect(first.outcome.driftDetected).toBe(true);

    const bootstrapDrift = await readDrift(ws, src, "2026-08-01T00:00:00.000Z");
    expect(bootstrapDrift.map((row) => [row.entity_kind, row.object_external_id, row.drift_kind]))
      .toEqual([
        ["customer", "cus_1", "missing_local"],
        ["invoice", "in_1", "missing_local"],
        ["price", "price_1", "missing_local"],
        ["subscription", "sub_1", "missing_local"],
        ["subscription_item", "si_1", "missing_local"],
      ]);
    expect(bootstrapDrift.every((row) => row.repaired)).toBe(true);

    const subscription = await db.one<{ status: string; livemode: boolean }>(
      `select status, livemode from stripe_subscriptions
        where workspace_id = $1 and source_id = $2 and stripe_subscription_id = 'sub_1'`,
      [ws, src],
    );
    expect(subscription).toMatchObject({ status: "active", livemode: true });
    const invoice = await db.one<{ amount_paid: string | number }>(
      `select amount_paid from stripe_invoices
        where workspace_id = $1 and source_id = $2 and stripe_invoice_id = 'in_1'`,
      [ws, src],
    );
    expect(String(invoice?.amount_paid)).toBe("5000");

    // THE self-drift proof: what the reconciler wrote must be exactly what it next expects to see.
    const second = await reconcile(ws, src, remoteState(), "2026-08-02T00:00:00.000Z");
    expect(second.plan.differences).toEqual([]);
    expect(second.outcome).toMatchObject({
      driftCount: 0,
      driftDetected: false,
      reconciledAt: "2026-08-02T00:00:00.000Z",
    });
    expect(await readDrift(ws, src, "2026-08-02T00:00:00.000Z")).toEqual([]);
  }, 120_000);

  it("records and repairs a state mismatch with the exact differing field names", async () => {
    const ws = "ws_recon_mismatch";
    const src = "src_recon_mismatch";
    await seedStripeSource(ws, src);
    await reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z");

    // Remote truth moved: the subscription cancelled and the item's quantity doubled. The delta
    // lane missing this is exactly the failure reconciliation exists to expose.
    const drifted = remoteState({
      subscriptions: [remoteSubscription({
        status: "canceled",
        canceledAt: "2026-08-03T10:00:00.000Z",
        endedAt: "2026-08-03T10:00:00.000Z",
        items: [remoteItem({ quantity: 2 })],
      })],
    });
    const run = await reconcile(ws, src, drifted, "2026-08-04T00:00:00.000Z");

    expect(run.outcome.countsByKind).toEqual({
      missing_local: 0,
      missing_remote: 0,
      state_mismatch: 2,
    });
    const rows = await readDrift(ws, src, "2026-08-04T00:00:00.000Z");
    expect(rows.map((row) => [row.entity_kind, row.object_external_id, row.drift_kind])).toEqual([
      ["subscription", "sub_1", "state_mismatch"],
      ["subscription_item", "si_1", "state_mismatch"],
    ]);
    // `repair: "direct"` — this reconciliation wrote the fix itself. The marker exists so a row
    // healed by a full replacement BEFORE the comparison ran is never mistaken for one nobody
    // repaired (see the drift-measurement seam in stripe-reconcile.ts).
    expect(rows[0]?.detail).toEqual({
      fields: ["canceled_at", "ended_at", "status"], repair: "direct",
    });
    expect(rows[1]?.detail).toEqual({ fields: ["quantity"], repair: "direct" });
    expect(rows.every((row) => row.repaired)).toBe(true);

    const repaired = await db.one<{ status: string; ended_at: string | Date | null }>(
      `select status, ended_at from stripe_subscriptions
        where workspace_id = $1 and source_id = $2 and stripe_subscription_id = 'sub_1'`,
      [ws, src],
    );
    expect(repaired?.status).toBe("canceled");
    expect(new Date(String(repaired?.ended_at)).toISOString()).toBe("2026-08-03T10:00:00.000Z");
    const item = await db.one<{ quantity: string | number }>(
      `select quantity from stripe_subscription_items
        where workspace_id = $1 and source_id = $2 and stripe_subscription_item_id = 'si_1'`,
      [ws, src],
    );
    expect(String(item?.quantity)).toBe("2");
  }, 120_000);

  it("deletes a disappeared CHILD row but only records a disappeared PARENT", async () => {
    const ws = "ws_recon_deletes";
    const src = "src_recon_deletes";
    await seedStripeSource(ws, src);
    const twoItemSub = remoteSubscription({
      items: [remoteItem(), remoteItem({ itemId: "si_2", priceId: "price_2" })],
    });
    await reconcile(
      ws,
      src,
      remoteState({
        subscriptions: [twoItemSub, remoteSubscription({
          subscriptionId: "sub_2",
          customerId: "cus_2",
          items: [remoteItem({ itemId: "si_9", priceId: "price_9" })],
        })],
        customerIds: ["cus_1", "cus_2"],
        invoices: [remoteInvoice(), remoteInvoice({ invoiceId: "in_2", customerId: "cus_2", subscriptionId: "sub_2" })],
      }),
      "2026-08-01T00:00:00.000Z",
    );

    // sub_2 (and its customer + invoice) vanished from Stripe; si_2 was removed from sub_1.
    const shrunk = remoteState({
      subscriptions: [remoteSubscription({ items: [remoteItem()] })],
      customerIds: ["cus_1"],
      invoices: [remoteInvoice()],
    });
    const run = await reconcile(ws, src, shrunk, "2026-08-04T00:00:00.000Z");
    const rows = await readDrift(ws, src, "2026-08-04T00:00:00.000Z");

    expect(rows.map((row) => [row.entity_kind, row.object_external_id, row.repaired])).toEqual([
      ["customer", "cus_2", false],
      ["invoice", "in_2", false],
      ["subscription", "sub_2", false],
      ["subscription_item", "si_2", true],
    ]);
    expect(rows.every((row) => row.drift_kind === "missing_remote")).toBe(true);
    expect(run.outcome).toMatchObject({ repairedCount: 1, recordedOnlyCount: 3 });

    // The child row is gone; the parents survive untouched (a deleted subscription would read as
    // churn at the next CLOSE, so parent deletion is deliberately out of the reconciler's hands).
    const items = await db.query<{ stripe_subscription_item_id: string }>(
      `select stripe_subscription_item_id from stripe_subscription_items
        where workspace_id = $1 and source_id = $2
        order by stripe_subscription_item_id`,
      [ws, src],
    );
    // si_2 is gone (its parent is still present remotely, so its absence IS a delete). si_9 stays:
    // its parent sub_2 vanished, and deleting an orphaned subscription's items would zero the
    // customer's recurring value and mint a contraction/churn fact out of a snapshot.
    expect(items.map((row) => row.stripe_subscription_item_id)).toEqual(["si_1", "si_9"]);
    const survivors = await db.query<{ stripe_subscription_id: string }>(
      `select stripe_subscription_id from stripe_subscriptions
        where workspace_id = $1 and source_id = $2 order by stripe_subscription_id`,
      [ws, src],
    );
    expect(survivors.map((row) => row.stripe_subscription_id)).toEqual(["sub_1", "sub_2"]);

    // A parent price is NEVER reported missing from a derived price set — dereference is not
    // deletion, and reporting it would keep the relax-to-weekly gate permanently red.
    expect(rows.some((row) => row.entity_kind === "price")).toBe(false);
    expect(run.plan.unevaluatedDeletions).toContainEqual({
      entityKind: "price",
      reason: "remote_price_set_not_a_complete_list",
    });
  }, 120_000);

  it("reconciles subscription discounts as replaceable child rows", async () => {
    const ws = "ws_recon_discounts";
    const src = "src_recon_discounts";
    await seedStripeSource(ws, src);
    const discount = {
      discountId: "di_1",
      position: 0,
      amountOff: null,
      percentOff: 20,
      currency: null,
      appliesToProductIds: ["prod_b", "prod_a"],
      amountOffCurrencyOptions: {},
      currencyOptionResolved: true,
      duration: "forever",
      startsAt: "2026-07-01T00:00:00.000Z",
      endsAt: null,
      complete: true,
      incompleteReason: null,
    };
    await reconcile(
      ws,
      src,
      remoteState({ subscriptions: [remoteSubscription({ discounts: [discount] })] }),
      "2026-08-01T00:00:00.000Z",
    );
    const key = stripeDiscountExternalId("sub_1", "subscription", "sub_1", 0);
    const seeded = await readDrift(ws, src, "2026-08-01T00:00:00.000Z");
    expect(seeded.find((row) => row.entity_kind === "discount")?.object_external_id).toBe(key);

    // Reordering the product restriction list is NOT a semantic change; changing the percentage is.
    const reordered = { ...discount, appliesToProductIds: ["prod_a", "prod_b"] };
    const clean = await reconcile(
      ws,
      src,
      remoteState({ subscriptions: [remoteSubscription({ discounts: [reordered] })] }),
      "2026-08-02T00:00:00.000Z",
    );
    expect(clean.plan.differences).toEqual([]);

    const changed = await reconcile(
      ws,
      src,
      remoteState({
        subscriptions: [remoteSubscription({ discounts: [{ ...discount, percentOff: 30 }] })],
      }),
      "2026-08-03T00:00:00.000Z",
    );
    expect(changed.plan.differences).toHaveLength(1);
    expect(changed.plan.differences[0]).toMatchObject({
      entityKind: "discount",
      objectExternalId: key,
      driftKind: "state_mismatch",
      detail: { fields: ["percent_off"] },
    });
    const stored = await db.one<{ percent_off: string | number }>(
      `select percent_off from stripe_subscription_discounts
        where workspace_id = $1 and source_id = $2 and stripe_subscription_id = 'sub_1'`,
      [ws, src],
    );
    expect(Number(stored?.percent_off)).toBe(30);

    // The discount disappearing entirely is a child delete, like the items it lives beside.
    const dropped = await reconcile(
      ws,
      src,
      remoteState({ subscriptions: [remoteSubscription({ discounts: [] })] }),
      "2026-08-04T00:00:00.000Z",
    );
    expect(dropped.plan.differences).toHaveLength(1);
    expect(dropped.plan.differences[0]).toMatchObject({
      entityKind: "discount",
      driftKind: "missing_remote",
    });
    const remaining = await db.query(
      `select 1 from stripe_subscription_discounts where workspace_id = $1 and source_id = $2`,
      [ws, src],
    );
    expect(remaining).toEqual([]);
  }, 120_000);

  it("ignores the documented volatile fields (no drift from provenance or local clocks)", async () => {
    const ws = "ws_recon_volatile";
    const src = "src_recon_volatile";
    await seedStripeSource(ws, src);
    await reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z");

    const rawId = `raw_${randomUUID()}`;
    await db.query(
      `insert into raw_records (
         id, workspace_id, source_id, provider, object_type, external_id, payload, source_record_hash
       ) values ($1,$2,$3,'stripe','stripe_subscription','sub_1','{}'::jsonb,$4)`,
      [rawId, ws, src, randomUUID()],
    );
    // Every one of these is excluded from the semantic hash on purpose:
    //   raw_record_id            — provenance pointer, rewritten by every sync
    //   created_at               — local insert clock
    //   customers.created_at_source — stamped with the invoice/subscription that first OBSERVED
    //                              the customer, so two lanes legitimately disagree
    //   prices.active            — hardcoded true by the writer and never updated on conflict
    await db.query(
      `update stripe_customers
          set raw_record_id = $3, created_at = now() - interval '5 days',
              created_at_source = timestamptz '1999-01-01T00:00:00Z'
        where workspace_id = $1 and source_id = $2`,
      [ws, src, rawId],
    );
    await db.query(
      `update stripe_subscriptions set raw_record_id = $3, created_at = now() - interval '5 days'
        where workspace_id = $1 and source_id = $2`,
      [ws, src, rawId],
    );
    await db.query(
      `update stripe_prices set raw_record_id = $3, active = false
        where workspace_id = $1 and source_id = $2`,
      [ws, src, rawId],
    );
    await db.query(
      `update stripe_invoices set raw_record_id = $3 where workspace_id = $1 and source_id = $2`,
      [ws, src, rawId],
    );

    const run = await reconcile(ws, src, remoteState(), "2026-08-02T00:00:00.000Z");
    expect(run.plan.differences).toEqual([]);
    expect(await readDrift(ws, src, "2026-08-02T00:00:00.000Z")).toEqual([]);
  }, 120_000);

  it("skips an UNOBSERVED customer classification instead of clearing it", async () => {
    const ws = "ws_recon_classification";
    const src = "src_recon_classification";
    await seedStripeSource(ws, src);
    await reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z");
    await db.query(
      `update stripe_customers set metrics_classification = 'internal_test'
        where workspace_id = $1 and source_id = $2`,
      [ws, src],
    );

    // Un-expanded customer: we could not look, so a null must not read as "the tag is gone".
    const unobserved = remoteState();
    unobserved.customers.rows[0]!.metadataAuthoritative = false;
    const held = await reconcile(ws, src, unobserved, "2026-08-02T00:00:00.000Z");
    expect(held.plan.differences).toEqual([]);
    const kept = await db.one<{ metrics_classification: string | null }>(
      `select metrics_classification from stripe_customers
        where workspace_id = $1 and source_id = $2`,
      [ws, src],
    );
    expect(kept?.metrics_classification).toBe("internal_test");

    // Expanded customer with no tag: absence IS the truth, so the stale exclusion is real drift.
    const cleared = await reconcile(ws, src, remoteState(), "2026-08-03T00:00:00.000Z");
    expect(cleared.plan.differences).toHaveLength(1);
    expect(cleared.plan.differences[0]).toMatchObject({
      entityKind: "customer",
      driftKind: "state_mismatch",
      detail: { fields: ["metrics_classification"] },
    });
    const now = await db.one<{ metrics_classification: string | null }>(
      `select metrics_classification from stripe_customers
        where workspace_id = $1 and source_id = $2`,
      [ws, src],
    );
    expect(now?.metrics_classification).toBeNull();
  }, 120_000);

  it("advances reconciled_at on every run but moves last_drift_at only when drift was found", async () => {
    const ws = "ws_recon_watermarks";
    const src = "src_recon_watermarks";
    await seedStripeSource(ws, src);

    // Run 1 — bootstrap drift.
    await reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z");
    const afterDrift = await readWatermarks(ws, src);
    expect(new Date(String(afterDrift?.reconciled_at)).toISOString())
      .toBe("2026-08-01T00:00:00.000Z");
    expect(afterDrift?.last_drift_at).not.toBeNull();
    const firstDriftAt = new Date(String(afterDrift?.last_drift_at)).toISOString();

    // Run 2 — zero drift STILL advances reconciled_at (that is the healthy signal) and leaves
    // last_drift_at exactly where it was; zeroing it would erase the recurrence history.
    await reconcile(ws, src, remoteState(), "2026-08-02T00:00:00.000Z");
    const afterClean = await readWatermarks(ws, src);
    expect(new Date(String(afterClean?.reconciled_at)).toISOString())
      .toBe("2026-08-02T00:00:00.000Z");
    expect(new Date(String(afterClean?.last_drift_at)).toISOString()).toBe(firstDriftAt);

    expect(await readStripeReconciliationWatermarks(db, { workspaceId: ws, sourceId: src }))
      .toEqual({ reconciledAt: "2026-08-02T00:00:00.000Z" });
    // And a source that has never been reconciled still reads as due.
    expect(reconciliationDue(
      { reconciledAt: "2026-08-02T00:00:00.000Z" },
      "2026-08-03T12:00:00.000Z",
    ).reason).toBe("interval_elapsed");
  }, 120_000);

  it("declares deletion UNEVALUABLE rather than inventing deletes from a partial snapshot", async () => {
    const ws = "ws_recon_partial";
    const src = "src_recon_partial";
    await seedStripeSource(ws, src);
    await reconcile(
      ws,
      src,
      remoteState({
        subscriptions: [remoteSubscription({ items: [remoteItem(), remoteItem({ itemId: "si_2" })] })],
      }),
      "2026-08-01T00:00:00.000Z",
    );

    // The item pages did not all succeed, so a "missing" item proves nothing.
    const partial = remoteState({
      subscriptions: [remoteSubscription({ itemsSynced: false, items: [remoteItem()] })],
      listComplete: { customers: false, subscriptions: false, invoices: false },
    });
    const run = await reconcile(ws, src, partial, "2026-08-02T00:00:00.000Z");

    expect(run.plan.differences.filter((diff) => diff.driftKind === "missing_remote")).toEqual([]);
    expect(run.plan.unevaluatedDeletions).toEqual(expect.arrayContaining([
      { entityKind: "customer", reason: "remote_customer_set_not_a_complete_list" },
      { entityKind: "subscription", reason: "remote_subscription_set_not_a_complete_list" },
      { entityKind: "invoice", reason: "remote_invoice_set_not_a_complete_list" },
      { entityKind: "subscription_item", reason: "subscription_item_pages_incomplete", scopeId: "sub_1" },
      {
        entityKind: "discount",
        reason: "subscription_discount_evidence_incomplete",
        scopeId: "sub_1",
      },
    ]));
    const items = await db.query(
      `select 1 from stripe_subscription_items where workspace_id = $1 and source_id = $2`,
      [ws, src],
    );
    expect(items).toHaveLength(2);
  }, 120_000);

  it("aborts without writing when the sync claim moved to another run", async () => {
    const ws = "ws_recon_claim";
    const src = "src_recon_claim";
    await seedStripeSource(ws, src);
    await expect(
      reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z", { ownedRun: false }),
    ).rejects.toBeInstanceOf(StripeReconciliationClaimLostError);

    expect(await readDrift(ws, src)).toEqual([]);
    expect(await readWatermarks(ws, src)).toBeNull();
    const subscriptions = await db.query(
      `select 1 from stripe_subscriptions where workspace_id = $1 and source_id = $2`,
      [ws, src],
    );
    expect(subscriptions).toEqual([]);
  }, 120_000);

  it("serves the drift-telemetry health view the cadence decision reads", async () => {
    const ws = "ws_recon_health";
    const src = "src_recon_health";
    await seedStripeSource(ws, src);

    const readHealth = () => db.one<Record<string, unknown>>(
      "select * from queryable.vw_stripe_reconciliation_health where workspace_id = $1",
      [ws],
    );

    // A connected source that has never been reconciled is NEVER "clean".
    const fresh = await readHealth();
    expect(fresh).toMatchObject({
      connected_source_count: 1,
      reconciled_source_count: 0,
      never_reconciled_source_count: 1,
      reconciliation_status: "never_reconciled",
      drift_7d: 0,
      metric_version: "stripe-reconcile-v1",
    });
    expect(fresh?.reconciled_at).toBeNull();

    await reconcile(ws, src, remoteState(), "2026-08-01T00:00:00.000Z");
    const drifted = await reconcile(
      ws,
      src,
      remoteState({
        subscriptions: [remoteSubscription({ status: "past_due" })],
        customerIds: ["cus_1"],
        invoices: [],
      }),
      "2026-08-02T00:00:00.000Z",
    );
    // in_1 disappeared from a COMPLETE invoice list → recorded, unrepaired.
    expect(drifted.outcome.countsByKind).toEqual({
      missing_local: 0,
      missing_remote: 1,
      state_mismatch: 1,
    });

    const health = await readHealth();
    expect(health).toMatchObject({
      connected_source_count: 1,
      reconciled_source_count: 1,
      never_reconciled_source_count: 0,
      drift_7d: 7,
      drift_30d: 7,
      missing_local_7d: 5,
      missing_remote_7d: 1,
      state_mismatch_7d: 1,
      unrepaired_7d: 1,
      reconciliation_status: "drifting",
    });
    // reconciled_at is the LAGGIEST connected source, and `run_started_at` (not wall-clock) is
    // what the watermark carries, so the view reports the comparison instant.
    expect(new Date(String(health?.reconciled_at)).toISOString()).toBe("2026-08-02T00:00:00.000Z");
    expect(health?.last_drift_at).not.toBeNull();

    // A second connected source with no watermark at all pulls the workspace back to honest.
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       select $1, $2, id, 'stripe', 'Stripe B', $1, 'connected'
         from datasets where workspace_id = $2 and key = 'billing'`,
      ["src_recon_health_b", ws],
    );
    expect(await readHealth()).toMatchObject({
      connected_source_count: 2,
      never_reconciled_source_count: 1,
      reconciliation_status: "never_reconciled",
    });
  }, 120_000);
});
