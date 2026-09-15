# Meta Ads daily history

Meta history uses the existing provider-reported campaign/day, ad-set/day and ad/day delivery facts
and matching typed conversion facts. Each grain is authoritative on its own; campaign and ad-set
conversions are never derived by summing ads. Delivery ratios are recomputed from summed bases.

`meta_ads_coverage_daily` is the measurement receipt. A row is written only after the provider
extract, every 500-row load chunk, exact-window replacement and CLOSE transaction succeed. A receipt
with `row_count = 0` means measured zero. No receipt means unmeasured. Normalized facts have no
age-based deletion policy.

The direct-Graph sync fully paginates every supported entity and insight page within a hard request
budget. `sync_runs.request_telemetry` records requests, accepted pages, retries, bounded utilization
samples and remaining budget. Each request is durably reserved before fetch so a hard process stop
cannot hide provider spend. A budget stop fails the run and writes no coverage or cursor.

`meta_ads_entity_versions` records metadata changes for campaigns, ad sets, ads and creatives.
Targeting, placement selections, promoted objects, copy and creative descriptors live in bounded
JSON; media bytes do not. Creative rows expose `asset_descriptors` entries shaped as
`{slotKey, kind, providerAssetId, slotFingerprint, sourceUrl, sourceLocator}` for a closed cloud
worker to archive into workspace-owned object storage. `sourceUrl` is always `null` for provider
media. URL-only slots keep a stable `slotFingerprint` plus a query-free `sourceLocator` of
`{host, path}` so the archive worker can refresh by creative id + slot without storing Meta's signed
media URL. Provider tokens, authorization fields and media query strings are removed before
raw/normalized storage.

Reporting dates are Meta account-local calendar dates. `meta_ads_accounts.timezone_name` and
`currency` are the sole Meta account metadata authority. Optional demographic, placement and device
insight breakdowns are not collected by this schema and must never be inferred from the base facts.
