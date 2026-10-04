-- Exclude developer/localhost traffic from the GA4 site-traffic views.
-- A GA4 property records every hostname its tag fires on, including `localhost`
-- and `127.0.0.1` when the site runs in local dev, so an unfiltered "page views"
-- query sums production + dev traffic. This drops dev hosts at the view boundary.
--
-- Idempotent and column-preserving: each view is recreated with `create or replace
-- view` (same columns/order/aliases as 0024/0025, REPLACE is valid because the
-- output column list is unchanged) and only a host-exclusion WHERE is added. The
-- predicate keeps NULL/other hosts (a real property may have a null host or only
-- the prod host) and drops `localhost`/`127.0.0.1` case-insensitively. Grants are
-- re-issued because a recreated view is not covered by 0006's apply-time blanket grant.

-- 1. vw_site_traffic — reads ga4_report_snapshot_fact (Report A, daily traffic).
-- SELECT reproduced verbatim from 0024 (2c); only the WHERE is new.
create or replace view queryable.vw_site_traffic as
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
from ga4_report_snapshot_fact
where (host_name is null or lower(host_name) not in ('localhost', '127.0.0.1'));

grant select on queryable.vw_site_traffic to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- 2. vw_site_pages — reads ga4_page_report_fact (Report C, page-level / top pages).
-- SELECT reproduced verbatim from 0025 (7b); only the WHERE is new.
create or replace view queryable.vw_site_pages as
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
from ga4_page_report_fact
where (host_name is null or lower(host_name) not in ('localhost', '127.0.0.1'));

grant select on queryable.vw_site_pages to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- 3. vw_site_conversion_rate — its inner `ga4` CTE reads ga4_report_snapshot_fact
-- (Report A) and aggregates total_users WITHOUT carrying host_name to the output,
-- so dev-host inflation of the visitor denominator can't be filtered downstream —
-- it must be excluded inside the CTE. Body reproduced verbatim from 0007; only the
-- inner WHERE is new.
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
