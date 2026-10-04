# Meta entity inventory: incremental discovery

[Codex] Ads and ad sets use `updated_since` (epoch seconds), supported by Meta's generated Business SDK. Campaigns do not expose that parameter there and retain a full paginated read. This only changes entity metadata discovery; insights continue reading and replacing complete date windows, since delivery/conversions can change without an ad-settings update.

[Codex] The first successful scan establishes an account-scoped baseline. Subsequent scans request changes since the previous successfully committed scan **start**, minus five minutes. Follow all pages in that filtered response; never stop on a familiar ID or assume ID/date ordering. Unchanged entity metadata from the database still supplies dimensions such as ad-set conversion optimization while interpreting insights. Only fresh provider objects are stamped as freshly observed.

[Codex] A delta upserts returned entities and preserves omitted ads, ad sets and creatives. Only the still-complete campaign edge can close absent campaign metadata during a delta. A full inventory reconciliation runs at least daily to detect removals or changes outside the overlap. DELETED is deliberately not added to the existing status filter: a live ads-edge probe returned Meta100/1815001 when it was included. No insight rows or zero metrics are synthesized for newly discovered entities.

[Codex] Two existing `sync_cursors` keys per source/account store the last successful scan start and full scan start. Both are written inside successful CLOSE alongside fact/coverage publication, with monotonic updates. A failed page, failed insight request, partial load, revoked source, or failed CLOSE cannot advance discovery. The reporting-window cursor remains separate, including on historical backfills. No schema migration is needed.

[Codex] Verification: a real PGlite integration starts with old ads, receives an existing changed ad plus ten new ads across two pages, preserves omitted existing ads, and refuses checkpoint advancement after page-two failure. Full-reconciliation tests prove actual disappearance closes old versions. The complete engine suite and typecheck also exercise existing metric derivation and failure handling. Live read-only verification against a connected account returned one newly created paused ad for a recent cutoff and zero ads for a future cutoff, without walking its old inventory.

[Codex] Reference: https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py (`get_ads`, `get_ad_sets`, `get_campaigns`).

[Codex] Independent review: a separate reviewer found no code correctness blockers after examining source-claim/credential fences, checkpoint advancement, pagination, cached dimensions and removal semantics, and independently rerunning16 tests/typecheck. All new helper/test/docs files are explicitly included in the commit.
