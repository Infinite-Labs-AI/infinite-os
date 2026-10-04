-- Central business-population eligibility for connected Stripe customer metrics.
-- Raw Stripe rows remain intact. Consumers exclude only explicit internal_test
-- classifications and treat a missing customer/classification as eligible.
--
-- Every consumer joins this view on workspace + source + Stripe customer ID.
-- The three-part key prevents a copied/sandboxed external ID from affecting
-- another connected workspace or source.

create or replace view queryable.vw_stripe_customer_metric_eligibility as
select
  c.workspace_id,
  c.source_id,
  c.stripe_customer_id,
  coalesce(c.metrics_classification, '') <> 'internal_test' as is_business_eligible
from stripe_customers c;

-- Every consumer role must be able to read this view DIRECTLY: the connector queries it at capture
-- time (business_eligible_at_capture) and the trial freeze joins it. Local PGlite runs as the owner
-- so a missing grant is invisible in tests — the cloud engine_app role is what exposed it (the first
-- prod sync after 0050-0057 failed with "permission denied for view vw_stripe_customer_metric_eligibility").
grant select on queryable.vw_stripe_customer_metric_eligibility to growth_os_worker, growth_os_tool_agent, growth_os_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on queryable.vw_stripe_customer_metric_eligibility to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on queryable.vw_stripe_customer_metric_eligibility to growth_os_read_api;
  end if;
end
$$;

create or replace view queryable.vw_stripe_subscription_lifecycle as
with subscription_mrr as (
  select
    workspace_id,
    source_id,
    stripe_subscription_id,
    max(currency) as currency,
    sum(
      case
        when unit_amount is null then 0
        when recurring_interval = 'year' then (unit_amount::numeric * greatest(quantity, 1)) / 12
        when recurring_interval = 'week' then (unit_amount::numeric * greatest(quantity, 1)) * 52 / 12
        when recurring_interval = 'day' then (unit_amount::numeric * greatest(quantity, 1)) * 365 / 12
        else unit_amount::numeric * greatest(quantity, 1)
      end
    ) as monthly_amount_cents
  from stripe_subscription_items
  group by workspace_id, source_id, stripe_subscription_id
),
paying_customers as (
  select distinct workspace_id, source_id, stripe_customer_id
  from stripe_invoices
  where status = 'paid'
    and amount_paid > 0
    and stripe_customer_id is not null
),
base as (
  select
    s.workspace_id,
    s.source_id,
    'stripe'::text as provider,
    s.stripe_subscription_id,
    coalesce(nullif(s.stripe_customer_id, ''), s.stripe_subscription_id) as subscriber_key,
    s.status,
    m.currency,
    coalesce(m.monthly_amount_cents, 0) as monthly_amount_cents,
    (p.stripe_customer_id is not null) as has_positive_payment,
    s.created_at_source,
    s.current_period_start,
    s.current_period_end,
    s.trial_start,
    s.trial_end,
    s.cancel_at,
    s.canceled_at,
    s.ended_at
  from stripe_subscriptions s
  left join subscription_mrr m
    on m.workspace_id = s.workspace_id
   and m.source_id = s.source_id
   and m.stripe_subscription_id = s.stripe_subscription_id
  left join queryable.vw_stripe_customer_metric_eligibility e
    on e.workspace_id = s.workspace_id
   and e.source_id = s.source_id
   and e.stripe_customer_id = s.stripe_customer_id
  left join paying_customers p
    on p.workspace_id = s.workspace_id
   and p.source_id = s.source_id
   and p.stripe_customer_id = s.stripe_customer_id
  where coalesce(e.is_business_eligible, true)
)
select
  workspace_id,
  source_id,
  provider,
  current_date as occurred_on,
  'current_paid_subscribers'::text as metric_kind,
  null::text as status,
  currency,
  count(distinct subscriber_key) as stripe_current_paid_subscribers,
  0::bigint as stripe_new_paid_subscribers,
  0::bigint as stripe_trialing_subscribers,
  0::bigint as stripe_churned_subscribers
from base
where status in ('active', 'past_due')
  and monthly_amount_cents > 0
group by workspace_id, source_id, provider, currency

union all

select
  workspace_id,
  source_id,
  provider,
  date(coalesce(trial_end, created_at_source)) as occurred_on,
  'new_paid_subscribers'::text as metric_kind,
  status,
  currency,
  0::bigint,
  count(distinct subscriber_key),
  0::bigint,
  0::bigint
from base
where status in ('active', 'past_due')
  and monthly_amount_cents > 0
  and coalesce(trial_end, created_at_source) is not null
group by workspace_id, source_id, provider, date(coalesce(trial_end, created_at_source)), status, currency

union all

select
  workspace_id,
  source_id,
  provider,
  date(coalesce(trial_start, created_at_source)) as occurred_on,
  'trialing_subscribers'::text as metric_kind,
  status,
  currency,
  0::bigint,
  0::bigint,
  count(distinct subscriber_key),
  0::bigint
from base
where status = 'trialing'
  and coalesce(trial_start, created_at_source) is not null
group by workspace_id, source_id, provider, date(coalesce(trial_start, created_at_source)), status, currency

union all

select
  workspace_id,
  source_id,
  provider,
  date(coalesce(canceled_at, ended_at, current_period_end)) as occurred_on,
  'churned_subscribers'::text as metric_kind,
  status,
  currency,
  0::bigint,
  0::bigint,
  0::bigint,
  count(distinct subscriber_key)
from base
where status in ('canceled', 'unpaid')
  and has_positive_payment
  and coalesce(canceled_at, ended_at, current_period_end) is not null
group by workspace_id, source_id, provider, date(coalesce(canceled_at, ended_at, current_period_end)), status, currency;

-- Refund visibility, scoped. recognized_revenue stays GROSS on purpose: changing what that
-- number means is a founder decision, not a migration's. What was missing was any way for a
-- consumer to net it at all, because nothing captured credit notes. Post-payment credit notes
-- are the refund-shaped half of Stripe's credit-note model (money returned after collection);
-- pre-payment ones only reduce what was ever owed and so never inflate collected cash.
--
-- These columns are added HERE rather than in 0054 (which otherwise owns the stripe_invoices
-- column additions) purely for ordering: the view immediately below reads them, and 0054 runs
-- after this file.
alter table stripe_invoices
  add column if not exists post_payment_credit_notes_amount bigint,
  add column if not exists pre_payment_credit_notes_amount bigint;

create or replace view queryable.vw_revenue_by_source as
select
  i.workspace_id,
  i.source_id,
  'stripe'::text as provider,
  date(i.paid_at) as occurred_on,
  i.currency,
  i.external_order_id,
  i.stripe_customer_id as customer_external_id,
  i.stripe_invoice_id as invoice_external_id,
  null::text as product_external_id,
  null::text as price_external_id,
  i.amount_paid::numeric as recognized_revenue,
  -- Null means "Stripe reported no credit-note amount on this invoice", NOT zero.
  i.post_payment_credit_notes_amount::numeric as post_payment_credited_minor
from stripe_invoices i
left join queryable.vw_stripe_customer_metric_eligibility e
  on e.workspace_id = i.workspace_id
 and e.source_id = i.source_id
 and e.stripe_customer_id = i.stripe_customer_id
where i.status = 'paid'
  and coalesce(e.is_business_eligible, true);

update queryable_views
set
  source_tables = '["stripe_subscriptions","stripe_subscription_items","stripe_customers","stripe_invoices"]',
  caveats = 'connected_stripe_source;current_paid_is_snapshot;new_paid_uses_trial_end_or_subscription_created_at;trialing_is_separate_from_paid;mrr_from_subscription_items;business_customer_eligibility_workspace_source_customer;churn_requires_positive_paid_invoice'
where id = 'queryable.vw_stripe_subscription_lifecycle';

update queryable_views
set
  source_tables = '["stripe_invoices","stripe_customers"]',
  caveats = 'gross_paid_invoice_amount;business_customer_eligibility_workspace_source_customer;gross_of_refunds;post_payment_credit_notes_exposed_not_netted;direct_charge_refunds_without_credit_notes_not_captured;not_accounting_revenue;not_proof_of_cash_receipt;content_linkage_not_implemented',
  updated_at = now()
where id = 'queryable.vw_revenue_by_source';

update metric_definitions
set
  name = 'Gross paid invoice amount',
  description = 'Gross paid invoice amount on business-eligible paid Stripe invoices',
  caveats = 'Stripe amount_paid;explicit internal_test customers excluded;missing classification remains eligible;gross of later refunds;not accounting revenue;not proof of cash receipt;MRR is a separate recurring snapshot',
  version = version + 1
where id = 'recognized_revenue';
