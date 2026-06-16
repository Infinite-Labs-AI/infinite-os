alter table ga4_report_snapshot_fact
  rename column report_date to reporting_date;

alter table ga4_report_snapshot_fact
  add constraint ga4_report_snapshot_unique
  unique (source_id, reporting_date, country, landing_page, utm_source, utm_medium, utm_campaign);

alter table stripe_invoices
  rename column recognized_at to paid_at;

alter table stripe_invoices
  add column external_order_id text;

alter table stripe_invoice_lines
  rename column amount to amount_cents;

alter table stripe_invoice_lines
  add column external_order_id text;

drop view queryable.vw_recent_sync_status;
drop view queryable.vw_revenue_by_source;
drop view queryable.vw_site_conversion_rate;
drop view queryable.vw_site_traffic;

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
  sessions,
  active_users,
  total_users as site_visitors
from ga4_report_snapshot_fact;

create view queryable.vw_site_conversion_rate as
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

create view queryable.vw_revenue_by_source as
select
  i.workspace_id,
  i.source_id,
  'stripe'::text as provider,
  date(i.paid_at) as occurred_on,
  i.currency,
  i.external_order_id,
  i.stripe_customer_id as customer_external_id,
  l.stripe_invoice_id as invoice_external_id,
  l.stripe_product_id as product_external_id,
  l.stripe_price_id as price_external_id,
  sum(l.amount_cents) as recognized_revenue
from stripe_invoices i
join stripe_invoice_lines l
  on l.source_id = i.source_id
  and l.stripe_invoice_id = i.stripe_invoice_id
where i.status = 'paid'
group by
  i.workspace_id,
  i.source_id,
  date(i.paid_at),
  i.currency,
  i.external_order_id,
  i.stripe_customer_id,
  l.stripe_invoice_id,
  l.stripe_product_id,
  l.stripe_price_id;

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
  ss.status as schedule_status,
  ss.next_run_at,
  ss.last_enqueued_at,
  ss.last_completed_at,
  ss.paused_at,
  ss.pause_reason,
  case
    when s.status = 'revoked' then 'revoked'
    when sr.status = 'failed' then 'degraded'
    when ss.last_completed_at is null then 'not_synced'
    when ss.last_completed_at < now() - (ss.stale_after_minutes::text || ' minutes')::interval then 'stale'
    else 'healthy'
  end as health_state
from sources s
left join lateral (
  select *
  from sync_runs
  where sync_runs.source_id = s.id
  order by started_at desc
  limit 1
) sr on true
left join sync_schedules ss on ss.source_id = s.id;
