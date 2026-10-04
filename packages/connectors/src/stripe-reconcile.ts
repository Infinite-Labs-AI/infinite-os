import { createHash, randomUUID } from "node:crypto";
import type { InfiniteOsDb } from "@infinite-os/db";

/**
 * Stripe FULL RECONCILIATION — the drift lane.
 *
 * Why this exists even though the 15-min `/v1/events` delta lane covers steady state: Stripe
 * documents `/v1/events` as a 30-day RECOVERY mechanism, not a formally complete CDC ledger
 * ("selection required" event types exist and list-completeness is not guaranteed), and every
 * list endpoint filters on `created` only — never `updated` — so a recently edited OLD object is
 * invisible to a creation-filtered incremental read. A periodic full-set comparison therefore has
 * to survive forever.
 *
 * The contract this module keeps:
 *  1. Repairs change CANONICAL state only. This module NEVER writes a ledger fact
 *     (`stripe_customer_mrr_*`, `stripe_trial_*`). The CLOSE classifiers observe the corrected
 *     canonical state at the NEXT close and mint their own immutable facts from it. A reconciler
 *     that wrote movements would fabricate history from a snapshot it cannot date.
 *  2. Drift is EVIDENCE OF A DELTA-LANE MISS (our bug, or a Stripe event gap). Every single
 *     difference is recorded in `stripe_reconciliation_drift` before/with its repair. Silently
 *     healing a difference is forbidden — that is exactly how a delta-lane bug would hide forever,
 *     and the drift counters are the gate for relaxing daily reconciliation to weekly.
 *     THE MEASUREMENT IS TAKEN PRE-LOAD. Reconciliation rides the FULL lane, whose LOAD full-
 *     replaces canonical state (chunk by chunk, committed) BEFORE the connector's CLOSE opens — so
 *     a comparison taken at CLOSE is remote-vs-what-we-just-wrote-from-that-same-remote and can
 *     only ever see the classes the LOAD writers do not cover. The integrator therefore captures a
 *     `StripeReconciliationLocalProjection` during EXTRACT and passes it to
 *     `computeReconciliationPlan`; repairs are still computed and applied against LIVE post-LOAD
 *     state, and `detail.repair` records which of the two resolved each difference.
 *  3. Absence is only DELETION when the remote set is a complete list. A derived remote set (e.g.
 *     prices seen through subscription items) proves dereference, not deletion, so `missing_remote`
 *     is not evaluable against it and the module records nothing rather than guessing.
 */

export const STRIPE_RECONCILIATION_VERSION = "stripe-reconcile-v1";

/** Daily default. The relax-to-weekly decision reads `queryable.vw_stripe_reconciliation_health`. */
export const STRIPE_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type StripeReconciliationEntityKind =
  | "customer"
  | "subscription"
  | "subscription_item"
  | "invoice"
  | "price"
  | "coupon"
  | "discount";

export type StripeReconciliationDriftKind =
  | "missing_local"
  | "missing_remote"
  | "state_mismatch";

/** Thrown when the sync claim moved to another run mid-CLOSE; the whole transaction must roll back. */
export class StripeReconciliationClaimLostError extends Error {
  readonly reason = "reconciliation_claim_lost" as const;
}

// ---------------------------------------------------------------------------
// Remote input shapes.
//
// These are deliberately STRUCTURAL SUBSETS of the normalized row types the Stripe connector
// already produces (`StripeSubscriptionRow`, `StripeInvoiceRow`, `StripeSubscriptionItemRow`,
// `StripeDiscountRow` in `index.ts`), so the integrator can pass those values straight through.
// They are re-declared here rather than imported because `index.ts` does not export them and this
// module must not take an import edge into the connector barrel (lane B owns that file).
// ---------------------------------------------------------------------------

export interface StripeReconcileRemoteSet<T> {
  rows: T[];
  /**
   * True ONLY when `rows` came from a complete full-list read of that entity for this source.
   * False for any derived/partial set: `missing_remote` is then not evaluable and the module
   * records an `unevaluatedDeletions` entry instead of inventing deletions.
   */
  listComplete: boolean;
}

export interface StripeReconcileRemoteCustomer {
  customerId: string;
  email: string | null;
  name: string | null;
  metricsClassification: string | null;
  /**
   * True only when the customer arrived as an EXPANDED object, i.e. its metadata was observable.
   * When false the full-sync writer deliberately preserves the stored classification, so
   * comparing it here would manufacture drift on every run.
   */
  metadataAuthoritative: boolean;
}

export interface StripeReconcileRemoteDiscount {
  discountId: string | null;
  position: number;
  amountOff: number | null;
  percentOff: number | null;
  currency: string | null;
  appliesToProductIds: string[];
  amountOffCurrencyOptions: Record<string, number>;
  currencyOptionResolved: boolean;
  duration: string | null;
  startsAt: string | null;
  endsAt: string | null;
  complete: boolean;
  incompleteReason: string | null;
}

export interface StripeReconcileRemoteSubscriptionItem {
  itemId: string;
  priceId: string | null;
  productId: string | null;
  currency: string | null;
  unitAmount: number | null;
  defaultCurrency: string | null;
  defaultUnitAmount: number | null;
  priceCurrencyOptions: Record<string, { unitAmount: number | null; customUnitAmount: boolean }>;
  currencyOptionResolved: boolean;
  quantity: number | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  recurringUsageType: string | null;
  billingScheme: string | null;
  customUnitAmount: boolean;
  transformQuantityDivideBy: number | null;
  transformQuantityRound: "up" | "down" | null;
  pricingState: string;
  discounts: StripeReconcileRemoteDiscount[];
}

export interface StripeReconcileRemoteSubscription {
  subscriptionId: string;
  customerId: string | null;
  liveMode: boolean | null;
  status: string;
  createdAt: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  endedAt: string | null;
  /** Every subscription-item page succeeded. Item/discount deletion is evaluable only then. */
  itemsSynced: boolean;
  discountsSynced: boolean;
  items: StripeReconcileRemoteSubscriptionItem[];
  discounts: StripeReconcileRemoteDiscount[];
}

export interface StripeReconcileRemoteInvoice {
  invoiceId: string;
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionOrigin: "subscription" | "non_subscription" | "unknown";
  status: string;
  currency: string;
  amountPaid: number;
  amountDue: number;
  postPaymentCreditedMinor: number | null;
  prePaymentCreditedMinor: number | null;
  paidAt: string | null;
  createdAt: string;
  externalOrderId: string | null;
}

export interface StripeReconcileRemotePrice {
  priceId: string;
  productId: string | null;
  currency: string | null;
  unitAmount: number | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  recurringUsageType: string | null;
  billingScheme: string | null;
  customUnitAmount: boolean;
  pricingState: string;
  currencyOptions: Record<string, { unitAmount: number | null; customUnitAmount: boolean }>;
  transformQuantityDivideBy: number | null;
  transformQuantityRound: "up" | "down" | null;
}

export interface StripeReconciliationRemoteState {
  customers: StripeReconcileRemoteSet<StripeReconcileRemoteCustomer>;
  subscriptions: StripeReconcileRemoteSet<StripeReconcileRemoteSubscription>;
  invoices: StripeReconcileRemoteSet<StripeReconcileRemoteInvoice>;
  prices: StripeReconcileRemoteSet<StripeReconcileRemotePrice>;
}

export interface StripeReconciliationScope {
  workspaceId: string;
  sourceId: string;
  /** The instant the remote read STARTED. `reconciled_at` advances to exactly this. */
  runStartedAt: string;
}

export interface StripeReconciliationApplyScope extends StripeReconciliationScope {
  /** Re-verified under the source lock; a lost claim aborts instead of writing. */
  syncRunId: string;
}

// ---------------------------------------------------------------------------
// Repairs. Each carries the canonical row to write, so `applyReconciliation` needs no re-derivation.
// ---------------------------------------------------------------------------

export type StripeReconciliationRepair =
  | { action: "upsert_customer"; row: StripeReconcileRemoteCustomer }
  | { action: "upsert_subscription"; row: StripeReconcileRemoteSubscription }
  | { action: "upsert_price"; row: StripeReconcileRemotePrice }
  | {
    action: "upsert_subscription_item";
    subscriptionId: string;
    row: StripeReconcileRemoteSubscriptionItem;
  }
  | { action: "delete_subscription_item"; itemId: string }
  | {
    action: "upsert_discount";
    subscriptionId: string;
    targetType: "subscription" | "item";
    targetId: string;
    row: StripeReconcileRemoteDiscount;
  }
  | {
    action: "delete_discount";
    subscriptionId: string;
    targetType: "subscription" | "item";
    targetId: string;
    position: number;
  }
  | { action: "upsert_invoice"; row: StripeReconcileRemoteInvoice }
  /**
   * RECORDED, NOT REPAIRED. Full replacement today deletes ONLY the per-subscription child sets
   * (`stripe_subscription_items`, `stripe_subscription_discounts`) and has never deleted a parent
   * row — a canceled subscription, a deleted customer and a voided invoice all stay, and the
   * metric views handle them by status. Deleting parents here would be brand-new behavior with a
   * ledger blast radius (a vanished subscription instantly reads as churn at the next CLOSE).
   * Matching the existing semantics means recording the drift loudly and repairing nothing.
   */
  | { action: "none"; reason: string };

export interface StripeReconciliationDifference {
  entityKind: StripeReconciliationEntityKind;
  objectExternalId: string;
  driftKind: StripeReconciliationDriftKind;
  detail: Record<string, unknown> | null;
  repair: StripeReconciliationRepair;
}

export interface StripeReconciliationUnevaluatedDeletion {
  entityKind: StripeReconciliationEntityKind;
  reason: string;
  /** Present when the gap is scoped to one parent (e.g. one subscription's item pages failed). */
  scopeId?: string;
}

export interface StripeReconciliationPlan {
  workspaceId: string;
  sourceId: string;
  runStartedAt: string;
  version: string;
  differences: StripeReconciliationDifference[];
  unevaluatedDeletions: StripeReconciliationUnevaluatedDeletion[];
}

export interface StripeReconciliationOutcome {
  driftCount: number;
  repairedCount: number;
  recordedOnlyCount: number;
  /**
   * Differences that were REAL at the start of the run and that this sync's own full replacement
   * had already healed by the time CLOSE opened. They are drift — evidence of a delta-lane miss —
   * and they are exactly the rows the old post-LOAD-only comparison could never see, so the
   * relax-daily-to-weekly decision must count them even though nothing was repaired.
   */
  healedByLoadCount: number;
  countsByKind: Record<StripeReconciliationDriftKind, number>;
  /** The value written to `stripe_sync_watermarks.reconciled_at` (always advances). */
  reconciledAt: string;
  driftDetected: boolean;
}

/** How a recorded difference was (or was not) resolved. Written to `drift.detail.repair`. */
export type StripeReconciliationRepairMarker =
  /** Survived the LOAD; this reconciliation wrote the fix. */
  | "direct"
  /** The sync's own full replacement healed it before CLOSE. Recorded, not repaired. */
  | "full_replacement"
  /** Unrepairable by contract (parent rows are never deleted by full replacement). */
  | "none";

// ---------------------------------------------------------------------------
// Semantic hashing.
//
// The hash covers the METRIC-RELEVANT fields of the NORMALIZED row, never the raw Stripe payload:
// a raw-JSON hash would flip on every Stripe API-version field addition and on any field we do not
// even store, drowning the drift signal that gates the cadence relaxation.
//
// EXCLUDED FROM EVERY ENTITY (and why):
//   • `id`            — local surrogate uuid, minted per insert. Never Stripe truth.
//   • `raw_record_id` — provenance pointer, rewritten by every sync. Pure no-op churn.
//   • `created_at`    — local insert clock.
// Per-entity exclusions are documented on each spec below.
// ---------------------------------------------------------------------------

type FieldType = "text" | "int" | "decimal" | "bool" | "timestamp" | "json" | "text_set";

interface FieldSpec {
  column: string;
  type: FieldType;
}

const NULL_SENTINEL = "\u0000null";

function canonicalScalar(type: FieldType, value: unknown): string {
  if (value === null || value === undefined) return NULL_SENTINEL;
  switch (type) {
    case "text":
      return `s:${String(value)}`;
    case "bool":
      return `b:${value === true || value === "t" || value === "true" ? "1" : "0"}`;
    case "int":
      // pg returns bigint columns as strings, PGlite may return numbers. BigInt(String(v)) unifies
      // both and THROWS on a float — a silent truncation here would hide a real amount change.
      return `i:${BigInt(String(value)).toString()}`;
    case "decimal":
      return `d:${canonicalDecimal(String(value))}`;
    case "timestamp": {
      const parsed = value instanceof Date ? value : new Date(String(value));
      const ms = parsed.getTime();
      if (Number.isNaN(ms)) throw new Error(`unparseable Stripe reconciliation timestamp: ${String(value)}`);
      return `t:${parsed.toISOString()}`;
    }
    case "json":
      return `j:${stableStringify(value)}`;
    case "text_set": {
      // Product-restriction lists are SETS: Stripe does not promise an order and the writer stores
      // whatever order it received, so sorting keeps a pure reorder from reading as drift.
      const list = Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value)];
      return `S:${JSON.stringify([...list].sort())}`;
    }
    default:
      throw new Error(`unhandled Stripe reconciliation field type: ${String(type)}`);
  }
}

function canonicalDecimal(raw: string): string {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`unparseable Stripe reconciliation decimal: ${raw}`);
  }
  if (!trimmed.includes(".")) return trimmed;
  const stripped = trimmed.replace(/0+$/, "").replace(/\.$/, "");
  return stripped === "-0" || stripped === "" ? "0" : stripped;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  if (typeof value === "string") {
    // jsonb round-trips as a parsed object through pg but as a string through some drivers.
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return stableStringify(JSON.parse(trimmed));
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/**
 * `stripe_customers`: only what the customer object itself asserts.
 * EXCLUDED — `created_at_source`: the full-sync writer stamps it with the INVOICE/SUBSCRIPTION that
 * first observed the customer, not the customer's own creation time, so it is provenance-dependent
 * and two lanes legitimately disagree. `metrics_classification` is conditional (see below).
 */
const CUSTOMER_FIELDS: FieldSpec[] = [
  { column: "email", type: "text" },
  { column: "name", type: "text" },
];
const CUSTOMER_CLASSIFICATION_FIELD: FieldSpec = { column: "metrics_classification", type: "text" };

/**
 * `stripe_subscriptions`. The two `*_sync_complete` flags ARE metric-relevant: the recurring-value
 * and MRR views fail closed on them, so a stale `false` silently nulls a customer's value.
 */
const SUBSCRIPTION_FIELDS: FieldSpec[] = [
  { column: "stripe_customer_id", type: "text" },
  { column: "status", type: "text" },
  { column: "current_period_start", type: "timestamp" },
  { column: "current_period_end", type: "timestamp" },
  { column: "created_at_source", type: "timestamp" },
  { column: "trial_start", type: "timestamp" },
  { column: "trial_end", type: "timestamp" },
  { column: "cancel_at", type: "timestamp" },
  { column: "canceled_at", type: "timestamp" },
  { column: "ended_at", type: "timestamp" },
  { column: "items_sync_complete", type: "bool" },
  { column: "discounts_sync_complete", type: "bool" },
  { column: "livemode", type: "bool" },
];

const SUBSCRIPTION_ITEM_FIELDS: FieldSpec[] = [
  { column: "stripe_subscription_id", type: "text" },
  { column: "stripe_price_id", type: "text" },
  { column: "stripe_product_id", type: "text" },
  { column: "currency", type: "text" },
  { column: "unit_amount", type: "int" },
  { column: "quantity", type: "int" },
  { column: "recurring_interval", type: "text" },
  { column: "recurring_interval_count", type: "int" },
  { column: "recurring_usage_type", type: "text" },
  { column: "billing_scheme", type: "text" },
  { column: "custom_unit_amount", type: "bool" },
  { column: "pricing_state", type: "text" },
  { column: "default_currency", type: "text" },
  { column: "default_unit_amount", type: "int" },
  { column: "price_currency_options", type: "json" },
  { column: "currency_option_resolved", type: "bool" },
  { column: "transform_quantity_divide_by", type: "int" },
  { column: "transform_quantity_round", type: "text" },
];

const INVOICE_FIELDS: FieldSpec[] = [
  { column: "stripe_customer_id", type: "text" },
  { column: "stripe_subscription_id", type: "text" },
  { column: "subscription_origin", type: "text" },
  { column: "status", type: "text" },
  { column: "currency", type: "text" },
  { column: "amount_paid", type: "int" },
  { column: "amount_due", type: "int" },
  { column: "paid_at", type: "timestamp" },
  { column: "created_at_source", type: "timestamp" },
  { column: "external_order_id", type: "text" },
  { column: "post_payment_credit_notes_amount", type: "int" },
  { column: "pre_payment_credit_notes_amount", type: "int" },
];

/**
 * `stripe_prices`.
 * EXCLUDED — `active`: the writer hardcodes `true` on insert and never updates it on conflict, so
 * it is not a synced field at all; comparing it would mint permanent phantom drift.
 */
const PRICE_FIELDS: FieldSpec[] = [
  { column: "stripe_product_id", type: "text" },
  { column: "currency", type: "text" },
  { column: "unit_amount", type: "int" },
  { column: "recurring_interval", type: "text" },
  { column: "recurring_interval_count", type: "int" },
  { column: "recurring_usage_type", type: "text" },
  { column: "billing_scheme", type: "text" },
  { column: "custom_unit_amount", type: "bool" },
  { column: "pricing_state", type: "text" },
  { column: "currency_options", type: "json" },
  { column: "transform_quantity_divide_by", type: "int" },
  { column: "transform_quantity_round", type: "text" },
];

/** `stripe_subscription_discounts`. Keyed by (subscription, target_type, target_id, position). */
const DISCOUNT_FIELDS: FieldSpec[] = [
  { column: "stripe_discount_id", type: "text" },
  { column: "amount_off", type: "int" },
  { column: "percent_off", type: "decimal" },
  { column: "currency", type: "text" },
  { column: "duration", type: "text" },
  { column: "starts_at", type: "timestamp" },
  { column: "ends_at", type: "timestamp" },
  { column: "is_complete", type: "bool" },
  { column: "incomplete_reason", type: "text" },
  { column: "applies_to_product_ids", type: "text_set" },
  { column: "amount_off_currency_options", type: "json" },
  { column: "currency_option_resolved", type: "bool" },
];

function canonicalFields(
  specs: readonly FieldSpec[],
  row: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) out[spec.column] = canonicalScalar(spec.type, row[spec.column]);
  return out;
}

/** Stable hash of one entity's metric-relevant canonical fields. Exported for telemetry/tests. */
export function stripeReconciliationSemanticHash(
  entityKind: StripeReconciliationEntityKind,
  fields: Record<string, string>,
): string {
  const body = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("|");
  return createHash("sha256").update(`${STRIPE_RECONCILIATION_VERSION}|${entityKind}|${body}`)
    .digest("hex");
}

function mismatchedFields(
  remote: Record<string, string>,
  local: Record<string, string>,
): string[] {
  return Object.keys(remote).filter((key) => remote[key] !== local[key]).sort();
}

// ---------------------------------------------------------------------------
// Remote → canonical-column projections. These MUST mirror what the full-sync writers store,
// column for column, or reconciliation would report drift against its own repair.
// ---------------------------------------------------------------------------

function remoteCustomerColumns(row: StripeReconcileRemoteCustomer): Record<string, unknown> {
  return {
    email: row.email,
    name: row.name,
    metrics_classification: row.metricsClassification,
  };
}

function remoteSubscriptionColumns(row: StripeReconcileRemoteSubscription): Record<string, unknown> {
  return {
    stripe_customer_id: row.customerId,
    status: row.status,
    current_period_start: row.currentPeriodStart,
    current_period_end: row.currentPeriodEnd,
    created_at_source: row.createdAt,
    trial_start: row.trialStart,
    trial_end: row.trialEnd,
    cancel_at: row.cancelAt,
    canceled_at: row.canceledAt,
    ended_at: row.endedAt,
    items_sync_complete: row.itemsSynced,
    discounts_sync_complete: row.discountsSynced,
    livemode: row.liveMode,
  };
}

function remoteItemColumns(
  subscriptionId: string,
  row: StripeReconcileRemoteSubscriptionItem,
): Record<string, unknown> {
  return {
    stripe_subscription_id: subscriptionId,
    stripe_price_id: row.priceId,
    stripe_product_id: row.productId,
    currency: row.currency,
    unit_amount: row.unitAmount,
    quantity: row.quantity,
    recurring_interval: row.recurringInterval,
    recurring_interval_count: row.recurringIntervalCount,
    recurring_usage_type: row.recurringUsageType,
    billing_scheme: row.billingScheme,
    custom_unit_amount: row.customUnitAmount,
    pricing_state: row.pricingState,
    default_currency: row.defaultCurrency,
    default_unit_amount: row.defaultUnitAmount,
    price_currency_options: row.priceCurrencyOptions,
    currency_option_resolved: row.currencyOptionResolved,
    transform_quantity_divide_by: row.transformQuantityDivideBy,
    transform_quantity_round: row.transformQuantityRound,
  };
}

function remoteInvoiceColumns(row: StripeReconcileRemoteInvoice): Record<string, unknown> {
  return {
    stripe_customer_id: row.customerId,
    stripe_subscription_id: row.subscriptionId,
    subscription_origin: row.subscriptionOrigin,
    status: row.status,
    currency: row.currency,
    amount_paid: row.amountPaid,
    amount_due: row.amountDue,
    paid_at: row.paidAt,
    created_at_source: row.createdAt,
    external_order_id: row.externalOrderId,
    post_payment_credit_notes_amount: row.postPaymentCreditedMinor,
    pre_payment_credit_notes_amount: row.prePaymentCreditedMinor,
  };
}

function remotePriceColumns(row: StripeReconcileRemotePrice): Record<string, unknown> {
  return {
    stripe_product_id: row.productId,
    currency: row.currency,
    unit_amount: row.unitAmount,
    recurring_interval: row.recurringInterval,
    recurring_interval_count: row.recurringIntervalCount,
    recurring_usage_type: row.recurringUsageType,
    billing_scheme: row.billingScheme,
    custom_unit_amount: row.customUnitAmount,
    pricing_state: row.pricingState,
    currency_options: row.currencyOptions,
    transform_quantity_divide_by: row.transformQuantityDivideBy,
    transform_quantity_round: row.transformQuantityRound,
  };
}

function remoteDiscountColumns(row: StripeReconcileRemoteDiscount): Record<string, unknown> {
  return {
    stripe_discount_id: row.discountId,
    amount_off: row.amountOff,
    percent_off: row.percentOff,
    currency: row.currency,
    duration: row.duration,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    is_complete: row.complete,
    incomplete_reason: row.incompleteReason,
    applies_to_product_ids: row.appliesToProductIds,
    amount_off_currency_options: row.amountOffCurrencyOptions,
    currency_option_resolved: row.currencyOptionResolved,
  };
}

export function stripeDiscountExternalId(
  subscriptionId: string,
  targetType: "subscription" | "item",
  targetId: string,
  position: number,
): string {
  return `${subscriptionId}:${targetType}:${targetId}:${position}`;
}

/**
 * Derive the remote PRICE set from the remote subscription items, exactly as the full-sync writer
 * does today. `listComplete` is deliberately FALSE: a price absent from this set is merely
 * unreferenced by any live subscription, which is not evidence it was deleted in Stripe. Pass a
 * real `/v1/prices` listing with `listComplete: true` when deletion detection is wanted.
 */
export function stripeRemotePricesFromSubscriptions(
  subscriptions: readonly StripeReconcileRemoteSubscription[],
): StripeReconcileRemoteSet<StripeReconcileRemotePrice> {
  const byId = new Map<string, StripeReconcileRemotePrice>();
  for (const subscription of subscriptions) {
    for (const item of subscription.items) {
      if (!item.priceId || byId.has(item.priceId)) continue;
      byId.set(item.priceId, {
        priceId: item.priceId,
        productId: item.productId,
        currency: item.defaultCurrency,
        unitAmount: item.defaultUnitAmount,
        recurringInterval: item.recurringInterval,
        recurringIntervalCount: item.recurringIntervalCount,
        recurringUsageType: item.recurringUsageType,
        billingScheme: item.billingScheme,
        customUnitAmount: item.customUnitAmount,
        pricingState: item.pricingState,
        currencyOptions: item.priceCurrencyOptions,
        transformQuantityDivideBy: item.transformQuantityDivideBy,
        transformQuantityRound: item.transformQuantityRound,
      });
    }
  }
  return { rows: [...byId.values()], listComplete: false };
}

// ---------------------------------------------------------------------------
// Local canonical-state reads.
// ---------------------------------------------------------------------------

type LocalRow = Record<string, unknown>;

async function readLocal(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
  table: string,
  keyColumn: string,
  specs: readonly FieldSpec[],
): Promise<Map<string, LocalRow>> {
  const columns = [keyColumn, ...specs.map((spec) => spec.column)].join(", ");
  const rows = await tx.query<LocalRow>(
    `select ${columns} from ${table} where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
  const map = new Map<string, LocalRow>();
  for (const row of rows) map.set(String(row[keyColumn]), row);
  return map;
}

/**
 * A point-in-time copy of EXACTLY the local columns the comparison reads.
 *
 * WHY THIS TYPE EXISTS — the drift ledger was structurally blind without it. `syncExtractedBatch`
 * commits the LOAD (full replacement, chunk by chunk) BEFORE the connector's CLOSE transaction
 * opens, and the reconciliation plan is computed inside that CLOSE. So on the FULL lane — the only
 * lane reconciliation rides — every difference the delta lane had actually accumulated was already
 * healed by the time anything measured it: the comparison was remote-vs-what-we-just-wrote-from-
 * that-same-remote, which can only ever find the classes the LOAD writers do not cover. A drift
 * ledger that reports zero because it measured after the repair is the exact inverse of its
 * contract, and the relax-daily-to-weekly gate reads it.
 *
 * Captured during EXTRACT (before any LOAD chunk commits) and carried on the run plan. It is a
 * MEASUREMENT, never a repair input: repairs are still re-verified against live POST-LOAD state.
 */
export interface StripeReconciliationLocalProjection {
  version: "stripe-reconcile-local-v1";
  customers: Map<string, LocalRow>;
  subscriptions: Map<string, LocalRow>;
  items: Map<string, LocalRow>;
  /** Keyed by `stripeDiscountExternalId`, so the caller never re-derives the composite key. */
  discountsByKey: Map<string, LocalRow>;
  prices: Map<string, LocalRow>;
  invoices: Map<string, LocalRow>;
}

/**
 * Read every local map the comparison needs. Six scoped queries — cheap enough to run at extract
 * time on every reconciling run (at most daily per source).
 */
export async function captureLocalReconciliationProjection(
  db: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
): Promise<StripeReconciliationLocalProjection> {
  const [customers, subscriptions, items, prices, invoices] = await Promise.all([
    readLocal(db, scope, "stripe_customers", "stripe_customer_id", [
      ...CUSTOMER_FIELDS,
      CUSTOMER_CLASSIFICATION_FIELD,
    ]),
    readLocal(db, scope, "stripe_subscriptions", "stripe_subscription_id", SUBSCRIPTION_FIELDS),
    readLocal(
      db,
      scope,
      "stripe_subscription_items",
      "stripe_subscription_item_id",
      SUBSCRIPTION_ITEM_FIELDS,
    ),
    readLocal(db, scope, "stripe_prices", "stripe_price_id", PRICE_FIELDS),
    readLocal(db, scope, "stripe_invoices", "stripe_invoice_id", INVOICE_FIELDS),
  ]);
  const discountRows = await db.query<LocalRow>(
    `select stripe_subscription_id, target_type, target_id, position,
            ${DISCOUNT_FIELDS.map((spec) => spec.column).join(", ")}
       from stripe_subscription_discounts
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
  const discountsByKey = new Map<string, LocalRow>();
  for (const row of discountRows) {
    discountsByKey.set(
      stripeDiscountExternalId(
        String(row.stripe_subscription_id),
        row.target_type as "subscription" | "item",
        String(row.target_id),
        Number(row.position),
      ),
      row,
    );
  }
  return {
    version: "stripe-reconcile-local-v1",
    customers,
    subscriptions,
    items,
    discountsByKey,
    prices,
    invoices,
  };
}

// ---------------------------------------------------------------------------
// Plan.
// ---------------------------------------------------------------------------

const ENTITY_APPLY_ORDER: StripeReconciliationEntityKind[] = [
  "customer",
  "subscription",
  "price",
  "subscription_item",
  "discount",
  "invoice",
  "coupon",
];

function sortDifferences(
  differences: StripeReconciliationDifference[],
): StripeReconciliationDifference[] {
  return [...differences].sort((left, right) => {
    const byEntity = ENTITY_APPLY_ORDER.indexOf(left.entityKind)
      - ENTITY_APPLY_ORDER.indexOf(right.entityKind);
    if (byEntity !== 0) return byEntity;
    if (left.objectExternalId !== right.objectExternalId) {
      return left.objectExternalId < right.objectExternalId ? -1 : 1;
    }
    return left.driftKind < right.driftKind ? -1 : left.driftKind > right.driftKind ? 1 : 0;
  });
}

/**
 * Compare a COMPLETE remote snapshot against local canonical state. Pure with respect to writes —
 * it only reads through `tx` — so a plan can be inspected, logged, or asserted before anything is
 * repaired.
 *
 * `options.local` substitutes a PRE-LOAD projection for the live read: that is how the drift
 * measurement escapes being taken after the LOAD already healed it (see
 * `StripeReconciliationLocalProjection`). Omit it and the comparison is against live state, which
 * is what the REPAIR set must always be computed from.
 */
export async function computeReconciliationPlan(
  tx: InfiniteOsDb,
  scope: StripeReconciliationScope,
  remote: StripeReconciliationRemoteState,
  options: { local?: StripeReconciliationLocalProjection } = {},
): Promise<StripeReconciliationPlan> {
  const differences: StripeReconciliationDifference[] = [];
  const unevaluatedDeletions: StripeReconciliationUnevaluatedDeletion[] = [];
  const local = options.local ?? await captureLocalReconciliationProjection(tx, scope);

  // --- customers -----------------------------------------------------------
  const localCustomers = local.customers;
  const seenCustomers = new Set<string>();
  for (const row of remote.customers.rows) {
    seenCustomers.add(row.customerId);
    // An un-expanded customer's classification is UNOBSERVED, not null — the writer preserves the
    // stored value on purpose, so it must drop out of the comparison too.
    const specs = row.metadataAuthoritative
      ? [...CUSTOMER_FIELDS, CUSTOMER_CLASSIFICATION_FIELD]
      : CUSTOMER_FIELDS;
    const local = localCustomers.get(row.customerId);
    if (!local) {
      differences.push({
        entityKind: "customer",
        objectExternalId: row.customerId,
        driftKind: "missing_local",
        detail: null,
        repair: { action: "upsert_customer", row },
      });
      continue;
    }
    const fields = mismatchedFields(
      canonicalFields(specs, remoteCustomerColumns(row)),
      canonicalFields(specs, local),
    );
    if (fields.length > 0) {
      differences.push({
        entityKind: "customer",
        objectExternalId: row.customerId,
        driftKind: "state_mismatch",
        detail: { fields },
        repair: { action: "upsert_customer", row },
      });
    }
  }
  if (remote.customers.listComplete) {
    for (const customerId of localCustomers.keys()) {
      if (seenCustomers.has(customerId)) continue;
      differences.push({
        entityKind: "customer",
        objectExternalId: customerId,
        driftKind: "missing_remote",
        detail: { reason: "parent_rows_are_never_deleted_by_full_replacement" },
        repair: { action: "none", reason: "parent_delete_not_in_full_sync_semantics" },
      });
    }
  } else {
    unevaluatedDeletions.push({
      entityKind: "customer",
      reason: "remote_customer_set_not_a_complete_list",
    });
  }

  // --- subscriptions -------------------------------------------------------
  const localSubscriptions = local.subscriptions;
  const remoteSubscriptionIds = new Set<string>();
  for (const row of remote.subscriptions.rows) {
    remoteSubscriptionIds.add(row.subscriptionId);
    const local = localSubscriptions.get(row.subscriptionId);
    if (!local) {
      differences.push({
        entityKind: "subscription",
        objectExternalId: row.subscriptionId,
        driftKind: "missing_local",
        detail: null,
        repair: { action: "upsert_subscription", row },
      });
      continue;
    }
    const fields = mismatchedFields(
      canonicalFields(SUBSCRIPTION_FIELDS, remoteSubscriptionColumns(row)),
      canonicalFields(SUBSCRIPTION_FIELDS, local),
    );
    if (fields.length > 0) {
      differences.push({
        entityKind: "subscription",
        objectExternalId: row.subscriptionId,
        driftKind: "state_mismatch",
        detail: { fields },
        repair: { action: "upsert_subscription", row },
      });
    }
  }
  if (remote.subscriptions.listComplete) {
    for (const subscriptionId of localSubscriptions.keys()) {
      if (remoteSubscriptionIds.has(subscriptionId)) continue;
      differences.push({
        entityKind: "subscription",
        objectExternalId: subscriptionId,
        driftKind: "missing_remote",
        // Its children are deliberately left alone: deleting the items of a subscription Stripe
        // no longer lists would zero the customer's value and mint a churn fact from a snapshot.
        detail: {
          reason: "parent_rows_are_never_deleted_by_full_replacement",
          childRowsNotCompared: true,
        },
        repair: { action: "none", reason: "parent_delete_not_in_full_sync_semantics" },
      });
    }
  } else {
    unevaluatedDeletions.push({
      entityKind: "subscription",
      reason: "remote_subscription_set_not_a_complete_list",
    });
  }

  // --- subscription items + discounts (children of remote-present subscriptions only) ---
  const localItems = local.items;
  const localDiscountsByKey = local.discountsByKey;

  for (const subscription of remote.subscriptions.rows) {
    if (!subscription.itemsSynced) {
      unevaluatedDeletions.push({
        entityKind: "subscription_item",
        reason: "subscription_item_pages_incomplete",
        scopeId: subscription.subscriptionId,
      });
    }
    const remoteItemIds = new Set<string>();
    for (const item of subscription.items) {
      remoteItemIds.add(item.itemId);
      const local = localItems.get(item.itemId);
      if (!local) {
        differences.push({
          entityKind: "subscription_item",
          objectExternalId: item.itemId,
          driftKind: "missing_local",
          detail: null,
          repair: {
            action: "upsert_subscription_item",
            subscriptionId: subscription.subscriptionId,
            row: item,
          },
        });
        continue;
      }
      const fields = mismatchedFields(
        canonicalFields(
          SUBSCRIPTION_ITEM_FIELDS,
          remoteItemColumns(subscription.subscriptionId, item),
        ),
        canonicalFields(SUBSCRIPTION_ITEM_FIELDS, local),
      );
      if (fields.length > 0) {
        differences.push({
          entityKind: "subscription_item",
          objectExternalId: item.itemId,
          driftKind: "state_mismatch",
          detail: { fields },
          repair: {
            action: "upsert_subscription_item",
            subscriptionId: subscription.subscriptionId,
            row: item,
          },
        });
      }
    }
    if (subscription.itemsSynced) {
      // Child sets ARE fully replaced by the existing full sync, so a disappeared item is a real
      // delete and repairing it matches today's `delete from stripe_subscription_items` semantics.
      for (const [itemId, local] of localItems) {
        if (String(local.stripe_subscription_id) !== subscription.subscriptionId) continue;
        if (remoteItemIds.has(itemId)) continue;
        differences.push({
          entityKind: "subscription_item",
          objectExternalId: itemId,
          driftKind: "missing_remote",
          detail: null,
          repair: { action: "delete_subscription_item", itemId },
        });
      }
    }

    const discountsEvaluable = subscription.itemsSynced && subscription.discountsSynced;
    const remoteDiscountKeys = new Set<string>();
    const remoteDiscountTargets: {
      targetType: "subscription" | "item";
      targetId: string;
      discount: StripeReconcileRemoteDiscount;
    }[] = [
      ...subscription.discounts.map((discount) => ({
        targetType: "subscription" as const,
        targetId: subscription.subscriptionId,
        discount,
      })),
      ...subscription.items.flatMap((item) => item.discounts.map((discount) => ({
        targetType: "item" as const,
        targetId: item.itemId,
        discount,
      }))),
    ];
    for (const target of remoteDiscountTargets) {
      const key = stripeDiscountExternalId(
        subscription.subscriptionId,
        target.targetType,
        target.targetId,
        target.discount.position,
      );
      remoteDiscountKeys.add(key);
      const local = localDiscountsByKey.get(key);
      const repair: StripeReconciliationRepair = {
        action: "upsert_discount",
        subscriptionId: subscription.subscriptionId,
        targetType: target.targetType,
        targetId: target.targetId,
        row: target.discount,
      };
      if (!local) {
        differences.push({
          entityKind: "discount",
          objectExternalId: key,
          driftKind: "missing_local",
          detail: null,
          repair,
        });
        continue;
      }
      const fields = mismatchedFields(
        canonicalFields(DISCOUNT_FIELDS, remoteDiscountColumns(target.discount)),
        canonicalFields(DISCOUNT_FIELDS, local),
      );
      if (fields.length > 0) {
        differences.push({
          entityKind: "discount",
          objectExternalId: key,
          driftKind: "state_mismatch",
          detail: { fields },
          repair,
        });
      }
    }
    if (discountsEvaluable) {
      for (const [key, local] of localDiscountsByKey) {
        if (String(local.stripe_subscription_id) !== subscription.subscriptionId) continue;
        if (remoteDiscountKeys.has(key)) continue;
        differences.push({
          entityKind: "discount",
          objectExternalId: key,
          driftKind: "missing_remote",
          detail: null,
          repair: {
            action: "delete_discount",
            subscriptionId: subscription.subscriptionId,
            targetType: local.target_type as "subscription" | "item",
            targetId: String(local.target_id),
            position: Number(local.position),
          },
        });
      }
    } else {
      unevaluatedDeletions.push({
        entityKind: "discount",
        reason: "subscription_discount_evidence_incomplete",
        scopeId: subscription.subscriptionId,
      });
    }
  }

  // --- prices --------------------------------------------------------------
  const localPrices = local.prices;
  const remotePriceIds = new Set<string>();
  for (const row of remote.prices.rows) {
    remotePriceIds.add(row.priceId);
    const local = localPrices.get(row.priceId);
    if (!local) {
      differences.push({
        entityKind: "price",
        objectExternalId: row.priceId,
        driftKind: "missing_local",
        detail: null,
        repair: { action: "upsert_price", row },
      });
      continue;
    }
    const fields = mismatchedFields(
      canonicalFields(PRICE_FIELDS, remotePriceColumns(row)),
      canonicalFields(PRICE_FIELDS, local),
    );
    if (fields.length > 0) {
      differences.push({
        entityKind: "price",
        objectExternalId: row.priceId,
        driftKind: "state_mismatch",
        detail: { fields },
        repair: { action: "upsert_price", row },
      });
    }
  }
  if (remote.prices.listComplete) {
    for (const priceId of localPrices.keys()) {
      if (remotePriceIds.has(priceId)) continue;
      differences.push({
        entityKind: "price",
        objectExternalId: priceId,
        driftKind: "missing_remote",
        detail: { reason: "parent_rows_are_never_deleted_by_full_replacement" },
        repair: { action: "none", reason: "parent_delete_not_in_full_sync_semantics" },
      });
    }
  } else {
    unevaluatedDeletions.push({
      entityKind: "price",
      reason: "remote_price_set_not_a_complete_list",
    });
  }

  // --- invoices ------------------------------------------------------------
  const localInvoices = local.invoices;
  const remoteInvoiceIds = new Set<string>();
  for (const row of remote.invoices.rows) {
    remoteInvoiceIds.add(row.invoiceId);
    const local = localInvoices.get(row.invoiceId);
    if (!local) {
      differences.push({
        entityKind: "invoice",
        objectExternalId: row.invoiceId,
        driftKind: "missing_local",
        detail: null,
        repair: { action: "upsert_invoice", row },
      });
      continue;
    }
    const fields = mismatchedFields(
      canonicalFields(INVOICE_FIELDS, remoteInvoiceColumns(row)),
      canonicalFields(INVOICE_FIELDS, local),
    );
    if (fields.length > 0) {
      differences.push({
        entityKind: "invoice",
        objectExternalId: row.invoiceId,
        driftKind: "state_mismatch",
        detail: { fields },
        repair: { action: "upsert_invoice", row },
      });
    }
  }
  if (remote.invoices.listComplete) {
    for (const invoiceId of localInvoices.keys()) {
      if (remoteInvoiceIds.has(invoiceId)) continue;
      differences.push({
        entityKind: "invoice",
        objectExternalId: invoiceId,
        driftKind: "missing_remote",
        detail: { reason: "parent_rows_are_never_deleted_by_full_replacement" },
        repair: { action: "none", reason: "parent_delete_not_in_full_sync_semantics" },
      });
    }
  } else {
    unevaluatedDeletions.push({
      entityKind: "invoice",
      reason: "remote_invoice_set_not_a_complete_list",
    });
  }

  return {
    workspaceId: scope.workspaceId,
    sourceId: scope.sourceId,
    runStartedAt: scope.runStartedAt,
    version: STRIPE_RECONCILIATION_VERSION,
    differences: sortDifferences(differences),
    unevaluatedDeletions,
  };
}

// ---------------------------------------------------------------------------
// Apply.
//
// The repair SQL below intentionally MIRRORS the full-sync writers in `index.ts`
// (`writeStripeTruth` / `writeStripeSubscriptionTruth`). It is re-declared rather than imported
// because those writers are private to the connector barrel and take a `SyncRequest`/rawId they
// cannot supply here (a reconciliation repair has no raw_record provenance of its own).
// DUPLICATION NOTE FOR THE INTEGRATOR: if these two ever diverge, reconciliation will "repair"
// rows into a shape the next full sync immediately re-drifts. Unifying them behind one exported
// upsert helper per table is the right follow-up once lane B's index.ts edits have landed.
// ---------------------------------------------------------------------------

async function applyRepair(
  tx: InfiniteOsDb,
  scope: StripeReconciliationApplyScope,
  repair: StripeReconciliationRepair,
): Promise<boolean> {
  switch (repair.action) {
    case "none":
      return false;
    case "upsert_customer": {
      await tx.query(
        `insert into stripe_customers (
           id, workspace_id, source_id, stripe_customer_id, email, name, metrics_classification
         ) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (source_id, stripe_customer_id)
         do update set
           email = excluded.email,
           name = excluded.name${repair.row.metadataAuthoritative
    ? ",\n           metrics_classification = excluded.metrics_classification"
    : ""}`,
        [
          `cus_${randomUUID()}`,
          scope.workspaceId,
          scope.sourceId,
          repair.row.customerId,
          repair.row.email,
          repair.row.name,
          repair.row.metricsClassification,
        ],
      );
      return true;
    }
    case "upsert_subscription": {
      const row = repair.row;
      await tx.query(
        `insert into stripe_subscriptions (
           id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
           current_period_start, current_period_end, created_at_source, trial_start, trial_end,
           cancel_at, canceled_at, ended_at, items_sync_complete, discounts_sync_complete, livemode
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (source_id, stripe_subscription_id)
         do update set
           stripe_customer_id = excluded.stripe_customer_id,
           status = excluded.status,
           current_period_start = excluded.current_period_start,
           current_period_end = excluded.current_period_end,
           created_at_source = excluded.created_at_source,
           trial_start = excluded.trial_start,
           trial_end = excluded.trial_end,
           cancel_at = excluded.cancel_at,
           canceled_at = excluded.canceled_at,
           ended_at = excluded.ended_at,
           items_sync_complete = excluded.items_sync_complete,
           discounts_sync_complete = excluded.discounts_sync_complete,
           livemode = excluded.livemode`,
        [
          `sub_${randomUUID()}`,
          scope.workspaceId,
          scope.sourceId,
          row.subscriptionId,
          row.customerId,
          row.status,
          row.currentPeriodStart,
          row.currentPeriodEnd,
          row.createdAt,
          row.trialStart,
          row.trialEnd,
          row.cancelAt,
          row.canceledAt,
          row.endedAt,
          row.itemsSynced,
          row.discountsSynced,
          row.liveMode,
        ],
      );
      return true;
    }
    case "upsert_price": {
      const row = repair.row;
      await tx.query(
        `insert into stripe_prices (
           id, workspace_id, source_id, stripe_price_id, stripe_product_id, currency, unit_amount,
           recurring_interval, recurring_interval_count, recurring_usage_type, billing_scheme,
           custom_unit_amount, pricing_state, currency_options, transform_quantity_divide_by,
           transform_quantity_round, active
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,true)
         on conflict (source_id, stripe_price_id)
         do update set
           stripe_product_id = excluded.stripe_product_id,
           currency = excluded.currency,
           unit_amount = excluded.unit_amount,
           recurring_interval = excluded.recurring_interval,
           recurring_interval_count = excluded.recurring_interval_count,
           recurring_usage_type = excluded.recurring_usage_type,
           billing_scheme = excluded.billing_scheme,
           custom_unit_amount = excluded.custom_unit_amount,
           pricing_state = excluded.pricing_state,
           currency_options = excluded.currency_options,
           transform_quantity_divide_by = excluded.transform_quantity_divide_by,
           transform_quantity_round = excluded.transform_quantity_round`,
        [
          `price_${randomUUID()}`,
          scope.workspaceId,
          scope.sourceId,
          row.priceId,
          row.productId,
          row.currency,
          row.unitAmount,
          row.recurringInterval,
          row.recurringIntervalCount,
          row.recurringUsageType,
          row.billingScheme,
          row.customUnitAmount,
          row.pricingState,
          JSON.stringify(row.currencyOptions),
          row.transformQuantityDivideBy,
          row.transformQuantityRound,
        ],
      );
      return true;
    }
    case "upsert_subscription_item": {
      const row = repair.row;
      await tx.query(
        `insert into stripe_subscription_items (
           id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
           stripe_price_id, stripe_product_id, currency, unit_amount, quantity, recurring_interval,
           recurring_interval_count, recurring_usage_type, billing_scheme, custom_unit_amount,
           pricing_state, default_currency, default_unit_amount, price_currency_options,
           currency_option_resolved, transform_quantity_divide_by, transform_quantity_round
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22)
         on conflict (source_id, stripe_subscription_item_id)
         do update set
           stripe_subscription_id = excluded.stripe_subscription_id,
           stripe_price_id = excluded.stripe_price_id,
           stripe_product_id = excluded.stripe_product_id,
           currency = excluded.currency,
           unit_amount = excluded.unit_amount,
           quantity = excluded.quantity,
           recurring_interval = excluded.recurring_interval,
           recurring_interval_count = excluded.recurring_interval_count,
           recurring_usage_type = excluded.recurring_usage_type,
           billing_scheme = excluded.billing_scheme,
           custom_unit_amount = excluded.custom_unit_amount,
           pricing_state = excluded.pricing_state,
           default_currency = excluded.default_currency,
           default_unit_amount = excluded.default_unit_amount,
           price_currency_options = excluded.price_currency_options,
           currency_option_resolved = excluded.currency_option_resolved,
           transform_quantity_divide_by = excluded.transform_quantity_divide_by,
           transform_quantity_round = excluded.transform_quantity_round`,
        [
          `si_${randomUUID()}`,
          scope.workspaceId,
          scope.sourceId,
          row.itemId,
          repair.subscriptionId,
          row.priceId,
          row.productId,
          row.currency,
          row.unitAmount,
          row.quantity,
          row.recurringInterval,
          row.recurringIntervalCount,
          row.recurringUsageType,
          row.billingScheme,
          row.customUnitAmount,
          row.pricingState,
          row.defaultCurrency,
          row.defaultUnitAmount,
          JSON.stringify(row.priceCurrencyOptions),
          row.currencyOptionResolved,
          row.transformQuantityDivideBy,
          row.transformQuantityRound,
        ],
      );
      return true;
    }
    case "delete_subscription_item": {
      await tx.query(
        `delete from stripe_subscription_items
          where workspace_id = $1 and source_id = $2 and stripe_subscription_item_id = $3`,
        [scope.workspaceId, scope.sourceId, repair.itemId],
      );
      return true;
    }
    case "upsert_discount": {
      const row = repair.row;
      await tx.query(
        `insert into stripe_subscription_discounts (
           id, workspace_id, source_id, stripe_subscription_id, target_type, target_id,
           stripe_discount_id, position, amount_off, percent_off, currency, duration, starts_at,
           ends_at, is_complete, incomplete_reason, applies_to_product_ids,
           amount_off_currency_options, currency_option_resolved
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
         on conflict (workspace_id, source_id, stripe_subscription_id, target_type, target_id, position)
         do update set
           stripe_discount_id = excluded.stripe_discount_id,
           amount_off = excluded.amount_off,
           percent_off = excluded.percent_off,
           currency = excluded.currency,
           duration = excluded.duration,
           starts_at = excluded.starts_at,
           ends_at = excluded.ends_at,
           is_complete = excluded.is_complete,
           incomplete_reason = excluded.incomplete_reason,
           applies_to_product_ids = excluded.applies_to_product_ids,
           amount_off_currency_options = excluded.amount_off_currency_options,
           currency_option_resolved = excluded.currency_option_resolved`,
        [
          `sdisc_${randomUUID()}`,
          scope.workspaceId,
          scope.sourceId,
          repair.subscriptionId,
          repair.targetType,
          repair.targetId,
          row.discountId,
          row.position,
          row.amountOff,
          row.percentOff,
          row.currency,
          row.duration,
          row.startsAt,
          row.endsAt,
          row.complete,
          row.incompleteReason,
          row.appliesToProductIds,
          JSON.stringify(row.amountOffCurrencyOptions),
          row.currencyOptionResolved,
        ],
      );
      return true;
    }
    case "delete_discount": {
      await tx.query(
        `delete from stripe_subscription_discounts
          where workspace_id = $1 and source_id = $2 and stripe_subscription_id = $3
            and target_type = $4 and target_id = $5 and position = $6`,
        [
          scope.workspaceId,
          scope.sourceId,
          repair.subscriptionId,
          repair.targetType,
          repair.targetId,
          repair.position,
        ],
      );
      return true;
    }
    case "upsert_invoice": {
      const row = repair.row;
      await tx.query(
        `insert into stripe_invoices (
           id, workspace_id, source_id, stripe_invoice_id, stripe_customer_id,
           stripe_subscription_id, subscription_origin, status, currency, amount_paid, amount_due,
           paid_at, created_at_source, external_order_id, post_payment_credit_notes_amount,
           pre_payment_credit_notes_amount
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (source_id, stripe_invoice_id)
         do update set
           stripe_customer_id = excluded.stripe_customer_id,
           stripe_subscription_id = excluded.stripe_subscription_id,
           subscription_origin = excluded.subscription_origin,
           status = excluded.status,
           currency = excluded.currency,
           amount_paid = excluded.amount_paid,
           amount_due = excluded.amount_due,
           paid_at = excluded.paid_at,
           created_at_source = excluded.created_at_source,
           external_order_id = excluded.external_order_id,
           post_payment_credit_notes_amount = excluded.post_payment_credit_notes_amount,
           pre_payment_credit_notes_amount = excluded.pre_payment_credit_notes_amount`,
        [
          `inv_${randomUUID()}`,
          scope.workspaceId,
          scope.sourceId,
          row.invoiceId,
          row.customerId,
          row.subscriptionId,
          row.subscriptionOrigin,
          row.status,
          row.currency,
          row.amountPaid,
          row.amountDue,
          row.paidAt,
          row.createdAt,
          row.externalOrderId,
          row.postPaymentCreditedMinor,
          row.prePaymentCreditedMinor,
        ],
      );
      return true;
    }
    default: {
      const exhaustive: never = repair;
      throw new Error(`unhandled Stripe reconciliation repair: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Key a difference by the OBJECT, not the drift kind: LOAD can legitimately change the kind. */
function differenceKey(difference: StripeReconciliationDifference): string {
  return `${difference.entityKind}\u0000${difference.objectExternalId}`;
}

export interface StripeReconciliationApplyOptions {
  /**
   * The SAME comparison recomputed against LIVE (post-LOAD) local state.
   *
   * When present, `plan` is the MEASUREMENT (taken against the pre-LOAD projection) and this is the
   * REPAIR set: a difference that no longer exists post-LOAD is recorded as drift and repaired with
   * nothing, while one that survives is repaired from the live plan's repair (which was derived
   * from the same remote row, so it is identical in practice — it is taken from here so a repair is
   * never issued for a state nobody re-verified). Differences that exist ONLY post-LOAD are drift
   * too — the LOAD writers disagreeing with the object Stripe returned — so they are recorded as
   * well rather than silently repaired.
   */
  postLoad?: StripeReconciliationPlan;
}

/**
 * Record every difference and repair the repairable ones, then advance the watermarks.
 *
 * MUST run inside the caller's CLOSE transaction: the drift rows, the canonical repairs and the
 * watermark advance either all land or none do. A partially applied reconciliation that still
 * advanced `reconciled_at` would claim a full-set comparison it never completed.
 */
export async function applyReconciliation(
  tx: InfiniteOsDb,
  plan: StripeReconciliationPlan,
  scope: StripeReconciliationApplyScope,
  options: StripeReconciliationApplyOptions = {},
): Promise<StripeReconciliationOutcome> {
  if (plan.workspaceId !== scope.workspaceId || plan.sourceId !== scope.sourceId) {
    throw new Error("Stripe reconciliation plan does not belong to the applying scope");
  }
  if (plan.runStartedAt !== scope.runStartedAt) {
    throw new Error("Stripe reconciliation plan run start disagrees with the applying scope");
  }
  const postLoad = options.postLoad;
  if (postLoad && (
    postLoad.workspaceId !== scope.workspaceId
    || postLoad.sourceId !== scope.sourceId
    || postLoad.runStartedAt !== scope.runStartedAt
  )) {
    throw new Error("Stripe reconciliation post-load plan does not belong to the applying scope");
  }

  // Same lock + ownership discipline as the MRR CLOSE: the boot sweep can reset a `syncing` source
  // to `connected` and let a competing claim take over WHILE this run is still committing. Writing
  // repairs into a table the new owner is mid-replacement of would manufacture drift and repairs
  // out of a torn snapshot.
  const locked = await tx.query<{ id: string }>(
    `select id from sources
      where id = $1 and workspace_id = $2 and provider = 'stripe'
      for update`,
    [scope.sourceId, scope.workspaceId],
  );
  if (!locked[0]) {
    throw new Error("Stripe reconciliation source is missing or outside workspace scope");
  }
  const owning = await tx.query<{ id: string }>(
    `select id from sync_runs
      where id = $1 and workspace_id = $2 and source_id = $3 and status = 'running'`,
    [scope.syncRunId, scope.workspaceId, scope.sourceId],
  );
  if (!owning[0]) {
    throw new StripeReconciliationClaimLostError(
      "Stripe reconciliation aborted: the sync claim belongs to another run",
    );
  }

  const countsByKind: Record<StripeReconciliationDriftKind, number> = {
    missing_local: 0,
    missing_remote: 0,
    state_mismatch: 0,
  };
  let repairedCount = 0;
  let recordedOnlyCount = 0;
  let healedByLoadCount = 0;

  // THE LEDGER IS THE UNION. `plan` measures what was wrong BEFORE this sync's LOAD; `postLoad`
  // measures what is still wrong after it. Recording only the first would miss a writer that
  // introduced a difference; recording only the second is the structural blindness this whole
  // seam exists to fix. Pre-load rows win the shape of the record (they are the honest description
  // of what the delta lane missed); post-load-only rows are appended.
  const survivors = new Map<string, StripeReconciliationDifference>();
  if (postLoad) for (const difference of postLoad.differences) {
    survivors.set(differenceKey(difference), difference);
  }
  const recorded: {
    difference: StripeReconciliationDifference;
    repair: StripeReconciliationRepair | null;
    observedAfterLoad: boolean;
    postLoadDriftKind: StripeReconciliationDriftKind | null;
  }[] = [];
  const measuredKeys = new Set<string>();
  for (const difference of plan.differences) {
    const key = differenceKey(difference);
    measuredKeys.add(key);
    // With no post-load plan the caller never separated measurement from repair, so the plan IS
    // both — exactly the pre-existing behaviour, kept for the bootstrap run and direct callers.
    const survivor = postLoad ? survivors.get(key) ?? null : difference;
    recorded.push({
      difference,
      repair: survivor ? survivor.repair : null,
      observedAfterLoad: false,
      postLoadDriftKind: survivor && survivor.driftKind !== difference.driftKind
        ? survivor.driftKind
        : null,
    });
  }
  if (postLoad) for (const difference of postLoad.differences) {
    if (measuredKeys.has(differenceKey(difference))) continue;
    recorded.push({
      difference,
      repair: difference.repair,
      observedAfterLoad: true,
      postLoadDriftKind: null,
    });
  }

  for (const entry of recorded) {
    const { difference } = entry;
    const repaired = entry.repair === null
      ? false
      : await applyRepair(tx, scope, entry.repair);
    if (repaired) repairedCount += 1;
    else recordedOnlyCount += 1;
    // `none` is unrepairable by contract; a null repair means the full replacement got there first.
    const marker: StripeReconciliationRepairMarker = repaired
      ? "direct"
      : entry.repair === null ? "full_replacement" : "none";
    if (marker === "full_replacement") healedByLoadCount += 1;
    countsByKind[difference.driftKind] += 1;
    const baseDetail = difference.repair.action === "none" && difference.detail === null
      ? { reason: difference.repair.reason }
      : difference.detail;
    const detail: Record<string, unknown> = {
      ...(baseDetail ?? {}),
      repair: marker,
      ...(entry.observedAfterLoad ? { observedAfterLoad: true } : {}),
      ...(entry.postLoadDriftKind ? { postLoadDriftKind: entry.postLoadDriftKind } : {}),
    };
    await tx.query(
      `insert into stripe_reconciliation_drift (
         id, workspace_id, source_id, run_started_at, entity_kind, object_external_id,
         drift_kind, repaired, detail
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        `stripe_drift_${randomUUID()}`,
        scope.workspaceId,
        scope.sourceId,
        plan.runStartedAt,
        difference.entityKind,
        difference.objectExternalId,
        difference.driftKind,
        repaired,
        detail === null ? null : JSON.stringify(detail),
      ],
    );
  }

  const driftDetected = recorded.length > 0;
  // ZERO DRIFT STILL ADVANCES `reconciled_at` — that IS the healthy signal the relax-to-weekly
  // decision reads. `last_drift_at` moves only when something actually differed.
  await tx.query(
    `insert into stripe_sync_watermarks (id, workspace_id, source_id, reconciled_at, last_drift_at, updated_at)
     values ($1,$2,$3,$4,${driftDetected ? "now()" : "null"},now())
     on conflict (workspace_id, source_id)
     do update set
       reconciled_at = excluded.reconciled_at,
       last_drift_at = ${driftDetected ? "now()" : "stripe_sync_watermarks.last_drift_at"},
       updated_at = now()`,
    [
      `stripe_watermarks_${randomUUID()}`,
      scope.workspaceId,
      scope.sourceId,
      plan.runStartedAt,
    ],
  );

  return {
    driftCount: recorded.length,
    repairedCount,
    recordedOnlyCount,
    healedByLoadCount,
    countsByKind,
    reconciledAt: plan.runStartedAt,
    driftDetected,
  };
}

// ---------------------------------------------------------------------------
// Scheduling.
// ---------------------------------------------------------------------------

export interface StripeReconciliationWatermarkState {
  reconciledAt: string | null;
}

/**
 * Immediate-trigger inputs. The integrator owns each source of truth; this module only decides.
 *  • `retentionCoverageGap`      — the delta lane could not cover a window (>30d event retention,
 *                                  a lost cursor, a reset segment). The snapshot must be re-proven.
 *  • `credentialOutageRecovered` — the key was revoked/expired and came back; anything that changed
 *                                  while we were locked out emitted events we can no longer read.
 *  • `apiVersionChanged`         — field semantics may have shifted under the normalizers.
 *  • `invariantFailure`          — a metric guard tripped (fail-closed view went `unavailable`,
 *                                  an items/discounts completeness flag disagrees with its rows).
 */
export interface StripeReconciliationTriggers {
  retentionCoverageGap: boolean;
  credentialOutageRecovered: boolean;
  apiVersionChanged: boolean;
  invariantFailure: boolean;
}

export type StripeReconciliationDueReason =
  | "never_reconciled"
  | "invariant_failure"
  | "retention_coverage_gap"
  | "api_version_change"
  | "credential_outage_recovery"
  | "interval_elapsed";

export interface StripeReconciliationDueDecision {
  due: boolean;
  /** Deterministic precedence, most fundamental first; null only when not due. */
  reason: StripeReconciliationDueReason | null;
  intervalMs: number;
}

export function reconciliationDue(
  watermarks: StripeReconciliationWatermarkState | null,
  now: string,
  options: {
    triggers?: Partial<StripeReconciliationTriggers>;
    intervalMs?: number;
  } = {},
): StripeReconciliationDueDecision {
  const intervalMs = options.intervalMs ?? STRIPE_RECONCILIATION_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid Stripe reconciliation interval: ${String(options.intervalMs)}`);
  }
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) throw new Error(`unparseable Stripe reconciliation now: ${now}`);

  const reconciledAt = watermarks?.reconciledAt ?? null;
  if (!reconciledAt) return { due: true, reason: "never_reconciled", intervalMs };

  const triggers = options.triggers ?? {};
  if (triggers.invariantFailure) return { due: true, reason: "invariant_failure", intervalMs };
  if (triggers.retentionCoverageGap) {
    return { due: true, reason: "retention_coverage_gap", intervalMs };
  }
  if (triggers.apiVersionChanged) return { due: true, reason: "api_version_change", intervalMs };
  if (triggers.credentialOutageRecovered) {
    return { due: true, reason: "credential_outage_recovery", intervalMs };
  }

  const reconciledMs = new Date(reconciledAt).getTime();
  if (Number.isNaN(reconciledMs)) {
    throw new Error(`unparseable Stripe reconciled_at watermark: ${reconciledAt}`);
  }
  if (nowMs - reconciledMs >= intervalMs) {
    return { due: true, reason: "interval_elapsed", intervalMs };
  }
  return { due: false, reason: null, intervalMs };
}

/** Read the reconciliation half of the delta lane's watermark row (lane B owns the other columns). */
export async function readStripeReconciliationWatermarks(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
): Promise<StripeReconciliationWatermarkState | null> {
  const row = await tx.one<{ reconciled_at: string | Date | null }>(
    `select reconciled_at from stripe_sync_watermarks
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
  if (!row) return null;
  const value = row.reconciled_at;
  return {
    reconciledAt: value === null
      ? null
      : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  };
}
