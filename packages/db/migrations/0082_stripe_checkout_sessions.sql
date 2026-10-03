-- Canonical Stripe CHECKOUT SESSIONS, plus the durable state of the lane that lists them.
--
-- WHY. A one-off sale made through Stripe Checkout or a Payment Link creates NO invoice unless the
-- merchant turned on `invoice_creation`, so the invoice tables never see it. Until now the only trace
-- was the minimised `checkout.session.completed` EVIDENCE the delta lane keeps (0058, parser
-- stripe-delta-events-v2) — and Stripe's `/v1/events` only reaches back ~30 days, so every older
-- sale was simply invisible. This table holds the FULL history, listed from `/v1/checkout/sessions`
-- and kept current between full refreshes from the session events the delta lane already polls.
--
-- MINIMISED. A session object carries the buyer's name, email, phone, billing and shipping address,
-- custom fields and merchant free text. None of it is stored: only what a revenue read needs, and
-- every reference reduced to its id.
--
-- ALL MODES ARE STORED. `/v1/checkout/sessions` cannot filter on `mode`, so the list returns
-- payment, subscription and setup sessions alike. They are kept rather than dropped (a
-- subscription-mode session is cheap and names the subscription it started); a revenue read selects
-- `mode = 'payment' and stripe_invoice_id is null` — a payment session WITH an invoice is already
-- counted through `stripe_invoices`.
--
-- Idempotent (the cloud engine's one-call execute_sql recipe can run a file twice).

create table if not exists stripe_checkout_sessions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_checkout_session_id text not null,
  mode text not null,
  status text not null,
  -- `paid` | `unpaid` | `no_payment_required`. A session paid by a DELAYED method (bank debits)
  -- completes `unpaid` and turns `paid` later; that transition arrives as
  -- `checkout.session.async_payment_succeeded`.
  payment_status text not null,
  -- Minor units, as Stripe reports them. NULL when Stripe did not report one — never 0.
  amount_total bigint,
  amount_subtotal bigint,
  currency text,
  stripe_customer_id text,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  -- The session's own `created` (when checkout started). A session is open for at most 24 hours,
  -- so this is within a day of the sale.
  session_created_at timestamptz not null,
  livemode boolean not null,
  -- The provider instant this row describes: the list time for a listed row, the event's `created`
  -- for an event-sourced one. Writers only overwrite with an observation at least as new, so a
  -- late-processed older event can never roll `payment_status` back.
  observed_at timestamptz not null,
  observed_via text not null check (observed_via in ('list', 'event')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, stripe_checkout_session_id)
);

create index if not exists stripe_checkout_sessions_scope_created_idx
  on stripe_checkout_sessions(workspace_id, source_id, session_created_at);

create table if not exists stripe_checkout_session_sync_state (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  -- THE TYPED CAPABILITY GAP. A restricted key may lack `Checkout Sessions: Read` while every other
  -- Stripe permission is granted. That must not fail the whole Stripe sync (subscriptions, invoices
  -- and MRR are unaffected), and it must not be silently skipped either: the lane records
  -- `missing_permission` with the Dashboard permission name, and readers report checkout history as
  -- UNAVAILABLE rather than as $0. `unknown` = the list endpoint has not been called yet.
  capability_state text not null default 'unknown'
    check (capability_state in ('unknown', 'available', 'missing_permission')),
  missing_permission text,
  capability_checked_at timestamptz,
  -- The HISTORY crawl: `/v1/checkout/sessions?status=complete&created[lt]=<anchor>` walked
  -- newest-to-oldest a bounded number of pages per run, resumable from `backfill_starting_after`.
  backfill_state text not null default 'pending'
    check (backfill_state in ('pending', 'in_progress', 'complete')),
  backfill_anchor timestamptz,
  backfill_starting_after text,
  -- `created` of the OLDEST session the crawl has listed so far. Every complete session created
  -- strictly after this second (and before the anchor) has been listed.
  backfill_reached_created_at timestamptz,
  backfill_completed_at timestamptz,
  -- An OPEN incremental list window [window_from, window_to), resumable from its cursor.
  window_from timestamptz,
  window_to timestamptz,
  window_starting_after text,
  -- COVERAGE CLAIM: every Checkout session that COMPLETED before this instant is stored. Set to the
  -- anchor when the crawl finishes, then advanced by an incremental list window that reaches back
  -- past it by more than a session's 24-hour lifetime, or by a closed delta window containing it.
  -- It does not claim a later `payment_status` change (an async payment that settles while the
  -- event chain is broken).
  listed_through timestamptz,
  last_successful_sync_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id),
  check ((capability_state = 'missing_permission') = (missing_permission is not null))
);

-- What a revenue read may claim about checkout sales, per source. `history_state` is closed:
--   missing_permission — the key cannot list Checkout sessions; history is UNAVAILABLE.
--   not_started        — nothing has been listed yet.
--   backfilling        — [covered_from, covered_through) is measured; anything older is not yet.
--   complete           — every completed session before `covered_through` is stored;
--                        `covers_all_history` is true and `covered_from` is null (no lower bound).
create or replace view queryable.vw_stripe_checkout_session_coverage as
select
  state.workspace_id,
  state.source_id,
  case
    when state.capability_state = 'missing_permission' then 'missing_permission'
    when state.backfill_state = 'complete' then 'complete'
    when state.backfill_reached_created_at is not null then 'backfilling'
    else 'not_started'
  end as history_state,
  state.capability_state,
  state.missing_permission,
  state.capability_checked_at,
  (state.capability_state <> 'missing_permission' and state.backfill_state = 'complete')
    as covers_all_history,
  case
    when state.capability_state = 'missing_permission' then null
    when state.backfill_state = 'complete' then null
    -- Exclusive of the oldest listed second: more sessions created in that same second may sit on
    -- the next, not-yet-read page.
    when state.backfill_reached_created_at is not null
      then state.backfill_reached_created_at + interval '1 second'
    else null
  end as covered_from,
  case
    when state.capability_state = 'missing_permission' then null
    when state.backfill_state = 'complete' then state.listed_through
    when state.backfill_reached_created_at is not null then state.backfill_anchor
    else null
  end as covered_through,
  state.backfill_completed_at,
  state.last_successful_sync_at
from stripe_checkout_session_sync_state state;

-- Caveat contract (not a `queryable_views` row, like the 0057 trial views): readable back with
-- obj_description().
comment on view queryable.vw_stripe_checkout_session_coverage is
  'missing_permission_is_unavailable_not_zero;source_without_a_row_has_never_listed_checkout_sessions;covered_range_is_half_open;coverage_is_by_completion_time;later_async_payment_settlement_rides_the_event_chain;revenue_reads_select_mode_payment_without_invoice';

grant select, insert, update on stripe_checkout_sessions to growth_os_worker;
grant select, insert, update on stripe_checkout_session_sync_state to growth_os_worker;
grant select on stripe_checkout_sessions, stripe_checkout_session_sync_state
  to growth_os_app, growth_os_tool_agent;
grant select on queryable.vw_stripe_checkout_session_coverage to growth_os_tool_agent, growth_os_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update on
      stripe_checkout_sessions,
      stripe_checkout_session_sync_state
    to engine_app;
    grant select on queryable.vw_stripe_checkout_session_coverage to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on
      stripe_checkout_sessions,
      stripe_checkout_session_sync_state,
      queryable.vw_stripe_checkout_session_coverage
    to growth_os_read_api;
  end if;
end
$$;
