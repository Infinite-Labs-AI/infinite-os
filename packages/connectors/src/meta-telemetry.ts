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
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > META_ADS_MAX_REQUEST_BUDGET) {
      throw new MetaAdsRequestBudgetError(Math.max(0, Number.isFinite(limit) ? limit : 0));
    }
  }

  /** Must run immediately before fetch. No request can cross the admitted limit. */
  async beforeRequest(kind: MetaAdsRequestKind, retry: boolean): Promise<void> {
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
