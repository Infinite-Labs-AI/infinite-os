create schema if not exists queryable;

create table metric_definitions (
  id text primary key,
  name text not null,
  description text not null,
  aliases jsonb not null default '[]',
  source_view text not null,
  expression jsonb not null,
  entity_type text,
  metric_type text not null default 'count',
  unit text,
  aggregation text,
  default_time_column text not null,
  allowed_dimensions jsonb not null default '[]',
  required_filters jsonb not null default '{}',
  default_filters jsonb not null default '{}',
  caveats text,
  examples jsonb not null default '[]',
  provenance_strategy text not null default 'view_drilldown',
  version integer not null default 1,
  created_at timestamptz not null default now()
);

create table queryable_views (
  id text primary key,
  schema_name text not null default 'queryable',
  view_name text not null,
  description text not null,
  view_type text not null default 'view',
  primary_entity text,
  row_grain text not null,
  default_time_column text not null,
  allowed_dimensions jsonb not null default '[]',
  allowed_measures jsonb not null default '[]',
  valid_filters jsonb not null default '[]',
  example_questions jsonb not null default '[]',
  source_tables jsonb not null default '[]',
  freshness_target text,
  caveats text,
  drilldown_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schema_name, view_name)
);

create table record_lineage (
  id text primary key,
  workspace_id text not null references workspaces(id),
  canonical_table text not null,
  canonical_id text not null,
  provider text not null check (provider in ('google_analytics_4', 'posthog', 'stripe')),
  provider_table text not null,
  provider_row_id text not null,
  raw_record_id text references raw_records(id),
  normalization_version text,
  created_at timestamptz not null default now()
);

create table tool_execution_log (
  id text primary key,
  workspace_id text not null references workspaces(id),
  actor_type text not null,
  surface text not null,
  tool_name text not null,
  input_payload jsonb not null default '{}',
  referenced_views jsonb not null default '[]',
  referenced_metrics jsonb not null default '[]',
  internal_plan jsonb,
  row_count integer,
  truncated boolean not null default false,
  execution_ms integer,
  created_at timestamptz not null default now()
);

create view queryable.vw_site_traffic as
select
  workspace_id,
  source_id,
  report_date as occurred_on,
  country,
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign,
  sessions,
  active_users,
  total_users as site_visitors
from ga4_report_snapshot_fact;

create view queryable.vw_site_conversion_rate as
select
  e.workspace_id,
  e.source_id,
  date(e.occurred_at) as occurred_on,
  e.landing_page,
  e.referrer,
  e.utm_source,
  e.utm_medium,
  e.utm_campaign,
  count(*) filter (where e.event_name = 'signup') as signup_count,
  null::numeric as site_conversion_rate
from posthog_event_truth e
group by e.workspace_id, e.source_id, date(e.occurred_at), e.landing_page, e.referrer, e.utm_source, e.utm_medium, e.utm_campaign;

create view queryable.vw_revenue_by_source as
select
  workspace_id,
  source_id,
  'stripe'::text as provider,
  date(coalesce(recognized_at, created_at_source, created_at)) as occurred_on,
  currency,
  sum(amount_paid) as recognized_revenue
from stripe_invoices
group by workspace_id, source_id, date(coalesce(recognized_at, created_at_source, created_at)), currency;

create view queryable.vw_recent_sync_status as
select
  s.workspace_id,
  s.id as source_id,
  s.provider,
  s.status as source_status,
  sr.status as latest_sync_status,
  sr.started_at,
  sr.finished_at,
  ss.stale_after_minutes,
  ss.last_completed_at
from sources s
left join lateral (
  select *
  from sync_runs
  where sync_runs.source_id = s.id
  order by started_at desc
  limit 1
) sr on true
left join sync_schedules ss on ss.source_id = s.id;

insert into queryable_views (id, view_name, description, row_grain, default_time_column, allowed_dimensions, allowed_measures, source_tables, freshness_target, caveats, drilldown_action)
values
  ('queryable.vw_site_traffic', 'vw_site_traffic', 'GA4 traffic authority view', 'day/source/dimension', 'occurred_on', '["country","landing_page","utm_source","utm_medium","utm_campaign"]', '["site_visitors","sessions","active_users"]', '["ga4_report_snapshot_fact"]', '24 hours', 'source_native_attribution_only', 'drilldown.ga4_traffic_provider_rows'),
  ('queryable.vw_site_conversion_rate', 'vw_site_conversion_rate', 'PostHog signup/conversion authority view', 'day/source/channel', 'occurred_on', '["landing_page","utm_source","utm_medium","utm_campaign"]', '["signup_count","site_conversion_rate"]', '["posthog_event_truth"]', '24 hours', 'source_native_attribution_only;content_linkage_not_implemented', 'drilldown.posthog_signup_provider_rows'),
  ('queryable.vw_revenue_by_source', 'vw_revenue_by_source', 'Stripe revenue authority view', 'day/source/currency', 'occurred_on', '["provider","currency"]', '["recognized_revenue"]', '["stripe_invoices"]', '24 hours', 'content_linkage_not_implemented', 'drilldown.stripe_revenue_provider_rows'),
  ('queryable.vw_recent_sync_status', 'vw_recent_sync_status', 'Recent source sync status view', 'source', 'started_at', '["provider","source_status","latest_sync_status"]', '[]', '["sources","sync_runs","sync_schedules"]', '15 minutes', null, 'drilldown.sync_status_rows');

insert into metric_definitions (id, name, description, aliases, source_view, expression, metric_type, unit, aggregation, default_time_column, allowed_dimensions, caveats, examples)
values
  ('site_visitors', 'Site visitors', 'GA4 total users for site traffic questions', '["visitors","users"]', 'queryable.vw_site_traffic', '{"type":"direct_column","view":"queryable.vw_site_traffic","column":"site_visitors","aggregate":"sum"}', 'count', 'visitors', 'sum', 'occurred_on', '["country","landing_page","utm_source","utm_medium","utm_campaign"]', 'GA4 is the first-phase traffic authority', '["How many site visitors came from the UK this week?"]'),
  ('signup_count', 'Signup count', 'PostHog signup events', '["signups"]', 'queryable.vw_site_conversion_rate', '{"type":"direct_column","view":"queryable.vw_site_conversion_rate","column":"signup_count","aggregate":"sum"}', 'count', 'signups', 'sum', 'occurred_on', '["landing_page","utm_source","utm_medium","utm_campaign"]', 'PostHog is the first-phase signup authority', '["Which channels drove the most signups in the last 30 days?"]'),
  ('site_conversion_rate', 'Site conversion rate', 'Ratio of PostHog signups to GA4 visitors', '["conversion percentage","conversion rate"]', 'queryable.vw_site_conversion_rate', '{"type":"ratio","numeratorMetric":"signup_count","denominatorMetric":"site_visitors","zeroDenominator":"null"}', 'ratio', 'percent', 'ratio', 'occurred_on', '["landing_page","utm_source","utm_medium","utm_campaign"]', 'channel_campaign_landing_page_grain_only', '["What is my site conversion percentage this month?"]'),
  ('recognized_revenue', 'Recognized revenue', 'Stripe recognized revenue', '["revenue"]', 'queryable.vw_revenue_by_source', '{"type":"direct_column","view":"queryable.vw_revenue_by_source","column":"recognized_revenue","aggregate":"sum"}', 'currency', 'minor_currency_unit', 'sum', 'occurred_on', '["provider","currency"]', 'Stripe is the first-phase revenue authority', '["What revenue did Stripe recognize this month?"]');
