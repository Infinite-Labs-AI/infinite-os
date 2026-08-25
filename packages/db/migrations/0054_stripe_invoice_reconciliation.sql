-- Durable Stripe invoice-to-subscription linkage and bounded reconciliation state.
-- Existing invoice rows are explicitly unknown until a fresh Stripe invoice version
-- proves that they are subscription- or non-subscription-originated.

alter table stripe_invoices
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_origin text not null default 'unknown';

alter table stripe_invoices
  drop constraint if exists stripe_invoices_subscription_origin_check;

alter table stripe_invoices
  add constraint stripe_invoices_subscription_origin_check
  check (subscription_origin in ('subscription', 'non_subscription', 'unknown'));

create index if not exists stripe_invoices_workspace_source_subscription_idx
  on stripe_invoices(workspace_id, source_id, stripe_subscription_id);

create table if not exists stripe_invoice_sync_state (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  backfill_state text not null default 'pending'
    check (backfill_state in ('pending', 'in_progress', 'complete')),
  backfill_starting_after text,
  backfill_completed_at timestamptz,
  event_window_from timestamptz,
  event_window_to timestamptz,
  event_starting_after text,
  latest_successful_stripe_cutoff timestamptz,
  last_successful_sync_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id)
);

create index if not exists stripe_invoice_sync_state_workspace_source_idx
  on stripe_invoice_sync_state(workspace_id, source_id);

create or replace view queryable.vw_stripe_invoice_link_quality as
with quality as (
  select
    state.workspace_id,
    state.source_id,
    state.backfill_state,
    state.latest_successful_stripe_cutoff,
    state.last_successful_sync_at,
    count(i.id) filter (
      where i.status = 'paid'
        and i.subscription_origin = 'subscription'
        and i.stripe_subscription_id is not null
    ) as linked_paid_invoices,
    count(i.id) filter (
      where i.status = 'paid'
        and i.subscription_origin = 'subscription'
        and i.stripe_subscription_id is null
    ) as unlinked_subscription_paid_invoices,
    count(i.id) filter (
      where i.status = 'paid'
        and i.subscription_origin = 'unknown'
    ) as unknown_origin_paid_invoices,
    count(i.id) filter (
      where i.status = 'paid'
        and i.subscription_origin = 'non_subscription'
    ) as non_subscription_paid_invoices,
    -- A paid invoice with no paid_at silently vanishes from every dated revenue query
    -- (date(null) is null, so it matches no occurred_on range) while still sitting in the
    -- table. The row is kept as-is; this counter is how it stops being invisible. It is
    -- deliberately NOT part of completeness_sufficient below: a paid_at-less invoice is a
    -- provider oddity to be looked at, not a reason to permanently withhold trial metrics.
    count(i.id) filter (
      where i.status = 'paid'
        and i.paid_at is null
    ) as paid_missing_paid_at_invoices
  from stripe_invoice_sync_state state
  left join stripe_invoices i
    on i.workspace_id = state.workspace_id
   and i.source_id = state.source_id
  group by
    state.workspace_id,
    state.source_id,
    state.backfill_state,
    state.latest_successful_stripe_cutoff,
    state.last_successful_sync_at
)
select
  workspace_id,
  source_id,
  linked_paid_invoices,
  unlinked_subscription_paid_invoices,
  unknown_origin_paid_invoices,
  non_subscription_paid_invoices,
  paid_missing_paid_at_invoices,
  case
    when linked_paid_invoices + unlinked_subscription_paid_invoices = 0 then null
    else linked_paid_invoices::numeric
      / (linked_paid_invoices + unlinked_subscription_paid_invoices)::numeric
  end as link_coverage,
  latest_successful_stripe_cutoff,
  backfill_state,
  last_successful_sync_at,
  (
    latest_successful_stripe_cutoff is not null
    and latest_successful_stripe_cutoff >= now() - interval '28 days'
  ) as cutoff_is_fresh,
  (
    backfill_state = 'complete'
    and latest_successful_stripe_cutoff is not null
    and latest_successful_stripe_cutoff >= now() - interval '28 days'
    and unlinked_subscription_paid_invoices = 0
    and unknown_origin_paid_invoices = 0
  ) as completeness_sufficient
from quality;

grant select, insert, update on stripe_invoice_sync_state to growth_os_worker;
grant select on queryable.vw_stripe_invoice_link_quality to growth_os_tool_agent, growth_os_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on queryable.vw_stripe_invoice_link_quality to growth_os_read_api;
  end if;
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update on stripe_invoice_sync_state to engine_app;
    grant select on queryable.vw_stripe_invoice_link_quality to engine_app;
  end if;
end
$$;
