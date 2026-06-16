-- Stop connectors from creating duplicate sources by making the identity key stable.
--
-- The previous identity key (workspace_id, provider, account_external_id, connection_name)
-- was unstable because account_external_id was nullable / name-derived and connection_name is
-- a free-text display label. This migration normalizes account_external_id, dedups the rows
-- that collide once connection_name is removed from the key, repoints every child table at the
-- surviving source, swaps the unique constraint to (workspace_id, provider, account_external_id),
-- and enforces NOT NULL on account_external_id.
--
-- The runMigrations runner already wraps every migration file in begin/commit, so this file is
-- not wrapped again here; the create temporary table ... on commit drop below relies on that
-- enclosing transaction.

-- (a) Backfill + normalize the identity column.
update sources set account_external_id = connection_name where account_external_id is null;
update sources set account_external_id = lower(account_external_id) where provider = 'x';

-- (b) Build the dedup map: choose a survivor per identity group by data-richness then recency.
create temporary table _source_dedup on commit drop as
with ranked as (
  select id, first_value(id) over (
    partition by workspace_id, provider, account_external_id
    order by last_synced_at desc nulls last, connected_at desc nulls last, id
  ) as survivor_id
  from sources
)
select id as loser_id, survivor_id from ranked where id <> survivor_id;

-- (c) Repoint every child row from loser -> survivor.

-- Plain repoint (no source_id-inclusive unique key; safe to move all rows).
update connection_credentials t set source_id = d.survivor_id from _source_dedup d where t.source_id = d.loser_id;
update integration_audit_log t set source_id = d.survivor_id from _source_dedup d where t.source_id = d.loser_id;
update sync_batches t set source_id = d.survivor_id from _source_dedup d where t.source_id = d.loser_id;
update sync_errors t set source_id = d.survivor_id from _source_dedup d where t.source_id = d.loser_id;
update sync_runs t set source_id = d.survivor_id from _source_dedup d where t.source_id = d.loser_id;

-- sync_schedules has a unique on (source_id) only: the survivor keeps its own schedule, drop losers'.
delete from sync_schedules s using _source_dedup d where s.source_id = d.loser_id;

-- Collision-safe repoint (unique is (source_id, <business_key...>)): move only rows that do not
-- collide with an existing survivor row, then delete the colliding remainder.

-- ga4_metadata_catalog: (metadata_type, api_name)
update ga4_metadata_catalog t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from ga4_metadata_catalog s
      where s.source_id = d.survivor_id
        and (s.metadata_type, s.api_name) is not distinct from (t.metadata_type, t.api_name)
    );
delete from ga4_metadata_catalog t using _source_dedup d where t.source_id = d.loser_id;

-- ga4_report_snapshot_fact: (reporting_date, country, landing_page, utm_source, utm_medium, utm_campaign)
update ga4_report_snapshot_fact t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from ga4_report_snapshot_fact s
      where s.source_id = d.survivor_id
        and (s.reporting_date, s.country, s.landing_page, s.utm_source, s.utm_medium, s.utm_campaign)
            is not distinct from
            (t.reporting_date, t.country, t.landing_page, t.utm_source, t.utm_medium, t.utm_campaign)
    );
delete from ga4_report_snapshot_fact t using _source_dedup d where t.source_id = d.loser_id;

-- meta_ads_campaign_daily: (ad_account_id, campaign_id, occurred_on)
update meta_ads_campaign_daily t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from meta_ads_campaign_daily s
      where s.source_id = d.survivor_id
        and (s.ad_account_id, s.campaign_id, s.occurred_on)
            is not distinct from (t.ad_account_id, t.campaign_id, t.occurred_on)
    );
delete from meta_ads_campaign_daily t using _source_dedup d where t.source_id = d.loser_id;

-- posthog_event_truth: (event_id)
update posthog_event_truth t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from posthog_event_truth s
      where s.source_id = d.survivor_id
        and (s.event_id) is not distinct from (t.event_id)
    );
delete from posthog_event_truth t using _source_dedup d where t.source_id = d.loser_id;

-- posthog_person_current: (person_id)
update posthog_person_current t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from posthog_person_current s
      where s.source_id = d.survivor_id
        and (s.person_id) is not distinct from (t.person_id)
    );
delete from posthog_person_current t using _source_dedup d where t.source_id = d.loser_id;

-- posthog_person_distinct_ids: (distinct_id)
update posthog_person_distinct_ids t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from posthog_person_distinct_ids s
      where s.source_id = d.survivor_id
        and (s.distinct_id) is not distinct from (t.distinct_id)
    );
delete from posthog_person_distinct_ids t using _source_dedup d where t.source_id = d.loser_id;

-- posthog_session_fact: (session_id)
update posthog_session_fact t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from posthog_session_fact s
      where s.source_id = d.survivor_id
        and (s.session_id) is not distinct from (t.session_id)
    );
delete from posthog_session_fact t using _source_dedup d where t.source_id = d.loser_id;

-- raw_records: (object_type, external_id, source_record_hash)
update raw_records t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from raw_records s
      where s.source_id = d.survivor_id
        and (s.object_type, s.external_id, s.source_record_hash)
            is not distinct from (t.object_type, t.external_id, t.source_record_hash)
    );
delete from raw_records t using _source_dedup d where t.source_id = d.loser_id;

-- shopify_order_lines: (shopify_line_item_id)
update shopify_order_lines t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from shopify_order_lines s
      where s.source_id = d.survivor_id
        and (s.shopify_line_item_id) is not distinct from (t.shopify_line_item_id)
    );
delete from shopify_order_lines t using _source_dedup d where t.source_id = d.loser_id;

-- shopify_orders: (shopify_order_id)
update shopify_orders t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from shopify_orders s
      where s.source_id = d.survivor_id
        and (s.shopify_order_id) is not distinct from (t.shopify_order_id)
    );
delete from shopify_orders t using _source_dedup d where t.source_id = d.loser_id;

-- shopify_products: (shopify_product_id)
update shopify_products t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from shopify_products s
      where s.source_id = d.survivor_id
        and (s.shopify_product_id) is not distinct from (t.shopify_product_id)
    );
delete from shopify_products t using _source_dedup d where t.source_id = d.loser_id;

-- source_scopes: (scope_key)
update source_scopes t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from source_scopes s
      where s.source_id = d.survivor_id
        and (s.scope_key) is not distinct from (t.scope_key)
    );
delete from source_scopes t using _source_dedup d where t.source_id = d.loser_id;

-- stripe_customers: (stripe_customer_id)
update stripe_customers t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from stripe_customers s
      where s.source_id = d.survivor_id
        and (s.stripe_customer_id) is not distinct from (t.stripe_customer_id)
    );
delete from stripe_customers t using _source_dedup d where t.source_id = d.loser_id;

-- stripe_invoice_lines: (stripe_line_id)
update stripe_invoice_lines t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from stripe_invoice_lines s
      where s.source_id = d.survivor_id
        and (s.stripe_line_id) is not distinct from (t.stripe_line_id)
    );
delete from stripe_invoice_lines t using _source_dedup d where t.source_id = d.loser_id;

-- stripe_invoices: (stripe_invoice_id)
update stripe_invoices t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from stripe_invoices s
      where s.source_id = d.survivor_id
        and (s.stripe_invoice_id) is not distinct from (t.stripe_invoice_id)
    );
delete from stripe_invoices t using _source_dedup d where t.source_id = d.loser_id;

-- stripe_prices: (stripe_price_id)
update stripe_prices t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from stripe_prices s
      where s.source_id = d.survivor_id
        and (s.stripe_price_id) is not distinct from (t.stripe_price_id)
    );
delete from stripe_prices t using _source_dedup d where t.source_id = d.loser_id;

-- stripe_products: (stripe_product_id)
update stripe_products t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from stripe_products s
      where s.source_id = d.survivor_id
        and (s.stripe_product_id) is not distinct from (t.stripe_product_id)
    );
delete from stripe_products t using _source_dedup d where t.source_id = d.loser_id;

-- stripe_subscriptions: (stripe_subscription_id)
update stripe_subscriptions t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from stripe_subscriptions s
      where s.source_id = d.survivor_id
        and (s.stripe_subscription_id) is not distinct from (t.stripe_subscription_id)
    );
delete from stripe_subscriptions t using _source_dedup d where t.source_id = d.loser_id;

-- sync_cursors: (cursor_key)
update sync_cursors t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from sync_cursors s
      where s.source_id = d.survivor_id
        and (s.cursor_key) is not distinct from (t.cursor_key)
    );
delete from sync_cursors t using _source_dedup d where t.source_id = d.loser_id;

-- x_post: (x_post_id)
update x_post t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from x_post s
      where s.source_id = d.survivor_id
        and (s.x_post_id) is not distinct from (t.x_post_id)
    );
delete from x_post t using _source_dedup d where t.source_id = d.loser_id;

-- x_post_metric_snapshot: (x_post_id, captured_at)
update x_post_metric_snapshot t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from x_post_metric_snapshot s
      where s.source_id = d.survivor_id
        and (s.x_post_id, s.captured_at) is not distinct from (t.x_post_id, t.captured_at)
    );
delete from x_post_metric_snapshot t using _source_dedup d where t.source_id = d.loser_id;

-- x_profile_snapshot: (captured_at)
update x_profile_snapshot t set source_id = d.survivor_id
  from _source_dedup d
  where t.source_id = d.loser_id
    and not exists (
      select 1 from x_profile_snapshot s
      where s.source_id = d.survivor_id
        and (s.captured_at) is not distinct from (t.captured_at)
    );
delete from x_profile_snapshot t using _source_dedup d where t.source_id = d.loser_id;

-- (d) Delete the now-orphaned loser source rows.
delete from sources s using _source_dedup d where s.id = d.loser_id;

-- (e) Swap the constraint + enforce NOT NULL on the stable identity column.
alter table sources drop constraint sources_workspace_id_provider_account_external_id_connectio_key;
alter table sources add constraint sources_workspace_provider_account_key unique (workspace_id, provider, account_external_id);
alter table sources alter column account_external_id set not null;
