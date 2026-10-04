-- Canonical Meta Ads daily-history integrity support.
--
-- The three delivery/conversion fact stacks already hold the canonical campaign, ad-set and ad
-- provider grains. This migration adds only the metadata required to prove what was measured and to
-- replace a successfully refreshed window without retaining obsolete provider rows. It deliberately
-- creates no competing rollup table and applies no fact-retention deletion.

-- One current account dimension per source. `sources.account_external_id` is still the binding of
-- record; this compact row gives history readers the provider-local reporting calendar and currency
-- without decrypting the credential or scanning campaign facts.
create table meta_ads_accounts (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  currency text,
  timezone_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, source_id, ad_account_id)
);

-- One receipt per provider-local day and requested reporting grain. Presence proves the exact day
-- completed extraction, every load chunk and snapshot CLOSE. row_count=0 is therefore a measured
-- zero; absence remains unmeasured. Overlapping restatements update the receipt in place.
create table meta_ads_coverage_daily (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  grain text not null check (grain in ('campaign', 'adset', 'ad')),
  occurred_on date not null,
  sync_run_id text not null references sync_runs(id),
  row_count integer not null check (row_count >= 0),
  closed_at timestamptz not null default now(),
  primary key (workspace_id, source_id, ad_account_id, grain, occurred_on)
);

-- Internal staged identity set for snapshot replacement. Writers add keys in the same transaction as
-- their fact rows. CLOSE anti-joins this exact run before pruning and then removes the staged keys.
-- A failed/partial load never enters CLOSE, so it can never delete normalized history or publish
-- coverage. The conversion result_type is part of the key; delivery uses the explicit empty sentinel.
create table meta_ads_snapshot_keys (
  sync_run_id text not null references sync_runs(id) on delete cascade,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  grain text not null check (grain in ('campaign', 'adset', 'ad', 'creative')),
  occurred_on date not null,
  entity_id text not null,
  key_kind text not null check (key_kind in ('delivery', 'conversion', 'entity')),
  result_type text not null default '',
  created_at timestamptz not null default now(),
  check ((key_kind in ('delivery', 'entity') and result_type = '') or (key_kind = 'conversion' and result_type <> '')),
  primary key (sync_run_id, grain, occurred_on, entity_id, key_kind, result_type)
);

-- Change-only entity history. The current campaign/ad-set/ad dimension tables stay the cheap current
-- lookup; this ledger opens a new version only when the bounded provider metadata payload changes.
-- Rich targeting, placement, promoted-object and creative descriptors live in metadata_json. Media
-- bytes never do: a closed cloud archival worker may use the stored provider references to copy
-- assets into workspace-owned object storage.
create table meta_ads_entity_versions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text not null references raw_records(id),
  ad_account_id text not null,
  entity_type text not null check (entity_type in ('campaign', 'adset', 'ad', 'creative')),
  entity_id text not null,
  campaign_id text,
  adset_id text,
  ad_id text,
  creative_id text,
  name text,
  effective_status text,
  configured_status text,
  objective text,
  optimization_goal text,
  billing_event text,
  daily_budget bigint,
  lifetime_budget bigint,
  bid_amount bigint,
  payload_hash text not null,
  metadata_json jsonb not null,
  asset_descriptors jsonb not null default '[]'::jsonb,
  api_version text not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  check (last_observed_at >= first_observed_at),
  check (valid_to is null or valid_to >= first_observed_at)
);

create unique index meta_ads_entity_versions_current_uq
  on meta_ads_entity_versions (workspace_id, source_id, ad_account_id, entity_type, entity_id)
  where valid_to is null;
create index meta_ads_entity_versions_history_idx
  on meta_ads_entity_versions
    (workspace_id, source_id, ad_account_id, entity_type, entity_id, first_observed_at desc);

-- Product reads always bind workspace + source + account + date before grouping by entity. Existing
-- unique indexes lead with source/account/entity/date, which cannot serve that range shape directly.
create index meta_ads_campaign_daily_history_idx
  on meta_ads_campaign_daily (workspace_id, source_id, ad_account_id, occurred_on, campaign_id);
create index meta_ads_adset_daily_history_idx
  on meta_ads_adset_daily (workspace_id, source_id, ad_account_id, occurred_on, adset_id);
create index meta_ads_ad_daily_history_idx
  on meta_ads_ad_daily (workspace_id, source_id, ad_account_id, occurred_on, ad_id);

create index meta_ads_campaign_conversions_daily_history_idx
  on meta_ads_campaign_conversions_daily
    (workspace_id, source_id, ad_account_id, occurred_on, result_type, campaign_id);
create index meta_ads_adset_conversions_daily_history_idx
  on meta_ads_adset_conversions_daily
    (workspace_id, source_id, ad_account_id, occurred_on, result_type, adset_id);
create index meta_ads_ad_conversions_daily_history_idx
  on meta_ads_ad_conversions_daily
    (workspace_id, source_id, ad_account_id, occurred_on, result_type, ad_id);

-- Snapshot replacement is the only new fact-table mutation. Scope remains exactly Meta's six
-- normalized facts; normalized rows have no age-based deletion policy in this slice.
grant delete on meta_ads_campaign_daily, meta_ads_adset_daily, meta_ads_ad_daily
  to growth_os_worker;
grant delete on meta_ads_campaign_conversions_daily, meta_ads_adset_conversions_daily, meta_ads_ad_conversions_daily
  to growth_os_worker;
grant select, insert, update on meta_ads_accounts, meta_ads_coverage_daily
  to growth_os_worker;
grant select, insert, delete on meta_ads_snapshot_keys
  to growth_os_worker;
grant select, insert, update on meta_ads_entity_versions
  to growth_os_worker;
grant select on meta_ads_accounts, meta_ads_coverage_daily, meta_ads_entity_versions
  to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- Hosted engine role is deployment-specific and may not exist in local PGlite.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update on meta_ads_accounts, meta_ads_coverage_daily to engine_app;
    grant select, insert, delete on meta_ads_snapshot_keys to engine_app;
    grant select, insert, update on meta_ads_entity_versions to engine_app;
    grant delete on meta_ads_campaign_daily, meta_ads_adset_daily, meta_ads_ad_daily to engine_app;
    grant delete on meta_ads_campaign_conversions_daily, meta_ads_adset_conversions_daily, meta_ads_ad_conversions_daily to engine_app;
  end if;
end
$$;
