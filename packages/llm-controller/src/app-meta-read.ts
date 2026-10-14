/**
 * The app's stored Meta read a desktop turn carries, by the name that desktop gives it: get_ads_performance (one read
 * for every ad channel, 1bu-1 desktop Cmd+L round 2) or get_meta_performance (the desktops before it, v0.4.12 and
 * earlier). The engine keys its Meta twin, prompt filters and routing lines on either, and names the one the turn has.
 */
export const APP_META_READS = ["get_ads_performance", "get_meta_performance"] as const;
export type AppMetaRead = (typeof APP_META_READS)[number];

/** The app's Meta read this turn carries, or undefined when it carries neither. */
export function appMetaRead(has: (name: string) => boolean): AppMetaRead | undefined {
  return APP_META_READS.find((name) => has(name));
}

/**
 * The read with its period input, as a routing line names it: get_meta_performance takes a structured `period`
 * object; get_ads_performance takes a `period` word (today, last_7d, ...) that applies to each channel.
 */
export function appMetaReadWithPeriod(read: AppMetaRead): string {
  return read === "get_ads_performance" ? "get_ads_performance with a `period`" : "get_meta_performance with a structured `period`";
}
