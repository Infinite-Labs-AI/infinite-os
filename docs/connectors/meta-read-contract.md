# Meta read and request accounting contract

Meta reporting preserves provider-grain aggregates and the explicit attribution windows recorded
with the data. Campaign/adset values are not reconstructed by summing ads: reach and frequency
are not additive. Archived entities remain in dimension reads because historical delivery and
creative provenance can still reference them. Live insight reads preserve missing reach/frequency
as null. Migration 0070 makes stored daily reach nullable and drops the zero default. New missing provider
values remain null; measured zero remains zero. Historical zero rows are not rewritten because
the original missing-versus-zero provenance is unknown. Frequency is not persisted in daily tables.

Meta omits archived and deleted objects' stats from `/<PARENT>/insights?level=<OBJECT_LEVEL>`
results by default ("Manage Your Ad Object's Status",
https://developers.facebook.com/docs/marketing-api/best-practices/storing_adobjects). Every
direct-Graph history insight read therefore filters `<level>.effective_status` IN every documented
status of that object (`metaAdsAllStatusFiltering`): the hot lane's ad read and the settled,
restatement, backfill and attended-refresh reads at all three grains. Without it a deleted ad's
day is missing from settled ad rows, ad rows stop summing to Meta's campaign row, and the settled
CLOSE prunes the hot lane's row for that ad.

The open-day hot lane is the one place parent rows ARE derived by summing ads; those rows carry
`reach = NULL` (unmeasured). The engine's reach metric sums measured rows only, frequency divides
measured rows' impressions by their reach, and both answers carry `reach_excludes_unmeasured_days`
when the queried scope held an unmeasured row (migration 0071 records this in the catalog).

Inventory scans (`inventory_only`) read the ad account node (`account_liveness`) at most once per
24h, tracked by the `meta_ads_account_liveness:<act>` cursor committed at CLOSE. The scan's own
entity reads fail with the same credential-grade error on a revoked token, so skipping the read
does not delay detection.

Recurring refresh reconciles at most 35 settled provider days. Explicit date ranges and backfills
keep their requested bounds (subject to the existing 37-month backfill retention floor). A
YYYY-MM-DD input denotes a provider date, not an instant to convert into another timezone.
All three direct-Graph insight grains use calendar-month chunks for wide windows, with week
fallback on the provider's data-volume error. Partial pages from a failed month are discarded
before narrower retry, avoiding duplicate staging. Insight pages and narrow dimension/status
pages request 500 rows; creative-expanded edges retain 100 to avoid known data-complexity errors.
Cursors still run to completion or fail explicitly at the page guard.

`MetaAdsRequestTelemetry` admits every direct Graph request before dispatch, including pagination,
status enrichment and retries. Its async reservation callback must fail closed if durable admission
cannot be written. `createActionHandlers({ metaAdsRequestTelemetry })` threads this observer to
explicit live insights and entity list/detail reads. MCP/ambient CLI accounting measures engine
transport invocations; it cannot measure hidden provider requests inside an external tool.

The fourth constructor argument receives an awaited `MetaAdsResponseSignal` after each response;
`SyncRequest.metaAdsOnResponse` provides the same hook for sync. Hosts can persist account cooldown
state there and enforce it at admission. Callback failures stop the operation. Signals include
app/account/BUC utilization, access tier, BUC regain converted from minutes to seconds, account
reset duration in seconds, and classified throttle errors even when reported utilization is low.
A successful hot page is consumed once. Telemetry holds later requests until cooldown instead of
re-fetching accepted data. Requests already in flight cannot be withdrawn by a later response.

The product API support baseline is v25.0. An explicit older or malformed credential version fails
with non-retryable `provider_api_version_unsupported` before a Graph request. Overrides are never
silently clamped, including for writes. This policy is not a claim about Meta's version expiry
schedule. Newer syntactically valid versions remain explicit operator choices.

`result_values_performance_indicator` is retained: Meta's official generated Python SDK declares
it in AdsInsights, so absence from a retrieved documentation page is not evidence it is invalid:
https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py

Header definitions: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
