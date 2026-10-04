-- PostHog audience view (slice 1) — device / OS / geo / browser breakdowns from data
-- that is ALREADY synced. PostHog's client-side `$pageview`/autocapture events persist
-- `$os`, `$device_type`, `$browser`, and the `$geoip_*` geo fields inside
-- posthog_event_truth.properties (JSONB, 0004). This slice unlocks those audience cuts
-- with NO new sync, NO backfill, NO API quota: a new queryable view over the existing
-- truth table + a single count measure. Sessions/visitors (non-additive distinct counts)
-- are DELIBERATELY deferred to slice 2 — this view ships only the additive pageview count.
--
-- HONESTY: every dimension is a REAL extraction from real properties. A missing property
-- yields NULL (the desktop renders an em-dash) — nothing is fabricated. The view is scoped
-- to `$pageview` events because the audience props ride client-side capture; server-side
-- events won't carry them, so blending them in would understate coverage dishonestly. This
-- scope also gives count(*) a clean "page views" meaning.
--
-- Additive + idempotent: the view is `drop ... if exists` then recreate (a brand-new name,
-- so nothing else depends on it), and the registry seeds use `on conflict (id) do update`.
-- Nothing is dropped or deleted; posthog_event_truth is untouched.

-- 1. The audience view. Audience dims are ALIASED into real columns here so the engine's
--    dimensionExpression() stays identity (matching the vw_posthog_events / vw_site_traffic
--    convention). `$device_type` is lower-cased to the mobile/desktop/tablet convention GA4's
--    device_category already uses; the rest pass through verbatim (NULL when absent).
drop view if exists queryable.vw_posthog_site;
create view queryable.vw_posthog_site as
select
  workspace_id,
  source_id,
  date(occurred_at) as occurred_on,
  lower(properties->>'$device_type') as device_type,
  properties->>'$os' as operating_system,
  properties->>'$browser' as browser,
  properties->>'$geoip_country_name' as country,
  properties->>'$geoip_subdivision_1_name' as region,
  properties->>'$geoip_city_name' as city,
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign,
  count(*) as posthog_page_views
from posthog_event_truth
where event_name = '$pageview'
group by
  workspace_id,
  source_id,
  date(occurred_at),
  lower(properties->>'$device_type'),
  properties->>'$os',
  properties->>'$browser',
  properties->>'$geoip_country_name',
  properties->>'$geoip_subdivision_1_name',
  properties->>'$geoip_city_name',
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign;

-- 2. Registry seed (metadata only — enforcement lives in the analytical-engine switch
--    functions; this row is what list_queryable_views / describe_queryable_view hydrate).
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
  'queryable.vw_posthog_site',
  'vw_posthog_site',
  'PostHog audience view — device/OS/geo/browser breakdowns over pageview counts',
  'day/source/audience',
  'occurred_on',
  '["device_type","operating_system","browser","country","region","city","landing_page","referrer","utm_source","utm_medium","utm_campaign"]',
  '["posthog_page_views"]',
  '["posthog_event_truth"]',
  '24 hours',
  'source_native_event_counts; pageview_events_only; audience_props_client_side_only',
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

-- 3. Metric seed — posthog_page_views is an ADDITIVE count over the daily grain (sum), so it
--    routes exactly like posthog_event_count but on the audience view. Its id == its view
--    column, preserving the metricColumn() identity convention.
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
  'posthog_page_views',
  'PostHog page views',
  'Count of PostHog $pageview events, broken down by audience dimensions (device, OS, browser, geography)',
  '["posthog page views","posthog pageviews","pageviews by device","pageviews by os","pageviews by country"]',
  'queryable.vw_posthog_site',
  '{"type":"direct_column","view":"queryable.vw_posthog_site","column":"posthog_page_views","aggregate":"sum"}',
  'count',
  'views',
  'sum',
  'occurred_on',
  '["device_type","operating_system","browser","country","region","city","landing_page","referrer","utm_source","utm_medium","utm_campaign"]',
  'source_native_event_counts; pageview_events_only; audience_props_client_side_only',
  '["PostHog pageviews by operating system this week","Which countries drove the most pageviews?","Mobile vs desktop pageviews in PostHog"]'
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

-- 4. Grants footer — a freshly created view is NOT covered by 0006's apply-time blanket
--    grant. Match the vw_posthog_events precedent (0022): tool_agent + app only (the PostHog
--    views never carried growth_os_read_api, unlike the GA4 views).
grant select on queryable.vw_posthog_site to growth_os_tool_agent, growth_os_app;
