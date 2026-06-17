-- Phase 0 — register the already-stored Meta Ads campaign-daily columns
-- (impressions, reach, cpm, cpc, ctr) in the metric_definitions catalog so
-- describe_metric / list_metrics / search_context return full authority +
-- provenance metadata for them — closing the catalog gap where the analytical
-- engine routed/aggregated these metrics but the DB catalog had no rows for them.
--
-- These mirror EXACTLY how meta_ads_spend / meta_ads_clicks are seeded in
-- 0016_shopify_meta_ads_queryable_views.sql: same source_view
-- (queryable.vw_meta_ads_campaign_daily), same allowed_dimensions, same
-- read-only marketing-api authority. The columns + view already exist (added in
-- 0015/0016) — this migration is a purely additive, idempotent catalog seed.
--
-- Aggregation correctness is LOAD-BEARING and matches
-- aggregateExpression()/caveatsForMetric() in packages/analytical-engine:
--   impressions -> sum(impressions)                                  (additive)
--   reach       -> sum(reach)  flagged APPROXIMATE (summing daily reach
--                  overcounts unique people; never claim exact unique reach)
--   cpm         -> sum(meta_ads_spend) / nullif(sum(impressions),0) * 1000
--   cpc         -> sum(meta_ads_spend) / nullif(sum(meta_ads_clicks),0)
--   ctr         -> sum(meta_ads_clicks) / nullif(sum(impressions),0)
-- The ratio metrics are RECOMPUTED from summed bases, never avg(per-row ratio),
-- and carry the ratio_recomputed_from_summed_bases caveat.

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
  caveats,
  examples
)
values
(
  'impressions',
  'Meta Ads impressions',
  'Daily Meta Ads impressions from campaign insights',
  '["facebook ads impressions","instagram ads impressions","meta impressions","ad impressions"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_daily","column":"impressions","aggregate":"sum"}',
  'count',
  'impressions',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_marketing_api_reporting',
  '["How many Meta Ads impressions did we get last week?"]'
),
(
  'reach',
  'Meta Ads reach (approximate)',
  'Daily Meta Ads reach from campaign insights, summed across the campaign×day grain. APPROXIMATE: summing daily reach overcounts unique people (someone reached on two days is counted twice) — do NOT claim exact de-duplicated unique reach.',
  '["facebook ads reach","instagram ads reach","meta reach","unique reach"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_daily","column":"reach","aggregate":"sum"}',
  'count',
  'people (approximate)',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_marketing_api_reporting; reach_is_approximate_summed_daily_reach_overcounts_unique_people',
  '["What was our approximate Meta Ads reach this month?"]'
),
(
  'cpm',
  'Meta Ads CPM',
  'Meta Ads cost per 1,000 impressions, RECOMPUTED from summed bases over the campaign×day grain: sum(meta_ads_spend) / nullif(sum(impressions),0) * 1000. Never averaged from per-row cpm (avg-of-ratios would weight every campaign-day equally regardless of impression volume, which is arithmetically wrong).',
  '["cost per mille","cost per thousand impressions","meta cpm","facebook cpm"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_daily","numerator":"sum(meta_ads_spend)","denominator":"sum(impressions)","multiplier":1000,"zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'major_currency_unit per 1000 impressions',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases',
  '["What is our Meta Ads CPM this month?"]'
),
(
  'cpc',
  'Meta Ads CPC',
  'Meta Ads cost per click, RECOMPUTED from summed bases over the campaign×day grain: sum(meta_ads_spend) / nullif(sum(meta_ads_clicks),0). Never averaged from per-row cpc (avg-of-ratios would weight every campaign-day equally regardless of click volume, which is arithmetically wrong).',
  '["cost per click","meta cpc","facebook cpc","instagram cpc"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_daily","numerator":"sum(meta_ads_spend)","denominator":"sum(meta_ads_clicks)","zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'major_currency_unit per click',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases',
  '["What is our Meta Ads cost per click this month?"]'
),
(
  'ctr',
  'Meta Ads CTR',
  'Meta Ads click-through rate, RECOMPUTED from summed bases over the campaign×day grain: sum(meta_ads_clicks) / nullif(sum(impressions),0). Never averaged from per-row ctr (avg-of-ratios would weight every campaign-day equally regardless of impression volume, which is arithmetically wrong).',
  '["click through rate","click-through rate","meta ctr","facebook ctr"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_daily","numerator":"sum(meta_ads_clicks)","denominator":"sum(impressions)","zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'fraction (0..1)',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases',
  '["What is our Meta Ads click-through rate this month?"]'
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
  caveats = excluded.caveats,
  examples = excluded.examples;
