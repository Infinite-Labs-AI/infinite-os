/**
 * Meta Ads EXTENDED READS: video watch fields, the ad set's learning stage and a weekly ad set
 * breakdown, all behind ONE caller-owned switch (`SyncRequest.metaAdsExtendedReads`) that ships OFF.
 *
 * WHY (Ad Brain decision 2, approved by the founder 2026-09-29, "one probe first, settled days only,
 * with an off switch"): the Ad Brain's Step 0 needs to know whether an ad set is still learning, and
 * its fatigue check needs video watch depth. Both ride requests the sync ALREADY makes:
 *  - the video fields ride the settled/backfill insights reads (no new call);
 *  - `learning_stage_info` rides the ad set edge read of an inventory/settled/backfill scan (no new call);
 *  - the breakdown is the only new call, ONE dimension per query, made by a separate entry point
 *    the caller schedules at most once per account per settled week and pays for out of its OWN
 *    share of the per-account request budget.
 *
 * SWITCH OFF (unset, or false) = every request and every stored row is byte-identical to before.
 * The switch never widens a request on the hot open-day lane, the attended Live refresh, the live
 * insights reader or the MCP/CLI transports, and never on a window that reaches today in the
 * account's own timezone (settled days only).
 *
 * This file is pure (no I/O); the requests and writes live in index.ts next to the reads they ride.
 */

/**
 * The video watch fields added to a settled/backfill insights read when the switch is on. Each is a
 * top-level list shaped like actions[] ({action_type, value, <attribution windows>}); Meta OMITS a
 * list when there was nothing to report (an image ad), so a requested-but-absent list is stored as
 * [] (measured none). `video_avg_time_watched_actions` is an AVERAGE per play: a reader weights it by
 * `video_play_actions` and never sums it across days or ads.
 *
 * The base insights field list (META_ADS_INSIGHTS_FIELDS in index.ts) is NOT changed: these are
 * appended only on the lanes below. One rejected field fails the WHOLE request, which is why the
 * one-shot probe (probeMetaAdsExtendedReads) must be run and read before any source is switched on.
 */
export const META_ADS_EXTENDED_INSIGHTS_FIELDS: readonly string[] = [
  "video_play_actions",
  "video_thruplay_watched_actions",
  "video_avg_time_watched_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p95_watched_actions",
  "video_p100_watched_actions",
];

/** The ad set field that carries Meta's learning phase ({status, conversions, last_sig_edit_ts, attribution_windows}). */
export const META_ADS_LEARNING_STAGE_FIELD = "learning_stage_info";

/** Insights lanes that may carry the video fields: settled days only, never the hot/attended/media lanes. */
export const META_ADS_EXTENDED_INSIGHTS_LANES: ReadonlySet<string> = new Set(["settled_history", "history_backfill"]);

/** Entity-scan lanes whose ad set edge read may carry `learning_stage_info` (0 extra calls). */
export const META_ADS_LEARNING_STAGE_LANES: ReadonlySet<string> = new Set(["inventory_sync", "settled_history", "history_backfill"]);

/**
 * The weekly breakdown dimensions, ONE per query. `platform_position` is deliberately absent: it is
 * only valid combined with `publisher_platform` (two dimensions in one query), and at our volume the
 * extra split is noise (plan decision F).
 */
export const META_ADS_BREAKDOWN_DIMENSIONS = ["device_platform", "publisher_platform"] as const;
export type MetaAdsBreakdownDimension = (typeof META_ADS_BREAKDOWN_DIMENSIONS)[number];

/** The longest window one all_days breakdown query may cover (a settled week is 7; a month is the ceiling). */
export const META_ADS_BREAKDOWN_MAX_WINDOW_DAYS = 31;

/** The probe's hard ceiling: insights + ad set learning + one breakdown. */
export const META_ADS_EXTENDED_READS_PROBE_MAX_REQUESTS = 3;

export function isMetaAdsBreakdownDimension(value: unknown): value is MetaAdsBreakdownDimension {
  return typeof value === "string" && (META_ADS_BREAKDOWN_DIMENSIONS as readonly string[]).includes(value);
}

/** The switch is on only for an explicit `true` on a settled insights lane. */
export function metaAdsExtendedInsightsLane(switchOn: boolean | undefined, lane: string | undefined): boolean {
  return switchOn === true && lane !== undefined && META_ADS_EXTENDED_INSIGHTS_LANES.has(lane);
}

/** The switch is on only for an explicit `true` on an entity-scan lane. */
export function metaAdsLearningStageLane(switchOn: boolean | undefined, lane: string | undefined): boolean {
  return switchOn === true && lane !== undefined && META_ADS_LEARNING_STAGE_LANES.has(lane);
}

/** The extended field suffix appended to a grain's insights field list. */
export function metaAdsExtendedInsightsFieldSuffix(): string {
  return META_ADS_EXTENDED_INSIGHTS_FIELDS.join(",");
}

/**
 * The video keys stored in `actions_raw` for a row whose read REQUESTED them: Meta's list verbatim,
 * or [] when Meta omitted it (measured none). A row read without the switch gets NO video key at all,
 * which is how a reader tells "not requested" (unknown) from "none".
 */
export function metaAdsVideoActionsRaw(row: Record<string, unknown>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const field of META_ADS_EXTENDED_INSIGHTS_FIELDS) {
    const value = row[field];
    out[field] = Array.isArray(value) ? value : [];
  }
  return out;
}

/** One ad set's learning stage as Meta reported it on one entity read. */
export interface MetaAdsLearningObservation {
  adsetId: string;
  /** Meta's word as returned (LEARNING | SUCCESS | FAIL); null when Meta returned no learning stage for this ad set. */
  status: string | null;
  /** Meta's count of optimisation events toward leaving learning; null when absent. */
  conversions: number | null;
  /** Meta's last significant edit time (unix seconds → ISO); null when absent. */
  lastSigEditAt: string | null;
  attributionWindows: unknown[] | null;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function learningObservation(adsetId: string, info: unknown): MetaAdsLearningObservation {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return { adsetId, status: null, conversions: null, lastSigEditAt: null, attributionWindows: null };
  }
  const record = info as Record<string, unknown>;
  const status = typeof record.status === "string" && record.status.trim() !== "" ? record.status : null;
  const seconds = finiteNumberOrNull(record.last_sig_edit_ts);
  const lastSigEditAt = seconds !== null && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
  return {
    adsetId,
    status,
    conversions: finiteNumberOrNull(record.conversions),
    lastSigEditAt,
    attributionWindows: Array.isArray(record.attribution_windows) ? record.attribution_windows : null,
  };
}

/**
 * Split `learning_stage_info` OFF each ad set node before the node reaches the entity snapshot.
 *
 * The learning stage changes as delivery accrues (conversions tick up, status flips), so leaving it
 * on the node would mint a new `meta_ads_entity_versions` row on nearly every scan and flood the
 * edit history the Ad Brain reads as "recent significant edits". It is stored instead as its own
 * observation (engine migration 0079). Every node is returned WITHOUT the key; `observations` has one
 * entry per ad set when `requested` (status null when Meta returned none) and is empty otherwise.
 */
export function metaAdsSplitLearningStage<Node extends { id?: string | null }>(
  nodes: readonly Node[],
  requested: boolean,
): { nodes: Node[]; observations: MetaAdsLearningObservation[] } {
  const stripped: Node[] = [];
  const observations: MetaAdsLearningObservation[] = [];
  for (const node of nodes) {
    const { [META_ADS_LEARNING_STAGE_FIELD]: info, ...rest } = node as Node & Record<string, unknown>;
    stripped.push(rest as unknown as Node);
    const adsetId = typeof node.id === "string" && node.id !== "" ? node.id : null;
    if (requested && adsetId) observations.push(learningObservation(adsetId, info));
  }
  return { nodes: stripped, observations };
}

/** Inclusive day span of a [since, until] window, or null when malformed. */
export function metaAdsWindowDays(since: string, until: string): number | null {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(since) || !pattern.test(until)) return null;
  const start = Date.parse(`${since}T00:00:00.000Z`);
  const end = Date.parse(`${until}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}
