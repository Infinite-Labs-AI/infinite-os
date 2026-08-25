-- Phase 1 §2.1 — the Meta Ads campaign DIMENSION table.
--
-- The delivery fact (meta_ads_campaign_daily, 0015) carries campaign_id +
-- campaign_name per day, but there is no campaign-grain dimension carrying the
-- account-level attributes the §5 Stripe join needs. This table is that
-- dimension: one row per campaign, last-write-wins on re-sync.
--
-- LOAD-BEARING column: `currency` (the ad-account currency, read from
-- `meta ads adaccount`). It is the reconciliation axis for the future Meta<->Stripe
-- ROAS join (Stripe revenue is per-invoice currency in MINOR units; Meta spend is
-- MAJOR units with the account currency tracked here). Stage 1 only stores it.
--
-- `objective` is the campaign-level coarse key. The REAL driver of result_type is
-- the adset `optimization_goal` (§2.1 note) — that lives on the per-day conversion
-- fact (meta_ads_campaign_conversions_daily.result_type / results_source) since a
-- campaign can carry adsets with different optimization goals. This dimension keeps
-- only the campaign-coarse `objective`; the canonical-event mapping (§4b) keys on
-- optimization_goal first, then falls back to this objective.
--
-- runMigrations() wraps every migration file in begin/commit, so this file is not
-- wrapped again here.

create table meta_ads_campaigns (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  campaign_id text not null,
  name text,
  -- Coarse campaign objective (ODAX, e.g. OUTCOME_LEADS / OUTCOME_SALES). The
  -- fine-grained result driver is the adset optimization_goal, captured per-day on
  -- the conversions fact; see §4b mapping precedence.
  objective text,
  effective_status text,
  configured_status text,
  -- Account currency (ISO code, lowercased to match Stripe's lowercase currency
  -- text) — load-bearing for the Stripe value join. Nullable: the account-currency
  -- read may not have run yet on first ingest.
  currency text,
  updated_at_source timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ad_account_id, campaign_id)
);

-- Worker ingests this dimension (insert/update on re-sync), mirroring the
-- meta_ads_campaign_daily worker grant (0015:103). A freshly created table is NOT
-- covered by 0006's apply-time blanket grant, so grant explicitly; guarded so the
-- migration applies on a fresh DB where the role may not exist yet (0028 pattern).
do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_campaigns to growth_os_worker;
  end if;
end $$;
