-- Complete, ordered Stripe recurring-value truth.
-- Infinite policy: forward MRR applies active forever/repeating discounts and ignores once.

alter table stripe_subscriptions
  add column if not exists items_sync_complete boolean not null default false,
  add column if not exists discounts_sync_complete boolean not null default false;

alter table stripe_prices
  add column if not exists recurring_interval_count integer,
  add column if not exists recurring_usage_type text,
  add column if not exists billing_scheme text,
  add column if not exists custom_unit_amount boolean not null default false,
  add column if not exists pricing_state text,
  add column if not exists currency_options jsonb not null default '{}'::jsonb,
  add column if not exists transform_quantity_divide_by integer,
  add column if not exists transform_quantity_round text;

alter table stripe_subscription_items
  alter column quantity drop not null,
  add column if not exists recurring_interval_count integer,
  add column if not exists recurring_usage_type text,
  add column if not exists billing_scheme text,
  add column if not exists custom_unit_amount boolean not null default false,
  add column if not exists pricing_state text,
  add column if not exists default_currency text,
  add column if not exists default_unit_amount bigint,
  add column if not exists price_currency_options jsonb not null default '{}'::jsonb,
  add column if not exists currency_option_resolved boolean not null default true,
  add column if not exists transform_quantity_divide_by integer,
  add column if not exists transform_quantity_round text;

create table if not exists stripe_subscription_discounts (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_subscription_id text not null,
  target_type text not null check (target_type in ('subscription', 'item')),
  target_id text not null,
  stripe_discount_id text,
  position integer not null check (position >= 0),
  amount_off bigint,
  percent_off numeric,
  currency text,
  duration text,
  starts_at timestamptz,
  ends_at timestamptz,
  is_complete boolean not null default false,
  incomplete_reason text,
  applies_to_product_ids text[] not null default array[]::text[],
  amount_off_currency_options jsonb not null default '{}'::jsonb,
  currency_option_resolved boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, source_id, stripe_subscription_id, target_type, target_id, position)
);

create index if not exists idx_stripe_subscription_discounts_scope
  on stripe_subscription_discounts(workspace_id, source_id, stripe_subscription_id);

create or replace view queryable.vw_stripe_subscription_recurring_value as
with recursive
item_base as (
  select
    i.id as item_row_id,
    i.workspace_id,
    i.source_id,
    i.stripe_subscription_id,
    i.stripe_subscription_item_id,
    i.currency,
    i.recurring_interval,
    i.recurring_interval_count,
    i.pricing_state,
    case
      when i.recurring_interval_count is null or i.recurring_interval_count <= 0 then null
      when i.recurring_interval = 'month' then 1::numeric / i.recurring_interval_count
      when i.recurring_interval = 'year' then 1::numeric / (12 * i.recurring_interval_count)
      when i.recurring_interval = 'week' then 52::numeric / (12 * i.recurring_interval_count)
      when i.recurring_interval = 'day' then 365::numeric / (12 * i.recurring_interval_count)
      else null
    end as monthly_factor,
    case
      when s.items_sync_complete is not true then false
      when i.currency_option_resolved is not true then false
      when (i.transform_quantity_divide_by is null) <> (i.transform_quantity_round is null) then false
      when i.transform_quantity_divide_by is not null
       and (i.transform_quantity_divide_by <= 0 or i.transform_quantity_round not in ('up', 'down')) then false
      -- coalesce(): a NULL pricing_state is UNKNOWN pricing, never licensed. Without it the
      -- comparison is NULL, the row falls through to `else true`, and an unpriceable item is
      -- stamped complete with a zero amount.
      when coalesce(i.pricing_state, '') <> 'licensed_per_unit' then false
      when i.unit_amount is null then false
      when i.quantity is null then false
      when i.currency is null then false
      when i.recurring_interval_count is null or i.recurring_interval_count <= 0 then false
      when i.recurring_interval not in ('day', 'week', 'month', 'year') then false
      else true
    end as list_complete,
    case
      when s.items_sync_complete is not true then 'items_sync_incomplete'
      when i.currency_option_resolved is not true then 'price_currency_option_unresolved'
      when (i.transform_quantity_divide_by is null) <> (i.transform_quantity_round is null) then 'invalid_transform_quantity'
      when i.transform_quantity_divide_by is not null
       and (i.transform_quantity_divide_by <= 0 or i.transform_quantity_round not in ('up', 'down')) then 'invalid_transform_quantity'
      when i.pricing_state = 'metered' then 'metered_item'
      when i.pricing_state = 'tiered' then 'tiered_item'
      when i.pricing_state = 'custom' then 'custom_price_item'
      when i.pricing_state = 'unknown_price' then 'unknown_price_item'
      when coalesce(i.pricing_state, '') <> 'licensed_per_unit' then 'unknown_pricing_state'
      when i.unit_amount is null then 'unknown_price_item'
      when i.quantity is null then 'unknown_quantity'
      when i.currency is null then 'missing_currency'
      when i.recurring_interval_count is null or i.recurring_interval_count <= 0 then 'invalid_interval_count'
      when i.recurring_interval not in ('day', 'week', 'month', 'year') then 'unknown_interval'
      else null
    end as list_reason,
    -- List value is LICENSED-ONLY and QUANTITY-EXPLICIT. A metered/tiered/custom/unknown price
    -- carrying a unit_amount is a per-usage rate, not a flat monthly charge, so it contributes
    -- nothing to list MRR. A null quantity is UNKNOWN (never priced as 1) and contributes nothing.
    -- An unusable transform_quantity contributes nothing (and never divides by zero).
    case
      when i.pricing_state = 'licensed_per_unit'
       and i.unit_amount is not null
       and i.quantity is not null
       and i.recurring_interval_count > 0
       and i.recurring_interval in ('day', 'week', 'month', 'year')
       and (i.transform_quantity_divide_by is null) = (i.transform_quantity_round is null)
       and (
         i.transform_quantity_divide_by is null
         or (i.transform_quantity_divide_by > 0 and i.transform_quantity_round in ('up', 'down'))
       )
      then i.unit_amount::numeric *
        case
          when i.transform_quantity_divide_by is null then i.quantity::numeric
          when i.transform_quantity_round = 'up' then ceil(i.quantity::numeric / i.transform_quantity_divide_by)
          else floor(i.quantity::numeric / i.transform_quantity_divide_by)
        end *
        case
          when i.recurring_interval = 'month' then 1::numeric / i.recurring_interval_count
          when i.recurring_interval = 'year' then 1::numeric / (12 * i.recurring_interval_count)
          when i.recurring_interval = 'week' then 52::numeric / (12 * i.recurring_interval_count)
          when i.recurring_interval = 'day' then 365::numeric / (12 * i.recurring_interval_count)
        end
      else null
    end as list_monthly_amount_cents,
    s.discounts_sync_complete,
    coalesce((
      select count(*) from stripe_subscription_discounts d
       where d.workspace_id = i.workspace_id
         and d.source_id = i.source_id
         and d.stripe_subscription_id = i.stripe_subscription_id
         and d.target_type = 'item'
         and d.target_id = i.stripe_subscription_item_id
    ), 0)::integer as discount_count
  from stripe_subscription_items i
  join stripe_subscriptions s
    on s.workspace_id = i.workspace_id
   and s.source_id = i.source_id
   and s.stripe_subscription_id = i.stripe_subscription_id
),
item_discount_ordered as (
  select
    d.*,
    row_number() over (
      partition by d.workspace_id, d.source_id, d.stripe_subscription_id, d.target_id
      order by d.position, d.id
    )::integer as step_no
  from stripe_subscription_discounts d
  where d.target_type = 'item'
),
item_steps as (
  select
    b.item_row_id,
    b.workspace_id,
    b.source_id,
    b.stripe_subscription_id,
    b.stripe_subscription_item_id,
    b.currency,
    b.monthly_factor,
    b.list_monthly_amount_cents,
    b.discount_count,
    0::integer as step_no,
    b.list_monthly_amount_cents as net_monthly_amount_cents,
    (b.list_complete and b.discounts_sync_complete) as net_complete,
    array_remove(array[
      b.list_reason,
      case when b.discounts_sync_complete is not true then 'discounts_sync_incomplete' end
    ]::text[], null) as reasons
  from item_base b

  union all

  select
    s.item_row_id,
    s.workspace_id,
    s.source_id,
    s.stripe_subscription_id,
    s.stripe_subscription_item_id,
    s.currency,
    s.monthly_factor,
    s.list_monthly_amount_cents,
    s.discount_count,
    s.step_no + 1,
    case
      when d.duration = 'once' then s.net_monthly_amount_cents
      when d.starts_at is not null and d.starts_at > now() then s.net_monthly_amount_cents
      when d.ends_at is not null and d.ends_at <= now() then s.net_monthly_amount_cents
      when d.duration not in ('forever', 'repeating') then s.net_monthly_amount_cents
      when cardinality(d.applies_to_product_ids) > 0 then s.net_monthly_amount_cents
      when d.currency_option_resolved is not true then s.net_monthly_amount_cents
      when d.is_complete is not true then s.net_monthly_amount_cents
      when d.amount_off is not null and d.currency is distinct from s.currency then s.net_monthly_amount_cents
      when d.amount_off is not null then greatest(0, s.net_monthly_amount_cents - d.amount_off::numeric * s.monthly_factor)
      when d.percent_off is not null then greatest(0, s.net_monthly_amount_cents * (1 - d.percent_off / 100))
      else s.net_monthly_amount_cents
    end,
    s.net_complete and case
      when d.duration = 'once' then true
      when d.starts_at is not null and d.starts_at > now() then true
      when d.ends_at is not null and d.ends_at <= now() then true
      when d.duration not in ('forever', 'repeating') then false
      when cardinality(d.applies_to_product_ids) > 0 then false
      when d.currency_option_resolved is not true then false
      when d.is_complete is not true then false
      when d.amount_off is not null and d.currency is distinct from s.currency then false
      else true
    end,
    s.reasons || case
      when d.duration = 'once' then array[]::text[]
      when d.starts_at is not null and d.starts_at > now() then array[]::text[]
      when d.ends_at is not null and d.ends_at <= now() then array[]::text[]
      when d.duration not in ('forever', 'repeating') then array['unknown_discount_duration']::text[]
      when cardinality(d.applies_to_product_ids) > 0 then array['product_restricted_discount_unsupported']::text[]
      when d.currency_option_resolved is not true then array['discount_currency_option_unresolved']::text[]
      when d.is_complete is not true then array[coalesce(d.incomplete_reason, 'incomplete_discount_definition')]::text[]
      when d.amount_off is not null and d.currency is distinct from s.currency then array['amount_discount_currency_mismatch']::text[]
      else array[]::text[]
    end
  from item_steps s
  join item_discount_ordered d
    on d.workspace_id = s.workspace_id
   and d.source_id = s.source_id
   and d.stripe_subscription_id = s.stripe_subscription_id
   and d.target_id = s.stripe_subscription_item_id
   and d.step_no = s.step_no + 1
),
item_final as (
  select * from item_steps where step_no = discount_count
),
subscription_base as (
  select
    sub.workspace_id,
    sub.source_id,
    sub.stripe_subscription_id,
    sub.stripe_customer_id,
    sub.status,
    sub.created_at_source,
    sub.current_period_start,
    sub.current_period_end,
    sub.trial_start,
    sub.trial_end,
    sub.cancel_at,
    sub.canceled_at,
    sub.ended_at,
    case when count(f.item_row_id) = 0 then null
         when count(distinct f.currency) = 1 then min(f.currency)
         else null end as currency,
    coalesce(sum(f.list_monthly_amount_cents), 0) as list_monthly_amount_cents,
    coalesce(sum(f.net_monthly_amount_cents), 0) as item_net_monthly_amount_cents,
    count(f.item_row_id) > 0
      and bool_and(f.net_complete)
      and count(distinct f.currency) = 1 as item_net_complete,
    case when min(f.monthly_factor) = max(f.monthly_factor) then min(f.monthly_factor) else null end as common_monthly_factor,
    -- nullif() drops items whose reason array is EMPTY so string_agg skips them entirely;
    -- without it two clean items aggregate to ',' and yield two empty-string reason codes.
    coalesce(
      string_to_array(nullif(string_agg(nullif(array_to_string(f.reasons, ','), ''), ','), ''), ','),
      array[]::text[]
    )
      || case when count(f.item_row_id) = 0 then array['no_subscription_items']::text[] else array[]::text[] end
      || case when count(distinct f.currency) > 1 then array['mixed_subscription_currencies']::text[] else array[]::text[] end
      as reasons,
    coalesce((
      select count(*) from stripe_subscription_discounts d
       where d.workspace_id = sub.workspace_id
         and d.source_id = sub.source_id
         and d.stripe_subscription_id = sub.stripe_subscription_id
         and d.target_type = 'subscription'
         and d.target_id = sub.stripe_subscription_id
    ), 0)::integer as discount_count
  from stripe_subscriptions sub
  left join item_final f
    on f.workspace_id = sub.workspace_id
   and f.source_id = sub.source_id
   and f.stripe_subscription_id = sub.stripe_subscription_id
  group by sub.workspace_id, sub.source_id, sub.stripe_subscription_id,
    sub.stripe_customer_id, sub.status, sub.created_at_source,
    sub.current_period_start, sub.current_period_end, sub.trial_start,
    sub.trial_end, sub.cancel_at, sub.canceled_at, sub.ended_at
),
subscription_discount_ordered as (
  select
    d.*,
    row_number() over (
      partition by d.workspace_id, d.source_id, d.stripe_subscription_id
      order by d.position, d.id
    )::integer as step_no
  from stripe_subscription_discounts d
  where d.target_type = 'subscription'
),
subscription_steps as (
  select
    b.*,
    0::integer as step_no,
    b.item_net_monthly_amount_cents as net_monthly_amount_cents,
    b.item_net_complete as net_complete
  from subscription_base b

  union all

  select
    s.workspace_id, s.source_id, s.stripe_subscription_id, s.stripe_customer_id,
    s.status, s.created_at_source, s.current_period_start, s.current_period_end,
    s.trial_start, s.trial_end, s.cancel_at, s.canceled_at, s.ended_at,
    s.currency, s.list_monthly_amount_cents, s.item_net_monthly_amount_cents,
    s.item_net_complete, s.common_monthly_factor,
    s.reasons || case
      when d.duration = 'once' then array[]::text[]
      when d.starts_at is not null and d.starts_at > now() then array[]::text[]
      when d.ends_at is not null and d.ends_at <= now() then array[]::text[]
      when d.duration not in ('forever', 'repeating') then array['unknown_discount_duration']::text[]
      when cardinality(d.applies_to_product_ids) > 0 then array['product_restricted_discount_unsupported']::text[]
      when d.currency_option_resolved is not true then array['discount_currency_option_unresolved']::text[]
      when d.is_complete is not true then array[coalesce(d.incomplete_reason, 'incomplete_discount_definition')]::text[]
      when d.amount_off is not null and d.currency is distinct from s.currency then array['amount_discount_currency_mismatch']::text[]
      when d.amount_off is not null and s.common_monthly_factor is null then array['mixed_interval_amount_discount']::text[]
      else array[]::text[]
    end,
    s.discount_count,
    s.step_no + 1,
    case
      when d.duration = 'once' then s.net_monthly_amount_cents
      when d.starts_at is not null and d.starts_at > now() then s.net_monthly_amount_cents
      when d.ends_at is not null and d.ends_at <= now() then s.net_monthly_amount_cents
      when d.duration not in ('forever', 'repeating') then s.net_monthly_amount_cents
      when cardinality(d.applies_to_product_ids) > 0 then s.net_monthly_amount_cents
      when d.currency_option_resolved is not true then s.net_monthly_amount_cents
      when d.is_complete is not true then s.net_monthly_amount_cents
      when d.amount_off is not null and d.currency is distinct from s.currency then s.net_monthly_amount_cents
      when d.amount_off is not null and s.common_monthly_factor is null then s.net_monthly_amount_cents
      when d.amount_off is not null then greatest(0, s.net_monthly_amount_cents - d.amount_off::numeric * s.common_monthly_factor)
      when d.percent_off is not null then greatest(0, s.net_monthly_amount_cents * (1 - d.percent_off / 100))
      else s.net_monthly_amount_cents
    end,
    s.net_complete and case
      when d.duration = 'once' then true
      when d.starts_at is not null and d.starts_at > now() then true
      when d.ends_at is not null and d.ends_at <= now() then true
      when d.duration not in ('forever', 'repeating') then false
      when cardinality(d.applies_to_product_ids) > 0 then false
      when d.currency_option_resolved is not true then false
      when d.is_complete is not true then false
      when d.amount_off is not null and d.currency is distinct from s.currency then false
      when d.amount_off is not null and s.common_monthly_factor is null then false
      else true
    end
  from subscription_steps s
  join subscription_discount_ordered d
    on d.workspace_id = s.workspace_id
   and d.source_id = s.source_id
   and d.stripe_subscription_id = s.stripe_subscription_id
   and d.step_no = s.step_no + 1
),
final_value as (
  select * from subscription_steps where step_no = discount_count
)
select
  f.workspace_id,
  f.source_id,
  f.stripe_subscription_id,
  f.stripe_customer_id,
  f.status,
  f.currency,
  f.list_monthly_amount_cents,
  case when f.net_complete then f.net_monthly_amount_cents else null end as net_monthly_amount_cents,
  case
    when 'mixed_subscription_currencies' = any(f.reasons) then 'mixed_currency'
    when f.net_complete then 'complete'
    when f.list_monthly_amount_cents > 0 then 'list_only'
    else 'unavailable'
  end as value_state,
  array(
    select distinct reason from unnest(f.reasons) reason
     where reason is not null and reason <> ''
     order by reason
  ) as incomplete_reasons,
  f.created_at_source,
  f.current_period_start,
  f.current_period_end,
  f.trial_start,
  f.trial_end,
  f.cancel_at,
  f.canceled_at,
  f.ended_at,
  coalesce(e.is_business_eligible, true) as business_eligible
from final_value f
left join queryable.vw_stripe_customer_metric_eligibility e
  on e.workspace_id = f.workspace_id
 and e.source_id = f.source_id
 and e.stripe_customer_id = f.stripe_customer_id;

create or replace view queryable.vw_stripe_subscription_lifecycle as
with connected_workspaces as (
  select distinct workspace_id
  from sources
  where provider = 'stripe' and status = 'connected'
),
paying_customers as (
  select distinct workspace_id, source_id, stripe_customer_id
  from stripe_invoices
  where status = 'paid' and amount_paid > 0 and stripe_customer_id is not null
),
base as (
  select
    v.*,
    'stripe'::text as provider,
    coalesce(nullif(v.stripe_customer_id, ''), v.stripe_subscription_id) as subscriber_key,
    (p.stripe_customer_id is not null) as has_positive_payment
  from queryable.vw_stripe_subscription_recurring_value v
  join sources connected_source
    on connected_source.workspace_id = v.workspace_id
   and connected_source.id = v.source_id
   and connected_source.provider = 'stripe'
   and connected_source.status = 'connected'
  left join paying_customers p
    on p.workspace_id = v.workspace_id
   and p.source_id = v.source_id
   and p.stripe_customer_id = v.stripe_customer_id
  where v.business_eligible
)
select cw.workspace_id, null::text as source_id, 'stripe'::text as provider, current_date as occurred_on,
  'current_paid_subscribers'::text as metric_kind, null::text as status,
  null::text as currency,
  case
    when coalesce(bool_or(
      b.status in ('active', 'past_due') and b.value_state <> 'complete'
    ), false) then null::bigint
    else count(distinct case
      when b.status in ('active', 'past_due')
       and b.value_state = 'complete'
       and b.net_monthly_amount_cents > 0
      then jsonb_build_array(b.source_id, b.subscriber_key)::text
    end)::bigint
  end as stripe_current_paid_subscribers,
  0::bigint as stripe_new_paid_subscribers, 0::bigint as stripe_trialing_subscribers,
  0::bigint as stripe_churned_subscribers
from connected_workspaces cw
left join base b on b.workspace_id = cw.workspace_id
group by cw.workspace_id

union all

select workspace_id, source_id, provider, date(coalesce(trial_end, created_at_source)),
  'new_paid_subscribers'::text, status, null::text, 0::bigint,
  count(distinct subscriber_key), 0::bigint, 0::bigint
from base
where status in ('active', 'past_due') and value_state = 'complete'
  and net_monthly_amount_cents > 0 and coalesce(trial_end, created_at_source) is not null
group by workspace_id, source_id, provider, date(coalesce(trial_end, created_at_source)), status

union all

select workspace_id, source_id, provider, date(coalesce(trial_start, created_at_source)),
  'trialing_subscribers'::text, status, null::text, 0::bigint, 0::bigint,
  count(distinct subscriber_key), 0::bigint
from base
where status = 'trialing' and coalesce(trial_start, created_at_source) is not null
group by workspace_id, source_id, provider, date(coalesce(trial_start, created_at_source)), status

union all

select workspace_id, source_id, provider, date(coalesce(canceled_at, ended_at, current_period_end)),
  'churned_subscribers'::text, status, null::text, 0::bigint, 0::bigint, 0::bigint,
  count(distinct subscriber_key)
from base
where status in ('canceled', 'unpaid') and has_positive_payment
  and coalesce(canceled_at, ended_at, current_period_end) is not null
group by workspace_id, source_id, provider,
  date(coalesce(canceled_at, ended_at, current_period_end)), status;

create or replace view queryable.vw_stripe_paid_subscribers as
select workspace_id, source_id, provider, occurred_on, status, currency,
  stripe_current_paid_subscribers as stripe_paid_subscribers
from queryable.vw_stripe_subscription_lifecycle
where metric_kind = 'current_paid_subscribers';

insert into queryable_views (
  id, view_name, description, row_grain, default_time_column,
  allowed_dimensions, allowed_measures, source_tables, freshness_target, caveats, drilldown_action
) values (
  'queryable.vw_stripe_subscription_recurring_value',
  'vw_stripe_subscription_recurring_value',
  'Complete normalized Stripe list and net recurring value by subscription',
  'workspace/source/subscription',
  'created_at_source',
  '["status","currency","value_state","business_eligible"]',
  '["list_monthly_amount_cents","net_monthly_amount_cents"]',
  '["stripe_subscriptions","stripe_subscription_items","stripe_subscription_discounts","stripe_customers"]',
  '24 hours',
  'licensed_per_unit_only;list_value_excludes_metered_tiered_and_custom_prices;interval_count_aware;quantity_null_is_unknown_not_one;quantity_zero_is_zero;item_discounts_before_subscription_discounts;active_forever_and_repeating_discounts;once_discount_excluded_by_infinite_policy;no_cross_currency_sum;incomplete_is_explicit',
  'drilldown.stripe_subscription_rows'
) on conflict (id) do update set
  description = excluded.description,
  row_grain = excluded.row_grain,
  allowed_dimensions = excluded.allowed_dimensions,
  allowed_measures = excluded.allowed_measures,
  source_tables = excluded.source_tables,
  caveats = excluded.caveats;

update queryable_views
set source_tables = '["stripe_subscriptions","stripe_subscription_items","stripe_subscription_discounts","stripe_customers","stripe_invoices"]',
    row_grain = 'workspace/current-snapshot for current paid; workspace/source/day/status for lifecycle movement',
    caveats = 'connected_stripe_sources_only;current_paid_is_one_workspace_row;current_paid_null_if_any_eligible_active_or_past_due_value_is_incomplete;current_paid_zero_is_measured_zero;subscriber_identity_is_source_safe;new_paid_uses_trial_end_or_subscription_created_at;trialing_is_separate_from_paid;business_customer_eligibility_workspace_source_customer;churn_requires_positive_paid_invoice'
where id = 'queryable.vw_stripe_subscription_lifecycle';

update metric_definitions
set description = 'Workspace-wide distinct business-eligible customers with positive complete net recurring value across connected Stripe sources; unavailable if any eligible active or past_due recurring value is incomplete.',
    caveats = 'workspace_current_snapshot;nullable_authority;zero_is_measured_only_when_all_eligible_active_rows_are_complete;subscriber_identity_is_source_safe;recurring_discounts_applied;trialing_excluded;past_due_included_as_delinquent_not_churned',
    version = version + 1
where id in ('stripe_current_paid_subscribers', 'stripe_paid_subscribers');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update, delete on stripe_subscription_discounts to engine_app;
    grant select, insert, update, delete on stripe_subscription_items to engine_app;
    grant select on queryable.vw_stripe_subscription_recurring_value to engine_app;
  end if;
end $$;

grant select on stripe_subscription_discounts to growth_os_tool_agent, growth_os_app;
grant select on queryable.vw_stripe_subscription_recurring_value to growth_os_tool_agent, growth_os_app;
