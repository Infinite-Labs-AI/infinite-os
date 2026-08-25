create table chat_sessions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  session_key text not null,
  actor_id text not null,
  surface text not null check (surface in ('cli', 'api', 'app', 'mcp')),
  model_provider text,
  model_name text,
  model_auth_source text,
  status text not null default 'active' check (status in ('active', 'ended', 'compacted')),
  parent_session_id text references chat_sessions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  title text,
  last_prompt_tokens integer,
  last_completion_tokens integer,
  total_tokens integer not null default 0,
  unique (workspace_id, session_key)
);

create table chat_messages (
  id text primary key,
  session_id text not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant', 'tool', 'summary')),
  content text not null,
  created_at timestamptz not null default now(),
  token_count integer,
  provider_message_id text,
  reasoning_metadata_json jsonb not null default '{}',
  codex_message_items_json jsonb not null default '[]',
  codex_reasoning_items_json jsonb not null default '[]',
  redaction_state text not null default 'clean'
);

create table chat_action_calls (
  id text primary key,
  session_id text not null references chat_sessions(id) on delete cascade,
  message_id text references chat_messages(id) on delete set null,
  provider_tool_call_id text,
  action_id text not null,
  authority text not null check (authority in ('tool_agent', 'operator')),
  input_json jsonb not null default '{}',
  output_envelope_json jsonb not null default '{}',
  status text not null,
  requires_confirmation boolean not null default false,
  confirmation_id text,
  input_hash text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table chat_session_summaries (
  id text primary key,
  session_id text not null references chat_sessions(id) on delete cascade,
  parent_session_id text references chat_sessions(id),
  summary_text text not null,
  summary_json jsonb not null default '{}',
  covered_message_start_id text references chat_messages(id) on delete set null,
  covered_message_end_id text references chat_messages(id) on delete set null,
  model_provider text,
  model_name text,
  created_at timestamptz not null default now()
);

create table chat_memory_facts (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text,
  scope text not null check (
    scope in (
      'workspace_preference',
      'metric_preference',
      'report_preference',
      'operator_correction',
      'source_naming'
    )
  ),
  fact text not null,
  source_session_id text references chat_sessions(id) on delete set null,
  source_message_id text references chat_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  blocked_reason text
);

create table workspace_preferences (
  workspace_id text primary key references workspaces(id),
  preferred_timezone text,
  default_popularity_metric text,
  preferred_source_ids jsonb not null default '[]',
  last_report_id text,
  last_export_target text,
  updated_at timestamptz not null default now()
);

create index chat_sessions_workspace_updated_idx
  on chat_sessions(workspace_id, updated_at desc);

create index chat_messages_session_created_idx
  on chat_messages(session_id, created_at);

create index chat_messages_content_search_idx
  on chat_messages using gin (to_tsvector('english', content));

create index chat_action_calls_session_created_idx
  on chat_action_calls(session_id, created_at);

create index chat_session_summaries_session_created_idx
  on chat_session_summaries(session_id, created_at desc);

create index chat_memory_facts_workspace_scope_idx
  on chat_memory_facts(workspace_id, scope, updated_at desc);

grant select, insert, update on chat_sessions, chat_messages, chat_action_calls,
  chat_session_summaries, chat_memory_facts, workspace_preferences to growth_os_app;
grant select on chat_sessions, chat_messages, chat_action_calls,
  chat_session_summaries, chat_memory_facts, workspace_preferences to growth_os_tool_agent;
