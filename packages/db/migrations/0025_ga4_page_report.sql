-- GA4 Analytics v1 — PR2: Report C (page-level / top pages).
-- Purely additive and idempotent: a NEW high-card page fact table (`create table if
-- not exists`), a NEW view (`vw_site_pages`), and registry seeds via `on conflict (id)
-- do update`. No live-DB unique-key swap (unlike 0024) — there is no existing table to
-- migrate, so there is no populated-DB risk here.

-- 7a. New high-card page fact table. The page dims (page_path/page_title) are high
-- cardinality, so they get their own table rather than joining the daily fact's
-- unique key. Upsert key = (source_id, reporting_date, host_name, page_path).
create table if not exists ga4_page_report_fact (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  reporting_date date not null,
  host_name text not null default '(not set)',
  page_path text not null default '(not set)',
  page_title text not null default '(not set)',
  screen_page_views integer not null default 0,
  sessions integer not null default 0,
  engaged_sessions integer not null default 0,
  average_session_duration numeric not null default 0,
  key_events integer not null default 0,
  created_at timestamptz not null default now(),
  constraint ga4_page_report_unique unique (source_id, reporting_date, host_name, page_path)
);

-- 7b. New view. Alias `screen_page_views as page_views` to preserve metricColumn
-- identity (metric id == aliased view column), and include source_id + sessions so
-- per-site filtering and session-weighted aggregates both work against it.
create view queryable.vw_site_pages as
select
  workspace_id,
  source_id,
  reporting_date as occurred_on,
  host_name,
  page_path,
  page_title,
  screen_page_views as page_views,
  sessions,
  engaged_sessions,
  average_session_duration,
  key_events
from ga4_page_report_fact;

-- 7c. Registry seeds (metadata only — execution uses hard-coded SQL in the engine).
insert into queryable_views (
  id,
  view_name,
  description,
  row_grain,
  default_time_column,
  allowed_dimensions,
  allowed_measures,
  source_tables,
  freshness_target,
  caveats,
  drilldown_action
)
values (
  'queryable.vw_site_pages',
  'vw_site_pages',
  'GA4 page-level authority view (top pages by host and path)',
  'day/source/host/page',
  'occurred_on',
  '["host_name","page_path","page_title"]',
  '["page_views","sessions","engaged_sessions","average_session_duration","key_events"]',
  '["ga4_page_report_fact"]',
  '24 hours',
  'source_native_attribution_only',
  'drilldown.ga4_page_provider_rows'
)
on conflict (id) do update set
  view_name = excluded.view_name,
  description = excluded.description,
  row_grain = excluded.row_grain,
  default_time_column = excluded.default_time_column,
  allowed_dimensions = excluded.allowed_dimensions,
  allowed_measures = excluded.allowed_measures,
  source_tables = excluded.source_tables,
  freshness_target = excluded.freshness_target,
  caveats = excluded.caveats,
  drilldown_action = excluded.drilldown_action;

insert into metric_definitions (
  id,
  name,
  description,
  aliases,
  source_view,
  expression,
  metric_type,
  unit,
  aggregation,
  default_time_column,
  allowed_dimensions,
  caveats,
  examples
)
values (
  'page_views_by_page',
  'Page views by page',
  'GA4 page views grouped by host and page path (top pages)',
  '["top pages","page views by page","most viewed pages","popular pages"]',
  'queryable.vw_site_pages',
  '{"type":"direct_column","view":"queryable.vw_site_pages","column":"page_views","aggregate":"sum"}',
  'count',
  'views',
  'sum',
  'occurred_on',
  '["host_name","page_path","page_title"]',
  'source_native_attribution_only',
  '["What are our top pages this week?","Which pages got the most views last month?"]'
)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  aliases = excluded.aliases,
  source_view = excluded.source_view,
  expression = excluded.expression,
  metric_type = excluded.metric_type,
  unit = excluded.unit,
  aggregation = excluded.aggregation,
  default_time_column = excluded.default_time_column,
  allowed_dimensions = excluded.allowed_dimensions,
  caveats = excluded.caveats,
  examples = excluded.examples;

-- 7d. Grants — a new table/view is NOT covered by 0006's apply-time blanket grant.
-- Grant the worker write access to the fact table and all three read roles select on
-- the view.
grant select, insert, update on ga4_page_report_fact to growth_os_worker;
grant select on queryable.vw_site_pages to growth_os_tool_agent, growth_os_app, growth_os_read_api;
