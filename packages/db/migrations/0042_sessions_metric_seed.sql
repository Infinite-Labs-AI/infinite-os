-- Sessions metric — seed the metric_definitions catalog row so list_metrics /
-- describe_metric discover `sessions`, the headline GA4 traffic count that already
-- lives in vw_site_traffic (0024 added the `sessions` measure + listed it in
-- allowed_measures) but had no registered metric id reading it. Additive count over
-- the daily grain, identical routing to its site-traffic siblings (page_views /
-- new_users / engaged_sessions): metricView -> vw_site_traffic, aggregate sum(sessions),
-- default time column occurred_on, the shared GA4 dimension allowances.
--
-- Additive + idempotent: the view/allowed_measures already carry `sessions` (0024), so
-- this migration only inserts the registry row and uses `on conflict (id) do update`.

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
    'sessions',
    'Sessions',
    'GA4 sessions grouped by acquisition channel and device',
    '["sessions","visits","session count","total sessions"]',
    'queryable.vw_site_traffic',
    '{"type":"direct_column","view":"queryable.vw_site_traffic","column":"sessions","aggregate":"sum"}',
    'count',
    'sessions',
    'sum',
    'occurred_on',
    '["country","session_default_channel_group","host_name","device_category","landing_page","utm_source","utm_medium","utm_campaign"]',
    'source_native_attribution_only',
    '["How many sessions did we get last week?","Sessions by channel this month"]'
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
