-- Meta AD-level HOURLY delivery WITH results (2026-10-09). Supersedes 0085's campaign hours as the scheduled read.
--
-- 0085 stored campaign hours with spend / impressions / clicks / link clicks only. Meta's hourly breakdown
-- (hourly_stats_aggregated_by_advertiser_time_zone) also returns actions[] and action_values[] per hour, and it works at
-- level=ad; it excludes only unique_* fields, reach, frequency and video_* fields. So the hourly read is now one
-- level=ad query that carries the same actions storage as the daily fact rows; ad set and campaign hours are sums of
-- their ad rows, so no other hourly level is stored.
--
-- Which hour a conversion lands in: since 2025-06-10 Meta disregards action_report_time and reports as Ads Manager does
-- (Meta's 2025 out-of-cycle changes). Off-Meta conversions (website purchases, leads, sign-ups) are reported at the time
-- the conversion happened; on-Meta actions (link clicks, page engagement) at the impression's time. The read sends the
-- same attribution windows as the daily read and no action_report_time.
--
-- 1. meta_ads_ad_hourly: one row per ad per account-local hour of a day that had delivery or actions in that hour.
--    occurred_on and hour are both on the ad account's own calendar. actions_raw = { actions: [...], action_values: [...] }
--    exactly as Meta returned them (per-window sub-values kept), the shape of meta_ads_adset_breakdown_daily.actions_raw.
--    campaign_id / adset_id are carried columns, not the key. Meta returns no reach by hour, so none is stored.
--
-- 2. meta_ads_ad_hourly_coverage: ONE receipt per (account, day), the rule of meta_ads_campaign_hourly_coverage.
--    settled = the day had ended in the account's time zone when it was read. For an open day (today),
--    observed_local_hour is the account-local hour at read time: hours before it with no row were measured as none,
--    that hour is still accruing, and later hours are unmeasured. NO receipt = never measured (never 0).
--
-- 0085's campaign tables are left as they are (readable; no longer written by the caller's schedule).
--
-- Written only by syncMetaAdsAdHourly (connectors), which the caller schedules and pays for from its own lane of the
-- per-account request budget. Data is kept forever.
--
-- Orphan-safe and idempotent: only new tables, every create is `if not exists`, grants are re-runnable — the cloud
-- engine's one-call execute_sql recipe can run it twice.

create table if not exists meta_ads_ad_hourly (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  ad_id text not null,
  adset_id text,
  campaign_id text,
  occurred_on date not null,
  hour smallint not null check (hour between 0 and 23),
  spend numeric,
  impressions bigint,
  clicks bigint,
  inline_link_clicks bigint,
  actions_raw jsonb,
  currency text,
  api_version text,
  sync_run_id text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, source_id, ad_account_id, occurred_on, ad_id, hour)
);

create table if not exists meta_ads_ad_hourly_coverage (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  occurred_on date not null,
  closed_at timestamptz not null default now(),
  row_count integer not null check (row_count >= 0),
  settled boolean not null,
  observed_local_hour smallint check (observed_local_hour between 0 and 23),
  timezone_name text not null,
  sync_run_id text,
  check (settled = (observed_local_hour is null)),
  primary key (workspace_id, source_id, ad_account_id, occurred_on)
);

grant select, insert, delete on meta_ads_ad_hourly to growth_os_worker;
grant select, insert, update on meta_ads_ad_hourly_coverage to growth_os_worker;
grant select on meta_ads_ad_hourly, meta_ads_ad_hourly_coverage to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- Hosted engine role is deployment-specific and may not exist in local PGlite.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, delete on meta_ads_ad_hourly to engine_app;
    grant select, insert, update on meta_ads_ad_hourly_coverage to engine_app;
  end if;
end
$$;
