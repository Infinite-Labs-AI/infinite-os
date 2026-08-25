-- Phase 1 §3.4 + §3.5 — recreate the delivery view with the new §2.2 columns, add a
-- new typed-conversions view over the §2.3 child fact, re-register both in the
-- queryable_views catalog, re-GRANT them, and seed metric_definitions for the new
-- Phase-1 metrics.
--
-- §3.4 FOOT-GUN: `create or replace view` CANNOT add or retype columns mid-list, so
-- the delivery view must be `drop view ... cascade` then recreated. The 0024 GA4 view
-- recreate is the precedent (drop-if-exists + recreate + re-seed registries + re-grant,
-- all idempotent). After the DROP CASCADE the GRANT must be replicated EXACTLY as
-- 0016 line 204 (`to growth_os_tool_agent, growth_os_app` — NOT growth_os_read_api;
-- the Meta view never had read_api, unlike the 0027 GA4 views).
--
-- THE READ PATH IS A DUAL-WRITE: a metric seeded here is INERT until it is also added
-- to runtime FIRST_PHASE_METRICS / FIRST_PHASE_QUERYABLE_VIEWS and given branches in
-- the analytical-engine switch-functions. Those code edits are a Stage 2 concern;
-- this migration only lands the catalog metadata + the views. The metric_definitions
-- rows are documentation/provenance and do NOT drive engine SQL.
--
-- §3.5 REQUIRED PARTITION: result_type + objective must be a REQUIRED partition for the
-- conversion metrics, not merely an allowed dimension. metric_definitions has no
-- native required-partition column for view dimensions, so we encode it in the
-- existing-but-unused required_filters jsonb column (0005:16, default '{}') as
-- {"partition_by":["result_type","objective"]}. The actual aggregate-refusal guard is
-- enforced in the engine TS (Stage 2); this seed records the contract.
--
-- runMigrations() wraps every migration file in begin/commit, so this file is not
-- wrapped again here. The DROP CASCADE + recreate + re-grant + re-register all run
-- atomically in this file's single implicit transaction.

-- 1. Recreate the delivery view exposing the §2.2 columns. DROP ... CASCADE because
--    we are adding columns mid-list (currency/inline_link_clicks/landing_page_views).
drop view if exists queryable.vw_meta_ads_campaign_daily cascade;
create view queryable.vw_meta_ads_campaign_daily as
select
  workspace_id,
  source_id,
  ad_account_id,
  campaign_id,
  campaign_name,
  occurred_on,
  currency,
  spend as meta_ads_spend,
  clicks as meta_ads_clicks,
  inline_link_clicks as link_clicks,
  landing_page_views,
  impressions,
  reach,
  cpm,
  cpc,
  ctr
from meta_ads_campaign_daily;

-- 2. New typed-conversions view over the §2.3 child fact. result_type is a column
--    (the REQUIRED partition); results/conversion_value are the additive measures.
create view queryable.vw_meta_ads_campaign_conversions_daily as
select
  workspace_id,
  source_id,
  ad_account_id,
  campaign_id,
  occurred_on,
  result_type,
  results,
  conversion_value,
  attribution_setting,
  is_primary,
  results_source
from meta_ads_campaign_conversions_daily;

-- 3. Re-register / register both views in the queryable_views catalog (idempotent).
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
  'queryable.vw_meta_ads_campaign_daily',
  'vw_meta_ads_campaign_daily',
  'Meta Ads campaign daily insights view',
  'campaign/day',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name","currency"]',
  '["meta_ads_spend","meta_ads_clicks","link_clicks","landing_page_views","impressions","reach","cpm","cpc","ctr"]',
  '["meta_ads_campaign_daily"]',
  '24 hours',
  'read_only_marketing_api_reporting',
  'drilldown.meta_ads_campaign_rows'
),
(
  'queryable.vw_meta_ads_campaign_conversions_daily',
  'vw_meta_ads_campaign_conversions_daily',
  'Meta Ads typed conversions view (campaign x day x result_type). result_type is a REQUIRED partition: results / cost_per_result / conversion_value / roas must never be blended across distinct result_types.',
  'campaign/day/result_type',
  'occurred_on',
  '["ad_account_id","campaign_id","result_type","is_primary","results_source"]',
  '["results","conversion_value"]',
  '["meta_ads_campaign_conversions_daily"]',
  '24 hours',
  'read_only_marketing_api_reporting; result_type_is_a_required_partition; cost_per_result_must_not_blend_across_result_types; conversion_value_in_account_currency',
  'drilldown.meta_ads_campaign_conversion_rows'
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

-- 4. §3.5 metric_definitions seeds (mirror 0029). Catalog metadata + provenance ONLY
--    — the analytical engine hard-codes the matching aggregate/caveat logic (Stage 2).
--    result_type + objective are recorded as a REQUIRED partition via required_filters.
--    Aggregation correctness (load-bearing parity with the Stage-2 engine functions):
--      results            -> sum(results)                                    (additive)
--      conversion_value   -> sum(conversion_value)                           (additive, purchase-only)
--      cost_per_result    -> sum(meta_ads_spend) / nullif(sum(results),0)    (recompute from summed bases)
--      roas               -> sum(conversion_value) / nullif(sum(meta_ads_spend),0) (recompute; NULL for lead-gen)
--      link_clicks        -> sum(link_clicks)                                (additive)
--      landing_page_views -> sum(landing_page_views)                         (additive, NON-omni)
--    Ratios are RECOMPUTED from summed bases PARTITIONED by result_type — never
--    avg(per-row ratio), never blended across result_types.
insert into metric_definitions (
  id,
  name,
  description,
  aliases,
  source_view,
  expression,
  metric_type,
  unit,
  aggregation,
  default_time_column,
  allowed_dimensions,
  required_filters,
  caveats,
  examples
)
values
(
  'results',
  'Meta Ads results (typed conversions)',
  'Meta Ads conversion results from the typed conversions fact, partitioned by result_type (lead, purchase, etc.). A results number is meaningless without its result_type — never blend across types.',
  '["conversions","meta results","conversion count","leads","purchases"]',
  'queryable.vw_meta_ads_campaign_conversions_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_conversions_daily","column":"results","aggregate":"sum"}',
  'count',
  'results',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","result_type"]',
  '{"partition_by":["result_type","objective"]}',
  'read_only_marketing_api_reporting; result_type_is_a_required_partition; cost_per_result_must_not_blend_across_result_types',
  '["How many leads did our Meta campaigns generate last week, by result type?"]'
),
(
  'cost_per_result',
  'Meta Ads cost per result (CPL / CPA)',
  'Meta Ads cost per result, RECOMPUTED from summed bases over the campaign x day grain PARTITIONED by result_type: sum(meta_ads_spend) / nullif(sum(results),0). Never averaged from per-row cost_per_result, and NEVER blended across result_types (CPL and CPA are different types and must not be mixed).',
  '["cpl","cpa","cost per lead","cost per acquisition","cost per conversion","cost per result"]',
  'queryable.vw_meta_ads_campaign_conversions_daily',
  '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_conversions_daily","numerator":"sum(meta_ads_spend)","denominator":"sum(results)","zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'major_currency_unit per result',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","result_type"]',
  '{"partition_by":["result_type","objective"]}',
  'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases; cost_per_result_must_not_blend_across_result_types; value_in_account_currency',
  '["What was our cost per lead on Meta last month?"]'
),
(
  'conversion_value',
  'Meta Ads conversion value (purchase-only)',
  'Meta Ads conversion value from the SAME pixel channel as the purchase count (offsite_conversion.fb_pixel_purchase + its action_value). Populated ONLY for purchase-type results — a configured lead value is NOT revenue. In the ad-account currency.',
  '["purchase value","conversion value","meta revenue","pixel purchase value"]',
  'queryable.vw_meta_ads_campaign_conversions_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_conversions_daily","column":"conversion_value","aggregate":"sum"}',
  'currency',
  'major_currency_unit',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","result_type"]',
  '{"partition_by":["result_type","objective"]}',
  'read_only_marketing_api_reporting; result_type_is_a_required_partition; conversion_value_purchase_only; value_in_account_currency',
  '["How much purchase value did Meta attribute last week?"]'
),
(
  'roas',
  'Meta Ads ROAS (return on ad spend)',
  'Meta Ads return on ad spend, RECOMPUTED from summed bases: sum(conversion_value) / nullif(sum(meta_ads_spend),0). NULL for lead-gen campaigns (no Meta revenue). Browser/pixel-attributed floor in the account currency; never averaged from per-row roas, never blended across result_types.',
  '["roas","return on ad spend","meta roas","purchase roas"]',
  'queryable.vw_meta_ads_campaign_conversions_daily',
  '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_conversions_daily","numerator":"sum(conversion_value)","denominator":"sum(meta_ads_spend)","zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'ratio (value per spend, account currency)',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","result_type"]',
  '{"partition_by":["result_type","objective"]}',
  'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases; cost_per_result_must_not_blend_across_result_types; value_in_account_currency',
  '["What is our Meta ROAS on the purchase campaigns this month?"]'
),
(
  'link_clicks',
  'Meta Ads link clicks',
  'Daily Meta Ads inline link clicks from campaign insights (distinct from total clicks).',
  '["link clicks","inline link clicks","meta link clicks","facebook link clicks"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_daily","column":"link_clicks","aggregate":"sum"}',
  'count',
  'clicks',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  '{}',
  'read_only_marketing_api_reporting',
  '["How many link clicks did our Meta ads get last week?"]'
),
(
  'landing_page_views',
  'Meta Ads landing page views',
  'Daily Meta Ads landing page views from actions[action_type=landing_page_view], NON-omni (the omni_landing_page_view variant is a broader, different population and is excluded).',
  '["landing page views","lpv","meta landing page views"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_daily","column":"landing_page_views","aggregate":"sum"}',
  'count',
  'views',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  '{}',
  'read_only_marketing_api_reporting; landing_page_views_non_omni',
  '["How many landing page views did Meta drive this month?"]'
)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  aliases = excluded.aliases,
  source_view = excluded.source_view,
  expression = excluded.expression,
  metric_type = excluded.metric_type,
  unit = excluded.unit,
  aggregation = excluded.aggregation,
  default_time_column = excluded.default_time_column,
  allowed_dimensions = excluded.allowed_dimensions,
  required_filters = excluded.required_filters,
  caveats = excluded.caveats,
  examples = excluded.examples;

-- 5. Re-GRANT the recreated + new views. Replicate 0016 line 204 EXACTLY:
--    tool_agent + app ONLY (NOT growth_os_read_api — the Meta view never had it).
grant select on queryable.vw_meta_ads_campaign_daily, queryable.vw_meta_ads_campaign_conversions_daily to growth_os_tool_agent, growth_os_app;
