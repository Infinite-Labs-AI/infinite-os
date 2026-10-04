-- Immutable Stripe lifecycle evidence, event-proven trial spells, and completed-segment coverage.
-- Cohort/current aggregate views are defined after the writer contract in this migration.

alter table stripe_subscriptions
  add column if not exists livemode boolean;

create table if not exists stripe_trial_history_segments (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  segment_from timestamptz not null,
  segment_to_exclusive timestamptz not null,
  closed_at timestamptz not null default now(),
  parser_version text not null,
  unique (workspace_id, source_id, id),
  unique (workspace_id, source_id, segment_from, segment_to_exclusive),
  check (segment_from < segment_to_exclusive)
);

create table if not exists stripe_subscription_lifecycle_events (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_event_id text not null,
  event_type text not null,
  event_created_at timestamptz not null,
  api_version text,
  livemode boolean,
  stripe_subscription_id text not null,
  stripe_customer_id text,
  current_status text,
  previous_status text,
  trial_start timestamptz,
  trial_end timestamptz,
  ended_at timestamptz,
  canceled_at timestamptz,
  previous_trial_start timestamptz,
  previous_trial_end timestamptz,
  segment_from timestamptz not null,
  segment_to_exclusive timestamptz not null,
  segment_closed_at timestamptz,
  published_segment_id text,
  business_eligible_at_capture boolean not null,
  parser_version text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, source_id, stripe_event_id),
  check (segment_from < segment_to_exclusive),
  check (event_created_at >= segment_from and event_created_at < segment_to_exclusive),
  check ((segment_closed_at is null) = (published_segment_id is null)),
  foreign key (workspace_id, source_id, published_segment_id)
    references stripe_trial_history_segments(workspace_id, source_id, id)
);

create index if not exists stripe_subscription_lifecycle_events_scope_time_idx
  on stripe_subscription_lifecycle_events(workspace_id, source_id, event_created_at, stripe_event_id);
create index if not exists stripe_subscription_lifecycle_events_subscription_idx
  on stripe_subscription_lifecycle_events(workspace_id, source_id, stripe_subscription_id, event_created_at);

create table if not exists stripe_trial_spells (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  stripe_subscription_id text not null,
  stripe_customer_id text,
  start_event_id text not null,
  start_at timestamptz not null,
  scheduled_trial_end timestamptz,
  effective_trial_end timestamptz,
  end_event_id text,
  end_authority text,
  terminal_status text,
  livemode boolean,
  business_eligible_at_capture boolean not null,
  frozen_currency text,
  frozen_net_monthly_amount_minor numeric(38,12),
  frozen_value_observed_at timestamptz,
  frozen_value_evidence_hash text,
  frozen_value_provenance text check (
    frozen_value_provenance is null
    or frozen_value_provenance = 'first_complete_current_observation_v1'
  ),
  value_incomplete_reasons text[] not null default '{}',
  classifier_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id, stripe_subscription_id, start_event_id),
  check (effective_trial_end is null or effective_trial_end >= start_at)
);

create index if not exists stripe_trial_spells_scope_start_idx
  on stripe_trial_spells(workspace_id, source_id, start_at);
create index if not exists stripe_trial_spells_scope_end_idx
  on stripe_trial_spells(workspace_id, source_id, effective_trial_end);

create table if not exists stripe_trial_history_coverage (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  current_segment_from timestamptz,
  current_segment_to_exclusive timestamptz,
  current_segment_starting_after text,
  continuous_coverage_from timestamptz,
  closed_through_exclusive timestamptz,
  retention_gap_count integer not null default 0,
  last_gap_from timestamptz,
  last_gap_to timestamptz,
  last_gap_reason text,
  last_successful_sync_at timestamptz,
  incomplete_event_count integer not null default 0,
  incomplete_reasons text[] not null default '{}',
  parser_version text not null,
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id),
  check (
    (current_segment_from is null and current_segment_to_exclusive is null)
    or (
      current_segment_from is not null
      and current_segment_to_exclusive is not null
      and current_segment_from < current_segment_to_exclusive
    )
  ),
  check (
    continuous_coverage_from is null
    or closed_through_exclusive is null
    or continuous_coverage_from < closed_through_exclusive
  )
);

grant select, insert, update, delete on
  stripe_subscription_lifecycle_events,
  stripe_trial_history_segments,
  stripe_trial_spells,
  stripe_trial_history_coverage
to growth_os_worker;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update, delete on
      stripe_subscription_lifecycle_events,
      stripe_trial_history_segments,
      stripe_trial_spells,
      stripe_trial_history_coverage
    to engine_app;
  end if;
end
$$;

create or replace view queryable.vw_stripe_current_trials as
with connected_sources as (
  select workspace_id, id as source_id, last_synced_at
  from sources
  where provider = 'stripe' and status = 'connected'
),
source_modes as (
  select cs.workspace_id, cs.source_id,
    -- Invoice-derived placeholder rows (status 'unknown') legitimately carry no livemode — an
    -- invoice payload has none. Only a REAL subscription row missing livemode is a health problem;
    -- counting placeholders here would let one phantom subscription null current trials workspace-wide.
    count(s.id) > 0
      and coalesce(bool_or(s.livemode is null and s.status <> 'unknown'), false) as has_missing_mode,
    coalesce(bool_or(s.livemode is true), false)
      and coalesce(bool_or(s.livemode is false), false) as has_mixed_mode,
    -- A source that HAS subscriptions but none in live mode is a test-mode key: live counting
    -- would report a confident zero. A source with NO subscriptions stays an honest zero.
    count(s.id) > 0
      and not coalesce(bool_or(s.livemode is true), false)
      and coalesce(bool_or(s.livemode is false), false) as is_test_mode_only
  from connected_sources cs
  left join stripe_subscriptions s
    on s.workspace_id = cs.workspace_id and s.source_id = cs.source_id
  group by cs.workspace_id, cs.source_id
),
workspace_health as (
  select cs.workspace_id,
    count(*)::bigint as connected_source_count,
    count(*) filter (
      where cs.last_synced_at is not null and cs.last_synced_at >= now() - interval '28 days'
    )::bigint as covered_source_count,
    min(cs.last_synced_at) as data_as_of,
    bool_or(sm.has_missing_mode) as has_missing_mode,
    bool_or(sm.has_mixed_mode) as has_mixed_mode,
    bool_or(sm.is_test_mode_only) as has_test_mode_only_source,
    'stripe-current-trials-v1'::text as metric_version
  from connected_sources cs
  join source_modes sm
    on sm.workspace_id = cs.workspace_id and sm.source_id = cs.source_id
  group by cs.workspace_id
),
trial_values as (
  select v.workspace_id, v.source_id, v.stripe_subscription_id,
    v.currency, v.net_monthly_amount_cents, v.value_state, v.incomplete_reasons
  from queryable.vw_stripe_subscription_recurring_value v
  join stripe_subscriptions s
    on s.workspace_id = v.workspace_id
   and s.source_id = v.source_id
   and s.stripe_subscription_id = v.stripe_subscription_id
  join connected_sources cs
    on cs.workspace_id = v.workspace_id and cs.source_id = v.source_id
  where s.status = 'trialing'
    and s.livemode is true
    and v.business_eligible
)
select wh.workspace_id, tv.currency,
  case when wh.covered_source_count <> wh.connected_source_count
          or wh.has_missing_mode or wh.has_mixed_mode or wh.has_test_mode_only_source
       then null::bigint else count(tv.stripe_subscription_id)::bigint end as current_trial_count,
  case when wh.covered_source_count <> wh.connected_source_count
          or wh.has_missing_mode or wh.has_mixed_mode or wh.has_test_mode_only_source
       then null::bigint
       else count(tv.stripe_subscription_id) filter (
         where tv.value_state = 'complete' and tv.net_monthly_amount_cents is not null
       )::bigint end as valued_trial_count,
  case when wh.covered_source_count <> wh.connected_source_count
          or wh.has_missing_mode or wh.has_mixed_mode or wh.has_test_mode_only_source
       then null::numeric
       when count(tv.stripe_subscription_id) filter (where tv.value_state <> 'complete') > 0
       then null::numeric
       else coalesce(sum(tv.net_monthly_amount_cents) filter (where tv.value_state = 'complete'), 0)::numeric(38,12) end
    as potential_mrr_minor,
  case
    when wh.covered_source_count <> wh.connected_source_count
      or wh.has_missing_mode or wh.has_mixed_mode or wh.has_test_mode_only_source then 'unavailable'
    when count(tv.stripe_subscription_id) filter (where tv.value_state <> 'complete') > 0 then 'partial'
    else 'complete'
  end as value_status,
  case when wh.covered_source_count <> wh.connected_source_count
          or wh.has_missing_mode or wh.has_mixed_mode or wh.has_test_mode_only_source
       then null::bigint
       else count(tv.stripe_subscription_id) filter (where tv.value_state <> 'complete')::bigint end
    as incomplete_value_count,
  wh.data_as_of,
  wh.connected_source_count,
  wh.covered_source_count,
  array_remove(array[
    case when wh.covered_source_count <> wh.connected_source_count then 'current_snapshot_missing_or_stale' end,
    case when wh.has_missing_mode then 'missing_livemode_source' end,
    case when wh.has_mixed_mode then 'mixed_livemode_source' end,
    case when wh.has_test_mode_only_source then 'test_mode_source' end
  ], null)::text[] as incomplete_reasons,
  wh.metric_version
from workspace_health wh
left join trial_values tv on tv.workspace_id = wh.workspace_id
group by wh.workspace_id, tv.currency, wh.connected_source_count, wh.covered_source_count,
  wh.data_as_of, wh.has_missing_mode, wh.has_mixed_mode, wh.has_test_mode_only_source,
  wh.metric_version;

create or replace view queryable.vw_stripe_trial_coverage as
with connected_sources as (
  select workspace_id, id as source_id
  from sources where provider = 'stripe' and status = 'connected'
),
per_source as (
  select cs.workspace_id, cs.source_id,
    h.continuous_coverage_from,
    h.closed_through_exclusive as lifecycle_data_as_of,
    q.latest_successful_stripe_cutoff as invoice_data_as_of,
    q.completeness_sufficient,
    h.incomplete_event_count,
    h.incomplete_reasons,
    h.parser_version
  from connected_sources cs
  left join stripe_trial_history_coverage h
    on h.workspace_id = cs.workspace_id and h.source_id = cs.source_id
  left join queryable.vw_stripe_invoice_link_quality q
    on q.workspace_id = cs.workspace_id and q.source_id = cs.source_id
)
select workspace_id,
  count(*)::bigint as connected_source_count,
  count(*) filter (
    where lifecycle_data_as_of is not null
      and incomplete_event_count = 0
      and cardinality(incomplete_reasons) = 0
  )::bigint as lifecycle_covered_source_count,
  count(*) filter (
    where completeness_sufficient and invoice_data_as_of is not null
  )::bigint as invoice_covered_source_count,
  max(continuous_coverage_from) as continuous_coverage_from,
  min(lifecycle_data_as_of) as lifecycle_data_as_of,
  min(invoice_data_as_of) as invoice_data_as_of,
  least(min(lifecycle_data_as_of), min(invoice_data_as_of)) as conversion_data_as_of,
  case
    when count(*) filter (
      where lifecycle_data_as_of is not null
        and incomplete_event_count = 0
        and cardinality(incomplete_reasons) = 0
    ) <> count(*) then 'unavailable'
    when count(*) filter (
      where completeness_sufficient and invoice_data_as_of is not null
    ) <> count(*) then 'invoice_incomplete'
    when max(continuous_coverage_from) + interval '30 days'
      > least(min(lifecycle_data_as_of), min(invoice_data_as_of)) then 'aging'
    else 'complete'
  end as conversion_status,
  array_remove(array[
    case when count(*) filter (where lifecycle_data_as_of is not null) <> count(*)
      then 'lifecycle_coverage_incomplete' end,
    case when count(*) filter (
      where coalesce(incomplete_event_count, 0) > 0
        or cardinality(coalesce(incomplete_reasons, array[]::text[])) > 0
    ) > 0 then 'lifecycle_evidence_incomplete' end,
    case when count(*) filter (where completeness_sufficient and invoice_data_as_of is not null) <> count(*)
      then 'invoice_coverage_incomplete' end,
    case when max(continuous_coverage_from) + interval '30 days'
      > least(min(lifecycle_data_as_of), min(invoice_data_as_of))
      then 'continuous_coverage_not_aged_30d' end
  ], null)::text[] as incomplete_reasons,
  min(parser_version) as parser_version,
  'stripe-trial-spells-v1'::text as classifier_version,
  30::integer as attribution_days
from per_source
group by workspace_id;

create or replace view queryable.vw_stripe_trial_start_cohort_daily as
with eligible_spells as (
  select sp.*, h.closed_through_exclusive as lifecycle_data_as_of,
    q.completeness_sufficient as invoice_complete,
    -- Acquisition means a new paying CUSTOMER, so the exclusion is customer-scoped: an existing
    -- payer who trials a SECOND subscription is not a new trial acquisition. Subscription-scoping
    -- here would count every upsell/plan trial as new. A spell with no customer id cannot be
    -- evaluated and is left unexcluded.
    exists (
      select 1 from stripe_invoices pre
      where pre.workspace_id = sp.workspace_id
        and pre.source_id = sp.source_id
        and pre.stripe_customer_id = sp.stripe_customer_id
        and pre.status = 'paid' and pre.amount_paid > 0
        and pre.paid_at < sp.start_at
    ) as has_pretrial_payment
  from stripe_trial_spells sp
  join sources src
    on src.workspace_id = sp.workspace_id and src.id = sp.source_id
   and src.provider = 'stripe' and src.status = 'connected'
  join stripe_trial_history_coverage h
    on h.workspace_id = sp.workspace_id and h.source_id = sp.source_id
   and h.continuous_coverage_from is not null
   and h.closed_through_exclusive is not null
   and sp.start_at >= h.continuous_coverage_from
   and sp.start_at < h.closed_through_exclusive
  left join queryable.vw_stripe_invoice_link_quality q
    on q.workspace_id = sp.workspace_id and q.source_id = sp.source_id
  left join queryable.vw_stripe_customer_metric_eligibility e
    on e.workspace_id = sp.workspace_id and e.source_id = sp.source_id
   and e.stripe_customer_id = sp.stripe_customer_id
  where sp.business_eligible_at_capture
    and coalesce(e.is_business_eligible, true)
    and sp.livemode is true
),
bucketed as (
select workspace_id, (start_at at time zone 'UTC')::date as start_cohort_date,
  frozen_currency as currency,
  case when bool_and(invoice_complete) then
    count(*) filter (where not has_pretrial_payment)::bigint else null::bigint end as new_trial_count,
  case when bool_and(invoice_complete) then
    count(*) filter (where not has_pretrial_payment and frozen_net_monthly_amount_minor is not null)::bigint
    else null::bigint end as valued_trial_count,
  case when bool_and(invoice_complete)
          and count(*) filter (where not has_pretrial_payment and frozen_net_monthly_amount_minor is null) = 0
       then sum(frozen_net_monthly_amount_minor) filter (where not has_pretrial_payment)::numeric(38,12)
       else null::numeric end as potential_mrr_minor,
  count(*) filter (where has_pretrial_payment)::bigint as acquisition_excluded_count,
  count(*) filter (where not has_pretrial_payment and frozen_net_monthly_amount_minor is null)::bigint
    as incomplete_value_count,
  case when bool_and(invoice_complete) then 'complete' else 'invoice_incomplete' end as cohort_status,
  min(lifecycle_data_as_of) as data_as_of,
  30::integer as attribution_days,
  'stripe-trial-spells-v1'::text as classifier_version
from eligible_spells
group by workspace_id, (start_at at time zone 'UTC')::date, frozen_currency
)
select bucketed.*,
  sum(incomplete_value_count) over (partition by workspace_id, start_cohort_date)::bigint
    as daily_incomplete_value_count,
  case
    when bool_and(cohort_status = 'complete') over (partition by workspace_id, start_cohort_date)
      and sum(incomplete_value_count) over (partition by workspace_id, start_cohort_date) = 0
      then 'complete'
    when bool_and(cohort_status = 'complete') over (partition by workspace_id, start_cohort_date)
      then 'value_incomplete'
    else 'invoice_incomplete'
  end as daily_status
from bucketed;

create or replace view queryable.vw_stripe_trial_conversion_daily as
with eligible_ends as (
  select sp.*, least(h.closed_through_exclusive, q.latest_successful_stripe_cutoff) as data_as_of,
    q.completeness_sufficient as invoice_complete,
    -- Same customer-scoped acquisition exclusion as vw_stripe_trial_start_cohort_daily; the two
    -- views MUST agree or a conversion can outlive its own start cohort.
    exists (
      select 1 from stripe_invoices pre
      where pre.workspace_id = sp.workspace_id
        and pre.source_id = sp.source_id
        and pre.stripe_customer_id = sp.stripe_customer_id
        and pre.status = 'paid' and pre.amount_paid > 0 and pre.paid_at < sp.start_at
    ) as has_pretrial_payment
  from stripe_trial_spells sp
  join sources src
    on src.workspace_id = sp.workspace_id and src.id = sp.source_id
   and src.provider = 'stripe' and src.status = 'connected'
  join stripe_trial_history_coverage h
    on h.workspace_id = sp.workspace_id and h.source_id = sp.source_id
   and h.continuous_coverage_from is not null and h.closed_through_exclusive is not null
   and sp.start_at >= h.continuous_coverage_from and sp.start_at < h.closed_through_exclusive
  left join queryable.vw_stripe_invoice_link_quality q
    on q.workspace_id = sp.workspace_id and q.source_id = sp.source_id
  left join queryable.vw_stripe_customer_metric_eligibility e
    on e.workspace_id = sp.workspace_id and e.source_id = sp.source_id
   and e.stripe_customer_id = sp.stripe_customer_id
  where sp.business_eligible_at_capture and coalesce(e.is_business_eligible, true)
    and sp.livemode is true and sp.effective_trial_end is not null
),
attributed as (
  -- Conversion linkage stays SAME-SUBSCRIPTION by design: only a paid invoice on the very
  -- subscription that trialed proves that trial converted. A customer who trials, lapses, and
  -- later resubscribes on a FRESH subscription is deliberately not counted as a conversion.
  select sp.*,
    exists (
      select 1 from stripe_invoices inv
      where inv.workspace_id = sp.workspace_id and inv.source_id = sp.source_id
        and inv.stripe_subscription_id = sp.stripe_subscription_id
        and inv.status = 'paid' and inv.amount_paid > 0
        and inv.paid_at >= sp.effective_trial_end
        and inv.paid_at < sp.effective_trial_end + interval '30 days'
        and inv.paid_at < sp.data_as_of
    ) as converted_30d,
    exists (
      select 1 from stripe_invoices inv
      where inv.workspace_id = sp.workspace_id and inv.source_id = sp.source_id
        and inv.stripe_subscription_id = sp.stripe_subscription_id
        and inv.status = 'paid' and inv.amount_paid > 0
        and inv.paid_at >= sp.effective_trial_end + interval '30 days'
        and inv.paid_at < sp.data_as_of
    ) as late_payment
  from eligible_ends sp
),
with_coverage as (
  select a.*, cov.conversion_status as workspace_conversion_status
  from attributed a
  join queryable.vw_stripe_trial_coverage cov on cov.workspace_id = a.workspace_id
)
select workspace_id, (effective_trial_end at time zone 'UTC')::date as end_cohort_date,
  frozen_currency as currency,
  count(*) filter (where not has_pretrial_payment)::bigint as completed_trial_count,
  count(*) filter (
    where not has_pretrial_payment and effective_trial_end + interval '30 days' <= data_as_of
  )::bigint
    as mature_completed_trial_count,
  case
    when count(*) filter (
      where not has_pretrial_payment and effective_trial_end + interval '30 days' <= data_as_of
    ) = 0 then 0::bigint
    when min(workspace_conversion_status) = 'complete' and bool_and(invoice_complete) then
      count(*) filter (
        where not has_pretrial_payment
          and effective_trial_end + interval '30 days' <= data_as_of and converted_30d
      )::bigint
    else null::bigint
  end as converted_30d_count,
  count(*) filter (where not has_pretrial_payment and late_payment)::bigint as late_payment_count,
  count(*) filter (where has_pretrial_payment)::bigint as acquisition_excluded_count,
  case
    when count(*) filter (
      where not has_pretrial_payment and effective_trial_end + interval '30 days' <= data_as_of
    ) = 0
      then 'no_mature_completed_trials'
    when min(workspace_conversion_status) = 'complete' and bool_and(invoice_complete) then 'complete'
    else min(workspace_conversion_status)
  end as conversion_status,
  min(data_as_of) as data_as_of,
  30::integer as attribution_days,
  'stripe-trial-spells-v1'::text as classifier_version
from with_coverage
group by workspace_id, (effective_trial_end at time zone 'UTC')::date, frozen_currency;

-- Caveat contract for the trial views. These views are not (yet) rows in `queryable_views`, so the
-- caveat strings live on the objects themselves and can be read back with obj_description().
comment on view queryable.vw_stripe_current_trials is
  'aggregate_only;livemode_trials_only;test_mode_only_source_is_unavailable_not_zero;source_with_no_subscriptions_is_an_honest_zero;value_from_recurring_value_contract;incomplete_is_explicit';
comment on view queryable.vw_stripe_trial_start_cohort_daily is
  'acquisition_exclusion_is_customer_scoped;existing_paying_customer_starting_a_second_subscription_trial_is_not_a_new_acquisition;spell_without_customer_id_cannot_be_excluded;livemode_spells_only;frozen_value_at_trial_start;incomplete_is_explicit';
comment on view queryable.vw_stripe_trial_conversion_daily is
  'acquisition_exclusion_is_customer_scoped_identically_to_the_start_cohort;conversion_linkage_is_same_subscription_only;trial_then_lapse_then_new_subscription_is_not_a_conversion;attribution_window_is_end_to_end_plus_30_days;mature_rows_only;incomplete_is_explicit';

grant select on
  queryable.vw_stripe_current_trials,
  queryable.vw_stripe_trial_coverage,
  queryable.vw_stripe_trial_start_cohort_daily,
  queryable.vw_stripe_trial_conversion_daily
to growth_os_tool_agent, growth_os_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on
      queryable.vw_stripe_current_trials,
      queryable.vw_stripe_trial_coverage,
      queryable.vw_stripe_trial_start_cohort_daily,
      queryable.vw_stripe_trial_conversion_daily
    to engine_app;
  end if;
end
$$;
