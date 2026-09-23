export interface MetaAdsResponseSignal {
  maxPercent: number | null;
  estimatedRegainSeconds: number | null;
  resetSeconds: number | null;
  accessTier: string | null;
  throttled?: boolean;
}

export type MetaAdsRequestKind =
  | "account_liveness"
  | "campaign_edge"
  | "adset_edge"
  | "ad_edge"
  | "campaign_insights"
  | "adset_insights"
  | "ad_insights"
  // Meta async report jobs (the data-volume ladder's last rung): the job POST and each status
  // poll are real budgeted calls; their result pages count under the grain's *_insights kind.
  | "insights_async_submit"
  | "insights_async_poll";

export type MetaRequestLane =
  | "hot_insights"
  | "inventory_sync"
  | "settled_history"
  | "history_backfill"
  | "attended_refresh"
  | "media_archive";

export const META_REQUEST_LANES: readonly MetaRequestLane[] = [
  "hot_insights",
  "inventory_sync",
  "settled_history",
  "history_backfill",
  "attended_refresh",
  "media_archive",
];

export function isMetaRequestLane(value: unknown): value is MetaRequestLane {
  return typeof value === "string" && (META_REQUEST_LANES as readonly string[]).includes(value);
}

const META_ADS_REQUEST_KINDS: readonly MetaAdsRequestKind[] = [
  "account_liveness",
  "campaign_edge",
  "adset_edge",
  "ad_edge",
  "campaign_insights",
  "adset_insights",
  "ad_insights",
  "insights_async_submit",
  "insights_async_poll",
];

export const META_ADS_DEFAULT_REQUEST_BUDGET = 500;
export const META_ADS_MAX_REQUEST_BUDGET = 5_000;
const META_ADS_UTILIZATION_SAMPLE_LIMIT = 32;
export const META_ADS_UTILIZATION_HIGH_WATERMARK = 95;

interface MetaAdsRequestTelemetrySnapshotBase {
  provider: "meta_ads";
  operation: "inventory_sync" | "history_sync";
  lastReservedAt: string | null;
  requestCount: number;
  pageCount: number;
  retryCount: number;
  byKind: Record<MetaAdsRequestKind, number>;
  /** Present on FULL inventory scans only: how the ad edge was read, and why it fell back to heavy. */
  fullAdRead?: { mode: "lean" | "heavy"; fallback: string | null };
  /** Present on INCREMENTAL inventory scans only: parent-transition child status refreshes. */
  childStatusRefresh?: MetaAdsChildStatusRefreshTelemetry;
  utilization: {
    maxPercent: number | null;
    samples: number[];
    highWatermarkResponses: number;
  };
  budget: {
    limit: number;
    remaining: number;
    exhausted: boolean;
  };
}

/**
 * What an incremental scan did about parents whose own status changed (meta-child-status-refresh.ts).
 * `refreshes` is the number of parent-edge child reads that ran and `requests` the Graph calls they
 * cost. With no parent change, everything is 0 and `outcome` is "none".
 */
export interface MetaAdsChildStatusRefreshTelemetry {
  outcome: "none" | "applied" | "full_read_requested";
  changedCampaigns: number;
  changedAdsets: number;
  refreshes: number;
  requests: number;
  adsetsUpdated: number;
  adsUpdated: number;
  /** Why the refresh was not applied and the next scan was switched to a full read. */
  fullReadReason: string | null;
}

export interface MetaAdsRequestTelemetrySnapshotV1 extends MetaAdsRequestTelemetrySnapshotBase {
  schemaVersion: 1;
}

export interface MetaAdsRequestTelemetrySnapshotV2 extends MetaAdsRequestTelemetrySnapshotBase {
  schemaVersion: 2;
  lane: MetaRequestLane;
}

export type MetaAdsRequestTelemetrySnapshot =
  | MetaAdsRequestTelemetrySnapshotV1
  | MetaAdsRequestTelemetrySnapshotV2;

export class MetaAdsRequestBudgetError extends Error {
  readonly code = "provider_rate_budget_exhausted";
  readonly retryable = true;

  constructor(limit: number) {
    super(`Meta Ads request budget exhausted after ${limit} requests; the reporting window remains incomplete`);
  }
}

// Graceful wall-time stop. Checked at the same beforeRequest chokepoint the request budget uses, so
// an extract that runs long throws a RETRYABLE error BEFORE a hosted maxDuration hard-kill can fire.
// The throw lands inside extract → the connector's catch runs recordSyncFailure (source not left
// `syncing`, run marked `failed`), making a time overrun the same benign, resumable outcome as a
// request-budget stop instead of a mid-CLOSE SIGKILL that strands the source. The deadline is an
// opaque wall-clock millisecond value owned by the CALLER (SyncRequest.softDeadlineAtMs); the engine
// imports nothing cloud/Supabase to honor it.
export class MetaAdsTimeBudgetError extends Error {
  readonly code = "provider_time_budget_exhausted";
  readonly retryable = true;

  constructor(deadlineAtMs: number) {
    super(`Meta Ads soft time budget exhausted at ${new Date(deadlineAtMs).toISOString()}; the reporting window remains incomplete`);
  }
}

/** Bounded, payload-free accounting for one Meta sync. */
export class MetaAdsRequestTelemetry {
  private cooldownUntil = 0;
  private requestCount = 0;
  private pageCount = 0;
  private retryCount = 0;
  private maxUtilizationPercent: number | null = null;
  private highWatermarkResponses = 0;
  private exhausted = false;
  private lastReservedAt: string | null = null;
  private readonly samples: number[] = [];
  private fullAdRead: { mode: "lean" | "heavy"; fallback: string | null } | null = null;
  private childStatusRefresh: MetaAdsChildStatusRefreshTelemetry | null = null;
  private readonly byKind = Object.fromEntries(
    META_ADS_REQUEST_KINDS.map((kind) => [kind, 0]),
  ) as Record<MetaAdsRequestKind, number>;

  constructor(
    readonly limit: number,
    private readonly persistReservation?: (snapshot: MetaAdsRequestTelemetrySnapshot) => Promise<void>,
    // Optional wall-clock deadline (ms since epoch). Omitted on desktop → behaviour unchanged.
    // When set (hosted), the first fetch attempted at or after it throws MetaAdsTimeBudgetError.
    private readonly deadlineAtMs?: number,
    private readonly onResponse?: (signal: MetaAdsResponseSignal) => Promise<void>,
    private readonly operation: "inventory_sync" | "history_sync" = "history_sync",
    private readonly lane?: MetaRequestLane,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > META_ADS_MAX_REQUEST_BUDGET) {
      throw new MetaAdsRequestBudgetError(Math.max(0, Number.isFinite(limit) ? limit : 0));
    }
  }

  /** Must run immediately before fetch. No request can cross the admitted limit. */
  async beforeRequest(kind: MetaAdsRequestKind, retry: boolean): Promise<void> {
    await this.beforeRequests([kind], retry);
  }

  /** Atomically reserves every logical request carried by one outer provider batch. */
  async beforeRequests(kinds: readonly MetaAdsRequestKind[], retry: boolean): Promise<void> {
    if (kinds.length === 0) return;
    if (Date.now() < this.cooldownUntil) {
      throw Object.assign(new Error("Meta Ads provider cooldown active"), { code: "provider_rate_limited", retryable: true });
    }
    // Soft time budget FIRST: a run that has already overrun its wall-time deadline stops here,
    // BEFORE consuming another request, so the graceful stop pre-empts a hosted hard-kill. Checked
    // at the fetch boundary only, so it never interrupts a half-written LOAD (LOAD does no fetches).
    if (this.deadlineAtMs !== undefined && Date.now() >= this.deadlineAtMs) {
      this.exhausted = true;
      await this.persistReservation?.(this.snapshot());
      throw new MetaAdsTimeBudgetError(this.deadlineAtMs);
    }
    if (this.requestCount + kinds.length > this.limit) {
      this.exhausted = true;
      await this.persistReservation?.(this.snapshot());
      throw new MetaAdsRequestBudgetError(this.limit);
    }
    this.requestCount += kinds.length;
    for (const kind of kinds) this.byKind[kind] += 1;
    if (retry) this.retryCount += kinds.length;
    this.lastReservedAt = new Date().toISOString();
    // Reserve durably before the provider call. A hard kill between this write and fetch can
    // conservatively over-count one request; it can never hide spend from the scheduler.
    await this.persistReservation?.(this.snapshot());
  }

  async observeResponse(signal: MetaAdsResponseSignal): Promise<void> {
    if (signal.throttled || (signal.maxPercent ?? 0) >= META_ADS_UTILIZATION_HIGH_WATERMARK || (signal.estimatedRegainSeconds ?? 0) > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.max(signal.estimatedRegainSeconds ?? 0, signal.resetSeconds ?? 0, 60) * 1000);
    }
    await this.onResponse?.(signal);
  }

  /** One accepted response page. Retried high-utilization responses are not counted as pages. */
  recordPage(utilizationPercent: number | null): void {
    this.pageCount += 1;
    this.recordUtilization(utilizationPercent);
  }

  recordRejectedResponse(utilizationPercent: number | null): void {
    this.recordUtilization(utilizationPercent);
  }

  /** Records how a FULL inventory scan read the ad edge (meta-lean-inventory.ts). */
  noteFullAdRead(mode: "lean" | "heavy", fallback: string | null): void {
    this.fullAdRead = { mode, fallback };
  }

  /** Records the incremental scan's parent-transition child refresh (meta-child-status-refresh.ts). */
  noteChildStatusRefresh(summary: MetaAdsChildStatusRefreshTelemetry): void {
    this.childStatusRefresh = { ...summary };
  }

  /** Requests this run can still admit before the budget refuses one. */
  remainingRequests(): number {
    return Math.max(0, this.limit - this.requestCount);
  }

  snapshot(): MetaAdsRequestTelemetrySnapshot {
    const common: MetaAdsRequestTelemetrySnapshotBase = {
      provider: "meta_ads",
      operation: this.operation,
      lastReservedAt: this.lastReservedAt,
      requestCount: this.requestCount,
      pageCount: this.pageCount,
      retryCount: this.retryCount,
      byKind: { ...this.byKind },
      ...(this.fullAdRead ? { fullAdRead: { ...this.fullAdRead } } : {}),
      ...(this.childStatusRefresh ? { childStatusRefresh: { ...this.childStatusRefresh } } : {}),
      utilization: {
        maxPercent: this.maxUtilizationPercent,
        samples: [...this.samples],
        highWatermarkResponses: this.highWatermarkResponses,
      },
      budget: {
        limit: this.limit,
        remaining: Math.max(0, this.limit - this.requestCount),
        exhausted: this.exhausted,
      },
    };
    return this.lane
      ? { ...common, schemaVersion: 2, lane: this.lane }
      : { ...common, schemaVersion: 1 };
  }

  private recordUtilization(value: number | null): void {
    if (value === null || !Number.isFinite(value)) return;
    const bounded = Math.max(0, Math.min(100, value));
    this.maxUtilizationPercent = this.maxUtilizationPercent === null
      ? bounded
      : Math.max(this.maxUtilizationPercent, bounded);
    if (this.samples.length < META_ADS_UTILIZATION_SAMPLE_LIMIT) this.samples.push(bounded);
    if (bounded >= META_ADS_UTILIZATION_HIGH_WATERMARK) this.highWatermarkResponses += 1;
  }
}

/** Structural transport hook, suitable for process-local handler options. */
export type MetaAdsRequestObserver = Pick<MetaAdsRequestTelemetry, "beforeRequest" | "beforeRequests" | "recordPage" | "recordRejectedResponse" | "observeResponse">;
