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

-- DEDUPE BEFORE INDEX (boot-safety): pre-P0-B, connectSource did a plain INSERT (new random id,
-- no `on conflict`) and never set revoked_at, so any install that re-connected a source has
-- MULTIPLE live (revoked_at is null) rows with the same (source_id, credential_kind). The partial-
-- unique index below cannot be built over that data — it aborts with 23505 unique_violation, the
-- atomic migration runner rolls 0039 back, and (because the daemon auto-migrates on boot) the
-- daemon then fails to start on EVERY boot. So collapse duplicates FIRST: keep the NEWEST live row
-- per (source_id, credential_kind) and revoke the rest. This is idempotent (a no-op once deduped)
-- and preserves history (revoked rows remain; the index is partial on revoked_at is null). The
-- surviving row is the freshest credential — exactly the one connectSource's upsert keeps writing to.
update connection_credentials c
   set revoked_at = now(),
       updated_at = now()
  from (
    select id,
           row_number() over (
             partition by source_id, credential_kind
             order by created_at desc, id desc
           ) as rn
      from connection_credentials
     where revoked_at is null
  ) dup
 where c.id = dup.id
   and dup.rn > 1;

-- Partial-unique index so connectSource's `on conflict (source_id, credential_kind)` upsert
-- (P0-B2) has a matching constraint. Partial on `revoked_at is null` so revoked credentials
-- never block a re-connect of the same kind (one live row per kind; revoked history allowed).
create unique index if not exists connection_credentials_source_kind_uq
  on connection_credentials (source_id, credential_kind)
  where revoked_at is null;
