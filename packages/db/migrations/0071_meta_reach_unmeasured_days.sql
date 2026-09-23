-- Reach / frequency over windows that contain UNMEASURED reach (catalog metadata only).
--
-- 0070 made reach nullable: missing provider reach is unknown, not measured zero. The hot open-day
-- lane stores exactly such rows — campaign and ad set rows derived by summing ad insights
-- (actions_raw.derivation.method = 'sum_of_ad_insights') carry reach = NULL, because reach is not
-- additive across ads. Against those rows the 0029/0034 definitions misread any window that
-- includes today: sum(reach) silently skips the day (LOW), and sum(impressions)/sum(reach) divided
-- that day's impressions by nobody (HIGH).
--
-- The analytical engine hard-codes the aggregate/caveat logic (aggregateExpression +
-- unmeasuredReachCaveats); this keeps the catalog it publishes in parity:
--   reach     -> sum(reach) over MEASURED rows; flagged reach_excludes_unmeasured_days whenever
--                the queried scope held an unmeasured row.
--   frequency -> sum(impressions) filter (where reach is not null) / nullif(sum(reach), 0): both
--                bases over the same measured rows; same flag.
update metric_definitions
   set description = 'Daily Meta Ads reach from campaign insights, summed across the campaign×day grain. APPROXIMATE: summing daily reach overcounts unique people (someone reached on two days is counted twice) — do NOT claim exact de-duplicated unique reach. MEASURED DAYS ONLY: a row whose reach Meta has not measured (the open day, derived from ad insights) is NULL and excluded, and the answer is flagged reach_excludes_unmeasured_days — never presented as the whole window.',
       caveats = 'read_only_marketing_api_reporting; reach_is_approximate_summed_daily_reach_overcounts_unique_people; reach_excludes_unmeasured_days_when_flagged'
 where id = 'reach';

update metric_definitions
   set description = 'Meta Ads frequency, RECOMPUTED from summed bases over the rows whose reach was MEASURED: sum(impressions) filter (where reach is not null) / nullif(sum(reach),0). Rows with unmeasured (NULL) reach — the open day, derived from ad insights — are excluded from BOTH bases and the answer is flagged reach_excludes_unmeasured_days. Inherits reach''s APPROXIMATE caveat (summing daily reach overcounts unique people, so the denominator is approximate). Never averaged from per-row frequency.',
       expression = '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_daily","numerator":"sum(impressions) filter (where reach is not null)","denominator":"sum(reach)","zeroDenominator":"null","recompute":"from_summed_bases"}',
       caveats = 'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases; reach_is_approximate_summed_daily_reach_overcounts_unique_people; reach_excludes_unmeasured_days_when_flagged'
 where id = 'frequency';
