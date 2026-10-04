-- Retire the last CROSS-PROVIDER view (same-lane rule, findings §5).
--
-- vw_site_conversion_rate hardcoded PostHog `'signup'` counts DIVIDED BY GA4 visitors — a rate whose
-- numerator and denominator come from two different measurement systems with different identity,
-- session, and consent models. That division is structurally dishonest (the same-lane rule every
-- other rate obeys: engagement_rate, cpm/cpc/ctr, roas all divide within ONE provider), and the
-- desktop Site UI already refuses it (its funnel divides GA4 key_events by GA4 visitors).
--
-- Replacement, in place (same view name; the metric ids stay served so BYO-brain query families and
-- stored saved-report plans keep working):
--   • vw_site_conversion_rate becomes the SAME-LANE GA4 rate: key_events ÷ visitors at the same
--     day/landing/utm grain, both sides from ga4_report_snapshot_fact. This is exactly the rate the
--     desktop Site funnel already shows, so engine answers and the UI finally agree.
--   • signup_count LEAVES this view entirely — it re-points to the pure PostHog lane
--     (queryable.vw_posthog_events, a filtered count of 'signup' events). Its authority/drilldown
--     always claimed PostHog; now its read path matches the claim. (Engine switch-function changes
--     ride the same train: metricView/aggregateExpression in packages/analytical-engine.)
--
-- DROP + CREATE (not `create or replace`): the output column set changes (signup_count leaves,
-- key_events joins), which REPLACE forbids. Idempotent: drop if exists, registry updates via
-- `on conflict (id) do update` … here as plain UPDATEs on rows 0005 seeded (update of a missing row
-- is a no-op, and 0005 always runs first in this stack).

drop view if exists queryable.vw_site_conversion_rate;
create view queryable.vw_site_conversion_rate as
select
  workspace_id,
  reporting_date as occurred_on,
  landing_page,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign,
  sum(key_events) as key_events,
  sum(total_users) as site_visitors,
  case
    when sum(total_users) is null or sum(total_users) = 0 then null
    else sum(key_events)::numeric / sum(total_users)
  end as site_conversion_rate
from ga4_report_snapshot_fact
-- Dev-host exclusion preserved from 0027 — localhost tag traffic must not pollute either side.
where (host_name is null or lower(host_name) not in ('localhost', '127.0.0.1'))
group by workspace_id, reporting_date, landing_page, referrer, utm_source, utm_medium, utm_campaign;

-- Registry: the view is now single-provider GA4 — freshnessForViews derives the provider set from
-- source_tables, so this row change is what fixes the funnel's freshness claim too.
update queryable_views set
  description = 'GA4 same-lane conversion-rate view (key events / visitors at the day/landing/utm grain)',
  row_grain = 'day/channel',
  allowed_dimensions = '["landing_page","referrer","utm_source","utm_medium","utm_campaign"]',
  allowed_measures = '["key_events","site_visitors","site_conversion_rate"]',
  source_tables = '["ga4_report_snapshot_fact"]',
  caveats = 'source_native_attribution_only;key_events_may_be_unconfigured',
  drilldown_action = 'drilldown.ga4_traffic_provider_rows'
where id = 'queryable.vw_site_conversion_rate';

update metric_definitions set
  description = 'GA4 site conversion rate: key events divided by visitors, both GA4 (same-lane)',
  expression = '{"type":"ratio","numeratorMetric":"key_events","denominatorMetric":"site_visitors","zeroDenominator":"null"}',
  caveats = 'source_native_attribution_only; key_events_may_be_unconfigured; channel_campaign_landing_page_grain_only',
  examples = '["What is my site conversion percentage this month?","Conversion rate by channel"]'
where id = 'site_conversion_rate';

-- signup_count re-points to the pure PostHog lane. referrer joins its allowed dims (a real
-- vw_posthog_events column the old blended view also exposed).
update metric_definitions set
  description = 'PostHog signup events (counted on the PostHog event lane)',
  source_view = 'queryable.vw_posthog_events',
  expression = '{"type":"filtered_count","view":"queryable.vw_posthog_events","filter":{"event_name":"signup"},"column":"posthog_event_count","aggregate":"sum"}',
  allowed_dimensions = '["landing_page","referrer","utm_source","utm_medium","utm_campaign"]'
where id = 'signup_count';

-- Grants — a recreated view is NOT covered by 0006's apply-time blanket grant (the 0053 incident).
grant select on queryable.vw_site_conversion_rate to growth_os_tool_agent, growth_os_app, growth_os_read_api;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on queryable.vw_site_conversion_rate to engine_app;
  end if;
end
$$;
