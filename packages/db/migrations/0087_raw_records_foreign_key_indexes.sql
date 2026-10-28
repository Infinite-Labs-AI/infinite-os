-- Index every foreign key that points at raw_records, and the PostHog raw copies by event day.
--
-- WHY NOW: 0088 starts deleting raw_records rows (the PostHog raw copies older than the retention
-- floor). Deleting a referenced row makes Postgres check EVERY referencing table for a row that
-- still points at it, once per deleted row. 34 tables reference raw_records(id), and only
-- sync_batch_records had an index on its column (0074). Without these, each deleted raw row is a
-- full scan of each of the other 33 tables: on the shared cloud engine that includes
-- posthog_event_truth (1.3 GB, about 950k rows) and ga4_report_snapshot_fact (53 MB), so deleting
-- even a few thousand raw rows would read terabytes. With them, each check is one index probe.
--
-- One index per foreign key, on the referencing column alone, named <table>_raw_record_id_idx.
-- Most of these tables are small or empty (Stripe, Meta, Shopify, X); their indexes cost a page or
-- two. The two that cost real space on the cloud engine are posthog_event_truth (about 50 MB) and
-- the PostHog day index below.
--
-- raw_records_posthog_event_day_idx: how 0088 finds the raw copies to delete. A PostHog raw row's
-- event time is in its payload (payload->>'occurredAt', always the connector's toISOString(), so
-- its first 10 characters are the event's UTC day, the same day posthog_event_truth buckets by).
-- Its extracted_at is no substitute: a backfill extracts months of old events in one week. Partial
-- to PostHog events, keyed by source and day, and carrying the row id so 0088's candidate scan and
-- its not-exists checks can run from the index alone (index-only), without reading the 2 KB payload
-- rows it keeps (raw held by a session or person row is skipped every day, and would otherwise be
-- re-read from the heap every day).
--
-- DELIBERATELY NOT `concurrently`, like 0046, 0073 and 0074: the migration runner applies each file
-- inside a transaction, where `create index concurrently` is an error. On a large, live shared
-- database the operator builds the large indexes ONLINE first (`create index concurrently if not
-- exists`, same names and definitions, each statement on its own, outside any transaction); this
-- file then finds them and builds nothing. Check they are valid (`pg_index.indisvalid`) before this
-- file runs: `if not exists` also skips an INVALID index left by a failed online build.
--
-- Additive and idempotent: only `create index if not exists`. No table, view, constraint or row is
-- touched, and an index changes plans, never results.

create index if not exists ga4_event_report_fact_raw_record_id_idx on ga4_event_report_fact (raw_record_id);
create index if not exists ga4_metadata_catalog_raw_record_id_idx on ga4_metadata_catalog (raw_record_id);
create index if not exists ga4_page_report_fact_raw_record_id_idx on ga4_page_report_fact (raw_record_id);
create index if not exists ga4_report_snapshot_fact_raw_record_id_idx on ga4_report_snapshot_fact (raw_record_id);
create index if not exists meta_ads_ad_conversions_daily_raw_record_id_idx on meta_ads_ad_conversions_daily (raw_record_id);
create index if not exists meta_ads_ad_daily_raw_record_id_idx on meta_ads_ad_daily (raw_record_id);
create index if not exists meta_ads_ads_raw_record_id_idx on meta_ads_ads (raw_record_id);
create index if not exists meta_ads_adset_conversions_daily_raw_record_id_idx on meta_ads_adset_conversions_daily (raw_record_id);
create index if not exists meta_ads_adset_daily_raw_record_id_idx on meta_ads_adset_daily (raw_record_id);
create index if not exists meta_ads_adsets_raw_record_id_idx on meta_ads_adsets (raw_record_id);
create index if not exists meta_ads_campaign_conversions_daily_raw_record_id_idx on meta_ads_campaign_conversions_daily (raw_record_id);
create index if not exists meta_ads_campaign_daily_raw_record_id_idx on meta_ads_campaign_daily (raw_record_id);
create index if not exists meta_ads_campaigns_raw_record_id_idx on meta_ads_campaigns (raw_record_id);
create index if not exists meta_ads_entity_versions_raw_record_id_idx on meta_ads_entity_versions (raw_record_id);
create index if not exists posthog_event_truth_raw_record_id_idx on posthog_event_truth (raw_record_id);
create index if not exists posthog_person_current_raw_record_id_idx on posthog_person_current (raw_record_id);
create index if not exists posthog_session_fact_raw_record_id_idx on posthog_session_fact (raw_record_id);
create index if not exists record_lineage_raw_record_id_idx on record_lineage (raw_record_id);
create index if not exists shopify_order_lines_raw_record_id_idx on shopify_order_lines (raw_record_id);
create index if not exists shopify_orders_raw_record_id_idx on shopify_orders (raw_record_id);
create index if not exists shopify_products_raw_record_id_idx on shopify_products (raw_record_id);
create index if not exists stripe_checkout_sessions_raw_record_id_idx on stripe_checkout_sessions (raw_record_id);
create index if not exists stripe_customers_raw_record_id_idx on stripe_customers (raw_record_id);
create index if not exists stripe_invoice_lines_raw_record_id_idx on stripe_invoice_lines (raw_record_id);
create index if not exists stripe_invoices_raw_record_id_idx on stripe_invoices (raw_record_id);
create index if not exists stripe_prices_raw_record_id_idx on stripe_prices (raw_record_id);
create index if not exists stripe_products_raw_record_id_idx on stripe_products (raw_record_id);
create index if not exists stripe_subscription_discounts_raw_record_id_idx on stripe_subscription_discounts (raw_record_id);
create index if not exists stripe_subscription_items_raw_record_id_idx on stripe_subscription_items (raw_record_id);
create index if not exists stripe_subscription_lifecycle_events_raw_record_id_idx on stripe_subscription_lifecycle_events (raw_record_id);
create index if not exists stripe_subscriptions_raw_record_id_idx on stripe_subscriptions (raw_record_id);
create index if not exists x_post_raw_record_id_idx on x_post (raw_record_id);
create index if not exists x_post_metric_snapshot_raw_record_id_idx on x_post_metric_snapshot (raw_record_id);

create index if not exists raw_records_posthog_event_day_idx
  on raw_records (source_id, (left(payload ->> 'occurredAt', 10)))
  include (id)
  where object_type = 'posthog_event';
