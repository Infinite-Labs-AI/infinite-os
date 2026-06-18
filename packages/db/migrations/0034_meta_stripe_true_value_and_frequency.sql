-- Phase 1 §5 (Meta<->Stripe true-value / ROAS join) + §6 finishing seeds (frequency,
-- roas_from_stripe). All READ-only: a mapping table + derived views over existing truth
-- tables, plus catalog metadata. ZERO ad-account mutations (open-core boundary).
--
-- WHY THIS MIGRATION DOES THREE THINGS:
--   1. The typed-conversions view (0033) carries results/conversion_value but NOT spend, so
--      the §6 ratio metrics cost_per_result (spend/results) and roas (value/spend) had no
--      spend column to divide by in a single-view query. The engine builds SQL as
--      `select <expr> from <one view>` — it never joins two views — so spend MUST be
--      co-resident with the conversion bases. We recreate the conversions view to LEFT JOIN
--      the delivery fact's spend in at the campaign x day grain. Spend is repeated across a
--      campaign-day's result_type rows; that is CORRECT only because result_type is a
--      REQUIRED partition (the engine refuses to sum across types — see analytical-engine
--      runAggregate / requiresResultTypePartition), so spend is never double-counted.
--   2. The Meta<->Stripe true-value mapping table + join view (§5): for lead-gen there is no
--      Meta revenue, so ROI = the Stripe join. Keyed on campaign_id (immutable; campaign_name
--      is display-only so renames don't break attribution), with a normalized key
--      (lower/trim/strip-emoji) and a match_confidence enum (exact|normalized|fuzzy|
--      unmatched). The view reconciles currency BEFORE dividing and surfaces unmatched spend
--      and unmatched revenue totals so a thin match never masquerades as a confident ROAS.
--   3. The remaining §6 metric_definitions seeds (frequency on the delivery view;
--      roas_from_stripe on the join view), mirroring the 0029/0033 seed shape.
--
-- FOOT-GUNS replicated from 0033/0016:
--   * `create or replace view` CANNOT add columns mid-list -> the conversions view is
--     `drop view ... cascade` then recreated (the 0024 GA4 precedent). The view's grant +
--     queryable_views registry row are re-applied idempotently after the recreate.
--   * GRANT MUST match 0016 EXACTLY: `to growth_os_tool_agent, growth_os_app` — NOT
--     growth_os_read_api (the Meta views never had read_api, unlike the 0027 GA4 views).
--   * runMigrations() wraps every migration file in begin/commit; this file is NOT wrapped
--     again. The whole DROP CASCADE + recreate + new table/view + grants + registry re-seed
--     run atomically in this file's single implicit transaction.
--
-- CURRENCY RECONCILIATION (the headline §5 gotcha): Stripe revenue (recognized_revenue) is
-- bigint MINOR units (cents); Meta spend is numeric(18,6) MAJOR units (dollars). We convert
-- Stripe revenue to MAJOR units (/100.0) before dividing, and we ONLY match revenue whose
-- per-invoice currency equals the campaign's account currency (meta_ads_campaigns.currency,
-- lowercased to match Stripe's lowercase currency text). There is NO FX table in the repo,
-- so cross-currency rows are deliberately treated as UNMATCHED rather than silently summed
-- across currencies. Both sides are normalized to lowercase ISO codes.

-- 1. Recreate the typed-conversions view to carry spend (for cost_per_result/roas) plus the
--    display name + coarse objective. DROP ... CASCADE because we are adding columns mid-list.
drop view if exists queryable.vw_meta_ads_campaign_conversions_daily cascade;
create view queryable.vw_meta_ads_campaign_conversions_daily as
select
  c.workspace_id,
  c.source_id,
  c.ad_account_id,
  c.campaign_id,
  d.campaign_name,
  dim.objective,
  c.occurred_on,
  c.result_type,
  c.results,
  c.conversion_value,
  -- Delivery-fact spend at the campaign x day grain, joined onto each result_type row. Safe
  -- to sum ONLY within a single result_type (the REQUIRED partition); summing across types
  -- double-counts spend, which the engine refuses to do.
  d.spend as meta_ads_spend,
  c.attribution_setting,
  c.is_primary,
  c.results_source
from meta_ads_campaign_conversions_daily c
left join meta_ads_campaign_daily d
  on d.source_id = c.source_id
  and d.ad_account_id = c.ad_account_id
  and d.campaign_id = c.campaign_id
  and d.occurred_on = c.occurred_on
left join meta_ads_campaigns dim
  on dim.source_id = c.source_id
  and dim.ad_account_id = c.ad_account_id
  and dim.campaign_id = c.campaign_id;

-- 2. The Meta<->Stripe campaign<->revenue mapping table (§5). Keyed on the IMMUTABLE
--    campaign_id. normalized_name is the lower/trim/emoji-stripped campaign name, used only
--    as a fallback match key (campaign_name itself is display-only). match_confidence records
--    HOW the campaign was tied to revenue. This table is the place an explicit operator
--    mapping (or a future GA4/PostHog bridge) is recorded; until populated, the join view
--    derives an account-currency-level match from the warehouse and labels everything
--    'unmatched' at the campaign grain (honest: there is no campaign key on Stripe rows).
create table meta_ads_campaign_revenue_map (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  ad_account_id text not null,
  -- Immutable join key. Renames of campaign_name never break attribution.
  campaign_id text not null,
  -- lower(trim(campaign_name)) with emoji/symbol code points stripped. Fallback key only.
  normalized_name text,
  -- exact     : an explicit operator-confirmed campaign<->revenue mapping.
  -- normalized: matched via the normalized_name key.
  -- fuzzy     : matched via a looser heuristic (e.g. token overlap).
  -- unmatched : no confident campaign<->revenue link (spend present, revenue unattributed).
  match_confidence text not null default 'unmatched'
    check (match_confidence in ('exact', 'normalized', 'fuzzy', 'unmatched')),
  -- The Stripe source the revenue is attributed to (nullable for unmatched rows).
  revenue_source_id text references sources(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ad_account_id, campaign_id)
);

-- Worker writes the mapping (insert/update on re-sync). Guarded so the migration applies on
-- a fresh DB where the role may not exist yet (0028 pattern).
do $$
begin
  if exists (select from pg_roles where rolname = 'growth_os_worker') then
    grant select, insert, update on meta_ads_campaign_revenue_map to growth_os_worker;
  end if;
end $$;

-- 3. The Meta<->Stripe true-value join view (§5). Rows carry:
--      * matched_spend_major   — Meta spend (major units) for matched campaigns.
--      * matched_revenue_major — Stripe revenue (converted cents -> major units) attributed
--                                to the campaign AT THE RECONCILED CURRENCY.
--      * match_confidence      — the join-quality signal.
--      * unmatched_spend_major / unmatched_revenue_major — surfaced so a thin match never
--        masquerades as a confident number. roas_from_stripe (the engine ratio) divides the
--        summed matched_revenue_major by the summed matched_spend_major.
--    Currency is the campaign's account currency (lowercased). Revenue is matched ONLY when
--    the Stripe per-invoice currency equals that account currency (no FX table -> no
--    cross-currency summation); mismatched-currency revenue lands in unmatched_revenue_major.
--
-- TWO SHAPES OF ROW (union):
--   A. campaign rows (campaign_id NOT NULL) — one per campaign x day, carrying that campaign's
--      spend (matched or unmatched) plus matched_revenue when the campaign is mapped.
--   B. unmatched-revenue rows (campaign_id NULL) — one per UNMAPPED Stripe revenue-source x day.
--      Revenue from a Stripe source that is NOT mapped to ANY campaign can NEVER be matched
--      (there is nothing to attribute it to), so it MUST surface as unmatched_revenue — a
--      join-quality signal (§5). Without these synthetic rows unmatched_revenue is STRUCTURALLY
--      unreachable (always 0): revenue only ever entered the view through the mapped branch.
--      These rows mirror how an unmapped CAMPAIGN surfaces unmatched_spend, just on the revenue
--      axis — there is simply no campaign key to hang the unmatched revenue on.
--
-- COARSE-BY-DESIGN OVER-ATTRIBUTION CAVEAT (the §5 honesty rule): the map links a whole Stripe
-- SOURCE to a campaign, and matched_revenue sums the ENTIRE source-day revenue for that source.
-- If a mapped source's day also contains revenue from invoices UNRELATED to the campaign (e.g. a
-- separate product line billed through the same Stripe account), that revenue is over-credited to
-- the campaign — matched_revenue is an UPPER BOUND, not a per-order attribution. Per-order/UTM
-- attribution is explicitly OUT of Phase-1 scope; the view instead stays HONEST in two ways:
--   (1) it never MULTIPLY-counts a source-day across co-mapped campaigns (single-representative
--       pick below), so the account-level total is at least internally consistent; and
--   (2) the over-attribution is made loud via the view's
--       stripe_revenue_is_source_level_may_over_attribute caveat + the roas_from_stripe
--       metric_definition caveat, so the number is never read as a precise per-campaign ROAS.
create view queryable.vw_meta_stripe_campaign_value_daily as
with spend as (
  select
    d.workspace_id,
    d.source_id,
    d.ad_account_id,
    d.campaign_id,
    d.campaign_name,
    d.occurred_on,
    -- Account currency for this row: prefer the dimension's currency, fall back to the
    -- delivery row's currency. Lowercased to match Stripe's lowercase currency text.
    lower(coalesce(dim.currency, d.currency)) as account_currency,
    d.spend as spend_major,
    m.campaign_id is not null and m.match_confidence <> 'unmatched' as is_mapped,
    coalesce(m.match_confidence, 'unmatched') as match_confidence,
    m.revenue_source_id
  from meta_ads_campaign_daily d
  left join meta_ads_campaigns dim
    on dim.source_id = d.source_id
    and dim.ad_account_id = d.ad_account_id
    and dim.campaign_id = d.campaign_id
  left join meta_ads_campaign_revenue_map m
    on m.source_id = d.source_id
    and m.ad_account_id = d.ad_account_id
    and m.campaign_id = d.campaign_id
),
-- Revenue attributed via the mapping, reconciled to the account currency BEFORE it is divided.
-- Only same-currency revenue is matched (no FX); cents -> major via /100.0.
--
-- DOUBLE-COUNT GUARD (the load-bearing §5 correctness rule): vw_revenue_by_source has NO
-- campaign key, so a single Stripe revenue_source_id maps to N campaigns is the NORMAL
-- topology. If we joined the source-day revenue onto EVERY co-mapped campaign, an account-level
-- roas_from_stripe (which sums matched_revenue_major across campaigns) would count that day's
-- revenue N times and inflate ROAS ~N-fold. Instead we:
--   1. (source_day_revenue) total the per-(meta source, account, revenue source, day, currency)
--      revenue EXACTLY ONCE, independent of how many campaigns are mapped to it; then
--   2. (revenue) attribute that whole total to a SINGLE representative campaign per
--      revenue-source-day (the lexicographically-first mapped campaign_id, picked
--      deterministically via row_number()), and 0 to the rest.
-- Net: summing matched_revenue_major across the co-mapped campaigns equals the source-day
-- revenue ONCE — never N times. Per-campaign spend is unaffected (spend is genuinely
-- per-campaign and is never fanned). When exactly one campaign maps to a source this collapses
-- to the obvious 1:1 attribution. (A future explicit per-campaign revenue weight on the map
-- would replace the single-representative pick with a split; until then attribution is
-- whole-to-one so the account-level total stays exact.)
source_day_revenue as (
  select
    s.workspace_id,
    s.source_id,
    s.ad_account_id,
    s.revenue_source_id,
    s.occurred_on,
    s.account_currency,
    sum(r.recognized_revenue) / 100.0 as revenue_major
  from (
    -- distinct revenue-source-days in the mapped set, so the revenue total is computed once
    -- per source-day and not multiplied by the number of co-mapped campaigns.
    select distinct
      workspace_id, source_id, ad_account_id, revenue_source_id, occurred_on, account_currency
    from spend
    where is_mapped
  ) s
  join queryable.vw_revenue_by_source r
    on r.workspace_id = s.workspace_id
    and r.source_id = s.revenue_source_id
    and r.occurred_on = s.occurred_on
    and lower(r.currency) = s.account_currency
  group by s.workspace_id, s.source_id, s.ad_account_id, s.revenue_source_id,
    s.occurred_on, s.account_currency
),
-- Deterministically pick ONE campaign per revenue-source-day to carry the whole revenue total.
mapped_campaign_pick as (
  select
    workspace_id, source_id, ad_account_id, campaign_id, revenue_source_id, occurred_on,
    account_currency,
    row_number() over (
      partition by workspace_id, source_id, ad_account_id, revenue_source_id, occurred_on,
        account_currency
      order by campaign_id
    ) as rn
  from spend
  where is_mapped
),
revenue as (
  select
    p.workspace_id,
    p.source_id,
    p.ad_account_id,
    p.campaign_id,
    p.occurred_on,
    sdr.revenue_major
  from mapped_campaign_pick p
  join source_day_revenue sdr
    on sdr.workspace_id = p.workspace_id
    and sdr.source_id = p.source_id
    and sdr.ad_account_id = p.ad_account_id
    and sdr.revenue_source_id = p.revenue_source_id
    and sdr.occurred_on = p.occurred_on
    and sdr.account_currency = p.account_currency
  where p.rn = 1
),
-- The set of Stripe revenue sources that ARE mapped to at least one campaign (with a confident
-- mapping). Used to EXCLUDE them from the unmatched-revenue branch so revenue is counted on
-- exactly one side (matched OR unmatched), never both.
mapped_revenue_sources as (
  select distinct workspace_id, revenue_source_id
  from spend
  where is_mapped and revenue_source_id is not null
),
-- UNMATCHED REVENUE (§5 join-quality signal). Every Stripe revenue-source x day whose source is
-- NOT mapped to any campaign in this workspace. There is no campaign key to attribute it to, so
-- it surfaces as a campaign_id-NULL row carrying ONLY unmatched_revenue_major. This is the fix
-- for the structurally-unreachable unmatched_revenue: previously revenue only flowed in through
-- the mapped branch, so an unmapped Stripe source's revenue silently vanished.
unmatched_revenue as (
  select
    r.workspace_id,
    r.occurred_on,
    lower(r.currency) as currency,
    sum(r.recognized_revenue) / 100.0 as revenue_major
  from queryable.vw_revenue_by_source r
  left join mapped_revenue_sources mrs
    on mrs.workspace_id = r.workspace_id
    and mrs.revenue_source_id = r.source_id
  where mrs.revenue_source_id is null
  group by r.workspace_id, r.occurred_on, lower(r.currency)
)
-- A. campaign rows: per-campaign spend + matched revenue (mapped) / none (unmapped campaign).
select
  s.workspace_id,
  s.source_id,
  s.ad_account_id,
  s.campaign_id,
  s.campaign_name,
  s.occurred_on,
  s.account_currency as currency,
  s.match_confidence,
  -- Matched spend/revenue feed the ROAS ratio; unmatched are surfaced for the join-quality
  -- signal. A campaign's spend is EITHER matched or unmatched (never both) per its mapping.
  case when s.is_mapped then s.spend_major else 0 end as matched_spend_major,
  coalesce(case when s.is_mapped then rev.revenue_major else 0 end, 0) as matched_revenue_major,
  case when s.is_mapped then 0 else s.spend_major end as unmatched_spend_major,
  -- Unmatched revenue NEVER rides a campaign row — it has no campaign. Campaign rows always
  -- carry 0 here; the unmapped-source revenue lives on the campaign-NULL rows below.
  0::numeric as unmatched_revenue_major
from spend s
left join revenue rev
  on rev.workspace_id = s.workspace_id
  and rev.source_id = s.source_id
  and rev.ad_account_id = s.ad_account_id
  and rev.campaign_id = s.campaign_id
  and rev.occurred_on = s.occurred_on
union all
-- B. unmatched-revenue rows: revenue from Stripe sources mapped to NO campaign. campaign_id NULL,
-- zero spend, zero matched revenue; the source-day's revenue lands in unmatched_revenue_major.
select
  ur.workspace_id,
  null::text as source_id,
  null::text as ad_account_id,
  null::text as campaign_id,
  null::text as campaign_name,
  ur.occurred_on,
  ur.currency,
  'unmatched'::text as match_confidence,
  0::numeric as matched_spend_major,
  0::numeric as matched_revenue_major,
  0::numeric as unmatched_spend_major,
  ur.revenue_major as unmatched_revenue_major
from unmatched_revenue ur;

-- 4. Re-register the recreated conversions view + register the new join view in the
--    queryable_views catalog (idempotent). The conversions view registry row gains
--    meta_ads_spend in allowed_measures (cost_per_result/roas read it) + campaign_name in
--    allowed_dimensions.
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
  'queryable.vw_meta_ads_campaign_conversions_daily',
  'vw_meta_ads_campaign_conversions_daily',
  'Meta Ads typed conversions view (campaign x day x result_type), with delivery spend joined in for cost_per_result / roas. result_type is a REQUIRED partition: results / cost_per_result / conversion_value / roas must never be blended across distinct result_types.',
  'campaign/day/result_type',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name","result_type","is_primary","results_source"]',
  '["results","conversion_value","meta_ads_spend"]',
  '["meta_ads_campaign_conversions_daily","meta_ads_campaign_daily","meta_ads_campaigns"]',
  '24 hours',
  'read_only_marketing_api_reporting; result_type_is_a_required_partition; cost_per_result_must_not_blend_across_result_types; conversion_value_in_account_currency',
  'drilldown.meta_ads_campaign_conversion_rows'
),
(
  'queryable.vw_meta_stripe_campaign_value_daily',
  'vw_meta_stripe_campaign_value_daily',
  'Meta<->Stripe true-value join (campaign x day, plus campaign-NULL rows for revenue from Stripe sources mapped to no campaign): Meta spend joined to Stripe revenue via the campaign<->revenue map, currency-reconciled before dividing. Emits matched/unmatched spend + revenue and a match_confidence signal (exact|normalized|fuzzy|unmatched). roas_from_stripe is mapping-dependent — read it WITH the match rate. CAVEAT: matched_revenue is SOURCE-LEVEL — it sums the whole Stripe-source-day revenue and may over-attribute unrelated invoices billed through the same Stripe account (upper bound, not per-order attribution).',
  'campaign/day',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name","match_confidence","currency"]',
  '["matched_spend_major","matched_revenue_major","unmatched_spend_major","unmatched_revenue_major"]',
  '["meta_ads_campaign_daily","meta_ads_campaigns","meta_ads_campaign_revenue_map","stripe_invoices","stripe_invoice_lines"]',
  '24 hours',
  'stripe_attributed_roas_is_mapping_dependent; excludes_unmatched_spend_and_unmatched_revenue; unmatched_revenue_surfaced_on_campaign_null_rows; stripe_revenue_is_source_level_may_over_attribute; currency_reconciled_to_account_currency_before_dividing; meta_vs_stripe_attribution_date_offset',
  'drilldown.meta_stripe_campaign_value_rows'
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

-- 5. metric_definitions seeds for the two metrics not seeded in 0033 (frequency on the
--    delivery view; roas_from_stripe on the join view). Catalog metadata + provenance ONLY —
--    the analytical engine hard-codes the matching aggregate/caveat logic (parity below).
--      frequency       -> sum(impressions) / nullif(sum(reach),0)              (recomputed; reach APPROXIMATE)
--      roas_from_stripe -> sum(matched_revenue_major) / nullif(sum(matched_spend_major),0) (recomputed; mapping-dependent)
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
  'frequency',
  'Meta Ads frequency (impressions per person reached)',
  'Meta Ads frequency, RECOMPUTED from summed bases: sum(impressions) / nullif(sum(reach),0). Inherits reach''s APPROXIMATE caveat (summing daily reach overcounts unique people, so the denominator is approximate). Never averaged from per-row frequency.',
  '["frequency","impressions per person","avg frequency"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"ratio","view":"queryable.vw_meta_ads_campaign_daily","numerator":"sum(impressions)","denominator":"sum(reach)","zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'impressions per person',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  '{}',
  'read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases; reach_is_approximate_summed_daily_reach_overcounts_unique_people',
  '["What is the average frequency on our Meta campaigns this month?"]'
),
(
  'roas_from_stripe',
  'Stripe-attributed ROAS (Meta spend vs Stripe revenue)',
  'Return on ad spend from the Meta<->Stripe true-value join: sum(matched_revenue_major) / nullif(sum(matched_spend_major),0), currency-reconciled to the account currency BEFORE dividing. MAPPING-DEPENDENT: only campaigns matched to Stripe revenue contribute; unmatched spend and unmatched revenue are excluded from the ratio and surfaced separately (unmatched revenue from a Stripe source mapped to no campaign appears on campaign-NULL rows). Read it WITH the match rate (match_confidence). OVER-ATTRIBUTION CAVEAT: the map is SOURCE-LEVEL, so matched_revenue sums the entire Stripe-source-day revenue and can over-credit unrelated invoices billed through the same Stripe account — it is an upper bound, not per-order attribution (per-order/UTM attribution is out of Phase-1 scope). Inherent Meta-vs-Stripe attribution-date offset.',
  '["stripe roas","true roas","real roas","stripe attributed roas","roas from stripe","return on ad spend from revenue"]',
  'queryable.vw_meta_stripe_campaign_value_daily',
  '{"type":"ratio","view":"queryable.vw_meta_stripe_campaign_value_daily","numerator":"sum(matched_revenue_major)","denominator":"sum(matched_spend_major)","zeroDenominator":"null","recompute":"from_summed_bases"}',
  'ratio',
  'revenue per spend (account currency)',
  'recomputed_ratio',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name","match_confidence","currency"]',
  '{}',
  'stripe_attributed_roas_is_mapping_dependent; ratio_recomputed_from_summed_bases; excludes_unmatched_spend_and_unmatched_revenue; unmatched_revenue_surfaced_on_campaign_null_rows; stripe_revenue_is_source_level_may_over_attribute; currency_reconciled_to_account_currency_before_dividing; meta_vs_stripe_attribution_date_offset',
  '["What is our true ROAS from Stripe revenue on the Meta purchase campaigns this month?"]'
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

-- 6. Re-GRANT the recreated conversions view + the new join view. Replicate 0016 line 204
--    EXACTLY: tool_agent + app ONLY (NOT growth_os_read_api — the Meta views never had it).
grant select on queryable.vw_meta_ads_campaign_conversions_daily, queryable.vw_meta_stripe_campaign_value_daily to growth_os_tool_agent, growth_os_app;
