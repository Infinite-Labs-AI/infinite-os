-- Phase 2 slice-1a §2/§3 — the Meta Ads ADSET grain (dim + delivery fact + typed
-- conversions + views + metric_definitions expansion). Mirrors the campaign grain
-- one-to-one (migrations 0030/0015+0032/0031/0033/0034) at adset grain, plus the
-- on/off STATUS dimensions (effective_status / configured_status) as first-class
-- queryable columns. ALL READ-ONLY (no ad-account mutations — open-core boundary).
--
-- WHY A SEPARATE TABLE STACK (the §1 no-roll-up rule): Meta dedups conversions only
-- WITHIN an ad set, so adset-summed conversions can exceed the campaign total. Spend
-- and clicks ARE additive; conversions/value are NOT. We therefore INGEST each grain
-- AS META REPORTS IT and never derive one grain from another — hence a parallel,
-- independently-keyed adset table stack rather than a roll-up of the campaign facts.
--
-- THE #1 CORRUPTION FIX (§2.2/§4): the unique key on every adset fact is RE-KEYED on
-- adset_id (not campaign_id). Reusing the campaign-keyed unique key at adset grain
-- would collapse every adset row of a campaign onto one corrupted row. campaign_id is
-- CARRIED on every adset row (so the §5e coarser-filter + finer-group case works) but
-- is never the row key.
--
-- STATUS (§2.1): effective_status = Meta's computed delivery state (ACTIVE / PAUSED /
-- CAMPAIGN_PAUSED / ADSET_PAUSED / ARCHIVED / DELETED / IN_PROCESS / WITH_ISSUES);
-- configured_status = what the operator set (the Graph `status` field). Both columns
-- are first-class so the engine can filter/label by on/off. The connector populates
-- them via a net-new /adsets edge read (§4a) + a /campaigns status backfill — the
-- columns are no longer NULL-by-construction (the Phase-1 gap on meta_ads_campaigns).
--
-- RACE TOLERANCE (§7a): the adset facts carry adset_id+campaign_id as PLAIN columns
-- with NO hard FK to meta_ads_adsets — mirroring the campaign topology (0015's
-- meta_ads_campaign_daily has no FK to meta_ads_campaigns). An insights-before-dim
-- sync therefore never fails a fact insert on a missing parent.
--
-- runMigrations() wraps every migration file in begin/commit, so this whole file
-- (tables + views + grants + registry seeds) runs atomically and is NOT wrapped here.

-- =====================================================================================
-- A. meta_ads_adsets (dim + status) — mirror 0030 meta_ads_campaigns at adset grain.
-- =====================================================================================
-- One row per adset, last-write-wins on re-sync. optimization_goal is per-adset, so the
-- §4b canonical-event mapping is EXACT at this grain (it keys on optimization_goal
-- first, then the campaign objective). currency is the account currency (load-bearing
-- for any future Stripe join); nullable because the account-currency read may not have
-- run on first ingest.
create table meta_ads_adsets (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  -- The parent campaign id, carried so adset rows can be filtered/grouped by campaign
  -- (the §5e coarser-filter case) and joined to campaign status. Plain column, not a
  -- hard FK (race-tolerant — the parent campaign dim may not be synced yet).
  campaign_id text not null,
  adset_id text not null,
  name text,
  -- Per-adset optimization goal (e.g. OFFSITE_CONVERSIONS, LEAD_GENERATION,
  -- LINK_CLICKS). The fine-grained driver of the §4b canonical-event mapping.
  optimization_goal text,
  -- Per-adset billing event (e.g. IMPRESSIONS, LINK_CLICKS). Provenance.
  billing_event text,
  -- Meta's COMPUTED delivery state (incl. inherited CAMPAIGN_PAUSED / ADSET_PAUSED).
  effective_status text,
  -- The operator-configured status (the Graph `status` field: ACTIVE/PAUSED/...).
  configured_status text,
  -- Account currency (ISO, lowercased to match Stripe). Nullable (carried via the
  -- campaign FK on the facts; the adset node itself does not echo a currency).
  currency text,
  updated_at_source timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ad_account_id, adset_id)
);

-- Worker ingests this dimension (insert/update on re-sync). A freshly created table is
-- NOT covered by 0006's apply-time blanket grant, so grant explicitly; guarded so the
-- migration applies on a fresh DB where the role may not exist yet (0030 pattern).
do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_adsets to growth_os_worker;
  end if;
end $$;

-- =====================================================================================
-- B. meta_ads_adset_daily (delivery fact) — mirror 0015 meta_ads_campaign_daily with
--    the 0032 column adds folded in, RE-KEYED on adset_id.
-- =====================================================================================
-- Grain = adset × day (carry campaign_id). The §2.2 columns (currency, inline_link_clicks,
-- landing_page_views, attribution_setting, actions_raw, api_version) are folded in at
-- create time rather than via a later alter. UNIQUE on (source_id, ad_account_id,
-- adset_id, occurred_on) — adset_id, not campaign_id (the #1 corruption fix). No hard FK
-- to meta_ads_adsets (race-tolerant; mirrors the campaign topology).
create table meta_ads_adset_daily (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  -- Carried parent campaign id (plain column; not the row key).
  campaign_id text not null,
  adset_id text not null,
  adset_name text,
  occurred_on date not null,
  spend numeric(18,6) not null default 0,
  clicks integer not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  cpm numeric(18,6),
  cpc numeric(18,6),
  ctr numeric(18,6),
  -- §2.2 attributes (mirror 0032 on the campaign delivery fact).
  currency text,
  inline_link_clicks bigint not null default 0,
  landing_page_views bigint not null default 0,
  attribution_setting text,
  actions_raw jsonb,
  api_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- RE-KEYED on adset_id (the #1 corruption fix — campaign_id is a carry, not the key).
  unique (source_id, ad_account_id, adset_id, occurred_on)
);

do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_adset_daily to growth_os_worker;
  end if;
end $$;

-- =====================================================================================
-- C. meta_ads_adset_conversions_daily (typed conversions) — mirror 0031 at adset grain.
-- =====================================================================================
-- Grain = adset × day × result_type (carry campaign_id). result_type NOT NULL (the
-- REQUIRED partition — never blend CPL across types). conversion_value is purchase-only
-- (NULL otherwise). UNIQUE adds adset_id + result_type. No hard FK (race-tolerant).
create table meta_ads_adset_conversions_daily (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  -- Carried parent campaign id (plain column; never derive campaign totals from these).
  campaign_id text not null,
  adset_id text not null,
  occurred_on date not null,
  -- The canonical conversion event type (lead/purchase/...). REQUIRED partition.
  result_type text not null,
  -- Additive count for this (adset, day, result_type).
  results numeric(18,6) not null default 0,
  -- Purchase-type ONLY (§2.3 guard); NULL for lead and other non-purchase types.
  conversion_value numeric(18,6),
  -- Provenance: the request's attribution windows (e.g. '1d_click,7d_click,1d_view').
  attribution_setting text,
  -- The adset optimization_goal's canonical headline result for this adset-day.
  is_primary boolean not null default false,
  -- 'derived_from_canonical_mapping' | 'meta_results' | 'meta_results_unverified_type'.
  results_source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- RE-KEYED on adset_id (+ result_type partition — the #1 corruption fix).
  unique (source_id, ad_account_id, adset_id, occurred_on, result_type)
);

do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_adset_conversions_daily to growth_os_worker;
  end if;
end $$;

-- =====================================================================================
-- D. vw_meta_ads_adset_daily — mirror 0033's vw_meta_ads_campaign_daily, IDENTICAL
--    column aliases (so the §5 resolver swaps only the view NAME). LEFT JOIN the dim
--    for status + carries campaign_id/adset_name as exposed dimensions.
-- =====================================================================================
-- Column aliases (spend as meta_ads_spend, inline_link_clicks as link_clicks, ...) are
-- byte-identical to the campaign delivery view so aggregateExpression/dimensionExpression
-- stay unchanged at adset grain. NET-NEW exposed dims vs the campaign view: adset_id,
-- adset_name, effective_status, configured_status (campaign_id is also exposed). The dim
-- LEFT JOIN supplies effective_status/configured_status (mirrors how 0034 LEFT JOINs the
-- dim for objective). drop-if-exists for re-runnability (0034 precedent).
drop view if exists queryable.vw_meta_ads_adset_daily cascade;
create view queryable.vw_meta_ads_adset_daily as
select
  d.workspace_id,
  d.source_id,
  d.ad_account_id,
  d.campaign_id,
  d.adset_id,
  d.adset_name,
  dim.effective_status,
  dim.configured_status,
  d.occurred_on,
  d.currency,
  d.spend as meta_ads_spend,
  d.clicks as meta_ads_clicks,
  d.inline_link_clicks as link_clicks,
  d.landing_page_views,
  d.impressions,
  d.reach,
  d.cpm,
  d.cpc,
  d.ctr
from meta_ads_adset_daily d
left join meta_ads_adsets dim
  on dim.source_id = d.source_id
  and dim.ad_account_id = d.ad_account_id
  and dim.adset_id = d.adset_id;

-- =====================================================================================
-- E. vw_meta_ads_adset_conversions_daily — mirror 0034's FINAL conversions view.
--    LEFT JOIN its OWN adset-grain spend (meta_ads_adset_daily on adset_id) — NEVER
--    campaign spend (joining campaign spend onto N adsets would N-count it).
-- =====================================================================================
-- Spend is co-resident at the ADSET grain so cost_per_result (spend/results) and roas
-- (value/spend) resolve in a single-view query. Safe to sum spend ONLY within a single
-- result_type (the REQUIRED partition; the engine refuses to sum across types). Aliases
-- identical to the campaign conversions view; exposes adset_id/adset_name/campaign_id +
-- effective_status/configured_status. drop-if-exists for re-runnability.
drop view if exists queryable.vw_meta_ads_adset_conversions_daily cascade;
create view queryable.vw_meta_ads_adset_conversions_daily as
select
  c.workspace_id,
  c.source_id,
  c.ad_account_id,
  c.campaign_id,
  c.adset_id,
  d.adset_name,
  dim.optimization_goal,
  dim.effective_status,
  dim.configured_status,
  c.occurred_on,
  c.result_type,
  c.results,
  c.conversion_value,
  -- Adset-grain delivery spend joined onto each result_type row. Sum ONLY within a
  -- single result_type — never across types (the engine refuses; double-counts spend).
  d.spend as meta_ads_spend,
  c.attribution_setting,
  c.is_primary,
  c.results_source
from meta_ads_adset_conversions_daily c
left join meta_ads_adset_daily d
  on d.source_id = c.source_id
  and d.ad_account_id = c.ad_account_id
  and d.adset_id = c.adset_id
  and d.occurred_on = c.occurred_on
left join meta_ads_adsets dim
  on dim.source_id = c.source_id
  and dim.ad_account_id = c.ad_account_id
  and dim.adset_id = c.adset_id;

-- =====================================================================================
-- F. Register the two new views in the queryable_views catalog (idempotent provenance).
-- =====================================================================================
-- This catalog is documentation/provenance and does NOT drive engine SQL — the live
-- wiring is the analytical-engine allowedDimensionsForView()/metricViewForGrain() +
-- runtime FIRST_PHASE_QUERYABLE_VIEWS (the Stage-1 §5 engine work). We still register so
-- describe/list_views surfaces the adset views with correct authority.
insert into queryable_views (
  id,
  view_name,
  description,
  row_grain,
  default_time_column,
  allowed_dimensions,
  allowed_measures,
  source_tables,
  freshness_target,
  caveats,
  drilldown_action
)
values
(
  'queryable.vw_meta_ads_adset_daily',
  'vw_meta_ads_adset_daily',
  'Meta Ads adset daily insights view (adset x day). Exposes on/off status (effective_status / configured_status) + the parent campaign_id as queryable dimensions. Spend/clicks/impressions are additive across adsets.',
  'adset/day',
  'occurred_on',
  '["ad_account_id","campaign_id","adset_id","adset_name","effective_status","configured_status","currency"]',
  '["meta_ads_spend","meta_ads_clicks","link_clicks","landing_page_views","impressions","reach","cpm","cpc","ctr"]',
  '["meta_ads_adset_daily","meta_ads_adsets"]',
  '24 hours',
  'read_only_marketing_api_reporting',
  'drilldown.meta_ads_adset_rows'
),
(
  'queryable.vw_meta_ads_adset_conversions_daily',
  'vw_meta_ads_adset_conversions_daily',
  'Meta Ads typed conversions view (adset x day x result_type), with the adset''s OWN-grain delivery spend joined in for cost_per_result / roas. result_type is a REQUIRED partition: results / cost_per_result / conversion_value / roas must never be blended across distinct result_types, and adset conversions must NEVER be summed up to campaign (Meta dedups only within an ad set). Exposes on/off status + the parent campaign_id. optimization_goal is the grain provenance for the canonical-event mapping.',
  'adset/day/result_type',
  'occurred_on',
  '["ad_account_id","campaign_id","adset_id","adset_name","result_type","is_primary","results_source","effective_status","configured_status"]',
  '["results","conversion_value","meta_ads_spend"]',
  '["meta_ads_adset_conversions_daily","meta_ads_adset_daily","meta_ads_adsets"]',
  '24 hours',
  'read_only_marketing_api_reporting; result_type_is_a_required_partition; cost_per_result_must_not_blend_across_result_types; adset_conversions_must_not_be_summed_to_campaign; conversion_value_in_account_currency',
  'drilldown.meta_ads_adset_conversion_rows'
)
on conflict (id) do update set
  view_name = excluded.view_name,
  description = excluded.description,
  row_grain = excluded.row_grain,
  default_time_column = excluded.default_time_column,
  allowed_dimensions = excluded.allowed_dimensions,
  allowed_measures = excluded.allowed_measures,
  source_tables = excluded.source_tables,
  freshness_target = excluded.freshness_target,
  caveats = excluded.caveats,
  drilldown_action = excluded.drilldown_action;

-- =====================================================================================
-- G. metric_definitions — EXPAND allowed_dimensions on the existing Meta metrics to
--    include adset_id/adset_name + effective_status/configured_status (NO new metric
--    IDs — §6). The §5 engine resolver swaps these metrics to the adset view by grain;
--    the seed is provenance only.
-- =====================================================================================
-- PARTITION = result_type ONLY at adset grain (DROP objective): there is no adset-level
-- objective; the REAL guard is the engine's result_type-only RESULT_TYPE_PARTITIONED_METRICS
-- Set, and optimization_goal is the grain provenance (recorded in the caveats text, not in
-- partition_by). Do NOT copy the campaign seed's two-element {result_type,objective}.
--
-- This update touches ONLY allowed_dimensions (+ required_filters for the conversion
-- metrics). All other columns (source_view, expression, ...) are intentionally left as
-- the campaign seed set them — the engine resolver, not source_view, picks the grain.
update metric_definitions
set allowed_dimensions =
  '["ad_account_id","campaign_id","adset_id","adset_name","result_type","effective_status","configured_status"]',
  required_filters = '{"partition_by":["result_type"]}'
where id in ('results', 'cost_per_result', 'conversion_value', 'roas');

update metric_definitions
set allowed_dimensions =
  '["ad_account_id","campaign_id","campaign_name","adset_id","adset_name","effective_status","configured_status"]'
where id in (
  'meta_ads_spend',
  'meta_ads_clicks',
  'impressions',
  'reach',
  'cpm',
  'cpc',
  'ctr',
  'link_clicks',
  'landing_page_views',
  'frequency'
);

-- =====================================================================================
-- H. Re-GRANT the two new views. Replicate 0016 line 204 EXACTLY: tool_agent + app ONLY
--    (NOT growth_os_read_api — the Meta views never had it).
-- =====================================================================================
grant select on queryable.vw_meta_ads_adset_daily, queryable.vw_meta_ads_adset_conversions_daily to growth_os_tool_agent, growth_os_app;
