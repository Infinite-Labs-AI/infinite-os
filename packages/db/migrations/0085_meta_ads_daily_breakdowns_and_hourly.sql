-- DAILY Meta ad set breakdowns + campaign HOURLY delivery (governed data layer, 2026-10-08).
--
-- 1. meta_ads_adset_breakdown_daily: the device / placement split of each ad set PER DAY (time_increment=1),
--    replacing the weekly all_days windows of 0080 as the read the caller schedules. The weekly table stays
--    (and stays readable) until its readers move; nothing here touches it.
--    Dimensions, ONE per query:
--      device_platform     breakdowns=device_platform
--      publisher_platform  breakdowns=publisher_platform
--      platform_position   breakdowns=publisher_platform,platform_position — a position ("feed") only exists
--                          under a platform, so its row carries the platform in parent_value
--                          ('facebook' / 'instagram'); the single-dimension rows carry parent_value ''.
--    reach is Meta's de-duplicated DAILY reach for that ad set and value: never sum it across days or values.
--    Rates are not stored; readers recompute them from these bases.
--
-- 2. meta_ads_adset_breakdown_daily_coverage: ONE receipt per (account, dimension, day), written in the SAME
--    transaction as that day's rows, like meta_ads_coverage_daily. row_count 0 = Meta returned no rows for that
--    day (a measured none); NO receipt = never measured, which a reader must show as unmeasured, never 0.
--
-- 3. meta_ads_campaign_hourly: campaign spend / impressions / clicks / link clicks per hour of the ADVERTISER's
--    time zone (breakdowns=hourly_stats_aggregated_by_advertiser_time_zone). occurred_on and hour are both on the
--    ad account's own calendar. Meta does not return reach by hour, so none is stored.
--
-- 4. meta_ads_campaign_hourly_coverage: ONE receipt per (account, day). settled = the day had ended in the
--    account's time zone when it was read. For an open day (today), observed_local_hour is the account-local
--    hour at read time: hours before it with no row were measured as none, that hour is still accruing, and
--    later hours are unmeasured. A settled day's receipt has observed_local_hour null.
--
-- Written only by syncMetaAdsAdsetBreakdownDaily / syncMetaAdsCampaignHourly (connectors), which the caller
-- schedules and pays for from its own lane of the per-account request budget. Data is kept forever.
--
-- Orphan-safe and idempotent: only new tables (no NOT NULL is added over existing rows), every create is
-- `if not exists`, grants are re-runnable — the cloud engine's one-call execute_sql recipe can run it twice.

create table if not exists meta_ads_adset_breakdown_daily (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  adset_id text not null,
  occurred_on date not null,
  dimension text not null check (dimension in ('device_platform', 'publisher_platform', 'platform_position')),
  parent_value text not null default '',
  dimension_value text not null,
  campaign_id text,
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
  check ((dimension = 'platform_position') = (parent_value <> '')),
  primary key (workspace_id, source_id, ad_account_id, occurred_on, dimension, adset_id, parent_value, dimension_value)
);

create table if not exists meta_ads_adset_breakdown_daily_coverage (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  dimension text not null check (dimension in ('device_platform', 'publisher_platform', 'platform_position')),
  occurred_on date not null,
  closed_at timestamptz not null default now(),
  row_count integer not null check (row_count >= 0),
  sync_run_id text,
  primary key (workspace_id, source_id, ad_account_id, dimension, occurred_on)
);

create table if not exists meta_ads_campaign_hourly (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  campaign_id text not null,
  occurred_on date not null,
  hour smallint not null check (hour between 0 and 23),
  spend numeric,
  impressions bigint,
  clicks bigint,
  inline_link_clicks bigint,
  currency text,
  api_version text,
  sync_run_id text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, source_id, ad_account_id, occurred_on, campaign_id, hour)
);

create table if not exists meta_ads_campaign_hourly_coverage (
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

grant select, insert, delete on meta_ads_adset_breakdown_daily, meta_ads_campaign_hourly to growth_os_worker;
grant select, insert, update on meta_ads_adset_breakdown_daily_coverage, meta_ads_campaign_hourly_coverage
  to growth_os_worker;
grant select on meta_ads_adset_breakdown_daily, meta_ads_adset_breakdown_daily_coverage,
  meta_ads_campaign_hourly, meta_ads_campaign_hourly_coverage
  to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- Hosted engine role is deployment-specific and may not exist in local PGlite.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, delete on meta_ads_adset_breakdown_daily, meta_ads_campaign_hourly to engine_app;
    grant select, insert, update on meta_ads_adset_breakdown_daily_coverage, meta_ads_campaign_hourly_coverage
      to engine_app;
  end if;
end
$$;
