-- Stripe subscription lifecycle metrics.
-- Keep invoice/payment revenue truth intact, but stop using signup-day active/trialing
-- subscription rows as the "paid subscribers" authority.

alter table stripe_subscriptions
  add column if not exists trial_start timestamptz,
  add column if not exists trial_end timestamptz,
  add column if not exists cancel_at timestamptz,
  add column if not exists canceled_at timestamptz,
  add column if not exists ended_at timestamptz;

create table if not exists stripe_subscription_items (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_subscription_item_id text not null,
  stripe_subscription_id text not null,
  stripe_price_id text,
  stripe_product_id text,
  currency text,
  unit_amount bigint,
  quantity bigint not null default 1,
  recurring_interval text,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_subscription_item_id)
);

create index if not exists idx_stripe_subscription_items_workspace_id
  on stripe_subscription_items(workspace_id);
create index if not exists idx_stripe_subscription_items_source_subscription
  on stripe_subscription_items(source_id, stripe_subscription_id);

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
  and coalesce(canceled_at, ended_at, current_period_end) is not null
group by workspace_id, source_id, provider, date(coalesce(canceled_at, ended_at, current_period_end)), status, currency;

-- Back-compat name: keep old metric id alive, but make it read current paid stock.
drop view if exists queryable.vw_stripe_paid_subscribers;

create or replace view queryable.vw_stripe_paid_subscribers as
select
  workspace_id,
  source_id,
  provider,
  occurred_on,
  status,
  currency,
  stripe_current_paid_subscribers as stripe_paid_subscribers
from queryable.vw_stripe_subscription_lifecycle
where metric_kind = 'current_paid_subscribers';

insert into queryable_views (
  id, view_name, description, row_grain, default_time_column,
  allowed_dimensions, allowed_measures, source_tables, freshness_target, caveats, drilldown_action
)
values (
  'queryable.vw_stripe_subscription_lifecycle',
  'vw_stripe_subscription_lifecycle',
  'Stripe connected-account subscription lifecycle view',
  'workspace/source/lifecycle_metric/day/currency',
  'occurred_on',
  '["provider","metric_kind","status","currency"]',
  '["stripe_current_paid_subscribers","stripe_new_paid_subscribers","stripe_trialing_subscribers","stripe_churned_subscribers"]',
  '["stripe_subscriptions","stripe_subscription_items"]',
  '24 hours',
  'connected_stripe_source;current_paid_is_snapshot;new_paid_uses_trial_end_or_subscription_created_at;trialing_is_separate_from_paid;mrr_from_subscription_items',
  'drilldown.stripe_subscription_rows'
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

update queryable_views
set
  description = 'Stripe current paid subscriber compatibility view',
  row_grain = 'workspace/source/current_snapshot/currency',
  allowed_dimensions = '["provider","status","currency"]',
  allowed_measures = '["stripe_paid_subscribers"]',
  source_tables = '["stripe_subscriptions","stripe_subscription_items"]',
  caveats = 'compatibility_metric;use_stripe_current_paid_subscribers_for_new_work;current_paid_is_snapshot',
  drilldown_action = 'drilldown.stripe_subscription_rows'
where id = 'queryable.vw_stripe_paid_subscribers';

insert into metric_definitions (
  id, name, description, aliases, source_view, expression, metric_type, unit,
  aggregation, default_time_column, allowed_dimensions, caveats, examples
)
values
(
  'stripe_current_paid_subscribers',
  'Current paid subscribers',
  'Distinct connected-Stripe customers with positive recurring value and an active or past_due subscription.',
  '["current paid subscribers","active paid subscribers","paid customers","active customers"]',
  'queryable.vw_stripe_subscription_lifecycle',
  '{"type":"direct_column","view":"queryable.vw_stripe_subscription_lifecycle","column":"stripe_current_paid_subscribers","aggregate":"sum"}',
  'count',
  'subscribers',
  'sum',
  'occurred_on',
  '["provider","currency"]',
  'current_snapshot;positive_recurring_value_only;trialing_excluded;past_due_included_as_delinquent_not_churned',
  '["How many paid subscribers do we have now?"]'
),
(
  'stripe_new_paid_subscribers',
  'New paid subscribers',
  'Distinct connected-Stripe customers whose positive recurring subscription first became paid in the selected range.',
  '["new paid subscribers","new customers","new paid customers"]',
  'queryable.vw_stripe_subscription_lifecycle',
  '{"type":"direct_column","view":"queryable.vw_stripe_subscription_lifecycle","column":"stripe_new_paid_subscribers","aggregate":"sum"}',
  'count',
  'subscribers',
  'sum',
  'occurred_on',
  '["provider","status","currency"]',
  'positive_recurring_value_only;uses_trial_end_or_subscription_created_at_as_first_paid_date;reactivations_not_yet_split',
  '["How many new paid customers did the site create this week?"]'
),
(
  'stripe_trialing_subscribers',
  'Trialing subscribers',
  'Distinct connected-Stripe customers currently trialing, counted separately from paid subscribers.',
  '["trialing subscribers","trials","new trials"]',
  'queryable.vw_stripe_subscription_lifecycle',
  '{"type":"direct_column","view":"queryable.vw_stripe_subscription_lifecycle","column":"stripe_trialing_subscribers","aggregate":"sum"}',
  'count',
  'subscribers',
  'sum',
  'occurred_on',
  '["provider","currency"]',
  'trialing_is_not_paid;stripe_dashboard_new_trials_are_subscription_grained',
  '["How many trials started this week?"]'
),
(
  'stripe_churned_subscribers',
  'Churned subscribers',
  'Distinct connected-Stripe customers whose subscription is canceled or unpaid in the selected range.',
  '["churned subscribers","churned customers","cancellations"]',
  'queryable.vw_stripe_subscription_lifecycle',
  '{"type":"direct_column","view":"queryable.vw_stripe_subscription_lifecycle","column":"stripe_churned_subscribers","aggregate":"sum"}',
  'count',
  'subscribers',
  'sum',
  'occurred_on',
  '["provider","status","currency"]',
  'customer_churn_requires_all_paid_subscriptions_zero;v1_uses_subscription_status_rows',
  '["How many subscribers churned this month?"]'
),
(
  'stripe_paid_subscribers',
  'Paid subscribers',
  'Compatibility metric for current paid subscribers. New code should use stripe_current_paid_subscribers.',
  '["paid subscribers","subscribers","paid customers","customers"]',
  'queryable.vw_stripe_paid_subscribers',
  '{"type":"direct_column","view":"queryable.vw_stripe_paid_subscribers","column":"stripe_paid_subscribers","aggregate":"sum"}',
  'count',
  'subscribers',
  'sum',
  'occurred_on',
  '["provider","currency"]',
  'deprecated_metric_id;current_paid_is_snapshot;use_stripe_current_paid_subscribers_for_new_work',
  '["How many paid subscribers do we have now?"]'
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

grant select, insert, update on stripe_subscription_items to growth_os_worker;
grant select on queryable.vw_stripe_subscription_lifecycle, queryable.vw_stripe_paid_subscribers to growth_os_tool_agent, growth_os_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on queryable.vw_stripe_subscription_lifecycle, queryable.vw_stripe_paid_subscribers to growth_os_read_api;
  end if;
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on queryable.vw_stripe_subscription_lifecycle, queryable.vw_stripe_paid_subscribers to engine_app;
  end if;
end
$$;
