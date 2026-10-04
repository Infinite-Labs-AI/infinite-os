-- Content-free receipts for background memory review and explicit model compaction.
-- Desktop acknowledges only after durably queueing a receipt for delivery.
create table if not exists auxiliary_brain_usage_outbox (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  feature text not null check (feature in ('memory_review', 'compaction')),
  provider text not null check (provider in ('codex', 'claude')),
  model text not null,
  effort text,
  status text not null check (status in ('succeeded', 'failed')),
  usage jsonb,
  occurred_at timestamptz not null,
  latency_ms integer not null check (latency_ms >= 0),
  created_at timestamptz not null default now()
);
create index if not exists auxiliary_brain_usage_pending
  on auxiliary_brain_usage_outbox (occurred_at, id);
create index if not exists auxiliary_brain_usage_workspace
  on auxiliary_brain_usage_outbox (workspace_id, occurred_at);

grant select, insert, delete on auxiliary_brain_usage_outbox to growth_os_app;
