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
      "0036_chat_sessions_desktop_surface.sql"
    ]);
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
      "0036_chat_sessions_desktop_surface.sql"
    ]);
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
});
