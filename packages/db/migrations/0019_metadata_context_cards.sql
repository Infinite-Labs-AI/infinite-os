create schema if not exists metadata;

create table metadata.context_cards (
  id text primary key,
  workspace_id text references workspaces(id),
  card_type text not null check (
    card_type in (
      'source_capability',
      'entity_definition',
      'outcome_definition',
      'policy_definition',
      'path_template',
      'journey_template',
      'glossary',
      'example_plan',
      'unsupported_case'
    )
  ),
  key text not null,
  title text not null,
  searchable_text text not null,
  payload jsonb not null,
  version integer not null default 1,
  source text not null check (source in ('seed', 'operator', 'learned_verified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table metadata.journey_template_suggestions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  proposed_by_session_id text,
  question text not null,
  template_payload jsonb not null,
  status text not null check (status in ('suggested', 'approved', 'rejected')),
  reviewer_actor_id text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index metadata_context_cards_global_unique
  on metadata.context_cards (card_type, key, version)
  where workspace_id is null;

create unique index metadata_context_cards_workspace_unique
  on metadata.context_cards (workspace_id, card_type, key, version)
  where workspace_id is not null;

create index metadata_context_cards_search_idx
  on metadata.context_cards using gin (to_tsvector('english', searchable_text));
