-- Bridge connection_credentials to the live oauth_tokens row so OAuth syncs read the
-- rotated token instead of a stale copy.
--
-- For OAuth providers (e.g. GA4) the access token previously lived in TWO places: the
-- oauth_tokens row (where refresh rotates it) and a copy inside
-- connection_credentials.encrypted_payload (where the sync engine reads it). After a refresh
-- only oauth_tokens advanced, so sync kept reading the stale copy. This migration adds an FK
-- bridge column so the sync read path can follow it to the live token and refresh on demand.
--
-- This change is ADDITIVE and BACKWARD COMPATIBLE:
--   * connection_credentials rows with oauth_token_id IS NULL keep reading their own
--     encrypted_payload exactly as before (non-OAuth credentials such as the PostHog personal
--     key or the X bearer token, plus any un-migrated OAuth rows).
--   * No payloads are re-encrypted and GROWTH_OS_ENCRYPTION_KEY is untouched.
--
-- The column inherits the existing connection_credentials table grants (the same pattern used
-- by 0021's expires_at/last_rotated_at additions), so no new grants are required.
--
-- The runMigrations runner already wraps every migration file in begin/commit.

-- (a) Add the FK bridge column. NULL means "read encrypted_payload" (the legacy path).
alter table connection_credentials
  add column if not exists oauth_token_id text references oauth_tokens (id);

-- (b) Backfill existing GA4 OAuth credentials to point at their live oauth_tokens row.
-- connection_credentials ties to a source_id; join through sources to recover the provider,
-- then match the most recent non-revoked oauth_tokens row for the same
-- (workspace_id, provider='google_analytics_4'). Only migrate active OAuth-access-token
-- credentials so non-OAuth and revoked rows are left on the legacy encrypted_payload path.
update connection_credentials cc
set oauth_token_id = picked.oauth_token_id
from (
  select
    cc.id as credential_id,
    (
      select ot.id
      from oauth_tokens ot
      where ot.workspace_id = s.workspace_id
        and ot.provider = 'google_analytics_4'
        and ot.revoked_at is null
      order by ot.last_rotated_at desc nulls last, ot.created_at desc
      limit 1
    ) as oauth_token_id
  from connection_credentials cc
  join sources s on s.id = cc.source_id
  where cc.credential_kind = 'oauth_access_token'
    and cc.revoked_at is null
    and cc.oauth_token_id is null
    and s.provider = 'google_analytics_4'
) as picked
where cc.id = picked.credential_id
  and picked.oauth_token_id is not null;
