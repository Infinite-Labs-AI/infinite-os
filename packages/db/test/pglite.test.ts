import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInfiniteOsDb,
  createProject,
  createProjectWithId,
  deleteProject,
  findProject,
  listProjects,
  loadMigrations,
  runMigrations,
  type InfiniteOsDb
} from "../src/index.js";
import {
  isPgliteDatabaseUrl,
  resolvePgliteDataDir,
  runPgliteMigrations
} from "../src/pglite-adapter.js";

// End-to-end proof that the embedded PGlite backend applies the WHOLE migration
// stack on a real (WASM) Postgres data dir and serves real queries — the desktop
// path. Uses a throwaway temp data directory so it never touches `~/.growth-os`.

describe("pglite url selection", () => {
  it("routes non-postgres URLs to PGlite and keeps postgres URLs on pg", () => {
    expect(isPgliteDatabaseUrl("postgres://u:p@host:5432/db")).toBe(false);
    expect(isPgliteDatabaseUrl("postgresql://u:p@host:5432/db")).toBe(false);
    expect(isPgliteDatabaseUrl("POSTGRES://u:p@host/db")).toBe(false);
    expect(isPgliteDatabaseUrl("pglite:///abs/path")).toBe(true);
    expect(isPgliteDatabaseUrl("pglite://")).toBe(true);
    expect(isPgliteDatabaseUrl("file:///abs/path")).toBe(true);
    expect(isPgliteDatabaseUrl("/Users/me/.growth-os/pglite")).toBe(true);
    expect(isPgliteDatabaseUrl("memory://")).toBe(true);
  });

  it("strips the pglite:// scheme to a data dir and defaults to ~/.growth-os/pglite", () => {
    expect(resolvePgliteDataDir("pglite:///tmp/x")).toBe("/tmp/x");
    expect(resolvePgliteDataDir("/tmp/y")).toBe("/tmp/y");
    expect(resolvePgliteDataDir("memory://")).toBe("memory://");
    expect(resolvePgliteDataDir("pglite://")).toMatch(/\.growth-os\/pglite$/);
  });

  it("treats a missing/blank url as NOT pglite (keeps pg path, no TypeError on undefined)", () => {
    expect(isPgliteDatabaseUrl(undefined)).toBe(false);
    expect(isPgliteDatabaseUrl(null)).toBe(false);
    expect(isPgliteDatabaseUrl("")).toBe(false);
    expect(isPgliteDatabaseUrl("   ")).toBe(false);
  });

  it("resolves the pglite: scheme with OR without the // (no-slash edge)", () => {
    // Without the fix these fell through to `return trimmed`, handing PGlite a literal `pglite:...`.
    expect(resolvePgliteDataDir("pglite:/tmp/a")).toBe("/tmp/a");
    expect(resolvePgliteDataDir("pglite:relative/b")).toBe("relative/b");
    expect(resolvePgliteDataDir("pglite:")).toMatch(/\.growth-os\/pglite$/);
  });
});

function recentTimestamptzIso(minutesAgo = 5): string {
  const value = new Date(Date.now() - minutesAgo * 60_000);
  value.setMilliseconds(0);
  return value.toISOString();
}

describe("pglite migration + query path (real WASM Postgres)", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;
  let firstRun: string[];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-"));
    url = `pglite://${dataDir}`;
    // Boot ONCE for the whole describe: run the migration stack, then open the shared db. Doing this
    // in beforeAll (not as a side effect of the first `it`) keeps every test order-INDEPENDENT — the
    // concurrency regression test below must stand on its own under `-t` / `.only` / shuffle, not
    // rely on an earlier `it` having assigned `db`.
    firstRun = await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("applied ALL 66 migrations on first boot and is idempotent on a re-run", async () => {
    expect(loadMigrations().length).toBe(66);
    expect(firstRun).toHaveLength(66);
    expect(firstRun).toContain("0001_control_plane.sql");
    expect(firstRun).toContain("0006_security_roles.sql");
    expect(firstRun).toContain("0036_chat_sessions_desktop_surface.sql");
    expect(firstRun).toContain("0037_meta_ads_ad_grain.sql");
    expect(firstRun).toContain("0038_chat_action_calls_workspace_id.sql");
    expect(firstRun).toContain("0039_connection_credentials_metadata.sql");
    expect(firstRun).toContain("0040_workspace_owner_id.sql");
    expect(firstRun).toContain("0041_fail_forever_queued_connector_jobs.sql");
    expect(firstRun).toContain("0042_sessions_metric_seed.sql");
    expect(firstRun).toContain("0043_posthog_audience_view.sql");
    expect(firstRun).toContain("0044_sources_consecutive_sync_failures.sql");
    expect(firstRun).toContain("0045_sources_last_counted_sync_failure_at.sql");
    expect(firstRun).toContain("0046_analytics_fact_table_indexes.sql");
    expect(firstRun).toContain("0047_stripe_paid_subscribers_metric.sql");
    expect(firstRun).toContain("0048_stripe_subscription_lifecycle_metrics.sql");
    expect(firstRun).toContain("0049_engine_app_stripe_subscription_items_grant.sql");
    expect(firstRun).toContain("0050_stripe_customer_metrics_classification.sql");
    expect(firstRun).toContain("0051_stripe_churn_requires_payment.sql");
    expect(firstRun).toContain("0052_stripe_revenue_uses_amount_paid.sql");
    expect(firstRun).toContain("0053_stripe_business_metric_eligibility.sql");
    expect(firstRun).toContain("0054_stripe_invoice_reconciliation.sql");
    expect(firstRun).toContain("0055_stripe_recurring_value_truth.sql");
    expect(firstRun).toContain("0056_stripe_customer_mrr_movements.sql");
    expect(firstRun).toContain("0057_stripe_trial_cohorts.sql");
    expect(firstRun).toContain("0058_stripe_delta_sync.sql");
    expect(firstRun).toContain("0059_stripe_reconciliation_drift.sql");
    expect(firstRun).toContain("0060_posthog_exclude_internal_from_app_views.sql");
    expect(firstRun).toContain("0061_ga4_event_report_and_snapshot_replacement.sql");
    expect(firstRun).toContain("0062_same_lane_site_conversion_rate.sql");
    expect(firstRun).toContain("0063_posthog_daily_rollups.sql");
    expect(firstRun).toContain("0064_posthog_raw_retention.sql");
    expect(firstRun).toContain("0065_prune_rolls_up_before_deleting.sql");
    expect(firstRun).toContain("0066_auxiliary_brain_usage_outbox.sql");

    // Idempotent: a second boot re-applies zero (the `rows.length` gate, not the pg `rowCount`
    // gate, makes this true on PGlite).
    const secondRun = await runMigrations(url);
    expect(secondRun).toEqual([]);
  });

  it("created the schema_migrations ledger with all 66 rows", async () => {
    const ledger = await db.query<{ id: string }>(
      "select id from schema_migrations order by id"
    );
    expect(ledger).toHaveLength(66);
    expect(ledger[0]?.id).toBe("0001_control_plane.sql");
    expect(ledger.at(-1)?.id).toBe("0066_auxiliary_brain_usage_outbox.sql");
  });

  it("0063 serves both PostHog views from per-(workspace, source, day) rollups — refresh, is_internal, idempotency, grain key, grants", async () => {
    // One workspace, TWO PostHog sources. Source A: two $pageview on D1 (one INTERNAL) + one
    // signup_completed on D1. Source B: one $pageview on D2 carrying audience properties. The
    // per-source refresh must roll each up exactly, hide the internal row from the app-facing
    // view while STILL holding it in the raw rollup (0060 doctrine), stay idempotent on re-run,
    // and reject a duplicate grain row outright (a doubled chart must be impossible).
    const WS = "ws_ph_rollup";
    const D1 = "2026-08-01";
    const D2 = "2026-08-02";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(WS, "PostHog Rollup WS");
      await tx.ensureFirstPhaseDatasets(WS);
    });
    const ds = await db.query<{ id: string }>(
      `select id from datasets where workspace_id = '${WS}' and key = 'web'`
    );
    for (const sourceId of ["src_ph_ru_a", "src_ph_ru_b"]) {
      // (workspace, provider, account) is unique on sources — two PostHog projects, two accounts.
      await db.query(
        `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
         values ($1, '${WS}', $2, 'posthog', 'conn', $1 || '_acct', 'connected')`,
        [sourceId, ds[0]?.id]
      );
    }
    const insertEvent = (
      id: string,
      sourceId: string,
      eventName: string,
      occurredAt: string,
      properties: Record<string, unknown>
    ) =>
      db.query(
        `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
         values ($1, '${WS}', $2, $1, $3, $4, $5::jsonb)`,
        [id, sourceId, eventName, occurredAt, JSON.stringify(properties)]
      );
    await insertEvent("ev_ru_a_pv", "src_ph_ru_a", "$pageview", `${D1}T10:00:00Z`, {});
    await insertEvent("ev_ru_a_pv_internal", "src_ph_ru_a", "$pageview", `${D1}T11:00:00Z`, {
      is_internal: true
    });
    await insertEvent("ev_ru_a_signup", "src_ph_ru_a", "signup_completed", `${D1}T12:00:00Z`, {});
    await insertEvent("ev_ru_b_pv", "src_ph_ru_b", "$pageview", `${D2}T09:00:00Z`, {
      $device_type: "Mobile",
      $geoip_country_name: "Canada"
    });

    // Nothing is served until a refresh has rolled the truth up (no silent read-through).
    const beforeRefresh = await db.query<{ n: string }>(
      `select count(*)::text as n from queryable.vw_posthog_events where workspace_id = '${WS}'`
    );
    expect(beforeRefresh[0]?.n).toBe("0");

    await db.query(
      `select refresh_posthog_daily_rollups('${WS}', 'src_ph_ru_a', $1::date, $1::date)`,
      [D1]
    );
    await db.query(
      `select refresh_posthog_daily_rollups('${WS}', 'src_ph_ru_b', $1::date, $1::date)`,
      [D2]
    );

    const readEvents = () =>
      db.query<{ occurred_on: string; event_name: string; n: string }>(
        `select occurred_on::text as occurred_on, event_name, sum(posthog_event_count)::text as n
           from queryable.vw_posthog_events
          where workspace_id = '${WS}'
          group by occurred_on, event_name
          order by occurred_on, event_name`
      );
    const events = await readEvents();
    // The internal $pageview is HIDDEN by the view: D1 $pageview = 1, signup_completed = 1.
    expect(events).toEqual([
      { occurred_on: D1, event_name: "$pageview", n: "1" },
      { occurred_on: D1, event_name: "signup_completed", n: "1" },
      { occurred_on: D2, event_name: "$pageview", n: "1" }
    ]);

    // ...but it is STILL COLLECTED in the raw rollup, flagged is_internal (0060 doctrine).
    const internalRows = await db.query<{ source_id: string; event_name: string; event_count: string }>(
      `select source_id, event_name, event_count::text as event_count
         from posthog_event_daily
        where workspace_id = '${WS}' and is_internal
        order by source_id`
    );
    expect(internalRows).toEqual([
      { source_id: "src_ph_ru_a", event_name: "$pageview", event_count: "1" }
    ]);

    // Audience dims are parsed out of the JSONB at rollup time, lower-cased device_type included.
    const site = await db.query<{ occurred_on: string; device_type: string | null; country: string | null; n: string }>(
      `select occurred_on::text as occurred_on, device_type, country, sum(posthog_page_views)::text as n
         from queryable.vw_posthog_site
        where workspace_id = '${WS}'
        group by occurred_on, device_type, country
        order by occurred_on`
    );
    expect(site).toEqual([
      { occurred_on: D1, device_type: null, country: null, n: "1" },
      { occurred_on: D2, device_type: "mobile", country: "Canada", n: "1" }
    ]);

    // Idempotent: refreshing source A again over the same window leaves counts AND row counts unchanged.
    const rowCountFor = async (sourceId: string) =>
      (
        await db.query<{ n: string }>(
          `select count(*)::text as n from posthog_event_daily where workspace_id = '${WS}' and source_id = $1`,
          [sourceId]
        )
      )[0]?.n;
    const aRowsBefore = await rowCountFor("src_ph_ru_a");
    await db.query(
      `select refresh_posthog_daily_rollups('${WS}', 'src_ph_ru_a', $1::date, $1::date)`,
      [D1]
    );
    expect(await readEvents()).toEqual(events);
    expect(await rowCountFor("src_ph_ru_a")).toBe(aRowsBefore);
    // A per-source refresh never touches the OTHER source's rows.
    expect(await rowCountFor("src_ph_ru_b")).toBe("1");

    // A backwards window is a caller bug — it raises, it does not silently no-op.
    await expect(
      db.query(`select refresh_posthog_daily_rollups('${WS}', 'src_ph_ru_a', $1::date, $2::date)`, [D2, D1])
    ).rejects.toThrow(/refresh_posthog_daily_rollups/);

    // The full grain is unique with NULLS NOT DISTINCT: a duplicate (all-null dims included) is a hard error.
    await expect(
      db.query(
        `insert into posthog_event_daily
           (workspace_id, source_id, occurred_on, event_name, is_internal, event_count)
         values ('${WS}', 'src_ph_ru_a', $1::date, 'signup_completed', false, 1)`,
        [D1]
      )
    ).rejects.toThrow(/posthog_event_daily_grain_key|duplicate key/);

    // View contracts are byte-for-byte 0060's (column names + order) — the engine's metricView /
    // runAggregate need zero SQL changes.
    const columnsOf = async (view: string) =>
      (
        await db.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'queryable' and table_name = $1
            order by ordinal_position`,
          [view]
        )
      ).map((row) => row.column_name);
    expect(await columnsOf("vw_posthog_events")).toEqual([
      "workspace_id",
      "source_id",
      "occurred_on",
      "event_name",
      "landing_page",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "posthog_event_count"
    ]);
    expect(await columnsOf("vw_posthog_site")).toEqual([
      "workspace_id",
      "source_id",
      "occurred_on",
      "device_type",
      "operating_system",
      "browser",
      "country",
      "region",
      "city",
      "landing_page",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "posthog_page_views"
    ]);

    // Grants (the 0053/2026-08-04 grantless incident): the connector CLOSE hook runs the refresh as
    // the worker (SECURITY INVOKER), so it needs full DML on both rollups; every read role must see
    // both tables AND both re-cut views. The FULL matrix is pinned — a partial pin is how a missing
    // grant ships. engine_app does not exist in PGlite — it is verified on the cloud DB after apply.
    const matrix: Array<[role: string, object: string, privilege: string]> = [];
    for (const table of ["posthog_event_daily", "posthog_site_daily"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) matrix.push(["growth_os_worker", table, privilege]);
      for (const role of ["growth_os_tool_agent", "growth_os_app", "growth_os_read_api"]) matrix.push([role, table, "SELECT"]);
    }
    for (const view of ["queryable.vw_posthog_events", "queryable.vw_posthog_site"]) {
      for (const role of ["growth_os_tool_agent", "growth_os_app", "growth_os_read_api"]) matrix.push([role, view, "SELECT"]);
    }
    const privileges = await db.query<{ role: string; object: string; privilege: string; granted: boolean }>(
      `select r as role, o as object, p as privilege, has_table_privilege(r, o, p) as granted
         from unnest($1::text[], $2::text[], $3::text[]) as t(r, o, p)`,
      [matrix.map((m) => m[0]), matrix.map((m) => m[1]), matrix.map((m) => m[2])]
    );
    // 2 tables × (worker S/I/U/D + 3 reader SELECTs) + 2 views × 3 reader SELECTs = 20 cells.
    expect(privileges).toHaveLength(20);
    expect(privileges.filter((row) => !row.granted)).toEqual([]);

    // Registry (0062 precedent): describe_queryable_view / freshness must name the rollups now.
    const registry = await db.query<{ id: string; source_tables: unknown }>(
      `select id, source_tables from queryable_views
        where id in ('queryable.vw_posthog_events', 'queryable.vw_posthog_site') order by id`
    );
    const sourceTablesOf = (row: { source_tables: unknown } | undefined) =>
      typeof row?.source_tables === "string" ? JSON.parse(row.source_tables) : row?.source_tables;
    expect(registry.map((row) => row.id)).toEqual(["queryable.vw_posthog_events", "queryable.vw_posthog_site"]);
    expect(sourceTablesOf(registry[0])).toEqual(["posthog_event_daily"]);
    expect(sourceTablesOf(registry[1])).toEqual(["posthog_site_daily"]);

    // Durable copy of the Phase-0 sandbox hand-applied audit index.
    const idx = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where indexname = 'stripe_invoice_lines_workspace_invoice_idx'`
    );
    expect(idx).toHaveLength(1);
  });

  it("0063 buckets the rollup day in UTC regardless of the session time zone", async () => {
    // The CLOSE hook derives the refresh window by slicing ISO (UTC) cursors. If the function
    // bucketed by the SESSION zone, a non-UTC session would file an event at 00:30Z into the
    // previous local day — a day the hook never asked to refresh, so it would stay short forever.
    const WS = "ws_ph_utc";
    const SRC = "src_ph_utc";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(WS, "PostHog UTC WS");
      await tx.ensureFirstPhaseDatasets(WS);
    });
    const ds = await db.query<{ id: string }>(
      `select id from datasets where workspace_id = '${WS}' and key = 'web'`
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('${SRC}', '${WS}', $1, 'posthog', 'conn', '${SRC}_acct', 'connected')`,
      [ds[0]?.id]
    );
    const insertEvent = (id: string, occurredAt: string) =>
      db.query(
        `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
         values ($1, '${WS}', '${SRC}', $1, '$pageview', $2, '{"$device_type":"Desktop"}'::jsonb)`,
        [id, occurredAt]
      );
    const rollupDays = () =>
      db.query<{ occurred_on: string; event_count: string }>(
        `select occurred_on::text as occurred_on, event_count::text as event_count
           from posthog_event_daily where workspace_id = '${WS}' order by occurred_on`
      );
    const viewDays = () =>
      db.query<{ occurred_on: string; n: string }>(
        `select occurred_on::text as occurred_on, sum(posthog_event_count)::text as n
           from queryable.vw_posthog_events where workspace_id = '${WS}' group by 1 order by 1`
      );
    const siteDays = () =>
      db.query<{ occurred_on: string }>(
        `select occurred_on::text as occurred_on from queryable.vw_posthog_site where workspace_id = '${WS}' order by 1`
      );

    // Non-UTC session: 2026-06-02T00:30Z is 2026-06-01 17:30 in Los Angeles.
    await db.query("set timezone = 'America/Los_Angeles'");
    try {
      await insertEvent("ev_utc_la", "2026-06-02T00:30:00Z");
      await db.query(
        `select refresh_posthog_daily_rollups('${WS}', '${SRC}', date '2026-06-02', date '2026-06-02')`
      );
      expect(await rollupDays()).toEqual([{ occurred_on: "2026-06-02", event_count: "1" }]);
      expect(await viewDays()).toEqual([{ occurred_on: "2026-06-02", n: "1" }]);
      expect(await siteDays()).toEqual([{ occurred_on: "2026-06-02" }]);
      // And refreshing the LOCAL day the event would have fallen into finds nothing — no phantom row.
      await db.query(
        `select refresh_posthog_daily_rollups('${WS}', '${SRC}', date '2026-06-01', date '2026-06-01')`
      );
      expect(await rollupDays()).toEqual([{ occurred_on: "2026-06-02", event_count: "1" }]);
    } finally {
      await db.query("reset timezone");
    }

    // Default (UTC) session: same shape, one day later.
    await insertEvent("ev_utc_default", "2026-06-03T00:30:00Z");
    await db.query(
      `select refresh_posthog_daily_rollups('${WS}', '${SRC}', date '2026-06-03', date '2026-06-03')`
    );
    expect(await rollupDays()).toEqual([
      { occurred_on: "2026-06-02", event_count: "1" },
      { occurred_on: "2026-06-03", event_count: "1" }
    ]);
    expect(await viewDays()).toEqual([
      { occurred_on: "2026-06-02", n: "1" },
      { occurred_on: "2026-06-03", n: "1" }
    ]);
  });

  it("0064 prunes raw while rollups stay PERMANENT — watermark-clamped refresh, no-op empty window, conservation redefined", async () => {
    // THE TRAP THIS MIGRATION EXISTS TO KILL: refresh_posthog_daily_rollups is delete+insert per
    // window. After raw pruning, any refresh whose window reaches into pruned days (the CLOSE hook's
    // no-cursor shape is literally `2000-01-01 → today`) would DELETE those days' rollup rows and
    // re-insert NOTHING — destroying permanent history. 0064 clamps the refresh window to the
    // per-source PRUNE WATERMARK (what was actually pruned — not the config floor, so a never-pruned
    // source still rolls up full backfill history and a later retention_days increase can't re-arm
    // the trap).
    const WS = "ws_ph_retention";
    const SRC = "src_ph_ret";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(WS, "PostHog Retention WS");
      await tx.ensureFirstPhaseDatasets(WS);
    });
    const ds = await db.query<{ id: string }>(
      `select id from datasets where workspace_id = '${WS}' and key = 'web'`
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('${SRC}', '${WS}', $1, 'posthog', 'conn', '${SRC}_acct', 'connected')`,
      [ds[0]?.id]
    );

    // Every day string comes from the DB's OWN UTC clock so the test can't skew against the
    // function's `now()`-derived retention floor.
    const dbDay = async (daysAgo: number) =>
      (
        await db.query<{ d: string }>(
          `select ((now() at time zone 'utc')::date - ${daysAgo})::text as d`
        )
      )[0]!.d;
    const dOld1 = await dbDay(200); // below the 180-day floor → pruned
    const dOld2 = await dbDay(190); // below the floor → pruned
    const dNew1 = await dbDay(10); // retained
    const dNew2 = await dbDay(5); // retained
    const today = await dbDay(0);
    const pBefore = await dbDay(180); // the cron's `today - retention_days`

    const insertEvent = (id: string, eventName: string, day: string, properties: object = {}) =>
      db.query(
        `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
         values ($1, '${WS}', '${SRC}', $1, $2, $3, $4::jsonb)`,
        [id, eventName, `${day}T12:00:00Z`, JSON.stringify(properties)]
      );
    await insertEvent("ev_ret_old_pv", "$pageview", dOld1);
    await insertEvent("ev_ret_old_signup", "signup_completed", dOld2);
    await insertEvent("ev_ret_old_internal", "$pageview", dOld2, { is_internal: true });
    await insertEvent("ev_ret_new_pv1", "$pageview", dNew1);
    await insertEvent("ev_ret_new_pv2", "$pageview", dNew2);
    await insertEvent("ev_ret_new_signup", "signup_completed", dNew2);

    const refresh = (from: string, to: string) =>
      db.query(
        `select refresh_posthog_daily_rollups('${WS}', '${SRC}', $1::date, $2::date)`,
        [from, to]
      );
    const prune = async (before: string) =>
      (
        await db.query<{ pruned: string }>(
          `select prune_posthog_raw('${WS}', '${SRC}', $1::date)::text as pruned`,
          [before]
        )
      )[0]!.pruned;
    const rollups = () =>
      db.query<{ occurred_on: string; event_name: string; is_internal: boolean; event_count: string }>(
        `select occurred_on::text as occurred_on, event_name, is_internal, event_count::text as event_count
           from posthog_event_daily where workspace_id = '${WS}'
          order by occurred_on, event_name, is_internal`
      );
    const truthCount = async () =>
      (
        await db.query<{ n: string }>(
          `select count(*)::text as n from posthog_event_truth where workspace_id = '${WS}'`
        )
      )[0]!.n;
    const rollupSum = async (whereSql = "") =>
      (
        await db.query<{ n: string }>(
          `select coalesce(sum(event_count), 0)::text as n
             from posthog_event_daily where workspace_id = '${WS}' ${whereSql}`
        )
      )[0]!.n;

    // The 0063 backfill shape rolls everything up; the GLOBAL conservation equality still holds
    // pre-prune: sum(event_count) — internal rows included, they are a grouping column — = count(truth).
    await refresh("2000-01-01", today);
    const fullHistory = await rollups();
    expect(fullHistory).toEqual([
      { occurred_on: dOld1, event_name: "$pageview", is_internal: false, event_count: "1" },
      { occurred_on: dOld2, event_name: "$pageview", is_internal: true, event_count: "1" },
      { occurred_on: dOld2, event_name: "signup_completed", is_internal: false, event_count: "1" },
      { occurred_on: dNew1, event_name: "$pageview", is_internal: false, event_count: "1" },
      { occurred_on: dNew2, event_name: "$pageview", is_internal: false, event_count: "1" },
      { occurred_on: dNew2, event_name: "signup_completed", is_internal: false, event_count: "1" }
    ]);
    expect(await rollupSum()).toBe(await truthCount()); // "6" = "6"

    // Config seeded 180 by the migration; the retention floor derives from it.
    const cfg = await db.query<{ retention_days: number }>(
      "select retention_days from posthog_retention_config"
    );
    expect(cfg).toHaveLength(1);
    expect(Number(cfg[0]?.retention_days)).toBe(180);

    // PRUNE: deletes exactly the 3 raw rows below the floor, returns the count, and touches ONLY
    // truth — every rollup row survives byte-for-byte. The watermark records what was pruned.
    expect(await prune(pBefore)).toBe("3");
    expect(await truthCount()).toBe("3");
    expect(await rollups()).toEqual(fullHistory);
    const watermark = await db.query<{ pruned_before: string }>(
      `select pruned_before::text as pruned_before from posthog_prune_watermarks
        where workspace_id = '${WS}' and source_id = '${SRC}'`
    );
    expect(watermark).toEqual([{ pruned_before: pBefore }]);

    // Idempotent: nothing left below the watermark.
    expect(await prune(pBefore)).toBe("0");

    // THE TRAP, DISARMED: the CLOSE hook's no-cursor refresh (2000-01-01 → today) after pruning.
    // Un-clamped 0063 semantics would delete the pruned days' rollups and re-insert nothing; the
    // watermark clamp must preserve them AND rebuild the retained window exactly.
    await refresh("2000-01-01", today);
    expect(await rollups()).toEqual(fullHistory);

    // A window ENTIRELY below the watermark clamps to empty and is a NO-OP — never a delete.
    await refresh("2000-01-01", dOld2);
    expect(await rollups()).toEqual(fullHistory);

    // CONSERVATION INVARIANT, REDEFINED (document it by asserting BOTH halves loudly):
    // within the retained window (days >= the prune watermark) the equality is still EXACT…
    expect(await rollupSum(`and occurred_on >= '${pBefore}'::date`)).toBe(await truthCount());
    // …and the GLOBAL equality of the 0063 era NO LONGER HOLDS after the first prune — days below
    // the watermark are permanent rollup history with no raw backing.
    expect(await rollupSum()).toBe("6");
    expect(await truthCount()).toBe("3");

    // The backwards-window raise is unchanged and fires on the RAW arguments, before any clamping.
    await expect(refresh(dNew2, dNew1)).rejects.toThrow(/refresh_posthog_daily_rollups/);

    // CALLER-DRIFT GUARD: prune clamps p_before to the config floor, so raw the policy still
    // guarantees is NEVER deletable through this function — a cron passing "tomorrow" deletes nothing
    // retained, and the watermark can never overtake the floor.
    expect(await prune(await dbDay(-1))).toBe("0");
    expect(await truthCount()).toBe("3");
    expect(
      await db.query<{ ok: boolean }>(
        `select pruned_before <= ((now() at time zone 'utc')::date - retention_days) as ok
           from posthog_prune_watermarks, posthog_retention_config
          where workspace_id = '${WS}' and source_id = '${SRC}'`
      )
    ).toEqual([{ ok: true }]);

    // The config is a hard singleton: a second policy row is impossible…
    await expect(
      db.query("insert into posthog_retention_config (singleton, retention_days) values (true, 90)")
    ).rejects.toThrow(/duplicate key|posthog_retention_config_pkey/);
    // …and a MISSING config row fails LOUD (select … into strict), never a silent unclamped prune.
    await db.query("delete from posthog_retention_config");
    try {
      await expect(prune(pBefore)).rejects.toThrow(/query returned no rows|no data found/i);
    } finally {
      await db.query(
        "insert into posthog_retention_config (singleton, retention_days) values (true, 180) on conflict (singleton) do nothing"
      );
    }

    // Grants (0053/2026-08-04 doctrine — owner-run PGlite can't catch a missing grant, so pin the
    // matrix): SECURITY INVOKER means prune callers (worker; engine_app on cloud, verified after the
    // cloud apply) need DELETE on truth + config SELECT + watermark DML, and every refresh caller
    // needs watermark SELECT. Read roles get SELECT on both new tables for diagnostics.
    const matrix: Array<[role: string, object: string, privilege: string]> = [];
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      matrix.push(["growth_os_worker", "posthog_prune_watermarks", privilege]);
    }
    matrix.push(["growth_os_worker", "posthog_retention_config", "SELECT"]);
    matrix.push(["growth_os_worker", "posthog_event_truth", "DELETE"]);
    for (const role of ["growth_os_app", "growth_os_tool_agent", "growth_os_read_api"]) {
      matrix.push([role, "posthog_retention_config", "SELECT"]);
      matrix.push([role, "posthog_prune_watermarks", "SELECT"]);
    }
    const privileges = await db.query<{ role: string; object: string; privilege: string; granted: boolean }>(
      `select r as role, o as object, p as privilege, has_table_privilege(r, o, p) as granted
         from unnest($1::text[], $2::text[], $3::text[]) as t(r, o, p)`,
      [matrix.map((m) => m[0]), matrix.map((m) => m[1]), matrix.map((m) => m[2])]
    );
    expect(privileges).toHaveLength(12);
    expect(privileges.filter((row) => !row.granted)).toEqual([]);
  });

  it("0065 prune ROLLS UP BEFORE DELETING — a mid-ingestion source's never-rolled-up raw survives as rollups", async () => {
    // THE AUDIT SCENARIO 0064 STILL LOST. Two facts about the ingestion lane combine into silent,
    // permanent history destruction:
    //   (1) truth commits per LOAD chunk in its OWN transaction, and the rollup refresh runs LATER,
    //       in the connector's CLOSE hook — so between the first chunk and the CLOSE there is a
    //       window where raw exists with NO rollup behind it;
    //   (2) the retention cron enumerates sources FROM TRUTH — so a source that is mid-backfill with
    //       >180d of history is a prune candidate BEFORE its first CLOSE ever runs.
    // Under 0064 the cron then deletes that raw and advances the watermark; the CLOSE refresh that
    // finally arrives is clamped to the watermark and skips those days — which now have neither raw
    // nor rollups, FOREVER. 0065 closes it by rolling the to-be-deleted window up INSIDE the prune
    // transaction, before the DELETE.
    const WS = "ws_ph_midflight";
    const SRC = "src_ph_mid";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(WS, "PostHog Mid-Flight WS");
      await tx.ensureFirstPhaseDatasets(WS);
    });
    const ds = await db.query<{ id: string }>(
      `select id from datasets where workspace_id = '${WS}' and key = 'web'`
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('${SRC}', '${WS}', $1, 'posthog', 'conn', '${SRC}_acct', 'connected')`,
      [ds[0]?.id]
    );

    const dbDay = async (daysAgo: number) =>
      (
        await db.query<{ d: string }>(
          `select ((now() at time zone 'utc')::date - ${daysAgo})::text as d`
        )
      )[0]!.d;
    const dOld1 = await dbDay(200); // below the 180-day floor -> pruned
    const dOld2 = await dbDay(190); // below the floor -> pruned
    const dNew1 = await dbDay(10); // retained
    const today = await dbDay(0);
    const pBefore = await dbDay(180);

    const insertEvent = (id: string, eventName: string, day: string, properties: object = {}) =>
      db.query(
        `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
         values ($1, '${WS}', '${SRC}', $1, $2, $3, $4::jsonb)`,
        [id, eventName, `${day}T12:00:00Z`, JSON.stringify(properties)]
      );
    // A backfill's committed chunks: two pageviews on the oldest day, a pageview + a signup on the
    // next, one pageview inside the retained window. NO refresh has run — that is the whole point.
    await insertEvent("ev_mid_o1_pv1", "$pageview", dOld1, { $device_type: "Desktop" });
    await insertEvent("ev_mid_o1_pv2", "$pageview", dOld1, { $device_type: "Desktop" });
    await insertEvent("ev_mid_o2_pv", "$pageview", dOld2, { $device_type: "Mobile" });
    await insertEvent("ev_mid_o2_signup", "signup_completed", dOld2);
    await insertEvent("ev_mid_new_pv", "$pageview", dNew1, { $device_type: "Desktop" });

    const rollups = () =>
      db.query<{ occurred_on: string; event_name: string; event_count: string }>(
        `select occurred_on::text as occurred_on, event_name, event_count::text as event_count
           from posthog_event_daily where workspace_id = '${WS}'
          order by occurred_on, event_name`
      );
    const siteRollups = () =>
      db.query<{ occurred_on: string; device_type: string | null; page_view_count: string }>(
        `select occurred_on::text as occurred_on, device_type, page_view_count::text as page_view_count
           from posthog_site_daily where workspace_id = '${WS}'
          order by occurred_on, device_type`
      );
    const truthCount = async () =>
      (
        await db.query<{ n: string }>(
          `select count(*)::text as n from posthog_event_truth where workspace_id = '${WS}'`
        )
      )[0]!.n;

    // Precondition — the trap's exact starting state: raw present, ZERO rollups behind it.
    expect(await truthCount()).toBe("5");
    expect(await rollups()).toEqual([]);

    // The cron prunes this never-closed source. It must still delete exactly the 4 below-floor raw
    // rows...
    const pruned = (
      await db.query<{ pruned: string }>(
        `select prune_posthog_raw('${WS}', '${SRC}', $1::date)::text as pruned`,
        [pBefore]
      )
    )[0]!.pruned;
    expect(pruned).toBe("4");
    expect(await truthCount()).toBe("1");

    // ...and the days it deleted must now EXIST as rollups, matching the counts the raw held. Under
    // 0064 this is `[]` — the four events are simply gone.
    expect(await rollups()).toEqual([
      { occurred_on: dOld1, event_name: "$pageview", event_count: "2" },
      { occurred_on: dOld2, event_name: "$pageview", event_count: "1" },
      { occurred_on: dOld2, event_name: "signup_completed", event_count: "1" }
    ]);
    // Both rollup tables are built, not just the event grain (the site grain is $pageview-only).
    expect(await siteRollups()).toEqual([
      { occurred_on: dOld1, device_type: "desktop", page_view_count: "2" },
      { occurred_on: dOld2, device_type: "mobile", page_view_count: "1" }
    ]);

    // The pre-delete rollup window is TIGHT: it stops at v_before - 1, so the retained day is left
    // for the CLOSE hook to roll up normally (prune must not fabricate rollups for days whose raw is
    // still arriving).
    expect((await rollups()).some((row) => row.occurred_on === dNew1)).toBe(false);

    // The watermark still advanced, so the CLOSE refresh that finally arrives is still clamped — but
    // now it clamps to days that HAVE rollups. Full history survives and the retained day fills in.
    expect(
      await db.query<{ pruned_before: string }>(
        `select pruned_before::text as pruned_before from posthog_prune_watermarks
          where workspace_id = '${WS}' and source_id = '${SRC}'`
      )
    ).toEqual([{ pruned_before: pBefore }]);
    await db.query(
      `select refresh_posthog_daily_rollups('${WS}', '${SRC}', date '2000-01-01', $1::date)`,
      [today]
    );
    expect(await rollups()).toEqual([
      { occurred_on: dOld1, event_name: "$pageview", event_count: "2" },
      { occurred_on: dOld2, event_name: "$pageview", event_count: "1" },
      { occurred_on: dOld2, event_name: "signup_completed", event_count: "1" },
      { occurred_on: dNew1, event_name: "$pageview", event_count: "1" }
    ]);

    // Conservation over the pruned window: the rollups hold exactly what the deleted raw held (4).
    expect(
      (
        await db.query<{ n: string }>(
          `select coalesce(sum(event_count), 0)::text as n from posthog_event_daily
            where workspace_id = '${WS}' and occurred_on < '${pBefore}'::date`
        )
      )[0]!.n
    ).toBe("4");
  });

  it("0065 prune SKIPS the pre-delete rollup when nothing falls below the floor (no backwards-window raise)", async () => {
    // The skip path is load-bearing, not a micro-optimisation: refresh_posthog_daily_rollups RAISES
    // on from > to, so a prune that computed a window start ABOVE v_before - 1 and called refresh
    // anyway would throw and take the whole retention cron down for every healthy source. Two ways
    // the window comes out empty — a source whose raw is entirely retained, and a source with no raw
    // at all — and both must be quiet no-ops that still advance the watermark.
    const WS = "ws_ph_skip";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(WS, "PostHog Skip WS");
      await tx.ensureFirstPhaseDatasets(WS);
    });
    const ds = await db.query<{ id: string }>(
      `select id from datasets where workspace_id = '${WS}' and key = 'web'`
    );
    for (const id of ["src_ph_skip_retained", "src_ph_skip_empty"]) {
      await db.query(
        `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
         values ($2, '${WS}', $1, 'posthog', 'conn', $2 || '_acct', 'connected')`,
        [ds[0]?.id, id]
      );
    }
    const dbDay = async (daysAgo: number) =>
      (
        await db.query<{ d: string }>(
          `select ((now() at time zone 'utc')::date - ${daysAgo})::text as d`
        )
      )[0]!.d;
    const dNew = await dbDay(10);
    const pBefore = await dbDay(180);
    const prune = async (source: string) =>
      (
        await db.query<{ pruned: string }>(
          `select prune_posthog_raw('${WS}', $2, $1::date)::text as pruned`,
          [pBefore, source]
        )
      )[0]!.pruned;

    // (a) ALL raw retained. A hand-planted rollup row that does NOT match raw is the tell: if prune
    // refreshed anything over this source it would be corrected to 1. It must survive untouched,
    // proving the pre-delete refresh never fired.
    await db.query(
      `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
       values ('ev_skip_new', '${WS}', 'src_ph_skip_retained', 'ev_skip_new', '$pageview', $1, '{}'::jsonb)`,
      [`${dNew}T12:00:00Z`]
    );
    await db.query(
      `insert into posthog_event_daily
         (workspace_id, source_id, occurred_on, event_name, is_internal, event_count)
       values ('${WS}', 'src_ph_skip_retained', $1::date, '$pageview', false, 99)`,
      [dNew]
    );
    expect(await prune("src_ph_skip_retained")).toBe("0");
    expect(
      await db.query<{ event_count: string }>(
        `select event_count::text as event_count from posthog_event_daily
          where workspace_id = '${WS}' and source_id = 'src_ph_skip_retained'`
      )
    ).toEqual([{ event_count: "99" }]);

    // (b) NO raw at all — the min-truth-day is NULL. Still a quiet no-op, still watermarked.
    expect(await prune("src_ph_skip_empty")).toBe("0");
    expect(
      await db.query<{ source_id: string; pruned_before: string }>(
        `select source_id, pruned_before::text as pruned_before from posthog_prune_watermarks
          where workspace_id = '${WS}' order by source_id`
      )
    ).toEqual([
      { source_id: "src_ph_skip_empty", pruned_before: pBefore },
      { source_id: "src_ph_skip_retained", pruned_before: pBefore }
    ]);
  });

  it("materialized the GA4 event grain + snapshot-replacement grants (0061)", async () => {
    // Owner-run PGlite cannot catch a missing grant (the 0053 incident) — pin the privileges
    // per role. The snapshot-replacement prune DELETEs from all three GA4 fact tables as the
    // worker, and the new event view must be readable by every read role.
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = 'ga4_event_report_fact'`
    );
    expect(tables).toHaveLength(1);
    const views = await db.query<{ table_name: string }>(
      `select table_name from information_schema.views
        where table_schema = 'queryable' and table_name = 'vw_site_events'`
    );
    expect(views).toHaveLength(1);

    const privileges = await db.query<Record<string, boolean>>(
      `select
         has_table_privilege('growth_os_worker', 'ga4_event_report_fact', 'INSERT') as evt_worker_insert,
         has_table_privilege('growth_os_worker', 'ga4_event_report_fact', 'UPDATE') as evt_worker_update,
         has_table_privilege('growth_os_worker', 'ga4_event_report_fact', 'DELETE') as evt_worker_delete,
         has_table_privilege('growth_os_worker', 'ga4_report_snapshot_fact', 'DELETE') as overview_worker_delete,
         has_table_privilege('growth_os_worker', 'ga4_page_report_fact', 'DELETE') as page_worker_delete,
         has_table_privilege('growth_os_tool_agent', 'queryable.vw_site_events', 'SELECT') as events_agent_select,
         has_table_privilege('growth_os_app', 'queryable.vw_site_events', 'SELECT') as events_app_select,
         has_table_privilege('growth_os_read_api', 'queryable.vw_site_events', 'SELECT') as events_readapi_select`
    );
    expect(privileges[0]).toEqual({
      evt_worker_insert: true,
      evt_worker_update: true,
      evt_worker_delete: true,
      overview_worker_delete: true,
      page_worker_delete: true,
      events_agent_select: true,
      events_app_select: true,
      events_readapi_select: true
    });

    // Provider metadata columns on sources (written at successful GA4 CLOSE).
    const sourceColumns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sources'
          and column_name in ('provider_time_zone', 'provider_data_through_date')
        order by column_name`
    );
    expect(sourceColumns.map((row) => row.column_name)).toEqual([
      "provider_data_through_date",
      "provider_time_zone"
    ]);
  });

  it("rebuilt vw_site_conversion_rate as the SAME-LANE GA4 rate (0062) — columns, math, grants", async () => {
    // The cross-provider column is GONE and both rate inputs are GA4 columns.
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'queryable' and table_name = 'vw_site_conversion_rate'
        order by ordinal_position`
    );
    expect(columns.map((row) => row.column_name)).toEqual([
      "workspace_id",
      "occurred_on",
      "landing_page",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "key_events",
      "site_visitors",
      "site_conversion_rate"
    ]);

    // Data-level proof: the rate divides GA4 key_events by GA4 visitors at the same grain, and the
    // 0027 dev-host exclusion survived the rebuild.
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_same_lane", "ws_same_lane");
      await tx.ensureFirstPhaseDatasets("ws_same_lane");
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = 'ws_same_lane' and key = 'web'"
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('src_same_lane', 'ws_same_lane', $1, 'google_analytics_4', 'conn', 'acct', 'connected')`,
      [ds[0]?.id]
    );
    await db.query(
      `insert into ga4_report_snapshot_fact (
         id, workspace_id, source_id, reporting_date, country, landing_page, referrer,
         utm_source, utm_medium, utm_campaign, host_name, total_users, key_events
       ) values
         ('f_same_lane_1', 'ws_same_lane', 'src_same_lane', '2026-08-12', 'UK', '/', '(not set)',
          '(direct)', '(none)', '(not set)', 'infinite.fast', 8, 2),
         ('f_same_lane_dev', 'ws_same_lane', 'src_same_lane', '2026-08-12', 'UK', '/', '(not set)',
          '(direct)', '(none)', '(not set)', 'localhost', 100, 50)`
    );
    const rows = await db.query<{ key_events: number; site_visitors: number; site_conversion_rate: string }>(
      `select key_events, site_visitors, site_conversion_rate::text
         from queryable.vw_site_conversion_rate where workspace_id = 'ws_same_lane'`
    );
    expect(rows).toHaveLength(1); // the localhost row is excluded, not blended in
    expect(rows[0]?.key_events).toBe(2);
    expect(rows[0]?.site_visitors).toBe(8);
    expect(Number(rows[0]?.site_conversion_rate)).toBeCloseTo(0.25);

    // The grantless-view incident: a REBUILT view must re-ship its grants.
    const privileges = await db.query<Record<string, boolean>>(
      `select
         has_table_privilege('growth_os_tool_agent', 'queryable.vw_site_conversion_rate', 'SELECT') as agent_select,
         has_table_privilege('growth_os_app', 'queryable.vw_site_conversion_rate', 'SELECT') as app_select,
         has_table_privilege('growth_os_read_api', 'queryable.vw_site_conversion_rate', 'SELECT') as readapi_select`
    );
    expect(privileges[0]).toEqual({ agent_select: true, app_select: true, readapi_select: true });

    // Registry now claims a single provider (freshness derives the provider set from source_tables).
    const registry = await db.query<{ source_tables: unknown; drilldown_action: string }>(
      "select source_tables, drilldown_action from queryable_views where id = 'queryable.vw_site_conversion_rate'"
    );
    // json/jsonb columns may arrive pre-parsed (PGlite) or as text — accept both shapes.
    const sourceTables = typeof registry[0]?.source_tables === "string"
      ? JSON.parse(registry[0].source_tables)
      : registry[0]?.source_tables;
    expect(sourceTables).toEqual(["ga4_report_snapshot_fact"]);
    expect(registry[0]?.drilldown_action).toBe("drilldown.ga4_traffic_provider_rows");
    const signupSeed = await db.query<{ source_view: string }>(
      "select source_view from metric_definitions where id = 'signup_count'"
    );
    expect(signupSeed[0]?.source_view).toBe("queryable.vw_posthog_events");
  });

  it("materialized the Stripe delta + reconciliation objects with WORKING grants", async () => {
    // A grantless view shipped once and broke the first post-deploy sync in prod — owner-run
    // PGlite tests could not see it, because the owner bypasses grants. Assert the privileges
    // themselves, per role, on the real migrated database.
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'stripe_event_segments', 'stripe_event_evidence',
            'stripe_sync_watermarks', 'stripe_reconciliation_drift'
          )
        order by table_name`
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "stripe_event_evidence",
      "stripe_event_segments",
      "stripe_reconciliation_drift",
      "stripe_sync_watermarks"
    ]);
    const views = await db.query<{ table_name: string }>(
      `select table_name from information_schema.views
        where table_schema = 'queryable' and table_name = 'vw_stripe_reconciliation_health'`
    );
    expect(views).toHaveLength(1);

    const privileges = await db.query<Record<string, boolean>>(
      `select
         has_table_privilege('growth_os_worker', 'stripe_event_segments', 'INSERT') as seg_worker_insert,
         has_table_privilege('growth_os_worker', 'stripe_event_evidence', 'INSERT') as evi_worker_insert,
         has_table_privilege('growth_os_worker', 'stripe_sync_watermarks', 'UPDATE') as wm_worker_update,
         has_table_privilege('growth_os_worker', 'stripe_reconciliation_drift', 'INSERT') as drift_worker_insert,
         has_table_privilege('growth_os_worker', 'stripe_reconciliation_drift', 'UPDATE') as drift_worker_update,
         has_table_privilege('growth_os_worker', 'stripe_reconciliation_drift', 'DELETE') as drift_worker_delete,
         has_table_privilege('growth_os_app', 'stripe_sync_watermarks', 'SELECT') as wm_app_select,
         has_table_privilege('growth_os_app', 'stripe_reconciliation_drift', 'SELECT') as drift_app_select,
         has_table_privilege('growth_os_tool_agent', 'stripe_reconciliation_drift', 'SELECT') as drift_agent_select,
         has_table_privilege('growth_os_read_api', 'stripe_sync_watermarks', 'SELECT') as wm_readapi_select,
         has_table_privilege('growth_os_app', 'queryable.vw_stripe_reconciliation_health', 'SELECT') as health_app_select,
         has_table_privilege('growth_os_tool_agent', 'queryable.vw_stripe_reconciliation_health', 'SELECT') as health_agent_select,
         has_table_privilege('growth_os_read_api', 'queryable.vw_stripe_reconciliation_health', 'SELECT') as health_readapi_select`
    );
    expect(privileges[0]).toMatchObject({
      seg_worker_insert: true,
      evi_worker_insert: true,
      wm_worker_update: true,
      drift_worker_insert: true,
      // Append-only by grant: the drift ledger's own writer must not be able to rewrite it.
      drift_worker_update: false,
      drift_worker_delete: false,
      wm_app_select: true,
      drift_app_select: true,
      drift_agent_select: true,
      wm_readapi_select: true,
      health_app_select: true,
      health_agent_select: true,
      health_readapi_select: true
    });

    // The view actually RUNS (a view can exist and still be broken by a bad join), and its
    // honesty invariant holds for whatever Stripe sources the rest of this suite left behind:
    // a workspace with an unreconciled connected source is never reported "clean".
    const health = await db.query<{
      metric_version: string;
      never_reconciled_source_count: number;
      reconciliation_status: string;
    }>("select * from queryable.vw_stripe_reconciliation_health");
    for (const row of health) {
      expect(row.metric_version).toBe("stripe-reconcile-v1");
      if (Number(row.never_reconciled_source_count) > 0) {
        expect(row.reconciliation_status).toBe("never_reconciled");
      }
    }
  });

  it("keeps invoice linkage source-scoped and exposes aggregate-only completeness diagnostics", async () => {
    const workspaceId = "ws_stripe_invoice_quality";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe invoice quality workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values
        ('src_quality_a', $1, $2, 'stripe', 'Stripe A', 'acct_quality_a', 'connected'),
        ('src_quality_b', $1, $2, 'stripe', 'Stripe B', 'acct_quality_b', 'connected')`,
      [workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into stripe_customers
        (id, workspace_id, source_id, stripe_customer_id, metrics_classification, created_at_source)
       values
        ('customer_quality_a', $1, 'src_quality_a', 'cus_shared', 'internal_test', '2026-07-01T00:00:00Z'),
        ('customer_quality_b', $1, 'src_quality_b', 'cus_shared', null, '2026-07-01T00:00:00Z')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_invoices
        (id, workspace_id, source_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id,
         subscription_origin, status, currency, amount_paid, amount_due, paid_at, created_at_source)
       values
        ('invoice_quality_a', $1, 'src_quality_a', 'inv_shared', 'cus_shared', 'sub_shared',
         'subscription', 'paid', 'usd', 5000, 5000, '2026-07-07T12:00:00Z', '2026-07-01T12:00:00Z'),
        ('invoice_quality_b', $1, 'src_quality_b', 'inv_shared', 'cus_shared', null,
         'subscription', 'paid', 'usd', 7000, 7000, '2026-07-08T12:00:00Z', '2026-07-01T12:00:00Z'),
        ('invoice_quality_unknown', $1, 'src_quality_b', 'inv_unknown', 'cus_shared', null,
         'unknown', 'paid', 'usd', 1000, 1000, '2026-07-09T12:00:00Z', '2026-07-02T12:00:00Z'),
        -- Paid but with no paid_at: invisible to every dated revenue query, so it must be
        -- COUNTED as a diagnostic without withholding the whole source's completeness.
        ('invoice_quality_no_paid_at', $1, 'src_quality_a', 'inv_no_paid_at', 'cus_shared', 'sub_shared',
         'subscription', 'paid', 'usd', 3000, 3000, null, '2026-07-03T12:00:00Z')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_invoice_sync_state
        (id, workspace_id, source_id, backfill_state, backfill_completed_at,
         latest_successful_stripe_cutoff, last_successful_sync_at)
       values
        ('state_quality_a', $1, 'src_quality_a', 'complete', now(), now(), now()),
        ('state_quality_b', $1, 'src_quality_b', 'in_progress', null, null, now())`,
      [workspaceId]
    );

    const sameExternalIds = await db.query<{
      source_id: string;
      stripe_subscription_id: string | null;
      metrics_classification: string | null;
    }>(
      `select i.source_id, i.stripe_subscription_id, c.metrics_classification
         from stripe_invoices i
         left join stripe_customers c
           on c.workspace_id = i.workspace_id
          and c.source_id = i.source_id
          and c.stripe_customer_id = i.stripe_customer_id
        where i.workspace_id = $1 and i.stripe_invoice_id = 'inv_shared'
        order by i.source_id`,
      [workspaceId]
    );
    expect(sameExternalIds).toEqual([
      { source_id: "src_quality_a", stripe_subscription_id: "sub_shared", metrics_classification: "internal_test" },
      { source_id: "src_quality_b", stripe_subscription_id: null, metrics_classification: null }
    ]);

    const quality = await db.query<Record<string, unknown>>(
      `select * from queryable.vw_stripe_invoice_link_quality
        where workspace_id = $1
        order by source_id`,
      [workspaceId]
    );
    expect(quality).toHaveLength(2);
    expect(quality[0]).toMatchObject({
      linked_paid_invoices: 2,
      unlinked_subscription_paid_invoices: 0,
      unknown_origin_paid_invoices: 0,
      paid_missing_paid_at_invoices: 1,
      backfill_state: "complete",
      completeness_sufficient: true
    });
    expect(Number(quality[0]?.link_coverage)).toBe(1);
    expect(quality[1]).toMatchObject({
      linked_paid_invoices: 0,
      unlinked_subscription_paid_invoices: 1,
      unknown_origin_paid_invoices: 1,
      paid_missing_paid_at_invoices: 0,
      backfill_state: "in_progress",
      completeness_sufficient: false
    });
    expect(Number(quality[1]?.link_coverage)).toBe(0);
    const serialized = JSON.stringify(quality);
    expect(serialized).not.toContain("inv_shared");
    expect(serialized).not.toContain("sub_shared");
    expect(serialized).not.toContain("cus_shared");
  });

  it("0046 creates the three workspace-leading analytics fact indexes", async () => {
    const idx = await db.query<{ tablename: string; indexname: string; indexdef: string }>(
      `select tablename, indexname, indexdef from pg_indexes
        where indexname in (
          'ga4_report_snapshot_workspace_date_idx',
          'ga4_page_report_workspace_date_idx',
          'posthog_event_truth_workspace_time_event_idx'
        )
        order by indexname`
    );
    expect(idx).toHaveLength(3);
    const byName = Object.fromEntries(
      idx.map((row) => [row.indexname, (row.indexdef ?? "").toLowerCase()])
    );
    // workspace_id MUST lead — the existing unique keys lead with source_id and so can
    // never serve the engine's `where workspace_id = $1 and <time> between …` reads.
    expect(byName["ga4_report_snapshot_workspace_date_idx"]).toContain(
      "on public.ga4_report_snapshot_fact using btree (workspace_id, reporting_date)"
    );
    expect(byName["ga4_page_report_workspace_date_idx"]).toContain(
      "on public.ga4_page_report_fact using btree (workspace_id, reporting_date)"
    );
    expect(byName["posthog_event_truth_workspace_time_event_idx"]).toContain(
      "on public.posthog_event_truth using btree (workspace_id, occurred_at, event_name)"
    );
  });

  it("0048 exposes current paid Stripe customers separately from trialing and new-paid counts", async () => {
    const workspaceId = "ws_stripe_paid_subs";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Paid subs workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('src_stripe_paid_subs', $1, $2, 'stripe', 'Stripe', 'acct_stripe', 'connected')`,
      [workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into raw_records
        (id, workspace_id, source_id, provider, object_type, external_id, payload, source_record_hash)
       values
        ('raw_a', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_a', '{}', 'hash_a'),
        ('raw_b', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_b', '{}', 'hash_b'),
        ('raw_c', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_c', '{}', 'hash_c'),
        ('raw_d', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_d', '{}', 'hash_d'),
        ('raw_e', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_e', '{}', 'hash_e'),
        ('raw_f', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_f', '{}', 'hash_f'),
        ('raw_g', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_g', '{}', 'hash_g'),
        ('raw_h', $1, 'src_stripe_paid_subs', 'stripe', 'subscription', 'sub_h',
         '{"discountsSynced":true,"discounts":[{"discountId":"di_free","position":0,"amountOff":null,"percentOff":100,"currency":null,"duration":"forever","startsAt":"2026-06-01T00:00:00.000Z","endsAt":null,"complete":true}]}'::jsonb,
         'hash_h'),
        ('raw_inv_c', $1, 'src_stripe_paid_subs', 'stripe', 'invoice', 'inv_c', '{}', 'hash_inv_c'),
        ('raw_item_a', $1, 'src_stripe_paid_subs', 'stripe', 'subscription_item', 'si_a', '{}', 'hash_item_a'),
        ('raw_item_b', $1, 'src_stripe_paid_subs', 'stripe', 'subscription_item', 'si_b', '{}', 'hash_item_b'),
        ('raw_item_d', $1, 'src_stripe_paid_subs', 'stripe', 'subscription_item', 'si_d', '{}', 'hash_item_d'),
        ('raw_item_e', $1, 'src_stripe_paid_subs', 'stripe', 'subscription_item', 'si_e', '{}', 'hash_item_e'),
        ('raw_item_h', $1, 'src_stripe_paid_subs', 'stripe', 'subscription_item', 'si_h', '{}', 'hash_item_h')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_customers
        (id, workspace_id, source_id, raw_record_id, stripe_customer_id, metrics_classification, created_at_source)
       values
        ('customer_a', $1, 'src_stripe_paid_subs', 'raw_a', 'cus_a', null, '2026-06-01T12:00:00Z'),
        ('customer_b', $1, 'src_stripe_paid_subs', 'raw_b', 'cus_b', null, '2026-06-20T13:00:00Z'),
        ('customer_c', $1, 'src_stripe_paid_subs', 'raw_c', 'cus_c', null, '2026-06-20T14:00:00Z'),
        ('customer_d', $1, 'src_stripe_paid_subs', 'raw_d', 'cus_d', 'internal_test', '2026-06-21T12:00:00Z'),
        ('customer_e', $1, 'src_stripe_paid_subs', 'raw_e', 'cus_e', 'internal_test', '2026-06-21T13:00:00Z'),
        ('customer_f', $1, 'src_stripe_paid_subs', 'raw_f', 'cus_f', 'internal_test', '2026-06-21T14:00:00Z'),
        ('customer_g', $1, 'src_stripe_paid_subs', 'raw_g', 'cus_g', null, '2026-06-21T15:00:00Z'),
        ('customer_h', $1, 'src_stripe_paid_subs', 'raw_h', 'cus_h', null, '2026-06-21T16:00:00Z')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_subscriptions
        (id, workspace_id, source_id, raw_record_id, stripe_subscription_id, stripe_customer_id, status, created_at_source, trial_end)
       values
        ('sub_active_a', $1, 'src_stripe_paid_subs', 'raw_a', 'sub_a', 'cus_a', 'active', '2026-06-01T12:00:00Z', '2026-06-10T12:00:00Z'),
        ('sub_trial_b', $1, 'src_stripe_paid_subs', 'raw_b', 'sub_b', 'cus_b', 'trialing', '2026-06-20T13:00:00Z', null),
        ('sub_canceled', $1, 'src_stripe_paid_subs', 'raw_c', 'sub_c', 'cus_c', 'canceled', '2026-06-20T14:00:00Z', null),
        ('sub_internal_active', $1, 'src_stripe_paid_subs', 'raw_d', 'sub_d', 'cus_d', 'active', '2026-06-21T12:00:00Z', null),
        ('sub_internal_trial', $1, 'src_stripe_paid_subs', 'raw_e', 'sub_e', 'cus_e', 'trialing', '2026-06-21T13:00:00Z', null),
        ('sub_internal_canceled', $1, 'src_stripe_paid_subs', 'raw_f', 'sub_f', 'cus_f', 'canceled', '2026-06-21T14:00:00Z', null),
        ('sub_never_paid_canceled', $1, 'src_stripe_paid_subs', 'raw_g', 'sub_g', 'cus_g', 'canceled', '2026-06-21T15:00:00Z', null),
        ('sub_fully_discounted', $1, 'src_stripe_paid_subs', 'raw_h', 'sub_h', 'cus_h', 'active', '2026-06-21T16:00:00Z', null)`,
      [workspaceId]
    );
    await db.query(
      `update stripe_subscriptions
       set canceled_at = '2026-06-25T12:00:00Z'
       where stripe_subscription_id in ('sub_c', 'sub_f', 'sub_g')`
    );
    await db.query(
      `insert into stripe_invoices
        (id, workspace_id, source_id, raw_record_id, stripe_invoice_id, stripe_customer_id, status, currency, amount_paid, amount_due, created_at_source)
       values
        ('invoice_c', $1, 'src_stripe_paid_subs', 'raw_inv_c', 'inv_c', 'cus_c', 'paid', 'usd', 4900, 4900, '2026-06-20T14:05:00Z')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_subscription_items
        (id, workspace_id, source_id, raw_record_id, stripe_subscription_item_id, stripe_subscription_id, stripe_price_id, stripe_product_id, currency, unit_amount, quantity, recurring_interval)
       values
        ('item_a', $1, 'src_stripe_paid_subs', 'raw_item_a', 'si_a', 'sub_a', 'price_a', 'prod_a', 'usd', 4900, 1, 'month'),
        ('item_b', $1, 'src_stripe_paid_subs', 'raw_item_b', 'si_b', 'sub_b', 'price_b', 'prod_b', 'usd', 4900, 1, 'month'),
        ('item_d', $1, 'src_stripe_paid_subs', 'raw_item_d', 'si_d', 'sub_d', 'price_d', 'prod_d', 'usd', 4900, 1, 'month'),
        ('item_e', $1, 'src_stripe_paid_subs', 'raw_item_e', 'si_e', 'sub_e', 'price_e', 'prod_e', 'usd', 4900, 1, 'month'),
        ('item_h', $1, 'src_stripe_paid_subs', 'raw_item_h', 'si_h', 'sub_h', 'price_h', 'prod_h', 'usd', 6000, 1, 'month')`,
      [workspaceId]
    );
    await db.query(
      `update stripe_subscriptions
          set items_sync_complete = true, discounts_sync_complete = true
        where workspace_id = $1 and source_id = 'src_stripe_paid_subs'`,
      [workspaceId]
    );
    await db.query(
      `update stripe_subscription_items
          set recurring_interval_count = 1,
              recurring_usage_type = 'licensed',
              billing_scheme = 'per_unit',
              pricing_state = 'licensed_per_unit'
        where workspace_id = $1 and source_id = 'src_stripe_paid_subs'`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_subscription_discounts
        (id, workspace_id, source_id, raw_record_id, stripe_subscription_id,
         target_type, target_id, stripe_discount_id, position, percent_off,
         duration, starts_at, is_complete)
       values ('discount_h', $1, 'src_stripe_paid_subs', 'raw_h', 'sub_h',
         'subscription', 'sub_h', 'di_free', 0, 100, 'forever',
         '2026-06-01T00:00:00Z', true)`,
      [workspaceId]
    );

    const current = await db.query<{ stripe_paid_subscribers: string }>(
      `select sum(stripe_paid_subscribers)::text as stripe_paid_subscribers
       from queryable.vw_stripe_paid_subscribers
       where workspace_id = $1`,
      [workspaceId]
    );
    expect(current[0]?.stripe_paid_subscribers).toBe("1");

    const lifecycle = await db.query<{
      metric_kind: string;
      current_paid: string;
      new_paid: string;
      trialing: string;
      churned: string;
    }>(
      `select metric_kind,
        sum(stripe_current_paid_subscribers)::text as current_paid,
        sum(stripe_new_paid_subscribers)::text as new_paid,
        sum(stripe_trialing_subscribers)::text as trialing
        ,sum(stripe_churned_subscribers)::text as churned
       from queryable.vw_stripe_subscription_lifecycle
       where workspace_id = $1
       group by metric_kind
       order by metric_kind`,
      [workspaceId]
    );
    expect(lifecycle).toEqual([
      { metric_kind: "current_paid_subscribers", current_paid: "1", new_paid: "0", trialing: "0", churned: "0" },
      { metric_kind: "trialing_subscribers", current_paid: "0", new_paid: "0", trialing: "1", churned: "0" }
    ]);
  });

  it("0056 fails workspace coverage closed when any connected Stripe source is missing or incomplete", async () => {
    const workspaceId = "ws_stripe_mrr_coverage";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe MRR coverage workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values
         ('src_mrr_cov_a',$1,$2,'stripe','Stripe A','acct_a','connected'),
         ('src_mrr_cov_b',$1,$2,'stripe','Stripe B','acct_b','connected')`,
      [workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into stripe_mrr_movement_coverage (
         id, workspace_id, source_id, forward_coverage_started_at,
         last_attempted_data_as_of, last_complete_data_as_of,
         incomplete_business_customer_count, classifier_version
       ) values ('cov_a',$1,'src_mrr_cov_a','2026-07-01T00:00:00Z',
         '2026-08-04T12:00:00Z','2026-08-04T12:00:00Z',0,'v1')`,
      [workspaceId]
    );

    const readCoverage = () => db.query<{
      connected_source_count: string;
      covered_source_count: string;
      missing_source_coverage_count: string;
      forward_coverage_started_at: string | Date | null;
      data_as_of: string | Date | null;
      incomplete_business_customer_count: string;
      classifier_version: string | null;
    }>(
      `select connected_source_count::text, covered_source_count::text,
              missing_source_coverage_count::text, forward_coverage_started_at,
              data_as_of, incomplete_business_customer_count::text, classifier_version
         from queryable.vw_stripe_mrr_movement_coverage where workspace_id = $1`,
      [workspaceId]
    );
    expect(await readCoverage()).toEqual([expect.objectContaining({
      connected_source_count: "2",
      covered_source_count: "1",
      missing_source_coverage_count: "1",
      forward_coverage_started_at: null,
      data_as_of: null,
      classifier_version: null,
    })]);

    await db.query(
      `insert into stripe_mrr_movement_coverage (
         id, workspace_id, source_id, forward_coverage_started_at,
         last_attempted_data_as_of, last_complete_data_as_of,
         incomplete_business_customer_count, incomplete_reasons, classifier_version
       ) values ('cov_b',$1,'src_mrr_cov_b','2026-07-02T00:00:00Z',
         '2026-08-04T11:00:00Z','2026-08-04T11:00:00Z',1,
         array['discounts_sync_incomplete'],'v1')`,
      [workspaceId]
    );
    expect(await readCoverage()).toEqual([expect.objectContaining({
      connected_source_count: "2",
      covered_source_count: "2",
      missing_source_coverage_count: "0",
      forward_coverage_started_at: null,
      data_as_of: null,
      incomplete_business_customer_count: "1",
      classifier_version: "v1",
    })]);

    await db.query(
      `update stripe_mrr_movement_coverage
          set incomplete_business_customer_count = 0, incomplete_reasons = array[]::text[]
        where source_id = 'src_mrr_cov_b'`
    );
    const complete = await readCoverage();
    expect(new Date(complete[0]?.forward_coverage_started_at ?? "").toISOString()).toBe(
      "2026-07-02T00:00:00.000Z"
    );
    expect(new Date(complete[0]?.data_as_of ?? "").toISOString()).toBe(
      "2026-08-04T11:00:00.000Z"
    );
    expect(complete[0]?.classifier_version).toBe("v1");

    await db.query(
      `update stripe_mrr_movement_coverage
          set classifier_version = 'v2'
        where source_id = 'src_mrr_cov_b'`
    );
    expect(await readCoverage()).toEqual([expect.objectContaining({
      connected_source_count: "2",
      covered_source_count: "2",
      missing_source_coverage_count: "0",
      classifier_version: null,
    })]);

    // Pending service ends are a DIAGNOSTIC, never a coverage gate: the count surfaces but the
    // workspace stays covered and keeps its data_as_of.
    await db.query(
      `update stripe_mrr_movement_coverage set pending_service_end_customer_count = 2
        where source_id = 'src_mrr_cov_a'`
    );
    const pending = await db.query<{
      pending: string;
      covered_source_count: string;
      data_as_of: string | Date | null;
    }>(
      `select pending_service_end_customer_count::text as pending,
              covered_source_count::text, data_as_of
         from queryable.vw_stripe_mrr_movement_coverage where workspace_id = $1`,
      [workspaceId]
    );
    expect(pending[0]).toMatchObject({ pending: "2", covered_source_count: "2" });
  });

  it("0056 requires event-time and current eligibility and counts lifecycle customers across currencies once", async () => {
    const workspaceId = "ws_stripe_mrr_eligibility";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe MRR eligibility workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('src_mrr_eligibility',$1,$2,'stripe','Stripe','acct','connected')`,
      [workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into stripe_customers (
         id, workspace_id, source_id, stripe_customer_id, metrics_classification
       ) values
         ('customer_business',$1,'src_mrr_eligibility','cus_business',null),
         ('customer_internal',$1,'src_mrr_eligibility','cus_internal','internal_test')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_customer_mrr_movements (
         id, workspace_id, source_id, stripe_customer_id, currency, movement_kind,
         from_amount_minor, to_amount_minor, delta_amount_minor, effective_at, observed_at,
         previous_evidence_hash, current_evidence_hash, provenance,
         business_eligible_at_event, classifier_version, idempotency_key
       ) values
         ('mov_business_usd',$1,'src_mrr_eligibility','cus_business','usd','new',
          0,5000,5000,'2026-08-01T10:00:00Z','2026-08-01T10:00:00Z','zero','usd',
          'forward_observed_v1',true,'v1','key_business_usd'),
         ('mov_business_gbp',$1,'src_mrr_eligibility','cus_business','gbp','new',
          0,4000,4000,'2026-08-01T11:00:00Z','2026-08-01T11:00:00Z','zero','gbp',
          'forward_observed_v1',true,'v1','key_business_gbp'),
         ('mov_internal_usd',$1,'src_mrr_eligibility','cus_internal','usd','new',
          0,2000,2000,'2026-08-01T12:00:00Z','2026-08-01T12:00:00Z','zero','internal',
          'forward_observed_v1',false,'v1','key_internal_usd')`,
      [workspaceId]
    );

    const visibleCount = async () => (await db.query<{ count: string }>(
      `select count(*)::text as count
         from queryable.vw_stripe_customer_mrr_movements where workspace_id = $1`,
      [workspaceId]
    ))[0]?.count;
    expect(await visibleCount()).toBe("2");
    const readLifecycle = () => db.query<{ new_paid: string | null; currency: string | null }>(
      `select stripe_new_paid_subscribers::text as new_paid, currency
         from queryable.vw_stripe_subscription_lifecycle
        where workspace_id = $1 and metric_kind = 'new_paid_subscribers'`,
      [workspaceId]
    );
    // 0056 fails the new/churn branches CLOSED per source: without a movement-coverage row the
    // count could only be an undercount, so it reports null rather than a concrete number.
    expect(await readLifecycle()).toEqual([{ new_paid: null, currency: null }]);
    await db.query(
      `insert into stripe_mrr_movement_coverage (
         id, workspace_id, source_id, forward_coverage_started_at,
         last_attempted_data_as_of, last_complete_data_as_of,
         incomplete_business_customer_count, classifier_version
       ) values ('cov_mrr_eligibility',$1,'src_mrr_eligibility','2026-08-01T00:00:00Z',
         '2026-08-02T00:00:00Z','2026-08-02T00:00:00Z',0,'v1')`,
      [workspaceId]
    );
    // With coverage proven, the same customer is counted ONCE across its two currencies.
    expect(await readLifecycle()).toEqual([{ new_paid: "1", currency: null }]);

    await db.query(
      `update stripe_customers set metrics_classification = 'internal_test'
        where source_id = 'src_mrr_eligibility' and stripe_customer_id = 'cus_business'`
    );
    expect(await visibleCount()).toBe("0");
    await db.query(
      `update stripe_customers set metrics_classification = null
        where source_id = 'src_mrr_eligibility' and stripe_customer_id = 'cus_internal'`
    );
    expect(await visibleCount()).toBe("0");
  });

  it("0055 computes interval-aware ordered net recurring value and explicit exclusions", async () => {
    const workspaceId = "ws_stripe_recurring_contract";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe recurring contract workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('src_recurring_contract', $1, $2, 'stripe', 'Stripe', 'acct_recurring_contract', 'connected')`,
      [workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into stripe_customers
        (id, workspace_id, source_id, stripe_customer_id, metrics_classification, created_at_source)
       values
        ('customer_shared_contract', $1, 'src_recurring_contract', 'cus_shared', null, now()),
        ('customer_internal_contract', $1, 'src_recurring_contract', 'cus_internal', 'internal_test', now())`,
      [workspaceId]
    );
    const subscriptionIds = [
      "monthly", "quarter", "multi_year", "weekly", "daily", "qnull", "qzero", "q3",
      "stack", "once", "expired", "mismatch", "metered", "tiered", "custom", "unknown",
      "free100", "shared_a", "shared_b", "internal",
      "transform", "product_restricted", "price_unresolved", "coupon_option", "coupon_unresolved",
      "metered_priced", "clean_multi",
    ];
    for (const subscriptionId of subscriptionIds) {
      const customerId = subscriptionId.startsWith("shared_")
        ? "cus_shared"
        : subscriptionId === "internal" ? "cus_internal" : `cus_${subscriptionId}`;
      await db.query(
        `insert into stripe_subscriptions
          (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
           created_at_source, items_sync_complete, discounts_sync_complete)
         values ($1, $2, 'src_recurring_contract', $3, $4, 'active', now(), true, true)`,
        [`row_${subscriptionId}`, workspaceId, `sub_${subscriptionId}`, customerId]
      );
    }
    const itemRows: Array<[string, number | null, number | null, string, number, string]> = [
      ["monthly", 6000, 1, "month", 1, "licensed_per_unit"],
      ["quarter", 6000, 1, "month", 3, "licensed_per_unit"],
      ["multi_year", 240000, 1, "year", 2, "licensed_per_unit"],
      ["weekly", 1200, 1, "week", 1, "licensed_per_unit"],
      ["daily", 120, 1, "day", 1, "licensed_per_unit"],
      ["qnull", 6000, null, "month", 1, "licensed_per_unit"],
      ["qzero", 6000, 0, "month", 1, "licensed_per_unit"],
      ["q3", 6000, 3, "month", 1, "licensed_per_unit"],
      ["stack", 6000, 1, "month", 1, "licensed_per_unit"],
      ["once", 6000, 1, "month", 1, "licensed_per_unit"],
      ["expired", 6000, 1, "month", 1, "licensed_per_unit"],
      ["mismatch", 6000, 1, "month", 1, "licensed_per_unit"],
      ["metered", null, 1, "month", 1, "metered"],
      ["tiered", null, 1, "month", 1, "tiered"],
      ["custom", null, 1, "month", 1, "custom"],
      ["unknown", 6000, 1, "fortnight", 1, "licensed_per_unit"],
      ["free100", 6000, 1, "month", 1, "licensed_per_unit"],
      ["shared_a", 1000, 1, "month", 1, "licensed_per_unit"],
      ["shared_b", 2000, 1, "month", 1, "licensed_per_unit"],
      ["internal", 9999, 1, "month", 1, "licensed_per_unit"],
      ["transform", 1000, 6, "month", 1, "licensed_per_unit"],
      ["product_restricted", 6000, 1, "month", 1, "licensed_per_unit"],
      ["price_unresolved", 1000, 1, "month", 1, "licensed_per_unit"],
      ["coupon_option", 6000, 1, "month", 1, "licensed_per_unit"],
      ["coupon_unresolved", 6000, 1, "month", 1, "licensed_per_unit"],
      // A METERED price that still carries a per-unit `unit_amount` (usage pricing). It must never
      // land in list MRR as if it were a flat monthly charge.
      ["metered_priced", 6000, null, "month", 1, "metered"],
      // Two healthy items on one subscription — the empty-reason aggregation case.
      ["clean_multi", 1500, 1, "month", 1, "licensed_per_unit"],
    ];
    for (const [name, unitAmount, quantity, interval, intervalCount, pricingState] of itemRows) {
      await db.query(
        `insert into stripe_subscription_items
          (id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
           currency, unit_amount, quantity, recurring_interval, recurring_interval_count,
           recurring_usage_type, billing_scheme, pricing_state)
         values ($1, $2, 'src_recurring_contract', $3, $4, 'usd', $5, $6, $7, $8,
                 'licensed', 'per_unit', $9)`,
        [`item_row_${name}`, workspaceId, `si_${name}`, `sub_${name}`, unitAmount, quantity,
          interval, intervalCount, pricingState]
      );
    }
    await db.query(
      `update stripe_subscription_items
          set transform_quantity_divide_by = 5, transform_quantity_round = 'up'
        where workspace_id = $1 and stripe_subscription_item_id = 'si_transform'`,
      [workspaceId]
    );
    await db.query(
      `update stripe_subscription_items
          set currency_option_resolved = false, default_currency = 'usd', default_unit_amount = 1000,
              currency = 'eur', pricing_state = 'licensed_per_unit'
        where workspace_id = $1 and stripe_subscription_item_id = 'si_price_unresolved'`,
      [workspaceId]
    );
    await db.query(
      `update stripe_subscription_items
          set currency = 'gbp'
        where workspace_id = $1 and stripe_subscription_item_id in ('si_coupon_option', 'si_coupon_unresolved')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_subscription_items
        (id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
         stripe_product_id, currency, unit_amount, quantity, recurring_interval,
         recurring_interval_count, recurring_usage_type, billing_scheme, pricing_state)
       values
        ('item_row_product_b', $1, 'src_recurring_contract', 'si_product_b',
         'sub_product_restricted', 'prod_b', 'usd', 6000, 1, 'month', 1,
         'licensed', 'per_unit', 'licensed_per_unit'),
        ('item_row_clean_multi_b', $1, 'src_recurring_contract', 'si_clean_multi_b',
         'sub_clean_multi', 'prod_clean_multi_b', 'usd', 2500, 2, 'month', 1,
         'licensed', 'per_unit', 'licensed_per_unit')`,
      [workspaceId]
    );
    await db.query(
      `update stripe_subscription_items set stripe_product_id = 'prod_a'
        where workspace_id = $1 and stripe_subscription_item_id = 'si_product_restricted'`,
      [workspaceId]
    );
    const discounts = [
      ["monthly", "subscription", "sub_monthly", 0, 1000, null, "usd", "forever", null],
      ["stack", "item", "si_stack", 0, null, 50, null, "forever", null],
      ["stack", "item", "si_stack", 1, 500, null, "usd", "forever", null],
      ["stack", "subscription", "sub_stack", 0, 1000, null, "usd", "forever", null],
      ["once", "subscription", "sub_once", 0, 1000, null, "usd", "once", null],
      ["expired", "subscription", "sub_expired", 0, 1000, null, "usd", "repeating", "2026-01-01T00:00:00Z"],
      ["mismatch", "subscription", "sub_mismatch", 0, 1000, null, "gbp", "forever", null],
      ["free100", "subscription", "sub_free100", 0, null, 100, null, "forever", null],
    ] as const;
    for (const [name, targetType, targetId, position, amountOff, percentOff, currency, duration, endsAt] of discounts) {
      await db.query(
        `insert into stripe_subscription_discounts
          (id, workspace_id, source_id, stripe_subscription_id, target_type, target_id,
           stripe_discount_id, position, amount_off, percent_off, currency, duration,
           starts_at, ends_at, is_complete)
         values ($1, $2, 'src_recurring_contract', $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, '2025-01-01T00:00:00Z', $12, true)`,
        [`discount_${name}_${targetType}_${position}`, workspaceId, `sub_${name}`, targetType,
          targetId, `di_${name}_${position}`, position, amountOff, percentOff, currency, duration, endsAt]
      );
    }
    await db.query(
      `insert into stripe_subscription_discounts
        (id, workspace_id, source_id, stripe_subscription_id, target_type, target_id,
         stripe_discount_id, position, amount_off, percent_off, currency, duration,
         starts_at, is_complete, applies_to_product_ids, amount_off_currency_options,
         currency_option_resolved)
       values
        ('discount_product_restricted', $1, 'src_recurring_contract', 'sub_product_restricted',
         'subscription', 'sub_product_restricted', 'di_product_restricted', 0, null, 100,
         null, 'forever', '2025-01-01T00:00:00Z', true, array['prod_a'], '{}'::jsonb, true),
        ('discount_coupon_option', $1, 'src_recurring_contract', 'sub_coupon_option',
         'subscription', 'sub_coupon_option', 'di_coupon_option', 0, 800, null,
         'gbp', 'forever', '2025-01-01T00:00:00Z', true, array[]::text[],
         '{"gbp":800}'::jsonb, true),
        ('discount_coupon_unresolved', $1, 'src_recurring_contract', 'sub_coupon_unresolved',
         'subscription', 'sub_coupon_unresolved', 'di_coupon_unresolved', 0, 1000, null,
         'usd', 'forever', '2025-01-01T00:00:00Z', true, array[]::text[],
         '{"gbp":800}'::jsonb, false)`,
      [workspaceId]
    );

    const values = await db.query<{
      stripe_subscription_id: string;
      list_value: string;
      net_value: string | null;
      value_state: string;
      incomplete_reasons: string[];
    }>(
      `select stripe_subscription_id,
              round(list_monthly_amount_cents, 4)::text as list_value,
              round(net_monthly_amount_cents, 4)::text as net_value,
              value_state, incomplete_reasons
         from queryable.vw_stripe_subscription_recurring_value
        where workspace_id = $1 and source_id = 'src_recurring_contract'
        order by stripe_subscription_id`,
      [workspaceId]
    );
    const byId = Object.fromEntries(values.map((row) => [row.stripe_subscription_id, row]));
    expect(byId.sub_monthly).toMatchObject({ list_value: "6000.0000", net_value: "5000.0000", value_state: "complete" });
    expect(byId.sub_quarter).toMatchObject({ net_value: "2000.0000", value_state: "complete" });
    expect(byId.sub_multi_year).toMatchObject({ net_value: "10000.0000", value_state: "complete" });
    expect(byId.sub_weekly).toMatchObject({ net_value: "5200.0000", value_state: "complete" });
    expect(byId.sub_daily).toMatchObject({ net_value: "3650.0000", value_state: "complete" });
    // A licensed item whose quantity failed to parse is UNKNOWN, never priced at 1.
    expect(byId.sub_qnull).toMatchObject({
      list_value: "0.0000",
      net_value: null,
      value_state: "unavailable",
    });
    expect(byId.sub_qnull?.incomplete_reasons).toContain("unknown_quantity");
    expect(byId.sub_qzero?.net_value).toBe("0.0000");
    expect(byId.sub_q3?.net_value).toBe("18000.0000");
    expect(byId.sub_stack?.net_value).toBe("1500.0000");
    expect(byId.sub_once?.net_value).toBe("6000.0000");
    expect(byId.sub_expired?.net_value).toBe("6000.0000");
    expect(byId.sub_free100?.net_value).toBe("0.0000");
    expect(byId.sub_mismatch).toMatchObject({ net_value: null, value_state: "list_only" });
    expect(byId.sub_mismatch?.incomplete_reasons).toContain("amount_discount_currency_mismatch");
    expect(byId.sub_metered?.incomplete_reasons).toContain("metered_item");
    // A metered price WITH a unit_amount contributes nothing to list MRR and leaves the whole
    // subscription unavailable rather than confidently listing a per-usage rate as monthly value.
    expect(byId.sub_metered_priced).toMatchObject({
      list_value: "0.0000",
      net_value: null,
      value_state: "unavailable",
    });
    expect(byId.sub_metered_priced?.incomplete_reasons).toEqual(["metered_item"]);
    // Two healthy items must aggregate to NO reasons at all (not empty-string codes).
    expect(byId.sub_clean_multi).toMatchObject({
      list_value: "6500.0000",
      net_value: "6500.0000",
      value_state: "complete",
    });
    expect(byId.sub_clean_multi?.incomplete_reasons).toEqual([]);
    expect(byId.sub_tiered?.incomplete_reasons).toContain("tiered_item");
    expect(byId.sub_custom?.incomplete_reasons).toContain("custom_price_item");
    expect(byId.sub_unknown?.incomplete_reasons).toContain("unknown_interval");
    expect(byId.sub_transform).toMatchObject({ list_value: "2000.0000", net_value: "2000.0000", value_state: "complete" });
    expect(byId.sub_product_restricted).toMatchObject({ list_value: "12000.0000", net_value: null, value_state: "list_only" });
    expect(byId.sub_product_restricted?.incomplete_reasons).toContain("product_restricted_discount_unsupported");
    expect(byId.sub_price_unresolved).toMatchObject({ net_value: null, value_state: "list_only" });
    expect(byId.sub_price_unresolved?.incomplete_reasons).toContain("price_currency_option_unresolved");
    expect(byId.sub_coupon_option).toMatchObject({ net_value: "5200.0000", value_state: "complete" });
    expect(byId.sub_coupon_unresolved).toMatchObject({ net_value: null, value_state: "list_only" });
    expect(byId.sub_coupon_unresolved?.incomplete_reasons).toContain("discount_currency_option_unresolved");
    const paid = await db.query<{ paid: string | null }>(
      `select sum(stripe_paid_subscribers)::text as paid
         from queryable.vw_stripe_paid_subscribers
        where workspace_id = $1`,
      [workspaceId]
    );
    expect(paid[0]?.paid).toBeNull();
    const internal = await db.query<{ business_eligible: boolean }>(
      `select business_eligible from queryable.vw_stripe_subscription_recurring_value
        where workspace_id = $1 and stripe_subscription_id = 'sub_internal'`,
      [workspaceId]
    );
    expect(internal[0]?.business_eligible).toBe(false);
  });

  it("0055 anchors current paid subscribers at workspace grain with honest zero and cross-source null", async () => {
    const zeroWorkspace = "ws_stripe_paid_zero";
    const mixedWorkspace = "ws_stripe_paid_cross_source";
    for (const workspaceId of [zeroWorkspace, mixedWorkspace]) {
      await db.withTransaction(async (tx) => {
        await tx.ensureWorkspace(workspaceId, `Stripe paid snapshot ${workspaceId}`);
        await tx.ensureFirstPhaseDatasets(workspaceId);
      });
      const ds = await db.query<{ id: string }>(
        "select id from datasets where workspace_id = $1 and key = 'billing'",
        [workspaceId]
      );
      await db.query(
        `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
         values ($1, $2, $3, 'stripe', 'Stripe', $1, 'connected')`,
        [`src_${workspaceId}_a`, workspaceId, ds[0]?.id]
      );
    }

    const zeroRows = await db.query<{ paid: string | null }>(
      `select stripe_paid_subscribers::text as paid
         from queryable.vw_stripe_paid_subscribers where workspace_id = $1`,
      [zeroWorkspace]
    );
    expect(zeroRows).toEqual([{ paid: "0" }]);

    const mixedDs = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [mixedWorkspace]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1, $2, $3, 'stripe', 'Stripe B', $1, 'connected')`,
      [`src_${mixedWorkspace}_b`, mixedWorkspace, mixedDs[0]?.id]
    );
    for (const [suffix, sourceId, complete] of [
      ["complete", `src_${mixedWorkspace}_a`, true],
      ["incomplete", `src_${mixedWorkspace}_b`, false],
    ] as const) {
      await db.query(
        `insert into stripe_subscriptions
          (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
           created_at_source, items_sync_complete, discounts_sync_complete)
         values ($1, $2, $3, $4, $5, 'active', now(), $6, true)`,
        [`row_${suffix}`, mixedWorkspace, sourceId, `sub_${suffix}`, "cus_shared_across_accounts", complete]
      );
      await db.query(
        `insert into stripe_subscription_items
          (id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
           currency, unit_amount, quantity, recurring_interval, recurring_interval_count,
           recurring_usage_type, billing_scheme, pricing_state)
         values ($1, $2, $3, $4, $5, 'usd', 1000, 1, 'month', 1,
                 'licensed', 'per_unit', 'licensed_per_unit')`,
        [`item_${suffix}`, mixedWorkspace, sourceId, `si_${suffix}`, `sub_${suffix}`]
      );
    }
    const mixedRows = await db.query<{ paid: string | null }>(
      `select stripe_paid_subscribers::text as paid
         from queryable.vw_stripe_paid_subscribers where workspace_id = $1`,
      [mixedWorkspace]
    );
    expect(mixedRows).toEqual([{ paid: null }]);

    await db.query(
      `update sources set status = 'error' where id = $1`,
      [`src_${mixedWorkspace}_b`]
    );
    const connectedOnly = await db.query<{ paid: string | null }>(
      `select stripe_paid_subscribers::text as paid
         from queryable.vw_stripe_paid_subscribers where workspace_id = $1`,
      [mixedWorkspace]
    );
    expect(connectedOnly).toEqual([{ paid: "1" }]);
  });

  it("0057 exposes aggregate-only current trials with truthful value and mode diagnostics", async () => {
    const workspaceId = "ws_stripe_trial_current";
    const currentSnapshotAsOf = recentTimestamptzIso();
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe current trials");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId],
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status, last_synced_at)
       values ('src_trial_current', $1, $2, 'stripe', 'Stripe', 'acct_trial_current', 'connected', $3::timestamptz)`,
      [workspaceId, ds[0]?.id, currentSnapshotAsOf],
    );
    await db.query(
      `insert into stripe_trial_history_coverage
        (id, workspace_id, source_id, continuous_coverage_from, closed_through_exclusive,
         last_successful_sync_at, parser_version)
       values ('coverage_trial_current', $1, 'src_trial_current',
               '2026-06-01T00:00:00Z', '2026-08-04T00:00:00Z',
               '2026-08-04T00:01:00Z', 'stripe-trial-events-v1')`,
      [workspaceId],
    );
    await db.query(
      `insert into stripe_subscriptions
        (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
         created_at_source, items_sync_complete, discounts_sync_complete, livemode)
       values
        ('subrow_trial_50', $1, 'src_trial_current', 'sub_trial_50', 'cus_trial_50', 'trialing',
         '2026-07-20T00:00:00Z', true, true, true),
        ('subrow_trial_zero', $1, 'src_trial_current', 'sub_trial_zero', 'cus_trial_zero', 'trialing',
         '2026-07-21T00:00:00Z', true, true, true),
        ('subrow_trial_incomplete', $1, 'src_trial_current', 'sub_trial_incomplete', 'cus_trial_incomplete', 'trialing',
         '2026-07-22T00:00:00Z', true, true, true)`,
      [workspaceId],
    );
    await db.query(
      `insert into stripe_subscription_items
        (id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
         currency, unit_amount, quantity, recurring_interval, recurring_interval_count,
         recurring_usage_type, billing_scheme, pricing_state)
       values
        ('item_trial_50', $1, 'src_trial_current', 'si_trial_50', 'sub_trial_50',
         'usd', 5000, 1, 'month', 1, 'licensed', 'per_unit', 'licensed_per_unit'),
        ('item_trial_zero', $1, 'src_trial_current', 'si_trial_zero', 'sub_trial_zero',
         'usd', 0, 1, 'month', 1, 'licensed', 'per_unit', 'licensed_per_unit'),
        ('item_trial_incomplete', $1, 'src_trial_current', 'si_trial_incomplete', 'sub_trial_incomplete',
         'usd', null, 1, 'month', 1, 'metered', 'per_unit', 'metered')`,
      [workspaceId],
    );

    const rows = await db.query<{
      currency: string | null;
      current_trial_count: string | null;
      valued_trial_count: string | null;
      potential_mrr_minor: string | null;
      value_status: string;
      incomplete_value_count: string;
      data_as_of: string | Date | null;
    }>(
      `select currency, current_trial_count::text, valued_trial_count::text,
              potential_mrr_minor::text, value_status, incomplete_value_count::text, data_as_of
         from queryable.vw_stripe_current_trials
        where workspace_id = $1 order by currency nulls last`,
      [workspaceId],
    );
    expect(rows).toEqual([expect.objectContaining({
      currency: "usd",
      current_trial_count: "3",
      valued_trial_count: "2",
      potential_mrr_minor: null,
      value_status: "partial",
      incomplete_value_count: "1",
    })]);
    expect(new Date(rows[0]?.data_as_of ?? "").toISOString()).toBe(currentSnapshotAsOf);

    await db.query(
      `update stripe_subscriptions set livemode = null
        where workspace_id = $1 and stripe_subscription_id = 'sub_trial_incomplete'`,
      [workspaceId],
    );
    const unavailable = await db.query<{ current_trial_count: string | null; value_status: string }>(
      `select current_trial_count::text, value_status
         from queryable.vw_stripe_current_trials where workspace_id = $1`,
      [workspaceId],
    );
    expect(unavailable).toEqual([{ current_trial_count: null, value_status: "unavailable" }]);

    const zeroWorkspace = "ws_stripe_trial_current_zero";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(zeroWorkspace, "Stripe zero current trials");
      await tx.ensureFirstPhaseDatasets(zeroWorkspace);
    });
    const zeroDs = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [zeroWorkspace],
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status, last_synced_at)
       values ('src_trial_current_zero',$1,$2,'stripe','Stripe','acct_trial_current_zero','connected',$3::timestamptz)`,
      [zeroWorkspace, zeroDs[0]?.id, currentSnapshotAsOf],
    );
    expect(await db.query<{
      current_trial_count: string;
      potential_mrr_minor: string;
      value_status: string;
    }>(
      `select current_trial_count::text, potential_mrr_minor::text, value_status
         from queryable.vw_stripe_current_trials where workspace_id = $1`,
      [zeroWorkspace],
    )).toEqual([{
      current_trial_count: "0",
      potential_mrr_minor: "0.000000000000",
      value_status: "complete",
    }]);
    // A brand-new Stripe account with no subscriptions at all is an HONEST zero, not a diagnostic.
    expect(await db.query<{ incomplete_reasons: string[] }>(
      `select incomplete_reasons from queryable.vw_stripe_current_trials where workspace_id = $1`,
      [zeroWorkspace],
    )).toEqual([{ incomplete_reasons: [] }]);
  });

  it("0057 reports a test-mode-only Stripe source as unavailable instead of a confident zero", async () => {
    const workspaceId = "ws_stripe_trial_test_mode";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe test-mode trials");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId],
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status, last_synced_at)
       values ('src_trial_test_mode', $1, $2, 'stripe', 'Stripe', 'acct_trial_test_mode', 'connected', now())`,
      [workspaceId, ds[0]?.id],
    );
    // Every subscription on this source is test mode: no nulls (so has_missing_mode is false) and
    // no live rows (so has_mixed_mode is false). Without the test-mode flag this reads as 0 trials.
    await db.query(
      `insert into stripe_subscriptions
        (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id, status,
         created_at_source, items_sync_complete, discounts_sync_complete, livemode)
       values
        ('subrow_test_mode_trial', $1, 'src_trial_test_mode', 'sub_test_mode_trial', 'cus_test_mode',
         'trialing', '2026-07-20T00:00:00Z', true, true, false)`,
      [workspaceId],
    );
    await db.query(
      `insert into stripe_subscription_items
        (id, workspace_id, source_id, stripe_subscription_item_id, stripe_subscription_id,
         currency, unit_amount, quantity, recurring_interval, recurring_interval_count,
         recurring_usage_type, billing_scheme, pricing_state)
       values ('item_test_mode_trial', $1, 'src_trial_test_mode', 'si_test_mode_trial',
               'sub_test_mode_trial', 'usd', 5000, 1, 'month', 1,
               'licensed', 'per_unit', 'licensed_per_unit')`,
      [workspaceId],
    );

    expect(await db.query<{
      current_trial_count: string | null;
      valued_trial_count: string | null;
      potential_mrr_minor: string | null;
      value_status: string;
      incomplete_value_count: string | null;
      incomplete_reasons: string[];
    }>(
      `select current_trial_count::text, valued_trial_count::text, potential_mrr_minor::text,
              value_status, incomplete_value_count::text, incomplete_reasons
         from queryable.vw_stripe_current_trials where workspace_id = $1`,
      [workspaceId],
    )).toEqual([{
      current_trial_count: null,
      valued_trial_count: null,
      potential_mrr_minor: null,
      value_status: "unavailable",
      incomplete_value_count: null,
      incomplete_reasons: ["test_mode_source"],
    }]);

    // The same source in live mode counts normally — the flag keys on mode, not on emptiness.
    await db.query(
      `update stripe_subscriptions set livemode = true
        where workspace_id = $1 and source_id = 'src_trial_test_mode'`,
      [workspaceId],
    );
    expect(await db.query<{
      current_trial_count: string;
      potential_mrr_minor: string;
      value_status: string;
      incomplete_reasons: string[];
    }>(
      `select current_trial_count::text, potential_mrr_minor::text, value_status, incomplete_reasons
         from queryable.vw_stripe_current_trials where workspace_id = $1`,
      [workspaceId],
    )).toEqual([{
      current_trial_count: "1",
      potential_mrr_minor: "5000.000000000000",
      value_status: "complete",
      incomplete_reasons: [],
    }]);
  });

  it("0057 attributes mature event-proven trials only to positive post-end invoices inside 30 days", async () => {
    const viewSql = loadMigrations().find((migration) => migration.id === "0057_stripe_trial_cohorts.sql")?.sql ?? "";
    expect(viewSql).toContain("queryable.vw_stripe_trial_start_cohort_daily");
    expect(viewSql).toContain("queryable.vw_stripe_trial_conversion_daily");
    expect(viewSql).toContain("queryable.vw_stripe_trial_coverage");
    expect(viewSql).not.toContain("stripe_customer_id, stripe_subscription_id");
  });

  it("0057 cohort daily honors coverage cutoffs, acquisition exclusion, maturity, and [end,end+30d) attribution", async () => {
    const workspaceId = "ws_stripe_trial_cohort";
    const sourceId = "src_stripe_trial_cohort";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe trial cohorts");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId],
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1,$2,$3,'stripe','Stripe',$1,'connected')`,
      [sourceId, workspaceId, ds[0]?.id],
    );
    await db.query(
      `insert into stripe_trial_history_coverage
        (id, workspace_id, source_id, continuous_coverage_from, closed_through_exclusive,
         incomplete_event_count, incomplete_reasons, parser_version)
       values ('coverage_trial_cohort',$1,$2,'2026-06-01T00:00:00Z','2026-08-15T00:00:00Z',
               0,array[]::text[],'stripe-trial-events-v1')`,
      [workspaceId, sourceId],
    );
    await db.query(
      `insert into stripe_invoice_sync_state
        (id, workspace_id, source_id, backfill_state, latest_successful_stripe_cutoff)
       values ('invoice_state_trial_cohort',$1,$2,'complete','2026-08-10T00:00:00Z')`,
      [workspaceId, sourceId],
    );
    const spells = [
      ["converted", "2026-07-01", "2026-07-05", "usd", 5000],
      ["boundary", "2026-07-02", "2026-07-05", "usd", 4000],
      ["acquisition", "2026-07-03", "2026-07-05", "usd", 7000],
      ["immature", "2026-07-04", "2026-07-25", "gbp", 3000],
      ["zero", "2026-07-05", "2026-07-06", "usd", 0],
      ["novalue", "2026-07-06", "2026-07-07", null, null],
      // An EXISTING paying customer trialing a SECOND subscription (upsell). The prior payment sits
      // on a different subscription, so only a customer-scoped exclusion catches it.
      ["upsell", "2026-07-09", "2026-07-10", "usd", 2000],
    ] as const;
    for (const [name, start, end, currency, value] of spells) {
      await db.query(
        `insert into stripe_trial_spells
          (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id,
           start_event_id, start_at, scheduled_trial_end, effective_trial_end,
           end_event_id, end_authority, terminal_status, livemode,
           business_eligible_at_capture, frozen_currency, frozen_net_monthly_amount_minor,
           frozen_value_observed_at, frozen_value_provenance, value_incomplete_reasons,
           classifier_version)
         values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$8::timestamptz,
                 $9,'observed_trial_transition','active',true,true,$10,$11,
                 case when $11::numeric is null then null else '2026-07-01T00:00:00Z'::timestamptz end,
                 case when $11::numeric is null then null else 'first_complete_current_observation_v1' end,
                 case when $11::numeric is null then array['frozen_value_not_observed']::text[] else array[]::text[] end,
                 'stripe-trial-spells-v1')`,
        [`spell_${name}`, workspaceId, sourceId, `sub_${name}`, `cus_${name}`,
          `evt_start_${name}`, start, end, `evt_end_${name}`, currency, value],
      );
    }
    await db.query(
      `insert into stripe_customers
        (id, workspace_id, source_id, stripe_customer_id, metrics_classification, created_at_source)
       values ('customer_trial_internal',$1,$2,'cus_internal','internal_test','2026-07-01T00:00:00Z')`,
      [workspaceId, sourceId],
    );
    await db.query(
      `insert into stripe_trial_spells
        (id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id,
         start_event_id, start_at, effective_trial_end, end_authority, terminal_status,
         livemode, business_eligible_at_capture, classifier_version)
       values
        ('spell_internal',$1,$2,'sub_internal','cus_internal','evt_start_internal',
         '2026-07-07T00:00:00Z','2026-07-08T00:00:00Z','observed_trial_transition','active',
         true,true,'stripe-trial-spells-v1'),
        ('spell_capture_ineligible',$1,$2,'sub_capture_ineligible','cus_capture_ineligible',
         'evt_start_capture_ineligible','2026-07-08T00:00:00Z','2026-07-09T00:00:00Z',
         'observed_trial_transition','active',true,false,'stripe-trial-spells-v1')`,
      [workspaceId, sourceId],
    );
    const invoices = [
      ["converted", "sub_converted", "2026-07-05T00:00:00Z"],
      ["boundary", "sub_boundary", "2026-08-04T00:00:00Z"],
      ["acquisition", "sub_acquisition", "2026-07-01T00:00:00Z"],
      ["upsell", "sub_upsell_original", "2026-07-01T00:00:00Z"],
    ] as const;
    for (const [name, subscriptionId, paidAt] of invoices) {
      await db.query(
        `insert into stripe_invoices
          (id, workspace_id, source_id, stripe_invoice_id, stripe_customer_id,
           stripe_subscription_id, subscription_origin, status, currency,
           amount_paid, amount_due, paid_at, created_at_source)
         values ($1,$2,$3,$4,$5,$6,'subscription','paid','usd',100,100,$7,$7)`,
        [`invoice_${name}`, workspaceId, sourceId, `in_${name}`, `cus_${name}`, subscriptionId, paidAt],
      );
    }

    const startSummary = await db.query<{
      new_trials: string;
      valued_trials: string;
      potential_minor: string;
      acquisition_excluded: string;
      incomplete_value: string;
    }>(
      `select sum(new_trial_count)::text as new_trials,
              sum(valued_trial_count)::text as valued_trials,
              sum(potential_mrr_minor)::text as potential_minor,
              sum(acquisition_excluded_count)::text as acquisition_excluded,
              sum(incomplete_value_count)::text as incomplete_value
         from queryable.vw_stripe_trial_start_cohort_daily
        where workspace_id = $1 and start_cohort_date >= date '2026-07-01'
          and start_cohort_date < date '2026-08-01'`,
      [workspaceId],
    );
    expect(startSummary).toEqual([{
      new_trials: "5",
      valued_trials: "4",
      potential_minor: "12000.000000000000",
      // Both the same-subscription payer AND the upsell payer are excluded; a subscription-scoped
      // exclusion would report 1 here and count the upsell as a new acquisition.
      acquisition_excluded: "2",
      incomplete_value: "1",
    }]);
    expect(await db.query<{ new_trial_count: string; acquisition_excluded_count: string }>(
      `select new_trial_count::text, acquisition_excluded_count::text
         from queryable.vw_stripe_trial_start_cohort_daily
        where workspace_id = $1 and start_cohort_date = date '2026-07-09'`,
      [workspaceId],
    )).toEqual([{ new_trial_count: "0", acquisition_excluded_count: "1" }]);
    expect(await db.query<{ completed_trial_count: string; acquisition_excluded_count: string }>(
      `select completed_trial_count::text, acquisition_excluded_count::text
         from queryable.vw_stripe_trial_conversion_daily
        where workspace_id = $1 and end_cohort_date = date '2026-07-10'`,
      [workspaceId],
    )).toEqual([{ completed_trial_count: "0", acquisition_excluded_count: "1" }]);
    expect(await db.query<{ statuses: string[] }>(
      `select array_agg(distinct daily_status order by daily_status) as statuses
         from queryable.vw_stripe_trial_start_cohort_daily
        where workspace_id = $1 and start_cohort_date >= date '2026-07-01'
          and start_cohort_date < date '2026-08-01'`,
      [workspaceId],
    )).toEqual([{ statuses: ["complete", "value_incomplete"] }]);
    const conversionSummary = await db.query<{
      mature: string;
      converted: string;
      late: string;
      statuses: string[];
    }>(
      `select sum(mature_completed_trial_count)::text as mature,
              sum(converted_30d_count)::text as converted,
              sum(late_payment_count)::text as late,
              array_agg(distinct conversion_status order by conversion_status) as statuses
         from queryable.vw_stripe_trial_conversion_daily
        where workspace_id = $1 and end_cohort_date >= date '2026-07-01'
          and end_cohort_date < date '2026-08-01'`,
      [workspaceId],
    );
    expect(conversionSummary).toEqual([{
      mature: "4",
      converted: "1",
      late: "1",
      statuses: ["complete", "no_mature_completed_trials"],
    }]);
    const coverage = await db.query<{
      lifecycle_data_as_of: string | Date;
      invoice_data_as_of: string | Date;
      conversion_data_as_of: string | Date;
      conversion_status: string;
      attribution_days: number;
    }>(
      `select lifecycle_data_as_of, invoice_data_as_of, conversion_data_as_of,
              conversion_status, attribution_days
         from queryable.vw_stripe_trial_coverage where workspace_id = $1`,
      [workspaceId],
    );
    expect(new Date(coverage[0]!.lifecycle_data_as_of).toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(new Date(coverage[0]!.invoice_data_as_of).toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(new Date(coverage[0]!.conversion_data_as_of).toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(coverage[0]).toMatchObject({ conversion_status: "complete", attribution_days: 30 });

    const secondSourceId = "src_stripe_trial_cohort_b";
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1,$2,$3,'stripe','Stripe B',$1,'connected')`,
      [secondSourceId, workspaceId, ds[0]?.id],
    );
    await db.query(
      `insert into stripe_trial_history_coverage
        (id, workspace_id, source_id, continuous_coverage_from, closed_through_exclusive,
         incomplete_event_count, incomplete_reasons, parser_version)
       values ('coverage_trial_cohort_b',$1,$2,'2026-07-01T00:00:00Z','2026-08-12T00:00:00Z',
               0,array[]::text[],'stripe-trial-events-v1')`,
      [workspaceId, secondSourceId],
    );
    await db.query(
      `insert into stripe_invoice_sync_state
        (id, workspace_id, source_id, backfill_state, latest_successful_stripe_cutoff)
       values ('invoice_state_trial_cohort_b',$1,$2,'complete','2026-08-09T00:00:00Z')`,
      [workspaceId, secondSourceId],
    );
    const intersection = await db.query<{
      continuous_coverage_from: string | Date;
      lifecycle_data_as_of: string | Date;
      invoice_data_as_of: string | Date;
      conversion_data_as_of: string | Date;
    }>(
      `select continuous_coverage_from, lifecycle_data_as_of, invoice_data_as_of, conversion_data_as_of
         from queryable.vw_stripe_trial_coverage where workspace_id = $1`,
      [workspaceId],
    );
    expect(new Date(intersection[0]!.continuous_coverage_from).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(new Date(intersection[0]!.lifecycle_data_as_of).toISOString()).toBe("2026-08-12T00:00:00.000Z");
    expect(new Date(intersection[0]!.invoice_data_as_of).toISOString()).toBe("2026-08-09T00:00:00.000Z");
    expect(new Date(intersection[0]!.conversion_data_as_of).toISOString()).toBe("2026-08-09T00:00:00.000Z");

    await db.query(
      `update stripe_invoice_sync_state set backfill_state = 'in_progress'
        where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    expect(await db.query<{ conversion_status: string }>(
      `select conversion_status from queryable.vw_stripe_trial_coverage where workspace_id = $1`,
      [workspaceId],
    )).toEqual([{ conversion_status: "invoice_incomplete" }]);
    expect(await db.query<{ unavailable_mature_rows: string }>(
      `select count(*) filter (
                where mature_completed_trial_count > 0
                  and converted_30d_count is null
                  and conversion_status = 'invoice_incomplete'
              )::text as unavailable_mature_rows
         from queryable.vw_stripe_trial_conversion_daily where workspace_id = $1`,
      [workspaceId],
    )).toEqual([{ unavailable_mature_rows: "3" }]);

    const exposedColumns = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'queryable'
          and table_name in ('vw_stripe_current_trials','vw_stripe_trial_coverage',
                             'vw_stripe_trial_start_cohort_daily','vw_stripe_trial_conversion_daily')
          and column_name in ('stripe_customer_id','stripe_subscription_id','start_event_id','end_event_id')`,
    );
    expect(exposedColumns).toEqual([]);
  });

  it("uses gross paid invoice amount instead of invoice line face value", async () => {
    const workspaceId = "ws_stripe_cash_revenue";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Stripe cash revenue workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'billing'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values
        ('src_stripe_cash_revenue', $1, $2, 'stripe', 'Stripe', 'acct_cash', 'connected'),
        ('src_stripe_cash_revenue_decoy', $1, $2, 'stripe', 'Stripe decoy', 'acct_cash_decoy', 'connected')`,
      [workspaceId, ds[0]?.id]
    );
    await db.query(
      `insert into stripe_customers
        (id, workspace_id, source_id, stripe_customer_id, metrics_classification, created_at_source)
       values
        ('customer_internal_cash', $1, 'src_stripe_cash_revenue', 'cus_internal', 'internal_test', '2026-07-01T00:00:00Z'),
        ('customer_cross_source_decoy', $1, 'src_stripe_cash_revenue_decoy', 'cus_cross_source', 'internal_test', '2026-07-01T00:00:00Z')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_invoices
        (id, workspace_id, source_id, stripe_invoice_id, stripe_customer_id, status, currency,
         amount_paid, amount_due, paid_at, created_at_source)
       values
        ('invoice_discounted', $1, 'src_stripe_cash_revenue', 'inv_discounted', 'cus_cross_source',
         'paid', 'usd', 5000, 5000, '2026-07-07T12:00:00Z', '2026-07-07T12:00:00Z'),
        ('invoice_internal_paid', $1, 'src_stripe_cash_revenue', 'inv_internal_paid', 'cus_internal',
         'paid', 'usd', 6000, 6000, '2026-07-08T12:00:00Z', '2026-07-08T12:00:00Z'),
        ('invoice_zero', $1, 'src_stripe_cash_revenue', 'inv_zero', 'cus_internal',
         'paid', 'usd', 0, 0, '2026-07-10T12:00:00Z', '2026-07-10T12:00:00Z')`,
      [workspaceId]
    );
    await db.query(
      `insert into stripe_invoice_lines
        (id, workspace_id, source_id, stripe_line_id, stripe_invoice_id, stripe_product_id,
         stripe_price_id, amount_cents, currency)
       values
        ('line_discounted', $1, 'src_stripe_cash_revenue', 'il_discounted', 'inv_discounted',
         'prod_real', 'price_real', 6000, 'usd'),
        ('line_internal_paid', $1, 'src_stripe_cash_revenue', 'il_internal_paid', 'inv_internal_paid',
         'prod_internal', 'price_internal', 6000, 'usd'),
        ('line_zero', $1, 'src_stripe_cash_revenue', 'il_zero', 'inv_zero',
         'prod_test', 'price_test', 60000, 'usd')`,
      [workspaceId]
    );

    const revenue = await db.query<{ recognized_revenue: string }>(
      `select coalesce(sum(recognized_revenue), 0)::text as recognized_revenue
       from queryable.vw_revenue_by_source
       where workspace_id = $1
         and occurred_on between '2026-07-01' and '2026-07-31'`,
      [workspaceId]
    );

    expect(revenue[0]?.recognized_revenue).toBe("5000");

    // Post-payment credit notes are EXPOSED, never netted into recognized_revenue: a refund is
    // visible to a consumer that wants to net it, and the gross number keeps its meaning.
    await db.query(
      `update stripe_invoices set post_payment_credit_notes_amount = 1500
        where workspace_id = $1 and id = 'invoice_discounted'`,
      [workspaceId]
    );
    const credited = await db.query<{
      recognized_revenue: string;
      post_payment_credited_minor: string | null;
    }>(
      `select recognized_revenue::text, post_payment_credited_minor::text
         from queryable.vw_revenue_by_source
        where workspace_id = $1 and invoice_external_id = 'inv_discounted'`,
      [workspaceId]
    );
    expect(credited).toEqual([{ recognized_revenue: "5000", post_payment_credited_minor: "1500" }]);

    const definitions = await db.query<{ name: string; description: string; caveats: string }>(
      `select name, description, caveats
         from metric_definitions
        where id = 'recognized_revenue'`
    );
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe("Gross paid invoice amount");
    const metadata = `${definitions[0]?.name} ${definitions[0]?.description} ${definitions[0]?.caveats}`.toLowerCase();
    expect(metadata).toContain("gross of later refunds");
    expect(metadata).toContain("not accounting revenue");
    expect(metadata).toContain("not proof of cash receipt");
    expect(metadata).not.toContain("cash collected");
    expect(metadata).not.toContain("gross revenue");
  });

  it("0038 pins chat_action_calls to its origin workspace (NOT NULL, FK, backfilled from chat_sessions)", async () => {
    // Column exists, is NOT NULL, and references workspaces(id).
    const columns = await db.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `select column_name, is_nullable, data_type
         from information_schema.columns
        where table_name = 'chat_action_calls' and column_name = 'workspace_id'`
    );
    expect(columns).toHaveLength(1);
    expect(columns[0]?.is_nullable).toBe("NO");
    expect(columns[0]?.data_type).toBe("text");

    // The FK to workspaces(id) exists.
    const fk = await db.query<{ constraint_name: string }>(
      `select tc.constraint_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
        where tc.table_name = 'chat_action_calls'
          and tc.constraint_type = 'FOREIGN KEY'
          and kcu.column_name = 'workspace_id'`
    );
    expect(fk.length).toBeGreaterThanOrEqual(1);

    // recordActionCall writes workspace_id; a row is bound to the session's workspace.
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_pin_a", "Pin A");
    });
    await db.query(
      `insert into chat_sessions (id, workspace_id, session_key, actor_id, surface)
       values ('sess_pin_a', 'ws_pin_a', 'sess_pin_a', 'cli', 'cli')`
    );
    await db.query(
      `insert into chat_action_calls (id, session_id, workspace_id, action_id, authority, status)
       values ('call_pin_a', 'sess_pin_a', 'ws_pin_a', 'create_meta_campaign', 'operator', 'requires_confirmation')`
    );
    const stored = await db.query<{ workspace_id: string }>(
      "select workspace_id from chat_action_calls where id = 'call_pin_a'"
    );
    expect(stored[0]?.workspace_id).toBe("ws_pin_a");
  });

  it("0039 adds the 5 connection_credentials operational columns with the stated types/defaults", async () => {
    const columns = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'connection_credentials'
          and column_name in (
            'selected_pixel_id', 'is_system_user', 'last_dispatch_at',
            'last_dispatch_status', 'last_error'
          )
        order by column_name`
    );
    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]));

    // All 5 new columns exist.
    expect(columns).toHaveLength(5);

    // selected_pixel_id — text, nullable.
    expect(byName.selected_pixel_id?.data_type).toBe("text");
    expect(byName.selected_pixel_id?.is_nullable).toBe("YES");

    // is_system_user — boolean, NOT NULL, default false.
    expect(byName.is_system_user?.data_type).toBe("boolean");
    expect(byName.is_system_user?.is_nullable).toBe("NO");
    expect(byName.is_system_user?.column_default).toBe("false");

    // last_dispatch_at — timestamptz, nullable.
    expect(byName.last_dispatch_at?.data_type).toBe("timestamp with time zone");
    expect(byName.last_dispatch_at?.is_nullable).toBe("YES");

    // last_dispatch_status — text, nullable, no CHECK.
    expect(byName.last_dispatch_status?.data_type).toBe("text");
    expect(byName.last_dispatch_status?.is_nullable).toBe("YES");

    // last_error — text, nullable.
    expect(byName.last_error?.data_type).toBe("text");
    expect(byName.last_error?.is_nullable).toBe("YES");

    // expires_at is REUSED (added 0021) — token_expires_at must NOT exist.
    const reused = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'connection_credentials'
          and column_name in ('expires_at', 'token_expires_at', 'account_external_id')`
    );
    const reusedNames = reused.map((r) => r.column_name);
    expect(reusedNames).toContain("expires_at");
    expect(reusedNames).not.toContain("token_expires_at");
    // account_external_id lives on sources — not denormalized here.
    expect(reusedNames).not.toContain("account_external_id");
  });

  it("0039 creates the partial-unique connection_credentials_source_kind_uq index (unique, partial on revoked_at is null, on (source_id, credential_kind))", async () => {
    const idx = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where tablename = 'connection_credentials'
          and indexname = 'connection_credentials_source_kind_uq'`
    );
    expect(idx).toHaveLength(1);
    const def = (idx[0]?.indexdef ?? "").toLowerCase();
    // Unique, on the right columns, partial on revoked_at is null.
    expect(def).toContain("create unique index");
    expect(def).toContain("(source_id, credential_kind)");
    expect(def).toContain("where (revoked_at is null)");
  });

  it("0039 partial-unique rejects two live rows of the same (source_id, credential_kind) but allows a revoked + live pair", async () => {
    // Seed a workspace + dataset + source so the FK chain holds.
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_cred_uq", "Cred UQ");
      await tx.ensureFirstPhaseDatasets("ws_cred_uq");
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = 'ws_cred_uq' and key = 'web'"
    );
    await db.query(
      `insert into sources (
         id, workspace_id, dataset_id, provider, connection_name, account_external_id, status
       ) values ('src_cred_uq', 'ws_cred_uq', $1, 'posthog', 'conn', 'acct', 'connected')`,
      [ds[0]?.id]
    );

    // First live credential of kind 'access_token' — inserts fine.
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ('cred_live_1', 'ws_cred_uq', 'src_cred_uq', 'access_token', 'enc')`
    );

    // Second live credential of the SAME (source_id, credential_kind) — rejected by the partial-unique.
    await expect(
      db.query(
        `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
         values ('cred_live_2', 'ws_cred_uq', 'src_cred_uq', 'access_token', 'enc')`
      )
    ).rejects.toThrow();

    // Revoke the live row, then a fresh live row of the same kind is ALLOWED (revoked row excluded from the index).
    await db.query("update connection_credentials set revoked_at = now() where id = 'cred_live_1'");
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ('cred_live_3', 'ws_cred_uq', 'src_cred_uq', 'access_token', 'enc')`
    );
    const live = await db.query<{ count: string }>(
      `select count(*)::text as count from connection_credentials
        where source_id = 'src_cred_uq' and credential_kind = 'access_token' and revoked_at is null`
    );
    expect(live[0]?.count).toBe("1");
  });

  it("0044 sources.consecutive_sync_failures defaults to 0 and resets ONLY on the 'connected' transition", async () => {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_csf", "CSF");
      await tx.ensureFirstPhaseDatasets("ws_csf");
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = 'ws_csf' and key = 'web'"
    );
    await db.query(
      `insert into sources (
         id, workspace_id, dataset_id, provider, connection_name, account_external_id, status
       ) values ('src_csf', 'ws_csf', $1, 'posthog', 'conn', 'acct', 'connected')`,
      [ds[0]?.id]
    );

    // The column backfills existing/new rows with 0 (NOT NULL is orphan-safe via the default).
    const fresh = await db.query<{ consecutive_sync_failures: number }>(
      "select consecutive_sync_failures from sources where id = 'src_csf'"
    );
    expect(fresh[0]?.consecutive_sync_failures).toBe(0);

    // Simulate the recordSyncFailure COUNTED increment (two independent transient failure
    // episodes — the counted write also stamps the 0045 time gate).
    await db.query(
      "update sources set consecutive_sync_failures = consecutive_sync_failures + 1, last_counted_sync_failure_at = now() where id = 'src_csf'"
    );
    await db.query(
      "update sources set consecutive_sync_failures = consecutive_sync_failures + 1, last_counted_sync_failure_at = now() where id = 'src_csf'"
    );

    // A non-'connected' status write (e.g. the syncing flip at batch open) must NOT reset the
    // streak — nor its time gate.
    await db.updateSourceStatus("src_csf", "syncing");
    const midStreak = await db.query<{
      consecutive_sync_failures: number;
      status: string;
      last_counted_sync_failure_at: string | null;
    }>(
      "select consecutive_sync_failures, status, last_counted_sync_failure_at from sources where id = 'src_csf'"
    );
    expect(midStreak[0]?.status).toBe("syncing");
    expect(midStreak[0]?.consecutive_sync_failures).toBe(2);
    expect(midStreak[0]?.last_counted_sync_failure_at).not.toBeNull();

    // The 'connected' transition (successful sync close / manual reconnect) zeroes the streak
    // AND nulls the time gate — a stale gate surviving recovery would swallow the first strike
    // of the NEXT genuine failure episode.
    await db.updateSourceStatus("src_csf", "connected", new Date().toISOString());
    const healthy = await db.query<{
      consecutive_sync_failures: number;
      status: string;
      last_counted_sync_failure_at: string | null;
    }>(
      "select consecutive_sync_failures, status, last_counted_sync_failure_at from sources where id = 'src_csf'"
    );
    expect(healthy[0]?.status).toBe("connected");
    expect(healthy[0]?.consecutive_sync_failures).toBe(0);
    expect(healthy[0]?.last_counted_sync_failure_at).toBeNull();
  });

  it("connectSource re-connect (on-conflict) zeroes the failure streak like every other path back to health", async () => {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_csf2", "CSF2");
      await tx.ensureFirstPhaseDatasets("ws_csf2");
    });
    // First connect creates the row; then park it the way a run of transient failures would:
    // status 'error' with a streak at the escalation threshold.
    await db.connectSource({
      workspaceId: "ws_csf2",
      provider: "posthog",
      connectionName: "conn2",
      accountExternalId: "acct2"
    });
    await db.query(
      "update sources set status = 'error', consecutive_sync_failures = 3, last_counted_sync_failure_at = now() where workspace_id = 'ws_csf2' and account_external_id = 'acct2'"
    );

    // Re-authorizing through the CONNECT flow hits the on-conflict update for the same
    // (workspace, provider, account_external_id). It must restore health COMPLETELY — a stale
    // streak surviving here would re-park the source on the very next single transient blip,
    // and a stale gate timestamp would swallow the next episode's first strike.
    await db.connectSource({
      workspaceId: "ws_csf2",
      provider: "posthog",
      connectionName: "conn2-again",
      accountExternalId: "acct2"
    });
    const revived = await db.query<{
      consecutive_sync_failures: number;
      status: string;
      last_counted_sync_failure_at: string | null;
    }>(
      "select consecutive_sync_failures, status, last_counted_sync_failure_at from sources where workspace_id = 'ws_csf2' and account_external_id = 'acct2'"
    );
    expect(revived).toHaveLength(1); // on-conflict updated, not duplicated
    expect(revived[0]?.status).toBe("connected");
    expect(revived[0]?.consecutive_sync_failures).toBe(0);
    expect(revived[0]?.last_counted_sync_failure_at).toBeNull();
  });

  it("0045 time-gates the failure streak: a burst counts once, a spaced episode counts again, reconnect nulls the gate", async () => {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_tg", "TimeGate");
      await tx.ensureFirstPhaseDatasets("ws_tg");
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = 'ws_tg' and key = 'web'"
    );
    await db.query(
      `insert into sources (
         id, workspace_id, dataset_id, provider, connection_name, account_external_id, status
       ) values ('src_tg', 'ws_tg', $1, 'posthog', 'conn', 'acct', 'connected')`,
      [ds[0]?.id]
    );

    // 0045 column exists and defaults to null (= no counted failure since last health).
    const fresh = await db.query<{ last_counted_sync_failure_at: string | null }>(
      "select last_counted_sync_failure_at from sources where id = 'src_tg'"
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.last_counted_sync_failure_at).toBeNull();

    // The EXACT gated increment recordSyncFailure runs (@infinite-os/connectors). Three
    // burst-spaced attempts — scheduler ticks / in-run retries during ONE outage — must count
    // exactly ONCE: the first stamps the gate, the next two match no row.
    const gatedIncrement = () =>
      db.query<{ consecutive_sync_failures: number }>(
        `update sources
         set consecutive_sync_failures = consecutive_sync_failures + 1,
           last_counted_sync_failure_at = now()
         where id = $1
           and (
             last_counted_sync_failure_at is null
             or last_counted_sync_failure_at <= now() - ($2::bigint * interval '1 millisecond')
           )
         returning consecutive_sync_failures`,
        ["src_tg", 10 * 60 * 1000]
      );
    const first = await gatedIncrement();
    expect(first).toHaveLength(1);
    expect(first[0]?.consecutive_sync_failures).toBe(1);
    const burst2 = await gatedIncrement();
    const burst3 = await gatedIncrement();
    expect(burst2).toHaveLength(0);
    expect(burst3).toHaveLength(0);
    const afterBurst = await db.query<{ consecutive_sync_failures: number; status: string }>(
      "select consecutive_sync_failures, status from sources where id = 'src_tg'"
    );
    expect(afterBurst[0]?.consecutive_sync_failures).toBe(1);
    expect(afterBurst[0]?.status).toBe("connected");

    // An INDEPENDENT episode — the last counted failure is beyond the spacing window — counts.
    await db.query(
      "update sources set last_counted_sync_failure_at = now() - interval '11 minutes' where id = 'src_tg'"
    );
    const spaced = await gatedIncrement();
    expect(spaced).toHaveLength(1);
    expect(spaced[0]?.consecutive_sync_failures).toBe(2);

    // The reconnect_source raw update (@infinite-os/analytical-engine) — mirrored verbatim —
    // restores health completely: streak zeroed AND gate nulled.
    await db.query(
      `update sources
       set status = 'connected', connected_at = now(),
         consecutive_sync_failures = 0,
         last_counted_sync_failure_at = null
       where workspace_id = $1 and id = $2`,
      ["ws_tg", "src_tg"]
    );
    const reconnected = await db.query<{
      consecutive_sync_failures: number;
      status: string;
      last_counted_sync_failure_at: string | null;
    }>(
      "select consecutive_sync_failures, status, last_counted_sync_failure_at from sources where id = 'src_tg'"
    );
    expect(reconnected[0]?.status).toBe("connected");
    expect(reconnected[0]?.consecutive_sync_failures).toBe(0);
    expect(reconnected[0]?.last_counted_sync_failure_at).toBeNull();
  });

  it("created all five growth_os_* roles (0006 applied on PGlite)", async () => {
    const roles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname like 'growth_os_%' order by rolname"
    );
    expect(roles.map((r) => r.rolname)).toEqual([
      "growth_os_app",
      "growth_os_migrator",
      "growth_os_read_api",
      "growth_os_tool_agent",
      "growth_os_worker"
    ]);
  });

  it("runs real CRUD against the migrated schema (createProject/list/find)", async () => {
    const created = await createProject(db, "Acme Desktop");
    expect(created.id).toMatch(/^proj_[0-9a-f]{16}$/);
    expect(created.name).toBe("Acme Desktop");

    const listed = await listProjects(db);
    expect(listed.some((p) => p.id === created.id)).toBe(true);

    const found = await findProject(db, "Acme Desktop");
    expect(found?.id).toBe(created.id);
  });

  it("createProjectWithId: creates under the exact supplied id, refuses a taken id atomically", async () => {
    const suppliedId = "9d2e6f1a-3b8c-4a5d-9e7f-1c4b8a2d6e0f";
    const first = await createProjectWithId(db, suppliedId, "Uuid Brand");
    expect(first).toMatchObject({ status: "created", project: { id: suppliedId, name: "Uuid Brand" } });

    // Real PK conflict against PGlite: `on conflict (id) do nothing` returns no row — the existing
    // project keeps its name and owner, the second caller gets a typed refusal, no throw.
    const second = await createProjectWithId(db, suppliedId, "Impostor");
    expect(second).toEqual({ status: "id_conflict" });
    const kept = await findProject(db, suppliedId);
    expect(kept?.name).toBe("Uuid Brand");
  });

  it("exercises a real withTransaction commit (ensureWorkspace + datasets)", async () => {
    const workspaceId = "ws_tx_test";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Tx Workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });

    const datasets = await db.query<{ key: string }>(
      "select key from datasets where workspace_id = $1 order by key",
      [workspaceId]
    );
    expect(datasets.map((d) => d.key)).toEqual(["billing", "web"]);
  });

  it("rolls a failing withTransaction back (no partial workspace persists)", async () => {
    const workspaceId = "ws_tx_rollback";
    await expect(
      db.withTransaction(async (tx) => {
        await tx.ensureWorkspace(workspaceId, "Rollback Workspace");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const rows = await db.query<{ id: string }>(
      "select id from workspaces where id = $1",
      [workspaceId]
    );
    expect(rows).toHaveLength(0);
  });

  it("serializes CONCURRENT withTransaction calls — native tx, no interleaving (C4 HIGH)", async () => {
    // Read-modify-write one counter from N transactions at once. Under wrapPool's single-connection
    // begin/commit, the transactions would interleave on PGlite's ONE connection and lose updates
    // (final < N). PGlite's native transaction() holds the connection mutex, so they serialize and
    // every increment lands (final === N). The setImmediate yield maximizes the interleaving window.
    await db.query("create table if not exists tx_race (n int not null)");
    await db.query("delete from tx_race");
    await db.query("insert into tx_race (n) values (0)");

    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () =>
        db.withTransaction(async (tx) => {
          const rows = await tx.query<{ n: number }>("select n from tx_race");
          const current = Number(rows[0]?.n ?? 0);
          await new Promise((resolve) => setImmediate(resolve)); // yield — invites interleaving
          await tx.query("update tx_race set n = $1", [current + 1]);
        })
      )
    );

    const final = await db.query<{ n: number }>("select n from tx_race");
    expect(Number(final[0]?.n)).toBe(N); // every increment survived → no interleaving
  });

  it("can SELECT from a queryable view (full schema, incl. views, is live)", async () => {
    // vw_meta_ads_adset_daily is created by the last data migration (0035) — a
    // successful empty SELECT proves the whole view stack compiled and applied.
    const rows = await db.query(
      "select * from queryable.vw_meta_ads_adset_daily limit 1"
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it("0043 vw_posthog_site aggregates pageview audience dims from properties, scopes to $pageview, and NULLs missing props", async () => {
    // Seed a workspace + web dataset + a PostHog source, then five posthog_event_truth rows:
    // two macOS/US pageviews (must aggregate to a count of 2), one Windows/CA pageview, one
    // pageview whose properties carry NO $os (operating_system must be NULL — the honest
    // em-dash), and one NON-pageview ($autocapture) that carries $os but MUST be excluded by
    // the view's `where event_name = '$pageview'` scope.
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_ph_aud", "PostHog Audience WS");
      await tx.ensureFirstPhaseDatasets("ws_ph_aud");
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = 'ws_ph_aud' and key = 'web'"
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ('src_ph_aud', 'ws_ph_aud', $1, 'posthog', 'conn', 'acct', 'connected')`,
      [ds[0]?.id]
    );
    const insertEvent = (
      id: string,
      eventName: string,
      occurredAt: string,
      properties: Record<string, unknown>
    ) =>
      db.query(
        `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
         values ($1, 'ws_ph_aud', 'src_ph_aud', $1, $2, $3, $4::jsonb)`,
        [id, eventName, occurredAt, JSON.stringify(properties)]
      );
    await insertEvent("ev_pv_us_1", "$pageview", "2026-07-01T10:00:00Z", {
      $os: "Mac OS X",
      $device_type: "Desktop",
      $browser: "Chrome",
      $geoip_country_name: "United States"
    });
    await insertEvent("ev_pv_us_2", "$pageview", "2026-07-01T11:00:00Z", {
      $os: "Mac OS X",
      $device_type: "Desktop",
      $browser: "Safari",
      $geoip_country_name: "United States"
    });
    await insertEvent("ev_pv_ca", "$pageview", "2026-07-01T12:00:00Z", {
      $os: "Windows",
      $device_type: "Desktop",
      $browser: "Edge",
      $geoip_country_name: "Canada"
    });
    // A pageview with NO $os — operating_system must come back NULL (honest, not fabricated).
    await insertEvent("ev_pv_noos", "$pageview", "2026-07-01T13:00:00Z", {
      $device_type: "Mobile",
      $geoip_country_name: "United States"
    });
    // A non-pageview event carrying $os — MUST be excluded by the view scope.
    await insertEvent("ev_autocapture", "$autocapture", "2026-07-01T14:00:00Z", {
      $os: "Linux",
      $geoip_country_name: "Germany"
    });
    // Since 0063 the view reads the per-(workspace, source, day) rollup, which the connector's
    // CLOSE hook refreshes after every sync — roll the seeded day up the same way here.
    await db.query(
      "select refresh_posthog_daily_rollups('ws_ph_aud', 'src_ph_aud', date '2026-07-01', date '2026-07-01')"
    );

    // Aggregate the view exactly as the engine's runAggregate does (sum over the daily grain).
    const rows = await db.query<{ operating_system: string | null; country: string | null; views: string }>(
      `select operating_system, country, sum(posthog_page_views)::text as views
         from queryable.vw_posthog_site
        where workspace_id = 'ws_ph_aud'
        group by operating_system, country
        order by operating_system nulls last, country`
    );

    // Windows/CA (1) + Mac OS X/US (2) + NULL-os/US (1) = three groups; the $autocapture row is gone.
    expect(rows).toEqual([
      { operating_system: "Mac OS X", country: "United States", views: "2" },
      { operating_system: "Windows", country: "Canada", views: "1" },
      { operating_system: null, country: "United States", views: "1" }
    ]);
    // Linux/Germany came ONLY from the excluded $autocapture event — it must not appear.
    expect(rows.some((r) => r.operating_system === "Linux")).toBe(false);

    // device_type is lower-cased to the mobile/desktop/tablet convention; $device_type "Mobile" -> "mobile".
    const deviceRows = await db.query<{ device_type: string | null; views: string }>(
      `select device_type, sum(posthog_page_views)::text as views
         from queryable.vw_posthog_site
        where workspace_id = 'ws_ph_aud'
        group by device_type
        order by device_type`
    );
    expect(deviceRows).toEqual([
      { device_type: "desktop", views: "3" },
      { device_type: "mobile", views: "1" }
    ]);
  });

  it("deletes a project transactionally end-to-end", async () => {
    const created = await createProject(db, "Delete Me");
    const result = await deleteProject(db, created.id);
    expect(result.deleted).toBe(true);
    const found = await findProject(db, created.id);
    expect(found).toBeNull();
  });

  it("deletes a project carrying the whole PostHog retention footprint (rollups + prune watermark)", async () => {
    // posthog_prune_watermarks (0064) references sources(id) with NO ON DELETE clause, so a table
    // missing from the delete inventory is NOT a leftover-rows nuisance: the `sources` delete raises
    // a foreign-key violation and the WHOLE deleteProject transaction aborts. Any workspace whose
    // PostHog raw had ever been pruned would be permanently undeletable. Seed the full retention
    // footprint so this lane actually exercises it.
    const created = await createProject(db, "Delete Me Pruned");
    await db.withTransaction(async (tx) => {
      await tx.ensureFirstPhaseDatasets(created.id);
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'web'",
      [created.id]
    );
    const SRC = `src_del_${Date.now()}`;
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1, $2, $3, 'posthog', 'conn', $1 || '_acct', 'connected')`,
      [SRC, created.id, ds[0]?.id]
    );
    await db.query(
      `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at, properties)
       values ($1, $2, $3, $1, '$pageview', now(), '{}'::jsonb)`,
      [`ev_del_${Date.now()}`, created.id, SRC]
    );
    await db.query(
      `insert into posthog_event_daily
         (workspace_id, source_id, occurred_on, event_name, is_internal, event_count)
       values ($1, $2, current_date, '$pageview', false, 1)`,
      [created.id, SRC]
    );
    await db.query(
      `insert into posthog_site_daily
         (workspace_id, source_id, occurred_on, page_view_count) values ($1, $2, current_date, 1)`,
      [created.id, SRC]
    );
    await db.query(
      `insert into posthog_prune_watermarks (workspace_id, source_id, pruned_before)
       values ($1, $2, current_date)`,
      [created.id, SRC]
    );

    expect(await deleteProject(db, created.id)).toEqual({ deleted: true });
    expect(await findProject(db, created.id)).toBeNull();
    for (const table of [
      "posthog_prune_watermarks",
      "posthog_event_daily",
      "posthog_site_daily",
      "posthog_event_truth",
      "sources"
    ]) {
      expect(
        await db.query(`select 1 from ${table} where workspace_id = $1`, [created.id])
      ).toEqual([]);
    }
  });
});

describe("connectSource writes the 0039 operational metadata + upserts on re-connect (P0-B2)", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-connectsrc-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists selectedPixelId / isSystemUser / expiresAt / dispatch telemetry when supplied", async () => {
    await db.connectSource({
      workspaceId: "ws_cs_supplied",
      provider: "meta_ads",
      connectionName: "Meta Supplied",
      accountExternalId: "act_supplied",
      credentialKind: "access_token",
      encryptedPayload: "enc-supplied",
      selectedPixelId: "px_123",
      isSystemUser: true,
      expiresAt: "2027-01-02T03:04:05.000Z",
      lastDispatchAt: "2026-06-22T10:00:00.000Z",
      lastDispatchStatus: "succeeded",
      lastError: "prior transient error"
    });

    const rows = await db.query<{
      selected_pixel_id: string | null;
      is_system_user: boolean;
      expires_at: string | null;
      last_dispatch_at: string | null;
      last_dispatch_status: string | null;
      last_error: string | null;
    }>(
      `select selected_pixel_id, is_system_user, expires_at, last_dispatch_at,
              last_dispatch_status, last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_supplied'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected_pixel_id).toBe("px_123");
    expect(rows[0]?.is_system_user).toBe(true);
    expect(new Date(rows[0]?.expires_at ?? "").toISOString()).toBe("2027-01-02T03:04:05.000Z");
    expect(new Date(rows[0]?.last_dispatch_at ?? "").toISOString()).toBe("2026-06-22T10:00:00.000Z");
    expect(rows[0]?.last_dispatch_status).toBe("succeeded");
    expect(rows[0]?.last_error).toBe("prior transient error");
  });

  it("defaults the new columns (NULL / is_system_user=false) when omitted — existing callers unchanged", async () => {
    await db.connectSource({
      workspaceId: "ws_cs_default",
      provider: "stripe",
      connectionName: "Stripe Default",
      accountExternalId: "acct_default",
      credentialKind: "secret_key",
      encryptedPayload: "enc-default"
    });

    const rows = await db.query<{
      selected_pixel_id: string | null;
      is_system_user: boolean;
      expires_at: string | null;
      last_dispatch_at: string | null;
      last_dispatch_status: string | null;
      last_error: string | null;
    }>(
      `select selected_pixel_id, is_system_user, expires_at, last_dispatch_at,
              last_dispatch_status, last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_default'
          and cc.credential_kind = 'secret_key'
          and cc.revoked_at is null`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected_pixel_id).toBeNull();
    expect(rows[0]?.is_system_user).toBe(false);
    expect(rows[0]?.expires_at).toBeNull();
    expect(rows[0]?.last_dispatch_at).toBeNull();
    expect(rows[0]?.last_dispatch_status).toBeNull();
    expect(rows[0]?.last_error).toBeNull();
  });

  it("a re-run for the same (source_id, credential_kind) UPDATEs — one live row, no duplicate", async () => {
    const base = {
      workspaceId: "ws_cs_rerun",
      provider: "meta_ads" as const,
      connectionName: "Meta Rerun",
      accountExternalId: "act_rerun",
      credentialKind: "access_token"
    };

    await db.connectSource({
      ...base,
      encryptedPayload: "enc-first",
      selectedPixelId: "px_first",
      isSystemUser: false
    });
    await db.connectSource({
      ...base,
      encryptedPayload: "enc-second",
      selectedPixelId: "px_second",
      isSystemUser: true,
      lastError: "second-run error"
    });

    const rows = await db.query<{
      encrypted_payload: string;
      selected_pixel_id: string | null;
      is_system_user: boolean;
      last_error: string | null;
    }>(
      `select cc.encrypted_payload, cc.selected_pixel_id, cc.is_system_user, cc.last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_rerun'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );

    // Exactly one live row — the upsert UPDATEd the existing row rather than orphaning a duplicate.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encrypted_payload).toBe("enc-second");
    expect(rows[0]?.selected_pixel_id).toBe("px_second");
    expect(rows[0]?.is_system_user).toBe(true);
    expect(rows[0]?.last_error).toBe("second-run error");

    // And there is still exactly one credential row total for this source (no orphaned duplicate).
    const total = await db.query<{ count: string }>(
      `select count(*)::text as count
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_rerun' and cc.credential_kind = 'access_token'`
    );
    expect(total[0]?.count).toBe("1");
  });

  it("P0-B2: a re-connect that OMITS metadata PRESERVES prior values (COALESCE upsert), updates encrypted_payload", async () => {
    const base = {
      workspaceId: "ws_cs_coalesce",
      provider: "meta_ads" as const,
      connectionName: "Meta Coalesce",
      accountExternalId: "act_coalesce",
      credentialKind: "access_token"
    };

    // First connect WITH metadata: pixel + system-user + dispatch telemetry.
    await db.connectSource({
      ...base,
      encryptedPayload: "enc-original",
      selectedPixelId: "px_1",
      isSystemUser: true,
      lastDispatchAt: "2026-06-22T09:00:00.000Z",
      lastDispatchStatus: "succeeded",
      lastError: "prior transient error"
    });

    // Re-connect (same source_id + kind) OMITTING all metadata — only a fresh token.
    // A naive `= excluded.selected_pixel_id` would null these out; COALESCE must preserve them.
    await db.connectSource({ ...base, encryptedPayload: "enc-rotated" });

    const rows = await db.query<{
      encrypted_payload: string;
      selected_pixel_id: string | null;
      is_system_user: boolean;
      last_dispatch_at: string | null;
      last_dispatch_status: string | null;
      last_error: string | null;
    }>(
      `select cc.encrypted_payload, cc.selected_pixel_id, cc.is_system_user,
              cc.last_dispatch_at, cc.last_dispatch_status, cc.last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_coalesce'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );

    expect(rows).toHaveLength(1);
    // encrypted_payload SHOULD update (it is a direct excluded, not coalesced).
    expect(rows[0]?.encrypted_payload).toBe("enc-rotated");
    // Prior metadata PRESERVED (the re-connect omitted them).
    expect(rows[0]?.selected_pixel_id).toBe("px_1");
    expect(rows[0]?.is_system_user).toBe(true); // NOT flipped to false by the omitting re-connect
    expect(new Date(rows[0]?.last_dispatch_at ?? "").toISOString()).toBe("2026-06-22T09:00:00.000Z");
    expect(rows[0]?.last_dispatch_status).toBe("succeeded");
    expect(rows[0]?.last_error).toBe("prior transient error");
  });

  it("P0-B2: a re-connect MAY still overwrite metadata when it SUPPLIES new non-null values", async () => {
    const base = {
      workspaceId: "ws_cs_overwrite",
      provider: "meta_ads" as const,
      connectionName: "Meta Overwrite",
      accountExternalId: "act_overwrite",
      credentialKind: "access_token"
    };
    await db.connectSource({ ...base, encryptedPayload: "enc-a", selectedPixelId: "px_old", isSystemUser: false });
    // Supplying a new pixel + flipping is_system_user true must take effect (COALESCE picks the
    // non-null new value).
    await db.connectSource({ ...base, encryptedPayload: "enc-b", selectedPixelId: "px_new", isSystemUser: true });

    const rows = await db.query<{ selected_pixel_id: string | null; is_system_user: boolean }>(
      `select cc.selected_pixel_id, cc.is_system_user
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_overwrite'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected_pixel_id).toBe("px_new");
    expect(rows[0]?.is_system_user).toBe(true);
  });

  it("a re-connect AFTER revoking the prior credential inserts a fresh live row (partial-unique does not block)", async () => {
    const base = {
      workspaceId: "ws_cs_revoke",
      provider: "meta_ads" as const,
      connectionName: "Meta Revoke",
      accountExternalId: "act_revoke",
      credentialKind: "access_token"
    };

    await db.connectSource({ ...base, encryptedPayload: "enc-original", selectedPixelId: "px_orig" });

    // Operator revokes the live credential (the partial-unique excludes revoked rows).
    await db.query(
      `update connection_credentials cc
          set revoked_at = now()
         from sources s
        where cc.source_id = s.id
          and s.workspace_id = 'ws_cs_revoke'
          and cc.credential_kind = 'access_token'`
    );

    // Re-connect — a fresh live row is inserted (the conflict target only sees the live partial index).
    await db.connectSource({ ...base, encryptedPayload: "enc-reconnected", selectedPixelId: "px_new" });

    const live = await db.query<{ encrypted_payload: string; selected_pixel_id: string | null }>(
      `select cc.encrypted_payload, cc.selected_pixel_id
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_revoke'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.encrypted_payload).toBe("enc-reconnected");
    expect(live[0]?.selected_pixel_id).toBe("px_new");

    // Two rows total: one revoked (history) + one fresh live.
    const total = await db.query<{ revoked: boolean }[]>(
      `select (cc.revoked_at is not null) as revoked
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_revoke' and cc.credential_kind = 'access_token'
        order by cc.created_at`
    );
    expect(total).toHaveLength(2);
  });
});

describe("pglite boot-failure handling", () => {
  it("close() after a FAILED boot resolves — it swallows the boot error", async () => {
    // Point the data dir at a path under a regular FILE so PGlite.create can't mkdir it and the
    // lazy boot rejects on first use. close() must then NOT re-throw that boot error out of
    // teardown (awaiting the rejected boot promise would, without the try/catch).
    const base = mkdtempSync(join(tmpdir(), "infinite-os-pglite-badboot-"));
    const filePath = join(base, "afile");
    writeFileSync(filePath, "x");
    const badDb = createInfiniteOsDb(`pglite://${join(filePath, "nested")}`);
    try {
      await expect(badDb.query("select 1")).rejects.toThrow(); // boot fails on first use
      await expect(badDb.close()).resolves.toBeUndefined(); // close swallows it, no throw
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("close() on a never-used facade is a no-op (never boots PGlite)", async () => {
    const neverUsed = createInfiniteOsDb(`pglite://${join(tmpdir(), "infinite-os-pglite-unused")}`);
    await expect(neverUsed.close()).resolves.toBeUndefined();
  });

  it("double-close of a booted facade is idempotent (the `closed` flag no-ops the second)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-dblclose-"));
    try {
      const dbx = createInfiniteOsDb(`pglite://${dir}`);
      await dbx.query("select 1"); // force a real boot
      await expect(dbx.close()).resolves.toBeUndefined();
      // Raw PGlite.close() THROWS ("PGlite is closed") on a second call; the facade's `closed`
      // flag must make the second close a no-op rather than re-invoking it.
      await expect(dbx.close()).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a FAILING migration rolls back atomically — no ledger row, no partial schema (native tx)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-rollback-"));
    const url = `pglite://${dir}`;
    try {
      const ok = { id: "9001_ok.sql", sql: "create table mig_ok (id int);" };
      // The good DDL and the invalid statement share ONE migration body — the whole body must roll
      // back, so neither mig_bad nor a ledger row for 9002 may survive.
      const bad = { id: "9002_bad.sql", sql: "create table mig_bad (id int); this is not valid sql;" };
      await expect(runPgliteMigrations(url, [ok, bad])).rejects.toThrow();

      const after = createInfiniteOsDb(url);
      try {
        const ledger = await after.query<{ id: string }>(
          "select id from schema_migrations order by id"
        );
        expect(ledger.map((r) => r.id)).toEqual(["9001_ok.sql"]); // 9001 committed; 9002 NOT recorded
        const tables = await after.query<{ table_name: string }>(
          "select table_name from information_schema.tables where table_name in ('mig_ok','mig_bad')"
        );
        // mig_ok persisted (9001 committed in its own tx); mig_bad rolled back with the bad statement.
        expect(tables.map((r) => r.table_name).sort()).toEqual(["mig_ok"]);
      } finally {
        await after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("confirm-path workspace scoping against the REAL PGlite DB (P0-A money-safety)", () => {
  // The mock session-store tests only assert SQL TEXT (`workspace_id = $2`). This proves the
  // scoping BEHAVIOR against a REAL WASM-Postgres store. We issue the session-store's EXACT
  // scoped SQL — the `recordActionCall` INSERT, the `getPendingActionCall` `where workspace_id
  // = $2` SELECT, and the `confirmActionCall` `where workspace_id = $4` UPDATE — kept byte-
  // faithful to packages/llm-controller/src/session-store.ts. (We re-issue the SQL here rather
  // than importing `createSessionStore`, which lives in a sibling package that is not a build
  // dependency of @infinite-os/db; coupling the two via a project reference would break db's
  // `tsc -b`. The store's value is exactly this SQL, and it is exercised verbatim.)
  //
  // confirmation_id is NOT unique across workspaces (`confirm_${sha256({actionId,input}).slice(
  // 0,16)}` carries no workspace), so two brands on one install collide on the same id. A pending
  // confirmation recorded under ws_a must be invisible to ws_b's lookup, and a ws_b confirm must
  // update ZERO rows (the row stays pending) — while ws_a's lookup/confirm sees and mutates it.

  // Byte-faithful copies of the three session-store statements (P0-A).
  const RECORD_ACTION_CALL_SQL = `
    insert into chat_action_calls (
      id, session_id, message_id, provider_tool_call_id, action_id, authority,
      input_json, output_envelope_json, status, requires_confirmation, confirmation_id,
      input_hash, workspace_id
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
  `;
  const GET_PENDING_SQL = `
    select
      id,
      session_id as "sessionId",
      action_id as "actionId",
      input_json as "input",
      input_hash as "inputHash",
      workspace_id as "workspaceId"
    from chat_action_calls
    where confirmation_id = $1
      and workspace_id = $2
      and requires_confirmation = true
      and confirmed_at is null
    limit 1
  `;
  const CONFIRM_SQL = `
    update chat_action_calls
    set confirmed_at = now(),
      output_envelope_json = $2::jsonb,
      status = $3,
      requires_confirmation = false
    where confirmation_id = $1
      and workspace_id = $4
      and requires_confirmation = true
      and confirmed_at is null
  `;

  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  const getPending = (confirmationId: string, workspaceId: string) =>
    db.one<{ id: string; workspaceId: string; actionId: string }>(GET_PENDING_SQL, [
      confirmationId,
      workspaceId
    ]);
  const confirm = (confirmationId: string, workspaceId: string) =>
    db.query(CONFIRM_SQL, [confirmationId, JSON.stringify({ ok: true }), "ok", workspaceId]);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-confirmscope-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);

    // Seed two workspaces + a chat_session per workspace (the FK chain
    // chat_action_calls.session_id → chat_sessions.id and .workspace_id → workspaces.id).
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_a", "Workspace A");
      await tx.ensureWorkspace("ws_b", "Workspace B");
    });
    await db.query(
      `insert into chat_sessions (id, workspace_id, session_key, actor_id, surface)
       values ('sess_a', 'ws_a', 'sess_a', 'cli', 'cli'),
              ('sess_b', 'ws_b', 'sess_b', 'cli', 'cli')`
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a pending confirmation recorded under ws_a is SELECT-invisible to ws_b and visible to ws_a", async () => {
    // recordActionCall under ws_a — confirmation_id 'confirm_collide' bound to ws_a.
    await db.query(RECORD_ACTION_CALL_SQL, [
      "call_a",
      "sess_a",
      null,
      null,
      "create_meta_campaign",
      "operator",
      JSON.stringify({ sourceId: "src_1" }),
      JSON.stringify({}),
      "requires_confirmation",
      true,
      "confirm_collide",
      "hash_a",
      "ws_a"
    ]);

    // ws_b cannot see ws_a's pending row (the `where workspace_id = $2` SELECT scoping).
    expect(await getPending("confirm_collide", "ws_b")).toBeNull();

    // ws_a sees its own row, bound to ws_a.
    const fromA = await getPending("confirm_collide", "ws_a");
    expect(fromA).not.toBeNull();
    expect(fromA?.workspaceId).toBe("ws_a");
    expect(fromA?.actionId).toBe("create_meta_campaign");
  });

  it("a ws_b confirm updates ZERO rows (the ws_a row stays pending); a ws_a confirm marks it confirmed", async () => {
    // ws_b tries to confirm ws_a's pending confirmation_id — the `where workspace_id = $4`
    // UPDATE scoping means it touches NO rows; the ws_a row must remain pending.
    await confirm("confirm_collide", "ws_b");
    const stillPending = await db.query<{
      requires_confirmation: boolean;
      confirmed_at: string | null;
      status: string;
    }>(
      `select requires_confirmation, confirmed_at, status
         from chat_action_calls
        where confirmation_id = 'confirm_collide' and workspace_id = 'ws_a'`
    );
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.requires_confirmation).toBe(true);
    expect(stillPending[0]?.confirmed_at).toBeNull();
    expect(stillPending[0]?.status).toBe("requires_confirmation");

    // And ws_a still sees it as pending.
    expect(await getPending("confirm_collide", "ws_a")).not.toBeNull();

    // The correct workspace (ws_a) confirms — exactly its row is marked confirmed.
    await confirm("confirm_collide", "ws_a");
    const afterA = await db.query<{
      requires_confirmation: boolean;
      confirmed_at: string | null;
      status: string;
    }>(
      `select requires_confirmation, confirmed_at, status
         from chat_action_calls
        where confirmation_id = 'confirm_collide' and workspace_id = 'ws_a'`
    );
    expect(afterA).toHaveLength(1);
    expect(afterA[0]?.requires_confirmation).toBe(false);
    expect(afterA[0]?.confirmed_at).not.toBeNull();
    expect(afterA[0]?.status).toBe("ok");

    // Now that it is confirmed, ws_a's pending lookup returns null (confirmed_at is set).
    expect(await getPending("confirm_collide", "ws_a")).toBeNull();
  });
});

describe("0038 backfills chat_action_calls.workspace_id from chat_sessions (partial-migration proof)", () => {
  // FIX #4 — exercise migration 0038's BACKFILL directly. The harness DOES support a partial
  // migration set (runPgliteMigrations takes an explicit list), so we apply 0001..0037, insert a
  // chat_action_call with NO workspace_id (the column doesn't exist pre-0038), then apply 0038
  // alone and assert: (a) the row's workspace_id was backfilled from its chat_session, and
  // (b) the NOT NULL now holds (a fresh insert omitting workspace_id is rejected).
  let dataDir: string;
  let url: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-0038-backfill-"));
    url = `pglite://${dataDir}`;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("backfills legacy NULL workspace_id from the owning session, then sets NOT NULL", async () => {
    const all = loadMigrations();
    const upTo0037 = all.filter((m) => m.id <= "0037_meta_ads_ad_grain.sql");
    const m0038 = all.find((m) => m.id === "0038_chat_action_calls_workspace_id.sql");
    expect(m0038).toBeDefined();
    // Sanity: 0038 is NOT in the partial set (so the column is genuinely absent pre-backfill).
    expect(upTo0037.some((m) => m.id === "0038_chat_action_calls_workspace_id.sql")).toBe(false);

    // 1. Apply 0001..0037 only.
    await runPgliteMigrations(url, upTo0037);

    const db = createInfiniteOsDb(url);
    try {
      // Pre-0038 the column must NOT exist yet.
      const preCols = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'chat_action_calls' and column_name = 'workspace_id'`
      );
      expect(preCols).toHaveLength(0);

      // 2. Seed a workspace + session, then a LEGACY chat_action_call with NO workspace_id column.
      await db.withTransaction(async (tx) => {
        await tx.ensureWorkspace("ws_legacy", "Legacy WS");
      });
      await db.query(
        `insert into chat_sessions (id, workspace_id, session_key, actor_id, surface)
         values ('sess_legacy', 'ws_legacy', 'sess_legacy', 'cli', 'cli')`
      );
      await db.query(
        `insert into chat_action_calls (id, session_id, action_id, authority, status)
         values ('call_legacy', 'sess_legacy', 'create_meta_campaign', 'operator', 'requires_confirmation')`
      );
    } finally {
      await db.close();
    }

    // 3. Apply 0038 alone (the add-column + backfill + set-not-null + index).
    const applied0038 = await runPgliteMigrations(url, [m0038!]);
    expect(applied0038).toEqual(["0038_chat_action_calls_workspace_id.sql"]);

    const db2 = createInfiniteOsDb(url);
    try {
      // (a) BACKFILL: the legacy row's workspace_id was filled from its chat_session.
      const backfilled = await db2.query<{ workspace_id: string }>(
        "select workspace_id from chat_action_calls where id = 'call_legacy'"
      );
      expect(backfilled).toHaveLength(1);
      expect(backfilled[0]?.workspace_id).toBe("ws_legacy");

      // The column is now NOT NULL.
      const cols = await db2.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
          where table_name = 'chat_action_calls' and column_name = 'workspace_id'`
      );
      expect(cols).toHaveLength(1);
      expect(cols[0]?.is_nullable).toBe("NO");

      // (b) SET-NOT-NULL HELD: a fresh insert that OMITS workspace_id is rejected.
      await expect(
        db2.query(
          `insert into chat_action_calls (id, session_id, action_id, authority, status)
           values ('call_after', 'sess_legacy', 'create_meta_campaign', 'operator', 'requires_confirmation')`
        )
      ).rejects.toThrow();
    } finally {
      await db2.close();
    }
  }, 60_000);
});

describe("0039 dedupes legacy duplicate live credentials BEFORE the partial-unique index (boot-safety proof)", () => {
  // Pre-P0-B, connectSource was a plain INSERT (new random id, no `on conflict`) that never set
  // revoked_at, so any install that re-connected a source accumulated MULTIPLE live rows with the
  // same (source_id, credential_kind). Without a dedupe step, 0039's `create unique index … where
  // revoked_at is null` aborts with 23505 and (since the daemon auto-migrates on boot) bricks the
  // daemon on every boot. This applies 0001..0038, seeds duplicate live rows, then applies 0039
  // alone and asserts: (a) 0039 SUCCEEDS, (b) exactly the NEWEST live row per (source,kind)
  // survives, (c) already-revoked history is untouched, (d) the index now blocks a new live dup.
  let dataDir: string;
  let url: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-0039-dedupe-"));
    url = `pglite://${dataDir}`;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("collapses duplicate live rows to the newest, preserves revoked history, then enforces uniqueness", async () => {
    const all = loadMigrations();
    const upTo0038 = all.filter((m) => m.id <= "0038_chat_action_calls_workspace_id.sql");
    const m0039 = all.find((m) => m.id === "0039_connection_credentials_metadata.sql");
    expect(m0039).toBeDefined();
    // Sanity: 0039 (and therefore the partial-unique index) is NOT in the partial set yet.
    expect(upTo0038.some((m) => m.id === "0039_connection_credentials_metadata.sql")).toBe(false);

    // 1. Apply 0001..0038 only (connection_credentials exists; the unique index does NOT).
    await runPgliteMigrations(url, upTo0038);

    const db = createInfiniteOsDb(url);
    try {
      await db.withTransaction(async (tx) => {
        await tx.ensureWorkspace("ws1", "WS");
      });
      await db.query(
        "insert into datasets (id, workspace_id, key, label) values ('ds1','ws1','k','L')"
      );
      await db.query(
        `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
         values ('src1','ws1','ds1','posthog','conn','acct','connected')`
      );
      // Three LIVE rows for (src1, access_token) with distinct created_at — exactly what main's
      // plain-INSERT connectSource produced across three reconnects. cred_new is the NEWEST.
      await db.query(
        `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload, created_at) values
           ('cred_old','ws1','src1','access_token','enc1','2026-01-01T00:00:00Z'),
           ('cred_mid','ws1','src1','access_token','enc2','2026-01-15T00:00:00Z'),
           ('cred_new','ws1','src1','access_token','enc3','2026-02-01T00:00:00Z')`
      );
      // An already-REVOKED row for the same (source,kind): must remain untouched (history preserved).
      await db.query(
        `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload, created_at, revoked_at)
         values ('cred_rev','ws1','src1','access_token','enc0','2025-12-01T00:00:00Z','2025-12-02T00:00:00Z')`
      );
      // A DIFFERENT kind on the same source with a single live row: must survive independently.
      await db.query(
        `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload, created_at)
         values ('cred_rt','ws1','src1','refresh_token','encR','2026-01-10T00:00:00Z')`
      );
    } finally {
      await db.close();
    }

    // 2. Apply 0039 alone — must NOT throw despite the 3 duplicate live access_token rows.
    const applied0039 = await runPgliteMigrations(url, [m0039!]);
    expect(applied0039).toEqual(["0039_connection_credentials_metadata.sql"]);

    const db2 = createInfiniteOsDb(url);
    try {
      // (a) Exactly ONE live access_token row survives, and it is the NEWEST (cred_new).
      const liveAccess = await db2.query<{ id: string }>(
        `select id from connection_credentials
          where source_id = 'src1' and credential_kind = 'access_token' and revoked_at is null`
      );
      expect(liveAccess).toHaveLength(1);
      expect(liveAccess[0]?.id).toBe("cred_new");

      // The older live dups were revoked (not deleted) — history retained.
      const revokedNow = await db2.query<{ id: string }>(
        `select id from connection_credentials
          where id in ('cred_old','cred_mid') and revoked_at is not null order by id`
      );
      expect(revokedNow.map((r) => r.id)).toEqual(["cred_mid", "cred_old"]);

      // (b) The originally-revoked row is untouched: same revoked_at timestamp, still revoked.
      const preRevoked = await db2.query<{ revoked_at: string }>(
        "select revoked_at from connection_credentials where id = 'cred_rev'"
      );
      expect(preRevoked).toHaveLength(1);
      expect(new Date(preRevoked[0]!.revoked_at).toISOString()).toBe("2025-12-02T00:00:00.000Z");

      // (c) The other credential_kind (single live row) is independent and survives.
      const liveRt = await db2.query<{ id: string }>(
        `select id from connection_credentials
          where source_id = 'src1' and credential_kind = 'refresh_token' and revoked_at is null`
      );
      expect(liveRt.map((r) => r.id)).toEqual(["cred_rt"]);

      // (d) The partial-unique index now EXISTS and blocks a second live row for the same kind.
      const idx = await db2.query<{ indexname: string }>(
        "select indexname from pg_indexes where indexname = 'connection_credentials_source_kind_uq'"
      );
      expect(idx).toHaveLength(1);
      await expect(
        db2.query(
          `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
           values ('cred_dup','ws1','src1','access_token','encX')`
        )
      ).rejects.toThrow();
    } finally {
      await db2.close();
    }
  }, 60_000);
});

describe("0041 fails the forever-queued connector jobs, sparing live queues (partial-migration proof)", () => {
  // Early installs enqueued source_sync/source_backfill job_runs at connect time, but the desktop
  // daemon never shipped a worker, so those rows sit 'queued' forever. 0041 marks the STALE ones
  // (7+ days old) failed — and must NOT touch young queued rows (a self-hosted deployment may run
  // apps/worker with a live queue), non-connector job types, or already-terminal rows. This
  // applies 0001..0040, seeds all four shapes, then applies 0041 alone and asserts each outcome.
  let dataDir: string;
  let url: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-0041-jobs-"));
    url = `pglite://${dataDir}`;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("fails stale queued connector jobs; leaves young, non-connector, and terminal rows alone", async () => {
    const all = loadMigrations();
    const upTo0040 = all.filter((m) => m.id <= "0040_workspace_owner_id.sql");
    const m0041 = all.find((m) => m.id === "0041_fail_forever_queued_connector_jobs.sql");
    expect(m0041).toBeDefined();
    expect(upTo0040.some((m) => m.id === m0041!.id)).toBe(false);

    // 1. Apply 0001..0040 only, then seed the four job shapes.
    await runPgliteMigrations(url, upTo0040);
    const db = createInfiniteOsDb(url);
    try {
      await db.withTransaction(async (tx) => {
        await tx.ensureWorkspace("ws1", "WS");
      });
      await db.query(
        `insert into job_runs (id, workspace_id, job_type, payload, status, created_at) values
           ('j_stale_sync',    'ws1', 'source_sync',               '{}'::jsonb, 'queued', now() - interval '30 days'),
           ('j_stale_backfill','ws1', 'source_backfill',           '{}'::jsonb, 'queued', now() - interval '30 days'),
           ('j_young_sync',    'ws1', 'source_sync',               '{}'::jsonb, 'queued', now() - interval '1 day'),
           ('j_stale_mview',   'ws1', 'materialized_view_refresh', '{}'::jsonb, 'queued', now() - interval '30 days'),
           ('j_done_sync',     'ws1', 'source_sync',               '{}'::jsonb, 'succeeded', now() - interval '30 days')`
      );
    } finally {
      await db.close();
    }

    // 2. Apply 0041 alone.
    const applied = await runPgliteMigrations(url, [m0041!]);
    expect(applied).toEqual(["0041_fail_forever_queued_connector_jobs.sql"]);

    const db2 = createInfiniteOsDb(url);
    try {
      const rows = await db2.query<{ id: string; status: string; error: string | null; finished_at: string | null }>(
        "select id, status, error, finished_at from job_runs order by id"
      );
      const byId = new Map(rows.map((r) => [r.id, r]));

      // (a) Stale queued connector jobs → failed, with an auditable error and finished_at.
      for (const id of ["j_stale_sync", "j_stale_backfill"]) {
        expect(byId.get(id)?.status).toBe("failed");
        expect(byId.get(id)?.error).toContain("migration 0041");
        expect(byId.get(id)?.finished_at).not.toBeNull();
      }
      // (b) A YOUNG queued connector job survives (live self-hosted queues are spared).
      expect(byId.get("j_young_sync")?.status).toBe("queued");
      // (c) Non-connector job types are untouched even when stale.
      expect(byId.get("j_stale_mview")?.status).toBe("queued");
      // (d) Terminal rows keep their status and gain no error text.
      expect(byId.get("j_done_sync")?.status).toBe("succeeded");
      expect(byId.get("j_done_sync")?.error).toBeNull();
    } finally {
      await db2.close();
    }
  }, 60_000);
});

describe("0046 indexes the analytics fact tables (partial-migration + planner proof)", () => {
  // The GA4/PostHog truth tables carried only their PK and their `source_id`-leading upsert
  // key, so a workspace-scoped dashboard read had to scan every tenant's rows. This applies
  // 0001..0045, seeds a realistic multi-tenant shape (40 workspaces × 300 daily rows each),
  // captures the plan, then applies 0046 ALONE and asserts the plan flips to the new
  // workspace-leading indexes — proving both the upgrade path on an already-migrated DB and
  // that the indexes are the ones the engine's canonical read shape actually needs.
  let dataDir: string;
  let url: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-0046-idx-"));
    url = `pglite://${dataDir}`;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const GA4_READ = `select sum(sessions) from ga4_report_snapshot_fact
      where workspace_id = 'ws_idx_3'
        and reporting_date >= date '2026-02-01'
        and reporting_date <= date '2026-02-28'`;
  const POSTHOG_READ = `select count(*) from posthog_event_truth
      where workspace_id = 'ws_idx_3'
        and occurred_at >= timestamptz '2026-01-05 00:00:00+00'
        and occurred_at <= timestamptz '2026-01-09 00:00:00+00'`;

  async function planOf(db: InfiniteOsDb, sql: string): Promise<string> {
    const rows = await db.query<Record<string, unknown>>(`explain ${sql}`);
    return rows
      .map((row) => Object.values(row)[0] as string)
      .join("\n")
      .toLowerCase();
  }

  it("applies on a DB already at 0045 and flips both reads onto the new indexes", async () => {
    const all = loadMigrations();
    const upTo0045 = all.filter((m) => m.id < "0046");
    const m0046 = all.find((m) => m.id === "0046_analytics_fact_table_indexes.sql");
    expect(m0046).toBeDefined();
    expect(upTo0045.some((m) => m.id === m0046!.id)).toBe(false);

    // 1. Apply 0001..0045 only, then seed 40 tenants' worth of GA4 + PostHog truth.
    await runPgliteMigrations(url, upTo0045);
    const db = createInfiniteOsDb(url);
    try {
      await db.withTransaction(async (tx) => {
        for (let i = 0; i < 40; i += 1) {
          await tx.ensureWorkspace(`ws_idx_${i}`, `Index Bench ${i}`);
          await tx.ensureFirstPhaseDatasets(`ws_idx_${i}`);
        }
      });
      for (let i = 0; i < 40; i += 1) {
        const ds = await db.query<{ id: string }>(
          "select id from datasets where workspace_id = $1 and key = 'web'",
          [`ws_idx_${i}`]
        );
        await db.query(
          `insert into sources (
             id, workspace_id, dataset_id, provider, connection_name, account_external_id, status
           ) values ($1, $2, $3, 'google_analytics_4', 'conn', 'acct', 'connected')`,
          [`src_idx_${i}`, `ws_idx_${i}`, ds[0]?.id]
        );
        await db.query(
          `insert into ga4_report_snapshot_fact (id, workspace_id, source_id, reporting_date, sessions)
           select $1 || '_' || g, $2, $3, date '2026-01-01' + (g % 300), g
             from generate_series(1, 300) as g`,
          [`fact_idx_${i}`, `ws_idx_${i}`, `src_idx_${i}`]
        );
        await db.query(
          `insert into posthog_event_truth (id, workspace_id, source_id, event_id, event_name, occurred_at)
           select $1 || '_' || g, $2, $3, 'evt_' || g,
                  case when g % 3 = 0 then '$pageview' else 'signup' end,
                  timestamptz '2026-01-01 00:00:00+00' + (g || ' hours')::interval
             from generate_series(1, 300) as g`,
          [`ph_idx_${i}`, `ws_idx_${i}`, `src_idx_${i}`]
        );
      }
      await db.query("analyze");

      // BEFORE: neither read can use a workspace-leading index. GA4 gets pushed onto the
      // `source_id`-leading upsert unique by date alone (a skip scan that then discards
      // every other tenant's rows) — assert that exact shape, not merely the absence of the
      // new index name, so a regression to a different-but-still-bad plan is caught.
      const ga4Before = await planOf(db, GA4_READ);
      const phBefore = await planOf(db, POSTHOG_READ);
      expect(ga4Before).toContain("ga4_report_snapshot_unique");
      expect(ga4Before).not.toContain("ga4_report_snapshot_workspace_date_idx");
      expect(phBefore).toContain("seq scan");
    } finally {
      await db.close();
    }

    // 2. Apply 0046 alone on the already-migrated DB.
    expect(await runPgliteMigrations(url, [m0046!])).toEqual([
      "0046_analytics_fact_table_indexes.sql"
    ]);
    // The runner short-circuits on the ledger row — that proves the LEDGER, not the SQL.
    expect(await runPgliteMigrations(url, [m0046!])).toEqual([]);
    // So actually re-execute the body against the schema it already created: same SQL under a
    // synthetic ledger id, which bypasses the short-circuit. `if not exists` must make this a
    // no-op rather than a duplicate-index error.
    expect(
      await runPgliteMigrations(url, [{ ...m0046!, id: `${m0046!.id}__replay` }])
    ).toEqual([`${m0046!.id}__replay`]);

    // 3. AFTER: the canonical `workspace_id = $1 and <time> between $2 and $3` reads —
    //    the shape the analytical engine emits against vw_site_traffic / vw_posthog_events —
    //    now ride the new indexes.
    const db2 = createInfiniteOsDb(url);
    try {
      await db2.query("analyze");
      const ga4After = await planOf(db2, GA4_READ);
      expect(ga4After).toContain("ga4_report_snapshot_workspace_date_idx");
      expect(ga4After).toContain("workspace_id = 'ws_idx_3'");
      expect(ga4After).not.toContain("seq scan");

      const phAfter = await planOf(db2, POSTHOG_READ);
      expect(phAfter).toContain("posthog_event_truth_workspace_time_event_idx");
      expect(phAfter).not.toContain("seq scan");
    } finally {
      await db2.close();
    }
  }, 120_000);
});
