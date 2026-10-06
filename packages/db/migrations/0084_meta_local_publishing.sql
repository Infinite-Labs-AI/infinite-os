-- Local operator publishing evidence. Stores safe IDs and opaque bindings, never credentials.
create table if not exists meta_local_publish_identity (
  workspace_id text not null,
  source_id text not null,
  actor_id text not null,
  operation_id text not null,
  binding_hash text not null,
  identity_json jsonb,
  verified_at timestamptz,
  claim_token text,
  claim_until timestamptz,
  primary key(workspace_id,source_id,actor_id,operation_id)
);
create table if not exists meta_local_publish_cooldown (
  account_id text primary key,
  throttle_until timestamptz not null
);
-- Local retry identity is stronger than the legacy host-provided opaque token.
-- Cloud isolated-server creates keep their existing action-hash-bound token protocol.
alter table meta_write_dedup add column if not exists actor_id text;
alter table meta_write_dedup add column if not exists input_hash text;

-- The daemon app role owns this write surface; read-only tools receive no grants.
do $$
begin
  if exists (select 1 from pg_roles where rolname='growth_os_app') then
    grant select,insert,update on meta_local_publish_identity,meta_local_publish_cooldown to growth_os_app;
    grant delete on meta_write_dedup to growth_os_app;
  end if;
end $$;
