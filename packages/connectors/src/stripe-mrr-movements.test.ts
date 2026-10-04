import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import {
  classifyStripeCustomerMrrObservation,
  StripeMrrCloseClaimLostError,
  writeStripeMrrMovementsAtClose,
  type StripeCustomerMrrObservationInput,
} from "./stripe-mrr-movements.js";

const OBSERVED_AT = "2026-08-04T12:00:00.000Z";

function observation(
  over: Partial<StripeCustomerMrrObservationInput> = {},
): StripeCustomerMrrObservationInput {
  return {
    workspaceId: "ws_1",
    sourceId: "src_1",
    customerId: "cus_1",
    observedAt: OBSERVED_AT,
    businessEligible: true,
    previous: [],
    current: [{
      currency: "usd",
      amountMinor: "5000",
      evidenceHash: "current-usd-5000",
      effectiveEndAt: null,
      zeroTransitionAuthority: "value_change",
    }],
    bootstrap: [{
      currency: "usd",
      firstPositivePaidAt: "2026-07-10T09:00:00.000Z",
      earliestPositiveLinkedToCurrentContribution: true,
      invoiceReconciliationComplete: true,
      hadPriorPositivePayment: true,
    }],
    ...over,
  };
}

describe("Stripe customer MRR movement algebra", () => {
  it("bootstraps one complete linked $50 customer as one provenance-qualified new fact", () => {
    const result = classifyStripeCustomerMrrObservation(observation());

    expect(result).toMatchObject({
      unavailableReason: null,
      facts: [{
        kind: "new",
        currency: "usd",
        fromAmountMinor: "0",
        toAmountMinor: "5000",
        deltaAmountMinor: "5000",
        effectiveAt: "2026-07-10T09:00:00.000Z",
        observedAt: OBSERVED_AT,
        provenance: "linked_paid_invoice_current_complete_v1",
        businessEligibleAtEvent: true,
      }],
      nextStates: [{ currency: "usd", amountMinor: "5000", hasEverPositive: true }],
    });
    expect(result.facts[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("aggregates two subscriptions before classification, yielding one customer new total", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      current: [{
        currency: "usd",
        amountMinor: "8000",
        evidenceHash: "sorted-sub-a-3000-sub-b-5000",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
    }));

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ kind: "new", toAmountMinor: "8000" });
  });

  it.each([
    { from: "5000", to: "7500", kind: "expansion", delta: "2500" },
    { from: "8000", to: "5000", kind: "contraction", delta: "-3000" },
  ] as const)("classifies $kind for an exact positive delta", ({ from, to, kind, delta }) => {
    const result = classifyStripeCustomerMrrObservation(observation({
      previous: [{
        currency: "usd",
        amountMinor: from,
        evidenceHash: `prior-${from}`,
        hasEverPositive: true,
      }],
      current: [{
        currency: "usd",
        amountMinor: to,
        evidenceHash: `current-${to}`,
        effectiveEndAt: kind === "contraction" ? "2026-08-04T10:00:00.000Z" : null,
        zeroTransitionAuthority: kind === "contraction" ? "service_end" : "value_change",
      }],
      bootstrap: [],
    }));

    expect(result.facts).toEqual([
      expect.objectContaining({ kind, fromAmountMinor: from, toAmountMinor: to, deltaAmountMinor: delta }),
    ]);
  });

  it("dates final churn at actual non-future service end, never cancellation request time", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      previous: [{
        currency: "usd",
        amountMinor: "5000",
        evidenceHash: "prior-positive",
        hasEverPositive: true,
      }],
      current: [{
        currency: "usd",
        amountMinor: "0",
        evidenceHash: "terminal-ended",
        effectiveEndAt: "2026-08-03T23:00:00.000Z",
        zeroTransitionAuthority: "service_end",
      }],
      bootstrap: [],
    }));

    expect(result.facts).toEqual([
      expect.objectContaining({
        kind: "churn",
        fromAmountMinor: "5000",
        toAmountMinor: "0",
        deltaAmountMinor: "-5000",
        effectiveAt: "2026-08-03T23:00:00.000Z",
      }),
    ]);
  });

  it("does not churn an active scheduled cancellation and defers an unproven terminal end", () => {
    const scheduled = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "same", hasEverPositive: true }],
      current: [{
        currency: "usd",
        amountMinor: "5000",
        evidenceHash: "same",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
      bootstrap: [],
    }));
    expect(scheduled.facts).toEqual([]);

    const unproven = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "prior", hasEverPositive: true }],
      current: [{
        currency: "usd",
        amountMinor: "0",
        evidenceHash: "terminal-no-end",
        effectiveEndAt: null,
        zeroTransitionAuthority: "service_end",
      }],
      bootstrap: [],
    }));
    // DEFERRED, not unavailable: an unpaid/paused customer must never blank the workspace.
    expect(unproven).toMatchObject({
      unavailableReason: null,
      deferredReason: "pending_proven_service_end",
      facts: [],
    });
    expect(unproven.nextStates).toEqual(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "prior", hasEverPositive: true }],
    }).previous);
  });

  it("defers, never churns, a customer whose future-dated period end cannot yet prove service end", () => {
    const deferred = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "prior", hasEverPositive: true }],
      current: [{
        currency: "usd",
        amountMinor: "0",
        // Stripe `unpaid`: no end recorded, and the current period runs past the observation.
        effectiveEndAt: null,
        evidenceHash: "unpaid-future-period-end",
        zeroTransitionAuthority: "service_end",
      }],
      bootstrap: [],
    }));
    expect(deferred).toMatchObject({
      facts: [],
      unavailableReason: null,
      deferredReason: "pending_proven_service_end",
    });

    // A later close, once the end is provable, lands the churn AT the proven service end — a date
    // that falls in an already-reported past window. That revision is intentional.
    const proven = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "prior", hasEverPositive: true }],
      current: [{
        currency: "usd",
        amountMinor: "0",
        effectiveEndAt: "2026-08-01T00:00:00.000Z",
        evidenceHash: "unpaid-period-end-passed",
        zeroTransitionAuthority: "service_end",
      }],
      bootstrap: [],
    }));
    expect(proven.deferredReason).toBeNull();
    expect(proven.facts).toEqual([
      expect.objectContaining({
        kind: "churn",
        fromAmountMinor: "5000",
        toAmountMinor: "0",
        effectiveAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    expect(proven.nextStates).toEqual([
      expect.objectContaining({ currency: "usd", amountMinor: "0", hasEverPositive: true }),
    ]);
  });

  it("defers a whole multi-currency customer rather than half-classifying it", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      previous: [
        { currency: "gbp", amountMinor: "4000", evidenceHash: "gbp-prior", hasEverPositive: true },
        { currency: "usd", amountMinor: "5000", evidenceHash: "usd-prior", hasEverPositive: true },
      ],
      current: [
        {
          currency: "gbp", amountMinor: "6000", evidenceHash: "gbp-expanded", effectiveEndAt: null,
          zeroTransitionAuthority: "value_change",
        },
        {
          currency: "usd", amountMinor: "0", evidenceHash: "usd-unpaid", effectiveEndAt: null,
          zeroTransitionAuthority: "service_end",
        },
      ],
      bootstrap: [],
    }));

    expect(result.facts).toEqual([]);
    expect(result.deferredReason).toBe("pending_proven_service_end");
    // The gbp expansion is not lost: state is carried forward, so the next close re-derives it.
    expect(result.nextStates).toEqual([
      { currency: "gbp", amountMinor: "4000", evidenceHash: "gbp-prior", hasEverPositive: true },
      { currency: "usd", amountMinor: "5000", evidenceHash: "usd-prior", hasEverPositive: true },
    ]);
  });

  it("never treats a missing current currency grain as proof of zero/churn", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      previous: [{
        currency: "usd",
        amountMinor: "5000",
        evidenceHash: "last-complete-positive",
        hasEverPositive: true,
      }],
      current: [],
      bootstrap: [],
    }));

    expect(result).toMatchObject({
      unavailableReason: null,
      deferredReason: "pending_proven_service_end",
      facts: [],
    });
    expect(result.nextStates).toEqual([
      {
        currency: "usd",
        amountMinor: "5000",
        evidenceHash: "last-complete-positive",
        hasEverPositive: true,
      },
    ]);
  });

  it("keeps the unobserved-zero evidence hash stable across repeated closes", () => {
    const unobserved = (evidenceHash: string) => classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "0", evidenceHash, hasEverPositive: true }],
      current: [],
      bootstrap: [],
    }));

    const first = unobserved("observed-zero");
    const second = unobserved(first.nextStates[0]?.evidenceHash ?? "");
    const third = unobserved(second.nextStates[0]?.evidenceHash ?? "");

    expect(first.nextStates[0]?.evidenceHash).toBe("unobserved-zero:observed-zero");
    expect(second.nextStates[0]?.evidenceHash).toBe("unobserved-zero:observed-zero");
    expect(third.nextStates).toEqual(second.nextStates);
    expect(first.facts).toEqual([]);
    expect(second.facts).toEqual([]);

    // A reactivation off a long-unobserved zero keeps ONE idempotency key, not a fresh one
    // per close, because the carried previous hash stopped mutating.
    const reactivation = (previousEvidenceHash: string) => classifyStripeCustomerMrrObservation(observation({
      previous: [{
        currency: "usd", amountMinor: "0", evidenceHash: previousEvidenceHash, hasEverPositive: true,
      }],
      current: [{
        currency: "usd", amountMinor: "5000", evidenceHash: "back-again", effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
      bootstrap: [],
    }));
    expect(reactivation(second.nextStates[0]?.evidenceHash ?? "").facts[0]?.idempotencyKey)
      .toBe(reactivation(third.nextStates[0]?.evidenceHash ?? "").facts[0]?.idempotencyKey);
  });

  it("classifies prior positive -> zero -> positive as churn then reactivation, including 100% discounts", () => {
    const zero = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "prior", hasEverPositive: true }],
      current: [{
        currency: "usd",
        amountMinor: "0",
        evidenceHash: "discount-100",
        effectiveEndAt: OBSERVED_AT,
        zeroTransitionAuthority: "value_change",
      }],
      bootstrap: [],
    }));
    expect(zero.facts[0]).toMatchObject({ kind: "churn", deltaAmountMinor: "-5000" });

    const positive = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "0", evidenceHash: "discount-100", hasEverPositive: true }],
      current: [{
        currency: "usd",
        amountMinor: "5000",
        evidenceHash: "discount-removed",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
      bootstrap: [],
    }));
    expect(positive.facts[0]).toMatchObject({ kind: "reactivation", deltaAmountMinor: "5000" });
  });

  it("persists explicit zero and prior-positive knowledge without inventing bootstrap movement", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      current: [{
        currency: "usd",
        amountMinor: "0",
        evidenceHash: "zero-now",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
      bootstrap: [{
        currency: "usd",
        firstPositivePaidAt: "2026-06-01T00:00:00.000Z",
        earliestPositiveLinkedToCurrentContribution: false,
        invoiceReconciliationComplete: true,
        hadPriorPositivePayment: true,
      }],
    }));

    expect(result.facts).toEqual([]);
    expect(result.nextStates).toEqual([
      expect.objectContaining({ currency: "usd", amountMinor: "0", hasEverPositive: true }),
    ]);
  });

  it("does not call a current subscription new when the earliest payment belongs to an older subscription", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      bootstrap: [{
        currency: "usd",
        firstPositivePaidAt: "2026-07-10T09:00:00.000Z",
        // The current subscription has a later payment, but the customer's earliest positive
        // invoice is linked to an older subscription. Zero-between is not proven.
        earliestPositiveLinkedToCurrentContribution: false,
        invoiceReconciliationComplete: true,
        hadPriorPositivePayment: true,
      }],
    }));

    expect(result.facts).toEqual([]);
    expect(result.coverageStartedAt).toBe(OBSERVED_AT);
    expect(result.nextStates[0]).toMatchObject({ amountMinor: "5000", hasEverPositive: true });
  });

  it("fails closed for same-observation USD -> GBP instead of emitting churn plus acquisition", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "usd-prior", hasEverPositive: true }],
      current: [{
        currency: "gbp",
        amountMinor: "4000",
        evidenceHash: "gbp-now",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
      bootstrap: [],
    }));

    expect(result).toMatchObject({ unavailableReason: "currency_switch_unclassified", facts: [] });
    expect(result.nextStates).toEqual(observation({
      previous: [{ currency: "usd", amountMinor: "5000", evidenceHash: "usd-prior", hasEverPositive: true }],
    }).previous);
  });

  it("keeps genuine simultaneous USD and GBP grains separate", () => {
    const result = classifyStripeCustomerMrrObservation(observation({
      current: [
        {
          currency: "gbp", amountMinor: "4000", evidenceHash: "gbp", effectiveEndAt: null,
          zeroTransitionAuthority: "value_change",
        },
        {
          currency: "usd", amountMinor: "5000", evidenceHash: "usd", effectiveEndAt: null,
          zeroTransitionAuthority: "value_change",
        },
      ],
      bootstrap: [
        {
          currency: "gbp",
          firstPositivePaidAt: "2026-07-11T00:00:00.000Z",
          earliestPositiveLinkedToCurrentContribution: true,
          invoiceReconciliationComplete: true,
          hadPriorPositivePayment: true,
        },
        {
          currency: "usd",
          firstPositivePaidAt: "2026-07-10T00:00:00.000Z",
          earliestPositiveLinkedToCurrentContribution: true,
          invoiceReconciliationComplete: true,
          hadPriorPositivePayment: true,
        },
      ],
    }));

    expect(result.unavailableReason).toBeNull();
    expect(result.facts.map((fact) => [fact.currency, fact.kind, fact.toAmountMinor])).toEqual([
      ["gbp", "new", "4000"],
      ["usd", "new", "5000"],
    ]);
  });

  it("is deterministic across replay and isolates workspace/source/customer scope", () => {
    const first = classifyStripeCustomerMrrObservation(observation());
    const replay = classifyStripeCustomerMrrObservation(observation());
    const otherSource = classifyStripeCustomerMrrObservation(observation({ sourceId: "src_2" }));
    const internal = classifyStripeCustomerMrrObservation(observation({ businessEligible: false }));

    expect(replay.facts[0]?.idempotencyKey).toBe(first.facts[0]?.idempotencyKey);
    expect(otherSource.facts[0]?.idempotencyKey).not.toBe(first.facts[0]?.idempotencyKey);
    expect(internal.facts[0]).toMatchObject({ businessEligibleAtEvent: false });
  });

  it("canonicalizes fractional minor-unit MRR before subtraction and idempotency hashing", () => {
    const first = classifyStripeCustomerMrrObservation(observation({
      current: [{
        currency: "usd",
        amountMinor: "83.333333333333333333",
        evidenceHash: "annual-price",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
    }));
    const replay = classifyStripeCustomerMrrObservation(observation({
      current: [{
        currency: "usd",
        amountMinor: "83.3333333333334",
        evidenceHash: "annual-price",
        effectiveEndAt: null,
        zeroTransitionAuthority: "value_change",
      }],
    }));

    expect(first.facts[0]).toMatchObject({
      fromAmountMinor: "0",
      toAmountMinor: "83.333333333333",
      deltaAmountMinor: "83.333333333333",
    });
    expect(replay.facts[0]?.idempotencyKey).toBe(first.facts[0]?.idempotencyKey);
  });
});

// End-to-end proof of the CLOSE writer against a REAL (WASM Postgres) PGlite data dir. The
// classifier unit tests above cannot see what the connector actually WRITES: the coverage row,
// the durable state rows, or the SQL gates in migration 0056.
describe("Stripe MRR movement CLOSE against real PGlite", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-stripe-mrr-close-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
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

  async function seedPaidCustomer(
    workspaceId: string,
    sourceId: string,
    customerId: string,
    options: { discountsComplete?: boolean } = {},
  ): Promise<void> {
    await db.query(
      `insert into stripe_customers (
         id, workspace_id, source_id, stripe_customer_id, metrics_classification, created_at_source
       ) values ($1,$2,$3,$4,null,now() - interval '90 days')`,
      [`cusrow_${randomUUID()}`, workspaceId, sourceId, customerId],
    );
    await db.query(
      `insert into stripe_subscriptions (
         id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
         current_period_start, current_period_end, created_at_source,
         items_sync_complete, discounts_sync_complete
       ) values ($1,$2,$3,$4,$5,'active',
                 now() - interval '5 days', now() + interval '25 days',
                 now() - interval '90 days', true, $6)`,
      [
        `subrow_${randomUUID()}`,
        workspaceId,
        sourceId,
        `sub_${customerId}`,
        customerId,
        options.discountsComplete ?? true,
      ],
    );
    await db.query(
      `insert into stripe_subscription_items (
         id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
         currency, unit_amount, quantity, recurring_interval, recurring_interval_count,
         recurring_usage_type, billing_scheme, custom_unit_amount, pricing_state,
         default_currency, default_unit_amount, price_currency_options, currency_option_resolved
       ) values ($1,$2,$3,$4,$5,'usd',5000,1,'month',1,'licensed','per_unit',false,
                 'licensed_per_unit','usd',5000,'{}'::jsonb,true)`,
      [`sirow_${randomUUID()}`, workspaceId, sourceId, `si_${customerId}`, `sub_${customerId}`],
    );
  }

  async function runClose(
    workspaceId: string,
    sourceId: string,
    options: { ownedRun?: boolean } = {},
  ): Promise<void> {
    const syncRunId = `run_${randomUUID()}`;
    await db.query(
      "insert into sync_runs (id, workspace_id, source_id, status) values ($1,$2,$3,$4)",
      [syncRunId, workspaceId, sourceId, options.ownedRun === false ? "failed" : "running"],
    );
    await db.withTransaction(async (tx) => {
      await writeStripeMrrMovementsAtClose(tx, { workspaceId, sourceId, syncRunId });
    });
    await db.query(
      "update sync_runs set status = 'succeeded', finished_at = now() where id = $1",
      [syncRunId],
    );
  }

  function readCoverage(workspaceId: string, sourceId: string) {
    return db.query<{
      incomplete_business_customer_count: number;
      pending_service_end_customer_count: number;
      incomplete_reasons: string[];
      last_complete_data_as_of: string | Date | null;
    }>(
      `select incomplete_business_customer_count, pending_service_end_customer_count,
              incomplete_reasons, last_complete_data_as_of
         from stripe_mrr_movement_coverage
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
  }

  function readWorkspaceCoverage(workspaceId: string) {
    return db.query<{
      forward_coverage_started_at: string | Date | null;
      data_as_of: string | Date | null;
      incomplete_business_customer_count: string;
      pending_service_end_customer_count: string;
    }>(
      `select forward_coverage_started_at, data_as_of,
              incomplete_business_customer_count::text,
              pending_service_end_customer_count::text
         from queryable.vw_stripe_mrr_movement_coverage
        where workspace_id = $1`,
      [workspaceId],
    );
  }

  function readMovements(workspaceId: string, sourceId: string) {
    return db.query<{
      movement_kind: string;
      from_amount_minor: string;
      to_amount_minor: string;
      effective_at: string | Date;
    }>(
      `select movement_kind, from_amount_minor::text, to_amount_minor::text, effective_at
         from stripe_customer_mrr_movements
        where workspace_id = $1 and source_id = $2
        order by effective_at`,
      [workspaceId, sourceId],
    );
  }

  function readStates(workspaceId: string, sourceId: string) {
    return db.query<{ currency: string; monthly_amount_minor: string }>(
      `select currency, monthly_amount_minor::text
         from stripe_customer_mrr_states
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
  }

  it("defers an unpaid customer instead of blanking the workspace, then churns at the proven end", async () => {
    const workspaceId = "ws_mrr_close_unpaid";
    const sourceId = "src_mrr_close_unpaid";
    await seedStripeSource(workspaceId, sourceId);
    await seedPaidCustomer(workspaceId, sourceId, "cus_unpaid");

    await runClose(workspaceId, sourceId);
    expect(await readStates(workspaceId, sourceId)).toEqual([
      expect.objectContaining({ currency: "usd" }),
    ]);
    expect(Number((await readStates(workspaceId, sourceId))[0]?.monthly_amount_minor)).toBe(5000);

    // Stripe `unpaid`: the subscription stops billing but keeps a FUTURE period end and records
    // no service end. Before the fix this poisoned coverage for the entire workspace.
    await db.query(
      "update stripe_subscriptions set status = 'unpaid' where source_id = $1",
      [sourceId],
    );
    await runClose(workspaceId, sourceId);

    expect(await readMovements(workspaceId, sourceId)).toEqual([]);
    expect(Number((await readStates(workspaceId, sourceId))[0]?.monthly_amount_minor)).toBe(5000);
    const deferredCoverage = await readCoverage(workspaceId, sourceId);
    expect(deferredCoverage[0]).toMatchObject({
      incomplete_business_customer_count: 0,
      pending_service_end_customer_count: 1,
      incomplete_reasons: [],
    });
    expect(deferredCoverage[0]?.last_complete_data_as_of).not.toBeNull();
    const deferredWorkspace = await readWorkspaceCoverage(workspaceId);
    expect(deferredWorkspace[0]?.forward_coverage_started_at).not.toBeNull();
    expect(deferredWorkspace[0]?.data_as_of).not.toBeNull();
    expect(deferredWorkspace[0]).toMatchObject({
      incomplete_business_customer_count: "0",
      pending_service_end_customer_count: "1",
    });

    // Once the period end passes, the end is PROVEN and the churn lands dated at it — a date in
    // an already-reported past window. That revision is intentional.
    await db.query(
      `update stripe_subscriptions
          set current_period_end = now() - interval '2 days'
        where source_id = $1`,
      [sourceId],
    );
    const provenEnd = await db.query<{ current_period_end: string | Date }>(
      "select current_period_end from stripe_subscriptions where source_id = $1",
      [sourceId],
    );
    await runClose(workspaceId, sourceId);

    const churned = await readMovements(workspaceId, sourceId);
    expect(churned).toHaveLength(1);
    expect(churned[0]?.movement_kind).toBe("churn");
    expect(Number(churned[0]?.from_amount_minor)).toBe(5000);
    expect(Number(churned[0]?.to_amount_minor)).toBe(0);
    expect(new Date(churned[0]?.effective_at ?? 0).toISOString())
      .toBe(new Date(provenEnd[0]?.current_period_end ?? 0).toISOString());
    expect(Number((await readStates(workspaceId, sourceId))[0]?.monthly_amount_minor)).toBe(0);
    expect((await readCoverage(workspaceId, sourceId))[0]).toMatchObject({
      incomplete_business_customer_count: 0,
      pending_service_end_customer_count: 0,
    });
  }, 120_000);

  it("treats a paused subscription as neither active value nor a proven end", async () => {
    const workspaceId = "ws_mrr_close_paused";
    const sourceId = "src_mrr_close_paused";
    await seedStripeSource(workspaceId, sourceId);
    await seedPaidCustomer(workspaceId, sourceId, "cus_paused");
    await runClose(workspaceId, sourceId);

    await db.query(
      "update stripe_subscriptions set status = 'paused' where source_id = $1",
      [sourceId],
    );
    await runClose(workspaceId, sourceId);

    expect(await readMovements(workspaceId, sourceId)).toEqual([]);
    // Not active: contributes no value. Not terminal: proves no end. So the last complete state
    // is carried forward untouched and the customer is merely pending.
    expect(Number((await readStates(workspaceId, sourceId))[0]?.monthly_amount_minor)).toBe(5000);
    expect((await readCoverage(workspaceId, sourceId))[0]).toMatchObject({
      incomplete_business_customer_count: 0,
      pending_service_end_customer_count: 1,
    });
    const workspaceCoverage = await readWorkspaceCoverage(workspaceId);
    expect(workspaceCoverage[0]?.data_as_of).not.toBeNull();
  }, 120_000);

  it("still fails coverage closed for a genuinely incomplete business customer", async () => {
    const workspaceId = "ws_mrr_close_incomplete";
    const sourceId = "src_mrr_close_incomplete";
    await seedStripeSource(workspaceId, sourceId);
    // discounts_sync_complete = false => value_state 'list_only': the ACTIVE recurring value is
    // unknown, which is real incompleteness, not a deferred story.
    await seedPaidCustomer(workspaceId, sourceId, "cus_incomplete", { discountsComplete: false });
    await runClose(workspaceId, sourceId);

    const coverage = await readCoverage(workspaceId, sourceId);
    expect(coverage[0]?.incomplete_business_customer_count).toBe(1);
    expect(coverage[0]?.pending_service_end_customer_count).toBe(0);
    expect(coverage[0]?.incomplete_reasons).toContain("discounts_sync_incomplete");
    expect(coverage[0]?.last_complete_data_as_of).toBeNull();
    const workspaceCoverage = await readWorkspaceCoverage(workspaceId);
    expect(workspaceCoverage[0]?.data_as_of).toBeNull();
    expect(workspaceCoverage[0]?.forward_coverage_started_at).toBeNull();
  }, 120_000);

  it("refuses to write immutable facts from a run that no longer owns the source", async () => {
    const workspaceId = "ws_mrr_close_superseded";
    const sourceId = "src_mrr_close_superseded";
    await seedStripeSource(workspaceId, sourceId);
    await seedPaidCustomer(workspaceId, sourceId, "cus_superseded");

    await expect(runClose(workspaceId, sourceId, { ownedRun: false }))
      .rejects.toBeInstanceOf(StripeMrrCloseClaimLostError);
    expect(await readCoverage(workspaceId, sourceId)).toEqual([]);
    expect(await readStates(workspaceId, sourceId)).toEqual([]);
    expect(await readMovements(workspaceId, sourceId)).toEqual([]);

    // The legitimate owner still writes.
    await runClose(workspaceId, sourceId);
    expect(await readStates(workspaceId, sourceId)).toHaveLength(1);
  }, 120_000);

  it("nulls the lifecycle new/churn counts when a source's movement coverage is not trustworthy", async () => {
    const workspaceId = "ws_mrr_lifecycle_gate";
    const sourceId = "src_mrr_lifecycle_gate";
    await seedStripeSource(workspaceId, sourceId);
    await db.query(
      `insert into stripe_customers (
         id, workspace_id, source_id, stripe_customer_id, metrics_classification
       ) values ($1,$2,$3,'cus_gate',null)`,
      [`cusrow_${randomUUID()}`, workspaceId, sourceId],
    );
    await db.query(
      `insert into stripe_customer_mrr_movements (
         id, workspace_id, source_id, stripe_customer_id, currency, movement_kind,
         from_amount_minor, to_amount_minor, delta_amount_minor, effective_at, observed_at,
         previous_evidence_hash, current_evidence_hash, provenance,
         business_eligible_at_event, classifier_version, idempotency_key
       ) values
         ($1,$2,$3,'cus_gate','usd','new',0,5000,5000,
          '2026-08-01T10:00:00Z','2026-08-01T10:00:00Z','zero','usd',
          'forward_observed_v1',true,'v1',$4),
         ($5,$2,$3,'cus_gate','usd','churn',5000,0,-5000,
          '2026-08-02T10:00:00Z','2026-08-02T10:00:00Z','usd','zero',
          'forward_observed_v1',true,'v1',$6)`,
      [
        `mov_${randomUUID()}`, workspaceId, sourceId, `key_new_${randomUUID()}`,
        `mov_${randomUUID()}`, `key_churn_${randomUUID()}`,
      ],
    );

    const lifecycle = () => db.query<{ metric_kind: string; new_paid: string | null; churned: string | null }>(
      `select metric_kind,
              sum(stripe_new_paid_subscribers)::text as new_paid,
              sum(stripe_churned_subscribers)::text as churned
         from queryable.vw_stripe_subscription_lifecycle
        where workspace_id = $1 and metric_kind in ('new_paid_subscribers','churned_subscribers')
        group by metric_kind
        order by metric_kind`,
      [workspaceId],
    );

    // No coverage row at all: the counts can only be an undercount, so they must read NULL.
    expect(await lifecycle()).toEqual([
      { metric_kind: "churned_subscribers", new_paid: "0", churned: null },
      { metric_kind: "new_paid_subscribers", new_paid: null, churned: "0" },
    ]);

    await db.query(
      `insert into stripe_mrr_movement_coverage (
         id, workspace_id, source_id, forward_coverage_started_at,
         last_attempted_data_as_of, last_complete_data_as_of,
         incomplete_business_customer_count, pending_service_end_customer_count,
         classifier_version
       ) values ($1,$2,$3,'2026-07-01T00:00:00Z','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z',
                 1,0,'v1')`,
      [`cov_${randomUUID()}`, workspaceId, sourceId],
    );
    expect(await lifecycle()).toEqual([
      { metric_kind: "churned_subscribers", new_paid: "0", churned: null },
      { metric_kind: "new_paid_subscribers", new_paid: null, churned: "0" },
    ]);

    // Complete coverage: the counts are trustworthy. A pending (deferred) customer does NOT gate.
    await db.query(
      `update stripe_mrr_movement_coverage
          set incomplete_business_customer_count = 0, pending_service_end_customer_count = 3
        where source_id = $1`,
      [sourceId],
    );
    expect(await lifecycle()).toEqual([
      { metric_kind: "churned_subscribers", new_paid: "0", churned: "1" },
      { metric_kind: "new_paid_subscribers", new_paid: "1", churned: "0" },
    ]);
  }, 120_000);
});
