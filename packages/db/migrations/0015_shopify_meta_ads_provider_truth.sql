alter table sources
  drop constraint if exists sources_provider_check;

alter table sources
  add constraint sources_provider_check
  check (provider in ('google_analytics_4', 'posthog', 'stripe', 'x', 'shopify', 'meta_ads'));

alter table raw_records
  drop constraint if exists raw_records_provider_check;

alter table raw_records
  add constraint raw_records_provider_check
  check (provider in ('google_analytics_4', 'posthog', 'stripe', 'x', 'shopify', 'meta_ads'));

alter table record_lineage
  drop constraint if exists record_lineage_provider_check;

alter table record_lineage
  add constraint record_lineage_provider_check
  check (provider in ('google_analytics_4', 'posthog', 'stripe', 'x', 'shopify', 'meta_ads'));

create table shopify_orders (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  shopify_order_id text not null,
  shopify_order_name text,
  customer_id text,
  customer_email text,
  currency text not null default 'usd',
  financial_status text,
  fulfillment_status text,
  subtotal_price_amount bigint not null default 0,
  total_tax_amount bigint not null default 0,
  total_discount_amount bigint not null default 0,
  total_price_amount bigint not null default 0,
  occurred_on date not null,
  created_at_source timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, shopify_order_id)
);

create table shopify_order_lines (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  shopify_line_item_id text not null,
  shopify_order_id text not null,
  shopify_product_id text,
  shopify_variant_id text,
  title text,
  sku text,
  quantity integer not null default 0,
  price_amount bigint not null default 0,
  line_total_amount bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, shopify_line_item_id)
);

create table shopify_products (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  shopify_product_id text not null,
  title text not null,
  vendor text,
  product_type text,
  status text,
  created_at_source timestamptz,
  updated_at_source timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, shopify_product_id)
);

create table meta_ads_campaign_daily (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  ad_account_id text not null,
  campaign_id text not null,
  campaign_name text,
  occurred_on date not null,
  spend numeric(18,6) not null default 0,
  clicks integer not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  cpm numeric(18,6),
  cpc numeric(18,6),
  ctr numeric(18,6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ad_account_id, campaign_id, occurred_on)
);

grant select, insert, update on shopify_orders, shopify_order_lines, shopify_products, meta_ads_campaign_daily to growth_os_worker;
