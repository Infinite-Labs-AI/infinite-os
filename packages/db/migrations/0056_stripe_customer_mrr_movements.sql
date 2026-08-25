-- Immutable, source-safe customer/currency Stripe MRR movement truth.
-- Classification is performed only at successful connector CLOSE after complete
-- subscription replacement. Historical linked-invoice bootstrap remains explicitly
-- distinct from forward-observed roll-forward coverage.

create table if not exists stripe_customer_mrr_states (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  stripe_customer_id text not null,
  currency text not null,
  monthly_amount_minor numeric(38, 12) not null check (monthly_amount_minor >= 0),
  has_ever_positive boolean not null default false,
  evidence_hash text not null,
  last_movement_id text,
  last_complete_observed_at timestamptz not null,
  classifier_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id, stripe_customer_id, currency)
);

create index if not exists stripe_customer_mrr_states_source_idx
  on stripe_customer_mrr_states(workspace_id, source_id);

create table if not exists stripe_customer_mrr_movements (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  stripe_customer_id text not null,
  currency text not null,
  movement_kind text not null
    check (movement_kind in ('new', 'reactivation', 'expansion', 'contraction', 'churn')),
  from_amount_minor numeric(38, 12) not null check (from_amount_minor >= 0),
  to_amount_minor numeric(38, 12) not null check (to_amount_minor >= 0),
  delta_amount_minor numeric(38, 12) not null,
  effective_at timestamptz not null,
  observed_at timestamptz not null,
  previous_evidence_hash text not null,
  current_evidence_hash text not null,
  provenance text not null
    check (provenance in ('forward_observed_v1', 'linked_paid_invoice_current_complete_v1')),
  business_eligible_at_event boolean not null,
  classifier_version text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (idempotency_key),
  check (delta_amount_minor = to_amount_minor - from_amount_minor)
);

create index if not exists stripe_customer_mrr_movements_window_idx
  on stripe_customer_mrr_movements(workspace_id, source_id, effective_at, currency, movement_kind);
create index if not exists stripe_customer_mrr_movements_customer_idx
  on stripe_customer_mrr_movements(workspace_id, source_id, stripe_customer_id, effective_at);

create table if not exists stripe_mrr_movement_coverage (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  forward_coverage_started_at timestamptz,
  bootstrap_evidence_from timestamptz,
  bootstrap_evidence_to timestamptz,
  last_attempted_data_as_of timestamptz not null,
  last_complete_data_as_of timestamptz,
  incomplete_business_customer_count integer not null default 0
    check (incomplete_business_customer_count >= 0),
  -- DIAGNOSTIC ONLY, and deliberately NOT a completeness gate. Counts customers whose recurring
  -- value has reached zero with no proven, non-future service end yet (Stripe's ordinary `unpaid`
  -- and `paused` states hold there for weeks). Churn here is DEFINED as a proven service end, so
  -- those customers have no movement fact YET and the ledger stays COMPLETE with respect to proven
  -- facts. Gating coverage on this would blank the whole workspace's movement panel over one
  -- mundane unpaid customer. The fact lands at the later close that can prove the end.
  pending_service_end_customer_count integer not null default 0
    check (pending_service_end_customer_count >= 0),
  incomplete_reasons text[] not null default array[]::text[],
  bootstrap_provenance text[] not null default array[]::text[],
  classifier_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id)
);

create index if not exists stripe_mrr_movement_coverage_workspace_idx
  on stripe_mrr_movement_coverage(workspace_id, source_id);

-- Business movement requires eligibility both when the immutable fact was created
-- and now. That makes business -> internal remove history without making a later
-- internal -> business reclassification resurrect events created as internal.
create or replace view queryable.vw_stripe_customer_mrr_movements as
select
  m.workspace_id,
  m.source_id,
  md5(jsonb_build_array(m.source_id, m.stripe_customer_id)::text) as scoped_customer_key,
  m.currency,
  m.movement_kind,
  m.from_amount_minor,
  m.to_amount_minor,
  m.delta_amount_minor,
  m.effective_at,
  m.observed_at,
  m.provenance,
  m.classifier_version
from stripe_customer_mrr_movements m
join sources s
  on s.workspace_id = m.workspace_id
 and s.id = m.source_id
 and s.provider = 'stripe'
 and s.status = 'connected'
left join queryable.vw_stripe_customer_metric_eligibility e
  on e.workspace_id = m.workspace_id
 and e.source_id = m.source_id
 and e.stripe_customer_id = m.stripe_customer_id
where m.business_eligible_at_event
  and coalesce(e.is_business_eligible, true);

create or replace view queryable.vw_stripe_mrr_movement_coverage as
select
  s.workspace_id,
  count(*)::bigint as connected_source_count,
  count(c.source_id)::bigint as covered_source_count,
  (count(*) - count(c.source_id))::bigint as missing_source_coverage_count,
  case
    when count(c.source_id) = count(*)
     and count(c.forward_coverage_started_at) = count(*)
     and bool_and(c.incomplete_business_customer_count = 0)
    then max(c.forward_coverage_started_at)
    else null
  end as forward_coverage_started_at,
  min(c.bootstrap_evidence_from) as bootstrap_evidence_from,
  max(c.bootstrap_evidence_to) as bootstrap_evidence_to,
  case
    when count(c.source_id) = count(*)
     and count(c.last_complete_data_as_of) = count(*)
     and bool_and(c.incomplete_business_customer_count = 0)
    then min(c.last_complete_data_as_of)
    else null
  end as data_as_of,
  coalesce(sum(c.incomplete_business_customer_count), 0)::bigint
    as incomplete_business_customer_count,
  -- Diagnostic sum only: intentionally absent from the data_as_of / forward_coverage_started_at
  -- gates above. A pending customer is an unfinished story, not missing data.
  coalesce(sum(c.pending_service_end_customer_count), 0)::bigint
    as pending_service_end_customer_count,
  array(
    select distinct reason
    from stripe_mrr_movement_coverage c2
    join sources s2 on s2.id = c2.source_id and s2.workspace_id = c2.workspace_id
    cross join lateral unnest(c2.incomplete_reasons) reason
    where c2.workspace_id = s.workspace_id
      and s2.provider = 'stripe' and s2.status = 'connected'
    order by reason
  ) as incomplete_reasons,
  array(
    select distinct provenance
    from stripe_mrr_movement_coverage c3
    join sources s3 on s3.id = c3.source_id and s3.workspace_id = c3.workspace_id
    cross join lateral unnest(c3.bootstrap_provenance) provenance
    where c3.workspace_id = s.workspace_id
      and s3.provider = 'stripe' and s3.status = 'connected'
    order by provenance
  ) as bootstrap_provenance,
  case
    when count(c.source_id) = count(*)
     and count(c.classifier_version) = count(*)
     and count(distinct c.classifier_version) = 1
    then min(c.classifier_version)
    else null
  end as classifier_version
from sources s
left join stripe_mrr_movement_coverage c
  on c.workspace_id = s.workspace_id
 and c.source_id = s.id
where s.provider = 'stripe'
  and s.status = 'connected'
group by s.workspace_id;

-- Preserve the Task 3 current-paid and trial snapshot authorities, replacing only
-- historical new/churn branches with immutable customer movement facts.
create or replace view queryable.vw_stripe_subscription_lifecycle as
with connected_workspaces as (
  select distinct workspace_id
  from sources
  where provider = 'stripe' and status = 'connected'
),
base as (
  select
    v.*,
    'stripe'::text as provider,
    coalesce(nullif(v.stripe_customer_id, ''), v.stripe_subscription_id) as subscriber_key
  from queryable.vw_stripe_subscription_recurring_value v
  join sources connected_source
    on connected_source.workspace_id = v.workspace_id
   and connected_source.id = v.source_id
   and connected_source.provider = 'stripe'
   and connected_source.status = 'connected'
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

-- FAILS CLOSED PER SOURCE, exactly like the current_paid branch above: a source with no coverage
-- row, no forward coverage start, or a genuinely incomplete business customer can only produce an
-- UNDERCOUNT, and a concrete undercount next to an honestly-NULL current count is the worst
-- possible reading. pending_service_end_customer_count is deliberately NOT part of this gate.
select m.workspace_id, m.source_id, 'stripe'::text, date(m.effective_at),
  'new_paid_subscribers'::text, null::text, null::text, 0::bigint,
  case
    when c.source_id is null
      or c.forward_coverage_started_at is null
      or c.incomplete_business_customer_count > 0
    then null::bigint
    else count(distinct m.scoped_customer_key)
  end,
  0::bigint, 0::bigint
from queryable.vw_stripe_customer_mrr_movements m
left join stripe_mrr_movement_coverage c
  on c.workspace_id = m.workspace_id
 and c.source_id = m.source_id
where m.movement_kind = 'new'
group by m.workspace_id, m.source_id, date(m.effective_at),
  c.source_id, c.forward_coverage_started_at, c.incomplete_business_customer_count

union all

select workspace_id, source_id, provider, date(coalesce(trial_start, created_at_source)),
  'trialing_subscribers'::text, status, null::text, 0::bigint, 0::bigint,
  count(distinct subscriber_key), 0::bigint
from base
where status = 'trialing' and coalesce(trial_start, created_at_source) is not null
group by workspace_id, source_id, provider, date(coalesce(trial_start, created_at_source)), status

union all

-- Same per-source completeness gate as the new_paid branch.
select m.workspace_id, m.source_id, 'stripe'::text, date(m.effective_at),
  'churned_subscribers'::text, null::text, null::text, 0::bigint, 0::bigint, 0::bigint,
  case
    when c.source_id is null
      or c.forward_coverage_started_at is null
      or c.incomplete_business_customer_count > 0
    then null::bigint
    else count(distinct m.scoped_customer_key)
  end
from queryable.vw_stripe_customer_mrr_movements m
left join stripe_mrr_movement_coverage c
  on c.workspace_id = m.workspace_id
 and c.source_id = m.source_id
where m.movement_kind = 'churn'
group by m.workspace_id, m.source_id, date(m.effective_at),
  c.source_id, c.forward_coverage_started_at, c.incomplete_business_customer_count;

update queryable_views
set source_tables = '["stripe_subscriptions","stripe_subscription_items","stripe_subscription_discounts","stripe_customers","stripe_customer_mrr_movements"]',
    row_grain = 'workspace/current snapshot; workspace/source/day/currency customer movement',
    caveats = 'current_paid_task3_authority;new_and_churn_from_immutable_customer_mrr_facts;event_and_current_business_eligibility;connected_sources_only;currency_separate;forward_coverage_separate_from_qualified_bootstrap;new_and_churn_null_when_source_coverage_incomplete;churn_lands_at_proven_service_end_and_may_revise_past_windows;pending_service_end_customers_are_deferred_not_incomplete'
where id = 'queryable.vw_stripe_subscription_lifecycle';

update metric_definitions
set description = 'Distinct business-eligible Stripe customers with a first forward-observed or narrowly qualified positive recurring-value transition.',
    caveats = 'customer_currency_grain;immutable_movement_facts;qualified_bootstrap_does_not_imply_complete_historical_roll_forward;connected_sources_only',
    version = version + 1
where id = 'stripe_new_paid_subscribers';

update metric_definitions
set description = 'Distinct business-eligible Stripe customers whose complete recurring value reaches zero at a proven effective service end.',
    caveats = 'customer_currency_grain;effective_service_end_not_cancellation_request;immutable_movement_facts;connected_sources_only;churn_lands_at_proven_service_end_and_may_revise_past_windows',
    version = version + 1
where id = 'stripe_churned_subscribers';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update on stripe_customer_mrr_states to engine_app;
    grant select, insert on stripe_customer_mrr_movements to engine_app;
    grant select, insert, update on stripe_mrr_movement_coverage to engine_app;
    grant select on queryable.vw_stripe_customer_mrr_movements,
      queryable.vw_stripe_mrr_movement_coverage to engine_app;
  end if;
end $$;

grant select, insert, update on stripe_customer_mrr_states to growth_os_worker;
grant select, insert on stripe_customer_mrr_movements to growth_os_worker;
grant select, insert, update on stripe_mrr_movement_coverage to growth_os_worker;
grant select on queryable.vw_stripe_customer_mrr_movements,
  queryable.vw_stripe_mrr_movement_coverage to growth_os_app;
