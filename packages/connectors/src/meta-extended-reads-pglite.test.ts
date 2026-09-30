import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import {
  connectorFor,
  probeMetaAdsExtendedReads,
  syncMetaAdsAdsetBreakdownWindow,
  type MetaAdsCredential,
  type SyncRequest,
} from "./index.js";

// Extended reads (Ad Brain decision 2) end to end against real PGlite: the switch OFF is byte-identical,
// ON adds exactly the approved fields on settled days only, the learning stage never mints an entity
// version, the weekly breakdown writes rows + coverage within its request ceiling, and the probe makes at
// most 3 calls and stores nothing.

const KEY = "meta-extended-reads-encryption-key";
const ACCOUNT = "act_123";
const CREDENTIAL: MetaAdsCredential = { mode: "live", transport: "meta_ads_cli", adAccountId: ACCOUNT, accessToken: "test-token", apiVersion: "v25.0" };

const BASE = "campaign_id,campaign_name,date_start,spend,clicks,inline_link_clicks,impressions,reach,frequency,cpm,cpc,ctr,actions,action_values,results,cost_per_result,result_values_performance_indicator,objective,optimization_goal,account_currency";
const VIDEO = "video_play_actions,video_thruplay_watched_actions,video_avg_time_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions";
const ADSET_EDGE_FIELDS = "id,name,optimization_goal,billing_event,effective_status,status,campaign_id,daily_budget,lifetime_budget,bid_amount,bid_strategy,targeting,promoted_object,destination_type,attribution_spec,start_time,end_time";
const THRUPLAYS = [{ action_type: "video_view", value: "9", "1d_view": "8", "7d_click": "1" }];
const LEARNING = { status: "LEARNING", conversions: 12, last_sig_edit_ts: 1_790_000_000, attribution_windows: ["7d_click", "1d_view"] };

type Seen = { method: string; url: URL };
type Fixture = {
  day: string;
  learning?: boolean;
  learningStatus?: string;
  insights?: (level: string, url: URL) => Response | undefined;
};

function localDay(timeZone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

describe("Meta Ads extended reads against real PGlite", () => {
  let dataDir: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-meta-extended-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedSource(): Promise<{ workspaceId: string; sourceId: string }> {
    const workspaceId = `ws_ext_${randomUUID()}`;
    const sourceId = `src_ext_${randomUUID()}`;
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const datasets = await db.query<{ id: string }>("select id from datasets where workspace_id = $1 and key = 'web'", [workspaceId]);
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1,$2,$3,'meta_ads','Meta extended',$4,'connected')`,
      [sourceId, workspaceId, datasets[0]!.id, ACCOUNT],
    );
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'marketing_api_access_token',$4)`,
      [`cred_${randomUUID()}`, workspaceId, sourceId, encryptCredentialPayload(CREDENTIAL, KEY)],
    );
    return { workspaceId, sourceId };
  }

  function request(scope: { workspaceId: string; sourceId: string }, since: string, until: string, extra: Partial<SyncRequest> = {}): SyncRequest {
    return {
      workspaceId: scope.workspaceId, sourceId: scope.sourceId, provider: "meta_ads", syncRunId: `sync_${randomUUID()}`,
      encryptionKey: KEY, windowSince: since, windowUntil: until, metaAdsRequestBudget: 50, ...extra,
    };
  }

  function insightRows(level: string, day: string, url: URL): Array<Record<string, unknown>> {
    const video = (url.searchParams.get("fields") ?? "").includes("video_thruplay_watched_actions");
    const base = { date_start: day, spend: "50", clicks: "10", impressions: "1000", reach: "800", account_currency: "GBP", campaign_id: "c1", campaign_name: "Campaign", objective: "OUTCOME_LEADS", optimization_goal: "LEAD_GENERATION", actions: [{ action_type: "lead", "7d_click": "2" }], action_values: [] };
    // Meta returns a video list only when asked, and omits it for an image ad (a2).
    const withVideo = (row: Record<string, unknown>) => (video ? { ...row, video_thruplay_watched_actions: THRUPLAYS, video_play_actions: [{ action_type: "video_view", value: "40" }] } : row);
    if (level === "campaign") return [withVideo(base)];
    if (level === "adset") return [withVideo({ ...base, adset_id: "s1", adset_name: "UK buyers" })];
    return [
      withVideo({ ...base, adset_id: "s1", adset_name: "UK buyers", ad_id: "a1", ad_name: "Video ad" }),
      { ...base, spend: "20", adset_id: "s1", adset_name: "UK buyers", ad_id: "a2", ad_name: "Image ad" },
    ];
  }

  async function withMeta<T>(fixture: Fixture, run: () => Promise<T>): Promise<{ result: T; seen: Seen[] }> {
    const seen: Seen[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const headers = { "content-type": "application/json", "x-fb-ads-insights-throttle": JSON.stringify({ acc_id_util_pct: 11 }) };
      if (init?.method === "POST" && requestUrl.pathname === "/v25.0/") {
        const reads = JSON.parse(new URLSearchParams(String(init.body)).get("batch") ?? "[]") as Array<{ relative_url: string }>;
        const items = reads.map((read) => {
          const url = new URL(read.relative_url, "https://graph.facebook.com/v25.0/");
          seen.push({ method: "BATCH", url });
          const level = url.searchParams.get("level")!;
          return { code: 200, headers: [], body: JSON.stringify({ data: insightRows(level, fixture.day, url), paging: {} }) };
        });
        return new Response(JSON.stringify(items), { status: 200, headers });
      }
      seen.push({ method: init?.method ?? "GET", url: requestUrl });
      if (requestUrl.pathname.endsWith(`/${ACCOUNT}`)) {
        return new Response(JSON.stringify({ id: ACCOUNT, account_id: "123", currency: "GBP", timezone_name: "Europe/London" }), { status: 200, headers });
      }
      const edge = requestUrl.pathname.split("/").at(-1);
      if (edge === "campaigns") return new Response(JSON.stringify({ data: [{ id: "c1", name: "Campaign", objective: "OUTCOME_LEADS", status: "ACTIVE", effective_status: "ACTIVE" }], paging: {} }), { status: 200, headers });
      if (edge === "adsets") {
        const askedLearning = (requestUrl.searchParams.get("fields") ?? "").includes("learning_stage_info");
        const learning = askedLearning && fixture.learning ? { learning_stage_info: { ...LEARNING, status: fixture.learningStatus ?? LEARNING.status } } : {};
        return new Response(JSON.stringify({ data: [
          { id: "s1", campaign_id: "c1", name: "UK buyers", optimization_goal: "LEAD_GENERATION", status: "ACTIVE", effective_status: "ACTIVE", ...learning },
          { id: "s2", campaign_id: "c1", name: "No stage", optimization_goal: "LEAD_GENERATION", status: "ACTIVE", effective_status: "ACTIVE" },
        ], paging: {} }), { status: 200, headers });
      }
      if (edge === "ads") return new Response(JSON.stringify({ data: [
        { id: "a1", campaign_id: "c1", adset_id: "s1", name: "Video ad", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "cr1" } },
        { id: "a2", campaign_id: "c1", adset_id: "s1", name: "Image ad", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "cr2" } },
      ], paging: {} }), { status: 200, headers });
      if (edge === "insights") {
        const level = requestUrl.searchParams.get("level")!;
        const custom = fixture.insights?.(level, requestUrl);
        if (custom) return custom;
        return new Response(JSON.stringify({ data: insightRows(level, fixture.day, requestUrl), paging: {} }), { status: 200, headers });
      }
      throw new Error(`unexpected Meta URL ${requestUrl.toString()}`);
    }) as typeof fetch;
    try {
      return { result: await run(), seen };
    } finally {
      globalThis.fetch = original;
    }
  }

  const fieldsByLevel = (seen: Seen[]) => seen
    .filter((entry) => entry.url.pathname.endsWith("/insights"))
    .map((entry) => [entry.url.searchParams.get("level"), entry.url.searchParams.get("fields")]);
  const edgeFields = (seen: Seen[], edge: string) => seen.filter((entry) => entry.url.pathname.endsWith(`/${edge}`)).map((entry) => entry.url.searchParams.get("fields"));
  const requestShape = (seen: Seen[]) => seen.map((entry) => `${entry.method} ${entry.url.pathname}?${[...entry.url.searchParams].filter(([key]) => key !== "updated_since").map(([k, v]) => `${k}=${v}`).join("&")}`);

  async function primed(): Promise<{ workspaceId: string; sourceId: string }> {
    const scope = await seedSource();
    await withMeta({ day: "2026-09-01" }, () => connectorFor("meta_ads").sync(db, request(scope, "2026-09-01", "2026-09-01")));
    return scope;
  }

  const oneDay = (scope: { workspaceId: string; sourceId: string }, day: string, lane: SyncRequest["metaAdsRequestLane"], extendedReads?: boolean): SyncRequest =>
    request(scope, day, day, { metaAdsSyncMode: "insights_only", metaAdsRequestLane: lane, metaAdsRequestBudget: 12, ...(extendedReads === undefined ? {} : { metaAdsExtendedReads: extendedReads }) });

  it("switch OFF: the settled one-day batch asks for today's exact base fields and stores no video key", async () => {
    const scope = await primed();
    const { seen } = await withMeta({ day: "2026-09-02" }, () => connectorFor("meta_ads").sync(db, oneDay(scope, "2026-09-02", "settled_history")));
    expect(fieldsByLevel(seen)).toEqual([
      ["campaign", BASE],
      ["adset", `adset_id,adset_name,${BASE}`],
      ["ad", `ad_id,ad_name,adset_id,${BASE}`],
    ]);
    const raw = await db.query<{ keys: string[] }>(
      "select array(select jsonb_object_keys(actions_raw) order by 1) as keys from meta_ads_ad_daily where source_id=$1 and occurred_on='2026-09-02'",
      [scope.sourceId],
    );
    expect(raw.map((row) => row.keys)).toEqual([["action_values", "actions", "provider_result_evidence"], ["action_values", "actions", "provider_result_evidence"]]);
  }, 120_000);

  it("switch OFF (unset or false) and ON-but-wrong-lane send byte-identical requests", async () => {
    const shapes: string[][] = [];
    for (const [lane, flag] of [["settled_history", undefined], ["settled_history", false], ["hot_insights", undefined], ["hot_insights", true], ["attended_refresh", undefined], ["attended_refresh", true]] as const) {
      const scope = await primed();
      const { seen } = await withMeta({ day: "2026-09-02" }, () => connectorFor("meta_ads").sync(db, oneDay(scope, "2026-09-02", lane, flag)));
      shapes.push(requestShape(seen));
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[3]).toEqual(shapes[2]);
    expect(shapes[5]).toEqual(shapes[4]);
    for (const shape of shapes) expect(shape.join("\n")).not.toContain("video_");
  }, 240_000);

  it("switch ON (settled_history): exactly the video fields ride the SAME three calls; requested-but-omitted is []", async () => {
    const scope = await primed();
    const run = oneDay(scope, "2026-09-02", "settled_history", true);
    const { seen } = await withMeta({ day: "2026-09-02" }, () => connectorFor("meta_ads").sync(db, run));
    expect(fieldsByLevel(seen)).toEqual([
      ["campaign", `${BASE},${VIDEO}`],
      ["adset", `adset_id,adset_name,${BASE},${VIDEO}`],
      ["ad", `ad_id,ad_name,adset_id,${BASE},${VIDEO}`],
    ]);
    expect((await db.query<{ requests: number }>("select (request_telemetry->>'requestCount')::integer as requests from sync_runs where id=$1", [run.syncRunId]))[0]?.requests).toBe(3);
    const ads = await db.query<{ ad_id: string; thruplays: unknown; p25: unknown }>(
      "select ad_id, actions_raw->'video_thruplay_watched_actions' as thruplays, actions_raw->'video_p25_watched_actions' as p25 from meta_ads_ad_daily where source_id=$1 and occurred_on='2026-09-02' order by ad_id",
      [scope.sourceId],
    );
    expect(ads).toEqual([
      { ad_id: "a1", thruplays: THRUPLAYS, p25: [] },
      { ad_id: "a2", thruplays: [], p25: [] },
    ]);
    // The day before was read with the switch off: its video keys stay ABSENT (unknown), never [].
    expect(await db.query("select actions_raw ? 'video_thruplay_watched_actions' as has from meta_ads_ad_daily where source_id=$1 and occurred_on='2026-09-01' limit 1", [scope.sourceId]))
      .toEqual([{ has: false }]);
  }, 120_000);

  it("switch ON never extends a window that reaches today in the account's timezone (settled days only)", async () => {
    const scope = await primed();
    const today = localDay("Europe/London");
    const { seen } = await withMeta({ day: today }, () => connectorFor("meta_ads").sync(db, oneDay(scope, today, "settled_history", true)));
    expect(fieldsByLevel(seen).map(([, fields]) => fields?.includes("video_"))).toEqual([false, false, false]);
  }, 120_000);

  it("switch ON (history_backfill full run): window + ad passes extended, learning stored apart and never mints a version", async () => {
    const scope = await seedSource();
    const backfill = (status?: string) => request(scope, "2026-09-03", "2026-09-04", { metaAdsRequestLane: "history_backfill", metaAdsExtendedReads: true });
    const first = await withMeta({ day: "2026-09-03", learning: true }, () => connectorFor("meta_ads").sync(db, backfill()));
    expect(fieldsByLevel(first.seen)).toEqual([
      ["campaign", `${BASE},${VIDEO}`],
      ["adset", `adset_id,adset_name,${BASE},${VIDEO}`],
      ["ad", `ad_id,ad_name,adset_id,${BASE},${VIDEO}`],
    ]);
    expect(edgeFields(first.seen, "adsets")).toEqual([`${ADSET_EDGE_FIELDS},learning_stage_info`]);
    const versions = async () => db.query<{ n: number; leaked: number }>(
      "select count(*)::int as n, count(*) filter (where metadata_json ? 'learning_stage_info')::int as leaked from meta_ads_entity_versions where source_id=$1 and entity_type='adset'",
      [scope.sourceId],
    );
    expect(await versions()).toEqual([{ n: 2, leaked: 0 }]);
    // The stage moves (LEARNING → SUCCESS); the ad sets did not change, so NO new version is minted.
    await db.query("update sync_cursors set cursor_value='2020-01-01T00:00:00.000Z' where source_id=$1 and cursor_key like 'meta_ads_entities_full:%'", [scope.sourceId]);
    await withMeta({ day: "2026-09-03", learning: true, learningStatus: "SUCCESS" }, () => connectorFor("meta_ads").sync(db, backfill("SUCCESS")));
    expect(await versions()).toEqual([{ n: 2, leaked: 0 }]);
    const learning = await db.query<{ adset_id: string; status: string | null; conversions: string | null; last_sig_edit_ts: string | null; observed_on: string | null }>(
      "select adset_id, status, conversions::text, last_sig_edit_ts::text, observed_on::text from meta_ads_adset_learning_observations where source_id=$1 order by observed_at, adset_id",
      [scope.sourceId],
    );
    expect(learning.map((row) => [row.adset_id, row.status])).toEqual([["s1", "LEARNING"], ["s2", null], ["s1", "SUCCESS"], ["s2", null]]);
    expect(learning[0]).toMatchObject({ conversions: "12", observed_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(learning[0]!.last_sig_edit_ts).not.toBeNull();
  }, 120_000);

  it("inventory_sync: the learning stage rides the ad set edge read (0 extra calls); switch OFF asks for it nowhere", async () => {
    const scope = await primed();
    const off = await withMeta({ day: "2026-09-02", learning: true }, () => connectorFor("meta_ads").sync(db, request(scope, "2026-09-02", "2026-09-02", { metaAdsSyncMode: "inventory_only", metaAdsRequestLane: "inventory_sync" })));
    const on = await withMeta({ day: "2026-09-02", learning: true }, () => connectorFor("meta_ads").sync(db, request(scope, "2026-09-02", "2026-09-02", { metaAdsSyncMode: "inventory_only", metaAdsRequestLane: "inventory_sync", metaAdsExtendedReads: true })));
    expect(edgeFields(off.seen, "adsets").every((fields) => !fields?.includes("learning_stage_info"))).toBe(true);
    expect(edgeFields(on.seen, "adsets")).toEqual(edgeFields(off.seen, "adsets").map((fields) => `${fields},learning_stage_info`));
    expect(on.seen.length).toBe(off.seen.length);
    const rows = await db.query<{ adset_id: string; status: string | null; observed_on: string | null }>(
      "select adset_id, status, observed_on::text from meta_ads_adset_learning_observations where source_id=$1 order by adset_id",
      [scope.sourceId],
    );
    expect(rows.map((row) => [row.adset_id, row.status])).toEqual([["s1", "LEARNING"], ["s2", null]]);
    expect(rows[0]!.observed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 120_000);

  describe("weekly ad set breakdown", () => {
    const week = { since: "2026-09-21", until: "2026-09-27" };
    const breakdownRows = [
      { adset_id: "s1", device_platform: "mobile_app", spend: "40", impressions: "900", reach: "700", clicks: "9", inline_link_clicks: "7", actions: [{ action_type: "lead", value: "2" }], account_currency: "GBP" },
      { adset_id: "s1", device_platform: "desktop", spend: "10", impressions: "100", reach: "90", clicks: "1", inline_link_clicks: "1", account_currency: "GBP" },
    ];

    it("reads ONE dimension over a settled window and writes rows + a coverage receipt", async () => {
      const scope = await primed();
      const { result, seen } = await withMeta({ day: week.until, insights: () => new Response(JSON.stringify({ data: breakdownRows, paging: {} }), { status: 200 }) }, () =>
        syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...scope, ...week, dimension: "device_platform", requestBudget: 1 }));
      expect(seen).toHaveLength(1);
      const url = seen[0]!.url;
      expect(url.searchParams.get("breakdowns")).toBe("device_platform");
      expect(url.searchParams.get("level")).toBe("adset");
      expect(url.searchParams.get("time_increment")).toBe("all_days");
      expect(url.searchParams.get("time_range")).toBe(JSON.stringify(week));
      expect(url.searchParams.get("fields")).not.toContain("video_");
      expect(result).toMatchObject({ rowCount: 2, dimension: "device_platform" });
      expect(result.telemetry.requestCount).toBe(1);
      expect(await db.query("select dimension_value, spend::float8 as spend, reach::int as reach, actions_raw from meta_ads_adset_breakdown_windows where source_id=$1 order by dimension_value", [scope.sourceId]))
        .toEqual([
          { dimension_value: "desktop", spend: 10, reach: 90, actions_raw: { actions: [], action_values: [] } },
          { dimension_value: "mobile_app", spend: 40, reach: 700, actions_raw: { actions: [{ action_type: "lead", value: "2" }], action_values: [] } },
        ]);
      expect(await db.query("select dimension, row_count from meta_ads_breakdown_coverage where source_id=$1", [scope.sourceId]))
        .toEqual([{ dimension: "device_platform", row_count: 2 }]);
    }, 120_000);

    it("an empty answer is a measured none (coverage row_count 0), a re-read replaces the window", async () => {
      const scope = await primed();
      await withMeta({ day: week.until, insights: () => new Response(JSON.stringify({ data: breakdownRows, paging: {} }), { status: 200 }) }, () =>
        syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...scope, ...week, dimension: "device_platform", requestBudget: 1 }));
      await withMeta({ day: week.until, insights: () => new Response(JSON.stringify({ data: [], paging: {} }), { status: 200 }) }, () =>
        syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...scope, ...week, dimension: "device_platform", requestBudget: 1 }));
      expect(await db.query("select adset_id from meta_ads_adset_breakdown_windows where source_id=$1", [scope.sourceId])).toEqual([]);
      expect(await db.query("select row_count from meta_ads_breakdown_coverage where source_id=$1", [scope.sourceId])).toEqual([{ row_count: 0 }]);
    }, 120_000);

    it("never crosses its request ceiling: a second page over budget writes nothing (still unmeasured)", async () => {
      const scope = await primed();
      const paged = (_level: string, url: URL) => url.searchParams.has("after")
        ? new Response(JSON.stringify({ data: [breakdownRows[1]], paging: {} }), { status: 200 })
        : new Response(JSON.stringify({ data: [breakdownRows[0]], paging: { next: `https://graph.facebook.com/v25.0/${ACCOUNT}/insights?level=adset&after=p2` } }), { status: 200 });
      const { seen } = await withMeta({ day: week.until, insights: paged }, async () => {
        await expect(syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...scope, ...week, dimension: "device_platform", requestBudget: 1 }))
          .rejects.toMatchObject({ code: "provider_rate_budget_exhausted" });
      });
      expect(seen).toHaveLength(1);
      expect(await db.query("select 1 from meta_ads_breakdown_coverage where source_id=$1", [scope.sourceId])).toEqual([]);
      expect(await db.query("select 1 from meta_ads_adset_breakdown_windows where source_id=$1", [scope.sourceId])).toEqual([]);
    }, 120_000);

    it("refuses with 0 calls: a window reaching today, two dimensions, an unknown account timezone", async () => {
      const scope = await primed();
      const today = localDay("Europe/London");
      const { seen } = await withMeta({ day: today }, async () => {
        await expect(syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...scope, since: today, until: today, dimension: "device_platform", requestBudget: 1 }))
          .rejects.toThrow(/settled days only/);
        await expect(syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...scope, ...week, dimension: "platform_position" as never, requestBudget: 1 }))
          .rejects.toThrow(/dimension is not supported/);
        const fresh = await seedSource();
        await expect(syncMetaAdsAdsetBreakdownWindow(db, CREDENTIAL, { ...fresh, ...week, dimension: "device_platform", requestBudget: 1 }))
          .rejects.toThrow(/stored account timezone/);
      });
      expect(seen).toEqual([]);
    }, 120_000);
  });

  describe("one-shot probe", () => {
    const tables = ["meta_ads_ad_daily", "meta_ads_adset_learning_observations", "meta_ads_adset_breakdown_windows", "meta_ads_breakdown_coverage", "meta_ads_entity_versions", "sync_runs"];
    const counts = async () => Promise.all(tables.map(async (table) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0]!.n));

    it("makes at most 3 calls, each exactly the real read's shape with limit=1, and stores nothing", async () => {
      const before = await counts();
      const { result, seen } = await withMeta({ day: "2026-09-28", learning: true }, () =>
        probeMetaAdsExtendedReads(CREDENTIAL, { adAccountId: ACCOUNT, settledDay: "2026-09-28", maxRequests: 3 }));
      expect(seen.map((entry) => entry.url.pathname.split("/").at(-1))).toEqual(["insights", "adsets", "insights"]);
      expect(seen.every((entry) => entry.url.searchParams.get("limit") === "1")).toBe(true);
      expect(seen[0]!.url.searchParams.get("fields")).toBe(`adset_id,adset_name,${BASE},${VIDEO}`);
      expect(seen[1]!.url.searchParams.get("fields")).toBe("id,learning_stage_info");
      expect(seen[2]!.url.searchParams.get("breakdowns")).toBe("device_platform");
      expect(result.calls.map((call) => [call.call, call.accepted])).toEqual([["insights_extended", true], ["adset_learning", true], ["breakdown_device", true]]);
      expect(result.calls[1]!.rowKeys).toContain("learning_stage_info");
      expect(result.apiVersion).toBe("v25.0");
      expect(await counts()).toEqual(before);
    }, 120_000);

    it("reports Meta's own refusal per call and stops at a throttle", async () => {
      const refusal = new Response(JSON.stringify({ error: { message: "(#100) video_p95_watched_actions is not valid for fields param", code: 100, error_subcode: 1487851 } }), { status: 400 });
      const throttle = () => new Response(JSON.stringify({ error: { message: "User request limit reached", code: 17, error_subcode: 2446079 } }), { status: 400 });
      const { result, seen } = await withMeta({ day: "2026-09-28", insights: (_level, url) => url.searchParams.has("breakdowns") ? throttle() : refusal.clone() }, () =>
        probeMetaAdsExtendedReads(CREDENTIAL, { adAccountId: "123", settledDay: "2026-09-28", maxRequests: 3 }));
      expect(seen).toHaveLength(3);
      expect(result.calls[0]).toMatchObject({ call: "insights_extended", accepted: false, code: 100, subcode: 1487851, message: expect.stringContaining("video_p95_watched_actions") });
      expect(result.calls[2]).toMatchObject({ call: "breakdown_device", accepted: false, code: 17, subcode: 2446079 });
    }, 120_000);

    it("honours a smaller allowance and refuses a different account with 0 calls", async () => {
      const { result, seen } = await withMeta({ day: "2026-09-28" }, () => probeMetaAdsExtendedReads(CREDENTIAL, { adAccountId: ACCOUNT, settledDay: "2026-09-28", maxRequests: 1 }));
      expect(seen).toHaveLength(1);
      expect(result.calls).toHaveLength(1);
      const other = await withMeta({ day: "2026-09-28" }, async () => {
        await expect(probeMetaAdsExtendedReads(CREDENTIAL, { adAccountId: "act_999", settledDay: "2026-09-28", maxRequests: 3 })).rejects.toMatchObject({ code: "source_scope_mismatch" });
      });
      expect(other.seen).toEqual([]);
    }, 120_000);
  });
});
