/**
 * How often the Meta inventory lane re-reads the ad account node (`GET /act_<id>`, telemetry kind
 * `account_liveness`).
 *
 * WHAT THAT READ IS FOR. It requests `id,account_id,currency,timezone_name` and checks the returned
 * id against the connected source. On an `inventory_only` run nothing else consumes it: the run
 * returns before the insights passes, so its currency/timezone never reach `meta_ads_accounts`
 * (only a history CLOSE writes that row, and the insights-only lanes read the STORED row instead of
 * calling Meta). It also cannot see a disabled account — it never asks for `account_status`.
 *
 * WHY IT DOES NOT NEED TO RUN EVERY SCAN. Its only remaining job on the inventory lane is to fail
 * the run when the token is revoked or loses access, and the entity edge reads that follow it in
 * the same run already do that with the same token and the same fetch path: a 401/403 is typed
 * `provider_auth_failed`, and a 400 OAuthException (code 190/102/200/10) or a permission-class body
 * (100/33, 3, 294, 270) carries the body that `classifySyncFailure` reads as terminal. Either way
 * the run fails with an identical recorded error. (An inventory failure never parks the source —
 * recordSyncFailure restores the claim for inventory_only runs, with or without this read; parking
 * a revoked source is the history lanes' job, and the hot lane calls Meta every 15-30 minutes
 * without ever making this read.) The source/credential account binding is a database check that
 * still runs on every scan. So the read costs one request per scan (12+/day/account at the 2-hour
 * cadence, out of a shared 300/24h budget) while adding no detection.
 *
 * It is kept once per 24 hours as a slow identity/metadata probe; the timestamp of the last
 * successful read is committed at CLOSE (so a failed run never suppresses the next read).
 */
export const META_ADS_ACCOUNT_LIVENESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function metaAdsAccountLivenessCursorKey(adAccountId: string): string {
  return `meta_ads_account_liveness:${adAccountId}`;
}

/**
 * True when the inventory lane must read the account node this run: never read, unparseable,
 * a timestamp in the future (clock skew — never trust it to suppress a read), or 24h+ old.
 */
export function metaAdsAccountLivenessDue(lastReadAt: string | null, now: Date): boolean {
  if (!lastReadAt) return true;
  const readAt = Date.parse(lastReadAt);
  if (!Number.isFinite(readAt)) return true;
  const age = now.getTime() - readAt;
  return age < 0 || age >= META_ADS_ACCOUNT_LIVENESS_MAX_AGE_MS;
}
