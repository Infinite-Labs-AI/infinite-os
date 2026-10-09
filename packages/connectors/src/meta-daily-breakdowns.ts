/**
 * DAILY Meta ad set breakdowns and campaign HOURLY delivery (engine migration 0085). Pure: no I/O; the
 * requests and writes live in index.ts beside the weekly window read they supersede.
 *
 * WHY (governed data layer, 2026-10-08; founder: "daily calls are fine; a new sync for daily device/placement is
 * fine; keep data forever"): the chat agent answers device/placement questions for ANY range in the user's own
 * time zone, which a fixed settled-week all_days window cannot serve. One query per dimension with
 * time_increment=1 returns every day of its window, so a daily re-read of the restatement window costs the
 * same number of calls as one weekly window (plus extra pages for the extra rows).
 *
 * The hourly read is campaign level with breakdowns=hourly_stats_aggregated_by_advertiser_time_zone, so both
 * the day and the hour are on the ad account's own calendar; a reader converts to the user's zone.
 */

/** Daily breakdown dimensions, ONE per query. */
export const META_ADS_DAILY_BREAKDOWN_DIMENSIONS = ["device_platform", "publisher_platform", "platform_position"] as const;
export type MetaAdsDailyBreakdownDimension = (typeof META_ADS_DAILY_BREAKDOWN_DIMENSIONS)[number];

export function isMetaAdsDailyBreakdownDimension(value: unknown): value is MetaAdsDailyBreakdownDimension {
  return typeof value === "string" && (META_ADS_DAILY_BREAKDOWN_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * The `breakdowns` parameter Meta needs for a dimension. platform_position is only valid together with
 * publisher_platform (Meta refuses it alone), so it is asked as the pair and each row is stored with its
 * platform as the parent value.
 */
export function metaAdsDailyBreakdownParam(dimension: MetaAdsDailyBreakdownDimension): string {
  return dimension === "platform_position" ? "publisher_platform,platform_position" : dimension;
}

/** [parent, value] of one row for a dimension; null when Meta left a needed key out. */
export function metaAdsDailyBreakdownValue(
  dimension: MetaAdsDailyBreakdownDimension,
  row: Record<string, unknown>,
): { parent: string; value: string } | null {
  const text = (key: string): string | null => (typeof row[key] === "string" && row[key] !== "" ? (row[key] as string) : null);
  if (dimension === "platform_position") {
    const parent = text("publisher_platform");
    const value = text("platform_position");
    return parent && value ? { parent, value } : null;
  }
  const value = text(dimension);
  return value ? { parent: "", value } : null;
}

/** The longest window one daily query may cover. A restatement window is ~7 days; a month is the ceiling. */
export const META_ADS_DAILY_BREAKDOWN_MAX_WINDOW_DAYS = 31;

/** Fields of the daily breakdown read: delivery + actions, no video, no rates (readers recompute rates). */
export const META_ADS_DAILY_BREAKDOWN_FIELDS =
  "adset_id,campaign_id,date_start,date_stop,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,account_currency";

/** The hourly breakdown, on the ADVERTISER's (ad account's) time zone. */
export const META_ADS_HOURLY_BREAKDOWN = "hourly_stats_aggregated_by_advertiser_time_zone";

/** Fields of the campaign hourly read. Meta returns no reach by hour, so none is asked for. */
export const META_ADS_HOURLY_FIELDS = "campaign_id,date_start,date_stop,spend,impressions,clicks,inline_link_clicks,account_currency";

/**
 * Fields of the AD hourly read (engine 0086): delivery plus actions[] / action_values[] and Meta's `results` per hour.
 * Meta's hourly breakdown excludes only unique_* fields, reach, frequency and video_* fields; actions, action_values
 * and results are allowed (each confirmed on a live level=ad hourly read, 2026-10-09: every row carried its ad set's
 * Results indicator). `results` is the ONLY place Meta reports a website trial (`conversions:start_trial_website`;
 * Graph v25 rejects start_trial_actions), so it is stored verbatim as the daily rows store it. Same call, one more
 * field: the request budget is unchanged. Ad set and campaign hours are sums of these ad rows.
 */
export const META_ADS_AD_HOURLY_FIELDS =
  "ad_id,adset_id,campaign_id,date_start,date_stop,spend,impressions,clicks,inline_link_clicks,actions,action_values,results,account_currency";

/** The longest window one hourly query may cover: today plus a restatement window. */
export const META_ADS_HOURLY_MAX_WINDOW_DAYS = 8;

/**
 * The account-local hour of a row, from Meta's bucket label ("13:00:00 - 13:59:59"); null when the label is not
 * one whole hour (refused upstream, never guessed).
 */
export function metaAdsHourFromBucket(label: unknown): number | null {
  if (typeof label !== "string") return null;
  const match = /^(\d{2}):00:00 - (\d{2}):59:59$/.exec(label.trim());
  if (!match || match[1] !== match[2]) return null;
  const hour = Number(match[1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/** Every day of an inclusive [since, until] window, oldest first. */
export function metaAdsWindowDayList(since: string, until: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${since}T00:00:00.000Z`);
  const end = Date.parse(`${until}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** The hour of the day (0-23) at `instant` on `timeZone`'s clock. */
export function metaAdsLocalHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(instant);
  return Number(hour);
}
