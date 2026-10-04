-- 0063_posthog_daily_rollups.sql
-- Day-grain rollups behind the two PostHog queryable views. The views previously GROUP BYed the whole
-- raw truth table per query (a day-of expression over occurred_at is not sargable, plus a per-row
-- JSONB parse), so every
-- App-tab tile re-scanned every event the workspace ever synced — 1.1s on prod's largest workspace,
-- 1.5-4s on the sandbox with sorts spilling to disk. They now read these tables, which
-- refresh_posthog_daily_rollups() maintains per (workspace, source, day-range) from the PostHog
-- connector's CLOSE hook (the transaction that runs after truth has committed — the same seam GA4's
-- snapshot replacement and Stripe's reconciliation cursor use). View contracts UNCHANGED: same names,
-- same column names/order/types as 0060, so metricView()/runAggregate need zero SQL changes.
--
-- Table/column names for posthog_event_daily match the demo train's projection (1bu-1
-- demo/lib/projections/posthog.ts), which already targets them; the extra dimension columns default
-- to NULL for demo rows.
--
-- is_internal is a GROUPING column here (0060 doctrine: internal rows are still COLLECTED, so they
-- remain available for our own testing / direct queries); the app-facing views hide them.
--
-- The grain is unique with NULLS NOT DISTINCT: a duplicate rollup row is a hard error, never a doubled
-- chart. Refresh is a per-(workspace, source, window) delete+insert, so it is exact and idempotent, and
-- because the sync scheduler serializes runs per source two PostHog sources in one workspace can never
-- race each other's rows.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────────────
-- VIEWS ONLY. Do NOT drop refresh_posthog_daily_rollups() or the two tables. Once the Trigger deploy
-- ships, the PostHog connector's CLOSE hook calls that function inside the sync transaction, so
-- dropping it (or the tables it writes) makes EVERY PostHog sync fail at close — the naive rollback is
-- worse than the thing it undoes. Left alone they are INERT: nothing reads them once the views are
-- re-pointed, and they stay warm for a re-cutover.
-- Rolling back the views is safe because posthog_event_truth is still FULLY WRITTEN by the connector
-- (this migration added a rollup beside it; it never stopped writing truth), and 0060's view contracts
-- are column-for-column identical to the ones re-cut below, so CREATE OR REPLACE accepts them.
-- Two steps, in one transaction:
--   1) re-issue migration 0060's two view bodies VERBATIM — copied below;
--   2) update queryable_views set source_tables = '["posthog_event_truth"]'
--       where id in ('queryable.vw_posthog_events', 'queryable.vw_posthog_site');
-- (vw_site_conversion_rate reads truth directly and is untouched here — it needs no rollback.)
--
-- create or replace view queryable.vw_posthog_events as
-- select
--   workspace_id, source_id, date(occurred_at) as occurred_on, event_name, landing_page, referrer,
--   utm_source, utm_medium, utm_campaign, count(*) as posthog_event_count
-- from posthog_event_truth
-- where coalesce(properties->>'is_internal', 'false') <> 'true'
-- group by workspace_id, source_id, date(occurred_at), event_name, landing_page, referrer,
--          utm_source, utm_medium, utm_campaign;
--
-- create or replace view queryable.vw_posthog_site as
-- select
--   workspace_id, source_id, date(occurred_at) as occurred_on,
--   lower(properties->>'$device_type') as device_type,
--   properties->>'$os' as operating_system,
--   properties->>'$browser' as browser,
--   properties->>'$geoip_country_name' as country,
--   properties->>'$geoip_subdivision_1_name' as region,
--   properties->>'$geoip_city_name' as city,
--   landing_page, referrer, utm_source, utm_medium, utm_campaign,
--   count(*) as posthog_page_views
-- from posthog_event_truth
-- where event_name = '$pageview'
--   and coalesce(properties->>'is_internal', 'false') <> 'true'
-- group by workspace_id, source_id, date(occurred_at),
--          lower(properties->>'$device_type'), properties->>'$os', properties->>'$browser',
--          properties->>'$geoip_country_name', properties->>'$geoip_subdivision_1_name',
--          properties->>'$geoip_city_name',
--          landing_page, referrer, utm_source, utm_medium, utm_campaign;

create table if not exists posthog_event_daily (
  workspace_id text not null,
  source_id    text not null references sources(id),
  occurred_on  date not null,
  event_name   text not null,
  landing_page text,
  referrer     text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  is_internal  boolean not null default false,
  event_count  bigint not null check (event_count >= 0),
  refreshed_at timestamptz not null default now(),
  constraint posthog_event_daily_grain_key unique nulls not distinct
    (workspace_id, source_id, occurred_on, event_name, landing_page, referrer,
     utm_source, utm_medium, utm_campaign, is_internal)
);
create index if not exists posthog_event_daily_workspace_time_idx
  on posthog_event_daily (workspace_id, occurred_on);

create table if not exists posthog_site_daily (
  workspace_id     text not null,
  source_id        text not null references sources(id),
  occurred_on      date not null,
  device_type      text,
  operating_system text,
  browser          text,
  country          text,
  region           text,
  city             text,
  landing_page     text,
  referrer         text,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  is_internal      boolean not null default false,
  page_view_count  bigint not null check (page_view_count >= 0),
  refreshed_at     timestamptz not null default now(),
  constraint posthog_site_daily_grain_key unique nulls not distinct
    (workspace_id, source_id, occurred_on, device_type, operating_system, browser, country, region,
     city, landing_page, referrer, utm_source, utm_medium, utm_campaign, is_internal)
);
create index if not exists posthog_site_daily_workspace_time_idx
  on posthog_site_daily (workspace_id, occurred_on);

-- Rewrites the rollups for ONE source over [p_from, p_to] (inclusive, UTC calendar days of
-- occurred_at). The day bucket is pinned to UTC in BOTH the grouping and the bounds — never the
-- session time zone: the connector CLOSE hook derives p_from/p_to by slicing ISO (UTC) cursors, so a
-- session-zone bucket would, under any non-UTC session, load events into a local day the hook never
-- asked to refresh (silently short forever). SECURITY INVOKER (the default): the caller — the
-- connector CLOSE hook as growth_os_worker locally, engine_app on the cloud engine — needs
-- DELETE + INSERT on both tables (granted below).
create or replace function refresh_posthog_daily_rollups(
  p_workspace_id text, p_source_id text, p_from date, p_to date
) returns void language plpgsql as $$
declare
  v_from timestamptz := p_from::timestamp at time zone 'utc';
  v_to   timestamptz := (p_to + 1)::timestamp at time zone 'utc';
begin
  if p_from > p_to then
    raise exception 'refresh_posthog_daily_rollups: from % after to %', p_from, p_to;
  end if;

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

-- Re-point the views. Same names, same column names/order/types as 0060 (CREATE OR REPLACE would
-- refuse anything else). The 0060 internal-traffic exclusion becomes `where not is_internal`.
create or replace view queryable.vw_posthog_events as
select workspace_id, source_id, occurred_on, event_name, landing_page, referrer,
       utm_source, utm_medium, utm_campaign,
       event_count as posthog_event_count
  from posthog_event_daily
 where not is_internal;

create or replace view queryable.vw_posthog_site as
select workspace_id, source_id, occurred_on, device_type, operating_system, browser,
       country, region, city, landing_page, referrer, utm_source, utm_medium, utm_campaign,
       page_view_count as posthog_page_views
  from posthog_site_daily
 where not is_internal;

-- Registry (0062's precedent): the views now read the rollups, so describe_queryable_view / the
-- freshness derivation must name them, not the raw truth table. Provider derivation keys off the
-- `posthog_` prefix, so the provider set is unchanged.
update queryable_views set source_tables = '["posthog_event_daily"]'
 where id = 'queryable.vw_posthog_events';
update queryable_views set source_tables = '["posthog_site_daily"]'
 where id = 'queryable.vw_posthog_site';

-- Grants (0057's pattern; a new table/view is NOT covered by 0006's apply-time blanket grant — the
-- 0053 / 2026-08-04 grantless-view incidents, which owner-run PGlite tests can never catch).
-- Writers (the connector CLOSE hook runs the refresh as these): local engine + cloud engine.
grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to growth_os_worker;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to engine_app;
  end if;
end
$$;
-- Readers: the query seam roles, on the tables AND the re-cut views.
grant select on posthog_event_daily, posthog_site_daily to growth_os_app, growth_os_tool_agent;
grant select on queryable.vw_posthog_events, queryable.vw_posthog_site to growth_os_app, growth_os_tool_agent;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on posthog_event_daily, posthog_site_daily to growth_os_read_api;
    grant select on queryable.vw_posthog_events, queryable.vw_posthog_site to growth_os_read_api;
  end if;
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on queryable.vw_posthog_events, queryable.vw_posthog_site to engine_app;
  end if;
end
$$;

-- Durable copy of the sandbox hand-applied audit index (Phase 0): the demo verifier's invoice-lines
-- correlated subquery had no (workspace, source, invoice) path and ran 61s. Plain CREATE INDEX — this
-- file runs inside one transaction, so the lock-free concurrent form is impossible; the table is small
-- enough that the lock is milliseconds.
create index if not exists stripe_invoice_lines_workspace_invoice_idx
  on stripe_invoice_lines (workspace_id, source_id, stripe_invoice_id);

-- One-time backfill, per (workspace, source) — the same unit the connector hook refreshes. Runs inside
-- the migration transaction: seconds on prod (92k rows), under a minute on the sandbox (221k).
-- The upper bound is UTC "today", not `current_date`: every other day expression in this file reads
-- occurred_at AT TIME ZONE 'utc', so a session running west of UTC would have stopped the backfill a
-- day short and left the most recent day unrolled until the next CLOSE hook.
do $$
declare r record;
begin
  for r in select distinct workspace_id, source_id from posthog_event_truth loop
    perform refresh_posthog_daily_rollups(
      r.workspace_id, r.source_id, date '2000-01-01', (now() at time zone 'utc')::date
    );
  end loop;
end $$;
