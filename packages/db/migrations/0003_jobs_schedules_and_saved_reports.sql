create table job_runs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  job_type text not null check (job_type in ('source_sync', 'source_backfill', 'materialized_view_refresh', 'saved_report_run', 'saved_report_export')),
  payload jsonb not null,
  status text not null,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text
);

create table job_locks (
  id text primary key,
  job_run_id text not null references job_runs(id),
  worker_id text not null,
  locked_until timestamptz not null,
  created_at timestamptz not null default now()
);

create table sync_schedules (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  schedule_kind text not null check (schedule_kind in ('every_15_minutes', 'hourly', 'daily', 'weekly', 'manual_only')),
  interval_minutes integer,
  sync_mode text not null,
  refresh_window_days integer,
  stale_after_minutes integer not null,
  status text not null check (status in ('active', 'paused')),
  next_run_at timestamptz,
  last_enqueued_at timestamptz,
  last_completed_at timestamptz,
  paused_at timestamptz,
  paused_by_actor_type text,
  pause_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id)
);

create table saved_reports (
  id text primary key,
  workspace_id text not null references workspaces(id),
  name text not null,
  tool_plan jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
