-- Meta's LEARNING STAGE per ad set, as read (extended reads; Ad Brain decision 2, 2026-09-29).
--
-- Written only when the caller switches a source's extended reads on (SyncRequest.metaAdsExtendedReads):
-- the inventory / settled / backfill entity scan then asks the ad set edge for `learning_stage_info` on the
-- SAME request it already makes (no extra call), and CLOSE writes one row per ad set that read returned.
-- With the switch off (the default) nothing writes here, and a reader says "not requested", never guesses.
--
-- The stage is deliberately NOT part of meta_ads_entity_versions: it moves as delivery accrues, so keeping
-- it on the entity metadata would mint a version on nearly every scan and bury real edits. It is stripped
-- from the node before the snapshot and lives here instead.
--
--   observed_at       when the ad set edge was read (one read → one row per ad set it returned).
--   observed_on       the account-local calendar day of observed_at; NULL while the account's timezone is
--                     not yet stored.
--   status            Meta's word as returned (LEARNING | SUCCESS | FAIL). NULL = the read ASKED and Meta
--                     returned no learning stage for this ad set (unmeasured, never "not learning").
--   conversions       Meta's count of optimisation events toward leaving learning; NULL when absent.
--   last_sig_edit_ts  Meta's last significant edit time for the ad set; NULL when absent.
--
-- Staleness: an incremental scan reads only ad sets whose updated_time moved, which a learning transition
-- does not move; the 24h full scan re-reads every ad set. Readers therefore say "as of <observed_at>".

create table if not exists meta_ads_adset_learning_observations (
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  adset_id text not null,
  observed_at timestamptz not null,
  observed_on date,
  status text,
  conversions numeric check (conversions is null or conversions >= 0),
  last_sig_edit_ts timestamptz,
  attribution_windows jsonb,
  api_version text,
  sync_run_id text,
  created_at timestamptz not null default now(),
  primary key (source_id, adset_id, observed_at)
);

create index if not exists meta_ads_adset_learning_observations_latest_idx
  on meta_ads_adset_learning_observations (workspace_id, source_id, ad_account_id, adset_id, observed_at desc);

grant select, insert on meta_ads_adset_learning_observations to growth_os_worker;
grant select on meta_ads_adset_learning_observations to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- Hosted engine role is deployment-specific and may not exist in local PGlite.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert on meta_ads_adset_learning_observations to engine_app;
  end if;
end
$$;
