-- 0064_posthog_raw_retention.sql
-- Raw-retention for the PostHog lane: RAW (posthog_event_truth) is kept ~retention_days (seeded 180),
-- ROLLUPS (posthog_event_daily / posthog_site_daily, migration 0063) are kept FOREVER — the same
-- shape the first-party ledger uses (analytics-ledger-retention + 90d raw). At October's volume
-- (~90k events/day, ~2-3M truth rows/month) unbounded raw is ~1GB and growing; the charts read ONLY
-- the rollups, so raw older than the retention floor buys nothing but storage.
--
-- ── THE TRAP THIS MIGRATION IS DESIGNED AROUND ──────────────────────────────────────────────────
-- refresh_posthog_daily_rollups (0063) is delete+insert per (workspace, source, window). After raw
-- pruning, ANY refresh whose window reaches into pruned days would DELETE those days' rollup rows
-- and re-insert NOTHING — destroying permanent history. This is not hypothetical: the connector
-- CLOSE hook refreshes from `2000-01-01` whenever a source has no stored cursor (first sync,
-- re-connect, re-backfill — exactly the "heal an errored source" path), and the 0063 backfill
-- DO-block used the same shape.
--
-- The fix clamps the refresh window to the per-source PRUNE WATERMARK (posthog_prune_watermarks —
-- the exact record of what prune_posthog_raw() actually deleted), NOT to the config-derived
-- retention floor. Keying the clamp off the watermark matters twice:
--   (a) a never-pruned source has no watermark and keeps FULL-history refresh semantics — a fresh
--       365-day backfill still rolls up all 365 days before the first prune trims raw;
--   (b) RAISING retention_days later moves the floor back, but the watermark stays where raw was
--       actually deleted — so the wider refresh window can never delete-and-rebuild-empty the days
--       pruned under the old setting. A config-floor clamp would re-arm the trap on any increase.
-- A window clamped to empty RETURNS — a no-op, never a delete.
--
-- prune_posthog_raw() itself clamps p_before to the config floor (least(p_before, floor)): raw the
-- policy still guarantees is NEVER deletable through this function, whatever a drifted caller
-- passes, so the watermark can never overtake the floor and the retained window always has full raw.
--
-- Prune and refresh serialize per (workspace, source) on one advisory transaction lock. Without it,
-- a prune committing between a refresh's watermark read and its raw scan could persist a PARTIAL
-- rollup for a day that then sits below the watermark forever (never refreshed again = permanently
-- wrong history). The sync scheduler serializes refreshes per source, but the retention cron is a
-- separate lane — the lock is what makes them mutually exclusive.
--
-- ── CONSERVATION INVARIANT — REDEFINED. READ THIS BEFORE TRUSTING ANY OLD RUNBOOK ───────────────
-- Since 0063 ops runbooks assert the GLOBAL equality sum(posthog_event_daily.event_count) =
-- count(posthog_event_truth) per (workspace, source). After the FIRST prune that equality is GONE
-- BY DESIGN. The invariant is now: sum(event_count) = count(truth) holds ONLY over days on or after
-- the source's prune watermark (posthog_prune_watermarks.pruned_before; no row = all days). Below
-- the watermark, rollup rows are permanent history with NO raw backing — a global-equality check
-- reporting a mismatch there is measuring the design, not a bug.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- BEFORE any prune has run: everything here is inert and droppable (functions + tables + grants).
-- AFTER any prune has run: do NOT revert refresh_posthog_daily_rollups to its 0063 body and do NOT
-- drop posthog_prune_watermarks — either one re-arms the delete-and-reinsert-nothing trap for every
-- pruned day. Dropping prune_posthog_raw alone is safe (the retention cron fails loud and raw
-- simply stops being trimmed).

create table if not exists posthog_retention_config (
  singleton      boolean primary key default true check (singleton),
  retention_days integer not null check (retention_days > 0)
);
insert into posthog_retention_config (singleton, retention_days)
values (true, 180)
on conflict (singleton) do nothing;

-- The per-source record of what has actually been pruned: refresh must never rebuild days below
-- pruned_before (their raw is gone). Advanced only by prune_posthog_raw, monotonically.
create table if not exists posthog_prune_watermarks (
  workspace_id  text not null,
  source_id     text not null references sources(id),
  pruned_before date not null,
  updated_at    timestamptz not null default now(),
  constraint posthog_prune_watermarks_pkey primary key (workspace_id, source_id)
);

-- Deletes raw truth rows for ONE source strictly before p_before (UTC calendar days of occurred_at,
-- matching every day expression in 0063), clamped to the config floor, and advances the watermark in
-- the same transaction. Returns the number of rows deleted. SECURITY INVOKER: callers (the retention
-- cron via the cloud service role; growth_os_worker / engine_app if ever run in credentialed
-- context) need DELETE on posthog_event_truth, SELECT on posthog_retention_config, and
-- INSERT/UPDATE/SELECT on posthog_prune_watermarks (granted below).
create or replace function prune_posthog_raw(
  p_workspace_id text, p_source_id text, p_before date
) returns bigint language plpgsql as $$
declare
  v_floor   date;
  v_before  date;
  v_deleted bigint;
begin
  if p_workspace_id is null or p_source_id is null or p_before is null then
    raise exception 'prune_posthog_raw: workspace_id, source_id and before-date are required';
  end if;

  -- Serialize with refresh_posthog_daily_rollups per (workspace, source) — see the header.
  perform pg_advisory_xact_lock(
    hashtextextended('posthog_raw_retention:' || p_workspace_id || ':' || p_source_id, 0)
  );

  -- STRICT: a missing (or duplicated) policy row fails LOUD — never a silent unclamped prune.
  select (now() at time zone 'utc')::date - retention_days
    into strict v_floor
    from posthog_retention_config;

  -- Caller-drift guard: never delete raw the policy still guarantees.
  v_before := least(p_before, v_floor);

  delete from posthog_event_truth
   where workspace_id = p_workspace_id
     and source_id = p_source_id
     and (occurred_at at time zone 'utc')::date < v_before;
  get diagnostics v_deleted = row_count;

  -- Advance the watermark even on a zero-row delete: below v_before there is provably no raw NOW,
  -- so a refresh must never rebuild those days from nothing.
  insert into posthog_prune_watermarks (workspace_id, source_id, pruned_before)
  values (p_workspace_id, p_source_id, v_before)
  on conflict (workspace_id, source_id) do update
    set pruned_before = greatest(posthog_prune_watermarks.pruned_before, excluded.pruned_before),
        updated_at = now();

  return v_deleted;
end $$;

-- Re-create the 0063 refresh RETENTION-AWARE. Same name/signature/semantics for retained days — the
-- frozen engine bundle's CLOSE hook keeps calling it unchanged — with exactly three additions:
--   1) the advisory transaction lock shared with prune_posthog_raw (see the header);
--   2) p_from clamps to the source's prune watermark, so the delete+insert can never reach days
--      whose raw is gone (no watermark row = nothing pruned = no clamp, full 0063 behavior);
--   3) a window clamped to empty RETURNS — a NO-OP, never a delete.
-- The backwards-window raise still fires on the RAW arguments, BEFORE any clamping: a caller
-- passing from > to is a bug regardless of retention. Day bucketing stays pinned to UTC in both the
-- grouping and the bounds (0063 doctrine). SECURITY INVOKER: callers additionally need SELECT on
-- posthog_prune_watermarks now (granted below).
create or replace function refresh_posthog_daily_rollups(
  p_workspace_id text, p_source_id text, p_from date, p_to date
) returns void language plpgsql as $$
declare
  v_pruned_before date;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if p_from > p_to then
    raise exception 'refresh_posthog_daily_rollups: from % after to %', p_from, p_to;
  end if;

  -- Serialize with prune_posthog_raw per (workspace, source) — the watermark read below and the
  -- delete+insert must see a consistent raw table.
  perform pg_advisory_xact_lock(
    hashtextextended('posthog_raw_retention:' || p_workspace_id || ':' || p_source_id, 0)
  );

  select pruned_before into v_pruned_before
    from posthog_prune_watermarks
   where workspace_id = p_workspace_id and source_id = p_source_id;

  if v_pruned_before is not null then
    -- Days below the watermark have NO raw: rebuilding them would delete permanent rollup history
    -- and re-insert nothing. Clamp, and no-op when nothing of the window survives.
    p_from := greatest(p_from, v_pruned_before);
    if p_from > p_to then
      return;
    end if;
  end if;

  v_from := p_from::timestamp at time zone 'utc';
  v_to   := (p_to + 1)::timestamp at time zone 'utc';

  delete from posthog_event_daily
   where workspace_id = p_workspace_id and source_id = p_source_id
     and occurred_on between p_from and p_to;
  insert into posthog_event_daily
    (workspace_id, source_id, occurred_on, event_name, landing_page, referrer,
     utm_source, utm_medium, utm_campaign, is_internal, event_count)
  select workspace_id, source_id, (occurred_at at time zone 'utc')::date, event_name, landing_page, referrer,
         utm_source, utm_medium, utm_campaign,
         coalesce(properties->>'is_internal', 'false') = 'true',
         count(*)
    from posthog_event_truth
   where workspace_id = p_workspace_id and source_id = p_source_id
     and occurred_at >= v_from and occurred_at < v_to
   group by workspace_id, source_id, (occurred_at at time zone 'utc')::date, event_name, landing_page, referrer,
            utm_source, utm_medium, utm_campaign,
            coalesce(properties->>'is_internal', 'false') = 'true';

  delete from posthog_site_daily
   where workspace_id = p_workspace_id and source_id = p_source_id
     and occurred_on between p_from and p_to;
  insert into posthog_site_daily
    (workspace_id, source_id, occurred_on, device_type, operating_system, browser,
     country, region, city, landing_page, referrer, utm_source, utm_medium, utm_campaign,
     is_internal, page_view_count)
  select workspace_id, source_id, (occurred_at at time zone 'utc')::date,
         lower(properties->>'$device_type'), properties->>'$os', properties->>'$browser',
         properties->>'$geoip_country_name', properties->>'$geoip_subdivision_1_name',
         properties->>'$geoip_city_name',
         landing_page, referrer, utm_source, utm_medium, utm_campaign,
         coalesce(properties->>'is_internal', 'false') = 'true',
         count(*)
    from posthog_event_truth
   where workspace_id = p_workspace_id and source_id = p_source_id
     and occurred_at >= v_from and occurred_at < v_to
     and event_name = '$pageview'
   group by workspace_id, source_id, (occurred_at at time zone 'utc')::date,
            lower(properties->>'$device_type'), properties->>'$os', properties->>'$browser',
            properties->>'$geoip_country_name', properties->>'$geoip_subdivision_1_name',
            properties->>'$geoip_city_name',
            landing_page, referrer, utm_source, utm_medium, utm_campaign,
            coalesce(properties->>'is_internal', 'false') = 'true';
end $$;

-- Grants (0057 pattern; a new table is NOT covered by 0006's apply-time blanket grant — the
-- 0053 / 2026-08-04 grantless incidents). Refresh callers (connector CLOSE hook: growth_os_worker
-- locally, engine_app on the cloud engine) read the watermark; prune callers additionally read the
-- config, DELETE raw truth, and write the watermark. Read roles get SELECT on both new tables for
-- diagnostics. posthog_event_truth grants predate this file for the worker (0006 blanket) — the
-- explicit re-grant is idempotent and documents what prune needs.
grant select on posthog_retention_config to growth_os_worker, growth_os_app, growth_os_tool_agent;
grant select, insert, update, delete on posthog_prune_watermarks to growth_os_worker;
grant select on posthog_prune_watermarks to growth_os_app, growth_os_tool_agent;
grant select, delete on posthog_event_truth to growth_os_worker;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on posthog_retention_config to engine_app;
    grant select, insert, update, delete on posthog_prune_watermarks to engine_app;
    grant select, delete on posthog_event_truth to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on posthog_retention_config, posthog_prune_watermarks to growth_os_read_api;
  end if;
end
$$;
