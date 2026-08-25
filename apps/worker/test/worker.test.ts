import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InfiniteOsDb } from "@infinite-os/db";
import { type NotificationEvent } from "@infinite-os/runtime";
import {
  aggregateExpression,
  caveatsForMetric,
  metricColumn,
  metricView
} from "@infinite-os/analytical-engine";

import { createWorkerLoop } from "../src/index.js";

const connectorSyncRequests = vi.hoisted((): Array<Record<string, unknown>> => []);
const workerEventMarkers = vi.hoisted((): string[] => []);
vi.mock("@infinite-os/connectors", () => ({
  connectorFor: (provider: string) => ({
    provider,
    sync: async (_db: unknown, request: Record<string, unknown>) => {
      workerEventMarkers.push("connector.sync");
      connectorSyncRequests.push(request);
      return {
        provider,
        recordsExtracted: 0,
        recordsLoaded: 0,
        cursorKey: "test_cursor",
        cursorValue: "2026-06-05T00:00:00.000Z"
      };
    }
  })
}));

describe("Infinite OS worker loop", () => {
  beforeEach(() => {
    connectorSyncRequests.length = 0;
    workerEventMarkers.length = 0;
  });

  it("boots without a database and exposes runtime metadata", async () => {
    const result = await createWorkerLoop().tick();
    expect(result.status).toBe("idle");
    expect(result.migrationCount).toBeGreaterThanOrEqual(6);
    expect(result.actionCount).toBeGreaterThan(0);
  });

  it("writes durable saved-report export artifacts and metadata rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const completed: Array<{ jobId: string; status: string }> = [];
    const notifications: NotificationEvent[] = [];
    const job = {
      id: "job_export_1",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_1", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_revenue_by_source")) {
          return [{ recognized_revenue: "4900" }] as T[];
        }
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_1",
            name: "Revenue report",
            tool_plan: { metric: "recognized_revenue" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob(jobId, status) {
        completed.push({ jobId, status });
      },
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({
        db,
        workspaceRoot: root,
        notificationSink: {
          emit: (event) => {
            notifications.push(event);
          }
        }
      }).tick();
      const artifactPath = join(root, ".growth-os", "exports", "workspace", "job_export_1.json");
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

      expect(result).toMatchObject({ status: "processed", jobId: "job_export_1", jobType: "saved_report_export" });
      expect(existsSync(artifactPath)).toBe(true);
      expect(artifact).toMatchObject({
        workspaceId: "workspace",
        report: { id: "report_1", name: "Revenue report" },
        security: {
          credentialsIncluded: false,
          rawPayloadJsonIncluded: false,
          genericSqlAllowed: false
        }
      });
      expect(queries.some((query) => query.sql.includes("insert into saved_report_exports"))).toBe(true);
      expect(completed).toEqual([{ jobId: "job_export_1", status: "succeeded" }]);
      expect(notifications).toEqual([
        expect.objectContaining({
          type: "export_ready",
          workspaceId: "workspace",
          jobId: "job_export_1",
          reportId: "report_1",
          artifactPath,
          status: "info"
        })
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Saved reports run THROUGH the job loop (runSavedReport is not exported). Post-DEDUP the
  // worker no longer keeps its own metricView/aggregateExpression copies — it imports them
  // from @infinite-os/analytical-engine. These tests assert the worker correctly WIRES those
  // exported engine functions into the saved-report SQL it emits for GA4 traffic metrics
  // (verifying both view routing and the session-weighted rate expression). Note: saved
  // reports have NO filter/groupBy/source_id support (runSavedReport is bare
  // `where workspace_id = $1`), so they are inherently cross-site.
  it("routes GA4 page_views saved reports to vw_site_traffic with sum(page_views)", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const job = {
      id: "job_export_pv",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_pv", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_site_traffic")) {
          return [{ page_views: "240" }] as T[];
        }
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_pv",
            name: "Page views report",
            tool_plan: { metric: "page_views" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({ db, workspaceRoot: root }).tick();
      expect(result).toMatchObject({ status: "processed", jobId: "job_export_pv" });
      const reportQuery = queries.find((query) => query.sql.includes("from queryable.vw_site_traffic"));
      expect(reportQuery?.sql).toBeDefined();
      expect(reportQuery?.sql).toContain("sum(page_views) as page_views");
      expect(reportQuery?.params).toEqual(["workspace"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the engine's session-weighted expression for engagement_rate saved reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const job = {
      id: "job_export_er",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_er", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_site_traffic")) {
          return [{ engagement_rate: "0.7" }] as T[];
        }
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_er",
            name: "Engagement rate report",
            tool_plan: { metric: "engagement_rate" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({ db, workspaceRoot: root }).tick();
      expect(result).toMatchObject({ status: "processed", jobId: "job_export_er" });
      const reportQuery = queries.find((query) => query.sql.includes("from queryable.vw_site_traffic"));
      expect(reportQuery?.sql).toBeDefined();
      expect(reportQuery?.sql).toContain("sum(engagement_rate * sessions) / sum(sessions)");
      expect(reportQuery?.sql).not.toContain("sum(engagement_rate) as");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects page_views_by_page saved reports (breakdown-only, excluded from worker routing)", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const job = {
      id: "job_export_pbp",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_pbp", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_pbp",
            name: "Top pages report",
            tool_plan: { metric: "page_views_by_page" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({ db, workspaceRoot: root }).tick();
      // The guard rejects before any aggregate SQL runs (no vw_site_pages query).
      expect(result).toMatchObject({
        status: "failed",
        jobId: "job_export_pbp",
        error: expect.stringContaining("saved_report_metric_unsupported:page_views_by_page")
      });
      expect(queries.some((query) => query.sql.includes("from queryable.vw_site_pages"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // DEDUP single-source-of-truth: the worker no longer keeps its own copies of
  // metricView/metricColumn/aggregateExpression/caveatsForMetric — it imports them from
  // @infinite-os/analytical-engine. This test drives a saved report through the loop and
  // asserts the emitted SQL + caveats are exactly what the engine's exported functions
  // produce, so worker and engine are provably the same source of truth.
  it("builds saved-report SQL from the engine's exported metric-routing functions", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const job = {
      id: "job_export_src",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_src", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_site_traffic")) {
          return [{ new_users: "55" }] as T[];
        }
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_src",
            name: "New users report",
            tool_plan: { metric: "new_users" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({ db, workspaceRoot: root }).tick();
      expect(result).toMatchObject({ status: "processed", jobId: "job_export_src" });

      const metric = "new_users";
      const expectedView = metricView(metric);
      const expectedColumn = metricColumn(metric);
      const expectedAggregate = aggregateExpression(metric, expectedColumn);

      const reportQuery = queries.find((query) => query.sql.includes(`from ${expectedView}`));
      expect(reportQuery?.sql).toBeDefined();
      expect(reportQuery?.sql).toContain(`select ${expectedAggregate} as ${metric}`);
      expect(reportQuery?.sql).toContain(`from ${expectedView}`);

      // The persisted artifact's caveats come from the engine's caveatsForMetric.
      const artifactPath = join(root, ".growth-os", "exports", "workspace", "job_export_src.json");
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      expect(artifact.result.caveats).toEqual(caveatsForMetric(metric));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // DEDUP behavior lock-in: this is the ONE path whose output actually changed. The old
  // worker copies routed every non-(GA4-traffic|recognized_revenue) metric to
  // vw_site_conversion_rate with the generic caveat set (broken SQL for these metrics).
  // The imported engine routes posthog_event_count -> vw_posthog_events with its own caveat.
  // This test drives a non-GA4 saved report end-to-end and asserts the NEW (correct) routing.
  it("routes a non-GA4 saved report (posthog_event_count) to vw_posthog_events via the engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const job = {
      id: "job_export_ph",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_ph", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_posthog_events")) {
          return [{ posthog_event_count: "1200" }] as T[];
        }
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_ph",
            name: "PostHog events report",
            tool_plan: { metric: "posthog_event_count" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({ db, workspaceRoot: root }).tick();
      expect(result).toMatchObject({ status: "processed", jobId: "job_export_ph" });

      const metric = "posthog_event_count";
      const expectedView = metricView(metric);
      const expectedColumn = metricColumn(metric);
      const expectedAggregate = aggregateExpression(metric, expectedColumn);

      // New routing: the engine sends this to vw_posthog_events, NOT vw_site_conversion_rate.
      expect(expectedView).toBe("queryable.vw_posthog_events");
      const reportQuery = queries.find((query) => query.sql.includes(`from ${expectedView}`));
      expect(reportQuery?.sql).toBeDefined();
      expect(reportQuery?.sql).toContain(`select ${expectedAggregate} as ${metric}`);
      expect(reportQuery?.sql).toContain(`from ${expectedView}`);
      // The old subset would have emitted SQL against vw_site_conversion_rate — assert it does not.
      expect(queries.some((query) => query.sql.includes("from queryable.vw_site_conversion_rate"))).toBe(
        false
      );

      // The persisted artifact's caveats come from the engine's metric-specific caveatsForMetric,
      // not the generic conversion-rate fallback set.
      const artifactPath = join(root, ".growth-os", "exports", "workspace", "job_export_ph.json");
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      expect(artifact.result.caveats).toEqual(caveatsForMetric(metric));
      expect(artifact.result.caveats).toEqual(["source_native_event_counts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Phase-2 slice-1a §5d/§9 — the saved-report path is the worker's no-group-by entry point; it
  // calls metricView(metric) (the campaign-default shim), so a Meta saved report MUST stay
  // campaign-grain and can NEVER reach the new adset view. This pins the no-drift contract end-to-
  // end through the job loop (a regression that routed a Meta saved report to the adset view —
  // e.g. by swapping metricView for metricViewForGrain in runSavedReport — fails here).
  it("§9: a Meta saved report (meta_ads_spend) stays campaign-grain — never the adset view", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-worker-"));
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const job = {
      id: "job_export_meta",
      workspace_id: "workspace",
      job_type: "saved_report_export",
      payload: { reportId: "report_meta", format: "json" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
          return [{ meta_ads_spend: "1234.56" }] as T[];
        }
        return [] as T[];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from saved_reports")) {
          return {
            id: "report_meta",
            name: "Meta spend report",
            tool_plan: { metric: "meta_ads_spend" }
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const result = await createWorkerLoop({ db, workspaceRoot: root }).tick();
      expect(result).toMatchObject({ status: "processed", jobId: "job_export_meta" });

      const metric = "meta_ads_spend";
      // The worker's entry point is metricView (the campaign shim) — NOT metricViewForGrain.
      expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_daily");
      const reportQuery = queries.find((query) =>
        query.sql.includes("from queryable.vw_meta_ads_campaign_daily")
      );
      expect(reportQuery?.sql).toBeDefined();
      expect(reportQuery?.sql).toContain(
        `select ${aggregateExpression(metric, metricColumn(metric))} as ${metric}`
      );
      // The adset view is NEVER reachable from a saved report.
      expect(queries.every((query) => !query.sql.includes("from queryable.vw_meta_ads_adset_daily"))).toBe(true);
      expect(
        queries.every((query) => !query.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily"))
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits sync failure notifications when source jobs fail", async () => {
    const notifications: NotificationEvent[] = [];
    const job = {
      id: "job_sync_1",
      workspace_id: "workspace",
      job_type: "source_sync",
      payload: { sourceId: "src_missing" }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const result = await createWorkerLoop({
      db,
      notificationSink: {
        emit: (event) => {
          notifications.push(event);
        }
      }
    }).tick();

    expect(result).toMatchObject({ status: "failed", jobId: "job_sync_1" });
    expect(notifications).toEqual([
      expect.objectContaining({
        type: "sync_failed",
        workspaceId: "workspace",
        sourceId: "src_missing",
        jobId: "job_sync_1",
        status: "error"
      })
    ]);
  });

  it("passes source backfill payload through to connector sync requests", async () => {
    const notifications: NotificationEvent[] = [];
    const completed: Array<{ jobId: string; status: string }> = [];
    const job = {
      id: "job_backfill_1",
      workspace_id: "workspace",
      job_type: "source_backfill",
      payload: {
        sourceId: "src_meta_ads",
        mode: "backfill",
        backfillWindow: "all_time",
        refreshWindowDays: 365
      }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return {
            id: "src_meta_ads",
            workspace_id: "workspace",
            provider: "meta_ads"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob(jobId, status) {
        completed.push({ jobId, status });
      },
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const result = await createWorkerLoop({
      db,
      notificationSink: {
        emit: (event) => {
          if (event.type === "sync_progress") {
            workerEventMarkers.push(`progress:${event.details?.progressPercent}`);
          }
          if (event.type === "sync_completed") {
            workerEventMarkers.push("sync_completed");
          }
          notifications.push(event);
        }
      }
    }).tick();

    expect(result).toMatchObject({ status: "processed", jobId: "job_backfill_1", jobType: "source_backfill" });
    expect(connectorSyncRequests).toEqual([
      expect.objectContaining({
        workspaceId: "workspace",
        sourceId: "src_meta_ads",
        provider: "meta_ads",
        mode: "backfill",
        backfillWindow: "all_time",
        refreshWindowDays: 365
      })
    ]);
    expect(completed).toEqual([{ jobId: "job_backfill_1", status: "succeeded" }]);
    expect(workerEventMarkers).toEqual(["progress:0", "connector.sync", "progress:100", "sync_completed"]);
    expect(notifications).toEqual([
      expect.objectContaining({
        type: "sync_progress",
        workspaceId: "workspace",
        sourceId: "src_meta_ads",
        jobId: "job_backfill_1",
        summary: "Meta Ads backfill progress for src_meta_ads [--------------------] 0%",
        details: {
          provider: "meta_ads",
          jobType: "source_backfill",
          progressPercent: 0,
          progressBar: "[--------------------] 0%"
        }
      }),
      expect.objectContaining({
        type: "sync_progress",
        workspaceId: "workspace",
        sourceId: "src_meta_ads",
        jobId: "job_backfill_1",
        summary: "Meta Ads backfill progress for src_meta_ads [####################] 100%",
        details: {
          provider: "meta_ads",
          jobType: "source_backfill",
          progressPercent: 100,
          progressBar: "[####################] 100%"
        }
      }),
      expect.objectContaining({
        type: "sync_completed",
        workspaceId: "workspace",
        sourceId: "src_meta_ads",
        jobId: "job_backfill_1",
        details: { provider: "meta_ads", jobType: "source_backfill" }
      })
    ]);
  });

  it("keeps Meta Ads backfills running when progress notification delivery fails", async () => {
    const completed: Array<{ jobId: string; status: string }> = [];
    const job = {
      id: "job_backfill_progress_failure",
      workspace_id: "workspace",
      job_type: "source_backfill",
      payload: {
        sourceId: "src_meta_ads",
        backfillWindow: "30_days",
        refreshWindowDays: 30
      }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return {
            id: "src_meta_ads",
            workspace_id: "workspace",
            provider: "meta_ads"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob(jobId, status) {
        completed.push({ jobId, status });
      },
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const result = await createWorkerLoop({
      db,
      notificationSink: {
        emit: (event) => {
          if (event.type === "sync_progress" && event.details?.progressPercent === 0) {
            workerEventMarkers.push("progress:0:failed");
            throw new Error("progress webhook unavailable");
          }
          if (event.type === "sync_completed") {
            workerEventMarkers.push("sync_completed");
          }
        }
      }
    }).tick();

    expect(result).toMatchObject({
      status: "processed",
      jobId: "job_backfill_progress_failure",
      jobType: "source_backfill"
    });
    expect(connectorSyncRequests).toEqual([
      expect.objectContaining({
        sourceId: "src_meta_ads",
        provider: "meta_ads",
        backfillWindow: "30_days",
        refreshWindowDays: 30
      })
    ]);
    expect(completed).toEqual([{ jobId: "job_backfill_progress_failure", status: "succeeded" }]);
    expect(workerEventMarkers).toEqual(["progress:0:failed", "connector.sync", "sync_completed"]);
  });

  it("keeps Meta Ads backfills running when progress notification delivery never resolves", async () => {
    const completed: Array<{ jobId: string; status: string }> = [];
    const job = {
      id: "job_backfill_progress_hung",
      workspace_id: "workspace",
      job_type: "source_backfill",
      payload: {
        sourceId: "src_meta_ads",
        backfillWindow: "30_days",
        refreshWindowDays: 30
      }
    };
    let claimed = false;
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return {
            id: "src_meta_ads",
            workspace_id: "workspace",
            provider: "meta_ads"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async completeJob(jobId, status) {
        completed.push({ jobId, status });
      },
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const result = await createWorkerLoop({
      db,
      notificationSink: {
        emit: (event) => {
          if (event.type === "sync_progress" && event.details?.progressPercent === 0) {
            workerEventMarkers.push("progress:0:hung");
            return new Promise<void>(() => {});
          }
          if (event.type === "sync_completed") {
            workerEventMarkers.push("sync_completed");
          }
        }
      }
    }).tick();

    expect(result).toMatchObject({
      status: "processed",
      jobId: "job_backfill_progress_hung",
      jobType: "source_backfill"
    });
    expect(connectorSyncRequests).toEqual([
      expect.objectContaining({
        sourceId: "src_meta_ads",
        provider: "meta_ads",
        backfillWindow: "30_days",
        refreshWindowDays: 30
      })
    ]);
    expect(completed).toEqual([{ jobId: "job_backfill_progress_hung", status: "succeeded" }]);
    expect(workerEventMarkers).toEqual(["progress:0:hung", "connector.sync", "sync_completed"]);
  });
});
