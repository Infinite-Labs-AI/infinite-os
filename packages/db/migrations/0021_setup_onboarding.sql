-- 0021_setup_onboarding.sql
-- Foundation tables for the /setup analytics onboarding feature.

create table workspace_sites (
  id text primary key,
  workspace_id text not null references workspaces (id) on delete cascade,
  url text not null,
  repo_path text,
  app_dir text,
  framework text,
  business_type text,
  runs_paid_ads boolean,
  verified_owner boolean not null default false,
  verification_method text,
  verified_at timestamptz,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index workspace_sites_primary_unique_idx
  on workspace_sites (workspace_id) where is_primary;

create table setup_runs (
  id text primary key,
  workspace_id text not null references workspaces (id) on delete cascade,
  tool text not null,
  provider text,
  status text not null default 'running',
  phase_state jsonb not null default '{}'::jsonb,
  pending_handoff jsonb,
  browser_profile text,
  site_id text references workspace_sites (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
-- One active run per (workspace, tool): concurrency guard for the resumable orchestrator.
create unique index setup_runs_active_unique_idx
  on setup_runs (workspace_id, tool)
  where status in ('running', 'paused_handoff');

create table oauth_apps (
  id text primary key,
  workspace_id text not null references workspaces (id) on delete cascade,
  provider text not null,
  encrypted_payload text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, provider)
);

create table oauth_tokens (
  id text primary key,
  workspace_id text not null references workspaces (id) on delete cascade,
  provider text not null,
  source_id text,
  encrypted_payload text not null,
  expires_at timestamptz,
  last_rotated_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index oauth_tokens_workspace_provider_idx on oauth_tokens (workspace_id, provider);

-- Credential rotation tracking (v6 §7.6).
alter table connection_credentials add column if not exists expires_at timestamptz;
alter table connection_credentials add column if not exists last_rotated_at timestamptz;

-- Role grants: app + worker only. tool_agent/read_api are blocked by the
-- schema-level `revoke all` in 0006_security_roles.sql, so new public-schema
-- tables are inaccessible to them by default; we grant explicitly to app+worker.
grant select, insert, update on workspace_sites, setup_runs to growth_os_app;
grant select, insert, update on oauth_apps, oauth_tokens to growth_os_app;
grant select, insert, update on oauth_apps, oauth_tokens to growth_os_worker;
grant select on workspace_sites, setup_runs to growth_os_worker;
