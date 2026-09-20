-- Minimal local durability for interactive Cmd+L tasks.
--
-- These rows are a task/event projection and references to action owners. They are
-- deliberately not a second provider journal: cloud services keep their own
-- authoritative attempts and receipts, while chat_action_calls remains the engine
-- LLM controller's action owner where applicable.
create table interactive_tasks (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text not null,
  surface text not null check (surface in ('cmdl')),
  client_surface_key text not null,
  provider_id text not null,
  model_id text not null,
  agent_profile text not null,
  provider_session_id text,
  accepted_context_revision text not null,
  authority_expires_at timestamptz not null,
  context_json jsonb not null default '{}',
  state text not null default 'active' check (
    state in ('active', 'awaiting_approval', 'recovering', 'paused', 'completed', 'failed', 'cancelled')
  ),
  revision bigint not null default 0 check (revision >= 0),
  last_event_sequence bigint not null default 0 check (last_event_sequence >= 0),
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id, actor_id)
);

create table interactive_task_events (
  event_id text primary key,
  task_id text not null,
  workspace_id text not null,
  actor_id text not null,
  sequence bigint not null check (sequence > 0),
  kind text not null check (
    kind in ('user_message', 'assistant_message', 'progress', 'approval_requested',
      'approval_resolved', 'action_dispatch', 'action_outcome', 'continuation', 'task_state')
  ),
  payload_json jsonb not null default '{}',
  transition_request_id text not null,
  transition_request_hash text not null check (transition_request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (task_id, workspace_id, actor_id)
    references interactive_tasks(id, workspace_id, actor_id) on delete cascade,
  unique (task_id, sequence),
  unique (task_id, transition_request_id)
);

create table interactive_action_refs (
  invocation_id text primary key,
  task_id text not null,
  workspace_id text not null,
  actor_id text not null,
  source_kind text not null check (source_kind in ('host_confirmation', 'engine_action_call', 'service_journal')),
  source_ref text,
  operation_id text not null,
  adapter_version text not null,
  schema_version text not null,
  proposal_ref text not null,
  proposal_revision integer not null check (proposal_revision > 0),
  proposal_hash text not null check (proposal_hash ~ '^[a-f0-9]{64}$'),
  proposal_json jsonb not null default '{}',
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  effect text not null check (effect in ('read', 'local_write', 'external_write')),
  replay_policy text not null check (replay_policy in ('read', 'idempotent_key', 'reconcile_before_retry')),
  state text not null check (
    state in ('prepared', 'awaiting_approval', 'authorized', 'dispatching',
      'succeeded', 'failed', 'unknown', 'declined', 'cancelled')
  ),
  prepared_context_revision text,
  authorization_context_revision text,
  authorization_expires_at timestamptz,
  decision_provenance text,
  service_resume_key text,
  receipt_ref text,
  outcome_summary text,
  verification text not null default 'not_run' check (
    verification in ('not_run', 'passed', 'failed', 'unavailable')
  ),
  continuation_key text,
  continuation_state text not null default 'not_required' check (
    continuation_state in ('not_required', 'pending', 'running', 'completed', 'failed')
  ),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (task_id, workspace_id, actor_id)
    references interactive_tasks(id, workspace_id, actor_id) on delete cascade,
  unique (task_id, proposal_ref, proposal_revision)
);

create unique index interactive_action_refs_task_continuation_idx
  on interactive_action_refs(task_id, continuation_key)
  where continuation_key is not null;

create index interactive_tasks_scope_active_idx
  on interactive_tasks(workspace_id, actor_id, surface, updated_at desc)
  where state not in ('completed', 'failed', 'cancelled');

create index interactive_task_events_cursor_idx
  on interactive_task_events(task_id, workspace_id, actor_id, sequence);

create index interactive_action_refs_scope_state_idx
  on interactive_action_refs(task_id, workspace_id, actor_id, state);

grant select, insert, update, delete on interactive_tasks, interactive_task_events,
  interactive_action_refs to growth_os_app;
