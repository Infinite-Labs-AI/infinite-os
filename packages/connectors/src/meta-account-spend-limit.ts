/**
 * The ad account SPENDING LIMIT — Meta's account-level `spend_cap` — and the spend Meta counts
 * toward it (`amount_spent`).
 *
 * NO NEW REQUEST. Both are fields of the ad account node, so they ride on the account read the sync
 * already makes (`GET /act_<id>`, telemetry kind `account_liveness`): every full sync, and at most once
 * per 24h on an inventory scan (meta-account-liveness.ts). The insights-only lanes never read the node,
 * so they never touch these values. Same request count, same per-account 24h request budget.
 *
 * UNITS, exactly as Meta returns them (Graph Ad Account reference):
 *   - `spend_cap` (numeric string): "The maximum amount that can be spent by this Ad Account. When the
 *     amount is reached, all delivery stops. A value of `0` means no spending-cap. ... Value specified
 *     in basic unit of the currency, for example 'cents' for `USD`."
 *   - `amount_spent` (numeric string): "Current amount spent by the account with respect to
 *     `spend_cap`. Or total amount in the absence of `spend_cap`." Same unit as `spend_cap`.
 * The basic unit follows Meta's per-currency OFFSET (marketing-api/currencies), not ISO 4217: offset
 * 100 for USD/GBP/EUR (cents), offset 1 for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG, TWD, VND
 * (whole units). A reader converts with Meta's offset table, never with ISO minor digits.
 * (Writing it back is different: the update takes the STANDARD denomination, e.g. 23.50 for $23.50,
 * and `spend_cap_action` = `reset` zeroes amount_spent / `delete` removes the limit. That is the
 * server's write path, not this read.)
 *
 * STORED AS RETURNED, never reinterpreted: "0" stays 0 and an absent field stays null. Both mean "no
 * limit set" to a reader, and neither is ever shown as a $0 limit. A value that is not a whole
 * number of basic units is UNREADABLE: the read records no measurement at all, so the previous one
 * (with its own read time) stands, or the reader keeps showing unmeasured. A number we cannot trust
 * the unit of is never stored.
 */

/** The account node fields: the sync's identity/metadata read plus the spending limit, one request. */
export const META_ADS_ACCOUNT_NODE_FIELDS = "id,account_id,currency,timezone_name,spend_cap,amount_spent";

export interface MetaAdsAccountSpendLimit {
  /** Meta's `spend_cap` in the currency's basic unit; "0" or null = no limit set. */
  spendCap: string | null;
  /** Meta's `amount_spent` in the same unit (toward the limit; the lifetime total when none is set). */
  amountSpent: string | null;
}

export type MetaAdsAccountSpendLimitRead =
  | ({ kind: "measured" } & MetaAdsAccountSpendLimit)
  | { kind: "unreadable"; field: "spend_cap" | "amount_spent" };

// A bigint holds 18 digits safely; Meta's basic units never approach it, and anything longer would
// fail the CLOSE transaction instead of the one field.
const WHOLE_BASIC_UNITS = /^\d{1,18}$/;

type BasicUnitAmount = { ok: true; value: string | null } | { ok: false };

function basicUnitAmount(value: unknown): BasicUnitAmount {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string" && WHOLE_BASIC_UNITS.test(value)) return { ok: true, value };
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return { ok: true, value: String(value) };
  return { ok: false };
}

/** Read the spending limit off an account node body (the same response the sync already parsed). */
export function metaAdsAccountSpendLimitRead(body: Record<string, unknown>): MetaAdsAccountSpendLimitRead {
  const spendCap = basicUnitAmount(body.spend_cap);
  if (!spendCap.ok) return { kind: "unreadable", field: "spend_cap" };
  const amountSpent = basicUnitAmount(body.amount_spent);
  if (!amountSpent.ok) return { kind: "unreadable", field: "amount_spent" };
  return { kind: "measured", spendCap: spendCap.value, amountSpent: amountSpent.value };
}
