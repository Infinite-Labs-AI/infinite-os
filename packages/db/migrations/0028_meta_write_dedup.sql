-- Atomic idempotency for Meta Ads create writes (money-safety INVARIANT 4).
--
-- The create-dedup was previously a non-atomic check-then-POST that scanned
-- integration_audit_log for a prior succeeded create carrying the same
-- client_token. With no backing UNIQUE constraint, two concurrent creates with
-- the SAME (workspace_id, source_id, client_token) could both pass the check and
-- both POST to the Graph API — double-spending money once activated.
--
-- This adds a dedicated dedup ledger with a UNIQUE key on
-- (workspace_id, source_id, client_token). The create handler CLAIMS the key
-- (insert) BEFORE the Graph POST: the DB rejects a second concurrent claim with
-- a unique violation, so exactly one create can POST. On a unique violation the
-- handler reads back the winner's entity_id and returns it with deduped:true.
--
-- client_token remains OPTIONAL: a create WITHOUT a client_token writes NO row
-- here and is intentionally NOT deduped (opt-out — the caller accepts that a
-- retried tokenless create may POST twice). Only tokenful creates are atomic.
--
-- The runMigrations runner already wraps every migration file in begin/commit,
-- so this file is not wrapped again here.

create table if not exists meta_write_dedup (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  client_token text not null,
  -- The Graph entity id once the create succeeds. NULL while a claim is in
  -- flight (claimed but the POST has not returned yet); backfilled on success.
  entity_id text,
  -- campaign | adset | ad | creative — which create produced this row.
  entity text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- The atomicity guarantee: at most ONE row per (workspace, source, token). A
-- second concurrent same-token create raises a unique violation on its claim
-- insert, which the handler catches and resolves to deduped:true.
create unique index if not exists meta_write_dedup_key_uq
  on meta_write_dedup (workspace_id, source_id, client_token);

-- The Meta write handlers run under the app role (same role that inserts
-- integration_audit_log in 0006). It needs to claim, resolve, and read dedup
-- rows. A recreated/new table is not covered by 0006's apply-time blanket grant.
do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_app') then
    grant select, insert, update on meta_write_dedup to growth_os_app;
  end if;
end $$;
