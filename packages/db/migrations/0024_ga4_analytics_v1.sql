-- GA4 Analytics v1 — PR1: storage + Report A (daily traffic).
-- Additive and idempotent: column adds use `if not exists`, the unique key swap is
-- `drop constraint if exists` then `add constraint`, the view is `drop ... if exists`
-- then recreate, and registry seeds use `on conflict (id) do update`.

-- 2a. New low-card dimensions + traffic measures on the daily fact grain.
alter table ga4_report_snapshot_fact
  add column if not exists session_default_channel_group text not null default '(not set)',
  add column if not exists host_name text not null default '(not set)',
  add column if not exists device_category text not null default '(not set)',
  add column if not exists screen_page_views integer not null default 0,
  add column if not exists new_users integer not null default 0,
  add column if not exists engaged_sessions integer not null default 0,
  add column if not exists engagement_rate numeric not null default 0,
  add column if not exists average_session_duration numeric not null default 0,
  add column if not exists key_events integer not null default 0;

-- 2b. Unique-key swap — the three new low-card dims become GROUP-BY keys, so they
-- must join the upsert key. Pre-existing rows are unique on the old 7-tuple and the
-- new columns all default to '(not set)', so the new 10-tuple stays unique per old
-- row → ADD CONSTRAINT succeeds. The column list here is the CANONICAL ordering and
-- MUST stay byte-identical to writeGa4Truth's `on conflict (...)` list.
alter table ga4_report_snapshot_fact drop constraint if exists ga4_report_snapshot_unique;
alter table ga4_report_snapshot_fact
  add constraint ga4_report_snapshot_unique
  unique (source_id, reporting_date, country, landing_page, utm_source, utm_medium,
          utm_campaign, session_default_channel_group, device_category, host_name);

-- 2c. Recreate vw_site_traffic with the new measures/dims and the metric-id aliases
-- (preserves metricColumn identity: metric id == aliased view column).
drop view if exists queryable.vw_site_traffic;
create view queryable.vw_site_traffic as
select
  workspace_id,
  source_id,
  reporting_date as occurred_on,
  country,
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign,
  session_default_channel_group,
  host_name,
  device_category,
  sessions,
  active_users,
  total_users as site_visitors,
  new_users,
  screen_page_views as page_views,
  engaged_sessions,
  engagement_rate,
  average_session_duration,
  key_events
from ga4_report_snapshot_fact;

-- 2d. Registry seeds (metadata only — execution uses hard-coded SQL in the engine).
update queryable_views set
  allowed_dimensions = '["country","landing_page","referrer","utm_source","utm_medium","utm_campaign","session_default_channel_group","host_name","device_category"]',
  allowed_measures = '["site_visitors","sessions","active_users","new_users","page_views","engaged_sessions","engagement_rate","average_session_duration","key_events"]'
where id = 'queryable.vw_site_traffic';

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
values
  (
    'page_views',
    'Page views',
    'GA4 screen/page views grouped by acquisition channel and device',
    '["page views","pageviews","screen page views","views"]',
    'queryable.vw_site_traffic',
    '{"type":"direct_column","view":"queryable.vw_site_traffic","column":"page_views","aggregate":"sum"}',
    'count',
    'views',
    'sum',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only',
    '["How many page views did we get last week?","Page views by channel this month"]'
  ),
  (
    'new_users',
    'New users',
    'GA4 new users grouped by acquisition channel and device',
    '["new users","first-time users","new visitors"]',
    'queryable.vw_site_traffic',
    '{"type":"direct_column","view":"queryable.vw_site_traffic","column":"new_users","aggregate":"sum"}',
    'count',
    'users',
    'sum',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only',
    '["How many new users came from organic search?","New users by channel last week"]'
  ),
  (
    'engaged_sessions',
    'Engaged sessions',
    'GA4 engaged sessions grouped by acquisition channel and device',
    '["engaged sessions","engaged visits"]',
    'queryable.vw_site_traffic',
    '{"type":"direct_column","view":"queryable.vw_site_traffic","column":"engaged_sessions","aggregate":"sum"}',
    'count',
    'sessions',
    'sum',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only',
    '["How many engaged sessions did mobile drive?","Engaged sessions by channel"]'
  ),
  (
    'key_events',
    'Key events',
    'GA4 key events grouped by acquisition channel and device',
    '["key events","conversions","key event count"]',
    'queryable.vw_site_traffic',
    '{"type":"direct_column","view":"queryable.vw_site_traffic","column":"key_events","aggregate":"sum"}',
    'count',
    'events',
    'sum',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only; key_events_may_be_unconfigured',
    '["How many key events fired last week?","Key events by channel"]'
  ),
  (
    'engagement_rate',
    'Engagement rate',
    'GA4 engagement rate (session-weighted average across the daily grain)',
    '["engagement rate","engaged rate"]',
    'queryable.vw_site_traffic',
    '{"type":"weighted_average","view":"queryable.vw_site_traffic","column":"engagement_rate","weight":"sessions"}',
    'ratio',
    'fraction (0..1)',
    'weighted_avg',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only; weighted_average_across_grain',
    '["What is our engagement rate by channel?","Engagement rate on mobile vs desktop"]'
  ),
  (
    'average_session_duration',
    'Avg session duration',
    'GA4 average session duration in seconds (session-weighted average across the daily grain)',
    '["average session duration","avg session duration","session length"]',
    'queryable.vw_site_traffic',
    '{"type":"weighted_average","view":"queryable.vw_site_traffic","column":"average_session_duration","weight":"sessions"}',
    'ratio',
    'seconds',
    'weighted_avg',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only; weighted_average_across_grain',
    '["What is our average session duration by channel?","Avg session duration on mobile"]'
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

-- 2e. Grants footer — a freshly recreated view is NOT covered by 0006's apply-time
-- blanket grant, so grant to all three read roles explicitly.
grant select on queryable.vw_site_traffic to growth_os_tool_agent, growth_os_app, growth_os_read_api;
