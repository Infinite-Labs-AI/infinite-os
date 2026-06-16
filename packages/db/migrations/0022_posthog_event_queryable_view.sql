create view queryable.vw_posthog_events as
select
  workspace_id,
  source_id,
  date(occurred_at) as occurred_on,
  event_name,
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign,
  count(*) as posthog_event_count
from posthog_event_truth
group by
  workspace_id,
  source_id,
  date(occurred_at),
  event_name,
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign;

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
  'queryable.vw_posthog_events',
  'vw_posthog_events',
  'PostHog event count authority view',
  'day/source/event/channel',
  'occurred_on',
  '["source_id","event_name","landing_page","referrer","utm_source","utm_medium","utm_campaign"]',
  '["posthog_event_count"]',
  '["posthog_event_truth"]',
  '24 hours',
  'source_native_event_counts',
  'drilldown.posthog_event_provider_rows'
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
  'posthog_event_count',
  'PostHog event count',
  'Count of synced PostHog events grouped by event name and acquisition channel',
  '["events","event count","event counts","posthog events"]',
  'queryable.vw_posthog_events',
  '{"type":"direct_column","view":"queryable.vw_posthog_events","column":"posthog_event_count","aggregate":"sum"}',
  'count',
  'events',
  'sum',
  'occurred_on',
  '["source_id","event_name","landing_page","referrer","utm_source","utm_medium","utm_campaign"]',
  'source_native_event_counts',
  '["Which PostHog events fired most often this week?","How many signup events came from LinkedIn yesterday?"]'
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

grant select on queryable.vw_posthog_events to growth_os_tool_agent, growth_os_app;
