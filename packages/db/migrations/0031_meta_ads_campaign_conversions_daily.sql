-- Phase 1 §2.3 — the Meta Ads conversions CHILD fact.
--
-- Grain = campaign × day × result_type. One row per MEANINGFUL conversion event
-- type for a campaign-day: a lead+purchase campaign gets BOTH a 'lead' row and a
-- 'purchase' row — no loser is silently dropped. This is the typed-conversion
-- spine: a conversion COUNT is meaningless without its TYPE (§1), so result_type
-- travels on every row and CPL/CPA are NEVER blended across types (§6).
--
-- WHY a separate fact (not scalar columns on meta_ads_campaign_daily): the daily
-- delivery fact is one row per campaign-day; conversions fan out to N result_types
-- per campaign-day. Putting results/result_type as scalar columns there would force
-- one type to win (the §0 Ultima corruption). §2.2 explicitly forbids scalar
-- results/result_type on the delivery fact.
--
-- conversion_value is populated ONLY for purchase-type results (§2.3 guard): a
-- configured *lead value* must NOT be stored as revenue. For lead rows it stays
-- NULL. The value, when present, is the SAME pixel channel as the count spine
-- (offsite_conversion.fb_pixel_purchase + its action_value) — never omni (§4).
--
-- results_source records which path produced the headline `results`:
--   'derived_from_canonical_mapping'  — WE applied the §4b objective->event mapping
--                                        to actions[] (deterministic, we control it).
--   'meta_results'                    — Meta's own results field fed the row AND its
--                                        result_values_performance_indicator matched
--                                        our canonical rule (verified cross-check).
--   'meta_results_unverified_type'    — Meta's results field fed the row but its
--                                        reported indicator did NOT match our rule's
--                                        action types (reconciliation drift flagged).
-- The actions[] derivation is preferred; the meta_results paths are the fallback so a
-- blank actions[] does not null the headline.
--
-- is_primary = true for the objective's canonical result (the headline number);
-- secondary rows (e.g. a lead row on a purchase campaign) carry is_primary = false.
--
-- runMigrations() wraps every migration file in begin/commit, so this file is not
-- wrapped again here.

create table meta_ads_campaign_conversions_daily (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  campaign_id text not null,
  occurred_on date not null,
  -- The canonical conversion event type (e.g. 'lead', 'purchase', 'link_click',
  -- 'landing_page_view'). The REQUIRED partition for results/cost_per_result — the
  -- engine refuses to blend across distinct result_types (§6).
  result_type text not null,
  -- Additive count for this (campaign, day, result_type). Recomputed/summed safely.
  results numeric(18,6) not null default 0,
  -- Purchase-type ONLY (§2.3 guard); NULL for lead and other non-purchase types.
  -- Same pixel channel as the count spine; never omni_purchase.
  conversion_value numeric(18,6),
  -- Describes the REQUEST shape that produced this row (attribution windows +
  -- unified on/off), e.g. '1d_click,7d_click,1d_view'. Provenance, not a lever.
  attribution_setting text,
  -- The objective's canonical headline result for this campaign-day.
  is_primary boolean not null default false,
  -- 'derived_from_canonical_mapping' | 'meta_results' — which path fed `results`.
  results_source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ad_account_id, campaign_id, occurred_on, result_type)
);

-- Worker ingests + restates this fact (insert/update on the rolling 28-day window;
-- §4c last-write-wins). Mirrors the meta_ads_campaign_daily worker grant; a
-- freshly created table is NOT covered by 0006's apply-time blanket grant. Guarded
-- so the migration applies on a fresh DB where the role may not exist yet.
do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_campaign_conversions_daily to growth_os_worker;
  end if;
end $$;
