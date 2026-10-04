-- Stripe paid subscribers metric.
-- Counts distinct Stripe customers whose subscription is currently active or trialing,
-- grouped by the subscription signup day. This is a customer-count metric, not revenue.

create or replace view queryable.vw_stripe_paid_subscribers as
select
  workspace_id,
  source_id,
  'stripe'::text as provider,
  date(coalesce(created_at_source, created_at)) as occurred_on,
  status,
  count(distinct coalesce(nullif(stripe_customer_id, ''), stripe_subscription_id)) as stripe_paid_subscribers
from stripe_subscriptions
where status in ('active', 'trialing')
group by
  workspace_id,
  source_id,
  date(coalesce(created_at_source, created_at)),
  status;

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
  'queryable.vw_stripe_paid_subscribers',
  'vw_stripe_paid_subscribers',
  'Stripe paid subscribers authority view',
  'day/source/status',
  'occurred_on',
  '["provider","status"]',
  '["stripe_paid_subscribers"]',
  '["stripe_subscriptions"]',
  '24 hours',
  'stripe_subscription_status_active_or_trialing;subscriber_signup_day;distinct_customer_count',
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
  'stripe_paid_subscribers',
  'Paid subscribers',
  'Stripe active or trialing subscription customers by signup day',
  '["paid subscribers","subscribers","paid customers","customers"]',
  'queryable.vw_stripe_paid_subscribers',
  '{"type":"direct_column","view":"queryable.vw_stripe_paid_subscribers","column":"stripe_paid_subscribers","aggregate":"sum"}',
  'count',
  'subscribers',
  'sum',
  'occurred_on',
  '["provider","status"]',
  'Stripe is the first-phase paid-subscriber authority; active/trialing subscriptions only; grouped by subscription signup day',
  '["How many paid subscribers signed up this week?"]'
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

grant select on queryable.vw_stripe_paid_subscribers to growth_os_tool_agent, growth_os_app;
