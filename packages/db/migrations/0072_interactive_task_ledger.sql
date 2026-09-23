-- Minimal local durability for interactive agent tasks (Cmd+L turns and automatic turns).
--
-- These rows are a task/event projection and references to action owners. They are
-- deliberately not a second provider journal: cloud services keep their own
-- authoritative attempts and receipts, while chat_action_calls remains the engine
-- LLM controller's action owner where applicable.
--
-- A proposal (an action row awaiting approval) is durable. A grant (authorization on that
-- row) is short-lived and never extended: once it lapses the row is `expired`, and "Apply"
-- re-prepares it into a new revision that supersedes the old one.
create table interactive_tasks (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text not null,
  -- Where the turn is shown. A human types into Cmd+L or iMessage; an automatic turn replies on
  -- iMessage or the agent-tasks board, never in the Cmd+L pane.
  surface text not null check (surface in ('cmdl', 'imessage', 'agent_tasks')),
  -- Who asked. Only `human` is ever human intent; `triggered` (data alert) and `scheduled`
  -- (time reminder) turns are written by the server from rule data.
  origin text not null check (origin in ('human', 'triggered', 'scheduled')),
  -- Host-authored provenance of an automatic turn. Never taken from model output.
  trigger_key text check (trigger_key is null or length(trigger_key) between 1 and 512),
  rule_id text check (rule_id is null or length(rule_id) between 1 and 200),
  rule_version integer check (rule_version is null or rule_version > 0),
  check_key text check (check_key is null or length(check_key) between 1 and 512),
  event_key text check (event_key is null or length(event_key) between 1 and 512),
  trigger_payload_hash text check (trigger_payload_hash is null or trigger_payload_hash ~ '^[a-f0-9]{64}$'),
  client_surface_key text not null,
  provider_id text not null,
  model_id text not null,
  agent_profile text not null,
  provider_session_id text,
  accepted_context_revision text not null,
  -- End of the originating turn's authority. After it, the task cannot record new proposals.
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
  unique (id, workspace_id, actor_id),
  -- A human task carries no trigger provenance at all.
  constraint interactive_tasks_human_provenance_check check (
    origin <> 'human' or (trigger_key is null and rule_id is null and rule_version is null
      and check_key is null and event_key is null and trigger_payload_hash is null)
  ),
  -- A triggered task carries the full contract provenance, and its key mirrors the alert delivery
  -- identity `trigger:{alert_id}:{event_key}` exactly.
  constraint interactive_tasks_triggered_provenance_check check (
    origin <> 'triggered' or (rule_id is not null and rule_version is not null and check_key is not null
      and event_key is not null and trigger_payload_hash is not null
      and trigger_key = 'trigger:' || rule_id || ':' || event_key)
  ),
  -- A scheduled task names its rule, its key and the payload it was built from.
  constraint interactive_tasks_scheduled_provenance_check check (
    origin <> 'scheduled' or (rule_id is not null and trigger_key is not null and trigger_payload_hash is not null)
  ),
  -- Automatic turns never render in the Cmd+L pane; a human never types into the board.
  constraint interactive_tasks_origin_surface_check check (
    (origin = 'human' and surface in ('cmdl', 'imessage'))
    or (origin <> 'human' and surface in ('imessage', 'agent_tasks'))
  )
);

-- One task per trigger key: a retried automatic turn maps to the existing task.
create unique index interactive_tasks_trigger_key_idx
  on interactive_tasks(workspace_id, trigger_key)
  where trigger_key is not null;

create table interactive_task_events (
  event_id text primary key,
  task_id text not null,
  workspace_id text not null,
  actor_id text not null,
  sequence bigint not null check (sequence > 0),
  kind text not null check (
    kind in ('user_message', 'trigger', 'assistant_message', 'progress', 'approval_requested',
      'approval_resolved', 'proposal_revised', 'authorization_expired', 'action_dispatch',
      'action_outcome', 'continuation', 'task_state')
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
      'succeeded', 'failed', 'unknown', 'declined', 'cancelled', 'superseded', 'expired')
  ),
  -- The revision this row re-prepared. The composite FK below keeps it inside the same
  -- (task, proposal_ref) lineage.
  supersedes_invocation_id text,
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
  unique (task_id, proposal_ref, proposal_revision),
  unique (invocation_id, task_id, proposal_ref),
  foreign key (supersedes_invocation_id, task_id, proposal_ref)
    references interactive_action_refs(invocation_id, task_id, proposal_ref) on delete cascade,
  constraint interactive_action_refs_revision_lineage_check check (
    (proposal_revision = 1) = (supersedes_invocation_id is null)
  )
);

-- Exactly one head per proposal lineage: every earlier revision is `superseded`, so a proposal
-- can never have two live revisions.
create unique index interactive_action_refs_proposal_head_idx
  on interactive_action_refs(task_id, proposal_ref)
  where state <> 'superseded';

-- A revision is re-prepared at most once: the lineage never forks.
create unique index interactive_action_refs_supersedes_idx
  on interactive_action_refs(supersedes_invocation_id)
  where supersedes_invocation_id is not null;

create unique index interactive_action_refs_task_continuation_idx
  on interactive_action_refs(task_id, continuation_key)
  where continuation_key is not null and state <> 'superseded';

create index interactive_tasks_scope_active_idx
  on interactive_tasks(workspace_id, actor_id, created_at desc, id desc)
  where state not in ('completed', 'failed', 'cancelled');

create index interactive_task_events_cursor_idx
  on interactive_task_events(task_id, workspace_id, actor_id, sequence);

create index interactive_action_refs_scope_state_idx
  on interactive_action_refs(task_id, workspace_id, actor_id, state);

grant select, insert, update, delete on interactive_tasks, interactive_task_events,
  interactive_action_refs to growth_os_app;
