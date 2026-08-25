import { describe, expect, it } from "vitest";

import { JOURNEY_ENTITY_TYPES } from "@infinite-os/core";

import { loadMigrations } from "../src/index.js";

const FORBIDDEN_TABLES = [
  "content_items",
  "conversion_events",
  "attribution_touchpoints",
  "scheduled_reports",
  "delivery_attempts"
];

describe("Infinite OS migration stack", () => {
  it("contains the first-phase migration stack", () => {
    expect(loadMigrations().map((migration) => migration.id)).toEqual([
      "0001_control_plane.sql",
      "0002_sync_state_and_raw_records.sql",
      "0003_jobs_schedules_and_saved_reports.sql",
      "0004_ga4_posthog_stripe_provider_truth.sql",
      "0005_metadata_registries_and_queryable_views.sql",
      "0006_security_roles.sql",
      "0007_first_phase_runtime_contract_updates.sql",
      "0008_record_lineage_idempotency.sql",
      "0009_saved_report_exports.sql",
      "0010_x_readonly_post_metrics.sql",
      "0011_x_queryable_public_post_metrics.sql",
      "0012_llm_runtime.sql",
      "0013_chat_memory_fact_dedupe.sql",
      "0014_x_profile_and_authored_activity.sql",
      "0015_shopify_meta_ads_provider_truth.sql",
      "0016_shopify_meta_ads_queryable_views.sql",
      "0017_stable_source_identity.sql",
      "0018_x_authored_activity_drilldown_action.sql",
      "0019_metadata_context_cards.sql",
      "0020_journey_core.sql",
      "0021_setup_onboarding.sql",
      "0022_posthog_event_queryable_view.sql",
      "0023_connection_credentials_oauth_token_fk.sql",
      "0024_ga4_analytics_v1.sql",
      "0025_ga4_page_report.sql",
      "0026_workspace_site_ga4_link.sql",
      "0027_exclude_dev_host_traffic.sql",
      "0028_meta_write_dedup.sql",
      "0029_meta_ads_extended_metric_seeds.sql",
      "0030_meta_ads_campaigns.sql",
      "0031_meta_ads_campaign_conversions_daily.sql",
      "0032_meta_ads_campaign_daily_conversion_columns.sql",
      "0033_meta_ads_conversion_views_and_metric_seeds.sql",
      "0034_meta_stripe_true_value_and_frequency.sql",
      "0035_meta_ads_adset_grain.sql",
      "0036_chat_sessions_desktop_surface.sql",
      "0037_meta_ads_ad_grain.sql",
      "0038_chat_action_calls_workspace_id.sql",
      "0039_connection_credentials_metadata.sql",
      "0040_workspace_owner_id.sql",
      "0041_fail_forever_queued_connector_jobs.sql",
      "0042_sessions_metric_seed.sql",
      "0043_posthog_audience_view.sql",
      "0044_sources_consecutive_sync_failures.sql",
      "0045_sources_last_counted_sync_failure_at.sql",
      "0046_analytics_fact_table_indexes.sql",
      "0047_stripe_paid_subscribers_metric.sql",
      "0048_stripe_subscription_lifecycle_metrics.sql",
      "0049_engine_app_stripe_subscription_items_grant.sql",
      "0050_stripe_customer_metrics_classification.sql",
      "0051_stripe_churn_requires_payment.sql",
      "0052_stripe_revenue_uses_amount_paid.sql",
      "0053_stripe_business_metric_eligibility.sql",
      "0054_stripe_invoice_reconciliation.sql",
      "0055_stripe_recurring_value_truth.sql",
      "0056_stripe_customer_mrr_movements.sql",
      "0057_stripe_trial_cohorts.sql",
      "0058_stripe_delta_sync.sql",
      "0059_stripe_reconciliation_drift.sql",
      "0060_posthog_exclude_internal_from_app_views.sql",
      "0061_ga4_event_report_and_snapshot_replacement.sql",
      "0062_same_lane_site_conversion_rate.sql",
      "0063_posthog_daily_rollups.sql",
      "0064_posthog_raw_retention.sql",
      "0065_prune_rolls_up_before_deleting.sql"
    ]);
  });

  it("grants the cloud engine role write access to Stripe subscription items (0049)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0049_engine_app_stripe_subscription_items_grant.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");
    expect(sql).toContain(
      "grant select, insert, update on stripe_subscription_items to engine_app"
    );
  });

  it("excludes explicitly classified Stripe customers from lifecycle metrics (0050)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0050_stripe_customer_metrics_classification.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("add column if not exists metrics_classification text");
    expect(sql).toContain("left join stripe_customers c");
    expect(sql).toContain("coalesce(c.metrics_classification, '') <> 'internal_test'");
    expect(sql).toContain("customer_metrics_classification_exclusion");
  });

  it("counts churn only for customers with a positive paid invoice (0051)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0051_stripe_churn_requires_payment.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("from stripe_invoices");
    expect(sql).toContain("amount_paid > 0");
    expect(sql).toContain("and has_positive_payment");
    expect(sql).toContain("churn_requires_positive_paid_invoice");
  });

  it("uses paid invoice cash instead of Stripe line face value for revenue (0052)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0052_stripe_revenue_uses_amount_paid.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("i.amount_paid::numeric as recognized_revenue");
    expect(sql).not.toContain("join stripe_invoice_lines");
    expect(sql).toContain("gross_of_refunds");
  });

  it("centralizes scope-safe Stripe business eligibility across customer metrics (0053)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0053_stripe_business_metric_eligibility.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("create or replace view queryable.vw_stripe_customer_metric_eligibility");
    expect(sql).toContain("coalesce(c.metrics_classification, '') <> 'internal_test' as is_business_eligible");
    expect(sql).toContain("e.workspace_id = s.workspace_id");
    expect(sql).toContain("e.source_id = s.source_id");
    expect(sql).toContain("e.stripe_customer_id = s.stripe_customer_id");
    expect(sql).toContain("e.workspace_id = i.workspace_id");
    expect(sql).toContain("e.source_id = i.source_id");
    expect(sql).toContain("e.stripe_customer_id = i.stripe_customer_id");
    expect(sql).toContain("coalesce(e.is_business_eligible, true)");
    expect(sql).toContain("i.amount_paid::numeric as recognized_revenue");
    expect(sql).toContain("name = 'gross paid invoice amount'");
    expect(sql).toContain("gross of later refunds");
    expect(sql).toContain("not accounting revenue");
    expect(sql).toContain("not proof of cash receipt");
    expect(sql).not.toContain("cash collected");
    expect(sql).not.toContain("gross revenue");
  });

  it("adds source-safe Stripe invoice linkage, reconciliation state, and aggregate quality (0054)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0054_stripe_invoice_reconciliation.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("alter table stripe_invoices add column if not exists stripe_subscription_id text");
    expect(sql).toContain("add column if not exists subscription_origin text");
    expect(sql).toContain("create index if not exists stripe_invoices_workspace_source_subscription_idx");
    expect(sql).toContain("on stripe_invoices(workspace_id, source_id, stripe_subscription_id)");
    expect(sql).toContain("create table if not exists stripe_invoice_sync_state");
    expect(sql).toContain("unique (workspace_id, source_id)");
    expect(sql).toContain("backfill_state text not null default 'pending'");
    expect(sql).toContain("event_window_from timestamptz");
    expect(sql).toContain("latest_successful_stripe_cutoff timestamptz");
    expect(sql).toContain("create or replace view queryable.vw_stripe_invoice_link_quality");
    expect(sql).toContain("linked_paid_invoices");
    expect(sql).toContain("unlinked_subscription_paid_invoices");
    expect(sql).toContain("unknown_origin_paid_invoices");
    expect(sql).toContain("link_coverage");
    expect(sql).toContain("completeness_sufficient");
    expect(sql).not.toContain("customer_external_id");
    expect(sql).not.toContain("invoice_external_id");
    expect(sql).not.toContain("subscription_external_id");
  });

  it("adds complete ordered Stripe recurring-value truth and net paid qualification (0055)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0055_stripe_recurring_value_truth.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("add column if not exists recurring_interval_count integer");
    expect(sql).toContain("add column if not exists recurring_usage_type text");
    expect(sql).toContain("add column if not exists billing_scheme text");
    expect(sql).toContain("create table if not exists stripe_subscription_discounts");
    expect(sql).toContain("unique (workspace_id, source_id, stripe_subscription_id, target_type, target_id, position)");
    expect(sql).toContain("create or replace view queryable.vw_stripe_subscription_recurring_value");
    expect(sql).toContain("item_discounts_before_subscription_discounts");
    expect(sql).toContain("net_monthly_amount_cents > 0");
    expect(sql).toContain("count(distinct subscriber_key)");
    expect(sql).toContain("amount_discount_currency_mismatch");
    expect(sql).toContain("mixed_interval_amount_discount");
    // List value is licensed-only: a metered/tiered/custom price carrying a unit_amount is a
    // per-usage rate and must not be summed into list MRR.
    expect(sql).toContain(
      "when i.pricing_state = 'licensed_per_unit' and i.unit_amount is not null and i.quantity is not null"
    );
    expect(sql).toContain("when coalesce(i.pricing_state, '') <> 'licensed_per_unit' then false");
    // A null quantity is unknown, never priced at 1.
    expect(sql).toContain("when i.quantity is null then 'unknown_quantity'");
    expect(sql).not.toContain("coalesce(i.quantity, 1)");
    expect(sql).toContain("quantity_null_is_unknown_not_one");
    expect(sql).toContain("list_value_excludes_metered_tiered_and_custom_prices");
    // Empty reason arrays must not aggregate into empty-string reason codes.
    expect(sql).toContain("string_agg(nullif(array_to_string(f.reasons, ','), ''), ',')");
    expect(sql).toContain("where reason is not null and reason <> ''");
  });

  it("adds immutable source-safe customer MRR state, facts, and forward coverage (0056)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0056_stripe_customer_mrr_movements.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("create table if not exists stripe_customer_mrr_states");
    expect(sql).toContain("unique (workspace_id, source_id, stripe_customer_id, currency)");
    expect(sql).toContain("create table if not exists stripe_customer_mrr_movements");
    expect(sql).toContain("unique (idempotency_key)");
    expect(sql).toContain("business_eligible_at_event boolean not null");
    expect(sql).toContain("create table if not exists stripe_mrr_movement_coverage");
    expect(sql).toContain("forward_coverage_started_at timestamptz");
    expect(sql).toContain("bootstrap_evidence_from timestamptz");
    expect(sql).toContain("create or replace view queryable.vw_stripe_customer_mrr_movements");
    expect(sql).toContain("m.business_eligible_at_event");
    expect(sql).toContain("e.is_business_eligible");
    expect(sql).toContain("m.effective_at");
    expect(sql).not.toContain("canceled_at");
  });

  it("adds immutable event-proven Stripe trial spells and completed-segment coverage (0057)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0057_stripe_trial_cohorts.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("add column if not exists livemode boolean");
    expect(sql).toContain("create table if not exists stripe_subscription_lifecycle_events");
    expect(sql).toContain("unique (workspace_id, source_id, stripe_event_id)");
    expect(sql).toContain("create table if not exists stripe_trial_history_segments");
    expect(sql).toContain("segment_from timestamptz not null");
    expect(sql).toContain("segment_to_exclusive timestamptz not null");
    expect(sql).toContain("check (segment_from < segment_to_exclusive)");
    expect(sql).toContain("check (event_created_at >= segment_from and event_created_at < segment_to_exclusive)");
    expect(sql).toContain("check ((segment_closed_at is null) = (published_segment_id is null))");
    expect(sql).toContain("foreign key (workspace_id, source_id, published_segment_id)");
    expect(sql).toContain("create table if not exists stripe_trial_spells");
    expect(sql).toContain("start_event_id text not null");
    expect(sql).toContain("unique (workspace_id, source_id, stripe_subscription_id, start_event_id)");
    expect(sql).toContain("business_eligible_at_capture boolean not null");
    expect(sql).toContain("first_complete_current_observation_v1");
    expect(sql).toContain("create table if not exists stripe_trial_history_coverage");
    expect(sql).toContain("continuous_coverage_from timestamptz");
    expect(sql).toContain("closed_through_exclusive timestamptz");
    expect(sql).toContain("grant select, insert, update, delete on");
    // A test-mode-only source is unavailable, not a confident zero.
    expect(sql).toContain("as is_test_mode_only");
    expect(sql).toContain("bool_or(sm.is_test_mode_only) as has_test_mode_only_source");
    expect(sql).toContain("'test_mode_source'");
    // Acquisition exclusion is CUSTOMER-scoped in both cohort views.
    expect(sql).toContain("pre.stripe_customer_id = sp.stripe_customer_id");
    expect(sql).not.toContain("pre.stripe_subscription_id = sp.stripe_subscription_id");
    expect(sql).toContain("acquisition_exclusion_is_customer_scoped");
    expect(sql).toContain("conversion_linkage_is_same_subscription_only");
    expect(sql).not.toContain("email");
    expect(sql).not.toContain("name text");
  });

  it("adds durable Stripe delta-lane segments, immutable evidence, and watermarks (0058)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0058_stripe_delta_sync.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("create table if not exists stripe_event_segments");
    expect(sql).toContain("check (segment_from < segment_to_exclusive)");
    expect(sql).toContain("create table if not exists stripe_event_evidence");
    // Evidence is insert-only historical proof; it must never establish current state.
    expect(sql).toContain("unique (workspace_id, source_id, stripe_event_id)");
    expect(sql).toContain("previous_attributes jsonb");
    expect(sql).toContain("create table if not exists stripe_sync_watermarks");
    // The three watermarks the Command Center reads, plus the two columns 0059 owns.
    expect(sql).toContain("delta_data_as_of timestamptz");
    expect(sql).toContain("continuous_coverage_from timestamptz");
    expect(sql).toContain("reconciled_at timestamptz");
    expect(sql).toContain("last_drift_at timestamptz");
    expect(sql).toContain("unique (workspace_id, source_id)");
    expect(sql).toContain("add column if not exists request_telemetry jsonb");
    // Reverse indexes for the price/coupon fan-out: those events name an object, not the
    // subscriptions that reference it, and Stripe emits no parent event for a subresource change.
    expect(sql).toContain("add column if not exists stripe_coupon_id text");
    expect(sql).toContain("stripe_subscription_items_price_idx");
    expect(sql).toContain("grant select, insert, update on stripe_sync_watermarks to growth_os_worker");
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");
    // Fix-round DDL, pinned so the Supabase mirror can't silently lag the engine file:
    // segment retirement status, the fan-out park column, and the flipped closed_at check.
    expect(sql).toContain("'superseded'");
    expect(sql).toContain("pending_full_refresh_reason");
    expect(sql).toContain("(status = 'open') = (closed_at is null)");
  });

  it("adds the append-only Stripe reconciliation drift ledger + health view (0059)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0059_stripe_reconciliation_drift.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("create table if not exists stripe_reconciliation_drift");
    expect(sql).toContain("run_started_at timestamptz not null");
    expect(sql).toContain(
      "check (entity_kind in ( 'customer', 'subscription', 'subscription_item', "
      + "'invoice', 'price', 'coupon', 'discount' ))"
    );
    expect(sql).toContain(
      "check (drift_kind in ( 'missing_local', 'missing_remote', 'state_mismatch' ))"
    );
    expect(sql).toContain("repaired boolean not null");
    expect(sql).toContain("detail jsonb");
    expect(sql).toContain("stripe_reconciliation_drift_scope_time_idx");

    // APPEND-ONLY BY GRANT: the writer gets insert but never update/delete. An evidence table its
    // own writer can rewrite is not evidence.
    expect(sql).toContain("grant select, insert on stripe_reconciliation_drift to growth_os_worker");
    expect(sql).not.toContain("grant select, insert, update on stripe_reconciliation_drift");
    expect(sql).not.toContain("delete on stripe_reconciliation_drift");

    // The grantless-view incident: every queryable view ships its own grants, in both roles and
    // behind the optional-role guards.
    expect(sql).toContain("create or replace view queryable.vw_stripe_reconciliation_health");
    expect(sql).toContain(
      "grant select on queryable.vw_stripe_reconciliation_health to growth_os_tool_agent, growth_os_app"
    );
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'growth_os_read_api')");

    // Honesty contract of the health surface.
    expect(sql).toContain("min(reconciled_at) as reconciled_at");
    expect(sql).toContain("'never_reconciled'");
    expect(sql).toContain("never_reconciled_is_not_clean");
  });

  it("adds the GA4 event grain + snapshot-replacement deletes + provider metadata (0061)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0061_ga4_event_report_and_snapshot_replacement.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    // The event-grain fact — upsert key MUST match writeGa4EventTruth's on-conflict list.
    expect(sql).toContain("create table if not exists ga4_event_report_fact");
    expect(sql).toContain(
      "constraint ga4_event_report_unique unique (source_id, reporting_date, host_name, event_name)"
    );
    expect(sql).toContain("create index if not exists ga4_event_report_workspace_date_idx");

    // The view aliases follow metric-id == view-column, and dev hosts are excluded from day one.
    expect(sql).toContain("create or replace view queryable.vw_site_events");
    expect(sql).toContain("event_count as site_event_count");
    expect(sql).toContain("key_events as site_key_events");
    expect(sql).toContain("lower(host_name) not in ('localhost', '127.0.0.1')");

    // Registry seeds so list_metrics / describe_metric discover both metrics.
    expect(sql).toContain("'queryable.vw_site_events'");
    expect(sql).toContain("'site_event_count'");
    expect(sql).toContain("'site_key_events'");

    // Snapshot replacement: the worker must be able to DELETE from all three GA4 fact tables
    // (the prune of restated/obsolete keys), and the new table gets full worker DML.
    expect(sql).toContain(
      "grant select, insert, update, delete on ga4_event_report_fact to growth_os_worker"
    );
    expect(sql).toContain(
      "grant delete on ga4_report_snapshot_fact, ga4_page_report_fact to growth_os_worker"
    );

    // The grantless-view incident: the view ships its own grants, plus the cloud-role guard.
    expect(sql).toContain(
      "grant select on queryable.vw_site_events to growth_os_tool_agent, growth_os_app, growth_os_read_api"
    );
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");

    // Provider metadata (GA4 dates are property-local; the data-through day may be partial).
    expect(sql).toContain("add column if not exists provider_time_zone text");
    expect(sql).toContain("add column if not exists provider_data_through_date date");
  });

  it("rebuilds vw_site_conversion_rate as the same-lane GA4 rate and re-lanes signup_count (0062)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0062_same_lane_site_conversion_rate.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    // DROP + CREATE (the column set changes — REPLACE would refuse), and the rebuilt view reads
    // ONLY the GA4 fact: no posthog CTE, no cross-provider join, no signup column.
    expect(sql).toContain("drop view if exists queryable.vw_site_conversion_rate");
    expect(sql).toContain("create view queryable.vw_site_conversion_rate");
    expect(sql).toContain("from ga4_report_snapshot_fact");
    expect(sql).not.toContain("posthog_event_truth");
    expect(sql).not.toContain("full outer join");
    expect(sql).not.toContain("signup_count as");
    expect(sql).toContain("sum(key_events)::numeric / sum(total_users)");

    // The 0027 dev-host exclusion survives the rebuild.
    expect(sql).toContain("lower(host_name) not in ('localhost', '127.0.0.1')");

    // Registry: single-provider source_tables (freshness derives providers from it) + GA4 drilldown.
    expect(sql).toContain(`source_tables = '["ga4_report_snapshot_fact"]'`);
    expect(sql).toContain("drilldown_action = 'drilldown.ga4_traffic_provider_rows'");

    // signup_count re-lanes to the pure PostHog view.
    expect(sql).toContain("source_view = 'queryable.vw_posthog_events'");

    // The grantless-view incident: a rebuilt view re-ships grants, plus the cloud-role guard.
    expect(sql).toContain(
      "grant select on queryable.vw_site_conversion_rate to growth_os_tool_agent, growth_os_app, growth_os_read_api"
    );
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");
  });

  it("puts per-source day-grain rollups behind the two PostHog queryable views (0063)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0063_posthog_daily_rollups.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    // The two rollups. posthog_event_daily's name/columns are the demo train's pre-designed
    // projection target; is_internal is a GROUPING column (0060: still collected, hidden by views).
    expect(sql).toContain("create table if not exists posthog_event_daily");
    expect(sql).toContain("create table if not exists posthog_site_daily");
    expect(sql).toContain("is_internal boolean not null default false");
    // Full-grain uniqueness with NULLS NOT DISTINCT — a duplicate grain row is a hard error, never a
    // doubled chart.
    expect(sql).toContain("constraint posthog_event_daily_grain_key unique nulls not distinct");
    expect(sql).toContain("constraint posthog_site_daily_grain_key unique nulls not distinct");
    expect(sql).toContain("create index if not exists posthog_event_daily_workspace_time_idx");
    expect(sql).toContain("create index if not exists posthog_site_daily_workspace_time_idx");

    // The per-(workspace, source, day-range) refresh the connector CLOSE hook calls.
    expect(sql).toContain(
      "create or replace function refresh_posthog_daily_rollups( p_workspace_id text, p_source_id text, p_from date, p_to date )"
    );
    expect(sql).toContain("raise exception 'refresh_posthog_daily_rollups: from % after to %'");
    // The day bucket and the window bounds are pinned to UTC — never the session zone (the CLOSE
    // hook slices UTC cursors; a session-zone bucket would strand events in an un-refreshed day).
    expect(sql).toContain("(occurred_at at time zone 'utc')::date");
    // Asserted against the EXECUTABLE statements, not the prose: the header's ROLLBACK section quotes
    // 0060's view bodies verbatim (the point of copying them is that they are paste-ready), and those
    // bodies bucket with date(occurred_at). What is banned is this migration RUNNING a session-zone
    // bucket, so comments are stripped before the check.
    const executableSql = (migration?.sql ?? "")
      .replace(/--[^\n]*/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(executableSql).not.toContain("date(occurred_at)");
    // The backfill's upper bound is UTC today too — `current_date` is the session zone.
    expect(executableSql).toContain("(now() at time zone 'utc')::date");
    expect(executableSql).not.toContain("current_date");
    expect(sql).toContain("v_from timestamptz := p_from::timestamp at time zone 'utc'");
    expect(sql).toContain("v_to timestamptz := (p_to + 1)::timestamp at time zone 'utc'");
    expect(sql).toContain("occurred_at >= v_from and occurred_at < v_to");

    // Registry (0062 precedent): the views' source_tables name the rollups, not the raw truth.
    expect(sql).toContain(
      `update queryable_views set source_tables = '["posthog_event_daily"]' where id = 'queryable.vw_posthog_events'`
    );
    expect(sql).toContain(
      `update queryable_views set source_tables = '["posthog_site_daily"]' where id = 'queryable.vw_posthog_site'`
    );

    // Views keep their 0060 names + column contracts but now read the rollups and hide internal rows.
    expect(sql).toContain("create or replace view queryable.vw_posthog_events");
    expect(sql).toContain("event_count as posthog_event_count from posthog_event_daily where not is_internal");
    expect(sql).toContain("create or replace view queryable.vw_posthog_site");
    expect(sql).toContain("page_view_count as posthog_page_views from posthog_site_daily where not is_internal");

    // Grants, 0057's pattern: writers (local worker + guarded cloud engine_app) get CRUD on the
    // rollups; readers get SELECT on the tables AND the re-cut views (guarded read_api/engine_app).
    expect(sql).toContain(
      "grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to growth_os_worker"
    );
    expect(sql).toContain(
      "grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to engine_app"
    );
    expect(sql).toContain(
      "grant select on posthog_event_daily, posthog_site_daily to growth_os_app, growth_os_tool_agent"
    );
    expect(sql).toContain(
      "grant select on queryable.vw_posthog_events, queryable.vw_posthog_site to growth_os_app, growth_os_tool_agent"
    );
    expect(sql).toContain("grant select on posthog_event_daily, posthog_site_daily to growth_os_read_api");
    expect(sql).toContain(
      "grant select on queryable.vw_posthog_events, queryable.vw_posthog_site to growth_os_read_api"
    );
    expect(sql).toContain("grant select on queryable.vw_posthog_events, queryable.vw_posthog_site to engine_app");
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'growth_os_read_api')");

    // Durable copy of the Phase-0 sandbox hand-applied audit index (plain CREATE INDEX — the
    // migration runs inside one transaction, so CONCURRENTLY is impossible).
    expect(sql).toContain(
      "create index if not exists stripe_invoice_lines_workspace_invoice_idx on stripe_invoice_lines (workspace_id, source_id, stripe_invoice_id)"
    );
    expect(sql).not.toContain("concurrently");

    // One-time backfill per (workspace, source) — the same unit the CLOSE hook refreshes.
    expect(sql).toContain("for r in select distinct workspace_id, source_id from posthog_event_truth loop");
    // Upper bound in UTC, matching every other day expression in the file — `current_date` would have
    // been the session zone and, west of UTC, would have left the most recent day unrolled.
    expect(sql).toContain(
      "perform refresh_posthog_daily_rollups( r.workspace_id, r.source_id, date '2000-01-01', (now() at time zone 'utc')::date )"
    );
  });

  it("keeps rollups permanent while raw is pruned — retention config, prune watermarks, clamped refresh (0064)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0064_posthog_raw_retention.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    // The per-deployment retention policy: a SINGLE row, seeded 180 days, positive-days check.
    expect(sql).toContain("create table if not exists posthog_retention_config");
    expect(sql).toContain("singleton boolean primary key default true check (singleton)");
    expect(sql).toContain("retention_days integer not null check (retention_days > 0)");
    expect(sql).toContain("values (true, 180) on conflict (singleton) do nothing");

    // The prune WATERMARK — the exact record of which days' raw is gone. The refresh clamp keys off
    // THIS, not the config floor, so (a) a never-pruned source still rolls up full backfill history
    // and (b) raising retention_days later can never re-arm the delete-and-reinsert-nothing trap for
    // days pruned under the old setting.
    expect(sql).toContain("create table if not exists posthog_prune_watermarks");
    expect(sql).toContain("pruned_before date not null");
    expect(sql).toContain("primary key (workspace_id, source_id)");

    // refresh_posthog_daily_rollups is RE-CREATED retention-aware: same signature (the frozen engine
    // bundle's CLOSE hook keeps calling it unchanged), backwards-window raise intact ON THE RAW
    // ARGUMENTS, p_from clamped to the watermark, and a fully-clamped-out window RETURNS — never a
    // delete. This is the trap fix: a post-prune refresh whose window reaches into pruned days (the
    // CLOSE hook's no-cursor `2000-01-01` shape included) must PRESERVE those days' rollup rows.
    expect(sql).toContain(
      "create or replace function refresh_posthog_daily_rollups( p_workspace_id text, p_source_id text, p_from date, p_to date )"
    );
    expect(sql).toContain("raise exception 'refresh_posthog_daily_rollups: from % after to %'");
    expect(sql).toContain("p_from := greatest(p_from, v_pruned_before)");
    expect(sql).toContain("if p_from > p_to then return; end if;");

    // prune_posthog_raw: UTC-pinned day bucket (0063 doctrine), deleted-row count returned, p_before
    // clamped to the config floor (raw the policy still guarantees is NEVER deletable through this
    // function, whatever a drifted caller passes), watermark advanced in the SAME transaction.
    expect(sql).toContain(
      "create or replace function prune_posthog_raw( p_workspace_id text, p_source_id text, p_before date ) returns bigint"
    );
    expect(sql).toContain("(now() at time zone 'utc')::date - retention_days");
    expect(sql).toContain("v_before := least(p_before, v_floor)");
    expect(sql).toContain("(occurred_at at time zone 'utc')::date < v_before");
    expect(sql).toContain("get diagnostics v_deleted = row_count");
    expect(sql).toContain(
      "on conflict (workspace_id, source_id) do update set pruned_before = greatest(posthog_prune_watermarks.pruned_before, excluded.pruned_before)"
    );

    // Prune and refresh serialize per (workspace, source) on the same advisory xact lock, so a prune
    // committing mid-refresh can never yield a partial rollup for a day that then falls below the
    // watermark forever (one lock call in each function).
    expect(sql.match(/pg_advisory_xact_lock/g)?.length).toBe(2);

    // Grants (0057 pattern): worker + guarded engine_app. Refresh callers read the watermark; prune
    // callers read the config, DELETE raw truth, and write the watermark.
    expect(sql).toContain(
      "grant select on posthog_retention_config to growth_os_worker, growth_os_app, growth_os_tool_agent"
    );
    expect(sql).toContain(
      "grant select, insert, update, delete on posthog_prune_watermarks to growth_os_worker"
    );
    expect(sql).toContain("grant select, delete on posthog_event_truth to growth_os_worker");
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");
    expect(sql).toContain("grant select, insert, update, delete on posthog_prune_watermarks to engine_app");
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'growth_os_read_api')");

    // Registry + views untouched: the app still reads the SAME rollup-backed views.
    expect(sql).not.toContain("update queryable_views");
    expect(sql).not.toContain("create or replace view");

    // The redefined conservation invariant must be stated in the migration itself — ops runbooks
    // elsewhere assert the OLD global equality, and this file is the durable correction.
    expect(sql).toContain("sum(event_count) = count(truth) holds only");
  });

  it("rolls the to-be-deleted window up INSIDE the prune, before the delete (0065)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0065_prune_rolls_up_before_deleting.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase().replace(/\s+/g, " ");

    // Same name/signature/return as 0064 — the retention cron keeps calling it unchanged.
    expect(sql).toContain(
      "create or replace function prune_posthog_raw( p_workspace_id text, p_source_id text, p_before date ) returns bigint"
    );

    // The fix itself: refresh the window about to be deleted, bounded at v_before - 1 so days whose
    // raw is still arriving are left to the CLOSE hook.
    expect(sql).toContain(
      "perform refresh_posthog_daily_rollups( p_workspace_id, p_source_id, v_window_start, v_before - 1 )"
    );
    // Window start: existing watermark first, min truth day as the fallback that rescues a source
    // whose first CLOSE never ran.
    expect(sql).toContain("select pruned_before from posthog_prune_watermarks");
    expect(sql).toContain("select min((occurred_at at time zone 'utc')::date) from posthog_event_truth");
    // The skip guard is load-bearing: refresh RAISES on from > to, so an empty window must not call it.
    expect(sql).toContain("if v_window_start is not null and v_window_start <= v_before - 1 then");

    // The rollup MUST precede the delete — order is the entire fix. Assert it positionally.
    expect(sql.indexOf("perform refresh_posthog_daily_rollups")).toBeLessThan(
      sql.indexOf("delete from posthog_event_truth")
    );

    // 0064's guarantees are carried forward verbatim, not quietly dropped in the re-create.
    expect(sql).toContain("v_before := least(p_before, v_floor)");
    expect(sql).toContain("into strict v_floor");
    expect(sql).toContain("(occurred_at at time zone 'utc')::date < v_before");
    expect(sql).toContain("get diagnostics v_deleted = row_count");
    expect(sql).toContain(
      "on conflict (workspace_id, source_id) do update set pruned_before = greatest(posthog_prune_watermarks.pruned_before, excluded.pruned_before)"
    );
    // Still exactly ONE lock ACQUISITION in this file (match the `perform`, not the header's prose
    // mention): the nested refresh re-takes the same lock, which is reentrant in-transaction — prune
    // must not grow a second acquisition of its own.
    expect(sql.match(/perform pg_advisory_xact_lock/g)?.length).toBe(1);

    // refresh_posthog_daily_rollups is NOT redefined here — 0064's clamped body stands.
    expect(sql).not.toContain("create or replace function refresh_posthog_daily_rollups");

    // Grants re-issued with the function (the 0053 / 2026-08-04 grantless doctrine), including the
    // rollup-table DML the nested refresh performs, guarded for the cloud role.
    expect(sql).toContain(
      "grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to growth_os_worker"
    );
    expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'engine_app')");

    // The scenario must be documented where the next reader of the function will find it.
    expect(sql).toContain("truth commits before the rollup exists");
    expect(sql).toContain("the retention cron enumerates sources from truth");
  });

  it("carries the cross-lane Stripe reconciliation additions somewhere in the stack", () => {
    // Placement-agnostic on purpose: these columns/counters may live in 0053, 0054, or 0056 as the
    // Stripe truth work settles, but the stack must always ship them.
    const sql = loadMigrations()
      .map((migration) => migration.sql)
      .join("\n")
      .toLowerCase()
      .replace(/\s+/g, " ");

    expect(sql).toContain("add column if not exists post_payment_credit_notes_amount bigint");
    expect(sql).toContain("add column if not exists pre_payment_credit_notes_amount bigint");
    expect(sql).toContain("post_payment_credited_minor");
    expect(sql).toContain("paid_missing_paid_at_invoices");
    expect(sql).toContain("pending_service_end_customer_count integer not null default 0");
  });

  it("creates the setup/onboarding tables, rotation columns, and role grants (0021)", () => {
    const migration = loadMigrations().find((m) => m.id === "0021_setup_onboarding.sql");
    const sql = (migration?.sql ?? "").toLowerCase();

    for (const table of ["workspace_sites", "setup_runs", "oauth_apps", "oauth_tokens"]) {
      expect(sql).toContain(`create table ${table}`);
    }
    expect(sql).toContain("setup_runs_active_unique_idx");
    expect(sql).toContain("where status in ('running', 'paused_handoff')");
    expect(sql).toContain("alter table connection_credentials");
    expect(sql).toContain("expires_at");
    expect(sql).toContain("last_rotated_at");
    expect(sql).toContain("encrypted_payload");
    expect(sql).toContain("grant select, insert, update on oauth_apps, oauth_tokens to growth_os_app");
    expect(sql).toContain("to growth_os_worker");
    expect(sql).not.toContain("to growth_os_tool_agent");
    expect(sql).not.toContain("to growth_os_read_api");
  });

  it("creates required first-phase tables and excludes deferred tables", () => {
    const sql = loadMigrations()
      .map((migration) => migration.sql)
      .join("\n")
      .toLowerCase();

    for (const table of [
      "workspaces",
      "datasets",
      "sources",
      "raw_records",
      "job_runs",
      "sync_schedules",
      "saved_reports",
      "saved_report_exports",
      "metric_definitions",
      "queryable_views",
      "ga4_report_snapshot_fact",
      "ga4_metadata_catalog",
      "posthog_event_truth",
      "posthog_person_current",
      "posthog_person_distinct_ids",
      "posthog_session_fact",
      "stripe_customers",
      "stripe_invoices",
      "stripe_invoice_lines",
      "stripe_subscriptions",
      "stripe_products",
      "stripe_prices",
      "x_post",
      "x_post_metric_snapshot",
      "x_profile_snapshot",
      "shopify_orders",
      "shopify_order_lines",
      "shopify_products",
      "meta_ads_campaign_daily",
      "meta_ads_campaigns",
      "meta_ads_campaign_conversions_daily",
      "meta_ads_adsets",
      "meta_ads_adset_daily",
      "meta_ads_adset_conversions_daily",
      "meta_ads_ads",
      "meta_ads_ad_daily",
      "meta_ads_ad_conversions_daily",
      "chat_sessions",
      "chat_messages",
      "chat_action_calls",
      "chat_session_summaries",
      "chat_memory_facts",
      "workspace_preferences",
      "metadata.context_cards",
      "metadata.journey_template_suggestions",
      "journey.actors",
      "journey.actor_identities",
      "journey.entities",
      "journey.touchpoint_facts",
      "journey.behavior_facts",
      "journey.conversion_facts",
      "journey.billing_facts",
      "journey.lifecycle_states",
      "journey.ltv_windows",
      "journey.evidence_refs"
    ]) {
      expect(sql).toContain(`create table ${table}`);
    }

    for (const table of FORBIDDEN_TABLES) {
      expect(sql).not.toContain(`create table ${table}`);
    }
  });

  it("keeps journey entity storage constraints aligned with the shared vocabulary", () => {
    const sql =
      loadMigrations().find(
        (migration) => migration.id === "0020_journey_core.sql"
      )?.sql ?? "";
    const match = sql.match(
      /entity_type text not null check \(entity_type in \(([^)]+)\)\)/
    );

    expect(match).toBeTruthy();
    const constrainedEntityTypes =
      match?.[1]
        .split(",")
        .map((value) => value.trim().replace(/^'|'$/g, ""))
        .sort() ?? [];
    expect(constrainedEntityTypes).toEqual([...JOURNEY_ENTITY_TYPES].sort());
  });

  it("creates only first-phase queryable views and metric seeds", () => {
    const sql = loadMigrations()
      .map((migration) => migration.sql)
      .join("\n");

    expect(sql).toContain("queryable.vw_site_traffic");
    expect(sql).toContain("queryable.vw_site_conversion_rate");
    expect(sql).toContain("queryable.vw_revenue_by_source");
    expect(sql).toContain("queryable.vw_recent_sync_status");
    expect(sql).toContain("queryable.vw_x_post_public_metrics");
    expect(sql).toContain("queryable.vw_shopify_orders");
    expect(sql).toContain("queryable.vw_shopify_products");
    expect(sql).toContain("queryable.vw_meta_ads_campaign_daily");
    // Phase-2 slice-1a — the adset-grain delivery + typed-conversions views.
    expect(sql).toContain("queryable.vw_meta_ads_adset_daily");
    expect(sql).toContain("queryable.vw_meta_ads_adset_conversions_daily");
    // Phase-2 slice-1b — the ad-grain delivery + typed-conversions views.
    expect(sql).toContain("queryable.vw_meta_ads_ad_daily");
    expect(sql).toContain("queryable.vw_meta_ads_ad_conversions_daily");
    // Slice-1 PostHog audience view (0043) + its metric.
    expect(sql).toContain("queryable.vw_posthog_site");
    expect(sql).toContain("'posthog_page_views'");
    expect(sql).toContain("'site_visitors'");
    expect(sql).toContain("'signup_count'");
    expect(sql).toContain("'site_conversion_rate'");
    expect(sql).toContain("'recognized_revenue'");
    expect(sql).toContain("'x_public_engagement'");
    expect(sql).toContain("'shopify_gross_sales'");
    expect(sql).toContain("'shopify_order_count'");
    expect(sql).toContain("'meta_ads_spend'");
    expect(sql).toContain("'meta_ads_clicks'");
    expect(sql).toContain("'page_views'");
    expect(sql).toContain("'new_users'");
    expect(sql).toContain("'engaged_sessions'");
    expect(sql).toContain("'key_events'");
    expect(sql).toContain("'engagement_rate'");
    expect(sql).toContain("'average_session_duration'");
  });

  it("seeds the sessions metric bound to vw_site_traffic with a sum aggregate (0042)", () => {
    const migration = loadMigrations().find((m) => m.id === "0042_sessions_metric_seed.sql");
    const sql = (migration?.sql ?? "").toLowerCase();

    // The metric id row + its routing (vw_site_traffic, additive sum(sessions)) — the seed
    // list_metrics / describe_metric hydrate so `sessions` becomes discoverable.
    expect(sql).toContain("insert into metric_definitions");
    expect(sql).toContain("'sessions'");
    expect(sql).toContain("queryable.vw_site_traffic");
    expect(sql).toContain('"column":"sessions","aggregate":"sum"');
    expect(sql).toContain("'occurred_on'");
    expect(sql).toContain("session_default_channel_group");
    // Idempotent upsert — re-applying the migration stack never dupes the row.
    expect(sql).toContain("on conflict (id) do update");
  });

  it("builds the PostHog audience view + pageview metric over posthog_event_truth.properties (0043)", () => {
    const migration = loadMigrations().find((m) => m.id === "0043_posthog_audience_view.sql");
    const sql = (migration?.sql ?? "").toLowerCase();

    // A new queryable view over the ALREADY-synced truth table (no new sync/backfill).
    expect(sql).toContain("create view queryable.vw_posthog_site");
    expect(sql).toContain("from posthog_event_truth");

    // Audience dims extracted from properties JSONB and aliased into real columns (so the
    // engine's dimensionExpression stays identity).
    expect(sql).toContain("properties->>'$device_type'");
    expect(sql).toContain("properties->>'$os' as operating_system");
    expect(sql).toContain("properties->>'$browser' as browser");
    expect(sql).toContain("properties->>'$geoip_country_name' as country");
    expect(sql).toContain("properties->>'$geoip_subdivision_1_name' as region");
    expect(sql).toContain("properties->>'$geoip_city_name' as city");
    // $device_type is lower-cased to the mobile/desktop/tablet convention.
    expect(sql).toContain("lower(properties->>'$device_type') as device_type");

    // Scoped to client-side $pageview events (honest coverage; count(*) means pageviews).
    expect(sql).toContain("where event_name = '$pageview'");
    expect(sql).toContain("count(*) as posthog_page_views");

    // The additive pageview metric routes to the audience view, sum aggregate.
    expect(sql).toContain("insert into metric_definitions");
    expect(sql).toContain("'posthog_page_views'");
    expect(sql).toContain('"column":"posthog_page_views","aggregate":"sum"');

    // PostHog-sibling grant target: tool_agent + app ONLY. The GRANT must NOT extend to the
    // three-role form that includes growth_os_read_api (the divergence the comment documents).
    expect(sql).toContain("grant select on queryable.vw_posthog_site to growth_os_tool_agent, growth_os_app");
    expect(sql).not.toContain("to growth_os_tool_agent, growth_os_app, growth_os_read_api");

    // Idempotent + non-destructive. The view uses `drop view if exists` (re-runnability);
    // forbid destructive table/column drops + deletes.
    expect(sql).toContain("on conflict (id) do update");
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("delete from");
  });

  it("preserves first-phase provider-truth and sync contract columns", () => {
    const sql = loadMigrations()
      .map((migration) => migration.sql)
      .join("\n")
      .toLowerCase();

    for (const required of [
      "sync_batch_records",
      "record_lineage",
      "tool_execution_log",
      "reporting_date",
      "landing_page",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "paid_at",
      "amount_cents",
      "external_order_id",
      "x_post_id",
      "public_metrics",
      "impression_count",
      "record_lineage_provider_row_unique",
      "artifact_path",
      "unique (source_id, cursor_key)",
      "unique (source_id, event_id)",
      "unique (source_id, stripe_invoice_id)",
      "unique (source_id, x_post_id)",
      "unique (source_id, x_post_id, captured_at)",
      "unique (source_id, shopify_order_id)",
      "unique (source_id, shopify_line_item_id)",
      "unique (source_id, shopify_product_id)",
      "unique (source_id, ad_account_id, campaign_id, occurred_on)",
      "unique (source_id, reporting_date, host_name, page_path)"
    ]) {
      expect(sql).toContain(required);
    }
  });

  it("creates the LLM runtime schema with bounded transcript and memory tables", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0012_llm_runtime.sql"
    );
    const sql = migration?.sql.toLowerCase() ?? "";

    for (const required of [
      "session_key",
      "actor_id",
      "model_provider",
      "model_auth_source",
      "provider_message_id",
      "reasoning_metadata_json",
      "codex_message_items_json",
      "codex_reasoning_items_json",
      "provider_tool_call_id",
      "requires_confirmation",
      "confirmation_id",
      "input_hash",
      "summary_json",
      "blocked_reason",
      "preferred_source_ids",
      "chat_messages_content_search_idx",
      "to_tsvector",
      "chat_messages_session_created_idx",
      "chat_action_calls_session_created_idx",
      "chat_memory_facts_workspace_scope_idx"
    ]) {
      expect(sql).toContain(required);
    }
    expect(sql).not.toContain("raw_payload");
    expect(sql).not.toContain("credential");
  });

  it("adds an active-memory unique index for DB-level fact de-dupe", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0013_chat_memory_fact_dedupe.sql"
    );
    const sql = migration?.sql.toLowerCase() ?? "";

    for (const required of [
      "row_number() over",
      "partition by workspace_id, scope, lower(fact)",
      "chat_memory_facts_active_unique_idx",
      "create unique index",
      "where blocked_reason is null"
    ]) {
      expect(sql).toContain(required);
    }
  });

  it("adds metadata context-card storage and search indexes", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0019_metadata_context_cards.sql"
    );
    const sql = migration?.sql.toLowerCase() ?? "";

    for (const required of [
      "create schema if not exists metadata",
      "create table metadata.context_cards",
      "create table metadata.journey_template_suggestions",
      "workspace_id text references workspaces(id)",
      "workspace_id text not null references workspaces(id)",
      "metadata_context_cards_global_unique",
      "where workspace_id is null",
      "metadata_context_cards_workspace_unique",
      "where workspace_id is not null",
      "metadata_context_cards_search_idx",
      "to_tsvector('english', searchable_text)"
    ]) {
      expect(sql).toContain(required);
    }
  });

  it("adds journey core storage with policy-versioned facts and workspace/time indexes", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0020_journey_core.sql"
    );
    const sql = migration?.sql.toLowerCase() ?? "";

    for (const required of [
      "create schema if not exists journey",
      "create table journey.actors",
      "create table journey.actor_identities",
      "create table journey.entities",
      "create table journey.touchpoint_facts",
      "create table journey.behavior_facts",
      "create table journey.conversion_facts",
      "create table journey.billing_facts",
      "create table journey.lifecycle_states",
      "create table journey.ltv_windows",
      "create table journey.evidence_refs",
      "policy_id text not null",
      "policy_version integer not null",
      "journey_touchpoint_workspace_time_idx",
      "journey_touchpoint_actor_time_idx",
      "journey_behavior_workspace_time_idx",
      "journey_behavior_actor_time_idx",
      "journey_behavior_event_time_idx",
      "journey_conversion_actor_time_idx",
      "journey_billing_actor_time_idx",
      "journey_lifecycle_actor_as_of_idx",
      "journey_ltv_window_unique_idx",
      "coalesce(currency, '')"
    ]) {
      expect(sql).toContain(required);
    }

    expect(sql.match(/policy_version integer not null/g)?.length).toBe(2);
    expect(sql).not.toContain("grant select on all tables in schema journey");
  });

  it("keeps incremental upgrades after 0018 scoped to metadata and journey migrations", () => {
    const alreadyAppliedThrough0018 = new Set(
      loadMigrations()
        .map((migration) => migration.id)
        .filter((id) => id <= "0018_x_authored_activity_drilldown_action.sql")
    );

    const pending = loadMigrations()
      .map((migration) => migration.id)
      .filter((id) => !alreadyAppliedThrough0018.has(id));

    expect(pending).toEqual([
      "0019_metadata_context_cards.sql",
      "0020_journey_core.sql",
      "0021_setup_onboarding.sql",
      "0022_posthog_event_queryable_view.sql",
      "0023_connection_credentials_oauth_token_fk.sql",
      "0024_ga4_analytics_v1.sql",
      "0025_ga4_page_report.sql",
      "0026_workspace_site_ga4_link.sql",
      "0027_exclude_dev_host_traffic.sql",
      "0028_meta_write_dedup.sql",
      "0029_meta_ads_extended_metric_seeds.sql",
      "0030_meta_ads_campaigns.sql",
      "0031_meta_ads_campaign_conversions_daily.sql",
      "0032_meta_ads_campaign_daily_conversion_columns.sql",
      "0033_meta_ads_conversion_views_and_metric_seeds.sql",
      "0034_meta_stripe_true_value_and_frequency.sql",
      "0035_meta_ads_adset_grain.sql",
      "0036_chat_sessions_desktop_surface.sql",
      "0037_meta_ads_ad_grain.sql",
      "0038_chat_action_calls_workspace_id.sql",
      "0039_connection_credentials_metadata.sql",
      "0040_workspace_owner_id.sql",
      "0041_fail_forever_queued_connector_jobs.sql",
      "0042_sessions_metric_seed.sql",
      "0043_posthog_audience_view.sql",
      "0044_sources_consecutive_sync_failures.sql",
      "0045_sources_last_counted_sync_failure_at.sql",
      "0046_analytics_fact_table_indexes.sql",
      "0047_stripe_paid_subscribers_metric.sql",
      "0048_stripe_subscription_lifecycle_metrics.sql",
      "0049_engine_app_stripe_subscription_items_grant.sql",
      "0050_stripe_customer_metrics_classification.sql",
      "0051_stripe_churn_requires_payment.sql",
      "0052_stripe_revenue_uses_amount_paid.sql",
      "0053_stripe_business_metric_eligibility.sql",
      "0054_stripe_invoice_reconciliation.sql",
      "0055_stripe_recurring_value_truth.sql",
      "0056_stripe_customer_mrr_movements.sql",
      "0057_stripe_trial_cohorts.sql",
      "0058_stripe_delta_sync.sql",
      "0059_stripe_reconciliation_drift.sql",
      "0060_posthog_exclude_internal_from_app_views.sql",
      "0061_ga4_event_report_and_snapshot_replacement.sql",
      "0062_same_lane_site_conversion_rate.sql",
      "0063_posthog_daily_rollups.sql",
      "0064_posthog_raw_retention.sql",
      "0065_prune_rolls_up_before_deleting.sql"
    ]);
  });

  it("adds connection_credentials operational metadata + partial-unique index (0039)", () => {
    const migration = loadMigrations().find(
      (m) => m.id === "0039_connection_credentials_metadata.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();

    // Targets connection_credentials.
    expect(sql).toContain("alter table connection_credentials");

    // The 5 non-secret operational columns the engine queries without decrypting.
    expect(sql).toContain("add column if not exists selected_pixel_id");
    expect(sql).toContain("add column if not exists is_system_user");
    expect(sql).toContain("add column if not exists last_dispatch_at");
    expect(sql).toContain("add column if not exists last_dispatch_status");
    expect(sql).toContain("add column if not exists last_error");

    // is_system_user is NOT NULL DEFAULT false (safe on existing rows).
    expect(sql).toContain("is_system_user");
    expect(sql).toMatch(/is_system_user\s+boolean\s+not null\s+default false/);

    // Token expiry reuses the EXISTING expires_at column (0021) — must NOT add token_expires_at
    // (the comment may mention the name; assert no column is actually ADDED for it).
    expect(sql).not.toMatch(/add column[^;]*token_expires_at/);
    // account_external_id lives on sources — must NOT be denormalized here (no column added).
    expect(sql).not.toMatch(/add column[^;]*account_external_id/);

    // Partial-unique index so P0-B2's `on conflict (source_id, credential_kind)` upsert binds.
    expect(sql).toContain("create unique index if not exists connection_credentials_source_kind_uq");
    expect(sql).toContain("(source_id, credential_kind)");
    expect(sql).toContain("where revoked_at is null");
  });

  it("bridges connection_credentials to oauth_tokens additively and backfills GA4 (0023)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0023_connection_credentials_oauth_token_fk.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();

    expect(sql).toContain("alter table connection_credentials");
    expect(sql).toContain("add column if not exists oauth_token_id text references oauth_tokens (id)");
    // Backfill only touches active GA4 OAuth-access-token rows.
    expect(sql).toContain("update connection_credentials");
    expect(sql).toContain("cc.credential_kind = 'oauth_access_token'");
    expect(sql).toContain("s.provider = 'google_analytics_4'");
    expect(sql).toContain("ot.revoked_at is null");
    // Additive only: no drops or destructive changes.
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("delete from");
  });

  it("adds GA4 traffic fact columns, swaps the unique key, and seeds traffic metrics additively (0024)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0024_ga4_analytics_v1.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();

    // 2a — additive fact columns.
    expect(sql).toContain("add column if not exists screen_page_views");
    expect(sql).toContain("add column if not exists session_default_channel_group");
    expect(sql).toContain("add column if not exists device_category");
    expect(sql).toContain("add column if not exists host_name");

    // 2b — unique-key swap (drop-if-exists then add the canonical 10-column constraint).
    // Whitespace-robust: collapse internal whitespace so a reformat of the SQL (newlines/indent)
    // does not break this for a non-substantive reason. Still asserts the same 10 columns in order.
    const collapsedSql = sql.replace(/\s+/g, " ");
    expect(collapsedSql).toContain("ga4_report_snapshot_unique");
    expect(collapsedSql).toContain("drop constraint if exists ga4_report_snapshot_unique");
    expect(collapsedSql).toContain(
      "unique (source_id, reporting_date, country, landing_page, utm_source, utm_medium, utm_campaign, session_default_channel_group, device_category, host_name)"
    );

    // 2c — view recreate preserves metricColumn identity via aliasing.
    expect(sql).toContain("screen_page_views as page_views");

    // 2d — idempotent registry seeds.
    expect(sql).toContain("on conflict (id) do update");

    // Additive only: no destructive drops of data. 0024 legitimately uses
    // `drop view if exists` and `drop constraint if exists`, so DO NOT assert
    // a broad not.toContain("drop").
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("delete from");
  });

  it("adds the GA4 page-report fact, view, and metric seed purely additively (0025)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0025_ga4_page_report.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();

    // 7a — new high-card page fact table with its own upsert key.
    expect(sql).toContain("create table if not exists ga4_page_report_fact");
    expect(sql).toContain("ga4_page_report_unique");
    // Whitespace-robust assertion of the page upsert key.
    const collapsedSql = sql.replace(/\s+/g, " ");
    expect(collapsedSql).toContain(
      "unique (source_id, reporting_date, host_name, page_path)"
    );

    // 7b — new view aliases screen_page_views -> page_views (metricColumn identity).
    expect(sql).toContain("create view queryable.vw_site_pages");
    expect(sql).toContain("screen_page_views as page_views");

    // 7c — idempotent registry seeds for the page view + metric.
    expect(sql).toContain("'page_views_by_page'");
    expect(sql).toContain("on conflict (id) do update");

    // 7d — worker write grant on the new fact table.
    expect(sql).toContain("grant select, insert, update on ga4_page_report_fact to growth_os_worker");

    // Purely additive: a new table/view, no destructive changes. 0025 has no
    // drop/swap at all, so no `drop view`/`drop constraint` exceptions are needed.
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("delete from");
  });

  it("links workspace_sites to a GA4 source via a nullable FK column purely additively (0026)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0026_workspace_site_ga4_link.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();

    // 11 — single nullable FK column added to the existing workspace_sites table.
    expect(sql).toContain("alter table workspace_sites");
    expect(sql).toContain("add column if not exists ga4_source_id");
    expect(sql).toContain("references sources");
    expect(sql).toContain("on delete set null");

    // Purely additive: no drops at all (no view/constraint swaps in 0026), no deletes.
    expect(sql).not.toContain("drop");
    expect(sql).not.toContain("delete from");
  });

  it("excludes localhost/dev-host traffic from all three GA4 views via CREATE OR REPLACE (0027)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0027_exclude_dev_host_traffic.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();
    const collapsedSql = sql.replace(/\s+/g, " ");

    // All three target views are recreated with CREATE OR REPLACE (columns unchanged).
    expect(sql).toContain("create or replace view queryable.vw_site_traffic");
    expect(sql).toContain("create or replace view queryable.vw_site_pages");
    expect(sql).toContain("create or replace view queryable.vw_site_conversion_rate");

    // The same case-insensitive host-exclusion predicate is applied to all three views
    // (incl. vw_site_conversion_rate's inner ga4 CTE), keeping NULL/other hosts and
    // dropping only localhost/127.0.0.1.
    const predicate =
      "where (host_name is null or lower(host_name) not in ('localhost', '127.0.0.1'))";
    expect(collapsedSql.match(new RegExp(predicate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(3);

    // Each view still reads its original fact table (no source-table drift).
    expect(sql).toContain("from ga4_report_snapshot_fact");
    expect(sql).toContain("from ga4_page_report_fact");

    // Column-preserving REPLACE only — no destructive statements.
    expect(sql).not.toContain("drop view");
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("delete from");

    // Recreated views must be re-granted to the read roles.
    expect(sql).toContain(
      "grant select on queryable.vw_site_traffic to growth_os_tool_agent, growth_os_app, growth_os_read_api"
    );
    expect(sql).toContain(
      "grant select on queryable.vw_site_pages to growth_os_tool_agent, growth_os_app, growth_os_read_api"
    );
    expect(sql).toContain(
      "grant select on queryable.vw_site_conversion_rate to growth_os_tool_agent, growth_os_app, growth_os_read_api"
    );
  });

  it("seeds metric_definitions catalog rows for impressions/reach/cpm/cpc/ctr bound to the meta view (0029)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0029_meta_ads_extended_metric_seeds.sql"
    );
    const sql = migration?.sql ?? "";
    const lower = sql.toLowerCase();

    // The five previously-unregistered Meta Ads metrics now have catalog rows so
    // describe_metric / list_metrics / search_context can return full
    // authority+provenance metadata for them (closing the catalog gap).
    for (const metricId of ["'impressions'", "'reach'", "'cpm'", "'cpc'", "'ctr'"]) {
      expect(sql).toContain(metricId);
    }

    // All five are bound to the same authority view as meta_ads_spend/meta_ads_clicks.
    expect(sql.match(/queryable\.vw_meta_ads_campaign_daily/g)?.length).toBeGreaterThanOrEqual(5);

    // Same read-only marketing-api authority carried on every row.
    expect(lower.match(/read_only_marketing_api_reporting/g)?.length).toBeGreaterThanOrEqual(5);

    // reach is flagged APPROXIMATE (summing daily reach overcounts unique people).
    expect(lower).toContain("reach_is_approximate_summed_daily_reach_overcounts_unique_people");

    // The ratio metrics encode the summed-base recompute semantics + caveat, and
    // must NOT be averaged from per-row ratios.
    // One caveat per ratio row (cpm/cpc/ctr); the header comment also references it.
    expect(lower.match(/ratio_recomputed_from_summed_bases/g)?.length).toBeGreaterThanOrEqual(3);
    expect(lower).toContain("sum(meta_ads_spend) / nullif(sum(impressions),0) * 1000"); // cpm
    expect(lower).toContain("sum(meta_ads_spend) / nullif(sum(meta_ads_clicks),0)"); // cpc
    expect(lower).toContain("sum(meta_ads_clicks) / nullif(sum(impressions),0)"); // ctr
    expect(lower).not.toContain("avg(cpm)");
    expect(lower).not.toContain("avg(cpc)");
    expect(lower).not.toContain("avg(ctr)");

    // Idempotent additive seed: upsert, no destructive statements.
    expect(lower).toContain("on conflict (id) do update set");
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("drop column");
    expect(lower).not.toContain("delete from");
  });

  it("creates the Meta Ads campaign dimension with the load-bearing currency column (0030)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0030_meta_ads_campaigns.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();
    const collapsed = sql.replace(/\s+/g, " ");

    expect(sql).toContain("create table meta_ads_campaigns");
    // §2.1 columns incl. the load-bearing account currency.
    for (const col of ["objective", "effective_status", "configured_status", "currency"]) {
      expect(sql).toContain(col);
    }
    // Campaign-grain identity (one row per campaign per source/account).
    expect(collapsed).toContain("unique (source_id, ad_account_id, campaign_id)");
    // Worker ingests the dimension; grant guarded for a fresh DB (0028 pattern).
    expect(sql).toContain("grant select, insert, update on meta_ads_campaigns to growth_os_worker");
    expect(sql).toContain("if exists (select from pg_roles where rolname = 'growth_os_worker')");
    // Additive table create only — no destructive statements.
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("delete from");
  });

  it("creates the typed conversions child fact at campaign x day x result_type grain (0031)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0031_meta_ads_campaign_conversions_daily.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();
    const collapsed = sql.replace(/\s+/g, " ");

    expect(sql).toContain("create table meta_ads_campaign_conversions_daily");
    // §2.3 columns: typed grain + guarded value + provenance.
    for (const col of [
      "result_type",
      "results",
      "conversion_value",
      "attribution_setting",
      "is_primary",
      "results_source"
    ]) {
      expect(sql).toContain(col);
    }
    // The typed grain is enforced by the unique key INCLUDING result_type — a
    // lead+purchase campaign-day gets BOTH rows, no loser dropped.
    expect(collapsed).toContain(
      "unique (source_id, ad_account_id, campaign_id, occurred_on, result_type)"
    );
    // result_type travels on every row (NOT NULL) so CPL/CPA can never blend.
    expect(collapsed).toContain("result_type text not null");
    // Worker restates this fact; grant guarded for a fresh DB.
    expect(sql).toContain(
      "grant select, insert, update on meta_ads_campaign_conversions_daily to growth_os_worker"
    );
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("delete from");
  });

  it("extends the delivery fact additively WITHOUT scalar results/result_type or per-window columns (0032)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0032_meta_ads_campaign_daily_conversion_columns.sql"
    );
    const sql = (migration?.sql ?? "").toLowerCase();

    expect(sql).toContain("alter table meta_ads_campaign_daily");
    // §2.2 additive columns, all `if not exists`.
    for (const col of [
      "add column if not exists currency",
      "add column if not exists inline_link_clicks",
      "add column if not exists landing_page_views",
      "add column if not exists attribution_setting",
      "add column if not exists actions_raw jsonb",
      "add column if not exists api_version"
    ]) {
      expect(sql).toContain(col);
    }
    // §2.2 invariant: NO scalar results/result_type on the delivery fact (that
    // would force one type to win — the Ultima corruption). It lives on the child
    // fact (0031) instead.
    expect(sql).not.toContain("add column if not exists result_type");
    expect(sql).not.toContain("add column if not exists results ");
    // §2.2 invariant: NO parallel per-window columns — per-window lives in actions_raw.
    // Assert no `add column` line introduces an attribution-window-named column.
    const addColumnLines = sql
      .split("\n")
      .filter((line) => line.includes("add column"));
    for (const line of addColumnLines) {
      expect(line).not.toMatch(/7d_click|1d_view|1d_click|28d/);
    }
    // Purely additive: no drops/deletes.
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("delete from");
  });

  it("recreates the meta view via DROP CASCADE, adds the conversions view, re-grants, and seeds Phase-1 metrics (0033)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0033_meta_ads_conversion_views_and_metric_seeds.sql"
    );
    const sql = migration?.sql ?? "";
    const lower = sql.toLowerCase();
    const collapsed = lower.replace(/\s+/g, " ");

    // §3.4 — the delivery view is recreated via DROP CASCADE (column add/retype),
    // NOT create-or-replace (which cannot add columns mid-list).
    expect(collapsed).toContain("drop view if exists queryable.vw_meta_ads_campaign_daily cascade");
    expect(lower).toContain("create view queryable.vw_meta_ads_campaign_daily");
    expect(lower).not.toContain("create or replace view queryable.vw_meta_ads_campaign_daily");
    // The recreated view surfaces the new §2.2 measures (non-omni LPV + link clicks).
    expect(lower).toContain("inline_link_clicks as link_clicks");
    expect(lower).toContain("landing_page_views");
    expect(lower).toContain("currency");
    // New typed-conversions view exposing result_type as a column.
    expect(lower).toContain("create view queryable.vw_meta_ads_campaign_conversions_daily");

    // §3.5 — Phase-1 metric seeds.
    for (const metricId of [
      "'results'",
      "'cost_per_result'",
      "'conversion_value'",
      "'roas'",
      "'link_clicks'",
      "'landing_page_views'"
    ]) {
      expect(sql).toContain(metricId);
    }
    // result_type + objective as a REQUIRED partition (required_filters, not just a dim).
    expect(lower).toContain('"partition_by":["result_type","objective"]');
    // Load-bearing caveats: never blend CPL/CPA across types; value/roas in account currency.
    expect(lower).toContain("cost_per_result_must_not_blend_across_result_types");
    expect(lower).toContain("value_in_account_currency");
    // Recompute-from-summed-bases for the ratios; never per-row avg.
    expect(lower).toContain("sum(meta_ads_spend)");
    expect(lower).toContain("sum(results)");
    expect(lower).toContain("sum(conversion_value)");
    expect(lower).not.toContain("avg(cost_per_result)");
    expect(lower).not.toContain("avg(roas)");

    // §3.4 GRANT divergence trap: re-grant to tool_agent + app ONLY (the meta view
    // never had growth_os_read_api, unlike the 0027 GA4 views).
    expect(lower).toContain(
      "grant select on queryable.vw_meta_ads_campaign_daily, queryable.vw_meta_ads_campaign_conversions_daily to growth_os_tool_agent, growth_os_app"
    );
    expect(collapsed).not.toContain("to growth_os_tool_agent, growth_os_app, growth_os_read_api");

    // Idempotent additive seeds. 0033 legitimately uses `drop view if exists`, so do
    // NOT assert a broad not.toContain("drop"); only forbid destructive table/column drops.
    expect(lower).toContain("on conflict (id) do update set");
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("drop column");
    expect(lower).not.toContain("delete from");
  });

  // §5 + §6 — the Meta<->Stripe true-value join + the conversions-view spend recreate +
  // the frequency / roas_from_stripe seeds (0034).
  it("builds the Meta<->Stripe true-value join with a match_confidence signal, currency reconciliation, and unmatched totals (0034)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0034_meta_stripe_true_value_and_frequency.sql"
    );
    const sql = migration?.sql ?? "";
    const lower = sql.toLowerCase();
    const collapsed = lower.replace(/\s+/g, " ");

    // The conversions view is recreated via DROP CASCADE so cost_per_result/roas can divide
    // by delivery spend co-resident in the SAME view (the engine never joins two views).
    expect(collapsed).toContain(
      "drop view if exists queryable.vw_meta_ads_campaign_conversions_daily cascade"
    );
    expect(lower).toContain("create view queryable.vw_meta_ads_campaign_conversions_daily");
    expect(lower).toContain("d.spend as meta_ads_spend");

    // §5 mapping table keyed on the IMMUTABLE campaign_id, with a normalized fallback key and
    // the match_confidence enum (exact|normalized|fuzzy|unmatched) constrained at the DB level.
    expect(lower).toContain("create table meta_ads_campaign_revenue_map");
    expect(lower).toContain("campaign_id text not null");
    expect(lower).toContain("normalized_name text");
    expect(collapsed).toContain(
      "match_confidence text not null default 'unmatched' check (match_confidence in ('exact', 'normalized', 'fuzzy', 'unmatched'))"
    );

    // §5 join view: matched + unmatched spend/revenue totals (the join-quality signal).
    expect(lower).toContain("create view queryable.vw_meta_stripe_campaign_value_daily");
    expect(lower).toContain("matched_spend_major");
    expect(lower).toContain("matched_revenue_major");
    expect(lower).toContain("unmatched_spend_major");
    expect(lower).toContain("unmatched_revenue_major");
    expect(lower).toContain("match_confidence");

    // §5 currency reconciliation BEFORE dividing: Stripe cents -> major units (/100.0), and
    // revenue is matched ONLY when the Stripe currency equals the account currency (no FX).
    expect(lower).toContain("/ 100.0");
    expect(lower).toContain("lower(r.currency) = s.account_currency");

    // §5 DOUBLE-COUNT GUARD (finding #4): a Stripe source mapped to N campaigns must NOT fan
    // the full source-day revenue onto every campaign (account-level roas_from_stripe sums
    // matched_revenue_major across campaigns and would inflate ROAS ~N-fold). The view totals
    // revenue ONCE per revenue-source-day (a distinct-source-day CTE) and attributes the whole
    // total to a SINGLE representative campaign per source-day via row_number()=1. A revert to
    // grouping revenue by campaign_id directly off `spend` reintroduces the fan-out and fails.
    expect(lower).toContain("source_day_revenue");
    expect(lower).toContain("mapped_campaign_pick");
    expect(lower).toContain("row_number() over");
    expect(collapsed).toContain("where p.rn = 1");
    // The revenue total is computed over a DISTINCT revenue-source-day set, not per campaign.
    expect(lower).toContain("select distinct");
    // Guard the guard: the old per-campaign revenue group-by (the fan-out) must be gone.
    expect(collapsed).not.toContain(
      "group by s.workspace_id, s.source_id, s.ad_account_id, s.campaign_id, s.occurred_on"
    );

    // §6 seeds for frequency (delivery view) + roas_from_stripe (join view), recomputed from
    // summed bases — never per-row avg.
    expect(sql).toContain("'frequency'");
    expect(sql).toContain("'roas_from_stripe'");
    expect(lower).toContain("sum(matched_revenue_major)");
    expect(lower).toContain("sum(impressions)");
    expect(lower).toContain("stripe_attributed_roas_is_mapping_dependent");
    expect(lower).not.toContain("avg(roas_from_stripe)");
    expect(lower).not.toContain("avg(frequency)");

    // GRANT divergence trap: tool_agent + app ONLY (NOT growth_os_read_api).
    expect(lower).toContain(
      "grant select on queryable.vw_meta_ads_campaign_conversions_daily, queryable.vw_meta_stripe_campaign_value_daily to growth_os_tool_agent, growth_os_app"
    );
    expect(collapsed).not.toContain(
      "to growth_os_tool_agent, growth_os_app, growth_os_read_api"
    );

    // Idempotent + non-destructive (the conversions-view recreate uses drop view if exists,
    // which is allowed; forbid destructive table/column drops + deletes).
    expect(lower).toContain("on conflict (id) do update set");
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("drop column");
    expect(lower).not.toContain("delete from");
  });

  // Phase-2 slice-1a §2/§3/§9 — the adset grain + on/off status migration (0035). Asserts the
  // load-bearing structural contracts the §9 acceptance gate depends on: the dim carries status,
  // every adset fact is RE-KEYED on adset_id (the #1 corruption fix), the views alias columns
  // IDENTICALLY to the campaign views (so the §5 resolver swaps only the NAME) AND expose
  // status + campaign_id, the conversions view LEFT JOINs its OWN adset-grain spend (never
  // campaign spend — no N-counting), the partition stays result_type-only, and the grant target
  // is tool_agent + app ONLY.
  it("creates the adset grain (dim+facts+views) re-keyed on adset_id with status and own-grain spend (0035)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0035_meta_ads_adset_grain.sql"
    );
    const sql = migration?.sql ?? "";
    const lower = sql.toLowerCase();
    const collapsed = lower.replace(/\s+/g, " ");

    // §2.1 — the dim carries BOTH status columns + the per-adset optimization_goal/billing_event
    // and the carried campaign_id, unique on (source_id, ad_account_id, adset_id).
    expect(lower).toContain("create table meta_ads_adsets");
    for (const col of ["effective_status", "configured_status", "optimization_goal", "billing_event"]) {
      expect(lower).toContain(col);
    }
    expect(collapsed).toContain("unique (source_id, ad_account_id, adset_id)");

    // §2.2/§2.3 — the two fact tables and their RE-KEYED unique keys (adset_id, NOT campaign_id —
    // the #1 corruption fix). The conversions key additionally pins result_type (the partition).
    expect(lower).toContain("create table meta_ads_adset_daily");
    expect(lower).toContain("create table meta_ads_adset_conversions_daily");
    expect(collapsed).toContain("unique (source_id, ad_account_id, adset_id, occurred_on)");
    expect(collapsed).toContain("unique (source_id, ad_account_id, adset_id, occurred_on, result_type)");
    // result_type is NOT NULL on the conversions fact (the REQUIRED partition is structural).
    expect(collapsed).toContain("result_type text not null");
    // campaign_id is CARRIED on every adset table (the §5e coarser-filter case) but is never the
    // row key — assert it is present as a plain column on each.
    expect(lower).toContain("campaign_id text not null");
    // Race-tolerant (§7a): the facts carry adset_id/campaign_id with NO hard FK to the dim
    // (mirrors the campaign topology). Forbid an accidental hard FK on the facts.
    expect(lower).not.toContain("references meta_ads_adsets");

    // §3 — the two views. Aliases IDENTICAL to the campaign views (so the resolver swaps only the
    // NAME), PLUS the net-new adset identity + on/off status dims.
    expect(lower).toContain("create view queryable.vw_meta_ads_adset_daily");
    expect(lower).toContain("create view queryable.vw_meta_ads_adset_conversions_daily");
    expect(lower).toContain("d.spend as meta_ads_spend");
    expect(lower).toContain("d.clicks as meta_ads_clicks");
    expect(lower).toContain("d.inline_link_clicks as link_clicks");
    // Status + the parent campaign_id are exposed as columns on the views (for filter + label).
    expect(lower).toContain("dim.effective_status");
    expect(lower).toContain("dim.configured_status");
    expect(lower).toContain("d.adset_id");
    expect(lower).toContain("c.campaign_id");

    // §3 NO N-COUNTING: the conversions view LEFT JOINs its OWN adset-grain delivery spend
    // (meta_ads_adset_daily on adset_id + occurred_on), NEVER campaign spend. Joining campaign
    // spend onto N adset rows would N-count it — the corruption the no-roll-up rule forbids in
    // reverse. Assert the join is to the adset delivery fact keyed on adset_id.
    expect(collapsed).toContain("left join meta_ads_adset_daily d on d.source_id = c.source_id");
    expect(collapsed).toContain("and d.adset_id = c.adset_id");
    expect(collapsed).toContain("and d.occurred_on = c.occurred_on");
    // The conversions view must NOT read the campaign delivery fact for spend — assert no
    // FROM/JOIN against meta_ads_campaign_daily (the bare string also appears in doc comments
    // that reference mirroring 0015/0033, so forbid the load-bearing clause forms, not the word).
    expect(collapsed).not.toContain("join meta_ads_campaign_daily");
    expect(collapsed).not.toContain("from meta_ads_campaign_daily");

    // §3.4 — the metric_definitions expansion: partition = result_type ONLY at adset grain (the
    // campaign seed's two-element {result_type,objective} is dropped). Assert the single-element
    // partition is written and the two-element form is NOT present in this migration.
    expect(lower).toContain('"partition_by":["result_type"]');
    expect(lower).not.toContain('"partition_by":["result_type","objective"]');
    // The allowed_dimensions expansion adds the adset + status dims (NO new metric IDs — §6).
    expect(lower).toContain('"adset_id"');
    expect(lower).toContain('"effective_status"');
    expect(lower).toContain('"configured_status"');

    // §3 — recompute-from-summed-bases stays byte-identical (only the view name swapped): the
    // views alias spend/results/conversion_value so the engine's ratio expressions are unchanged.
    // No avg-of-ratios anywhere in the migration.
    expect(lower).not.toContain("avg(cost_per_result)");
    expect(lower).not.toContain("avg(roas)");

    // §3 GRANT divergence trap: tool_agent + app ONLY (the Meta views never had read_api).
    expect(lower).toContain(
      "grant select on queryable.vw_meta_ads_adset_daily, queryable.vw_meta_ads_adset_conversions_daily to growth_os_tool_agent, growth_os_app"
    );
    expect(collapsed).not.toContain("to growth_os_tool_agent, growth_os_app, growth_os_read_api");

    // Idempotent + non-destructive. The view recreate uses `drop view if exists ... cascade`
    // (re-runnability), which is allowed; forbid destructive TABLE/COLUMN drops + deletes.
    expect(lower).toContain("on conflict (id) do update set");
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("drop column");
    expect(lower).not.toContain("delete from");
    // SCOPE TRIPWIRE (open-core boundary): this slice is reads only — no ad-account mutation
    // can ride in a migration. There is no Graph write here, but assert the migration does not
    // attempt to flip any status to ACTIVE (a write-shaped value has no place in a read migration).
    expect(collapsed).not.toContain("set effective_status = 'active'");
  });

  // Phase-2 slice-1b §2/§3/§9 — the ad/creative grain migration (0037). Mirrors the 0035 adset
  // contracts at AD grain: the dim carries status + creative_id + a NULLABLE adset_id (orphan
  // tolerance), every ad fact is RE-KEYED on ad_id (the #1 corruption fix), the views alias
  // columns IDENTICALLY to the campaign/adset views (so the §5 resolver swaps only the NAME) and
  // expose status + adset_id/campaign_id, the conversions view LEFT JOINs its OWN ad-grain spend
  // (never coarser spend — no N-counting) AND DROPS optimization_goal (an adset property), the
  // partition stays result_type-only, and the grant target is tool_agent + app ONLY.
  it("creates the ad grain (dim+facts+views) re-keyed on ad_id with creative_id, nullable adset_id, own-grain spend (0037)", () => {
    const migration = loadMigrations().find(
      (candidate) => candidate.id === "0037_meta_ads_ad_grain.sql"
    );
    const sql = migration?.sql ?? "";
    const lower = sql.toLowerCase();
    const collapsed = lower.replace(/\s+/g, " ");

    // §2.1 — the dim carries BOTH status columns + creative_id (NULLABLE) + a NULLABLE adset_id
    // (orphan tolerance) and a NOT NULL campaign_id, unique on (source_id, ad_account_id, ad_id).
    expect(lower).toContain("create table meta_ads_ads");
    for (const col of ["effective_status", "configured_status", "creative_id"]) {
      expect(lower).toContain(col);
    }
    expect(collapsed).toContain("unique (source_id, ad_account_id, ad_id)");
    // optimization_goal is NOT a COLUMN on the ad stack (it is an adset property carried
    // in-memory). The word appears in explanatory comments, so forbid only the column form.
    expect(lower).not.toContain("optimization_goal text");

    // §2.2/§2.3 — the two fact tables and their RE-KEYED unique keys (ad_id, NOT adset/campaign
    // — the #1 corruption fix). The conversions key additionally pins result_type (the partition).
    expect(lower).toContain("create table meta_ads_ad_daily");
    expect(lower).toContain("create table meta_ads_ad_conversions_daily");
    expect(collapsed).toContain("unique (source_id, ad_account_id, ad_id, occurred_on)");
    expect(collapsed).toContain("unique (source_id, ad_account_id, ad_id, occurred_on, result_type)");
    // result_type is NOT NULL on the conversions fact (the REQUIRED partition is structural).
    expect(collapsed).toContain("result_type text not null");
    // campaign_id is CARRIED NOT NULL; adset_id is CARRIED but NULLABLE (orphan tolerance, §7a).
    expect(lower).toContain("campaign_id text not null");
    // Race-tolerant (§7a): the facts carry ad_id/adset_id/campaign_id with NO hard FK to the
    // ad/adset dims (mirrors the campaign/adset topology). Forbid an accidental hard FK on facts.
    expect(lower).not.toContain("references meta_ads_ads");
    expect(lower).not.toContain("references meta_ads_adsets");

    // §3 — the two views. Aliases IDENTICAL to the campaign/adset views (so the resolver swaps
    // only the NAME), PLUS the net-new ad identity + the carried adset_id/campaign_id + on/off
    // status dims.
    expect(lower).toContain("create view queryable.vw_meta_ads_ad_daily");
    expect(lower).toContain("create view queryable.vw_meta_ads_ad_conversions_daily");
    expect(lower).toContain("d.spend as meta_ads_spend");
    expect(lower).toContain("d.clicks as meta_ads_clicks");
    expect(lower).toContain("d.inline_link_clicks as link_clicks");
    // Status + the ad identity + the carried parent ids are exposed as columns on the views.
    expect(lower).toContain("dim.effective_status");
    expect(lower).toContain("dim.configured_status");
    expect(lower).toContain("d.ad_id");
    expect(lower).toContain("c.adset_id");
    expect(lower).toContain("c.campaign_id");

    // §2.3 — the ad CONVERSIONS view DROPS optimization_goal from its SELECT (it is an adset
    // property carried in-memory by the connector, never on the ad dim). Assert the SELECT does
    // not pull dim.optimization_goal anywhere in this migration.
    expect(lower).not.toContain("dim.optimization_goal");

    // §3 NO N-COUNTING: the conversions view LEFT JOINs its OWN ad-grain delivery spend
    // (meta_ads_ad_daily on ad_id + occurred_on), NEVER adset/campaign spend (which would
    // N-count it). Assert the join is to the ad delivery fact keyed on ad_id.
    expect(collapsed).toContain("left join meta_ads_ad_daily d on d.source_id = c.source_id");
    expect(collapsed).toContain("and d.ad_id = c.ad_id");
    expect(collapsed).toContain("and d.occurred_on = c.occurred_on");
    // The conversions view must NOT read the campaign/adset delivery fact for spend.
    expect(collapsed).not.toContain("join meta_ads_campaign_daily");
    expect(collapsed).not.toContain("from meta_ads_campaign_daily");
    expect(collapsed).not.toContain("join meta_ads_adset_daily");
    expect(collapsed).not.toContain("from meta_ads_adset_daily");

    // §3.4 — the metric_definitions expansion: partition = result_type ONLY at ad grain. Assert
    // the single-element partition is written and the two-element form is NOT present.
    expect(lower).toContain('"partition_by":["result_type"]');
    expect(lower).not.toContain('"partition_by":["result_type","objective"]');
    // The allowed_dimensions expansion adds the ad + status dims (NO new metric IDs — §6).
    expect(lower).toContain('"ad_id"');
    expect(lower).toContain('"ad_name"');
    expect(lower).toContain('"effective_status"');
    expect(lower).toContain('"configured_status"');

    // §3 — recompute-from-summed-bases stays byte-identical (only the view name swapped).
    expect(lower).not.toContain("avg(cost_per_result)");
    expect(lower).not.toContain("avg(roas)");

    // §3 GRANT divergence trap: tool_agent + app ONLY (the Meta views never had read_api).
    expect(lower).toContain(
      "grant select on queryable.vw_meta_ads_ad_daily, queryable.vw_meta_ads_ad_conversions_daily to growth_os_tool_agent, growth_os_app"
    );
    expect(collapsed).not.toContain("to growth_os_tool_agent, growth_os_app, growth_os_read_api");

    // Idempotent + non-destructive. The view recreate uses `drop view if exists ... cascade`.
    expect(lower).toContain("on conflict (id) do update set");
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("drop column");
    expect(lower).not.toContain("delete from");
    // SCOPE TRIPWIRE (open-core boundary): reads only — no ad-account mutation, no creative BODY.
    expect(collapsed).not.toContain("set effective_status = 'active'");
  });
});
