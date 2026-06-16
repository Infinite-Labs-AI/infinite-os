create table saved_report_exports (
  id text primary key,
  workspace_id text not null references workspaces(id),
  saved_report_id text not null references saved_reports(id),
  job_run_id text references job_runs(id),
  format text not null check (format in ('json')),
  artifact_path text not null,
  artifact_bytes integer not null default 0,
  row_count integer not null default 0,
  status text not null check (status in ('succeeded', 'failed')),
  created_at timestamptz not null default now(),
  unique (job_run_id)
);
