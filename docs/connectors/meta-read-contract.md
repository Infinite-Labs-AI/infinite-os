# Meta read and request accounting contract

Meta reporting preserves provider-grain aggregates and the explicit attribution windows recorded
with the data. Campaign/adset values are not reconstructed by summing ads: reach and frequency
are not additive. Archived entities remain in dimension reads because historical delivery and
creative provenance can still reference them. Missing reach/frequency remain null.

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
