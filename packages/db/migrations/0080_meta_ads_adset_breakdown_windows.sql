-- Weekly Meta ad set BREAKDOWNS (extended reads; Ad Brain decision 2, 2026-09-29): about two calls per
-- account per settled week, ONE dimension per query (device_platform, then publisher_platform).
--
-- Written only by syncMetaAdsAdsetBreakdownWindow, which the caller schedules for a switched-on source and
-- pays for from its own reserved share of the per-account request budget. One read = one window x one
-- dimension: its rows replace that window's rows for that dimension, and its coverage receipt is written in
-- the SAME transaction.
--
-- Coverage is the honesty contract: a receipt with row_count = 0 means Meta returned no rows for that
-- window and dimension (a measured none); NO receipt means never measured, which a reader must show as
-- unmeasured, never as 0.
--
-- Values are Meta's for the whole window (time_increment=all_days): reach is Meta's de-duplicated window
-- reach for that ad set and dimension value, so it must never be summed across dimension values or windows.
-- Rates are not stored; readers recompute them from these bases.

create table if not exists meta_ads_adset_breakdown_windows (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  adset_id text not null,
  window_since date not null,
  window_until date not null,
  dimension text not null check (dimension in ('device_platform', 'publisher_platform')),
  dimension_value text not null,
  spend numeric,
  impressions bigint,
  reach bigint,
  clicks bigint,
  inline_link_clicks bigint,
  actions_raw jsonb,
  currency text,
  api_version text,
  sync_run_id text,
  created_at timestamptz not null default now(),
  check (window_until >= window_since),
  primary key (workspace_id, source_id, ad_account_id, adset_id, window_since, window_until, dimension, dimension_value)
);

create table if not exists meta_ads_breakdown_coverage (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  window_since date not null,
  window_until date not null,
  dimension text not null check (dimension in ('device_platform', 'publisher_platform')),
  closed_at timestamptz not null default now(),
  row_count integer not null check (row_count >= 0),
  sync_run_id text,
  check (window_until >= window_since),
  primary key (workspace_id, source_id, ad_account_id, window_since, window_until, dimension)
);

grant select, insert, delete on meta_ads_adset_breakdown_windows to growth_os_worker;
grant select, insert, update on meta_ads_breakdown_coverage to growth_os_worker;
grant select on meta_ads_adset_breakdown_windows, meta_ads_breakdown_coverage
  to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- Hosted engine role is deployment-specific and may not exist in local PGlite.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, delete on meta_ads_adset_breakdown_windows to engine_app;
    grant select, insert, update on meta_ads_breakdown_coverage to engine_app;
  end if;
end
$$;
