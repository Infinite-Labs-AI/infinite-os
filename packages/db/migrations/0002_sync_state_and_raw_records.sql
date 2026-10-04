create table sync_runs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_extracted integer default 0,
  records_loaded integer default 0,
  error text
);

create table sync_batches (
  id text primary key,
  sync_run_id text not null references sync_runs(id),
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  status text not null,
  batch_type text not null,
  cursor_key text,
  cursor_start text,
  cursor_end text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_seen integer default 0,
  records_written integer default 0,
  error text
);

create table raw_records (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  sync_batch_id text references sync_batches(id),
  provider text not null check (provider in ('google_analytics_4', 'posthog', 'stripe')),
  object_type text not null,
  external_id text,
  payload jsonb not null,
  payload_version text,
  source_record_hash text not null,
  extracted_at timestamptz not null default now(),
  source_updated_at timestamptz,
  unique (source_id, object_type, external_id, source_record_hash)
);

create table sync_batch_records (
  id text primary key,
  sync_batch_id text not null references sync_batches(id),
  raw_record_id text not null references raw_records(id),
  record_status text not null,
  error text
);

create table sync_cursors (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  cursor_key text not null,
  cursor_value text not null,
  updated_at timestamptz not null default now(),
  unique (source_id, cursor_key)
);

create table sync_errors (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  sync_run_id text references sync_runs(id),
  sync_batch_id text references sync_batches(id),
  error_code text not null,
  error_message text not null,
  retryable boolean not null default false,
  created_at timestamptz not null default now()
);

create index raw_records_workspace_source_extracted_at_idx
  on raw_records(workspace_id, source_id, extracted_at);
create index raw_records_provider_object_type_idx
  on raw_records(provider, object_type);
create index raw_records_source_object_external_idx
  on raw_records(source_id, object_type, external_id);
