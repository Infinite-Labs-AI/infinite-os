create table workspaces (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table datasets (
  id text primary key,
  workspace_id text not null references workspaces(id),
  key text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table sources (
  id text primary key,
  workspace_id text not null references workspaces(id),
  dataset_id text not null references datasets(id),
  provider text not null check (provider in ('google_analytics_4', 'posthog', 'stripe')),
  connection_name text not null,
  account_external_id text,
  status text not null check (status in ('pending_credentials', 'connected', 'syncing', 'degraded', 'revoked', 'error')),
  sync_mode text not null default 'incremental',
  connected_at timestamptz,
  last_synced_at timestamptz,
  unique (workspace_id, provider, account_external_id, connection_name)
);

create table source_scopes (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  scope_key text not null,
  scope_label text,
  granted_at timestamptz not null default now(),
  unique (source_id, scope_key)
);

create table connection_credentials (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  credential_kind text not null,
  encrypted_payload text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table integration_audit_log (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text references sources(id),
  actor_type text not null,
  action text not null,
  status text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
