export type MetaAdsRequestKind =
  | "account_liveness"
  | "campaign_edge"
  | "adset_edge"
  | "ad_edge"
  | "campaign_insights"
  | "adset_insights"
  | "ad_insights";

const META_ADS_REQUEST_KINDS: readonly MetaAdsRequestKind[] = [
  "account_liveness",
  "campaign_edge",
  "adset_edge",
  "ad_edge",
  "campaign_insights",
  "adset_insights",
  "ad_insights",
];

export const META_ADS_DEFAULT_REQUEST_BUDGET = 500;
export const META_ADS_MAX_REQUEST_BUDGET = 5_000;
const META_ADS_UTILIZATION_SAMPLE_LIMIT = 32;
export const META_ADS_UTILIZATION_HIGH_WATERMARK = 95;

export interface MetaAdsRequestTelemetrySnapshot {
  provider: "meta_ads";
  schemaVersion: 1;
  requestCount: number;
  pageCount: number;
  retryCount: number;
  byKind: Record<MetaAdsRequestKind, number>;
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
  private requestCount = 0;
  private pageCount = 0;
  private retryCount = 0;
  private maxUtilizationPercent: number | null = null;
  private highWatermarkResponses = 0;
  private exhausted = false;
  private readonly samples: number[] = [];
  private readonly byKind = Object.fromEntries(
    META_ADS_REQUEST_KINDS.map((kind) => [kind, 0]),
  ) as Record<MetaAdsRequestKind, number>;

  constructor(
    readonly limit: number,
    private readonly persistReservation?: (snapshot: MetaAdsRequestTelemetrySnapshot) => Promise<void>,
    // Optional wall-clock deadline (ms since epoch). Omitted on desktop → behaviour unchanged.
    // When set (hosted), the first fetch attempted at or after it throws MetaAdsTimeBudgetError.
    private readonly deadlineAtMs?: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > META_ADS_MAX_REQUEST_BUDGET) {
      throw new MetaAdsRequestBudgetError(Math.max(0, Number.isFinite(limit) ? limit : 0));
    }
  }

  /** Must run immediately before fetch. No request can cross the admitted limit. */
  async beforeRequest(kind: MetaAdsRequestKind, retry: boolean): Promise<void> {
    // Soft time budget FIRST: a run that has already overrun its wall-time deadline stops here,
    // BEFORE consuming another request, so the graceful stop pre-empts a hosted hard-kill. Checked
    // at the fetch boundary only, so it never interrupts a half-written LOAD (LOAD does no fetches).
    if (this.deadlineAtMs !== undefined && Date.now() >= this.deadlineAtMs) {
      this.exhausted = true;
      await this.persistReservation?.(this.snapshot());
      throw new MetaAdsTimeBudgetError(this.deadlineAtMs);
    }
    if (this.requestCount >= this.limit) {
      this.exhausted = true;
      await this.persistReservation?.(this.snapshot());
      throw new MetaAdsRequestBudgetError(this.limit);
    }
    this.requestCount += 1;
    this.byKind[kind] += 1;
    if (retry) this.retryCount += 1;
    // Reserve durably before the provider call. A hard kill between this write and fetch can
    // conservatively over-count one request; it can never hide spend from the scheduler.
    await this.persistReservation?.(this.snapshot());
  }

  /** One accepted response page. Retried high-utilization responses are not counted as pages. */
  recordPage(utilizationPercent: number | null): void {
    this.pageCount += 1;
    this.recordUtilization(utilizationPercent);
  }

  recordRejectedResponse(utilizationPercent: number | null): void {
    this.recordUtilization(utilizationPercent);
  }

  snapshot(): MetaAdsRequestTelemetrySnapshot {
    return {
      provider: "meta_ads",
      schemaVersion: 1,
      requestCount: this.requestCount,
      pageCount: this.pageCount,
      retryCount: this.retryCount,
      byKind: { ...this.byKind },
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
