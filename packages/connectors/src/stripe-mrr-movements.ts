import { createHash } from "node:crypto";
import type { InfiniteOsDb } from "@infinite-os/db";

export const STRIPE_MRR_CLASSIFIER_VERSION = "stripe_customer_mrr_v1";
export const STRIPE_MRR_MINOR_SCALE = 12;
const MINOR_FACTOR = 10n ** BigInt(STRIPE_MRR_MINOR_SCALE);

export type StripeMrrMovementKind =
  | "new"
  | "reactivation"
  | "expansion"
  | "contraction"
  | "churn";

export interface StripeCustomerMrrPreviousState {
  currency: string;
  /** Canonical decimal minor units, rounded half-up to STRIPE_MRR_MINOR_SCALE. */
  amountMinor: string;
  evidenceHash: string;
  hasEverPositive: boolean;
}

export interface StripeCustomerMrrCurrentState {
  currency: string;
  /** Decimal minor units from PostgreSQL numeric; never a JavaScript number. */
  amountMinor: string;
  evidenceHash: string;
  effectiveEndAt: string | null;
  zeroTransitionAuthority: "value_change" | "service_end";
}

export interface StripeCustomerMrrBootstrapEvidence {
  currency: string;
  firstPositivePaidAt: string | null;
  earliestPositiveLinkedToCurrentContribution: boolean;
  invoiceReconciliationComplete: boolean;
  hadPriorPositivePayment: boolean;
}

export interface StripeCustomerMrrObservationInput {
  workspaceId: string;
  sourceId: string;
  customerId: string;
  observedAt: string;
  businessEligible: boolean;
  previous: StripeCustomerMrrPreviousState[];
  current: StripeCustomerMrrCurrentState[];
  bootstrap: StripeCustomerMrrBootstrapEvidence[];
}

export interface StripeCustomerMrrMovementFact {
  kind: StripeMrrMovementKind;
  currency: string;
  fromAmountMinor: string;
  toAmountMinor: string;
  deltaAmountMinor: string;
  effectiveAt: string;
  observedAt: string;
  provenance: "forward_observed_v1" | "linked_paid_invoice_current_complete_v1";
  businessEligibleAtEvent: boolean;
  previousEvidenceHash: string;
  currentEvidenceHash: string;
  idempotencyKey: string;
}

export interface StripeCustomerMrrObservationResult {
  facts: StripeCustomerMrrMovementFact[];
  nextStates: StripeCustomerMrrPreviousState[];
  unavailableReason: "currency_switch_unclassified" | null;
  /**
   * DEFERRED, NOT INCOMPLETE. Churn in this ledger is DEFINED as a proven service end, so a
   * previously-positive customer whose active-set value has dropped to zero without a
   * non-future service-end authority has no movement fact YET — the ledger is still complete
   * with respect to PROVEN facts. Stripe's ordinary `unpaid`/`paused` states sit here for
   * weeks (`ended_at` stays null while the current period end is still in the future), so
   * counting them as incompleteness would NULL `data_as_of` for the entire workspace over one
   * mundane customer. The churn fact lands at the LATER close where the end becomes provable,
   * dated at the actual service end — which may fall in an ALREADY-REPORTED past window.
   */
  deferredReason: "pending_proven_service_end" | null;
  coverageStartedAt: string;
  bootstrapEvidenceFrom: string | null;
}

/**
 * A currency grain that is absent from the current observation is UNOBSERVED, not zero. Its
 * marker hash must be STABLE across closes: re-prefixing every close grew the stored hash
 * without bound (and changed the `previousEvidenceHash` of a later reactivation on every
 * single close, so an unchanged state kept minting fresh idempotency keys).
 */
const UNOBSERVED_ZERO_PREFIX = "unobserved-zero:";

function unobservedZeroEvidenceHash(previousHash: string | undefined, currency: string): string {
  if (previousHash?.startsWith(UNOBSERVED_ZERO_PREFIX)) return previousHash;
  return `${UNOBSERVED_ZERO_PREFIX}${previousHash ?? currency}`;
}

function normalizedCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

/** Parse non-negative decimal minor units and round half-up to the durable 12-place scale. */
function decimalMinorToScaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`invalid non-negative Stripe MRR decimal: ${value}`);
  const whole = BigInt(match[1] ?? "0");
  const fraction = match[2] ?? "";
  const kept = (fraction.slice(0, STRIPE_MRR_MINOR_SCALE) || "0")
    .padEnd(STRIPE_MRR_MINOR_SCALE, "0");
  let scaled = whole * MINOR_FACTOR + BigInt(kept);
  if ((fraction[STRIPE_MRR_MINOR_SCALE] ?? "0") >= "5") scaled += 1n;
  return scaled;
}

function scaledToCanonicalDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MINOR_FACTOR;
  const fraction = (absolute % MINOR_FACTOR).toString().padStart(STRIPE_MRR_MINOR_SCALE, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function canonicalStripeMrrMinor(value: string): string {
  return scaledToCanonicalDecimal(decimalMinorToScaled(value));
}

export function sumCanonicalStripeMrrMinor(values: readonly string[]): string {
  return scaledToCanonicalDecimal(values.reduce(
    (sum, value) => sum + decimalMinorToScaled(value),
    0n,
  ));
}

export function stripeMrrMinorDelta(to: string, from: string): string {
  return scaledToCanonicalDecimal(decimalMinorToScaled(to) - decimalMinorToScaled(from));
}

function validIsoAtOrBefore(value: string | null, ceiling: string): string | null {
  if (!value) return null;
  const valueMs = new Date(value).getTime();
  const ceilingMs = new Date(ceiling).getTime();
  if (!Number.isFinite(valueMs) || !Number.isFinite(ceilingMs) || valueMs > ceilingMs) return null;
  return new Date(valueMs).toISOString();
}

function earliestIso(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function movementIdempotencyKey(input: {
  workspaceId: string;
  sourceId: string;
  customerId: string;
  currency: string;
  kind: StripeMrrMovementKind;
  fromAmountMinor: string;
  toAmountMinor: string;
  effectiveAt: string;
  previousEvidenceHash: string;
  currentEvidenceHash: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    STRIPE_MRR_CLASSIFIER_VERSION,
    STRIPE_MRR_MINOR_SCALE,
    input.workspaceId,
    input.sourceId,
    input.customerId,
    input.currency,
    input.kind,
    input.fromAmountMinor,
    input.toAmountMinor,
    input.effectiveAt,
    input.previousEvidenceHash,
    input.currentEvidenceHash,
  ])).digest("hex");
}

function normalizedPrevious(input: StripeCustomerMrrObservationInput): StripeCustomerMrrPreviousState[] {
  return input.previous
    .map((state) => ({
      ...state,
      currency: normalizedCurrency(state.currency),
      amountMinor: canonicalStripeMrrMinor(state.amountMinor),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export function classifyStripeCustomerMrrObservation(
  input: StripeCustomerMrrObservationInput,
): StripeCustomerMrrObservationResult {
  const previousByCurrency = new Map(normalizedPrevious(input).map((state) => [state.currency, state]));
  const currentByCurrency = new Map(input.current.map((state) => {
    const currency = normalizedCurrency(state.currency);
    return [currency, {
      ...state,
      currency,
      amountMinor: canonicalStripeMrrMinor(state.amountMinor),
    }];
  }));
  const bootstrapByCurrency = new Map(input.bootstrap.map((evidence) => {
    const currency = normalizedCurrency(evidence.currency);
    return [currency, { ...evidence, currency }];
  }));

  const lostPositiveCurrencies = [...previousByCurrency.entries()]
    .filter(([currency, state]) => (
      decimalMinorToScaled(state.amountMinor) > 0n &&
      decimalMinorToScaled(currentByCurrency.get(currency)?.amountMinor ?? "0") === 0n
    ))
    .map(([currency]) => currency);
  const gainedPositiveCurrencies = [...currentByCurrency.entries()]
    .filter(([currency, state]) => (
      decimalMinorToScaled(state.amountMinor) > 0n &&
      decimalMinorToScaled(previousByCurrency.get(currency)?.amountMinor ?? "0") === 0n
    ))
    .map(([currency]) => currency);
  if (lostPositiveCurrencies.length > 0 && gainedPositiveCurrencies.length > 0) {
    return {
      facts: [],
      nextStates: normalizedPrevious(input),
      unavailableReason: "currency_switch_unclassified",
      deferredReason: null,
      coverageStartedAt: input.observedAt,
      bootstrapEvidenceFrom: null,
    };
  }

  const currencies = [...new Set([
    ...previousByCurrency.keys(),
    ...currentByCurrency.keys(),
  ])].sort();
  const facts: StripeCustomerMrrMovementFact[] = [];
  const nextStates: StripeCustomerMrrPreviousState[] = [];
  let bootstrapEvidenceFrom: string | null = null;

  for (const currency of currencies) {
    const previous = previousByCurrency.get(currency);
    const current = currentByCurrency.get(currency);
    const bootstrap = bootstrapByCurrency.get(currency);
    const fromScaled = decimalMinorToScaled(previous?.amountMinor ?? "0");
    const toScaled = decimalMinorToScaled(current?.amountMinor ?? "0");
    const fromAmountMinor = scaledToCanonicalDecimal(fromScaled);
    const toAmountMinor = scaledToCanonicalDecimal(toScaled);
    const currentEvidenceHash = current?.evidenceHash
      ?? unobservedZeroEvidenceHash(previous?.evidenceHash, currency);
    const previousEvidenceHash = previous?.evidenceHash ?? "initial-zero";

    // Missing a previously-positive currency is absence, not a complete zero observation.
    // Terminal zero additionally requires a non-future service-end authority.
    //
    // Neither case is INCOMPLETE data — it is an unfinished story. Emit nothing, carry the whole
    // customer's last complete state forward untouched, and report the customer as DEFERRED so the
    // workspace's coverage stays trustworthy. Deferring the customer's OTHER currency grains too is
    // deliberate: those facts are re-derived verbatim from the carried-forward state at the next
    // close, so nothing is lost, and no customer is ever half-classified.
    if (
      previous &&
      fromScaled > 0n &&
      toScaled === 0n &&
      (
        !current ||
        (
          current.zeroTransitionAuthority === "service_end" &&
          validIsoAtOrBefore(current.effectiveEndAt, input.observedAt) === null
        )
      )
    ) {
      return {
        facts: [],
        nextStates: normalizedPrevious(input),
        unavailableReason: null,
        deferredReason: "pending_proven_service_end",
        coverageStartedAt: input.observedAt,
        bootstrapEvidenceFrom: null,
      };
    }

    let hasEverPositive = previous?.hasEverPositive ?? Boolean(bootstrap?.hadPriorPositivePayment);
    let kind: StripeMrrMovementKind | null = null;
    let provenance: StripeCustomerMrrMovementFact["provenance"] = "forward_observed_v1";
    let effectiveAt = input.observedAt;

    if (!previous && toScaled > 0n) {
      const paidAt = validIsoAtOrBefore(bootstrap?.firstPositivePaidAt ?? null, input.observedAt);
      if (
        paidAt &&
        bootstrap?.invoiceReconciliationComplete === true &&
        bootstrap.earliestPositiveLinkedToCurrentContribution === true &&
        bootstrap.hadPriorPositivePayment === true
      ) {
        kind = "new";
        provenance = "linked_paid_invoice_current_complete_v1";
        effectiveAt = paidAt;
        bootstrapEvidenceFrom = earliestIso(bootstrapEvidenceFrom, paidAt);
      }
    } else if (fromScaled === 0n && toScaled > 0n) {
      kind = hasEverPositive ? "reactivation" : "new";
    } else if (fromScaled > 0n && toScaled > fromScaled) {
      kind = "expansion";
    } else if (fromScaled > toScaled && toScaled > 0n) {
      kind = "contraction";
      effectiveAt = validIsoAtOrBefore(current?.effectiveEndAt ?? null, input.observedAt) ?? input.observedAt;
    } else if (fromScaled > 0n && toScaled === 0n) {
      kind = "churn";
      effectiveAt = current?.zeroTransitionAuthority === "service_end"
        ? validIsoAtOrBefore(current.effectiveEndAt, input.observedAt) ?? input.observedAt
        : input.observedAt;
    }

    if (toScaled > 0n || fromScaled > 0n) hasEverPositive = true;

    if (kind) {
      const deltaAmountMinor = scaledToCanonicalDecimal(toScaled - fromScaled);
      const idempotencyKey = movementIdempotencyKey({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        customerId: input.customerId,
        currency,
        kind,
        fromAmountMinor,
        toAmountMinor,
        effectiveAt,
        previousEvidenceHash,
        currentEvidenceHash,
      });
      facts.push({
        kind,
        currency,
        fromAmountMinor,
        toAmountMinor,
        deltaAmountMinor,
        effectiveAt,
        observedAt: input.observedAt,
        provenance,
        businessEligibleAtEvent: input.businessEligible,
        previousEvidenceHash,
        currentEvidenceHash,
        idempotencyKey,
      });
    }

    nextStates.push({
      currency,
      amountMinor: toAmountMinor,
      evidenceHash: currentEvidenceHash,
      hasEverPositive,
    });
  }

  return {
    facts,
    nextStates,
    unavailableReason: null,
    deferredReason: null,
    coverageStartedAt: input.observedAt,
    bootstrapEvidenceFrom,
  };
}

interface StripeMrrRecurringRow {
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  status: string | null;
  currency: string | null;
  net_monthly_amount_cents: string | number | null;
  value_state: string;
  incomplete_reasons: string[] | null;
  ended_at: string | Date | null;
  current_period_end: string | Date | null;
  business_eligible: boolean;
  source_record_hash: string | null;
}

interface StripeMrrStateRow {
  stripe_customer_id: string;
  currency: string;
  monthly_amount_minor: string | number;
  has_ever_positive: boolean;
  evidence_hash: string;
}

interface StripeMrrInvoiceEvidenceRow {
  stripe_customer_id: string;
  stripe_subscription_id: string;
  currency: string;
  paid_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function latestNonFuture(
  values: ReadonlyArray<string | Date | null>,
  observedAt: string,
): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    const candidate = validIsoAtOrBefore(iso(value), observedAt);
    if (!candidate) return latest;
    return latest === null || candidate > latest ? candidate : latest;
  }, null);
}

function scopedId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${stableHash(parts)}`;
}

/**
 * A CLOSE that no longer owns the source must not write immutable movement facts. Mirrors the
 * `sync_claim_lost` shape used by the OPEN admission check and the claimed-failure recorder.
 */
export class StripeMrrCloseClaimLostError extends Error {
  readonly code = "sync_claim_lost";
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "StripeMrrCloseClaimLostError";
  }
}

/**
 * Statuses that count as ACTIVE recurring value. `paused` is deliberately absent from BOTH this
 * set and the terminal set below: a paused subscription bills nothing (so it cannot hold value)
 * yet proves no service end (so it cannot churn). It therefore lands in the classifier's deferred
 * path — zero active value with no non-future end authority — exactly like `unpaid`.
 */
const STRIPE_ACTIVE_VALUE_STATUSES = ["active", "past_due"] as const;
/** Statuses that may CARRY a service-end proof. The proof itself is still required. */
const STRIPE_TERMINAL_STATUSES = ["canceled", "unpaid"] as const;

function isActiveValueStatus(status: string | null): boolean {
  return (STRIPE_ACTIVE_VALUE_STATUSES as readonly string[]).includes(status ?? "");
}

function isTerminalStatus(status: string | null): boolean {
  return (STRIPE_TERMINAL_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Successful Stripe CLOSE classifier. The caller must invoke this inside the existing
 * syncExtractedBatch CLOSE transaction, after every LOAD chunk has committed.
 */
export async function writeStripeMrrMovementsAtClose(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string; syncRunId: string },
): Promise<void> {
  // Serialize competing CLOSE decisions on the durable source row. Crucially this lock and all
  // state reads happen before classification; the source is still `syncing` at this point.
  const locked = await tx.query<{ id: string }>(
    `select id from sources
      where id = $1 and workspace_id = $2 and provider = 'stripe'
      for update`,
    [scope.sourceId, scope.workspaceId],
  );
  if (!locked[0]) throw new Error("Stripe MRR CLOSE source is missing or outside workspace scope");

  // OWNERSHIP, RE-VERIFIED UNDER THE LOCK. OPEN proved this run owned the source, but the boot
  // sweep resets any `syncing` source to `connected` unconditionally, which lets a competing claim
  // supersede this run WHILE its LOAD chunks are still committing. This CLOSE would then classify
  // against a subscription table the new owner is mid-replacement of — fabricating churn and
  // contraction facts that are IMMUTABLE. Abort instead; the whole CLOSE transaction rolls back and
  // the claimed-failure recorder correctly declines to touch the new owner's bookkeeping.
  const owningRuns = await tx.query<{ id: string }>(
    `select id from sync_runs
      where id = $1 and workspace_id = $2 and source_id = $3 and status = 'running'`,
    [scope.syncRunId, scope.workspaceId, scope.sourceId],
  );
  if (!owningRuns[0]) {
    throw new StripeMrrCloseClaimLostError(
      "Stripe MRR CLOSE aborted: the sync claim belongs to another run",
    );
  }

  const clock = await tx.query<{ observed_at: string | Date }>("select now() as observed_at");
  const observedAt = iso(clock[0]?.observed_at ?? new Date());

  // Direct target-source read: connected-only lifecycle views intentionally omit this source while
  // CLOSE still has it in `syncing` state and would otherwise fabricate mass churn.
  const recurringRows = await tx.query<StripeMrrRecurringRow>(
    `select v.stripe_subscription_id, v.stripe_customer_id, v.status, v.currency,
            v.net_monthly_amount_cents, v.value_state, v.incomplete_reasons,
            v.ended_at, v.current_period_end, v.business_eligible,
            r.source_record_hash
       from queryable.vw_stripe_subscription_recurring_value v
       join stripe_subscriptions s
         on s.workspace_id = v.workspace_id
        and s.source_id = v.source_id
        and s.stripe_subscription_id = v.stripe_subscription_id
       left join raw_records r on r.id = s.raw_record_id
      where v.workspace_id = $1 and v.source_id = $2
      order by v.stripe_customer_id nulls first, v.stripe_subscription_id`,
    [scope.workspaceId, scope.sourceId],
  );
  const previousRows = await tx.query<StripeMrrStateRow>(
    `select stripe_customer_id, currency, monthly_amount_minor,
            has_ever_positive, evidence_hash
       from stripe_customer_mrr_states
      where workspace_id = $1 and source_id = $2
      order by stripe_customer_id, currency`,
    [scope.workspaceId, scope.sourceId],
  );
  const eligibilityRows = await tx.query<{
    stripe_customer_id: string;
    is_business_eligible: boolean;
  }>(
    `select stripe_customer_id, is_business_eligible
       from queryable.vw_stripe_customer_metric_eligibility
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
  const invoiceState = await tx.query<{ backfill_state: string }>(
    `select backfill_state from stripe_invoice_sync_state
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
  const invoiceReconciliationComplete = invoiceState[0]?.backfill_state === "complete";
  const invoiceEvidence = await tx.query<StripeMrrInvoiceEvidenceRow>(
    `select i.stripe_customer_id, i.stripe_subscription_id, lower(i.currency) as currency,
            i.paid_at
       from stripe_invoices i
      where i.workspace_id = $1 and i.source_id = $2
        and i.status = 'paid' and i.amount_paid > 0
        and i.subscription_origin = 'subscription'
        and i.stripe_customer_id is not null
        and i.stripe_subscription_id is not null
        and i.currency is not null and i.paid_at is not null
      order by i.paid_at, i.stripe_invoice_id`,
    [scope.workspaceId, scope.sourceId],
  );

  const rowsByCustomer = new Map<string, StripeMrrRecurringRow[]>();
  let missingCustomerRows = 0;
  const incompleteReasons = new Set<string>();
  for (const row of recurringRows) {
    if (!row.stripe_customer_id) {
      if (row.business_eligible && isActiveValueStatus(row.status)) {
        missingCustomerRows += 1;
        incompleteReasons.add("missing_customer_id");
      }
      continue;
    }
    const rows = rowsByCustomer.get(row.stripe_customer_id) ?? [];
    rows.push(row);
    rowsByCustomer.set(row.stripe_customer_id, rows);
  }
  const previousByCustomer = new Map<string, StripeMrrStateRow[]>();
  for (const state of previousRows) {
    const states = previousByCustomer.get(state.stripe_customer_id) ?? [];
    states.push(state);
    previousByCustomer.set(state.stripe_customer_id, states);
  }
  const eligibility = new Map(eligibilityRows.map((row) => [
    row.stripe_customer_id,
    row.is_business_eligible,
  ]));
  const customers = [...new Set([
    ...rowsByCustomer.keys(),
    ...previousByCustomer.keys(),
  ])].sort();
  let incompleteBusinessCustomerCount = missingCustomerRows;
  let pendingServiceEndCustomerCount = 0;
  let bootstrapEvidenceFrom: string | null = null;
  let bootstrapEvidenceTo: string | null = null;
  const bootstrapProvenance = new Set<string>();

  for (const customerId of customers) {
    const customerRows = rowsByCustomer.get(customerId) ?? [];
    const previous = (previousByCustomer.get(customerId) ?? []).map((state) => ({
      currency: state.currency,
      amountMinor: String(state.monthly_amount_minor),
      evidenceHash: state.evidence_hash,
      hasEverPositive: state.has_ever_positive,
    }));
    const businessEligible = eligibility.get(customerId)
      ?? customerRows.every((row) => row.business_eligible !== false);
    const activeRows = customerRows.filter((row) => isActiveValueStatus(row.status));
    const activeIncomplete = activeRows.filter((row) => (
      row.value_state !== "complete" ||
      row.net_monthly_amount_cents === null ||
      !row.currency
    ));
    if (activeIncomplete.length > 0) {
      if (businessEligible) {
        incompleteBusinessCustomerCount += 1;
        for (const row of activeIncomplete) {
          for (const reason of row.incomplete_reasons ?? []) incompleteReasons.add(reason);
          if (!row.currency) incompleteReasons.add("missing_currency");
        }
      }
      continue;
    }

    const currencies = [...new Set(customerRows.flatMap((row) => (
      row.currency ? [row.currency.toLowerCase()] : []
    )))].sort();
    const current = currencies.map<StripeCustomerMrrCurrentState>((currency) => {
      const currencyRows = customerRows.filter((row) => row.currency?.toLowerCase() === currency);
      const activeCurrencyRows = currencyRows.filter((row) => isActiveValueStatus(row.status));
      const amountMinor = sumCanonicalStripeMrrMinor(activeCurrencyRows.map((row) => (
        String(row.net_monthly_amount_cents ?? "0")
      )));
      const terminalRows = currencyRows.filter((row) => isTerminalStatus(row.status));
      const effectiveEndAt = latestNonFuture(
        terminalRows.flatMap((row) => [row.ended_at, row.current_period_end]),
        observedAt,
      );
      const hasActiveZero = activeCurrencyRows.length > 0 && amountMinor === "0";
      let contractionEndAt: string | null = null;
      const prior = previous.find((state) => normalizedCurrency(state.currency) === currency);
      if (prior && amountMinor !== "0" && terminalRows.length > 0 && effectiveEndAt) {
        const endedAmount = sumCanonicalStripeMrrMinor(terminalRows.flatMap((row) => (
          row.value_state === "complete" && row.net_monthly_amount_cents !== null
            ? [String(row.net_monthly_amount_cents)]
            : []
        )));
        if (stripeMrrMinorDelta(prior.amountMinor, amountMinor) === endedAmount) {
          contractionEndAt = effectiveEndAt;
        }
      }
      return {
        currency,
        amountMinor,
        evidenceHash: stableHash(currencyRows.map((row) => ({
          subscriptionId: row.stripe_subscription_id,
          status: row.status,
          currency,
          valueState: row.value_state,
          netAmountMinor: row.net_monthly_amount_cents === null
            ? null
            : canonicalStripeMrrMinor(String(row.net_monthly_amount_cents)),
          endedAt: row.ended_at ? iso(row.ended_at) : null,
          currentPeriodEnd: row.current_period_end ? iso(row.current_period_end) : null,
          rawHash: row.source_record_hash,
        }))),
        effectiveEndAt: amountMinor === "0" ? effectiveEndAt : contractionEndAt,
        zeroTransitionAuthority: hasActiveZero ? "value_change" : "service_end",
      };
    });
    const activeSubscriptionIdsByCurrency = new Map(currencies.map((currency) => [
      currency,
      new Set(customerRows.filter((row) => (
        row.currency?.toLowerCase() === currency && isActiveValueStatus(row.status)
      )).map((row) => row.stripe_subscription_id)),
    ]));
    const bootstrap = currencies.map<StripeCustomerMrrBootstrapEvidence>((currency) => {
      const customerInvoices = invoiceEvidence.filter((row) => (
        row.stripe_customer_id === customerId && row.currency === currency
      ));
      const firstCustomerInvoice = customerInvoices[0] ?? null;
      const earliestPositiveLinkedToCurrentContribution = firstCustomerInvoice !== null &&
        activeSubscriptionIdsByCurrency.get(currency)?.has(firstCustomerInvoice.stripe_subscription_id) === true;
      return {
        currency,
        firstPositivePaidAt: firstCustomerInvoice ? iso(firstCustomerInvoice.paid_at) : null,
        earliestPositiveLinkedToCurrentContribution,
        invoiceReconciliationComplete,
        hadPriorPositivePayment: customerInvoices.length > 0,
      };
    });
    const result = classifyStripeCustomerMrrObservation({
      workspaceId: scope.workspaceId,
      sourceId: scope.sourceId,
      customerId,
      observedAt,
      businessEligible,
      previous,
      current,
      bootstrap,
    });
    if (result.unavailableReason) {
      if (businessEligible) incompleteBusinessCustomerCount += 1;
      incompleteReasons.add(result.unavailableReason);
      continue;
    }
    if (result.deferredReason) {
      // Deferred, not incomplete: no fact exists YET, so coverage stays trustworthy and the
      // durable state row is left exactly as the last COMPLETE observation wrote it (rewriting it
      // would advance last_complete_observed_at for an observation that resolved nothing).
      // Business-eligible only, matching the incomplete counter: an internal-test customer's
      // pending churn is noise to the founder reading this diagnostic.
      if (businessEligible) pendingServiceEndCustomerCount += 1;
      continue;
    }

    const movementIdByCurrency = new Map<string, string>();
    for (const fact of result.facts) {
      const movementId = `smrrmov_${fact.idempotencyKey}`;
      movementIdByCurrency.set(fact.currency, movementId);
      await tx.query(
        `insert into stripe_customer_mrr_movements (
           id, workspace_id, source_id, stripe_customer_id, currency, movement_kind,
           from_amount_minor, to_amount_minor, delta_amount_minor, effective_at, observed_at,
           previous_evidence_hash, current_evidence_hash, provenance,
           business_eligible_at_event, classifier_version, idempotency_key
         ) values ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (idempotency_key) do nothing`,
        [
          movementId,
          scope.workspaceId,
          scope.sourceId,
          customerId,
          fact.currency,
          fact.kind,
          fact.fromAmountMinor,
          fact.toAmountMinor,
          fact.deltaAmountMinor,
          fact.effectiveAt,
          fact.observedAt,
          fact.previousEvidenceHash,
          fact.currentEvidenceHash,
          fact.provenance,
          fact.businessEligibleAtEvent,
          STRIPE_MRR_CLASSIFIER_VERSION,
          fact.idempotencyKey,
        ],
      );
      if (fact.provenance === "linked_paid_invoice_current_complete_v1") {
        bootstrapEvidenceFrom = earliestIso(bootstrapEvidenceFrom, fact.effectiveAt);
        bootstrapEvidenceTo = observedAt;
        bootstrapProvenance.add(fact.provenance);
      }
    }
    for (const state of result.nextStates) {
      await tx.query(
        `insert into stripe_customer_mrr_states (
           id, workspace_id, source_id, stripe_customer_id, currency,
           monthly_amount_minor, has_ever_positive, evidence_hash,
           last_movement_id, last_complete_observed_at, classifier_version
         ) values ($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10,$11)
         on conflict (workspace_id, source_id, stripe_customer_id, currency)
         do update set
           monthly_amount_minor = excluded.monthly_amount_minor,
           has_ever_positive = excluded.has_ever_positive,
           evidence_hash = excluded.evidence_hash,
           last_movement_id = coalesce(excluded.last_movement_id, stripe_customer_mrr_states.last_movement_id),
           last_complete_observed_at = excluded.last_complete_observed_at,
           classifier_version = excluded.classifier_version,
           updated_at = now()`,
        [
          scopedId("smrrstate", [scope.workspaceId, scope.sourceId, customerId, state.currency]),
          scope.workspaceId,
          scope.sourceId,
          customerId,
          state.currency,
          state.amountMinor,
          state.hasEverPositive,
          state.evidenceHash,
          movementIdByCurrency.get(state.currency) ?? null,
          observedAt,
          STRIPE_MRR_CLASSIFIER_VERSION,
        ],
      );
    }
  }

  await tx.query(
    `insert into stripe_mrr_movement_coverage (
       id, workspace_id, source_id, forward_coverage_started_at,
       bootstrap_evidence_from, bootstrap_evidence_to,
       last_attempted_data_as_of, last_complete_data_as_of,
       incomplete_business_customer_count, incomplete_reasons,
       bootstrap_provenance, classifier_version,
       pending_service_end_customer_count
     ) values (
       $1,$2,$3,case when $4 = 0 then $5::timestamptz else null end,$6,$7,$5,
       case when $4 = 0 then $5::timestamptz else null end,$4,$8::text[],$9::text[],$10,
       $11
     )
     on conflict (workspace_id, source_id)
     do update set
       forward_coverage_started_at = coalesce(
         stripe_mrr_movement_coverage.forward_coverage_started_at,
         case when $4 = 0 then $5::timestamptz else null end
       ),
       bootstrap_evidence_from = case
         when stripe_mrr_movement_coverage.bootstrap_evidence_from is null then excluded.bootstrap_evidence_from
         when excluded.bootstrap_evidence_from is null then stripe_mrr_movement_coverage.bootstrap_evidence_from
         else least(stripe_mrr_movement_coverage.bootstrap_evidence_from, excluded.bootstrap_evidence_from)
       end,
       bootstrap_evidence_to = greatest(
         stripe_mrr_movement_coverage.bootstrap_evidence_to,
         excluded.bootstrap_evidence_to
       ),
       last_attempted_data_as_of = excluded.last_attempted_data_as_of,
       last_complete_data_as_of = case
         when $4 = 0 then excluded.last_attempted_data_as_of
         else stripe_mrr_movement_coverage.last_complete_data_as_of
       end,
       incomplete_business_customer_count = excluded.incomplete_business_customer_count,
       pending_service_end_customer_count = excluded.pending_service_end_customer_count,
       incomplete_reasons = excluded.incomplete_reasons,
       bootstrap_provenance = array(
         select distinct p from unnest(
           stripe_mrr_movement_coverage.bootstrap_provenance || excluded.bootstrap_provenance
         ) p order by p
       ),
       classifier_version = excluded.classifier_version,
       updated_at = now()`,
    [
      scopedId("smrrcoverage", [scope.workspaceId, scope.sourceId]),
      scope.workspaceId,
      scope.sourceId,
      incompleteBusinessCustomerCount,
      observedAt,
      bootstrapEvidenceFrom,
      bootstrapEvidenceTo,
      [...incompleteReasons].sort(),
      [...bootstrapProvenance].sort(),
      STRIPE_MRR_CLASSIFIER_VERSION,
      pendingServiceEndCustomerCount,
    ],
  );
}
