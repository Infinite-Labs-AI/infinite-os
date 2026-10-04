create view queryable.vw_shopify_orders as
select
  workspace_id,
  source_id,
  shopify_order_id,
  shopify_order_name,
  customer_id,
  customer_email,
  currency,
  occurred_on,
  subtotal_price_amount,
  total_tax_amount,
  total_discount_amount,
  total_price_amount as shopify_gross_sales,
  1 as shopify_order_count
from shopify_orders;

create view queryable.vw_shopify_products as
select
  workspace_id,
  source_id,
  shopify_product_id,
  title,
  vendor,
  product_type,
  status,
  coalesce(updated_at_source, created_at_source, created_at)::date as occurred_on,
  updated_at_source,
  created_at_source
from shopify_products;

create view queryable.vw_meta_ads_campaign_daily as
select
  workspace_id,
  source_id,
  ad_account_id,
  campaign_id,
  campaign_name,
  occurred_on,
  spend as meta_ads_spend,
  clicks as meta_ads_clicks,
  impressions,
  reach,
  cpm,
  cpc,
  ctr
from meta_ads_campaign_daily;

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
  'queryable.vw_shopify_orders',
  'vw_shopify_orders',
  'Shopify orders authority view',
  'order',
  'occurred_on',
  '["shopify_order_id","shopify_order_name","customer_id","customer_email","currency"]',
  '["shopify_gross_sales","shopify_order_count","subtotal_price_amount","total_tax_amount","total_discount_amount"]',
  '["shopify_orders"]',
  '24 hours',
  'order_level_shopify_commerce_authority',
  'drilldown.shopify_order_rows'
),
(
  'queryable.vw_shopify_products',
  'vw_shopify_products',
  'Shopify product catalog authority view',
  'product/latest_snapshot',
  'updated_at_source',
  '["shopify_product_id","title","vendor","product_type","status"]',
  '[]',
  '["shopify_products"]',
  '24 hours',
  'catalog_snapshot_only',
  'drilldown.shopify_product_rows'
),
(
  'queryable.vw_meta_ads_campaign_daily',
  'vw_meta_ads_campaign_daily',
  'Meta Ads campaign daily insights view',
  'campaign/day',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  '["meta_ads_spend","meta_ads_clicks","impressions","reach","cpm","cpc","ctr"]',
  '["meta_ads_campaign_daily"]',
  '24 hours',
  'read_only_marketing_api_reporting',
  'drilldown.meta_ads_campaign_rows'
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
  'shopify_gross_sales',
  'Shopify gross sales',
  'Gross sales from Shopify orders',
  '["shopify revenue","shop sales","gross merchandise value","gmv"]',
  'queryable.vw_shopify_orders',
  '{"type":"direct_column","view":"queryable.vw_shopify_orders","column":"shopify_gross_sales","aggregate":"sum"}',
  'currency',
  'minor_currency_unit',
  'sum',
  'occurred_on',
  '["currency","customer_email"]',
  'shopify_orders_are_the_source_of_truth_for_order_gross_sales',
  '["What gross sales did Shopify record this week?"]'
),
(
  'shopify_order_count',
  'Shopify order count',
  'Count of Shopify orders',
  '["orders","shopify orders"]',
  'queryable.vw_shopify_orders',
  '{"type":"direct_column","view":"queryable.vw_shopify_orders","column":"shopify_order_count","aggregate":"sum"}',
  'count',
  'orders',
  'sum',
  'occurred_on',
  '["currency","customer_email"]',
  'shopify_orders_are_the_source_of_truth_for_order_count',
  '["How many orders came through Shopify yesterday?"]'
),
(
  'meta_ads_spend',
  'Meta Ads spend',
  'Daily Meta Ads spend from campaign insights',
  '["facebook ads spend","instagram ads spend","meta spend"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_daily","column":"meta_ads_spend","aggregate":"sum"}',
  'currency',
  'major_currency_unit',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_campaign_level_insights',
  '["How much did we spend on Meta Ads last week?"]'
),
(
  'meta_ads_clicks',
  'Meta Ads clicks',
  'Daily Meta Ads clicks from campaign insights',
  '["facebook ads clicks","instagram ads clicks","meta clicks"]',
  'queryable.vw_meta_ads_campaign_daily',
  '{"type":"direct_column","view":"queryable.vw_meta_ads_campaign_daily","column":"meta_ads_clicks","aggregate":"sum"}',
  'count',
  'clicks',
  'sum',
  'occurred_on',
  '["ad_account_id","campaign_id","campaign_name"]',
  'read_only_campaign_level_insights',
  '["Which Meta campaign drove the most clicks this month?"]'
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

grant select on queryable.vw_shopify_orders, queryable.vw_shopify_products, queryable.vw_meta_ads_campaign_daily to growth_os_tool_agent, growth_os_app;
