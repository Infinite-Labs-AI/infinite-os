-- 0039_connection_credentials_metadata.sql
-- Non-secret operational metadata the engine keeps per-connection. Secrets (tokens) stay
-- inside encrypted_payload; these columns let the engine query selection/telemetry without
-- decrypting. All nullable → existing rows untouched.
-- NOTE: token expiry reuses the EXISTING expires_at column (added migration 0021);
--       account_external_id is intentionally NOT added (lives on sources, joined via source_id).
alter table connection_credentials
  add column if not exists selected_pixel_id     text,            -- Meta CAPI pixel selection (NULL until chosen)
  add column if not exists is_system_user        boolean not null default false, -- system-user token vs OAuth user token
  add column if not exists last_dispatch_at       timestamptz,    -- last CAPI/MP dispatch attempt (Phase 3 telemetry)
  add column if not exists last_dispatch_status   text,           -- 'succeeded' | 'failed' | NULL
  add column if not exists last_error             text;           -- last write/dispatch error message (no secrets)
-- system-user tokens are long-lived → expires_at stays NULL for them; OAuth user tokens
-- populate the existing expires_at column (reused, not duplicated).

-- Partial-unique index so connectSource's `on conflict (source_id, credential_kind)` upsert
-- (P0-B2) has a matching constraint. Partial on `revoked_at is null` so revoked credentials
-- never block a re-connect of the same kind (one live row per kind; revoked history allowed).
create unique index if not exists connection_credentials_source_kind_uq
  on connection_credentials (source_id, credential_kind)
  where revoked_at is null;
