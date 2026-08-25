-- Stripe FULL RECONCILIATION drift ledger + health surface.
--
-- The delta lane (0058) is the steady-state sync, but Stripe documents `/v1/events` as a 30-day
-- RECOVERY mechanism rather than a formally complete change feed, and every list endpoint filters
-- on `created` — never `updated` — so an edit to an old object is invisible to any incremental
-- read. A periodic full-set comparison therefore has to survive forever.
--
-- DRIFT IS EVIDENCE, NOT NOISE. Every difference between the remote full set and local canonical
-- state is recorded here BEFORE/WITH its repair. A reconciler that silently healed differences
-- would hide a delta-lane bug (or a Stripe event gap) forever; these counters are the gate for
-- relaxing daily reconciliation to weekly, so they must be complete and append-only.
--
-- The reconciler repairs CANONICAL state only. It never writes a ledger fact — the MRR movement
-- and trial classifiers observe the corrected canonical state at the NEXT close and mint their own
-- immutable facts from it.

create table if not exists stripe_reconciliation_drift (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  -- The instant the remote read STARTED; `stripe_sync_watermarks.reconciled_at` advances to the
  -- same value, so a drift row can always be tied back to the comparison that produced it.
  run_started_at timestamptz not null,
  entity_kind text not null check (entity_kind in (
    'customer', 'subscription', 'subscription_item', 'invoice', 'price', 'coupon', 'discount'
  )),
  object_external_id text not null,
  drift_kind text not null check (drift_kind in (
    'missing_local', 'missing_remote', 'state_mismatch'
  )),
  detected_at timestamptz not null default now(),
  -- FALSE is a real, expected outcome — not a failure, and it now covers TWO distinct cases that
  -- `detail.repair` tells apart:
  --   `none`             — unrepairable by contract. Full replacement has never deleted a PARENT
  --                        row (only the per-subscription item/discount child sets), so a
  --                        `missing_remote` customer / subscription / invoice / price is recorded
  --                        and left alone: deleting it would be brand-new behavior whose blast
  --                        radius lands on immutable ledgers (a vanished subscription instantly
  --                        reads as churn at the next close).
  --   `full_replacement` — the difference was REAL at the start of the run and this same sync's
  --                        LOAD had already healed it before CLOSE opened. It is measured against a
  --                        PRE-LOAD projection precisely so it is visible at all; measured after
  --                        the load it would be silently absent and the relax-to-weekly gate would
  --                        read "clean" off a run that found real delta-lane misses.
  -- `direct` is the repaired = true case: the difference survived the load and was fixed here.
  repaired boolean not null,
  -- SMALL by contract: differing field names, the `repair` marker above, or a machine-readable
  -- reason. Never a payload — this table is telemetry, and `stripe_event_evidence` / `raw_records`
  -- already hold provenance.
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Deliberately NO unique key on (scope, object, kind): the same object drifting on two different
-- days must produce two rows. Collapsing repeats would erase exactly the recurrence signal the
-- cadence decision needs.
create index if not exists stripe_reconciliation_drift_scope_time_idx
  on stripe_reconciliation_drift(workspace_id, source_id, detected_at desc);
create index if not exists stripe_reconciliation_drift_scope_kind_idx
  on stripe_reconciliation_drift(workspace_id, source_id, entity_kind, drift_kind, detected_at desc);
create index if not exists stripe_reconciliation_drift_run_idx
  on stripe_reconciliation_drift(workspace_id, source_id, run_started_at);

-- APPEND-ONLY BY GRANT: the worker gets insert but no update/delete. An immutable evidence table
-- whose writer can rewrite it is not evidence.
grant select, insert on stripe_reconciliation_drift to growth_os_worker;
grant select on stripe_reconciliation_drift to growth_os_app, growth_os_tool_agent;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert on stripe_reconciliation_drift to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on stripe_reconciliation_drift to growth_os_read_api;
  end if;
end
$$;

-- The drift-telemetry surface the relax-daily-to-weekly decision reads. Aggregate-only, and
-- explicit about incompleteness: a workspace with a connected Stripe source that has never been
-- reconciled reports `never_reconciled`, never a confident "clean".
create or replace view queryable.vw_stripe_reconciliation_health as
with connected_sources as (
  select workspace_id, id as source_id
  from sources
  where provider = 'stripe' and status = 'connected'
),
per_source as (
  select cs.workspace_id, cs.source_id, w.reconciled_at, w.last_drift_at
  from connected_sources cs
  left join stripe_sync_watermarks w
    on w.workspace_id = cs.workspace_id and w.source_id = cs.source_id
),
source_health as (
  select workspace_id,
    count(*)::bigint as connected_source_count,
    count(*) filter (where reconciled_at is not null)::bigint as reconciled_source_count,
    count(*) filter (where reconciled_at is null)::bigint as never_reconciled_source_count,
    -- MIN, not MAX: the workspace is only reconciled as far back as its LAGGIEST source.
    min(reconciled_at) as reconciled_at,
    max(last_drift_at) as last_drift_at
  from per_source
  group by workspace_id
),
scoped_drift as (
  -- Drift from a source that has since been disconnected is deliberately excluded: the health
  -- surface answers "can I trust the numbers I am serving now", and a disconnected source serves
  -- none. The rows stay in the table for forensics.
  select d.workspace_id, d.drift_kind, d.detected_at, d.repaired
  from stripe_reconciliation_drift d
  join connected_sources cs
    on cs.workspace_id = d.workspace_id and cs.source_id = d.source_id
),
drift_counts as (
  select workspace_id,
    count(*) filter (where detected_at >= now() - interval '7 days')::bigint as drift_7d,
    count(*) filter (where detected_at >= now() - interval '30 days')::bigint as drift_30d,
    count(*) filter (
      where detected_at >= now() - interval '7 days' and drift_kind = 'missing_local'
    )::bigint as missing_local_7d,
    count(*) filter (
      where detected_at >= now() - interval '7 days' and drift_kind = 'missing_remote'
    )::bigint as missing_remote_7d,
    count(*) filter (
      where detected_at >= now() - interval '7 days' and drift_kind = 'state_mismatch'
    )::bigint as state_mismatch_7d,
    count(*) filter (
      where detected_at >= now() - interval '30 days' and drift_kind = 'missing_local'
    )::bigint as missing_local_30d,
    count(*) filter (
      where detected_at >= now() - interval '30 days' and drift_kind = 'missing_remote'
    )::bigint as missing_remote_30d,
    count(*) filter (
      where detected_at >= now() - interval '30 days' and drift_kind = 'state_mismatch'
    )::bigint as state_mismatch_30d,
    count(*) filter (
      where detected_at >= now() - interval '7 days' and not repaired
    )::bigint as unrepaired_7d,
    count(*) filter (
      where detected_at >= now() - interval '30 days' and not repaired
    )::bigint as unrepaired_30d
  from scoped_drift
  group by workspace_id
)
select sh.workspace_id,
  sh.connected_source_count,
  sh.reconciled_source_count,
  sh.never_reconciled_source_count,
  sh.reconciled_at,
  sh.last_drift_at,
  coalesce(dc.drift_7d, 0)::bigint as drift_7d,
  coalesce(dc.drift_30d, 0)::bigint as drift_30d,
  coalesce(dc.missing_local_7d, 0)::bigint as missing_local_7d,
  coalesce(dc.missing_remote_7d, 0)::bigint as missing_remote_7d,
  coalesce(dc.state_mismatch_7d, 0)::bigint as state_mismatch_7d,
  coalesce(dc.missing_local_30d, 0)::bigint as missing_local_30d,
  coalesce(dc.missing_remote_30d, 0)::bigint as missing_remote_30d,
  coalesce(dc.state_mismatch_30d, 0)::bigint as state_mismatch_30d,
  coalesce(dc.unrepaired_7d, 0)::bigint as unrepaired_7d,
  coalesce(dc.unrepaired_30d, 0)::bigint as unrepaired_30d,
  case
    when sh.never_reconciled_source_count > 0 then 'never_reconciled'
    when coalesce(dc.drift_7d, 0) > 0 then 'drifting'
    -- Daily cadence with a doubled grace window: one missed run is a schedule hiccup, two is a
    -- broken lane. Tighten this ONLY together with the cadence itself.
    when sh.reconciled_at < now() - interval '48 hours' then 'stale'
    else 'clean'
  end as reconciliation_status,
  'stripe-reconcile-v1'::text as metric_version
from source_health sh
left join drift_counts dc on dc.workspace_id = sh.workspace_id;

comment on view queryable.vw_stripe_reconciliation_health is
  'aggregate_only;reconciled_at_is_the_laggiest_connected_source;never_reconciled_is_not_clean;drift_from_disconnected_sources_excluded;unrepaired_rows_are_expected_parent_deletions_or_load_healed_drift_not_failures;see_detail_repair_marker;zero_drift_over_60_to_90_days_is_the_relax_to_weekly_gate';

grant select on queryable.vw_stripe_reconciliation_health
  to growth_os_tool_agent, growth_os_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on queryable.vw_stripe_reconciliation_health to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on queryable.vw_stripe_reconciliation_health to growth_os_read_api;
  end if;
end
$$;
