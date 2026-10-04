-- Exclude Infinite's INTERNAL/test events (properties.is_internal = true) from every app-facing PostHog
-- queryable view, so internal traffic never surfaces in the desktop app's analytics — while STILL
-- collecting it in posthog_event_truth (UNCHANGED), so it stays available for our own testing / direct
-- PostHog queries.
--
-- `is_internal` is Infinite's OWN event property (only on Infinite's product events, set for founder/team
-- sessions). A customer's own events never carry it, so `properties->>'is_internal'` is null → coalesced
-- to 'false' → kept: customers are entirely unaffected. Views are recreated with CREATE OR REPLACE
-- (Postgres preserves grants on replace; re-granted defensively to match each view's original set).
--
-- Three views read posthog_event_truth and each gets the one-line exclusion:
--   • vw_posthog_events        — the PostHog event-count authority view (App Analytics funnels)
--   • vw_posthog_site          — the PostHog pageview/audience view
--   • vw_site_conversion_rate  — its `posthog` CTE (signup counts); the `ga4` CTE is untouched (GA4 has
--                                no is_internal)

-- 1) vw_posthog_events
create or replace view queryable.vw_posthog_events as
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
where coalesce(properties->>'is_internal', 'false') <> 'true'
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

grant select on queryable.vw_posthog_events to growth_os_tool_agent, growth_os_app;

-- 2) vw_posthog_site
create or replace view queryable.vw_posthog_site as
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
  and coalesce(properties->>'is_internal', 'false') <> 'true'
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

grant select on queryable.vw_posthog_site to growth_os_tool_agent, growth_os_app;

-- 3) vw_site_conversion_rate — exclusion added inside the `posthog` CTE only.
create or replace view queryable.vw_site_conversion_rate as
with ga4 as (
  select
    workspace_id,
    reporting_date as occurred_on,
    landing_page,
    referrer,
    utm_source,
    utm_medium,
    utm_campaign,
    sum(total_users) as site_visitors
  from ga4_report_snapshot_fact
  where (host_name is null or lower(host_name) not in ('localhost', '127.0.0.1'))
  group by workspace_id, reporting_date, landing_page, referrer, utm_source, utm_medium, utm_campaign
),
posthog as (
  select
    workspace_id,
    date(occurred_at) as occurred_on,
    landing_page,
    referrer,
    utm_source,
    utm_medium,
    utm_campaign,
    count(*) filter (where event_name = 'signup') as signup_count
  from posthog_event_truth
  where coalesce(properties->>'is_internal', 'false') <> 'true'
  group by workspace_id, date(occurred_at), landing_page, referrer, utm_source, utm_medium, utm_campaign
)
select
  coalesce(ga4.workspace_id, posthog.workspace_id) as workspace_id,
  coalesce(ga4.occurred_on, posthog.occurred_on) as occurred_on,
  coalesce(ga4.landing_page, posthog.landing_page) as landing_page,
  coalesce(ga4.referrer, posthog.referrer) as referrer,
  coalesce(ga4.utm_source, posthog.utm_source) as utm_source,
  coalesce(ga4.utm_medium, posthog.utm_medium) as utm_medium,
  coalesce(ga4.utm_campaign, posthog.utm_campaign) as utm_campaign,
  coalesce(posthog.signup_count, 0) as signup_count,
  ga4.site_visitors,
  case
    when ga4.site_visitors is null or ga4.site_visitors = 0 then null
    else coalesce(posthog.signup_count, 0)::numeric / ga4.site_visitors
  end as site_conversion_rate
from ga4
full outer join posthog
  on ga4.workspace_id = posthog.workspace_id
  and ga4.occurred_on = posthog.occurred_on
  and coalesce(ga4.landing_page, '') = coalesce(posthog.landing_page, '')
  and coalesce(ga4.referrer, '') = coalesce(posthog.referrer, '')
  and coalesce(ga4.utm_source, '') = coalesce(posthog.utm_source, '')
  and coalesce(ga4.utm_medium, '') = coalesce(posthog.utm_medium, '')
  and coalesce(ga4.utm_campaign, '') = coalesce(posthog.utm_campaign, '');

grant select on queryable.vw_site_conversion_rate to growth_os_tool_agent, growth_os_app, growth_os_read_api;
