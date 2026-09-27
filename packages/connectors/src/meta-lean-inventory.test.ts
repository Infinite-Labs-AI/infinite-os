import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { classifySyncFailure, connectorFor, type SyncRequest } from "./index.js";
import { metaAdsEntityVersionFingerprint } from "./meta-entity-fingerprint.js";
import {
  META_ADS_AD_FULL_FIELDS,
  META_ADS_AD_LEAN_FIELDS,
  META_ADS_CREATIVE_RULING_FIELDS,
  META_ADS_HEAVY_RECONCILE_MAX_AGE_MS,
  mergeMetaAdsLeanAds,
  metaAdsFullAdReadPlan,
  metaAdsHeavyAdFieldsKey,
  metaAdsHeavyCursorValue,
  metaAdsMarkCreativeRulingFields,
  metaAdsWithoutUnreadRulingFields,
  metaGraphNextPage,
} from "./meta-lean-inventory.js";

const KEY = "meta-lean-inventory-encryption-key";
const ACCOUNT = "act_777";
const OLD = "2026-01-01T00:00:00+0000";

describe("metaGraphNextPage", () => {
  it("treats a page with cursors but no next link as the LAST page (Meta returns cursors.after on every non-empty page)", () => {
    expect(metaGraphNextPage({ cursors: { after: "QVFIUk1" } })).toEqual({ kind: "last" });
    expect(metaGraphNextPage({})).toEqual({ kind: "last" });
    expect(metaGraphNextPage(null)).toEqual({ kind: "last" });
  });
  it("continues only when next is present, preferring the cursor token over the token-bearing URL", () => {
    expect(metaGraphNextPage({ cursors: { after: "A1" }, next: "https://graph.facebook.com/v25.0/act_1/ads?after=A1&access_token=x" }))
      .toEqual({ kind: "next", after: "A1" });
    expect(metaGraphNextPage({ next: "https://graph.facebook.com/v25.0/act_1/ads?after=B2" })).toEqual({ kind: "next", after: "B2" });
  });
  it("flags a next link it cannot continue instead of silently truncating", () => {
    expect(metaGraphNextPage({ next: "https://graph.facebook.com/v25.0/act_1/ads" })).toEqual({ kind: "malformed" });
    expect(metaGraphNextPage({ next: "not a url" })).toEqual({ kind: "malformed" });
  });
});

describe("metaAdsFullAdReadPlan", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const V = "v25.0";
  const heavy = (at: string, version = V) => metaAdsHeavyCursorValue(at, metaAdsHeavyAdFieldsKey(version));
  it("reads lean with a delta bounded by the last committed scan (5 min overlap)", () => {
    expect(metaAdsFullAdReadPlan({ scanCheckpoint: "2026-09-23T10:00:00.000Z", heavyCheckpoint: heavy("2026-09-20T00:00:00.000Z"), apiVersion: V, now }))
      .toEqual({ lean: true, updatedSince: Date.parse("2026-09-23T09:55:00Z") / 1000 });
  });
  it("reads heavy without a scan checkpoint, a heavy checkpoint, the current field set, or a recent heavy read", () => {
    expect(metaAdsFullAdReadPlan({ scanCheckpoint: null, heavyCheckpoint: heavy("2026-09-20T00:00:00.000Z"), apiVersion: V, now }))
      .toEqual({ lean: false, reason: "no_scan_checkpoint" });
    expect(metaAdsFullAdReadPlan({ scanCheckpoint: "2026-09-23T10:00:00.000Z", heavyCheckpoint: null, apiVersion: V, now }))
      .toEqual({ lean: false, reason: "no_heavy_checkpoint" });
    expect(metaAdsFullAdReadPlan({ scanCheckpoint: "2026-09-23T10:00:00.000Z", heavyCheckpoint: "2026-09-20T00:00:00.000Z|0123456789abcdef", apiVersion: V, now }))
      .toEqual({ lean: false, reason: "heavy_shape_changed" });
    expect(metaAdsFullAdReadPlan({
      scanCheckpoint: "2026-09-23T10:00:00.000Z",
      heavyCheckpoint: heavy(new Date(now.getTime() - META_ADS_HEAVY_RECONCILE_MAX_AGE_MS).toISOString()),
      apiVersion: V,
      now,
    })).toEqual({ lean: false, reason: "heavy_reconcile_due" });
    expect(metaAdsFullAdReadPlan({ scanCheckpoint: "2026-09-24T10:00:00.000Z", heavyCheckpoint: heavy("2026-09-20T00:00:00.000Z"), apiVersion: V, now }))
      .toEqual({ lean: false, reason: "no_scan_checkpoint" });
  });
  it("keys the heavy checkpoint to the exact heavy field set AND Graph API version", () => {
    expect(metaAdsHeavyAdFieldsKey(V)).toBe(metaAdsHeavyAdFieldsKey(V, META_ADS_AD_FULL_FIELDS));
    expect(metaAdsHeavyAdFieldsKey(V, `${META_ADS_AD_FULL_FIELDS},url_tags`)).not.toBe(metaAdsHeavyAdFieldsKey(V));
    expect(metaAdsHeavyAdFieldsKey("v26.0")).not.toBe(metaAdsHeavyAdFieldsKey(V));
    expect(META_ADS_AD_LEAN_FIELDS).not.toContain("{");
  });
  it("forces a heavy read after a Graph API version bump", () => {
    expect(metaAdsFullAdReadPlan({ scanCheckpoint: "2026-09-23T10:00:00.000Z", heavyCheckpoint: heavy("2026-09-22T00:00:00.000Z", "v25.0"), apiVersion: "v26.0", now }))
      .toEqual({ lean: false, reason: "heavy_shape_changed" });
  });
});

describe("creative ruling fields (url_tags, degrees_of_freedom_spec)", () => {
  const spec = { creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" }, text_optimizations: { enroll_status: "OPT_IN" } } };
  it("the heavy read asks for both inside the creative expansion — the same request, no new one", () => {
    const expansion = META_ADS_AD_FULL_FIELDS.slice(META_ADS_AD_FULL_FIELDS.indexOf("creative{") + "creative{".length, META_ADS_AD_FULL_FIELDS.indexOf("}"));
    expect(expansion.split(",")).toEqual(expect.arrayContaining([...META_ADS_CREATIVE_RULING_FIELDS]));
    expect([...META_ADS_CREATIVE_RULING_FIELDS]).toEqual(["url_tags", "degrees_of_freedom_spec"]);
    expect(META_ADS_AD_LEAN_FIELDS).not.toContain("url_tags");
  });
  it("records an absent field as null (asked, none set) and keeps what Meta returned", () => {
    const bare = { id: "a1", creative: { id: "cr1", name: "Old" } };
    expect(metaAdsMarkCreativeRulingFields(bare)).toEqual({ id: "a1", creative: { id: "cr1", name: "Old", url_tags: null, degrees_of_freedom_spec: null } });
    expect(bare.creative).toEqual({ id: "cr1", name: "Old" }); // the input is not mutated
    const tagged = { id: "a2", creative: { id: "cr2", url_tags: "utm_content={{ad.name}}", degrees_of_freedom_spec: spec } };
    expect(metaAdsMarkCreativeRulingFields(tagged)).toBe(tagged);
    expect(metaAdsMarkCreativeRulingFields({ id: "a3", creative: { id: "cr3", url_tags: "x=1" } }).creative)
      .toEqual({ id: "cr3", url_tags: "x=1", degrees_of_freedom_spec: null });
  });
  it("strips from fresh metadata only the ruling keys the stored snapshot never held — top level and the ad's creative", () => {
    const fresh = { id: "cr1", name: "A", url_tags: null, degrees_of_freedom_spec: spec };
    expect(metaAdsWithoutUnreadRulingFields(fresh, { id: "cr1", name: "A" })).toEqual({ id: "cr1", name: "A" });
    expect(metaAdsWithoutUnreadRulingFields(fresh, { id: "cr1", name: "A", url_tags: "x=1" })).toEqual({ id: "cr1", name: "A", url_tags: null });
    const ad = { id: "a1", status: "ACTIVE", creative: { id: "cr1", url_tags: "utm_content={{ad.name}}", degrees_of_freedom_spec: null } };
    expect(metaAdsWithoutUnreadRulingFields(ad, { id: "a1", status: "ACTIVE", creative: { id: "cr1" } })).toEqual({ id: "a1", status: "ACTIVE", creative: { id: "cr1" } });
    expect(ad.creative).toHaveProperty("url_tags"); // not mutated
  });
  it("leaves a node without a creative expansion alone (no creative, or a bare lean reference is never a heavy node)", () => {
    const none = { id: "a4" };
    expect(metaAdsMarkCreativeRulingFields(none)).toBe(none);
    const list = { id: "a5", creative: [] as unknown };
    expect(metaAdsMarkCreativeRulingFields(list)).toBe(list);
  });
});

describe("mergeMetaAdsLeanAds", () => {
  const stored: Record<string, unknown> = { id: "a1", name: "Ad", adset_id: "s1", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE", bid_amount: 5, creative: { id: "cr1", body: "Copy" } };
  it("takes status from the lean read and everything else from the stored snapshot", () => {
    const lean = { id: "a1", name: "Ad", adset_id: "s1", campaign_id: "c1", status: "ACTIVE", effective_status: "ARCHIVED", creative: { id: "cr1" } };
    expect(mergeMetaAdsLeanAds({ lean: [lean], delta: [], stored: [stored] }))
      .toEqual({ kind: "merged", nodes: [{ ...stored, effective_status: "ARCHIVED" }] });
  });
  it("prefers the fresh delta node over the stored one", () => {
    const delta = { ...stored, bid_amount: 9, creative: { id: "cr1", body: "New copy" } };
    const lean = { id: "a1", name: "Ad", adset_id: "s1", campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", creative: { id: "cr1" } };
    expect(mergeMetaAdsLeanAds({ lean: [lean], delta: [delta], stored: [stored] }))
      .toEqual({ kind: "merged", nodes: [{ ...delta, status: "PAUSED", effective_status: "PAUSED" }] });
  });
  it("resolves a shared creative to ONE source per creative id: delta, else the stored creative version, else the ad's own", () => {
    const leanOf = (id: string): Record<string, unknown> => ({ id, name: "Ad", adset_id: "s1", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "cr1" } });
    const staleAd: Record<string, unknown> = { ...stored, id: "a2", creative: { id: "cr1", name: "Old" } };
    const renamed = { id: "cr1", name: "Renamed", body: "Copy" };
    // The stored creative version (latest observation across ads) outranks a sibling's stale copy.
    expect(mergeMetaAdsLeanAds({ lean: [leanOf("a2")], delta: [], stored: [staleAd], storedCreatives: [renamed] }))
      .toEqual({ kind: "merged", nodes: [{ ...staleAd, creative: renamed }] });
    // A creative read in this run outranks storage, for every ad sharing it.
    const fresh = { id: "cr1", name: "Fresh", body: "Copy" };
    const merged = mergeMetaAdsLeanAds({
      lean: [leanOf("a1"), leanOf("a2")], delta: [{ ...stored, creative: fresh }], stored: [stored, staleAd], storedCreatives: [renamed],
    });
    expect(merged.kind === "merged" && merged.nodes.map(node => node.creative)).toEqual([fresh, fresh]);
    // No stored creative version: the ad keeps its own expansion.
    expect(mergeMetaAdsLeanAds({ lean: [leanOf("a2")], delta: [], stored: [staleAd] }))
      .toEqual({ kind: "merged", nodes: [staleAd] });
  });
  it("membership comes from the lean read only (a vanished ad is not resurrected from storage)", () => {
    expect(mergeMetaAdsLeanAds({ lean: [], delta: [stored], stored: [stored] })).toEqual({ kind: "merged", nodes: [] });
  });
  it("demands a heavy read for an unknown ad, a swapped creative, or a non-status change the delta missed", () => {
    const lean = { id: "a1", name: "Ad", adset_id: "s1", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "cr1" } };
    expect(mergeMetaAdsLeanAds({ lean: [{ ...lean, id: "a2" }], delta: [], stored: [stored] }))
      .toEqual({ kind: "needs_full", reason: "unknown_ad", entityId: "a2" });
    expect(mergeMetaAdsLeanAds({ lean: [{ ...lean, creative: { id: "cr2" } }], delta: [], stored: [stored] }))
      .toEqual({ kind: "needs_full", reason: "creative_changed", entityId: "a1" });
    expect(mergeMetaAdsLeanAds({ lean: [{ ...lean, name: "Renamed" }], delta: [], stored: [stored] }))
      .toEqual({ kind: "needs_full", reason: "fields_changed", entityId: "a1" });
    expect(mergeMetaAdsLeanAds({ lean: [{ ...lean, adset_id: "s9" }], delta: [], stored: [stored] }))
      .toEqual({ kind: "needs_full", reason: "fields_changed", entityId: "a1" });
  });
});

type Node = Record<string, unknown> & { id: string; updated_time: string };

type Account = { campaigns: Node[]; adsets: Node[]; ads: Node[]; adInsights: Array<Record<string, unknown>> };

type EdgeRequest = { edge: string; fields: string; limit: number; updatedSince: number | null; after: string | null };

/** Split a Graph `fields` list at top-level commas (sub-field lists stay intact). */
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

/** Project a node the way Graph does: requested fields only, a bare reference field → `{id}`. */
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

/**
 * A Graph edge that behaves like Meta: filters effective_status and updated_since, pages by
 * `limit`, returns cursors.after on EVERY non-empty page, and `next` only when more data exists.
 */
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
    ...(end < matching.length ? { next: `https://graph.facebook.com/v25.0/${ACCOUNT}/x?after=${end}` } : {}),
  };
  return new Response(JSON.stringify({ data: page, ...(paging ? { paging } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
}

/** Meta's answer to a revoked/expired token: HTTP 400 with an OAuthException code-190 body. */
function revokedTokenResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Error validating access token: The session has been invalidated.", type: "OAuthException", code: 190, error_subcode: 460 } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** The Chargerless 1 shape: 25 campaigns (7 archived), 222 ad sets (12 archived), 460 ads (45 archived). */
function prodShapeAccount(): Account {
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
    const adset = 12 + (i % 210);
    return {
      id: `a${i}`, name: `Ad ${i}`, adset_id: `s${adset}`, campaign_id: `c${7 + (adset - 12) % 18}`,
      status, effective_status: status, updated_time: OLD,
      creative: { id: `cr${i}`, title: `Hook ${i}`, body: `Body ${i}`, image_hash: `hash${i}`, thumbnail_url: `https://scontent.xx.fbcdn.net/t${i}.jpg?oh=signed` },
    };
  });
  return { campaigns, adsets, ads, adInsights: [] };
}

describe("lean Meta inventory reads against real PGlite", () => {
  let dataDir: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-meta-lean-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedSource(workspaceId: string, sourceId: string): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const datasets = await db.query<{ id: string }>("select id from datasets where workspace_id = $1 and key = 'web'", [workspaceId]);
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1,$2,$3,'meta_ads','Meta lean',$4,'connected')`,
      [sourceId, workspaceId, datasets[0]!.id, ACCOUNT],
    );
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'marketing_api_access_token',$4)`,
      [`cred_${randomUUID()}`, workspaceId, sourceId, encryptCredentialPayload(
        { mode: "live", transport: "meta_ads_cli", adAccountId: ACCOUNT, accessToken: "test-token", apiVersion: "v25.0" }, KEY)],
    );
  }

  function request(workspaceId: string, sourceId: string, mode: "inventory_only" | "insights_only" | "full" = "inventory_only"): SyncRequest {
    return {
      workspaceId, sourceId, provider: "meta_ads", syncRunId: `sync_${randomUUID()}`, encryptionKey: KEY,
      windowSince: "2026-09-22", windowUntil: "2026-09-22", metaAdsRequestBudget: 300,
      ...(mode === "full" ? {} : { metaAdsSyncMode: mode }),
      ...(mode === "insights_only" ? { metaAdsRequestLane: "hot_insights" as const } : {}),
    };
  }

  type FullAdRead = { mode: "lean" | "heavy"; fallback: string | null } | undefined;
  async function sync(account: Account, syncRequest: SyncRequest, options: { revoked?: boolean } = {}): Promise<{ edges: EdgeRequest[]; byKind: Record<string, number>; requestCount: number; fullAdRead: FullAdRead; error?: unknown }> {
    const edges: EdgeRequest[] = [];
    let error: unknown;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const headers = { "content-type": "application/json", "x-fb-ads-insights-throttle": JSON.stringify({ acc_id_util_pct: 5 }) };
      if (init?.method === "POST" && url.pathname === "/v25.0/") {
        const reads = JSON.parse(new URLSearchParams(String(init.body)).get("batch") ?? "[]") as Array<{ relative_url: string }>;
        const items = reads.map((read) => {
          const level = new URL(read.relative_url, "https://graph.facebook.com/v25.0/").searchParams.get("level");
          return { code: 200, headers: [], body: JSON.stringify({ data: level === "ad" ? account.adInsights : [], paging: {} }) };
        });
        return new Response(JSON.stringify(items), { status: 200, headers });
      }
      if (options.revoked) return revokedTokenResponse();
      if (url.pathname.endsWith(`/${ACCOUNT}`)) {
        return new Response(JSON.stringify({ id: ACCOUNT, account_id: "777", currency: "USD", timezone_name: "America/New_York" }), { status: 200, headers });
      }
      const edge = url.pathname.split("/").at(-1) ?? "";
      if (edge === "insights") {
        const level = url.searchParams.get("level");
        return new Response(JSON.stringify({ data: level === "ad" ? account.adInsights : [], paging: {} }), { status: 200, headers });
      }
      if (edge === "campaigns" || edge === "adsets" || edge === "ads") {
        edges.push({
          edge, fields: url.searchParams.get("fields") ?? "", limit: Number(url.searchParams.get("limit")),
          updatedSince: url.searchParams.has("updated_since") ? Number(url.searchParams.get("updated_since")) : null,
          after: url.searchParams.get("after"),
        });
        return graphEdgePage(account[edge], url);
      }
      throw new Error(`unexpected Meta URL ${url.toString()}`);
    }) as typeof fetch;
    try {
      await connectorFor("meta_ads").sync(db, syncRequest);
    } catch (caught) {
      if (!options.revoked) throw caught;
      error = caught;
    } finally {
      globalThis.fetch = original;
    }
    const telemetry = (await db.query<{ request_telemetry: { byKind: Record<string, number>; requestCount: number; fullAdRead?: FullAdRead } }>(
      "select request_telemetry from sync_runs where id=$1", [syncRequest.syncRunId]))[0]!.request_telemetry;
    return { edges, byKind: telemetry.byKind, requestCount: telemetry.requestCount, fullAdRead: telemetry.fullAdRead, error };
  }

  function edgeCalls(byKind: Record<string, number>) {
    return { account_liveness: byKind.account_liveness, campaign_edge: byKind.campaign_edge, adset_edge: byKind.adset_edge, ad_edge: byKind.ad_edge };
  }

  async function forceNextScanFull(sourceId: string): Promise<void> {
    await db.query("update sync_cursors set cursor_value='2020-01-01T00:00:00.000Z' where source_id=$1 and cursor_key like 'meta_ads_entities_full:%'", [sourceId]);
  }

  async function currentAd(sourceId: string, adId: string) {
    return db.query<{ effective_status: string; configured_status: string; metadata_json: Record<string, unknown> }>(
      "select effective_status, configured_status, metadata_json from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and entity_id=$2 and valid_to is null",
      [sourceId, adId],
    );
  }

  async function versionCounts(sourceId: string) {
    return db.query<{ entity_type: string; total: number; current: number }>(
      `select entity_type, count(*)::int as total, count(*) filter (where valid_to is null)::int as current
         from meta_ads_entity_versions where source_id=$1 group by entity_type order by entity_type`,
      [sourceId],
    );
  }

  it("#4 — a full scan of the prod shape pays one call per page and never follows a last page's cursor", async () => {
    const workspaceId = `ws_lean_pages_${randomUUID()}`, sourceId = `src_lean_pages_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    const full = await sync(account, request(workspaceId, sourceId));
    // Before: campaign 2 / adset 2 / ad 6 (an extra empty request after every edge's last page).
    expect(edgeCalls(full.byKind)).toEqual({ account_liveness: 1, campaign_edge: 1, adset_edge: 1, ad_edge: 5 });
    expect(full.requestCount).toBe(8);
    expect(full.fullAdRead).toEqual({ mode: "heavy", fallback: "no_scan_checkpoint" });
    expect(await versionCounts(sourceId)).toEqual([
      { entity_type: "ad", total: 460, current: 460 },
      { entity_type: "adset", total: 222, current: 222 },
      { entity_type: "campaign", total: 25, current: 25 },
      { entity_type: "creative", total: 460, current: 460 },
    ]);

    // Incremental with nothing changed: one call per edge (campaigns are always a complete read),
    // and no account read — the first scan's liveness read is good for 24h.
    const quiet = await sync(account, request(workspaceId, sourceId));
    expect(edgeCalls(quiet.byKind)).toEqual({ account_liveness: 0, campaign_edge: 1, adset_edge: 1, ad_edge: 1 });
    expect(quiet.edges.find((call) => call.edge === "campaigns")?.updatedSince).toBeNull();
    // Incremental scans do not read the full ad snapshot at all.
    expect(quiet.fullAdRead).toBeUndefined();

    // Incremental with three changed ads: still one ad call (before: 2 — the empty follow-up).
    for (const ad of account.ads.slice(100, 103)) { ad.name = `${String(ad.name)} v2`; ad.updated_time = new Date().toISOString(); }
    const changed = await sync(account, request(workspaceId, sourceId));
    expect(edgeCalls(changed.byKind)).toEqual({ account_liveness: 0, campaign_edge: 1, adset_edge: 1, ad_edge: 1 });
    expect((await currentAd(sourceId, "a100"))[0]?.metadata_json.name).toBe("Ad 100 v2");
  }, 120_000);

  it("#3 — the daily full read reads ads without the creative expansion and keeps every version and creative current", async () => {
    const workspaceId = `ws_lean_full_${randomUUID()}`, sourceId = `src_lean_full_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    await sync(account, request(workspaceId, sourceId));
    const heavyCursor = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2", [sourceId, `meta_ads_entities_heavy:${ACCOUNT}`]);
    expect(heavyCursor[0]?.cursor_value).toMatch(new RegExp(`\\|${metaAdsHeavyAdFieldsKey("v25.0")}$`));
    const before = await versionCounts(sourceId);

    await forceNextScanFull(sourceId);
    const lean = await sync(account, request(workspaceId, sourceId));
    // Before: ad_edge 6 (5 heavy pages of 100 + an empty follow-up). After: one heavy delta + one lean page.
    expect(edgeCalls(lean.byKind)).toEqual({ account_liveness: 0, campaign_edge: 1, adset_edge: 1, ad_edge: 2 });
    expect(lean.requestCount).toBe(4);
    expect(lean.fullAdRead).toEqual({ mode: "lean", fallback: null });
    const adCalls = lean.edges.filter((call) => call.edge === "ads");
    expect(adCalls).toEqual([
      expect.objectContaining({ fields: META_ADS_AD_FULL_FIELDS, limit: 100, updatedSince: expect.any(Number) }),
      expect.objectContaining({ fields: META_ADS_AD_LEAN_FIELDS, limit: 500, updatedSince: null }),
    ]);
    // No version minted, none closed, creatives (sourced from storage) stay current.
    expect(await versionCounts(sourceId)).toEqual(before);
    expect((await currentAd(sourceId, "a300"))[0]?.metadata_json.creative).toMatchObject({ id: "cr300", title: "Hook 300", body: "Body 300" });
    // A full read (lean or heavy) still advances the full checkpoint.
    const full = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2", [sourceId, `meta_ads_entities_full:${ACCOUNT}`]);
    expect(Date.parse(full[0]!.cursor_value)).toBeGreaterThan(Date.parse("2026-01-01"));
    // The lean read does not refresh the heavy checkpoint — the weekly heavy reconcile stays due on time.
    expect(await db.query("select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2",
      [sourceId, `meta_ads_entities_heavy:${ACCOUNT}`])).toEqual(heavyCursor);
  }, 120_000);

  it("#3 — records ACTIVE→ARCHIVED truthfully whether or not the ad's own updated_time moves, and closes a deleted ad", async () => {
    const workspaceId = `ws_lean_archive_${randomUUID()}`, sourceId = `src_lean_archive_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    // A complete history sync (also stores the account currency/timezone the hot lane requires).
    await sync(account, request(workspaceId, sourceId, "full"));
    expect((await currentAd(sourceId, "a200"))[0]).toMatchObject({ effective_status: "ACTIVE", configured_status: "ACTIVE" });

    // Direct archive: the ad's own status changes and updated_time moves → the incremental delta records it.
    Object.assign(account.ads[300]!, { status: "ARCHIVED", effective_status: "ARCHIVED", updated_time: new Date().toISOString() });
    await sync(account, request(workspaceId, sourceId));
    expect((await currentAd(sourceId, "a300"))[0]).toMatchObject({ effective_status: "ARCHIVED", configured_status: "ARCHIVED" });

    // Inherited archive: the parent is archived; the child's effective_status changes but its own
    // updated_time does NOT, so no delta read can see it. Only the full snapshot can.
    const archivedChild = account.ads[200]!;
    archivedChild.effective_status = "ARCHIVED";
    // Deletion: DELETED is filtered out of every edge read, so the ad simply vanishes.
    account.ads.splice(250, 1);
    await forceNextScanFull(sourceId);
    const lean = await sync(account, request(workspaceId, sourceId));
    expect(edgeCalls(lean.byKind).ad_edge).toBe(2);

    const [a200] = await currentAd(sourceId, "a200");
    expect(a200).toMatchObject({ effective_status: "ARCHIVED", configured_status: "ACTIVE" });
    // The new version still carries the full creative expansion (from the stored snapshot).
    expect(a200?.metadata_json.creative).toMatchObject({ id: "cr200", title: "Hook 200", body: "Body 200", image_hash: "hash200" });
    const a200Versions = await db.query<{ effective_status: string; closed: boolean }>(
      "select effective_status, valid_to is not null as closed from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and entity_id='a200' order by first_observed_at",
      [sourceId],
    );
    expect(a200Versions).toEqual([{ effective_status: "ACTIVE", closed: true }, { effective_status: "ARCHIVED", closed: false }]);
    // Archiving mints an ad version, never a creative version.
    expect(await db.query("select count(*)::int as n from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id='cr200'", [sourceId]))
      .toEqual([{ n: 1 }]);
    // Already-archived ads stay current (observed, unchanged) across the lean read.
    expect((await currentAd(sourceId, "a10"))[0]).toMatchObject({ effective_status: "ARCHIVED" });
    expect((await currentAd(sourceId, "a300"))[0]).toMatchObject({ effective_status: "ARCHIVED" });
    // The vanished ad and its creative are closed by the full-snapshot disappearance rule.
    expect(await currentAd(sourceId, "a250")).toEqual([]);
    expect(await db.query("select id from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id='cr250' and valid_to is null", [sourceId]))
      .toEqual([]);

    // Downstream: the hot lane labels the archived ad's metrics from the current version, so the
    // history dimension the Ads screen reads says ARCHIVED — never a stale ACTIVE.
    account.adInsights = [{
      date_start: "2026-09-22", date_stop: "2026-09-22", account_currency: "USD", spend: "3.50", impressions: "100", clicks: "2",
      campaign_id: archivedChild.campaign_id, campaign_name: "Campaign", adset_id: archivedChild.adset_id, adset_name: "Ad set",
      ad_id: "a200", ad_name: "Ad 200", objective: "OUTCOME_SALES",
    }];
    await sync(account, request(workspaceId, sourceId, "insights_only"));
    expect(await db.query("select effective_status, configured_status from meta_ads_ads where source_id=$1 and ad_id='a200'", [sourceId]))
      .toEqual([{ effective_status: "ARCHIVED", configured_status: "ACTIVE" }]);
  }, 120_000);

  it("#3 — falls back to the heavy full read when the lean read cannot be explained by storage or the delta", async () => {
    const workspaceId = `ws_lean_fallback_${randomUUID()}`, sourceId = `src_lean_fallback_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    await sync(account, request(workspaceId, sourceId));

    // A creative swap whose updated_time lags the checkpoint (eventual consistency beyond the overlap).
    account.ads[400]!.creative = { id: "cr_new", title: "New hook", body: "New body", image_hash: "hash_new" };
    await forceNextScanFull(sourceId);
    const swapped = await sync(account, request(workspaceId, sourceId));
    // delta 1 + lean 1 + heavy 5
    expect(edgeCalls(swapped.byKind).ad_edge).toBe(7);
    expect(swapped.fullAdRead).toEqual({ mode: "heavy", fallback: "creative_changed" });
    expect((await currentAd(sourceId, "a400"))[0]?.metadata_json.creative).toMatchObject({ id: "cr_new", title: "New hook" });
    // The heavy fallback refreshed the heavy checkpoint.
    const heavy = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2", [sourceId, `meta_ads_entities_heavy:${ACCOUNT}`]);
    const full = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2", [sourceId, `meta_ads_entities_full:${ACCOUNT}`]);
    expect(heavy[0]?.cursor_value.split("|")[0]).toBe(full[0]?.cursor_value);

    // A never-seen ad the delta did not return (created before the overlap window yet never stored).
    account.ads.push({ id: "a_ghost", name: "Ghost", adset_id: "s20", campaign_id: "c10", status: "ACTIVE", effective_status: "ACTIVE", updated_time: OLD, creative: { id: "cr_ghost", title: "Ghost hook" } });
    await forceNextScanFull(sourceId);
    const ghost = await sync(account, request(workspaceId, sourceId));
    expect(edgeCalls(ghost.byKind).ad_edge).toBe(7);
    expect(ghost.fullAdRead).toEqual({ mode: "heavy", fallback: "unknown_ad" });
    expect((await currentAd(sourceId, "a_ghost"))[0]?.metadata_json.creative).toMatchObject({ id: "cr_ghost", title: "Ghost hook" });
  }, 120_000);

  it("#3 — forces the heavy full read once the weekly reconcile is due", async () => {
    const workspaceId = `ws_lean_weekly_${randomUUID()}`, sourceId = `src_lean_weekly_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    await sync(account, request(workspaceId, sourceId));
    await db.query("update sync_cursors set cursor_value=$2 where source_id=$1 and cursor_key like 'meta_ads_entities_heavy:%'",
      [sourceId, metaAdsHeavyCursorValue(new Date(Date.now() - META_ADS_HEAVY_RECONCILE_MAX_AGE_MS - 60_000).toISOString(), metaAdsHeavyAdFieldsKey("v25.0"))]);
    // A creative RENAME never moves the ad's updated_time; only a heavy read can see it.
    (account.ads[60]!.creative as Record<string, unknown>).name = "Renamed creative";
    await forceNextScanFull(sourceId);
    const weekly = await sync(account, request(workspaceId, sourceId));
    expect(edgeCalls(weekly.byKind).ad_edge).toBe(5);
    expect(weekly.fullAdRead).toEqual({ mode: "heavy", fallback: "heavy_reconcile_due" });
    expect(weekly.edges.filter((call) => call.edge === "ads").every((call) => call.fields === META_ADS_AD_FULL_FIELDS)).toBe(true);
    expect((await currentAd(sourceId, "a60"))[0]?.metadata_json.creative).toMatchObject({ name: "Renamed creative" });
  }, 120_000);

  it("#3 — REVIEW regression: a creative shared by two ads converges to ONE version on lean reads (no flip-flop, no regression)", async () => {
    const workspaceId = `ws_review_shared_${randomUUID()}`, sourceId = `src_review_shared_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    // a100 and a101 share one AdCreative (common after duplicating an ad/ad set).
    account.ads[101]!.creative = account.ads[100]!.creative;
    await sync(account, request(workspaceId, sourceId)); // heavy (first run)
    // Creative rename: never moves either ad's updated_time.
    (account.ads[100]!.creative as Record<string, unknown>).name = "Renamed creative";
    // a100's OWN status changes -> incremental heavy delta re-reads a100 WITH the renamed expansion.
    Object.assign(account.ads[100]!, { status: "PAUSED", effective_status: "PAUSED", updated_time: new Date().toISOString() });
    await sync(account, request(workspaceId, sourceId));
    const creativeVersions = () => db.query<{ name: string | null; current: boolean }>(
      "select metadata_json->>'name' as name, valid_to is null as current from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id='cr100' order by first_observed_at, id",
      [sourceId]);
    const afterIncremental = await creativeVersions();
    await forceNextScanFull(sourceId);
    const lean1 = await sync(account, request(workspaceId, sourceId));
    expect(lean1.byKind.ad_edge).toBe(2);
    await forceNextScanFull(sourceId);
    const lean2 = await sync(account, request(workspaceId, sourceId));
    expect(lean2.byKind.ad_edge).toBe(2);
    const final = await creativeVersions();
    expect(final.filter((v) => v.current)).toEqual([{ name: "Renamed creative", current: true }]);
    expect(final.length).toBe(afterIncremental.length);
    // The sibling ad converges on the renamed creative once, then stays put.
    const a101 = await db.query<{ name: string | null; current: boolean }>(
      "select metadata_json->'creative'->>'name' as name, valid_to is null as current from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and entity_id='a101' order by first_observed_at, id",
      [sourceId]);
    expect(a101).toEqual([{ name: null, current: false }, { name: "Renamed creative", current: true }]);
  }, 120_000);

  it("#3 — REVIEW control: the same shared-creative scenario under heavy full reads (pre-PR behavior)", async () => {
    const workspaceId = `ws_review_ctl_${randomUUID()}`, sourceId = `src_review_ctl_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    account.ads[101]!.creative = account.ads[100]!.creative;
    await sync(account, request(workspaceId, sourceId));
    (account.ads[100]!.creative as Record<string, unknown>).name = "Renamed creative";
    Object.assign(account.ads[100]!, { status: "PAUSED", effective_status: "PAUSED", updated_time: new Date().toISOString() });
    await sync(account, request(workspaceId, sourceId));
    const forceHeavy = () => db.query("delete from sync_cursors where source_id=$1 and cursor_key like 'meta_ads_entities_heavy:%'", [sourceId]);
    for (let i = 0; i < 2; i += 1) { await forceNextScanFull(sourceId); await forceHeavy(); await sync(account, request(workspaceId, sourceId)); }
    const final = await db.query<{ name: string | null; current: boolean }>(
      "select metadata_json->>'name' as name, valid_to is null as current from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id='cr100' order by first_observed_at, id",
      [sourceId]);
    expect(final).toEqual([{ name: null, current: false }, { name: "Renamed creative", current: true }]);
  }, 120_000);

  it("stores each creative's url_tags and enhancement switches from the heavy read, absent ones as null, and keeps them on lean reads", async () => {
    const workspaceId = `ws_lean_rulings_${randomUUID()}`, sourceId = `src_lean_rulings_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    const spec = { creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" }, text_optimizations: { enroll_status: "OPT_OUT" } } };
    Object.assign(account.ads[50]!.creative as Record<string, unknown>, { url_tags: "utm_source=facebook&utm_content={{ad.name}}", degrees_of_freedom_spec: spec });
    const first = await sync(account, request(workspaceId, sourceId));
    expect(first.edges.filter((call) => call.edge === "ads").every((call) => call.fields === META_ADS_AD_FULL_FIELDS)).toBe(true);
    const creative = async (id: string) => (await db.query<{ metadata_json: Record<string, unknown> }>(
      "select metadata_json from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id=$2 and valid_to is null",
      [sourceId, id]))[0]?.metadata_json;
    expect(await creative("cr50")).toMatchObject({ url_tags: "utm_source=facebook&utm_content={{ad.name}}", degrees_of_freedom_spec: spec });
    // Meta returned neither: stored as null ("asked, none set"), never left absent ("never read").
    const bare = await creative("cr51");
    expect(bare).toMatchObject({ url_tags: null, degrees_of_freedom_spec: null });
    expect(Object.keys(bare ?? {})).toEqual(expect.arrayContaining(["url_tags", "degrees_of_freedom_spec"]));
    // The ad's own snapshot of its creative carries the same fields.
    expect((await currentAd(sourceId, "a50"))[0]?.metadata_json.creative).toMatchObject({ url_tags: "utm_source=facebook&utm_content={{ad.name}}" });
    const before = await versionCounts(sourceId);

    // A lean full read rebuilds every creative from storage: the fields survive, nothing re-versions.
    await forceNextScanFull(sourceId);
    const lean = await sync(account, request(workspaceId, sourceId));
    expect(lean.fullAdRead).toEqual({ mode: "lean", fallback: null });
    expect(await versionCounts(sourceId)).toEqual(before);
    expect(await creative("cr51")).toMatchObject({ url_tags: null, degrees_of_freedom_spec: null });
    expect(await creative("cr50")).toMatchObject({ degrees_of_freedom_spec: spec });
  }, 120_000);

  it("a heavy checkpoint taken before the ruling fields were requested forces ONE heavy re-read, which stores them", async () => {
    const workspaceId = `ws_lean_rulings_old_${randomUUID()}`, sourceId = `src_lean_rulings_old_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    await sync(account, request(workspaceId, sourceId));
    // The deployed engine before this change: its heavy key named the field set without the ruling fields.
    const before = META_ADS_AD_FULL_FIELDS.replace(",url_tags,degrees_of_freedom_spec", "");
    expect(before).not.toBe(META_ADS_AD_FULL_FIELDS);
    await db.query("update sync_cursors set cursor_value=$2 where source_id=$1 and cursor_key like 'meta_ads_entities_heavy:%'",
      [sourceId, metaAdsHeavyCursorValue(new Date().toISOString(), metaAdsHeavyAdFieldsKey("v25.0", before))]);
    await forceNextScanFull(sourceId);
    const reread = await sync(account, request(workspaceId, sourceId));
    expect(reread.fullAdRead).toEqual({ mode: "heavy", fallback: "heavy_shape_changed" });
    const heavy = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2", [sourceId, `meta_ads_entities_heavy:${ACCOUNT}`]);
    expect(heavy[0]?.cursor_value).toMatch(new RegExp(`\\|${metaAdsHeavyAdFieldsKey("v25.0")}$`));
    await forceNextScanFull(sourceId);
    expect((await sync(account, request(workspaceId, sourceId))).fullAdRead).toEqual({ mode: "lean", fallback: null });
  }, 120_000);

  it("the first heavy read after the ruling fields were added fills them into the CURRENT versions — no new version, no change", async () => {
    const workspaceId = `ws_lean_rulings_fill_${randomUUID()}`, sourceId = `src_lean_rulings_fill_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    Object.assign(account.ads[70]!.creative as Record<string, unknown>, { url_tags: "utm_content={{ad.name}}", degrees_of_freedom_spec: { creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" } } } });
    await sync(account, request(workspaceId, sourceId));
    // Rewind storage to what the engine BEFORE this change wrote: no ruling keys anywhere, hashes over that metadata,
    // and a heavy checkpoint keyed to the old field set.
    const strip = (entityType: "creative" | "ad") => entityType === "creative"
      ? "metadata_json - 'url_tags' - 'degrees_of_freedom_spec'"
      : "metadata_json #- '{creative,url_tags}' #- '{creative,degrees_of_freedom_spec}'";
    for (const entityType of ["creative", "ad"] as const) {
      await db.query(`update meta_ads_entity_versions set metadata_json = ${strip(entityType)} where source_id=$1 and entity_type=$2`, [sourceId, entityType]);
      const rows = await db.query<{ id: string; metadata_json: Record<string, unknown> }>(
        "select id, metadata_json from meta_ads_entity_versions where source_id=$1 and entity_type=$2", [sourceId, entityType]);
      for (const row of rows) await db.query("update meta_ads_entity_versions set payload_hash=$2 where id=$1", [row.id, metaAdsEntityVersionFingerprint(row.metadata_json)]);
    }
    const before = META_ADS_AD_FULL_FIELDS.replace(",url_tags,degrees_of_freedom_spec", "");
    await db.query("update sync_cursors set cursor_value=$2 where source_id=$1 and cursor_key like 'meta_ads_entities_heavy:%'",
      [sourceId, metaAdsHeavyCursorValue(new Date().toISOString(), metaAdsHeavyAdFieldsKey("v25.0", before))]);
    const versions = await versionCounts(sourceId);
    const stamp = async () => (await db.query<{ n: string }>("select count(*)::text||'@'||max(first_observed_at)::text as n from meta_ads_entity_versions where source_id=$1", [sourceId]))[0]?.n;
    const firstSightings = await stamp();

    // A creative renamed in Ads Manager at the same time IS a change: it still mints its version (and, as before this
    // change, so does the one ad whose snapshot of it carries the name).
    (account.ads[80]!.creative as Record<string, unknown>).name = "Renamed in Ads Manager";
    await forceNextScanFull(sourceId);
    const reread = await sync(account, request(workspaceId, sourceId));
    expect(reread.fullAdRead).toEqual({ mode: "heavy", fallback: "heavy_shape_changed" });
    const after = await versionCounts(sourceId);
    expect(after).toEqual(versions.map((row) => (row.entity_type === "creative" || row.entity_type === "ad" ? { ...row, total: row.total + 1 } : row)));
    // Every other creative and ad kept its version and got the fields in place, hash re-keyed to the new metadata.
    const creative = async (id: string) => (await db.query<{ metadata_json: Record<string, unknown>; payload_hash: string; first_observed_at: Date }>(
      "select metadata_json, payload_hash, first_observed_at from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id=$2 and valid_to is null",
      [sourceId, id]))[0]!;
    const cr70 = await creative("cr70");
    expect(cr70.metadata_json).toMatchObject({ url_tags: "utm_content={{ad.name}}", degrees_of_freedom_spec: { creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" } } } });
    expect(cr70.payload_hash).toBe(metaAdsEntityVersionFingerprint(cr70.metadata_json));
    expect((await creative("cr71")).metadata_json).toMatchObject({ url_tags: null, degrees_of_freedom_spec: null });
    expect((await currentAd(sourceId, "a70"))[0]?.metadata_json.creative).toMatchObject({ url_tags: "utm_content={{ad.name}}" });
    expect((await creative("cr80")).metadata_json).toMatchObject({ name: "Renamed in Ads Manager", url_tags: null });
    // No first sighting is new except the rename's: nothing else reads as changed.
    expect(await db.query("select entity_id from meta_ads_entity_versions where source_id=$1 and first_observed_at > $2::timestamptz order by entity_id",
      [sourceId, firstSightings!.split("@")[1]])).toEqual([{ entity_id: "a80" }, { entity_id: "cr80" }]);
    // And the next scan is the fast path: nothing new.
    await forceNextScanFull(sourceId);
    await sync(account, request(workspaceId, sourceId));
    expect(await versionCounts(sourceId)).toEqual(after);
  }, 120_000);

  it("reads the account node at most once per 24h on inventory scans, and a revoked token still fails the very next scan", async () => {
    const workspaceId = `ws_lean_liveness_${randomUUID()}`, sourceId = `src_lean_liveness_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const account = prodShapeAccount();
    const livenessCursor = async () => (await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2", [sourceId, `meta_ads_account_liveness:${ACCOUNT}`]))[0]?.cursor_value;

    // First scan: no cursor → one account read, committed at CLOSE.
    const first = await sync(account, request(workspaceId, sourceId));
    expect(first.byKind.account_liveness).toBe(1);
    const readAt = await livenessCursor();
    expect(Date.now() - Date.parse(readAt!)).toBeLessThan(60_000);

    // Within 24h: no account read (before: one per scan, 12+/day at the 2-hour cadence).
    for (let i = 0; i < 3; i += 1) {
      const scan = await sync(account, request(workspaceId, sourceId));
      expect(scan.byKind.account_liveness).toBe(0);
    }
    expect(await livenessCursor()).toBe(readAt);

    // 24h later: read again, cursor advances.
    await db.query("update sync_cursors set cursor_value=$3 where source_id=$1 and cursor_key=$2",
      [sourceId, `meta_ads_account_liveness:${ACCOUNT}`, new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString()]);
    const stale = await sync(account, request(workspaceId, sourceId));
    expect(stale.byKind.account_liveness).toBe(1);
    expect(Date.parse((await livenessCursor())!)).toBeGreaterThan(Date.parse(readAt!));

    // A future-dated cursor (clock skew) never suppresses the read.
    await db.query("update sync_cursors set cursor_value='2099-01-01T00:00:00.000Z' where source_id=$1 and cursor_key=$2",
      [sourceId, `meta_ads_account_liveness:${ACCOUNT}`]);
    expect((await sync(account, request(workspaceId, sourceId))).byKind.account_liveness).toBe(1);
    await db.query("update sync_cursors set cursor_value=$3 where source_id=$1 and cursor_key=$2",
      [sourceId, `meta_ads_account_liveness:${ACCOUNT}`, new Date().toISOString()]);

    // Token revoked while the liveness read is skipped: the scan's own entity reads hit Meta's
    // OAuthException 190 and the run fails with the credential-grade error — same run, no account read.
    const revoked = await sync(account, request(workspaceId, sourceId), { revoked: true });
    expect(revoked.error).toBeInstanceOf(Error);
    expect(revoked.byKind.account_liveness).toBe(0);
    const [failure] = await db.query<{ error_code: string; error_message: string; retryable: boolean }>(
      "select e.error_code, e.error_message, e.retryable from sync_errors e join sync_runs r on r.id=e.sync_run_id where r.source_id=$1 and r.status='failed'",
      [sourceId]);
    expect(failure?.error_message).toContain("\"code\":190");
    expect(classifySyncFailure({ code: failure!.error_code, message: failure!.error_message, retryable: failure!.retryable })).toBe("terminal");
    // A failed scan never advances the liveness cursor.
    expect(Date.now() - Date.parse((await livenessCursor())!)).toBeLessThan(60_000);
  }, 120_000);
});
