/**
 * Hot (open-day) Meta Ads lane: read TODAY once at ad grain and DERIVE the campaign and ad set
 * day rows by summation, instead of asking Meta for all three grains.
 *
 * WHY: every Graph sub-request counts against the shared per-ad-account request budget (a Graph
 * Batch of three is three calls). The hot lane runs all day, so reading one grain instead of three
 * cuts its cost by two thirds (144 → 48 calls/day at a 30-minute cadence), which is what makes room
 * for a 15-minute cadence and the media archive.
 *
 * WHY IT IS SAFE for the open day only:
 *  - Every additive delivery metric (spend, impressions, clicks, inline_link_clicks, and every
 *    actions[]/action_values[] count per action_type per attribution window) is the sum of its
 *    child ads. Stored prod history agreed exactly for ad → ad set every day and ad → campaign on
 *    44/45 days (one day $0.09 off $8,025).
 *  - Rates are recomputed from the sums (never averaged): ctr = clicks / impressions × 100,
 *    cpc = spend / clicks, cpm = spend / impressions × 1000; a zero denominator is NULL.
 *  - Typed results ride on those sums: a derived ad set row is classified by the same canonical
 *    mapping as a Meta-read one (its promoted START_TRIAL / COMPLETE_REGISTRATION event included),
 *    so an action_type the engine cannot yet name survives verbatim in the summed actions[].
 *  - Meta's configured-outcome `results` list is not additive as a whole (a campaign's ad sets can
 *    optimise different events). Only the indicators the engine reads as typed counts (StartTrial's
 *    `conversions:start_trial_website`) are summed per attribution window, and only when EVERY ad
 *    in the group reported the indicator with values; otherwise the derived entry has no values, so
 *    the trial count stays unknown, never a partial sum or a measured zero. Inside one ad set every
 *    ad shares the promoted event, so its ads' counts add up to the ad set's.
 *  - Reach and frequency are NOT additive (one person can see several ads). Derived rows carry
 *    NULL — unmeasured, never 0 and never a sum.
 *  - Meta's default level=ad result list OMITS deleted and archived ads, while a campaign-level
 *    read includes their stats ("Manage Your Ad Object's Status": `act_<ID>/insights?level=ad`
 *    "does not return stats for the deleted object"; "You can query insights for DELETED objects
 *    using the ad.effective_status filter"). The hot read therefore filters on EVERY ad
 *    effective_status so the rolled-up totals match a campaign-level read.
 *  - Settled, restatement, backfill and attended-refresh reads keep reading all three grains from
 *    Meta, so every settled day is replaced by Meta's own campaign/ad set numbers (reach included).
 *    They send the same all-status filter at each read's OWN level (metaAdsAllStatusFiltering):
 *    the same doc's status table marks Archived and Deleted objects as NOT included in
 *    `/<PARENT_OBJECT_ID>/insights?level=<OBJECT_LEVEL>` results at every level, so an unfiltered
 *    settled read would drop a deleted ad's (or ad set's, or campaign's) day — ad rows would no
 *    longer sum to the campaign row, and the settled CLOSE would prune the hot lane's row for it.
 */

/** Every documented Ad `effective_status` (Graph Ad reference). Unknown values fail the request. */
export const META_ADS_AD_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
] as const;

/** Every documented Ad Set `effective_status` (Graph Ad Set reference / business SDK enum). */
export const META_ADS_ADSET_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
] as const;

/** Every documented Campaign `effective_status` (Graph Campaign reference / business SDK enum). */
export const META_ADS_CAMPAIGN_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
] as const;

const ALL_STATUSES_BY_LEVEL = {
  ad: META_ADS_AD_EFFECTIVE_STATUSES,
  adset: META_ADS_ADSET_EFFECTIVE_STATUSES,
  campaign: META_ADS_CAMPAIGN_EFFECTIVE_STATUSES,
} as const;

/**
 * Insights `filtering` value that returns stats for objects of `level` in every status, incl.
 * ARCHIVED/DELETED — `<level>.effective_status IN <every documented status for that object>`.
 * Filtering at the read's own level is the documented way to get deleted objects' stats back
 * ("Manage Your Ad Object's Status"); an unknown status value fails the request, so each level
 * carries only its own object's enum.
 */
export function metaAdsAllStatusFiltering(level: keyof typeof ALL_STATUSES_BY_LEVEL): string {
  return JSON.stringify([
    { field: `${level}.effective_status`, operator: "IN", value: [...ALL_STATUSES_BY_LEVEL[level]] },
  ]);
}

/** Insights `filtering` value that returns stats for ads in every status, incl. ARCHIVED/DELETED. */
export function metaAdsAllStatusAdFiltering(): string {
  return metaAdsAllStatusFiltering("ad");
}

/**
 * Only the hot open-day lane derives parent grains. Every other lane — including the attended
 * Live refresh — reads Meta's own campaign and ad set rows.
 */
export function metaAdsHotLaneRollsUpFromAds(lane: string | undefined): boolean {
  return lane === "hot_insights";
}

/** Stored in `actions_raw.derivation` on every derived row, so a reader can tell it from Meta's. */
export const META_ADS_HOT_ROLLUP_DERIVATION = {
  method: "sum_of_ad_insights",
  version: 1,
  source_grain: "ad",
} as const;

export interface MetaAdsRollupActionElement {
  action_type?: string | null;
  value?: string | number | null;
  [key: string]: unknown;
}

/** One entry of Meta's configured-outcome `results` list: an indicator plus one value per window. */
export interface MetaAdsRollupResultEntry {
  indicator?: string | null;
  values?: Array<{ value?: string | number | null; attribution_windows?: string[] | null }> | null;
}

export interface MetaAdsRollupOptions {
  /**
   * The `results` indicators the caller reads as typed counts (e.g. `conversions:start_trial_website`).
   * Only these are summed into a derived row; every other indicator stays off it.
   */
  resultIndicators?: readonly string[];
}

/** The subset of an ad-level insights row the rollup reads. */
export interface MetaAdsRollupSourceRow {
  campaign_id?: string | null;
  campaign_name?: string | null;
  adset_id?: string | null;
  adset_name?: string | null;
  date_start?: string | null;
  date_stop?: string | null;
  spend?: string | number | null;
  clicks?: string | number | null;
  inline_link_clicks?: string | number | null;
  impressions?: string | number | null;
  actions?: MetaAdsRollupActionElement[] | null;
  action_values?: MetaAdsRollupActionElement[] | null;
  results?: MetaAdsRollupResultEntry[] | null;
  objective?: string | null;
  optimization_goal?: string | null;
  account_currency?: string | null;
}

/** A synthesized parent-grain insights row, shaped like Meta's so the normal row builders apply. */
export interface MetaAdsRolledUpRow {
  campaign_id: string;
  campaign_name: string | null;
  adset_id?: string;
  adset_name?: string | null;
  date_start: string;
  date_stop: string | null;
  spend: number;
  clicks: number;
  inline_link_clicks: number;
  impressions: number;
  reach: null;
  frequency: null;
  cpm: number | null;
  cpc: number | null;
  ctr: number | null;
  actions?: MetaAdsRollupActionElement[];
  action_values?: MetaAdsRollupActionElement[];
  // Meta's configured-outcome list is not additive as a whole. A derived row carries only the
  // requested indicators (MetaAdsRollupOptions.resultIndicators), and null when no ad reported one.
  results: MetaAdsRollupResultEntry[] | null;
  cost_per_result: null;
  result_values_performance_indicator: null;
  objective: string | null;
  optimization_goal: string | null;
  account_currency: string | null;
}

export interface MetaAdsAdRollup {
  grain: "campaign" | "adset";
  entityId: string;
  adRowCount: number;
  row: MetaAdsRolledUpRow;
}

export class MetaAdsRollupError extends Error {}

const WINDOW_KEYS_WITH_HEADLINE = ["7d_click", "1d_view"] as const;

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Remove binary-float noise from a sum of decimal strings (stored columns keep 6 decimals). */
function roundSum(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

class ActionAccumulator {
  private readonly byType = new Map<string, Map<string, number>>();

  add(elements: MetaAdsRollupActionElement[]): void {
    for (const element of elements) {
      const actionType = nonEmpty(element.action_type);
      if (!actionType) throw new MetaAdsRollupError("Meta Ads ad insights returned an action without action_type");
      let sums = this.byType.get(actionType);
      if (!sums) {
        sums = new Map();
        this.byType.set(actionType, sums);
      }
      // An element with no per-window keys carries its headline in `value` (7d_click only). Pin it to
      // 7d_click before summing so it still counts once another ad's element brings window keys.
      const hasWindow = WINDOW_KEYS_WITH_HEADLINE.some((key) => element[key] !== undefined);
      const normalized: Record<string, unknown> = hasWindow || element.value === undefined
        ? element
        : { ...element, "7d_click": element.value };
      for (const [key, raw] of Object.entries(normalized)) {
        if (key === "action_type" || raw === undefined || raw === null) continue;
        sums.set(key, (sums.get(key) ?? 0) + finiteNumber(raw));
      }
    }
  }

  elements(): MetaAdsRollupActionElement[] {
    return [...this.byType].map(([actionType, sums]) => {
      const element: MetaAdsRollupActionElement = { action_type: actionType };
      for (const [key, total] of sums) element[key] = roundSum(total);
      return element;
    });
  }
}

/**
 * One ad's values for `indicator`, per attribution window, or null when they cannot be summed
 * honestly: the ad has no `results`, has no single entry for the indicator, the entry has no values,
 * or a value is malformed (not exactly one window, a repeated window, not a finite count >= 0).
 */
export function metaAdsResultWindowValues(results: MetaAdsRollupResultEntry[] | null | undefined, indicator: string): Map<string, number> | null {
  if (!Array.isArray(results)) return null;
  const entries = results.filter((entry) => entry?.indicator === indicator);
  if (entries.length !== 1) return null;
  const values = entries[0]!.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const byWindow = new Map<string, number>();
  for (const value of values) {
    const windows = value?.attribution_windows;
    const window = Array.isArray(windows) && windows.length === 1 ? nonEmpty(windows[0]) : null;
    if (window === null || byWindow.has(window)) return null;
    const raw = value.value;
    const count = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : Number.NaN;
    if (!Number.isFinite(count) || count < 0) return null;
    byWindow.set(window, count);
  }
  return byWindow;
}

/**
 * Sum one `results` indicator across a group's ads. Inside one ad set every ad shares the promoted
 * event, so every ad reports the same indicator and the counts add. The sum is published ONLY when
 * every ad reported it with summable values; otherwise the parent's entry has NO values (unknown,
 * never a partial sum). A window one ad omits counts 0 for it, as for actions[] (Meta omits zero
 * windows). Returns null when no ad reported the indicator at all.
 */
function sumResultIndicator(
  adResults: ReadonlyArray<MetaAdsRollupResultEntry[] | null>,
  indicator: string,
): MetaAdsRollupResultEntry | null {
  const reported = adResults.some((results) => Array.isArray(results) && results.some((entry) => entry?.indicator === indicator));
  if (!reported) return null;
  const totals = new Map<string, number>();
  for (const results of adResults) {
    const byWindow = metaAdsResultWindowValues(results, indicator);
    if (byWindow === null) return { indicator };
    for (const [window, count] of byWindow) totals.set(window, (totals.get(window) ?? 0) + count);
  }
  return {
    indicator,
    values: [...totals].map(([window, total]) => ({ value: roundSum(total), attribution_windows: [window] })),
  };
}

class GroupAccumulator {
  adRowCount = 0;
  spend = 0;
  clicks = 0;
  inlineLinkClicks = 0;
  impressions = 0;
  campaignName: string | null = null;
  adsetName: string | null = null;
  dateStop: string | null = null;
  objective: string | null = null;
  currency: string | null = null;
  readonly goals = new Set<string | null>();
  private actions: ActionAccumulator | null = null;
  private actionValues: ActionAccumulator | null = null;
  private readonly adResults: Array<MetaAdsRollupResultEntry[] | null> = [];

  constructor(
    readonly campaignId: string,
    readonly adsetId: string | null,
    readonly day: string,
    private readonly resultIndicators: readonly string[],
  ) {}

  add(row: MetaAdsRollupSourceRow): void {
    this.adRowCount += 1;
    this.spend += finiteNumber(row.spend);
    this.clicks += Math.round(finiteNumber(row.clicks));
    this.inlineLinkClicks += Math.round(finiteNumber(row.inline_link_clicks));
    this.impressions += Math.round(finiteNumber(row.impressions));
    this.campaignName ??= nonEmpty(row.campaign_name);
    this.adsetName ??= nonEmpty(row.adset_name);
    this.dateStop ??= nonEmpty(row.date_stop);
    this.objective ??= nonEmpty(row.objective);
    this.currency ??= nonEmpty(row.account_currency);
    this.goals.add(nonEmpty(row.optimization_goal));
    // Meta omits actions[] when an ad had none. The parent has actions[] iff ANY child did — exactly
    // what a parent-level read returns — and stays absent (unknown) when no child reported any.
    if (Array.isArray(row.actions)) (this.actions ??= new ActionAccumulator()).add(row.actions);
    if (Array.isArray(row.action_values)) (this.actionValues ??= new ActionAccumulator()).add(row.action_values);
    this.adResults.push(Array.isArray(row.results) ? row.results : null);
  }

  build(): MetaAdsRolledUpRow {
    const spend = roundSum(this.spend);
    const goal = this.goals.size === 1 ? [...this.goals][0] ?? null : null;
    const results = this.resultIndicators
      .map((indicator) => sumResultIndicator(this.adResults, indicator))
      .filter((entry): entry is MetaAdsRollupResultEntry => entry !== null);
    return {
      campaign_id: this.campaignId,
      campaign_name: this.campaignName,
      ...(this.adsetId === null ? {} : { adset_id: this.adsetId, adset_name: this.adsetName }),
      date_start: this.day,
      date_stop: this.dateStop,
      spend,
      clicks: this.clicks,
      inline_link_clicks: this.inlineLinkClicks,
      impressions: this.impressions,
      reach: null,
      frequency: null,
      ctr: this.impressions === 0 ? null : (this.clicks / this.impressions) * 100,
      cpc: this.clicks === 0 ? null : spend / this.clicks,
      cpm: this.impressions === 0 ? null : (spend / this.impressions) * 1000,
      ...(this.actions ? { actions: this.actions.elements() } : {}),
      ...(this.actionValues ? { action_values: this.actionValues.elements() } : {}),
      results: results.length > 0 ? results : null,
      cost_per_result: null,
      result_values_performance_indicator: null,
      objective: this.objective,
      // An ad set has one goal. A campaign keeps a goal only when every child ad agrees; otherwise
      // the canonical-event rule falls back to the campaign objective (Meta's own campaign rows
      // report e.g. "Unknown Optimization Goal", which resolves the same way).
      optimization_goal: goal,
      account_currency: this.currency,
    };
  }
}

/**
 * Derive one campaign row per campaign and one ad set row per ad set from ONE day of ad-level
 * insights rows. Throws rather than dropping a row it cannot attribute: silently losing spend
 * would publish a wrong total as if it were measured.
 */
export function rollUpMetaAdsAdInsights(rows: readonly MetaAdsRollupSourceRow[], options: MetaAdsRollupOptions = {}): {
  campaigns: MetaAdsAdRollup[];
  adsets: MetaAdsAdRollup[];
} {
  const resultIndicators = options.resultIndicators ?? [];
  const campaigns = new Map<string, GroupAccumulator>();
  const adsets = new Map<string, GroupAccumulator>();
  let day: string | null = null;
  for (const row of rows) {
    const campaignId = nonEmpty(row.campaign_id);
    if (!campaignId) throw new MetaAdsRollupError("Meta Ads ad insights row is missing campaign_id; refusing to roll up");
    const adsetId = nonEmpty(row.adset_id);
    if (!adsetId) throw new MetaAdsRollupError("Meta Ads ad insights row is missing adset_id; refusing to roll up");
    const rowDay = nonEmpty(row.date_start);
    if (!rowDay) throw new MetaAdsRollupError("Meta Ads ad insights row is missing date_start; refusing to roll up");
    if (day !== null && rowDay !== day) {
      throw new MetaAdsRollupError("Meta Ads hot rollup expects exactly one reporting day");
    }
    day = rowDay;
    let campaign = campaigns.get(campaignId);
    if (!campaign) campaigns.set(campaignId, campaign = new GroupAccumulator(campaignId, null, rowDay, resultIndicators));
    campaign.add(row);
    let adset = adsets.get(adsetId);
    if (!adset) adsets.set(adsetId, adset = new GroupAccumulator(campaignId, adsetId, rowDay, resultIndicators));
    else if (adset.campaignId !== campaignId) {
      throw new MetaAdsRollupError(`Meta Ads ad set ${adsetId} was reported under two campaigns`);
    }
    adset.add(row);
  }
  return {
    campaigns: [...campaigns].map(([entityId, group]) => ({
      grain: "campaign" as const, entityId, adRowCount: group.adRowCount, row: group.build(),
    })),
    adsets: [...adsets].map(([entityId, group]) => ({
      grain: "adset" as const, entityId, adRowCount: group.adRowCount, row: group.build(),
    })),
  };
}
