-- Phase 2 slice-1b §2/§3 — the Meta Ads AD / CREATIVE grain (dim + delivery fact +
-- typed conversions + views + metric_definitions expansion). Mirrors the adset grain
-- (0035) one-to-one at AD grain, plus the creative_id lifecycle column. ALL READ-ONLY
-- (no ad-account mutations, no creative BODIES — open-core boundary; creative_id is the
-- creative{id} field-expansion only, never a creative body).
--
-- WHY A SEPARATE TABLE STACK (the §1 no-roll-up rule): Meta dedups conversions only
-- WITHIN an ad set, so ad-summed conversions can EXCEED the adset total. Spend and clicks
-- ARE additive; conversions/value are NOT. We therefore INGEST each grain AS META REPORTS
-- IT and never derive one grain from another — hence a parallel, independently-keyed ad
-- table stack rather than a roll-up of the adset/campaign facts.
--
-- THE #1 CORRUPTION FIX (§2.2/§4): the unique key on every ad fact is RE-KEYED on ad_id
-- (not campaign_id or adset_id). Reusing a coarser-keyed unique key at ad grain would
-- collapse every ad row of an adset onto one corrupted row. campaign_id AND adset_id are
-- CARRIED on every ad row (so the §5e coarser-filter + finer-group case works) but are
-- never part of the row key.
--
-- ORPHAN TOLERANCE (§2.1/§7a): adset_id is NULLABLE on the ad dim and the ad facts — an
-- ad can exist with no resolvable ad set (carry null without failing). campaign_id stays
-- NOT NULL (mirrors the adset dim). creative_id is NULLABLE (ad-with-no-creative; the
-- connector coalesces on upsert so a later null never wipes a previously-seen id).
--
-- optimization_goal IS DELIBERATELY ABSENT from this stack: it is an ADSET property. The
-- §4b conversion mapping carries it from the in-memory adset-dim map at connector time;
-- it is never denormalized onto the ad dim, and the ad conversions VIEW drops it from the
-- SELECT (§2.3) — even though the campaign/adset conversions views expose it.
--
-- RACE TOLERANCE (§7a): the ad facts carry adset_id+campaign_id as PLAIN columns with NO
-- hard FK to meta_ads_ads / meta_ads_adsets — mirroring the campaign/adset topology. An
-- insights-before-dim sync therefore never fails a fact insert on a missing parent.
--
-- runMigrations() wraps every migration file in begin/commit, so this whole file (tables +
-- views + grants + registry seeds) runs atomically and is NOT wrapped here.

-- =====================================================================================
-- A. meta_ads_ads (dim + status + creative_id) — mirror 0035 meta_ads_adsets at ad grain.
-- =====================================================================================
-- One row per ad, last-write-wins on re-sync. adset_id is NULLABLE (orphan tolerance —
-- ad-with-no-adset); creative_id is NULLABLE (ad-with-no-creative; coalesce on upsert).
-- optimization_goal is intentionally NOT here — it is an adset property carried in-memory
-- by the connector, never denormalized onto the ad dim.
create table meta_ads_ads (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  -- The parent campaign id, carried so ad rows can be filtered/grouped by campaign
  -- (the §5e coarser-filter case) and joined to campaign status. Plain column, not a
  -- hard FK (race-tolerant — the parent campaign dim may not be synced yet).
  campaign_id text not null,
  -- The parent adset id, carried. NULLABLE — orphan tolerance (§7a ad-with-no-adset).
  -- Plain column, not a hard FK (race-tolerant).
  adset_id text,
  ad_id text not null,
  name text,
  -- The creative id from the creative{id} field-expansion (creative?.id ?? null). NULLABLE
  -- (ad-with-no-creative); the connector coalesces on upsert so a later null never wipes a
  -- previously-seen id (freeze-on-disappearance lifecycle, §7). NO creative BODY is fetched.
  creative_id text,
  -- Meta's COMPUTED delivery state (incl. inherited CAMPAIGN_PAUSED / ADSET_PAUSED).
  effective_status text,
  -- The operator-configured status (the Graph `status` field: ACTIVE/PAUSED/...).
  configured_status text,
  updated_at_source timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ad_account_id, ad_id)
);

-- Worker ingests this dimension (insert/update on re-sync). A freshly created table is
-- NOT covered by 0006's apply-time blanket grant, so grant explicitly; guarded so the
-- migration applies on a fresh DB where the role may not exist yet (0030/0035 pattern).
do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_ads to growth_os_worker;
  end if;
end $$;

-- =====================================================================================
-- B. meta_ads_ad_daily (delivery fact) — mirror 0035 meta_ads_adset_daily, RE-KEYED on
--    ad_id, carrying campaign_id + adset_id as plain columns.
-- =====================================================================================
-- Grain = ad × day (carry campaign_id NOT NULL + adset_id NULLABLE). UNIQUE on
-- (source_id, ad_account_id, ad_id, occurred_on) — ad_id, not campaign_id/adset_id (the
-- #1 corruption fix). No hard FK to meta_ads_ads/meta_ads_adsets (race-tolerant).
create table meta_ads_ad_daily (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  -- Carried parent campaign id (plain column; not the row key).
  campaign_id text not null,
  -- Carried parent adset id (plain column; NULLABLE — orphan tolerance; not the row key).
  adset_id text,
  ad_id text not null,
  ad_name text,
  occurred_on date not null,
  spend numeric(18,6) not null default 0,
  clicks integer not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  cpm numeric(18,6),
  cpc numeric(18,6),
  ctr numeric(18,6),
  -- §2.2 attributes (mirror the adset delivery fact).
  currency text,
  inline_link_clicks bigint not null default 0,
  landing_page_views bigint not null default 0,
  attribution_setting text,
  actions_raw jsonb,
  api_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- RE-KEYED on ad_id (the #1 corruption fix — campaign_id/adset_id are carries, not key).
  unique (source_id, ad_account_id, ad_id, occurred_on)
);

do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_ad_daily to growth_os_worker;
  end if;
end $$;

-- =====================================================================================
-- C. meta_ads_ad_conversions_daily (typed conversions) — mirror 0035 at ad grain.
-- =====================================================================================
-- Grain = ad × day × result_type (carry campaign_id NOT NULL + adset_id NULLABLE).
-- result_type NOT NULL (the REQUIRED partition — never blend CPL across types).
-- conversion_value is purchase-only (NULL otherwise). UNIQUE adds ad_id + result_type.
-- No hard FK (race-tolerant). optimization_goal is NOT stored here (adset property).
create table meta_ads_ad_conversions_daily (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  -- Carried parent campaign id (plain column; never derive campaign totals from these).
  campaign_id text not null,
  -- Carried parent adset id (plain column; NULLABLE — orphan tolerance).
  adset_id text,
  ad_id text not null,
  occurred_on date not null,
  -- The canonical conversion event type (lead/purchase/...). REQUIRED partition.
  result_type text not null,
  -- Additive count for this (ad, day, result_type).
  results numeric(18,6) not null default 0,
  -- Purchase-type ONLY (§2.3 guard); NULL for lead and other non-purchase types.
  conversion_value numeric(18,6),
  -- Provenance: the request's attribution windows (e.g. '1d_click,7d_click,1d_view').
  attribution_setting text,
  -- The adset optimization_goal's canonical headline result for this ad-day.
  is_primary boolean not null default false,
  -- 'derived_from_canonical_mapping' | 'meta_results' | 'meta_results_unverified_type'.
  results_source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- RE-KEYED on ad_id (+ result_type partition — the #1 corruption fix).
  unique (source_id, ad_account_id, ad_id, occurred_on, result_type)
);

do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_ad_conversions_daily to growth_os_worker;
  end if;
end $$;

-- =====================================================================================
-- D. vw_meta_ads_ad_daily — mirror 0035's vw_meta_ads_adset_daily, IDENTICAL column
--    aliases (so the §5 resolver swaps only the view NAME). LEFT JOIN the dim for status +
--    carries campaign_id/adset_id/ad_name as exposed dimensions.
-- =====================================================================================
-- Column aliases (spend as meta_ads_spend, inline_link_clicks as link_clicks, ...) are
-- byte-identical to the campaign/adset delivery views so aggregateExpression/
-- dimensionExpression stay unchanged at ad grain. NET-NEW exposed dims vs the adset view:
-- ad_id, ad_name (campaign_id, adset_id, effective_status, configured_status are also
-- exposed). The dim LEFT JOIN supplies effective_status/configured_status.
-- drop-if-exists for re-runnability.
drop view if exists queryable.vw_meta_ads_ad_daily cascade;
create view queryable.vw_meta_ads_ad_daily as
select
  d.workspace_id,
  d.source_id,
  d.ad_account_id,
  d.campaign_id,
  d.adset_id,
  d.ad_id,
  d.ad_name,
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
from meta_ads_ad_daily d
left join meta_ads_ads dim
  on dim.source_id = d.source_id
  and dim.ad_account_id = d.ad_account_id
  and dim.ad_id = d.ad_id;

-- =====================================================================================
-- E. vw_meta_ads_ad_conversions_daily — mirror 0035's adset conversions view at ad grain.
--    LEFT JOIN its OWN ad-grain spend (meta_ads_ad_daily on ad_id) — NEVER campaign/adset
--    spend (joining coarser spend onto N ads would N-count it). DROPS optimization_goal
--    from the SELECT (§2.3 — it is an adset property, never on the ad dim).
-- =====================================================================================
-- Spend is co-resident at the AD grain so cost_per_result (spend/results) and roas
-- (value/spend) resolve in a single-view query. Safe to sum spend ONLY within a single
-- result_type (the REQUIRED partition; the engine refuses to sum across types). Aliases
-- identical to the campaign/adset conversions views; exposes ad_id/ad_name/adset_id/
-- campaign_id + effective_status/configured_status. NO optimization_goal. drop-if-exists.
drop view if exists queryable.vw_meta_ads_ad_conversions_daily cascade;
create view queryable.vw_meta_ads_ad_conversions_daily as
select
  c.workspace_id,
  c.source_id,
  c.ad_account_id,
  c.campaign_id,
  c.adset_id,
  c.ad_id,
  d.ad_name,
  dim.effective_status,
  dim.configured_status,
  c.occurred_on,
  c.result_type,
  c.results,
  c.conversion_value,
  -- Ad-grain delivery spend joined onto each result_type row. Sum ONLY within a single
  -- result_type — never across types (the engine refuses; double-counts spend).
  d.spend as meta_ads_spend,
  c.attribution_setting,
  c.is_primary,
  c.results_source
from meta_ads_ad_conversions_daily c
left join meta_ads_ad_daily d
  on d.source_id = c.source_id
  and d.ad_account_id = c.ad_account_id
  and d.ad_id = c.ad_id
  and d.occurred_on = c.occurred_on
left join meta_ads_ads dim
  on dim.source_id = c.source_id
  and dim.ad_account_id = c.ad_account_id
  and dim.ad_id = c.ad_id;

-- =====================================================================================
-- F. Register the two new views in the queryable_views catalog (idempotent provenance).
-- =====================================================================================
-- This catalog is documentation/provenance and does NOT drive engine SQL — the live
-- wiring is the analytical-engine allowedDimensionsForView()/metricViewForGrain() +
-- runtime FIRST_PHASE_QUERYABLE_VIEWS (the Stage-1 §5 engine work). We still register so
-- describe/list_views surfaces the ad views with correct authority.
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
  'queryable.vw_meta_ads_ad_daily',
  'vw_meta_ads_ad_daily',
  'Meta Ads ad daily insights view (ad x day). Exposes on/off status (effective_status / configured_status) + the parent adset_id/campaign_id as queryable dimensions. Spend/clicks/impressions are additive across ads.',
  'ad/day',
  'occurred_on',
  '["ad_account_id","campaign_id","adset_id","ad_id","ad_name","effective_status","configured_status","currency"]',
  '["meta_ads_spend","meta_ads_clicks","link_clicks","landing_page_views","impressions","reach","cpm","cpc","ctr"]',
  '["meta_ads_ad_daily","meta_ads_ads"]',
  '24 hours',
  'read_only_marketing_api_reporting',
  'drilldown.meta_ads_ad_rows'
),
(
  'queryable.vw_meta_ads_ad_conversions_daily',
  'vw_meta_ads_ad_conversions_daily',
  'Meta Ads typed conversions view (ad x day x result_type), with the ad''s OWN-grain delivery spend joined in for cost_per_result / roas. result_type is a REQUIRED partition: results / cost_per_result / conversion_value / roas must never be blended across distinct result_types, and ad conversions must NEVER be summed up to adset or campaign (Meta dedups only within an ad set). Exposes on/off status + the parent adset_id/campaign_id. optimization_goal is an ADSET property and is intentionally NOT exposed here.',
  'ad/day/result_type',
  'occurred_on',
  '["ad_account_id","campaign_id","adset_id","ad_id","ad_name","result_type","is_primary","results_source","effective_status","configured_status"]',
  '["results","conversion_value","meta_ads_spend"]',
  '["meta_ads_ad_conversions_daily","meta_ads_ad_daily","meta_ads_ads"]',
  '24 hours',
  'read_only_marketing_api_reporting; result_type_is_a_required_partition; cost_per_result_must_not_blend_across_result_types; ad_conversions_must_not_be_summed_to_adset_or_campaign; conversion_value_in_account_currency',
  'drilldown.meta_ads_ad_conversion_rows'
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
--    include ad_id/ad_name (+ the carried adset/campaign dims + status). NO new metric
--    IDs (§6). The §5 engine resolver swaps these metrics to the ad view by grain; the
--    seed is provenance only.
-- =====================================================================================
-- PARTITION = result_type ONLY at ad grain (NO objective — there is no ad-level objective;
-- the REAL guard is the engine's result_type-only RESULT_TYPE_PARTITIONED_METRICS Set).
-- This update touches ONLY allowed_dimensions (+ required_filters for the conversion
-- metrics). All other columns are intentionally left as the campaign/adset seed set them —
-- the engine resolver, not source_view, picks the grain.
update metric_definitions
set allowed_dimensions =
  '["ad_account_id","campaign_id","adset_id","adset_name","ad_id","ad_name","result_type","effective_status","configured_status"]',
  required_filters = '{"partition_by":["result_type"]}'
where id in ('results', 'cost_per_result', 'conversion_value', 'roas');

update metric_definitions
set allowed_dimensions =
  '["ad_account_id","campaign_id","campaign_name","adset_id","adset_name","ad_id","ad_name","effective_status","configured_status"]'
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
grant select on queryable.vw_meta_ads_ad_daily, queryable.vw_meta_ads_ad_conversions_daily to growth_os_tool_agent, growth_os_app;
