import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { connectorFor, type SyncRequest } from "./index.js";
import {
  META_ADS_ADSET_LEAN_FIELDS,
  planMetaChildStatusRefresh,
  runMetaChildStatusRefresh,
} from "./meta-child-status-refresh.js";
import { META_ADS_AD_LEAN_FIELDS } from "./meta-lean-inventory.js";

const KEY = "meta-child-status-encryption-key";
const ACCOUNT = "act_888";
const OLD = "2026-01-01T00:00:00+0000";

describe("planMetaChildStatusRefresh", () => {
  const campaign = { id: "c1", status: "ACTIVE", effective_status: "ACTIVE" };
  const adset = { id: "s1", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE" };
  const ads = Array.from({ length: 1200 }, (_, i) => ({ id: `a${i}`, adset_id: i < 10 ? "s1" : "s2", campaign_id: "c1" }));

  it("plans nothing when no stored parent changed status (new parents are covered by the delta)", () => {
    expect(planMetaChildStatusRefresh({ campaigns: [campaign], adsets: [adset], storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads })).toBeNull();
    expect(planMetaChildStatusRefresh({
      campaigns: [{ ...campaign, id: "c_new", status: "PAUSED" }], adsets: [{ ...adset, id: "s_new", status: "PAUSED" }],
      storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads,
    })).toBeNull();
    // A non-status change is the delta's job, not a transition.
    expect(planMetaChildStatusRefresh({ campaigns: [{ ...campaign, name: "Renamed" }], adsets: [], storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads })).toBeNull();
  });

  it("reads ad sets + ads under a changed campaign, and ads under a changed ad set, sized by stored children", () => {
    const plan = planMetaChildStatusRefresh({
      campaigns: [{ ...campaign, effective_status: "PAUSED", status: "PAUSED" }],
      adsets: [], storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads,
    });
    expect(plan).toEqual({
      changedCampaignIds: ["c1"], changedAdsetIds: [], estimatedRequests: 4,
      reads: [
        { parentType: "campaign", parentId: "c1", edge: "adsets", fields: META_ADS_ADSET_LEAN_FIELDS, estimatedRequests: 1 },
        // 1,200 stored ads at 500 per lean page.
        { parentType: "campaign", parentId: "c1", edge: "ads", fields: META_ADS_AD_LEAN_FIELDS, estimatedRequests: 3 },
      ],
    });
    expect(planMetaChildStatusRefresh({
      campaigns: [campaign], adsets: [{ ...adset, status: "PAUSED", effective_status: "PAUSED" }],
      storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads,
    })?.reads).toEqual([{ parentType: "adset", parentId: "s1", edge: "ads", fields: META_ADS_AD_LEAN_FIELDS, estimatedRequests: 1 }]);
  });

  it("skips an ad set's own read when its campaign's /ads read already covers it", () => {
    const plan = planMetaChildStatusRefresh({
      campaigns: [{ ...campaign, status: "PAUSED", effective_status: "PAUSED" }],
      adsets: [{ ...adset, status: "PAUSED", effective_status: "PAUSED" }],
      storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads,
    });
    expect(plan?.changedAdsetIds).toEqual(["s1"]);
    expect(plan?.reads.map((read) => `${read.parentId}/${read.edge}`)).toEqual(["c1/adsets", "c1/ads"]);
  });

  it("returns full_read_required (and applies nothing) when a child read runs out of budget", async () => {
    type Loose = { id: string; campaign_id?: string; adset_id?: string; status?: string; effective_status?: string };
    const plan = planMetaChildStatusRefresh({
      campaigns: [{ ...campaign, status: "PAUSED", effective_status: "PAUSED" }],
      adsets: [], storedCampaigns: [campaign], storedAdsets: [adset], storedAds: ads,
    })!;
    const budgetError = new Error("budget");
    let reads = 0;
    const outcome = await runMetaChildStatusRefresh<Loose>({
      plan, remainingRequests: 10,
      readChildren: async () => { reads += 1; if (reads === 2) throw budgetError; return [{ ...adset, effective_status: "CAMPAIGN_PAUSED" }]; },
      loadStoredCreatives: async () => [], normalize: (node) => node,
      deltaAdsets: [], deltaAds: [], storedAdsets: [adset], storedAds: ads,
      isBudgetError: (error) => error === budgetError,
    });
    expect(outcome).toEqual({ kind: "full_read_required", plan, reason: "request_budget_exhausted" });
    // A plan larger than the remaining budget never calls Meta.
    const refused = await runMetaChildStatusRefresh<Loose>({
      plan, remainingRequests: 3,
      readChildren: async () => { throw new Error("must not read"); },
      loadStoredCreatives: async () => [], normalize: (node) => node,
      deltaAdsets: [], deltaAds: [], storedAdsets: [adset], storedAds: ads, isBudgetError: () => false,
    });
    expect(refused).toEqual({ kind: "full_read_required", plan, reason: "request_budget" });
  });
});

type Node = Record<string, unknown> & { id: string; updated_time: string };
type Account = { campaigns: Node[]; adsets: Node[]; ads: Node[] };
type EdgeRequest = { owner: string; edge: string; fields: string; limit: number; updatedSince: number | null };

function topLevelFields(fields: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const char of fields) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "," && depth === 0) { out.push(current); current = ""; continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** Graph projection: requested fields only; a bare reference field returns `{id}`. */
function project(node: Node, fields: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of topLevelFields(fields)) {
    const name = field.split("{")[0]!;
    const value = node[name];
    if (value === undefined) continue;
    out[name] = !field.includes("{") && value && typeof value === "object" && !Array.isArray(value)
      ? { id: (value as Record<string, unknown>).id }
      : value;
  }
  return out;
}

/** A Graph edge (account-level or a parent's own edge) that filters, pages and signals `next` like Meta. */
function graphEdgePage(nodes: Node[], url: URL): Response {
  const statuses = JSON.parse(url.searchParams.get("effective_status") ?? "null") as string[] | null;
  const since = url.searchParams.get("updated_since");
  const matching = nodes.filter((node) =>
    (!statuses || statuses.includes(String(node.effective_status)))
    && (since === null || Date.parse(node.updated_time) / 1000 >= Number(since)));
  const limit = Number(url.searchParams.get("limit") ?? "25");
  const offset = Number(url.searchParams.get("after") ?? "0");
  const page = matching.slice(offset, offset + limit).map((node) => project(node, url.searchParams.get("fields") ?? "id"));
  const end = offset + page.length;
  const paging = page.length === 0 ? undefined : {
    cursors: { before: String(offset), after: String(end) },
    ...(end < matching.length ? { next: `https://graph.facebook.com/v25.0/x/y?after=${end}` } : {}),
  };
  return new Response(JSON.stringify({ data: page, ...(paging ? { paging } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
}

/** ~Chargerless 1 shape with consistent parentage: 25 campaigns, 222 ad sets, 460 ads. */
function account(): Account {
  const campaigns: Node[] = Array.from({ length: 25 }, (_, i) => {
    const status = i < 7 ? "ARCHIVED" : "ACTIVE";
    return { id: `c${i}`, name: `Campaign ${i}`, objective: "OUTCOME_SALES", status, effective_status: status, updated_time: OLD };
  });
  const adsets: Node[] = Array.from({ length: 222 }, (_, i) => {
    const status = i < 12 ? "ARCHIVED" : "ACTIVE";
    return { id: `s${i}`, campaign_id: `c${7 + (i % 18)}`, name: `Ad set ${i}`, optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", status, effective_status: status, updated_time: OLD };
  });
  const ads: Node[] = Array.from({ length: 460 }, (_, i) => {
    const status = i < 45 ? "ARCHIVED" : "ACTIVE";
    const adset = adsets[12 + (i % 210)]!;
    return {
      id: `a${i}`, name: `Ad ${i}`, adset_id: adset.id, campaign_id: adset.campaign_id,
      status, effective_status: status, updated_time: OLD,
      creative: { id: `cr${i}`, title: `Hook ${i}`, body: `Body ${i}`, image_hash: `hash${i}`, thumbnail_url: `https://scontent.xx.fbcdn.net/t${i}.jpg?oh=signed` },
    };
  });
  return { campaigns, adsets, ads };
}

/** Set a campaign's own status and its children's inherited delivery status (their updated_time does not move). */
function setCampaign(acct: Account, campaignId: string, status: "ACTIVE" | "PAUSED"): void {
  Object.assign(acct.campaigns.find((c) => c.id === campaignId)!, { status, effective_status: status, updated_time: new Date().toISOString() });
  for (const child of [...acct.adsets, ...acct.ads]) {
    if (child.campaign_id !== campaignId || child.effective_status === "ARCHIVED") continue;
    child.effective_status = status === "PAUSED" ? "CAMPAIGN_PAUSED" : "ACTIVE";
  }
}

describe("transition-aware incremental inventory scans against real PGlite", () => {
  let dataDir: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-meta-child-status-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedSource(): Promise<{ workspaceId: string; sourceId: string }> {
    const workspaceId = `ws_child_${randomUUID()}`, sourceId = `src_child_${randomUUID()}`;
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const datasets = await db.query<{ id: string }>("select id from datasets where workspace_id = $1 and key = 'web'", [workspaceId]);
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1,$2,$3,'meta_ads','Meta child status',$4,'connected')`,
      [sourceId, workspaceId, datasets[0]!.id, ACCOUNT],
    );
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'marketing_api_access_token',$4)`,
      [`cred_${randomUUID()}`, workspaceId, sourceId, encryptCredentialPayload(
        { mode: "live", transport: "meta_ads_cli", adAccountId: ACCOUNT, accessToken: "test-token", apiVersion: "v25.0" }, KEY)],
    );
    return { workspaceId, sourceId };
  }

  type Telemetry = { byKind: Record<string, number>; requestCount: number; fullAdRead?: unknown; childStatusRefresh?: Record<string, unknown> };
  async function scan(acct: Account, ids: { workspaceId: string; sourceId: string }, budget = 300): Promise<Telemetry & { edges: EdgeRequest[] }> {
    const edges: EdgeRequest[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const headers = { "content-type": "application/json", "x-fb-ads-insights-throttle": JSON.stringify({ acc_id_util_pct: 5 }) };
      const [, , owner = "", edge = ""] = url.pathname.split("/");
      if (owner === ACCOUNT && !edge) {
        return new Response(JSON.stringify({ id: ACCOUNT, account_id: "888", currency: "USD", timezone_name: "America/New_York" }), { status: 200, headers });
      }
      if (edge === "campaigns" || edge === "adsets" || edge === "ads") {
        edges.push({
          owner, edge, fields: url.searchParams.get("fields") ?? "", limit: Number(url.searchParams.get("limit")),
          updatedSince: url.searchParams.has("updated_since") ? Number(url.searchParams.get("updated_since")) : null,
        });
        const all = acct[edge];
        const scoped = owner === ACCOUNT ? all
          : owner.startsWith("c") ? all.filter((node) => node.campaign_id === owner)
            : all.filter((node) => node.adset_id === owner);
        return graphEdgePage(scoped, url);
      }
      throw new Error(`unexpected Meta URL ${url.toString()}`);
    }) as typeof fetch;
    const syncRunId = `sync_${randomUUID()}`;
    try {
      await connectorFor("meta_ads").sync(db, {
        ...ids, provider: "meta_ads", syncRunId, encryptionKey: KEY,
        windowSince: "2026-09-22", windowUntil: "2026-09-22", metaAdsRequestBudget: budget, metaAdsSyncMode: "inventory_only",
      } satisfies SyncRequest);
    } finally {
      globalThis.fetch = original;
    }
    const [run] = await db.query<{ status: string; request_telemetry: Telemetry }>("select status, request_telemetry from sync_runs where id=$1", [syncRunId]);
    expect(run?.status).toBe("succeeded");
    return { ...run!.request_telemetry, edges };
  }

  const edgeCalls = (t: Telemetry) => ({ campaign_edge: t.byKind.campaign_edge, adset_edge: t.byKind.adset_edge, ad_edge: t.byKind.ad_edge });

  async function current(sourceId: string, entityType: "adset" | "ad", ids: string[]) {
    return db.query<{ entity_id: string; effective_status: string; configured_status: string }>(
      `select entity_id, effective_status, configured_status from meta_ads_entity_versions
        where source_id=$1 and entity_type=$2 and entity_id = any($3::text[]) and valid_to is null order by entity_id`,
      [sourceId, entityType, ids]);
  }

  async function versionCounts(sourceId: string) {
    return db.query<{ entity_type: string; total: number; current: number }>(
      `select entity_type, count(*)::int as total, count(*) filter (where valid_to is null)::int as current
         from meta_ads_entity_versions where source_id=$1 group by entity_type order by entity_type`, [sourceId]);
  }

  async function versionsOf(sourceId: string, entityType: string, entityId: string): Promise<number> {
    return (await db.query<{ n: number }>("select count(*)::int as n from meta_ads_entity_versions where source_id=$1 and entity_type=$2 and entity_id=$3",
      [sourceId, entityType, entityId]))[0]!.n;
  }

  async function fullCursor(sourceId: string): Promise<string | undefined> {
    return (await db.query<{ cursor_value: string }>("select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2",
      [sourceId, `meta_ads_entities_full:${ACCOUNT}`]))[0]?.cursor_value;
  }

  it("a RESUMED campaign's CAMPAIGN_PAUSED ad sets and ads become ACTIVE in the same incremental scan (2 extra lean calls, 0 creative versions)", async () => {
    const ids = await seedSource();
    const acct = account();
    const childAdsets = acct.adsets.filter((s) => s.campaign_id === "c10" && s.effective_status !== "ARCHIVED").map((s) => s.id);
    const childAds = acct.ads.filter((a) => a.campaign_id === "c10" && a.effective_status !== "ARCHIVED").map((a) => a.id);
    expect(childAdsets.length).toBeGreaterThan(5);
    expect(childAds.length).toBeGreaterThan(20);
    // A creative shared between a c10 ad and an ad elsewhere (#76's shared-creative case).
    const sibling = acct.ads.find((a) => a.campaign_id !== "c10" && a.effective_status === "ACTIVE")!;
    const sharer = acct.ads.find((a) => a.id === childAds[0])!;
    sharer.creative = sibling.creative;
    setCampaign(acct, "c10", "PAUSED");
    await scan(acct, ids); // first scan: full, records CAMPAIGN_PAUSED on the children
    expect(new Set((await current(ids.sourceId, "ad", childAds)).map((row) => row.effective_status))).toEqual(new Set(["CAMPAIGN_PAUSED"]));

    // The shared creative is renamed and re-read through the sibling's own delta: the creative gets
    // a new version, while the sharer's stored copy still carries the old expansion.
    (sibling.creative as Record<string, unknown>).name = "Renamed creative";
    Object.assign(sibling, { name: "Sibling v2", updated_time: new Date().toISOString() });
    await scan(acct, ids);
    const creativesBefore = (await versionCounts(ids.sourceId)).find((row) => row.entity_type === "creative");

    // Resume. Children's updated_time does not move. One child is also edited, so it is in the delta.
    setCampaign(acct, "c10", "ACTIVE");
    const edited = acct.ads.find((a) => a.id === childAds[1])!;
    Object.assign(edited, { name: "Edited child", updated_time: new Date().toISOString() });
    const resumed = await scan(acct, ids);

    expect(edgeCalls(resumed)).toEqual({ campaign_edge: 1, adset_edge: 2, ad_edge: 2 });
    const c10Calls = resumed.edges.filter((call) => call.owner === "c10");
    expect(c10Calls).toHaveLength(2);
    expect(c10Calls).toEqual(expect.arrayContaining([
      { owner: "c10", edge: "adsets", fields: META_ADS_ADSET_LEAN_FIELDS, limit: 500, updatedSince: null },
      { owner: "c10", edge: "ads", fields: META_ADS_AD_LEAN_FIELDS, limit: 500, updatedSince: null },
    ]));
    expect(resumed.childStatusRefresh).toEqual({
      outcome: "applied", changedCampaigns: 1, changedAdsets: 0, refreshes: 2, requests: 2,
      adsetsUpdated: childAdsets.length, adsUpdated: childAds.length - 1, fullReadReason: null,
    });
    expect(new Set((await current(ids.sourceId, "adset", childAdsets)).map((row) => row.effective_status))).toEqual(new Set(["ACTIVE"]));
    expect(new Set((await current(ids.sourceId, "ad", childAds)).map((row) => row.effective_status))).toEqual(new Set(["ACTIVE"]));
    // The edited child got ONE new version this run (delta node, with the fresh status), not two.
    expect(await versionsOf(ids.sourceId, "ad", edited.id)).toBe(2);
    // Status-only rebuilds never mint a creative version, including the shared creative.
    expect((await versionCounts(ids.sourceId)).find((row) => row.entity_type === "creative")).toEqual(creativesBefore);
    const [sharerNow] = await db.query<{ creative_name: string | null }>(
      "select metadata_json->'creative'->>'name' as creative_name from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and entity_id=$2 and valid_to is null",
      [ids.sourceId, sharer.id]);
    expect(sharerNow?.creative_name).toBe("Renamed creative");
    // Ads outside the campaign are untouched.
    const outside = acct.ads.find((a) => a.campaign_id !== "c10" && a.id !== sibling.id)!;
    expect(await versionsOf(ids.sourceId, "ad", outside.id)).toBe(1);
  }, 120_000);

  it("a PAUSED ad set's ads become ADSET_PAUSED in the same incremental scan (1 extra lean call)", async () => {
    const ids = await seedSource();
    const acct = account();
    await scan(acct, ids);
    const adset = acct.adsets.find((s) => s.id === "s40")!;
    const children = acct.ads.filter((a) => a.adset_id === "s40" && a.effective_status !== "ARCHIVED");
    expect(children.length).toBeGreaterThan(0);
    Object.assign(adset, { status: "PAUSED", effective_status: "PAUSED", updated_time: new Date().toISOString() });
    for (const ad of children) ad.effective_status = "ADSET_PAUSED";

    const paused = await scan(acct, ids);
    expect(edgeCalls(paused)).toEqual({ campaign_edge: 1, adset_edge: 1, ad_edge: 2 });
    expect(paused.edges.filter((call) => call.owner !== ACCOUNT)).toEqual([
      { owner: "s40", edge: "ads", fields: META_ADS_AD_LEAN_FIELDS, limit: 500, updatedSince: null },
    ]);
    expect(paused.childStatusRefresh).toMatchObject({ outcome: "applied", changedAdsets: 1, refreshes: 1, requests: 1, adsUpdated: children.length });
    expect(await current(ids.sourceId, "ad", children.map((a) => a.id))).toEqual(
      children.map((a) => ({ entity_id: a.id, effective_status: "ADSET_PAUSED", configured_status: "ACTIVE" })).sort((l, r) => l.entity_id.localeCompare(r.entity_id)));
    expect(await current(ids.sourceId, "adset", ["s40"])).toEqual([{ entity_id: "s40", effective_status: "PAUSED", configured_status: "PAUSED" }]);
  }, 120_000);

  it("no parent status change: 0 extra calls and 0 new versions", async () => {
    const ids = await seedSource();
    const acct = account();
    await scan(acct, ids);
    const before = await versionCounts(ids.sourceId);
    const quiet = await scan(acct, ids);
    expect(edgeCalls(quiet)).toEqual({ campaign_edge: 1, adset_edge: 1, ad_edge: 1 });
    expect(quiet.requestCount).toBe(3);
    expect(quiet.edges.every((call) => call.owner === ACCOUNT)).toBe(true);
    expect(quiet.childStatusRefresh).toEqual({
      outcome: "none", changedCampaigns: 0, changedAdsets: 0, refreshes: 0, requests: 0, adsetsUpdated: 0, adsUpdated: 0, fullReadReason: null,
    });
    expect(await versionCounts(ids.sourceId)).toEqual(before);

    // A renamed campaign and ad set (no status change) are not transitions either.
    acct.campaigns[12]!.name = "Renamed campaign";
    Object.assign(acct.adsets[30]!, { name: "Renamed ad set", updated_time: new Date().toISOString() });
    const renamed = await scan(acct, ids);
    expect(edgeCalls(renamed)).toEqual({ campaign_edge: 1, adset_edge: 1, ad_edge: 1 });
    expect(renamed.childStatusRefresh?.outcome).toBe("none");
  }, 120_000);

  it("budget too small: requests the full read, writes no child version, and the next scan's full read fixes the children", async () => {
    const ids = await seedSource();
    const acct = account();
    setCampaign(acct, "c10", "PAUSED");
    await scan(acct, ids);
    const childAds = acct.ads.filter((a) => a.campaign_id === "c10" && a.effective_status !== "ARCHIVED").map((a) => a.id);
    const before = await versionCounts(ids.sourceId);

    setCampaign(acct, "c10", "ACTIVE");
    // Exactly the three edge calls an incremental scan needs; nothing left for the child reads.
    const starved = await scan(acct, ids, 3);
    expect(edgeCalls(starved)).toEqual({ campaign_edge: 1, adset_edge: 1, ad_edge: 1 });
    expect(starved.childStatusRefresh).toMatchObject({ outcome: "full_read_requested", fullReadReason: "request_budget", refreshes: 0, requests: 0, adsUpdated: 0 });
    // Nothing half-written: only the campaign's own new version, no child version.
    const after = await versionCounts(ids.sourceId);
    expect(after.find((row) => row.entity_type === "campaign")?.total).toBe(before.find((row) => row.entity_type === "campaign")!.total + 1);
    expect(after.filter((row) => row.entity_type !== "campaign")).toEqual(before.filter((row) => row.entity_type !== "campaign"));
    expect(new Set((await current(ids.sourceId, "ad", childAds)).map((row) => row.effective_status))).toEqual(new Set(["CAMPAIGN_PAUSED"]));
    expect(await fullCursor(ids.sourceId)).toBe("1970-01-01T00:00:00.000Z");

    // The next scan is the daily full read (lean ad snapshot), and it carries the resume to the children.
    const next = await scan(acct, ids);
    expect(next.fullAdRead).toEqual({ mode: "lean", fallback: null });
    expect(next.childStatusRefresh).toBeUndefined();
    expect(new Set((await current(ids.sourceId, "ad", childAds)).map((row) => row.effective_status))).toEqual(new Set(["ACTIVE"]));
    expect(Date.parse((await fullCursor(ids.sourceId))!)).toBeGreaterThan(Date.parse("2026-01-01"));
  }, 120_000);

  it("a child the refresh cannot explain (never stored, not in the delta) requests the full read and applies nothing", async () => {
    const ids = await seedSource();
    const acct = account();
    await scan(acct, ids);
    const children = acct.ads.filter((a) => a.adset_id === "s50" && a.effective_status !== "ARCHIVED");
    Object.assign(acct.adsets.find((s) => s.id === "s50")!, { status: "PAUSED", effective_status: "PAUSED", updated_time: new Date().toISOString() });
    for (const ad of children) ad.effective_status = "ADSET_PAUSED";
    // Created before the overlap window yet never stored (eventual consistency).
    acct.ads.push({ id: "a_ghost", name: "Ghost", adset_id: "s50", campaign_id: acct.adsets[50]!.campaign_id, status: "ACTIVE", effective_status: "ADSET_PAUSED", updated_time: OLD, creative: { id: "cr_ghost" } });

    const ghost = await scan(acct, ids);
    expect(ghost.childStatusRefresh).toMatchObject({ outcome: "full_read_requested", fullReadReason: "unknown_ad", refreshes: 1, requests: 1, adsUpdated: 0 });
    expect(new Set((await current(ids.sourceId, "ad", children.map((a) => a.id))).map((row) => row.effective_status))).toEqual(new Set(["ACTIVE"]));
    expect(await fullCursor(ids.sourceId)).toBe("1970-01-01T00:00:00.000Z");
  }, 120_000);
});
