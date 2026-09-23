import { createHash } from "node:crypto";

import { canonicalMetaAdsJson } from "./meta-entity-fingerprint.js";

/**
 * Leaner Meta inventory reads.
 *
 * 1. Graph pagination: every non-empty Graph edge page carries `paging.cursors.after`, INCLUDING
 *    the last one. Only `paging.next` says another page exists ("If not included, this is the last
 *    page of data"). Following `cursors.after` alone costs one extra, empty request per edge read —
 *    which is why a 25-campaign account paid 2 campaign calls per scan.
 *
 * 2. The daily full ad read. The heavy ad field set carries the `creative{…}` expansion, which forces
 *    100-row pages, and archived ads never leave the edge, so the full read's cost grew with account
 *    age. The lean full read keeps the COMPLETE snapshot (every ad on the edge, archived included —
 *    so disappearance and ARCHIVED/PAUSED status stay exact) but reads it WITHOUT the expansion
 *    (500-row pages), and sources the expansion from:
 *      - a heavy `updated_since` delta read for ads that changed since the last committed scan
 *        (the same read an incremental scan does), and
 *      - the stored current version for every other ad.
 *    An ad's stored expansion is reused only when the lean read proves it is still the same ad: same
 *    creative id and same non-status fields. Status (`status`, `effective_status`) is always taken
 *    from the lean read — that is how an inherited ACTIVE→ARCHIVED/CAMPAIGN_PAUSED transition, which
 *    does not touch the ad's own `updated_time`, is still recorded. Anything unexplained (an ad the
 *    delta did not return and we have never stored, a swapped creative id, a renamed/re-parented ad
 *    the delta missed) falls back to the heavy full read, i.e. exactly the previous behavior.
 *    AdCreatives are immutable apart from name/status (see meta-entity-fingerprint.ts), so the only
 *    thing the lean read cannot see is a creative RENAME; a heavy full read at least every
 *    META_ADS_HEAVY_RECONCILE_MAX_AGE_MS (and whenever the heavy field set changes) bounds that.
 */

/** The heavy ad field set: the full entity snapshot including the creative expansion. */
export const META_ADS_AD_FULL_FIELDS =
  "id,name,creative{id,name,title,body,thumbnail_url,image_url,image_hash,video_id,call_to_action_type,object_story_spec,asset_feed_spec},adset_id,campaign_id,effective_status,status,bid_amount,tracking_specs,conversion_specs";

/**
 * The lean ad field set: identity, parentage, creative REFERENCE (Graph returns `{id}` for a
 * reference field requested without sub-fields — no expansion, so 500-row pages) and status.
 */
export const META_ADS_AD_LEAN_FIELDS = "id,name,creative,adset_id,campaign_id,effective_status,status";

const LEAN_KEYS = ["id", "name", "adset_id", "campaign_id", "effective_status", "status"] as const;
const STATUS_KEYS: ReadonlySet<string> = new Set(["effective_status", "status"]);

/** A heavy (expansion-bearing) full ad read is forced at least this often. */
export const META_ADS_HEAVY_RECONCILE_MAX_AGE_MS = 7 * 86_400_000;

/** Same boundary/eventual-consistency overlap metaEntityReadMode uses for incremental scans. */
const DELTA_OVERLAP_SECONDS = 300;

export function metaAdsHeavyCursorKey(adAccountId: string): string {
  return `meta_ads_entities_heavy:${adAccountId}`;
}

/** Identifies the heavy ad field set, so a field-set change forces one heavy re-read. */
export function metaAdsHeavyAdFieldsKey(fields: string = META_ADS_AD_FULL_FIELDS): string {
  return createHash("sha256").update(fields).digest("hex").slice(0, 16);
}

/** Cursor value: `<scan startedAt ISO>|<heavy field-set key>` (ISO first keeps `greatest()` ordering). */
export function metaAdsHeavyCursorValue(startedAt: string, fieldsKey: string = metaAdsHeavyAdFieldsKey()): string {
  return `${startedAt}|${fieldsKey}`;
}

export type MetaAdsFullAdReadPlan =
  | { lean: true; updatedSince: number }
  | { lean: false; reason: "no_scan_checkpoint" | "no_heavy_checkpoint" | "heavy_fields_changed" | "heavy_reconcile_due" };

/**
 * Decide how a FULL scan reads the ad edge. Lean needs (a) a committed scan checkpoint, whose start
 * bounds the delta read so every ad changed since the stored versions were written is re-read
 * heavy, and (b) a recent heavy full read with the current field set.
 */
export function metaAdsFullAdReadPlan(input: {
  scanCheckpoint: string | null;
  heavyCheckpoint: string | null;
  now: Date;
}): MetaAdsFullAdReadPlan {
  const at = input.now.getTime();
  const scan = input.scanCheckpoint ? Date.parse(input.scanCheckpoint) : NaN;
  if (!Number.isFinite(scan) || scan > at) return { lean: false, reason: "no_scan_checkpoint" };
  const separator = input.heavyCheckpoint?.lastIndexOf("|") ?? -1;
  if (!input.heavyCheckpoint || separator < 0) return { lean: false, reason: "no_heavy_checkpoint" };
  const heavyAt = Date.parse(input.heavyCheckpoint.slice(0, separator));
  if (!Number.isFinite(heavyAt) || heavyAt > at) return { lean: false, reason: "no_heavy_checkpoint" };
  if (input.heavyCheckpoint.slice(separator + 1) !== metaAdsHeavyAdFieldsKey()) {
    return { lean: false, reason: "heavy_fields_changed" };
  }
  if (at - heavyAt >= META_ADS_HEAVY_RECONCILE_MAX_AGE_MS) return { lean: false, reason: "heavy_reconcile_due" };
  return { lean: true, updatedSince: Math.max(0, Math.floor(scan / 1000) - DELTA_OVERLAP_SECONDS) };
}

type AdNode = Record<string, unknown> & { id?: string | null; creative?: unknown };

function nodeId(node: AdNode): string | null {
  return typeof node.id === "string" && node.id ? node.id : null;
}

function creativeId(node: AdNode): string | null {
  const creative = node.creative;
  if (!creative || typeof creative !== "object" || Array.isArray(creative)) return null;
  const id = (creative as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

export type MetaAdsLeanMergeResult<N extends AdNode> =
  | { kind: "merged"; nodes: N[] }
  | { kind: "needs_full"; reason: "unknown_ad" | "creative_changed" | "fields_changed"; entityId: string };

/**
 * Rebuild the full ad snapshot from a lean read. The LEAN read is the membership + status truth
 * (only ids it returned are in the snapshot, so a vanished ad is still closed at CLOSE); the heavy
 * base for each id is the fresh delta node, else the stored current version.
 */
export function mergeMetaAdsLeanAds<N extends AdNode>(input: { lean: N[]; delta: N[]; stored: N[] }): MetaAdsLeanMergeResult<N> {
  const deltaById = new Map<string, N>();
  for (const node of input.delta) { const id = nodeId(node); if (id) deltaById.set(id, node); }
  const storedById = new Map<string, N>();
  for (const node of input.stored) { const id = nodeId(node); if (id) storedById.set(id, node); }
  const nodes: N[] = [];
  for (const lean of input.lean) {
    const id = nodeId(lean);
    if (!id) continue;
    const base = deltaById.get(id) ?? storedById.get(id);
    if (!base) return { kind: "needs_full", reason: "unknown_ad", entityId: id };
    if (creativeId(lean) !== creativeId(base)) return { kind: "needs_full", reason: "creative_changed", entityId: id };
    for (const key of LEAN_KEYS) {
      if (STATUS_KEYS.has(key)) continue;
      if (canonicalMetaAdsJson(lean[key]) !== canonicalMetaAdsJson(base[key])) {
        return { kind: "needs_full", reason: "fields_changed", entityId: id };
      }
    }
    const merged: Record<string, unknown> = { ...base };
    for (const key of STATUS_KEYS) {
      // Graph omits empty fields: an absent status in the lean read is absent now, not "unchanged".
      if (lean[key] === undefined) delete merged[key];
      else merged[key] = lean[key];
    }
    nodes.push(merged as N);
  }
  return { kind: "merged", nodes };
}

/**
 * The full-scan ad read. `readEdge` is the paginated /ads edge reader; `withMedia` marks the reads
 * whose pages carry the creative expansion (fresh media URLs) for the caller's media hand-off.
 */
export async function readMetaAdsFullAdSnapshot<N extends AdNode>(input: {
  plan: MetaAdsFullAdReadPlan;
  loadStored: () => Promise<N[]>;
  readEdge: (fields: string, updatedSince: number | undefined, withMedia: boolean) => Promise<N[]>;
  normalize: (node: N) => N;
}): Promise<{ nodes: N[]; heavy: boolean; fallback?: string }> {
  const heavy = async (fallback?: string) => ({
    nodes: await input.readEdge(META_ADS_AD_FULL_FIELDS, undefined, true),
    heavy: true,
    ...(fallback ? { fallback } : {}),
  });
  if (!input.plan.lean) return heavy(input.plan.reason);
  const stored = await input.loadStored();
  if (stored.length === 0) return heavy("no_stored_ads");
  // Delta first, then the lean snapshot: the snapshot is the later observation of membership and
  // status, and any change between the two reads is re-read by the next scan's overlap window.
  const delta = await input.readEdge(META_ADS_AD_FULL_FIELDS, input.plan.updatedSince, true);
  const lean = await input.readEdge(META_ADS_AD_LEAN_FIELDS, undefined, false);
  const merged = mergeMetaAdsLeanAds({
    lean: lean.map(input.normalize),
    delta: delta.map(input.normalize),
    stored,
  });
  if (merged.kind === "needs_full") return heavy(merged.reason);
  return { nodes: merged.nodes, heavy: false };
}

/** Graph page continuation: `after` only when `paging.next` says another page exists. */
export type MetaGraphNextPage = { kind: "last" } | { kind: "next"; after: string } | { kind: "malformed" };

export function metaGraphNextPage(paging: { next?: string | null; cursors?: { after?: string | null } | null } | null | undefined): MetaGraphNextPage {
  if (!paging?.next) return { kind: "last" };
  const after = paging.cursors?.after;
  if (after) return { kind: "next", after };
  try {
    const fromNext = new URL(paging.next).searchParams.get("after");
    return fromNext ? { kind: "next", after: fromNext } : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}
