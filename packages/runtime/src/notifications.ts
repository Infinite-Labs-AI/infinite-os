export type NotificationEventType =
  | "sync_progress"
  | "sync_completed"
  | "sync_failed"
  | "source_stale"
  | "export_ready";

export interface NotificationEvent {
  type: NotificationEventType;
  workspaceId: string;
  sourceId?: string;
  jobId?: string;
  reportId?: string;
  artifactPath?: string;
  status: "info" | "warning" | "error";
  occurredAt: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface NotificationSink {
  emit(event: NotificationEvent): Promise<void> | void;
}

export interface NotificationEnv {
  GROWTH_OS_NOTIFICATION_WEBHOOK_URL?: string;
}

export function createNotificationSinkFromEnv(
  env: NotificationEnv = process.env,
  options: {
    fetcher?: typeof fetch;
    log?: (line: string) => void;
  } = {}
): NotificationSink {
  if (env.GROWTH_OS_NOTIFICATION_WEBHOOK_URL) {
    return createWebhookNotificationSink(
      env.GROWTH_OS_NOTIFICATION_WEBHOOK_URL,
      options.fetcher ?? fetch
    );
  }
  return createLogNotificationSink(options.log);
}

export function createLogNotificationSink(
  log: (line: string) => void = console.log
): NotificationSink {
  return {
    emit(event) {
      log(JSON.stringify({ notification: event }));
    }
  };
}

export function createWebhookNotificationSink(
  webhookUrl: string,
  fetcher: typeof fetch = fetch
): NotificationSink {
  return {
    async emit(event) {
      await fetcher(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      });
    }
  };
}

export function createNotificationEvent(input: {
  type: NotificationEventType;
  workspaceId: string;
  sourceId?: string;
  jobId?: string;
  reportId?: string;
  artifactPath?: string;
  error?: string;
  progressPercent?: number;
  details?: Record<string, unknown>;
}): NotificationEvent {
  const status = statusFor(input.type);
  const progressPercent = boundedProgressPercent(input.progressPercent);
  return {
    type: input.type,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    jobId: input.jobId,
    reportId: input.reportId,
    artifactPath: input.artifactPath,
    status,
    occurredAt: new Date().toISOString(),
    summary: summaryFor(input),
    details: {
      ...(input.details ?? {}),
      ...(progressPercent === undefined
        ? {}
        : { progressPercent, progressBar: renderProgressBar(progressPercent) }),
      ...(input.error ? { error: input.error } : {})
    }
  };
}

function statusFor(type: NotificationEventType): NotificationEvent["status"] {
  if (type === "sync_failed") return "error";
  if (type === "source_stale") return "warning";
  return "info";
}

function summaryFor(input: {
  type: NotificationEventType;
  sourceId?: string;
  reportId?: string;
  artifactPath?: string;
  progressPercent?: number;
  details?: Record<string, unknown>;
}): string {
  if (input.type === "sync_progress") {
    const label =
      input.details?.provider === "meta_ads" && input.details?.jobType === "source_backfill"
        ? "Meta Ads backfill"
        : "Sync";
    return `${label} progress for ${input.sourceId ?? "source"} ${renderProgressBar(input.progressPercent ?? 0)}`;
  }
  if (input.type === "sync_completed") {
    return `Sync completed for ${input.sourceId ?? "source"}`;
  }
  if (input.type === "sync_failed") {
    return `Sync failed for ${input.sourceId ?? "source"}`;
  }
  if (input.type === "source_stale") {
    return `Source ${input.sourceId ?? "unknown"} is stale`;
  }
  return `Export ready for ${input.reportId ?? "saved report"} at ${input.artifactPath ?? "artifact"}`;
}

export function renderProgressBar(percent: number, width = 20): string {
  const boundedPercent = boundedProgressPercent(percent) ?? 0;
  const boundedWidth = Math.max(1, Math.floor(width));
  const filled = Math.round((boundedPercent / 100) * boundedWidth);
  return `[${"#".repeat(filled)}${"-".repeat(boundedWidth - filled)}] ${boundedPercent}%`;
}

function boundedProgressPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
