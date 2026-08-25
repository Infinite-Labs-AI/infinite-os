import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  metricView,
  metricColumn,
  aggregateExpression,
  caveatsForMetric,
  requiresResultTypePartition
} from "@infinite-os/analytical-engine";
import { loadInfiniteOsConfig } from "@infinite-os/config";
import { connectorFor } from "@infinite-os/connectors";
import { createInfiniteOsDb, loadMigrations, type InfiniteOsDb } from "@infinite-os/db";
import {
  createInfiniteOsRegistry,
  createNotificationSinkFromEnv,
  createNotificationEvent,
  type NotificationSink
} from "@infinite-os/runtime";

export interface WorkerTickResult {
  status: "idle" | "processed" | "failed";
  workerId: string;
  jobId?: string;
  jobType?: string;
  migrationCount: number;
  actionCount: number;
  error?: string;
}

export function createWorkerLoop(options: {
  db?: InfiniteOsDb;
  workerId?: string;
  pollIntervalMs?: number;
  workspaceRoot?: string;
  notificationSink?: NotificationSink;
} = {}) {
  const registry = createInfiniteOsRegistry();
  const workerId = options.workerId ?? `worker_${randomUUID()}`;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const notificationSink = options.notificationSink ?? createNotificationSinkFromEnv(process.env);

  async function tick(): Promise<WorkerTickResult> {
    const db = options.db;
    if (!db) {
      return {
        status: "idle",
        workerId,
        migrationCount: loadMigrations().length,
        actionCount: registry.list().length
      };
    }
    const job = await db.withTransaction((tx) => tx.claimNextJob(workerId, 60));
    if (!job) {
      await enqueueDueSchedules(db, notificationSink);
      return {
        status: "idle",
        workerId,
        migrationCount: loadMigrations().length,
        actionCount: registry.list().length
      };
    }
    try {
      await processJob(db, job, options.workspaceRoot ?? process.cwd(), notificationSink);
      await db.completeJob(String(job.id), "succeeded");
      return {
        status: "processed",
        workerId,
        jobId: String(job.id),
        jobType: String(job.job_type),
        migrationCount: loadMigrations().length,
        actionCount: registry.list().length
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.completeJob(String(job.id), "failed", message);
      await emitJobFailure(notificationSink, job, message);
      return {
        status: "failed",
        workerId,
        jobId: String(job.id),
        jobType: String(job.job_type),
        migrationCount: loadMigrations().length,
        actionCount: registry.list().length,
        error: message
      };
    }
  }

  async function runForever(): Promise<void> {
    for (;;) {
      const result = await tick();
      console.log(JSON.stringify(result));
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return { tick, runForever };
}

async function enqueueDueSchedules(db: InfiniteOsDb, notificationSink: NotificationSink): Promise<void> {
  const due = await db.query(
    `
      select ss.workspace_id, ss.source_id
      from sync_schedules ss
      join sources s on s.id = ss.source_id
      where ss.status = 'active'
        and s.status in ('connected', 'degraded')
        and ss.schedule_kind <> 'manual_only'
        and (ss.next_run_at is null or ss.next_run_at <= now())
      order by ss.next_run_at nulls first
      limit 10
    `
  );
  for (const schedule of due) {
    await db.createJob({
      workspaceId: String(schedule.workspace_id),
      jobType: "source_sync",
      payload: { sourceId: schedule.source_id, mode: "scheduled" }
    });
    await db.query(
      `
        update sync_schedules
        set last_enqueued_at = now(),
          next_run_at = case
            when schedule_kind = 'every_15_minutes' then now() + interval '15 minutes'
            when schedule_kind = 'hourly' then now() + interval '1 hour'
            when schedule_kind = 'daily' then now() + interval '1 day'
            when schedule_kind = 'weekly' then now() + interval '7 days'
            else null
          end
        where source_id = $1
      `,
      [schedule.source_id]
    );
  }
  const stale = await db.query(
    `
      select ss.workspace_id, ss.source_id, ss.stale_after_minutes, ss.last_completed_at
      from sync_schedules ss
      join sources s on s.id = ss.source_id
      where ss.status = 'active'
        and s.status in ('connected', 'degraded')
        and ss.stale_after_minutes is not null
        and ss.last_completed_at is not null
        and ss.last_completed_at < now() - (ss.stale_after_minutes * interval '1 minute')
      limit 10
    `
  );
  for (const source of stale) {
    await notificationSink.emit(
      createNotificationEvent({
        type: "source_stale",
        workspaceId: String(source.workspace_id),
        sourceId: String(source.source_id),
        details: {
          staleAfterMinutes: source.stale_after_minutes,
          lastCompletedAt: source.last_completed_at
        }
      })
    );
  }
}

async function processJob(
  db: InfiniteOsDb,
  job: Record<string, unknown>,
  workspaceRoot: string,
  notificationSink: NotificationSink
): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  if (job.job_type === "source_sync" || job.job_type === "source_backfill") {
    const sourceId = requireString(payload.sourceId, "sourceId");
    const source = await db.one(
      "select id, workspace_id, provider from sources where id = $1 and workspace_id = $2",
      [sourceId, job.workspace_id]
    );
    if (!source) {
      throw new Error(`source_not_found:${sourceId}`);
    }
    const connector = connectorFor(String(source.provider));
    const refreshWindowDays = optionalPositiveNumber(payload.refreshWindowDays);
    const backfillWindow = optionalString(payload.backfillWindow);
    const mode = optionalString(payload.mode);
    const emitsBackfillProgress = job.job_type === "source_backfill" && connector.provider === "meta_ads";
    if (emitsBackfillProgress) {
      emitProgressWithoutAwaitingAsyncDelivery(notificationSink, {
        workspaceId: String(source.workspace_id),
        sourceId,
        jobId: String(job.id),
        provider: connector.provider,
        jobType: String(job.job_type),
        progressPercent: 0
      });
    }
    await connector.sync(db, {
      workspaceId: String(source.workspace_id),
      sourceId,
      provider: connector.provider,
      syncRunId: `sync_${randomUUID()}`,
      ...(mode ? { mode } : {}),
      ...(refreshWindowDays === undefined ? {} : { refreshWindowDays }),
      ...(backfillWindow ? { backfillWindow } : {})
    });
    await db.query(
      "update sync_schedules set last_completed_at = now() where source_id = $1",
      [sourceId]
    );
    if (emitsBackfillProgress) {
      emitProgressWithoutAwaitingAsyncDelivery(notificationSink, {
        workspaceId: String(source.workspace_id),
        sourceId,
        jobId: String(job.id),
        provider: connector.provider,
        jobType: String(job.job_type),
        progressPercent: 100
      });
    }
    await notificationSink.emit(
      createNotificationEvent({
        type: "sync_completed",
        workspaceId: String(source.workspace_id),
        sourceId,
        jobId: String(job.id),
        details: { provider: connector.provider, jobType: job.job_type }
      })
    );
    return;
  }
  if (job.job_type === "materialized_view_refresh") {
    return;
  }
  if (job.job_type === "saved_report_run") {
    const reportId = requireString(payload.reportId, "reportId");
    const result = await runSavedReport(db, String(job.workspace_id), reportId);
    await db.query(
      `
        insert into integration_audit_log (id, workspace_id, actor_type, action, status, details)
        values ($1, $2, 'worker', $3, 'succeeded', $4::jsonb)
      `,
      [
        `audit_${randomUUID()}`,
        job.workspace_id,
        job.job_type,
        JSON.stringify({ reportId, rowCount: result.rowCount, metric: result.metric })
      ]
    );
    return;
  }
  if (job.job_type === "saved_report_export") {
    const reportId = requireString(payload.reportId, "reportId");
    const format = String(payload.format ?? "json");
    if (format !== "json") {
      throw new Error(`unsupported_export_format:${format}`);
    }
    const result = await runSavedReport(db, String(job.workspace_id), reportId);
    const exportDir = join(workspaceRoot, ".growth-os", "exports", String(job.workspace_id));
    mkdirSync(exportDir, { recursive: true });
    const artifactPath = join(exportDir, `${String(job.id)}.json`);
    const artifact = {
      generatedAt: new Date().toISOString(),
      workspaceId: job.workspace_id,
      report: result.report,
      result: {
        metric: result.metric,
        view: result.view,
        rows: result.rows,
        rowCount: result.rowCount,
        caveats: result.caveats
      },
      security: {
        credentialsIncluded: false,
        rawPayloadJsonIncluded: false,
        genericSqlAllowed: false
      }
    };
    const serialized = JSON.stringify(artifact, null, 2);
    writeFileSync(artifactPath, serialized);
    await db.query(
      `
        insert into saved_report_exports (
          id, workspace_id, saved_report_id, job_run_id, format,
          artifact_path, artifact_bytes, row_count, status
        )
        values ($1,$2,$3,$4,'json',$5,$6,$7,'succeeded')
        on conflict (job_run_id)
        do update set artifact_path = excluded.artifact_path,
          artifact_bytes = excluded.artifact_bytes,
          row_count = excluded.row_count,
          status = excluded.status
      `,
      [
        `export_${randomUUID()}`,
        job.workspace_id,
        reportId,
        job.id,
        artifactPath,
        Buffer.byteLength(serialized),
        result.rowCount
      ]
    );
    await db.query(
      `
        insert into integration_audit_log (id, workspace_id, actor_type, action, status, details)
        values ($1, $2, 'worker', $3, 'succeeded', $4::jsonb)
      `,
      [
        `audit_${randomUUID()}`,
        job.workspace_id,
        job.job_type,
        JSON.stringify({ reportId, artifactPath, rowCount: result.rowCount })
      ]
    );
    await notificationSink.emit(
      createNotificationEvent({
        type: "export_ready",
        workspaceId: String(job.workspace_id),
        jobId: String(job.id),
        reportId,
        artifactPath,
        details: { rowCount: result.rowCount, format: "json" }
      })
    );
    return;
  }
  throw new Error(`unsupported_job_type:${String(job.job_type)}`);
}

async function emitJobFailure(
  notificationSink: NotificationSink,
  job: Record<string, unknown>,
  error: string
): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  if (job.job_type === "source_sync" || job.job_type === "source_backfill") {
    await notificationSink.emit(
      createNotificationEvent({
        type: "sync_failed",
        workspaceId: String(job.workspace_id),
        sourceId: typeof payload.sourceId === "string" ? payload.sourceId : undefined,
        jobId: String(job.id),
        error,
        details: { jobType: job.job_type }
      })
    );
  }
}

async function runSavedReport(db: InfiniteOsDb, workspaceId: string, reportId: string) {
  const report = await db.one<{ id: string; name: string; tool_plan: Record<string, unknown> }>(
    "select id, name, tool_plan from saved_reports where workspace_id = $1 and id = $2",
    [workspaceId, reportId]
  );
  if (!report) {
    throw new Error(`saved_report_not_found:${reportId}`);
  }
  const plan = report.tool_plan ?? {};
  const metric = typeof plan.metric === "string" ? plan.metric : "recognized_revenue";
  // SINGLE SOURCE OF TRUTH: the worker IMPORTS metricView/metricColumn/aggregateExpression/
  // caveatsForMetric from @infinite-os/analytical-engine (no more lockstep duplicate copies).
  //
  // INTENTIONAL ROUTING CHANGE (DEDUP) for non-GA4-traffic saved reports: the deleted
  // worker copies were a SUBSET of the engine — they routed EVERY metric that was not
  // GA4-traffic|recognized_revenue to vw_site_conversion_rate with the generic caveat set.
  // saved_reports.tool_plan is persisted by the engine's createSavedReport with NO metric
  // validation, so any FIRST_PHASE_METRICS value (posthog_event_count, shopify_*, meta_ads_*,
  // x_*) is worker-reachable. The old subset produced BROKEN SQL for those (e.g.
  // `sum(posthog_event_count)` against vw_site_conversion_rate references a non-existent
  // column -> runtime error). Importing the engine routes them to their real views
  // (vw_posthog_events, vw_shopify_orders, vw_meta_ads_campaign_daily, vw_x_*) with
  // metric-specific caveats. This is a latent-bug FIX, not a regression: the only behavior
  // that changes is the previously-erroring non-GA4 path now emitting correct SQL/caveats.
  //
  // FOLLOW-UP (pre-existing, not a DEDUP regression): plan.metric is interpolated into SQL
  // below WITHOUT a FIRST_PHASE_METRICS allowlist gate (the page_views_by_page string check
  // is the only guard). Now that routing is correct for more metrics, more arbitrary metric
  // strings reach live SQL — worth a rejectUnsupportedMetric gate here in a follow-up.
  //
  // page_views_by_page is BREAKDOWN-ONLY in v1 (page grain) and is the worker-only
  // exclusion: this guard MUST stay BEFORE the metricView/metricColumn/aggregateExpression
  // calls. The engine maps page_views_by_page -> vw_site_pages with column `page_views`,
  // but saved reports have no page grain, so we reject it here before any engine routing
  // (the engine's page_views_by_page branch is therefore never exercised from the worker).
  // See packages/analytical-engine metricColumn() and .context/ga4-v1-build-plan.md (PR2 Step 10).
  if (metric === "page_views_by_page") {
    throw new Error("saved_report_metric_unsupported:page_views_by_page_is_breakdown_only");
  }
  // Phase-1 §6 — the saved-report path is ungrouped (no GROUP BY, no result_type partition),
  // so the conversion-family metrics (results/cost_per_result/conversion_value/roas) cannot be
  // honored here without silently blending CPL+CPA across result_types. Exclude them the same
  // way as page_views_by_page rather than emit a meaningless blended number. They remain fully
  // queryable through run_metric_query / run_breakdown_query, which enforce the partition.
  if (requiresResultTypePartition(metric)) {
    throw new Error(`saved_report_metric_unsupported:${metric}_requires_result_type_partition`);
  }
  const view = metricView(metric);
  const column = metricColumn(metric);
  const rows = await db.query(
    `
      select ${aggregateExpression(metric, column)} as ${metric}
      from ${view}
      where workspace_id = $1
      limit 500
    `,
    [workspaceId]
  );
  return {
    report: { id: report.id, name: report.name, toolPlan: plan },
    metric,
    view,
    rows,
    rowCount: rows.length,
    caveats: caveatsForMetric(metric)
  };
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function emitProgressWithoutAwaitingAsyncDelivery(
  notificationSink: NotificationSink,
  input: {
    workspaceId: string;
    sourceId: string;
    jobId: string;
    provider: string;
    jobType: string;
    progressPercent: number;
  }
): void {
  // Production sinks either return promptly or return a Promise for remote delivery.
  // Detach that async delivery so progress telemetry never controls sync success.
  void emitSyncProgress(notificationSink, input).catch(() => {
    // Progress notifications must not decide whether the source sync succeeds.
  });
}

async function emitSyncProgress(
  notificationSink: NotificationSink,
  input: {
    workspaceId: string;
    sourceId: string;
    jobId: string;
    provider: string;
    jobType: string;
    progressPercent: number;
  }
): Promise<void> {
  await notificationSink.emit(
    createNotificationEvent({
      type: "sync_progress",
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      jobId: input.jobId,
      progressPercent: input.progressPercent,
      details: {
        provider: input.provider,
        jobType: input.jobType
      }
    })
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadInfiniteOsConfig();
  const db = createInfiniteOsDb(config.databaseUrl);
  const loop = createWorkerLoop({ db, workspaceRoot: config.workspaceRoot });
  await loop.runForever();
}
