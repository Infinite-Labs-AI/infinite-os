import { canonicalMetaAdsJson } from "./meta-entity-fingerprint.js";
import { META_ADS_AD_LEAN_FIELDS, mergeMetaAdsLeanAds } from "./meta-lean-inventory.js";

/**
 * Transition-aware incremental inventory scans.
 *
 * An incremental scan reads ad sets and ads with `updated_since`, so it only sees children whose
 * OWN `updated_time` moved. Pausing or resuming a campaign or ad set changes its children's
 * `effective_status` (ACTIVE <-> CAMPAIGN_PAUSED / ADSET_PAUSED) without touching their
 * `updated_time`. Before this, those children kept the stale inherited status until the next daily
 * full read, so a resumed campaign's ads showed PAUSED for up to 24h while they were spending.
 *
 * What this does: when a scan sees a campaign or ad set whose own `status`/`effective_status`
 * differs from its stored current version, it re-reads that parent's children in the same run.
 * The read uses the lean field sets (no creative expansion, 500-row pages) on the parent's own
 * documented edges:
 *   - GET /{campaign_id}/adsets  https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/adsets/
 *   - GET /{campaign_id}/ads     https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/ads/
 *   - GET /{ad_set_id}/ads       https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/ads/
 * Each of those edges documents `effective_status` as a filter, and the scan passes the same
 * all-status list it uses on the account edges. The account edges (`/act_<id>/ads`,
 * `/act_<id>/adsets`) document only `effective_status`, `updated_since`, `date_preset` and
 * `time_range`. A `filtering` on `campaign.id`/`adset.id` is not documented there, so this code
 * does not rely on it.
 *
 * Writes are status-only. A child's stored snapshot (or this run's delta node) is kept, and only
 * `status` and `effective_status` come from the lean read. That is the same merge the lean daily
 * full read uses (mergeMetaAdsLeanAds): #76's shared-creative resolution stays, and #71's
 * fingerprint means a child whose status did not change mints nothing. Only children whose status
 * actually changed are returned.
 *
 * It is all or nothing. The refresh may not fit the run's remaining request budget, or it may meet
 * a child it cannot explain from storage or the delta (never stored, re-parented, renamed, swapped
 * creative). In both cases nothing from the refresh is applied. The caller then asks for the daily
 * full read on the next scan instead of skipping silently.
 *
 * When no parent changed, no plan is produced and the scan makes no extra calls.
 */

export const META_ADS_ADSET_LEAN_FIELDS = "id,name,campaign_id,effective_status,status";

/** Lean edge reads have no field expansion, so metaAdsReadEdge pages them 500 at a time. */
const LEAN_PAGE_SIZE = 500;

type EntityNode = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  effective_status?: string | null;
  campaign_id?: string | null;
  adset_id?: string | null;
  creative?: unknown;
};

function nodeId(node: EntityNode): string | null {
  return typeof node.id === "string" && node.id ? node.id : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Own status or delivery status differs. An absent field equals an explicit null. */
export function metaAdsStatusChanged(previous: EntityNode, next: EntityNode): boolean {
  return canonicalMetaAdsJson(previous.status ?? null) !== canonicalMetaAdsJson(next.status ?? null)
    || canonicalMetaAdsJson(previous.effective_status ?? null) !== canonicalMetaAdsJson(next.effective_status ?? null);
}

export interface MetaChildStatusRead {
  parentType: "campaign" | "adset";
  parentId: string;
  edge: "adsets" | "ads";
  fields: string;
  /** Pages expected from the stored child count (at least one). */
  estimatedRequests: number;
}

export interface MetaChildStatusRefreshPlan {
  changedCampaignIds: string[];
  changedAdsetIds: string[];
  reads: MetaChildStatusRead[];
  estimatedRequests: number;
}

/**
 * Find the parents whose own status changed in this scan, and the child reads that cover them.
 * `campaigns` is this scan's complete campaign read and `adsets` its `updated_since` delta. The
 * `stored*` arrays are the current stored versions. A parent with no stored version is new: its
 * children are new too, carry fresh `updated_time`s, and the delta reads them. Returns null when
 * no known parent changed.
 */
export function planMetaChildStatusRefresh(input: {
  campaigns: EntityNode[];
  adsets: EntityNode[];
  storedCampaigns: EntityNode[];
  storedAdsets: EntityNode[];
  storedAds: EntityNode[];
}): MetaChildStatusRefreshPlan | null {
  const byId = (nodes: EntityNode[]) => {
    const map = new Map<string, EntityNode>();
    for (const node of nodes) { const id = nodeId(node); if (id) map.set(id, node); }
    return map;
  };
  const storedCampaigns = byId(input.storedCampaigns);
  const storedAdsets = byId(input.storedAdsets);
  const changed = (fresh: EntityNode[], stored: Map<string, EntityNode>) => {
    const ids = new Set<string>();
    for (const node of fresh) {
      const id = nodeId(node);
      const previous = id ? stored.get(id) : undefined;
      if (id && previous && metaAdsStatusChanged(previous, node)) ids.add(id);
    }
    return [...ids].sort();
  };
  const changedCampaignIds = changed(input.campaigns, storedCampaigns);
  const changedAdsetIds = changed(input.adsets, storedAdsets);
  if (changedCampaignIds.length === 0 && changedAdsetIds.length === 0) return null;

  const campaignSet = new Set(changedCampaignIds);
  const freshAdsets = byId(input.adsets);
  const adsetCampaign = (id: string) => text(freshAdsets.get(id)?.campaign_id) ?? text(storedAdsets.get(id)?.campaign_id);
  const count = (nodes: EntityNode[], key: "campaign_id" | "adset_id", parentId: string) =>
    nodes.reduce((total, node) => total + (text(node[key]) === parentId ? 1 : 0), 0);
  const pages = (children: number) => Math.max(1, Math.ceil(children / LEAN_PAGE_SIZE));

  const reads: MetaChildStatusRead[] = [];
  for (const campaignId of changedCampaignIds) {
    reads.push({ parentType: "campaign", parentId: campaignId, edge: "adsets", fields: META_ADS_ADSET_LEAN_FIELDS,
      estimatedRequests: pages(count(input.storedAdsets, "campaign_id", campaignId)) });
    reads.push({ parentType: "campaign", parentId: campaignId, edge: "ads", fields: META_ADS_AD_LEAN_FIELDS,
      estimatedRequests: pages(count(input.storedAds, "campaign_id", campaignId)) });
  }
  for (const adsetId of changedAdsetIds) {
    // The campaign's /ads read already covers an ad set under a changed campaign.
    const campaignId = adsetCampaign(adsetId);
    if (campaignId && campaignSet.has(campaignId)) continue;
    reads.push({ parentType: "adset", parentId: adsetId, edge: "ads", fields: META_ADS_AD_LEAN_FIELDS,
      estimatedRequests: pages(count(input.storedAds, "adset_id", adsetId)) });
  }
  return {
    changedCampaignIds,
    changedAdsetIds,
    reads,
    estimatedRequests: reads.reduce((total, read) => total + read.estimatedRequests, 0),
  };
}

export type MetaChildStatusFullReadReason =
  | "request_budget" | "request_budget_exhausted" | "unknown_adset" | "adset_fields_changed"
  | "unknown_ad" | "creative_changed" | "fields_changed";

export type MetaChildStatusRefreshOutcome<N> =
  | { kind: "applied"; plan: MetaChildStatusRefreshPlan; adsets: N[]; ads: N[] }
  | { kind: "full_read_required"; plan: MetaChildStatusRefreshPlan; reason: MetaChildStatusFullReadReason; entityId?: string };

/**
 * Status-only merge for ad sets. The lean read supplies status. The base is this run's delta node,
 * or else the stored current version. Identity fields must agree: a rename or re-parent the delta
 * missed cannot be patched from a lean read.
 */
export function mergeMetaAdsLeanAdsets<N extends EntityNode>(input: { lean: N[]; delta: N[]; stored: N[] }):
  | { kind: "merged"; nodes: N[] }
  | { kind: "needs_full"; reason: "unknown_adset" | "adset_fields_changed"; entityId: string } {
  const deltaById = new Map<string, N>();
  for (const node of input.delta) { const id = nodeId(node); if (id) deltaById.set(id, node); }
  const storedById = new Map<string, N>();
  for (const node of input.stored) { const id = nodeId(node); if (id) storedById.set(id, node); }
  const nodes: N[] = [];
  for (const lean of input.lean) {
    const id = nodeId(lean);
    if (!id) continue;
    const base = deltaById.get(id) ?? storedById.get(id);
    if (!base) return { kind: "needs_full", reason: "unknown_adset", entityId: id };
    for (const key of ["name", "campaign_id"] as const) {
      if (canonicalMetaAdsJson(lean[key]) !== canonicalMetaAdsJson(base[key])) {
        return { kind: "needs_full", reason: "adset_fields_changed", entityId: id };
      }
    }
    const merged: Record<string, unknown> = { ...base };
    for (const key of ["status", "effective_status"] as const) {
      // Graph omits empty fields: absent in the lean read means absent now.
      const value = lean[key];
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    nodes.push(merged as N);
  }
  return { kind: "merged", nodes };
}

/**
 * Run a refresh plan. `readChildren` is the paginated parent-edge reader. It goes through the
 * run's request telemetry, so every page is budgeted and counted. Returns only the children whose
 * status changed, merged onto their base (delta node, else stored version). The caller replaces a
 * delta node with its merged form, or appends a stored-based one, so no entity gets two rows in
 * one run.
 */
export async function runMetaChildStatusRefresh<N extends EntityNode>(input: {
  plan: MetaChildStatusRefreshPlan;
  remainingRequests: number;
  readChildren: (read: MetaChildStatusRead) => Promise<N[]>;
  /** Current stored creative versions, for #76's shared-creative resolution. Loaded only here. */
  loadStoredCreatives: () => Promise<Array<Record<string, unknown>>>;
  normalize: (node: N) => N;
  deltaAdsets: N[];
  deltaAds: N[];
  storedAdsets: N[];
  storedAds: N[];
  isBudgetError: (error: unknown) => boolean;
}): Promise<MetaChildStatusRefreshOutcome<N>> {
  const { plan } = input;
  if (plan.estimatedRequests > input.remainingRequests) {
    return { kind: "full_read_required", plan, reason: "request_budget" };
  }
  const leanAdsets = new Map<string, N>();
  const leanAds = new Map<string, N>();
  for (const read of plan.reads) {
    let nodes: N[];
    try {
      nodes = await input.readChildren(read);
    } catch (error) {
      // The estimate came from stored counts, and the parent can have more children now. Nothing
      // from the refresh has been applied, so let the next scan do the full read.
      if (input.isBudgetError(error)) return { kind: "full_read_required", plan, reason: "request_budget_exhausted" };
      throw error;
    }
    for (const raw of nodes) {
      const node = input.normalize(raw);
      const id = nodeId(node);
      if (!id) continue;
      (read.edge === "adsets" ? leanAdsets : leanAds).set(id, node);
    }
  }
  const deltaAdsets = input.deltaAdsets.map(input.normalize);
  const deltaAds = input.deltaAds.map(input.normalize);
  const baseOf = (delta: N[], stored: N[]) => {
    const map = new Map<string, N>();
    for (const node of stored) { const id = nodeId(node); if (id) map.set(id, node); }
    for (const node of delta) { const id = nodeId(node); if (id) map.set(id, node); }
    return map;
  };
  const statusMoved = (nodes: N[], bases: Map<string, N>) =>
    nodes.filter((node) => { const base = bases.get(nodeId(node) ?? ""); return !base || metaAdsStatusChanged(base, node); });

  const adsetMerge = mergeMetaAdsLeanAdsets({ lean: [...leanAdsets.values()], delta: deltaAdsets, stored: input.storedAdsets });
  if (adsetMerge.kind === "needs_full") {
    return { kind: "full_read_required", plan, reason: adsetMerge.reason, entityId: adsetMerge.entityId };
  }
  let ads: N[] = [];
  if (leanAds.size > 0) {
    const adMerge = mergeMetaAdsLeanAds({
      lean: [...leanAds.values()],
      delta: deltaAds,
      stored: input.storedAds,
      storedCreatives: await input.loadStoredCreatives(),
    });
    if (adMerge.kind === "needs_full") {
      return { kind: "full_read_required", plan, reason: adMerge.reason, entityId: adMerge.entityId };
    }
    ads = statusMoved(adMerge.nodes, baseOf(deltaAds, input.storedAds));
  }
  return {
    kind: "applied",
    plan,
    adsets: statusMoved(adsetMerge.nodes, baseOf(deltaAdsets, input.storedAdsets)),
    ads,
  };
}
