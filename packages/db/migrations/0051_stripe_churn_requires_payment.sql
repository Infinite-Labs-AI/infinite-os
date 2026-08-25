-- Churn is a lost paying subscriber, not every canceled Stripe subscription.
-- Requiring a positive paid invoice also keeps never-paid historical test
-- subscriptions out when their deleted Customer can no longer be classified.

create or replace view queryable.vw_stripe_subscription_lifecycle as
with subscription_mrr as (
  select
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
  group by source_id, stripe_subscription_id
),
paying_customers as (
  select distinct source_id, stripe_customer_id
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
    on m.source_id = s.source_id
   and m.stripe_subscription_id = s.stripe_subscription_id
  left join stripe_customers c
    on c.source_id = s.source_id
   and c.stripe_customer_id = s.stripe_customer_id
  left join paying_customers p
    on p.source_id = s.source_id
   and p.stripe_customer_id = s.stripe_customer_id
  where coalesce(c.metrics_classification, '') <> 'internal_test'
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

update queryable_views
set caveats = 'connected_stripe_source;current_paid_is_snapshot;new_paid_uses_trial_end_or_subscription_created_at;trialing_is_separate_from_paid;mrr_from_subscription_items;customer_metrics_classification_exclusion;churn_requires_positive_paid_invoice'
where id = 'queryable.vw_stripe_subscription_lifecycle';
