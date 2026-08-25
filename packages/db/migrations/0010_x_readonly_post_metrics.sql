alter table sources
  drop constraint if exists sources_provider_check;

alter table sources
  add constraint sources_provider_check
  check (provider in ('google_analytics_4', 'posthog', 'stripe', 'x'));

alter table raw_records
  drop constraint if exists raw_records_provider_check;

alter table raw_records
  add constraint raw_records_provider_check
  check (provider in ('google_analytics_4', 'posthog', 'stripe', 'x'));

alter table record_lineage
  drop constraint if exists record_lineage_provider_check;

alter table record_lineage
  add constraint record_lineage_provider_check
  check (provider in ('google_analytics_4', 'posthog', 'stripe', 'x'));

create table x_post (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  x_post_id text not null,
  author_id text not null,
  conversation_id text,
  post_url text not null,
  body_text text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, x_post_id)
);

create table x_post_metric_snapshot (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  x_post_id text not null,
  captured_at timestamptz not null,
  retweet_count integer not null default 0,
  reply_count integer not null default 0,
  like_count integer not null default 0,
  quote_count integer not null default 0,
  bookmark_count integer not null default 0,
  impression_count integer not null default 0,
  public_metrics jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (source_id, x_post_id, captured_at)
);

grant select, insert, update on x_post, x_post_metric_snapshot to growth_os_worker;
