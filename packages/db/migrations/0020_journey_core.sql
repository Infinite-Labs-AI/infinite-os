create schema if not exists journey;

create table journey.actors (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_type text not null check (actor_type in ('person', 'account')),
  display_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table journey.actor_identities (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text not null references journey.actors(id),
  provider text not null,
  provider_subject_type text not null,
  provider_subject_id text not null,
  identity_kind text not null check (identity_kind in ('provider_id', 'distinct_id', 'email_hash', 'customer_id')),
  identity_hash text,
  redacted_value text,
  status text not null check (status in ('accepted', 'conflicted', 'rejected', 'superseded')),
  rule_id text not null,
  source_table text not null,
  source_row_id text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider, provider_subject_type, provider_subject_id, identity_kind)
);

create table journey.entities (
  id text primary key,
  workspace_id text not null references workspaces(id),
  entity_type text not null check (entity_type in ('channel', 'campaign', 'content_item', 'event_item', 'page', 'product', 'behavior')),
  entity_key text not null,
  provider text,
  provider_entity_id text,
  label text not null,
  properties jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, entity_type, entity_key)
);

create table journey.touchpoint_facts (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text references journey.actors(id),
  entity_id text references journey.entities(id),
  source_id text references sources(id),
  provider text not null,
  touchpoint_type text not null,
  occurred_at timestamptz not null,
  channel text,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  source_table text not null,
  source_row_id text not null,
  created_at timestamptz not null default now()
);

create table journey.behavior_facts (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text references journey.actors(id),
  source_id text references sources(id),
  provider text not null,
  event_name text not null,
  occurred_at timestamptz not null,
  selected_properties jsonb not null default '{}',
  source_table text not null,
  source_row_id text not null,
  created_at timestamptz not null default now()
);

create table journey.conversion_facts (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text references journey.actors(id),
  outcome_id text not null,
  occurred_at timestamptz not null,
  source_table text not null,
  source_row_id text not null,
  created_at timestamptz not null default now()
);

create table journey.billing_facts (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text references journey.actors(id),
  provider text not null,
  billing_event_type text not null,
  occurred_at timestamptz not null,
  amount_minor bigint not null default 0,
  currency text,
  source_table text not null,
  source_row_id text not null,
  created_at timestamptz not null default now()
);

create table journey.lifecycle_states (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text not null references journey.actors(id),
  state text not null check (state in ('lead', 'trial', 'active_paid', 'churned', 'reactivated', 'unknown')),
  policy_id text not null,
  policy_version integer not null,
  as_of timestamptz not null,
  source_ref_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (workspace_id, actor_id, policy_id, policy_version, as_of)
);

create table journey.ltv_windows (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_id text not null references journey.actors(id),
  policy_id text not null,
  policy_version integer not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  amount_minor bigint not null default 0,
  currency text,
  source_ref_ids jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create unique index journey_ltv_window_unique_idx on journey.ltv_windows (
  workspace_id,
  actor_id,
  policy_id,
  policy_version,
  window_start,
  window_end,
  coalesce(currency, '')
);

create table journey.evidence_refs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  evidence_type text not null,
  source_table text not null,
  source_row_id text not null,
  redacted_summary jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index journey_touchpoint_workspace_time_idx on journey.touchpoint_facts (workspace_id, occurred_at);
create index journey_touchpoint_actor_time_idx on journey.touchpoint_facts (workspace_id, actor_id, occurred_at);
create index journey_behavior_workspace_time_idx on journey.behavior_facts (workspace_id, occurred_at);
create index journey_behavior_actor_time_idx on journey.behavior_facts (workspace_id, actor_id, occurred_at);
create index journey_behavior_event_time_idx on journey.behavior_facts (workspace_id, event_name, occurred_at);
create index journey_conversion_actor_time_idx on journey.conversion_facts (workspace_id, actor_id, occurred_at);
create index journey_billing_actor_time_idx on journey.billing_facts (workspace_id, actor_id, occurred_at);
create index journey_lifecycle_actor_as_of_idx on journey.lifecycle_states (workspace_id, actor_id, as_of desc);
