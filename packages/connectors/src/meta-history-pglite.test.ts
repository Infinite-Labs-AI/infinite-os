import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { connectorFor, metaAdsSettledWindow, type SyncRequest } from "./index.js";
import { canonicalMetaAdsJson, metaAdsEntityVersionFingerprint } from "./meta-entity-fingerprint.js";

const KEY = "meta-history-pglite-encryption-key";
const ACCOUNT = "act_123";

type MetaFixture = {
  campaigns: Array<Record<string, unknown>>;
  adsets: Array<Record<string, unknown>>;
  ads: Array<Record<string, unknown>>;
  campaignInsights: Array<Record<string, unknown>>;
  adsetInsights: Array<Record<string, unknown>>;
  adInsights: Array<Record<string, unknown>>;
  failLevel?: "campaign" | "adset" | "ad";
  edgeResponse?: (edge:string,url:URL)=>Response|undefined;
  onBatch?: (relativeUrls: string[]) => void;
  batchItem?: (level: "campaign" | "adset" | "ad", url: URL, rows: Array<Record<string, unknown>>) => {
    code?: number;
    body?: unknown;
    utilization?: number;
  };
  outerBatchResponse?: Response;
  onRequest?: (url: URL, init?: RequestInit) => void;
  /**
   * Model Meta's documented insights behaviour for archived/deleted objects: a row carrying
   * `__status` ARCHIVED or DELETED is omitted from `level=<grain>` results unless the request
   * filters `<grain>.effective_status` IN a list naming that status ("Manage Your Ad Object's
   * Status"). `__status` is stripped from every returned row.
   */
  metaStatusSemantics?: boolean;
};

/** Apply Meta's archived/deleted omission to insights rows at `level` for the request `url`. */
function metaVisibleInsightRows(fixture: MetaFixture, level: string, url: URL, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!fixture.metaStatusSemantics) return rows;
  const filters = JSON.parse(url.searchParams.get("filtering") ?? "[]") as Array<{ field: string; operator: string; value: string[] }>;
  const included = new Set(filters.find(filter => filter.field === `${level}.effective_status` && filter.operator === "IN")?.value ?? []);
  return rows
    .filter(row => {
      const status = typeof row.__status === "string" ? row.__status : "ACTIVE";
      return (status !== "ARCHIVED" && status !== "DELETED") || included.has(status);
    })
    .map(({ __status: _status, ...row }) => row);
}

describe("Meta Ads history CLOSE against real PGlite", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-meta-history-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedSource(
    workspaceId: string,
    sourceId: string,
    options: { sourceAccount?: string; credentialAccount?: string } = {},
  ): Promise<void> {
    const sourceAccount = options.sourceAccount ?? ACCOUNT;
    const credentialAccount = options.credentialAccount ?? ACCOUNT;
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const datasets = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'web'",
      [workspaceId],
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1,$2,$3,'meta_ads','Meta history',$4,'connected')`,
      [sourceId, workspaceId, datasets[0]!.id, sourceAccount],
    );
    await db.query(
      `insert into connection_credentials
        (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'marketing_api_access_token',$4)`,
      [
        `cred_${randomUUID()}`,
        workspaceId,
        sourceId,
        encryptCredentialPayload(
          { mode: "live", transport: "meta_ads_cli", adAccountId: credentialAccount, accessToken: "test-token", apiVersion: "v25.0" },
          KEY,
        ),
      ],
    );
  }

  function syncRequest(workspaceId: string, sourceId: string, since: string, until: string): SyncRequest {
    return {
      workspaceId,
      sourceId,
      provider: "meta_ads",
      syncRunId: `sync_${randomUUID()}`,
      encryptionKey: KEY,
      windowSince: since,
      windowUntil: until,
      metaAdsRequestBudget: 50,
    };
  }

  async function withMetaFetch<T>(fixture: MetaFixture, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      fixture.onRequest?.(requestUrl, init);
      const headers = {
        "content-type": "application/json",
        "x-fb-ads-insights-throttle": JSON.stringify({ acc_id_util_pct: 11 }),
      };
      if (init?.method === "POST" && requestUrl.pathname === "/v25.0/") {
        if (fixture.outerBatchResponse) return fixture.outerBatchResponse;
        const form = new URLSearchParams(String(init.body));
        const reads = JSON.parse(form.get("batch") ?? "[]") as Array<{ method: string; relative_url: string }>;
        fixture.onBatch?.(reads.map((read) => read.relative_url));
        const items = reads.map((read) => {
          const url = new URL(read.relative_url, "https://graph.facebook.com/v25.0/");
          const level = url.searchParams.get("level") as "campaign" | "adset" | "ad";
          if (fixture.failLevel === level) {
            return { code: 500, headers: [], body: JSON.stringify({ error: { message: "fixture failure" } }) };
          }
          const rows = metaVisibleInsightRows(fixture, level, url, level === "campaign"
            ? fixture.campaignInsights
            : level === "adset"
              ? fixture.adsetInsights
              : fixture.adInsights);
          const custom = fixture.batchItem?.(level, url, rows);
          return {
            code: custom?.code ?? 200,
            headers: [{ name: "x-fb-ads-insights-throttle", value: JSON.stringify({ acc_id_util_pct: custom?.utilization ?? 11 }) }],
            body: JSON.stringify(custom?.body ?? { data: rows, paging: {} }),
          };
        });
        return new Response(JSON.stringify(items), { status: 200, headers });
      }
      if (requestUrl.pathname.endsWith(`/${ACCOUNT}`)) {
        return new Response(JSON.stringify({ id: ACCOUNT, account_id: "123", currency: "GBP", timezone_name: "Europe/London" }), { status: 200, headers });
      }
      const edge = requestUrl.pathname.split("/").at(-1);
      const custom=fixture.edgeResponse?.(edge ?? "",requestUrl);
      if(custom)return custom;
      if (edge === "campaigns") return new Response(JSON.stringify({ data: fixture.campaigns, paging: {} }), { status: 200, headers });
      if (edge === "adsets") return new Response(JSON.stringify({ data: fixture.adsets, paging: {} }), { status: 200, headers });
      if (edge === "ads") return new Response(JSON.stringify({ data: fixture.ads, paging: {} }), { status: 200, headers });
      if (edge === "insights") {
        const level = requestUrl.searchParams.get("level") as "campaign" | "adset" | "ad";
        if (fixture.failLevel === level) {
          return new Response(JSON.stringify({ error: { message: "fixture failure" } }), { status: 500, headers });
        }
        const rows = metaVisibleInsightRows(fixture, level, requestUrl, level === "campaign"
          ? fixture.campaignInsights
          : level === "adset"
            ? fixture.adsetInsights
            : fixture.adInsights);
        return new Response(JSON.stringify({ data: rows, paging: {} }), { status: 200, headers });
      }
      throw new Error(`unexpected Meta fixture URL ${requestUrl.toString()}`);
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  function fixture(day: string, options: { includeSecondAd?: boolean; changedStatus?: boolean; empty?: boolean } = {}): MetaFixture {
    const actions = [
      { action_type: "lead", "7d_click": "2", "1d_view": "1" },
      { action_type: "purchase", "7d_click": "1", "1d_view": "1" },
    ];
    const actionValues = [{ action_type: "purchase", "7d_click": "100", "1d_view": "25" }];
    const base = { date_start: day, spend: "50", clicks: "10", impressions: "1000", account_currency: "GBP", actions, action_values: actionValues };
    return {
      campaigns: [{ id: "c1", name: "Campaign", objective: "OUTCOME_LEADS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "10000" }],
      adsets: [{ id: "s1", campaign_id: "c1", name: "UK buyers", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", status: "ACTIVE", effective_status: "ACTIVE", targeting: { geo_locations: { countries: ["GB"] }, publisher_platforms: ["facebook", "instagram"] } }],
      ads: [
        { id: "a1", campaign_id: "c1", adset_id: "s1", name: "Ad one", status: options.changedStatus ? "PAUSED" : "ACTIVE", effective_status: options.changedStatus ? "PAUSED" : "ACTIVE", creative: { id: "cr1", title: "Hook", body: "Copy", image_hash: "img1", image_url: "https://scontent.xx.fbcdn.net/img1.jpg?oh=raw-signed-secret&oe=123", video_id: "123456789012345678", thumbnail_url: "https://scontent.xx.fbcdn.net/video-thumb.jpg?oh=thumb-secret", asset_feed_spec: { videos: [{ video_id: "v2" }] } } },
        ...(options.includeSecondAd ? [{ id: "a2", campaign_id: "c1", adset_id: "s1", name: "Ad two", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "cr2", video_id: "v1" } }] : []),
      ],
      campaignInsights: options.empty ? [] : [{ ...base, campaign_id: "c1", campaign_name: "Campaign", objective: "OUTCOME_LEADS", optimization_goal: "LEAD_GENERATION" }],
      adsetInsights: options.empty ? [] : [{ ...base, campaign_id: "c1", campaign_name: "Campaign", adset_id: "s1", adset_name: "UK buyers", objective: "OUTCOME_LEADS", optimization_goal: "LEAD_GENERATION" }],
      adInsights: options.empty ? [] : [
        { ...base, campaign_id: "c1", campaign_name: "Campaign", adset_id: "s1", adset_name: "UK buyers", ad_id: "a1", ad_name: "Ad one", objective: "OUTCOME_LEADS" },
        ...(options.includeSecondAd ? [{ ...base, spend: "20", campaign_id: "c1", campaign_name: "Campaign", adset_id: "s1", adset_name: "UK buyers", ad_id: "a2", ad_name: "Ad two", objective: "OUTCOME_LEADS" }] : []),
      ],
    };
  }

  function reversedObjectKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reversedObjectKeys);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).reverse().map(([key, entry]) => [key, reversedObjectKeys(entry)]),
    );
  }

  it("preserves missing reach as null and measured zero as zero at every stored grain", async () => {
    const workspaceId = `ws_meta_reach_${randomUUID()}`;
    const sourceId = `src_meta_reach_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    for (const [day, reach] of [["2026-09-01", undefined], ["2026-09-02", null], ["2026-09-03", ""], ["2026-09-04", "0"], ["2026-09-05", "  "]] as const) {
      const data = fixture(day);
      if (reach !== undefined) for (const rows of [data.campaignInsights, data.adsetInsights, data.adInsights]) {
        for (const row of rows) row.reach = reach;
      }
      await withMetaFetch(data, () => connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, day, day)));
    }
    for (const table of ["meta_ads_campaign_daily", "meta_ads_adset_daily", "meta_ads_ad_daily"]) {
      const rows = await db.query<{ reach: string | null }>(`select reach::text from ${table} where source_id=$1 order by occurred_on`, [sourceId]);
      expect(rows.map(row => row.reach)).toEqual([null, null, null, "0", null]);
      const columns = await db.query<{is_nullable:string; column_default:string|null}>(
        "select is_nullable,column_default from information_schema.columns where table_name=$1 and column_name='reach'", [table]);
      expect(columns).toEqual([{is_nullable:"YES",column_default:null}]);
    }
  });

  it("stores every ad-day, restates exact windows, publishes measured-zero coverage, and versions metadata", async () => {
    const workspaceId = `ws_meta_history_${randomUUID()}`;
    const sourceId = `src_meta_history_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    await withMetaFetch(fixture("2026-09-01", { includeSecondAd: true }), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-03"))
    );

    expect((await db.query<{ ad_id: string }>(
      "select ad_id from meta_ads_ad_daily where source_id = $1 order by ad_id",
      [sourceId],
    )).map((row) => row.ad_id)).toEqual(["a1", "a2"]);
    expect(await db.query(
      "select result_type, results::text, conversion_value::text, is_primary from meta_ads_ad_conversions_daily where source_id = $1 and ad_id = 'a1' order by is_primary desc, result_type",
      [sourceId],
    )).toEqual([
      { result_type: "lead", results: "3.000000", conversion_value: null, is_primary: true },
      { result_type: "purchase", results: "2.000000", conversion_value: "125.000000", is_primary: false },
    ]);
    expect(await db.query(
      "select currency, timezone_name from meta_ads_accounts where workspace_id = $1 and source_id = $2",
      [workspaceId, sourceId],
    )).toEqual([{ currency: "gbp", timezone_name: "Europe/London" }]);
    expect(await db.query(
      "select id from raw_records where source_id = $1 and payload::text like '%raw-signed-secret%'",
      [sourceId],
    )).toEqual([]);
    const creativeVersion = await db.query<{ metadata_json: unknown; asset_descriptors: unknown }>(
      "select metadata_json,asset_descriptors from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and valid_to is null",
      [sourceId],
    );
    expect(JSON.stringify(creativeVersion)).not.toContain("raw-signed-secret");
    expect(creativeVersion[0]?.asset_descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ slotKey: "creative.image", providerAssetId: "img1", providerAssetType: "image_hash", sourceUrl: null }),
      expect.objectContaining({ slotKey: "creative.thumbnail", providerAssetId: "123456789012345678", providerAssetType: "video_id", sourceUrl: null }),
    ]));
    const coverage = await db.query<{ grain: string; occurred_on: string; row_count: number }>(
      "select grain, occurred_on::text, row_count from meta_ads_coverage_daily where source_id = $1 order by grain, occurred_on",
      [sourceId],
    );
    expect(coverage).toHaveLength(9);
    expect(coverage.find((row) => row.grain === "ad" && row.occurred_on === "2026-09-01")?.row_count).toBe(2);
    expect(coverage.find((row) => row.grain === "ad" && row.occurred_on === "2026-09-02")?.row_count).toBe(0);
    expect((await db.query("select entity_id from meta_ads_snapshot_keys where source_id = $1", [sourceId]))).toEqual([]);

    const reordered = reversedObjectKeys(fixture("2026-09-01", { includeSecondAd: true })) as MetaFixture;
    await withMetaFetch(reordered, () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-03"))
    );
    expect(await db.query(
      "select id from meta_ads_entity_versions where source_id=$1",
      [sourceId],
    )).toHaveLength(6);

    await db.query(
      `insert into meta_ads_ad_daily
        (id,workspace_id,source_id,ad_account_id,campaign_id,adset_id,ad_id,ad_name,occurred_on,spend)
       values ('outside',$1,$2,$3,'c1','s1','outside','Outside','2026-08-31',1)`,
      [workspaceId, sourceId, ACCOUNT],
    );

    // Only a complete reconciliation may infer removal from absence.
    await db.query("update sync_cursors set cursor_value='2020-01-01T00:00:00.000Z' where source_id=$1 and cursor_key like 'meta_ads_entities_full:%'",[sourceId]);
    await withMetaFetch(fixture("2026-09-01", { changedStatus: true }), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-03"))
    );
    expect((await db.query<{ ad_id: string }>(
      "select ad_id from meta_ads_ad_daily where source_id = $1 order by ad_id",
      [sourceId],
    )).map((row) => row.ad_id)).toEqual(["a1", "outside"]);
    const versions = await db.query<{ entity_id: string; configured_status: string; valid_to: string | Date | null }>(
      "select entity_id, configured_status, valid_to from meta_ads_entity_versions where source_id = $1 and entity_type = 'ad' order by entity_id, first_observed_at",
      [sourceId],
    );
    expect(versions.filter((row) => row.entity_id === "a1")).toHaveLength(2);
    expect(versions.filter((row) => row.entity_id === "a1").at(-1)).toMatchObject({ configured_status: "PAUSED", valid_to: null });
    expect(versions.find((row) => row.entity_id === "a2")?.valid_to).not.toBeNull();

    await withMetaFetch(fixture("2026-09-01", { changedStatus: true, empty: true }), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-03"))
    );
    expect((await db.query<{ ad_id: string }>(
      "select ad_id from meta_ads_ad_daily where source_id = $1 order by ad_id",
      [sourceId],
    )).map((row) => row.ad_id)).toEqual(["outside"]);
    expect((await db.query<{ row_count: number }>(
      "select row_count from meta_ads_coverage_daily where source_id = $1 and grain = 'ad' order by occurred_on",
      [sourceId],
    )).map((row) => row.row_count)).toEqual([0, 0, 0]);
  }, 120_000);

  it("preserves sub-millisecond credential timestamps across a node-postgres sync claim", async () => {
    const workspaceId = `ws_meta_timestamp_${randomUUID()}`;
    const sourceId = `src_meta_timestamp_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await db.query(
      "update connection_credentials set updated_at='2026-09-15T17:26:35.839418Z'::timestamptz where source_id=$1",
      [sourceId],
    );

    // node-postgres decodes a raw timestamptz as a JavaScript Date, which truncates Postgres'
    // microseconds to milliseconds. Text-cast timestamps retain the complete credential version.
    const nodePostgresLikeDb: InfiniteOsDb = {
      ...db,
      async withTransaction<T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T> {
        return db.withTransaction(async (tx) => fn({
          ...tx,
          async one<R>(sql: string, params?: unknown[]): Promise<R | null> {
            const row = await tx.one<Record<string, unknown>>(sql, params);
            if (
              row
              && sql.includes("select id, updated_at")
              && !sql.includes("to_char(updated_at")
              && row.updated_at
            ) {
              return {
                ...row,
                updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
              } as R;
            }
            return row as R | null;
          },
        } as InfiniteOsDb));
      },
    };

    await expect(withMetaFetch(fixture("2026-09-04"), () =>
      connectorFor("meta_ads").sync(
        nodePostgresLikeDb,
        syncRequest(workspaceId, sourceId, "2026-09-04", "2026-09-04"),
      )
    )).resolves.toMatchObject({ provider: "meta_ads", recordsLoaded: expect.any(Number) });
    expect(await db.query(
      "select occurred_on from meta_ads_coverage_daily where source_id=$1",
      [sourceId],
    )).toHaveLength(3);
  }, 120_000);

  it("rejects an updated-at-only credential change after the sync claim", async () => {
    const workspaceId = `ws_meta_timestamp_change_${randomUUID()}`;
    const sourceId = `src_meta_timestamp_change_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await db.query(
      "update connection_credentials set updated_at='2026-09-15T17:26:35.839418Z'::timestamptz where source_id=$1",
      [sourceId],
    );

    let transaction = 0;
    const racingDb: InfiniteOsDb = {
      ...db,
      async withTransaction<T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T> {
        transaction += 1;
        if (transaction === 2) {
          await db.query(
            "update connection_credentials set updated_at='2026-09-15T17:26:35.839419Z'::timestamptz where source_id=$1",
            [sourceId],
          );
        }
        return db.withTransaction(fn);
      },
    };

    await expect(withMetaFetch(fixture("2026-09-05"), () =>
      connectorFor("meta_ads").sync(
        racingDb,
        syncRequest(workspaceId, sourceId, "2026-09-05", "2026-09-05"),
      )
    )).rejects.toMatchObject({ code: "sync_claim_lost" });
    expect(await db.query(
      "select occurred_on from meta_ads_coverage_daily where source_id=$1",
      [sourceId],
    )).toEqual([]);
  }, 120_000);

  it("records failed request spend but leaves facts, coverage, and cursor unchanged", async () => {
    const workspaceId = `ws_meta_failure_${randomUUID()}`;
    const sourceId = `src_meta_failure_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const first = syncRequest(workspaceId, sourceId, "2026-09-10", "2026-09-10");
    await withMetaFetch(fixture("2026-09-10"), () => connectorFor("meta_ads").sync(db, first));

    const failed = syncRequest(workspaceId, sourceId, "2026-09-11", "2026-09-11");
    await expect(withMetaFetch({ ...fixture("2026-09-11"), failLevel: "campaign" }, () =>
      connectorFor("meta_ads").sync(db, failed)
    )).rejects.toThrow(/fixture failure/);

    expect(await db.query("select occurred_on from meta_ads_ad_daily where source_id = $1", [sourceId])).toHaveLength(1);
    expect(await db.query(
      "select occurred_on from meta_ads_coverage_daily where source_id = $1 and occurred_on = '2026-09-11'",
      [sourceId],
    )).toEqual([]);
    expect(await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'meta_ads_campaign_daily'",
      [sourceId],
    )).toEqual([{ cursor_value: "2026-09-10" }]);
    const telemetry = await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id = $1",
      [failed.syncRunId],
    );
    expect(telemetry[0]?.request_telemetry).toMatchObject({ provider: "meta_ads", requestCount: 5 });
  }, 120_000);

  it("rejects a source/account credential mismatch before any provider request or history write", async () => {
    const workspaceId = `ws_meta_binding_${randomUUID()}`;
    const sourceId = `src_meta_binding_${randomUUID()}`;
    await seedSource(workspaceId, sourceId, { sourceAccount: "act_999", credentialAccount: ACCOUNT });
    let providerCalls = 0;
    await expect(withMetaFetch(fixture("2026-09-12"), async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        providerCalls += 1;
        return original(...args);
      }) as typeof fetch;
      try {
        return await connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-12", "2026-09-12"));
      } finally {
        globalThis.fetch = original;
      }
    })).rejects.toMatchObject({ code: "source_scope_mismatch" });
    expect(providerCalls).toBe(0);
    expect(await db.query("select id from meta_ads_ad_daily where source_id=$1", [sourceId])).toEqual([]);
    expect(await db.query("select occurred_on from meta_ads_coverage_daily where source_id=$1", [sourceId])).toEqual([]);
  }, 120_000);

  it("keeps URL-only creative slots without retaining capability URLs", async () => {
    const workspaceId = `ws_meta_url_slots_${randomUUID()}`;
    const sourceId = `src_meta_url_slots_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    const urlFixture = fixture("2026-09-13");
    urlFixture.ads = [{
      id: "a_url",
      campaign_id: "c1",
      adset_id: "s1",
      name: "URL-only ad",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      creative: {
        id: "cr_url",
        title: "URL-only creative",
        body: "Copy",
        image_url: "https://scontent.xx.fbcdn.net/v/t39.30808-6/url-only.jpg?oh=signed-image&oe=123#frag",
        thumbnail_url: "https://lookaside.fbsbx.com/v/t39/thumb.jpg?token=signed-thumb",
        asset_feed_spec: {
          images: [{ url: "https://scontent.xx.fbcdn.net/v/asset-feed.jpg?oh=signed-asset" }],
        },
        object_story_spec: {
          link_data: {
            child_attachments: [
              { picture: "https://scontent.xx.fbcdn.net/v/carousel-0.jpg?stp=signed-carousel" },
            ],
          },
          photo_data: {
            id: "photo_123",
            picture: "https://scontent.xx.fbcdn.net/v/story-photo.jpg?oh=signed-story-photo",
          },
          template_data: {
            image_url: "https://scontent.xx.fbcdn.net/v/template-top.jpg?oh=signed-template-top",
            child_attachments: [
              { image_url: "https://scontent.xx.fbcdn.net/v/template-card.jpg?oh=signed-template-card" },
            ],
          },
        },
      },
    }];
    urlFixture.adInsights = [{
      ...urlFixture.adInsights[0],
      ad_id: "a_url",
      ad_name: "URL-only ad",
    }];

    await withMetaFetch(urlFixture, () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-13", "2026-09-13"))
    );

    const rows = await db.query<{ metadata_json: unknown; asset_descriptors: Array<Record<string, unknown>> }>(
      "select metadata_json,asset_descriptors from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id='cr_url' and valid_to is null",
      [sourceId],
    );
    expect(rows).toHaveLength(1);
    const descriptors = rows[0]!.asset_descriptors;
    expect(descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slotKey: "creative.image",
        kind: "image",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "scontent.xx.fbcdn.net", path: "/v/t39.30808-6/url-only.jpg" },
      }),
      expect.objectContaining({
        slotKey: "creative.thumbnail",
        kind: "thumbnail",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "lookaside.fbsbx.com", path: "/v/t39/thumb.jpg" },
      }),
      expect.objectContaining({
        slotKey: "asset_feed.images.0",
        kind: "image",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "scontent.xx.fbcdn.net", path: "/v/asset-feed.jpg" },
      }),
      expect.objectContaining({
        slotKey: "object_story.carousel.0",
        kind: "image",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "scontent.xx.fbcdn.net", path: "/v/carousel-0.jpg" },
      }),
      expect.objectContaining({
        slotKey: "object_story.photo",
        kind: "image",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "scontent.xx.fbcdn.net", path: "/v/story-photo.jpg" },
      }),
      expect.objectContaining({
        slotKey: "object_story.template",
        kind: "image",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "scontent.xx.fbcdn.net", path: "/v/template-top.jpg" },
      }),
      expect.objectContaining({
        slotKey: "object_story.template.carousel.0",
        kind: "image",
        providerAssetId: null,
        sourceUrl: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceLocator: { host: "scontent.xx.fbcdn.net", path: "/v/template-card.jpg" },
      }),
    ]));
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain("signed-image");
    expect(stored).not.toContain("signed-thumb");
    expect(stored).not.toContain("signed-asset");
    expect(stored).not.toContain("signed-carousel");
    expect(stored).not.toContain("signed-story-photo");
    expect(stored).not.toContain("signed-template-top");
    expect(stored).not.toContain("signed-template-card");
    expect(stored).not.toContain("?oh=");
    expect(stored).not.toContain("?token=");
    expect(stored).not.toContain("?stp=");
  }, 120_000);

  it("persists object_story photo_data image hashes as creative asset descriptors", async () => {
    const workspaceId = `ws_meta_photo_data_${randomUUID()}`;
    const sourceId = `src_meta_photo_data_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    const photoFixture = fixture("2026-09-14");
    photoFixture.ads = [{
      id: "a_photo",
      campaign_id: "c1",
      adset_id: "s1",
      name: "Photo ad",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      creative: {
        id: "crphoto",
        title: "Photo creative",
        body: "Copy",
        image_hash: null,
        object_story_spec: {
          photo_data: { image_hash: "realhash" },
        },
      },
    }];
    photoFixture.adInsights = [{
      ...photoFixture.adInsights[0],
      ad_id: "a_photo",
      ad_name: "Photo ad",
    }];

    await withMetaFetch(photoFixture, () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-14", "2026-09-14"))
    );

    const rows = await db.query<{ asset_descriptors: Array<Record<string, unknown>> }>(
      "select asset_descriptors from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and entity_id='crphoto' and valid_to is null",
      [sourceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.asset_descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slotKey: "object_story.photo",
        kind: "image",
        providerAssetId: "realhash",
        providerAssetType: "image_hash",
        sourceUrl: null,
        sourceLocator: null,
        slotFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    ]));
  }, 120_000);

  it("a partial 500-row chunk load never deletes stale facts or publishes coverage", async () => {
    const workspaceId = `ws_meta_partial_${randomUUID()}`;
    const sourceId = `src_meta_partial_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await db.query(
      `insert into meta_ads_campaign_daily
        (id,workspace_id,source_id,ad_account_id,campaign_id,campaign_name,occurred_on,spend)
       values ('stale-partial',$1,$2,$3,'stale','Stale','2026-09-20',1)`,
      [workspaceId, sourceId, ACCOUNT],
    );
    const rows = Array.from({ length: 501 }, (_, index) => ({
      campaign_id: `c${index}`,
      campaign_name: `Campaign ${index}`,
      date_start: "2026-09-20",
      spend: "1",
      account_currency: "GBP",
      objective: "OUTCOME_AWARENESS",
    }));
    const inner = db;
    let transaction = 0;
    const failingDb: InfiniteOsDb = {
      ...inner,
      withTransaction: async (fn) => {
        transaction += 1;
        if (transaction === 4) throw new Error("forced second history chunk failure");
        return inner.withTransaction(fn);
      },
    };
    const request = syncRequest(workspaceId, sourceId, "2026-09-20", "2026-09-20");
    await expect(withMetaFetch({
      campaigns: [], adsets: [], ads: [], campaignInsights: rows, adsetInsights: [], adInsights: [],
    }, () => connectorFor("meta_ads").sync(failingDb, request))).rejects.toThrow(/forced second history chunk failure/);

    expect(await db.query(
      "select id from meta_ads_campaign_daily where source_id = $1 and campaign_id = 'stale'",
      [sourceId],
    )).toHaveLength(1);
    expect(await db.query("select occurred_on from meta_ads_coverage_daily where source_id = $1", [sourceId])).toEqual([]);
    expect(await db.query("select id from sync_cursors where source_id = $1", [sourceId])).toEqual([]);
    expect(await db.query("select entity_id from meta_ads_snapshot_keys where source_id = $1", [sourceId])).toEqual([]);
  }, 120_000);

  it("does not close, prune, publish coverage, or resurrect a source revoked after load", async () => {
    const workspaceId = `ws_meta_revoke_close_${randomUUID()}`;
    const sourceId = `src_meta_revoke_close_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await db.query(
      `insert into meta_ads_ad_daily
        (id,workspace_id,source_id,ad_account_id,campaign_id,adset_id,ad_id,ad_name,occurred_on,spend)
       values ('stale-revoke-close',$1,$2,$3,'c1','s1','stale-close','Stale close','2026-09-21',1)`,
      [workspaceId, sourceId, ACCOUNT],
    );

    const inner = db;
    let transaction = 0;
    let revoked = false;
    const racingDb: InfiniteOsDb = {
      ...inner,
      withTransaction: async (fn) => {
        transaction += 1;
        if (transaction === 4 && !revoked) {
          revoked = true;
          await inner.query("update sources set status='revoked' where id = $1", [sourceId]);
          await inner.query(
            "update connection_credentials set revoked_at=now(), updated_at='2030-01-01T00:00:00Z'::timestamptz where source_id = $1 and revoked_at is null",
            [sourceId],
          );
        }
        return inner.withTransaction(fn);
      },
    };

    const request = syncRequest(workspaceId, sourceId, "2026-09-21", "2026-09-21");
    await expect(withMetaFetch(fixture("2026-09-21"), () =>
      connectorFor("meta_ads").sync(racingDb, request)
    )).rejects.toMatchObject({ code: "sync_claim_lost" });

    expect(await db.query(
      "select id from meta_ads_ad_daily where source_id = $1 and ad_id = 'stale-close'",
      [sourceId],
    )).toHaveLength(1);
    expect(await db.query("select occurred_on from meta_ads_coverage_daily where source_id = $1", [sourceId])).toEqual([]);
    expect(await db.query("select id from sync_cursors where source_id = $1", [sourceId])).toEqual([]);
    expect(await db.query("select entity_id from meta_ads_snapshot_keys where source_id = $1", [sourceId])).toEqual([]);
    expect(await db.query<{ status: string }>("select status from sources where id = $1", [sourceId])).toEqual([{ status: "revoked" }]);
  }, 120_000);

  it("does not count stale chunk failures against a source that reconnected during the run", async () => {
    const workspaceId = `ws_meta_reconnect_partial_${randomUUID()}`;
    const sourceId = `src_meta_reconnect_partial_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await db.query(
      `insert into meta_ads_campaign_daily
        (id,workspace_id,source_id,ad_account_id,campaign_id,campaign_name,occurred_on,spend)
       values ('stale-reconnect-partial',$1,$2,$3,'stale','Stale','2026-09-22',1)`,
      [workspaceId, sourceId, ACCOUNT],
    );
    const rows = Array.from({ length: 501 }, (_, index) => ({
      campaign_id: `rc${index}`,
      campaign_name: `Reconnect Campaign ${index}`,
      date_start: "2026-09-22",
      spend: "1",
      account_currency: "GBP",
      objective: "OUTCOME_AWARENESS",
    }));

    const inner = db;
    let transaction = 0;
    let reconnected = false;
    const failingDb: InfiniteOsDb = {
      ...inner,
      withTransaction: async (fn) => {
        transaction += 1;
        if (transaction === 4 && !reconnected) {
          reconnected = true;
          await inner.query(
            `update sources
             set status='connected', consecutive_sync_failures=0, last_counted_sync_failure_at=null
             where id = $1`,
            [sourceId],
          );
          await inner.query(
            `update connection_credentials
             set encrypted_payload=$2, updated_at='2030-01-01T00:00:00Z'::timestamptz
             where source_id=$1 and revoked_at is null`,
            [
              sourceId,
              encryptCredentialPayload(
                { mode: "live", transport: "meta_ads_cli", adAccountId: ACCOUNT, accessToken: "new-token", apiVersion: "v25.0" },
                KEY,
              ),
            ],
          );
          throw new Error("forced second history chunk failure after reconnect");
        }
        return inner.withTransaction(fn);
      },
    };

    const request = syncRequest(workspaceId, sourceId, "2026-09-22", "2026-09-22");
    await expect(withMetaFetch({
      campaigns: [], adsets: [], ads: [], campaignInsights: rows, adsetInsights: [], adInsights: [],
    }, () => connectorFor("meta_ads").sync(failingDb, request))).rejects.toThrow(/forced second history chunk failure after reconnect/);

    expect(await db.query(
      "select id from meta_ads_campaign_daily where source_id = $1 and campaign_id = 'stale'",
      [sourceId],
    )).toHaveLength(1);
    expect(await db.query("select occurred_on from meta_ads_coverage_daily where source_id = $1", [sourceId])).toEqual([]);
    expect(await db.query("select id from sync_cursors where source_id = $1", [sourceId])).toEqual([]);
    const sourceRows = await db.query<{
      status: string;
      consecutive_sync_failures: number;
      last_counted_sync_failure_at: string | Date | null;
    }>(
      "select status, consecutive_sync_failures, last_counted_sync_failure_at from sources where id = $1",
      [sourceId],
    );
    expect(sourceRows).toEqual([{ status: "connected", consecutive_sync_failures: 0, last_counted_sync_failure_at: null }]);
  }, 120_000);

  // §5 Test A (durable Meta history sync) — proves the finer-window CLOSE is composable and
  // all-or-nothing, and that a graceful soft-time-budget interruption leaves a RESUMABLE gap the
  // next run closes (never a stranded `syncing`).
  it("closes a 7-day window and composes an adjacent window without double-counting", async () => {
    const workspaceId = `ws_meta_compose_${randomUUID()}`;
    const sourceId = `src_meta_compose_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    // (A.1) A 7-day window [D1,D7] closes: coverage = 7 days × 3 grains, source connected, cursor at D7.
    await withMetaFetch(fixture("2026-10-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-10-01", "2026-10-07"))
    );
    const afterFirst = await db.query<{ total: number; days: number; grains: number; lo: string; hi: string }>(
      `select count(*)::int as total, count(distinct occurred_on)::int as days,
              count(distinct grain)::int as grains, min(occurred_on)::text as lo, max(occurred_on)::text as hi
         from meta_ads_coverage_daily where source_id = $1`,
      [sourceId],
    );
    expect(afterFirst).toEqual([{ total: 21, days: 7, grains: 3, lo: "2026-10-01", hi: "2026-10-07" }]);
    expect(await db.query<{ status: string }>("select status from sources where id = $1", [sourceId]))
      .toEqual([{ status: "connected" }]);
    expect(await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'meta_ads_campaign_daily'",
      [sourceId],
    )).toEqual([{ cursor_value: "2026-10-07" }]);

    // (A.2) The adjacent window [D8,D14] composes: coverage now spans [D1,D14] with NO double count
    // in the *_daily tables (the fixture emits one row per grain per window's D1, so exactly two
    // day-rows per entity survive — one at 2026-10-01, one at 2026-10-08 — not four).
    await withMetaFetch(fixture("2026-10-08"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-10-08", "2026-10-14"))
    );
    const afterSecond = await db.query<{ total: number; days: number; grains: number; lo: string; hi: string }>(
      `select count(*)::int as total, count(distinct occurred_on)::int as days,
              count(distinct grain)::int as grains, min(occurred_on)::text as lo, max(occurred_on)::text as hi
         from meta_ads_coverage_daily where source_id = $1`,
      [sourceId],
    );
    expect(afterSecond).toEqual([{ total: 42, days: 14, grains: 3, lo: "2026-10-01", hi: "2026-10-14" }]);
    // No double-count: one campaign/adset/ad day-row per populated day (2026-10-01 and 2026-10-08).
    expect(await db.query<{ occurred_on: string }>(
      "select occurred_on::text as occurred_on from meta_ads_campaign_daily where source_id = $1 and campaign_id = 'c1' order by occurred_on",
      [sourceId],
    )).toEqual([{ occurred_on: "2026-10-01" }, { occurred_on: "2026-10-08" }]);
    expect(await db.query<{ occurred_on: string }>(
      "select occurred_on::text as occurred_on from meta_ads_ad_daily where source_id = $1 and ad_id = 'a1' order by occurred_on",
      [sourceId],
    )).toEqual([{ occurred_on: "2026-10-01" }, { occurred_on: "2026-10-08" }]);
    expect(await db.query<{ occurred_on: string }>(
      "select occurred_on::text as occurred_on from meta_ads_adset_daily where source_id = $1 and adset_id = 's1' order by occurred_on",
      [sourceId],
    )).toEqual([{ occurred_on: "2026-10-01" }, { occurred_on: "2026-10-08" }]);
    expect(await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'meta_ads_campaign_daily'",
      [sourceId],
    )).toEqual([{ cursor_value: "2026-10-14" }]);
  }, 120_000);

  it("a soft-time-budget interruption leaves a resumable gap the next run CLOSEs, never stranded syncing", async () => {
    const workspaceId = `ws_meta_deadline_${randomUUID()}`;
    const sourceId = `src_meta_deadline_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);

    // A wall-clock deadline already in the past → the FIRST Meta fetch's telemetry chokepoint throws
    // MetaAdsTimeBudgetError, INSIDE extract, before any LOAD or CLOSE. This is the graceful stop that
    // replaces a hosted maxDuration hard-kill: it flows through the connector's catch → recordSyncFailure.
    const interrupted = {
      ...syncRequest(workspaceId, sourceId, "2026-11-01", "2026-11-07"),
      softDeadlineAtMs: Date.now() - 1,
    };
    await expect(withMetaFetch(fixture("2026-11-01"), () =>
      connectorFor("meta_ads").sync(db, interrupted)
    )).rejects.toMatchObject({ code: "provider_time_budget_exhausted" });

    // ZERO coverage for the window: the CLOSE (the sole coverage writer) never ran.
    expect(await db.query("select occurred_on from meta_ads_coverage_daily where source_id = $1", [sourceId])).toEqual([]);
    // The run is FAILED and the source is NOT left `syncing` — the strand that a hard kill produces is
    // gone. A single retryable time-budget stop is a PROPORTIONATE transient: the source is restored to
    // `connected` (streak bumped) and stays in scheduler rotation, so the next tick can retry it.
    expect(await db.query<{ status: string }>("select status from sync_runs where id = $1", [interrupted.syncRunId]))
      .toEqual([{ status: "failed" }]);
    expect(await db.query<{ status: string; consecutive_sync_failures: number }>(
      "select status, consecutive_sync_failures from sources where id = $1",
      [sourceId],
    )).toEqual([{ status: "connected", consecutive_sync_failures: 1 }]);
    expect(await db.query<{ error_code: string; retryable: boolean }>(
      "select error_code, retryable from sync_errors where sync_run_id = $1",
      [interrupted.syncRunId],
    )).toEqual([{ error_code: "provider_time_budget_exhausted", retryable: true }]);
    // The cursor was NOT advanced to the window end. (recordSyncFailure seeds a placeholder cursor at
    // plan.cursorStart with `on conflict do nothing`, so a row may exist — but never at D7.)
    expect((await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'meta_ads_campaign_daily'",
      [sourceId],
    )).every((row) => row.cursor_value !== "2026-11-07")).toBe(true);

    // Re-run the SAME window with no deadline → the gap closes fully (7 days × 3 grains), the source
    // reconnects with a reset streak, and the cursor advances. "interrupted → gap → next run CLOSEs".
    await withMetaFetch(fixture("2026-11-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-11-01", "2026-11-07"))
    );
    expect(await db.query<{ total: number; days: number; grains: number }>(
      `select count(*)::int as total, count(distinct occurred_on)::int as days, count(distinct grain)::int as grains
         from meta_ads_coverage_daily where source_id = $1`,
      [sourceId],
    )).toEqual([{ total: 21, days: 7, grains: 3 }]);
    expect(await db.query<{ status: string; consecutive_sync_failures: number }>(
      "select status, consecutive_sync_failures from sources where id = $1",
      [sourceId],
    )).toEqual([{ status: "connected", consecutive_sync_failures: 0 }]);
    expect(await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'meta_ads_campaign_daily'",
      [sourceId],
    )).toEqual([{ cursor_value: "2026-11-07" }]);
  }, 120_000);
  it("pages only changed ads, preserves unchanged entities and commits the checkpoint only on success", async()=>{
    const workspaceId=`ws_delta_${randomUUID()}`,sourceId=`src_delta_${randomUUID()}`;
    await seedSource(workspaceId,sourceId);
    await withMetaFetch(fixture('2026-09-01',{includeSecondAd:true}),()=>connectorFor('meta_ads').sync(db,syncRequest(workspaceId,sourceId,'2026-09-01','2026-09-01')));
    const urls:URL[]=[];
    const changes=Array.from({length:10},(_,i)=>({id:`new${i}`,campaign_id:'c1',adset_id:'s1',name:`New ${i}`,status:'PAUSED',effective_status:'PAUSED'}));
    const delta=fixture('2026-09-01',{changedStatus:true});delta.adsets=[];
    delta.edgeResponse=(edge,url)=>{
      urls.push(url);
      if(edge!=='ads')return undefined;
      return new Response(JSON.stringify(url.searchParams.has('after')?{data:changes.slice(5)}:{data:[delta.ads[0],...changes.slice(0,5)],paging:{cursors:{after:'page2'},next:'https://graph.facebook.com/page2'}}),{status:200,headers:{'content-type':'application/json'}});
    };
    await withMetaFetch(delta,()=>connectorFor('meta_ads').sync(db,syncRequest(workspaceId,sourceId,'2026-09-01','2026-09-01')));
    const ads=await db.query<{entity_id:string;configured_status:string}>("select entity_id,configured_status from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and valid_to is null",[sourceId]);
    expect(ads).toHaveLength(12);expect(ads.find(ad=>ad.entity_id==='a1')?.configured_status).toBe('PAUSED');expect(ads.some(ad=>ad.entity_id==='a2')).toBe(true);
    expect(urls.filter(url=>url.pathname.endsWith('/ads'))).toHaveLength(2);
    expect(urls.filter(url=>/\/(ads|adsets)$/.test(url.pathname)).every(url=>Number(url.searchParams.get('updated_since'))>0)).toBe(true);
    expect(urls.find(url=>url.pathname.endsWith('/campaigns'))?.searchParams.has('updated_since')).toBe(false);
    const before=await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key like 'meta_ads_entities_%' order by cursor_key",[sourceId]);
    // scan + full + heavy (the first full read was heavy, see meta-lean-inventory.ts).
    expect(before.map(row=>String((row as {cursor_key:string}).cursor_key).split(':')[0])).toEqual(['meta_ads_entities_full','meta_ads_entities_heavy','meta_ads_entities_scan']);
    delta.edgeResponse=(edge,url)=>edge==='ads'?new Response(JSON.stringify(url.searchParams.has('after')?{error:{code:100,message:'failed second page'}}:{data:[],paging:{cursors:{after:'page2'},next:'https://graph.facebook.com/page2'}}),{status:url.searchParams.has('after')?400:200,headers:{'content-type':'application/json'}}):undefined;
    await expect(withMetaFetch(delta,()=>connectorFor('meta_ads').sync(db,syncRequest(workspaceId,sourceId,'2026-09-01','2026-09-01')))).rejects.toThrow();
    expect(await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key like 'meta_ads_entities_%' order by cursor_key",[sourceId])).toEqual(before);
  },120_000);

  it("inventory-only sync updates entity truth without insights, history cursor movement, or history-health reset", async () => {
    const workspaceId = `ws_meta_inventory_only_${randomUUID()}`;
    const sourceId = `src_meta_inventory_only_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    await db.query(
      `update sources set status='error',last_synced_at='2026-09-01T11:00:00.123456Z',consecutive_sync_failures=2,
         last_counted_sync_failure_at='2026-09-01T12:00:00.654321Z'
       where id=$1`,
      [sourceId],
    );
    const genericBefore = await db.query<{cursor_key:string;cursor_value:string}>(
      "select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key not like 'meta_ads_entities_%' order by cursor_key",
      [sourceId],
    );
    const sourceBefore = (await db.query("select status,last_synced_at::text,consecutive_sync_failures,last_counted_sync_failure_at::text from sources where id=$1",[sourceId]))[0];
    let insightCalls = 0;
    const changed = fixture("2026-09-02", { changedStatus: true });
    changed.edgeResponse = edge => { if (edge === "insights") insightCalls += 1; return undefined; };
    const request = Object.assign(syncRequest(workspaceId, sourceId, "2026-09-02", "2026-09-02"), {
      metaAdsSyncMode: "inventory_only" as const,
    }) as SyncRequest;
    await withMetaFetch(changed, () => connectorFor("meta_ads").sync(db, request));
    expect(insightCalls).toBe(0);
    expect((await db.query<{configured_status:string;effective_status:string}>(
      "select configured_status,effective_status from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and entity_id='a1' and valid_to is null",
      [sourceId],
    ))[0]).toEqual({ configured_status: "PAUSED", effective_status: "PAUSED" });
    expect(await db.query("select id from meta_ads_ad_daily where source_id=$1 and occurred_on='2026-09-02'",[sourceId])).toEqual([]);
    expect(await db.query("select occurred_on from meta_ads_coverage_daily where source_id=$1 and occurred_on='2026-09-02'",[sourceId])).toEqual([]);
    expect(await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key not like 'meta_ads_entities_%' order by cursor_key",[sourceId])).toEqual(genericBefore);
    expect((await db.query("select status,last_synced_at::text,consecutive_sync_failures,last_counted_sync_failure_at::text from sources where id=$1",[sourceId]))[0]).toEqual(sourceBefore);
  }, 120_000);

  it("inventory-only rejects an ambient CLI before provider work",async()=>{
    const workspaceId=`ws_inventory_transport_${randomUUID()}`,sourceId=`src_inventory_transport_${randomUUID()}`;await seedSource(workspaceId,sourceId);
    await db.query("update connection_credentials set encrypted_payload=$2 where source_id=$1",[sourceId,encryptCredentialPayload({mode:"live",transport:"meta_ads_cli",adAccountId:ACCOUNT,apiVersion:"v25.0"},KEY)]);
    let calls=0;const original=globalThis.fetch;globalThis.fetch=(async()=>{calls+=1;throw new Error("must not call provider");}) as typeof fetch;
    try{await expect(connectorFor("meta_ads").sync(db,{...syncRequest(workspaceId,sourceId,"2026-09-02","2026-09-02"),metaAdsSyncMode:"inventory_only"})).rejects.toMatchObject({code:"provider_unsupported",retryable:false});}
    finally{globalThis.fetch=original;}
    expect(calls).toBe(0);expect(await db.query("select id from meta_ads_campaign_daily where source_id=$1",[sourceId])).toEqual([]);
  },120_000);

  it("rejects split modes for fixture credentials",async()=>{
    const workspaceId=`ws_fixture_mode_${randomUUID()}`,sourceId=`src_fixture_mode_${randomUUID()}`;await seedSource(workspaceId,sourceId);
    await db.query("update connection_credentials set encrypted_payload='fixture-encrypted' where source_id=$1",[sourceId]);
    await expect(connectorFor("meta_ads").sync(db,{...syncRequest(workspaceId,sourceId,"2026-09-02","2026-09-02"),metaAdsSyncMode:"insights_only"})).rejects.toMatchObject({code:"provider_unsupported",retryable:false});
  },120_000);

  it("inventory-only extraction failure restores source health and cursors exactly",async()=>{
    const workspaceId=`ws_inventory_extract_${randomUUID()}`,sourceId=`src_inventory_extract_${randomUUID()}`;await seedSource(workspaceId,sourceId);
    await withMetaFetch(fixture("2026-09-01"),()=>connectorFor("meta_ads").sync(db,syncRequest(workspaceId,sourceId,"2026-09-01","2026-09-01")));
    await db.query("update sources set status='error',last_synced_at='2026-09-01T11:00:00.123456Z',consecutive_sync_failures=3,last_counted_sync_failure_at='2026-09-01T12:00:00.654321Z' where id=$1",[sourceId]);
    const before=(await db.query("select status,last_synced_at::text,consecutive_sync_failures,last_counted_sync_failure_at::text from sources where id=$1",[sourceId]))[0];
    const cursors=await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 order by cursor_key",[sourceId]);
    const broken=fixture("2026-09-02");broken.edgeResponse=edge=>edge==="campaigns"?new Response(JSON.stringify({error:{message:"inventory edge failed"}}),{status:500,headers:{"content-type":"application/json"}}):undefined;
    await expect(withMetaFetch(broken,()=>connectorFor("meta_ads").sync(db,{...syncRequest(workspaceId,sourceId,"2026-09-02","2026-09-02"),metaAdsSyncMode:"inventory_only"}))).rejects.toThrow(/inventory edge failed/);
    expect((await db.query("select status,last_synced_at::text,consecutive_sync_failures,last_counted_sync_failure_at::text from sources where id=$1",[sourceId]))[0]).toEqual(before);
    expect(await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 order by cursor_key",[sourceId])).toEqual(cursors);
  },120_000);

  it("insights-only sync writes facts without re-reading entity edges or advancing the entity checkpoint", async () => {
    const workspaceId = `ws_meta_insights_only_${randomUUID()}`;
    const sourceId = `src_meta_insights_only_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    const entityCursorBefore = await db.query<{cursor_key:string;cursor_value:string}>(
      "select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key like 'meta_ads_entities_%' order by cursor_key",
      [sourceId],
    );
    const entityObservedBefore = await db.query<{entity_id:string;last_observed_at:string}>(
      "select entity_id,last_observed_at::text from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and valid_to is null order by entity_id",
      [sourceId],
    );
    let edgeCalls = 0;
    const batches: string[][] = [];
    const providerRequests: Array<{pathname:string;method:string}> = [];
    const next = fixture("2026-09-02");
    next.onBatch = urls => batches.push(urls);
    next.onRequest = (url, init) => providerRequests.push({pathname:url.pathname,method:init?.method ?? "GET"});
    next.edgeResponse = edge => { if (["campaigns","adsets","ads"].includes(edge)) edgeCalls += 1; return undefined; };
    const request = Object.assign(syncRequest(workspaceId, sourceId, "2026-09-02", "2026-09-02"), {
      metaAdsSyncMode: "insights_only" as const,
      metaAdsRequestLane: "hot_insights" as const,
      metaAdsRequestBudget: 12,
    }) as SyncRequest;
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request));
    expect(edgeCalls).toBe(0);
    expect(providerRequests).toEqual([{pathname:"/v25.0/",method:"POST"}]);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map(url => new URL(url, "https://graph.facebook.com/v25.0/").searchParams.get("level"))).toEqual(["ad"]);
    expect(await db.query("select ad_id from meta_ads_ad_daily where source_id=$1 and occurred_on='2026-09-02'",[sourceId])).toEqual([{ad_id:"a1"}]);
    expect(await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key like 'meta_ads_entities_%' order by cursor_key",[sourceId])).toEqual(entityCursorBefore);
    expect(await db.query("select entity_id,last_observed_at::text from meta_ads_entity_versions where source_id=$1 and entity_type='ad' and valid_to is null order by entity_id",[sourceId])).toEqual(entityObservedBefore);
    const telemetry = (await db.query<{request_telemetry: Record<string, unknown>}>(
      "select request_telemetry from sync_runs where id=$1",
      [request.syncRunId],
    ))[0]?.request_telemetry;
    expect(telemetry).toMatchObject({
      schemaVersion: 2,
      lane: "hot_insights",
      requestCount: 1,
      pageCount: 1,
      budget: { limit: 12, remaining: 11, exhausted: false },
    });
  }, 120_000);

  it("hot lane reads TODAY with ONE all-status ad request and derives campaign + ad set rows from it", async () => {
    const workspaceId = `ws_meta_hot_rollup_${randomUUID()}`;
    const sourceId = `src_meta_hot_rollup_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    const day = "2026-09-02";
    const next = fixture(day);
    // Meta's own campaign/ad set rows are poisoned: the hot lane must never read them.
    next.campaignInsights[0]!.spend = "999";
    next.adsetInsights[0]!.spend = "999";
    next.adInsights[0]!.reach = "800";
    next.adInsights.push({
      // An ad deleted today: absent from the /ads edge, present only because the read asks for
      // every ad.effective_status. Its spend must reach the rolled-up campaign and ad set.
      date_start: day, spend: "20", clicks: "5", impressions: "500", reach: "400", account_currency: "GBP",
      inline_link_clicks: "3", campaign_id: "c1", campaign_name: "Campaign", adset_id: "s1", adset_name: "UK buyers",
      ad_id: "a_deleted", ad_name: "Deleted ad", objective: "OUTCOME_LEADS",
      actions: [{ action_type: "lead", "7d_click": "1" }, { action_type: "landing_page_view", "7d_click": "4" }],
      action_values: [],
    });
    const batches: string[][] = [];
    next.onBatch = urls => batches.push(urls);
    const request: SyncRequest = {
      ...syncRequest(workspaceId, sourceId, day, day),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "hot_insights",
      metaAdsRequestBudget: 12,
    };
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    const read = new URL(batches[0]![0]!, "https://graph.facebook.com/v25.0/");
    expect(read.searchParams.get("level")).toBe("ad");
    expect(read.searchParams.get("fields")?.split(",")).toEqual(expect.arrayContaining(["ad_id", "adset_id", "adset_name", "campaign_id", "campaign_name"]));
    expect(JSON.parse(read.searchParams.get("filtering") ?? "null")).toEqual([{
      field: "ad.effective_status",
      operator: "IN",
      value: ["ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"],
    }]);

    const telemetry = (await db.query<{ request_telemetry: Record<string, unknown> }>(
      "select request_telemetry from sync_runs where id=$1", [request.syncRunId],
    ))[0]?.request_telemetry;
    expect(telemetry).toMatchObject({
      lane: "hot_insights", requestCount: 1, pageCount: 1, budget: { limit: 12, remaining: 11, exhausted: false },
    });

    expect(await db.query("select ad_id,spend::float8 as spend from meta_ads_ad_daily where source_id=$1 and occurred_on=$2 order by ad_id", [sourceId, day]))
      .toEqual([{ ad_id: "a1", spend: 50 }, { ad_id: "a_deleted", spend: 20 }]);
    for (const [table, key] of [["meta_ads_campaign_daily", "campaign_id"], ["meta_ads_adset_daily", "adset_id"]] as const) {
      const rows = await db.query<Record<string, unknown>>(
        `select ${key} as id,spend::float8 as spend,clicks,impressions,inline_link_clicks,landing_page_views,reach,
                ctr::float8 as ctr,cpc::float8 as cpc,cpm::float8 as cpm,actions_raw->'derivation' as derivation
           from ${table} where source_id=$1 and occurred_on=$2`,
        [sourceId, day],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ spend: 70, reach: null, derivation: { method: "sum_of_ad_insights", version: 1, source_grain: "ad", ad_rows: 2 } });
      expect(Number(row.clicks)).toBe(15);
      expect(Number(row.impressions)).toBe(1500);
      expect(Number(row.inline_link_clicks)).toBe(3);
      expect(Number(row.landing_page_views)).toBe(4);
      expect(row.ctr as number).toBeCloseTo(1, 5);
      expect(row.cpc as number).toBeCloseTo(70 / 15, 5);
      expect(row.cpm as number).toBeCloseTo(70 / 1500 * 1000, 5);
    }
    expect(await db.query("select actions_raw->'derivation' as derivation from meta_ads_ad_daily where source_id=$1 and occurred_on=$2 and ad_id='a1'", [sourceId, day]))
      .toEqual([{ derivation: null }]);
    for (const table of ["meta_ads_campaign_conversions_daily", "meta_ads_adset_conversions_daily"]) {
      expect(await db.query(
        `select result_type,results::float8 as results,conversion_value::float8 as conversion_value,is_primary,results_source
           from ${table} where source_id=$1 and occurred_on=$2 order by result_type`,
        [sourceId, day],
      )).toEqual([
        { result_type: "lead", results: 4, conversion_value: null, is_primary: true, results_source: "derived_from_canonical_mapping" },
        { result_type: "purchase", results: 2, conversion_value: 125, is_primary: false, results_source: "derived_from_canonical_mapping" },
      ]);
    }
    expect(await db.query("select grain,row_count from meta_ads_coverage_daily where source_id=$1 and occurred_on=$2 order by grain", [sourceId, day]))
      .toEqual([{ grain: "ad", row_count: 2 }, { grain: "adset", row_count: 1 }, { grain: "campaign", row_count: 1 }]);
  }, 120_000);

  it("hot lane rolls up across every ad page and counts one request per page", async () => {
    const workspaceId = `ws_meta_hot_rollup_pages_${randomUUID()}`;
    const sourceId = `src_meta_hot_rollup_pages_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    const day = "2026-09-02";
    const next = fixture(day, { includeSecondAd: true });
    const [first, second] = next.adInsights;
    const batches: string[][] = [];
    next.onBatch = urls => batches.push(urls);
    next.batchItem = (_level, url) => url.searchParams.has("after")
      ? { body: { data: [second], paging: {} } }
      : { body: { data: [first], paging: { cursors: { after: "ad-page-2" }, next: `https://graph.facebook.com/v25.0/${ACCOUNT}/insights?level=ad&after=ad-page-2` } } };
    const request: SyncRequest = { ...syncRequest(workspaceId, sourceId, day, day), metaAdsSyncMode: "insights_only", metaAdsRequestLane: "hot_insights", metaAdsRequestBudget: 12 };
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request));
    expect(batches.map(batch => batch.length)).toEqual([1, 1]);
    const continuation = new URL(batches[1]![0]!, "https://graph.facebook.com/v25.0/");
    expect(continuation.searchParams.get("after")).toBe("ad-page-2");
    expect(continuation.searchParams.get("filtering")).toContain("DELETED");
    expect(await db.query("select spend::float8 as spend from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2", [sourceId, day]))
      .toEqual([{ spend: 70 }]);
    expect((await db.query<{ requests: number }>("select (request_telemetry->>'requestCount')::integer as requests from sync_runs where id=$1", [request.syncRunId]))[0]?.requests).toBe(2);
  }, 120_000);

  it.each(["settled_history", "attended_refresh"] as const)("%s one-day insights still reads all three grains from Meta (reach included)", async (lane) => {
    const workspaceId = `ws_meta_three_grain_${lane}_${randomUUID()}`;
    const sourceId = `src_meta_three_grain_${lane}_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    const day = "2026-09-02";
    const next = fixture(day);
    next.campaignInsights[0]!.reach = "777";
    next.campaignInsights[0]!.spend = "61";
    const batches: string[][] = [];
    next.onBatch = urls => batches.push(urls);
    const request: SyncRequest = { ...syncRequest(workspaceId, sourceId, day, day), metaAdsSyncMode: "insights_only", metaAdsRequestLane: lane, metaAdsRequestBudget: 12 };
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request));
    expect(batches.map(batch => batch.map(url => new URL(url, "https://graph.facebook.com/v25.0/").searchParams.get("level")))).toEqual([["campaign", "adset", "ad"]]);
    // Each grain asks for its objects in EVERY status at its own level (archived/deleted included).
    expect(batches[0]!.map(url => {
      const filters = JSON.parse(new URL(url, "https://graph.facebook.com/v25.0/").searchParams.get("filtering") ?? "null") as Array<{ field: string; value: string[] }>;
      return [filters[0]!.field, filters[0]!.value.includes("DELETED") && filters[0]!.value.includes("ARCHIVED")];
    })).toEqual([["campaign.effective_status", true], ["adset.effective_status", true], ["ad.effective_status", true]]);
    expect(await db.query("select spend::float8 as spend,reach,actions_raw->'derivation' as derivation from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2", [sourceId, day]))
      .toEqual([{ spend: 61, reach: expect.anything(), derivation: null }]);
    expect(Number((await db.query<{ reach: unknown }>("select reach from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2", [sourceId, day]))[0]?.reach)).toBe(777);
    expect((await db.query<{ requests: number }>("select (request_telemetry->>'requestCount')::integer as requests from sync_runs where id=$1", [request.syncRunId]))[0]?.requests).toBe(3);
  }, 120_000);

  /** Day D as Meta reports it once ad a_deleted (spend 20) and ad set s_deleted (spend 5) are deleted. */
  function deletedObjectsDay(day: string): MetaFixture {
    const next = fixture(day);
    next.metaStatusSemantics = true;
    const deletedAd = {
      date_start: day, spend: "20", clicks: "5", impressions: "500", reach: "400", account_currency: "GBP",
      campaign_id: "c1", campaign_name: "Campaign", adset_id: "s1", adset_name: "UK buyers",
      ad_id: "a_deleted", ad_name: "Deleted ad", objective: "OUTCOME_LEADS", actions: [], action_values: [], __status: "DELETED",
    };
    const deletedAdsetAd = {
      ...deletedAd, spend: "5", clicks: "1", impressions: "100", reach: "90",
      adset_id: "s_deleted", adset_name: "Deleted set", ad_id: "a_in_deleted_set", ad_name: "Ad in deleted set",
    };
    next.adInsights.push(deletedAd, deletedAdsetAd);
    // A live ad set's own row includes its deleted ads' stats (the doc's example); the deleted ad set
    // row, like any deleted object, is returned only when asked for.
    next.adsetInsights[0]!.spend = "70";
    next.adsetInsights.push({ ...next.adsetInsights[0]!, spend: "5", adset_id: "s_deleted", adset_name: "Deleted set", __status: "DELETED" });
    // The live campaign's row already includes every deleted child's stats.
    next.campaignInsights[0]!.spend = "75";
    return next;
  }

  async function spendByGrain(sourceId: string, day: string): Promise<Record<"campaign" | "adset" | "ad", number>> {
    const total = async (table: string) => Number((await db.query<{ spend: number | null }>(
      `select sum(spend)::float8 as spend from ${table} where source_id=$1 and occurred_on=$2`, [sourceId, day]))[0]?.spend ?? 0);
    return { campaign: await total("meta_ads_campaign_daily"), adset: await total("meta_ads_adset_daily"), ad: await total("meta_ads_ad_daily") };
  }

  it("settled one-day read keeps deleted ads' and ad sets' stats, so the hot lane's rows survive settlement at parity", async () => {
    const workspaceId = `ws_meta_settled_deleted_${randomUUID()}`;
    const sourceId = `src_meta_settled_deleted_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-01"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    const day = "2026-09-02";
    const oneDay = (lane: "hot_insights" | "settled_history"): SyncRequest => ({
      ...syncRequest(workspaceId, sourceId, day, day), metaAdsSyncMode: "insights_only", metaAdsRequestLane: lane, metaAdsRequestBudget: 12,
    });
    // Open day: the hot lane's all-status ad read sees every ad and derives the parents from them.
    await withMetaFetch(deletedObjectsDay(day), () => connectorFor("meta_ads").sync(db, oneDay("hot_insights")));
    expect(await spendByGrain(sourceId, day)).toEqual({ campaign: 75, adset: 75, ad: 75 });

    // Settlement replaces the day with Meta's own three grains. Without the all-status filters Meta
    // omits a_deleted / a_in_deleted_set / s_deleted, and CLOSE prunes the hot lane's rows for them.
    await withMetaFetch(deletedObjectsDay(day), () => connectorFor("meta_ads").sync(db, oneDay("settled_history")));
    expect(await spendByGrain(sourceId, day)).toEqual({ campaign: 75, adset: 75, ad: 75 });
    expect((await db.query<{ ad_id: string }>("select ad_id from meta_ads_ad_daily where source_id=$1 and occurred_on=$2 order by ad_id", [sourceId, day]))
      .map(row => row.ad_id)).toEqual(["a1", "a_deleted", "a_in_deleted_set"]);
    expect((await db.query<{ adset_id: string }>("select adset_id from meta_ads_adset_daily where source_id=$1 and occurred_on=$2 order by adset_id", [sourceId, day]))
      .map(row => row.adset_id)).toEqual(["s1", "s_deleted"]);
    // Settled rows are Meta's own (reach measured), never the derivation.
    expect(await db.query("select actions_raw->'derivation' as derivation from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2", [sourceId, day]))
      .toEqual([{ derivation: null }]);
  }, 120_000);

  it("multi-day restatement/backfill reads keep deleted ads' and ad sets' stats at every grain", async () => {
    const workspaceId = `ws_meta_restate_deleted_${randomUUID()}`;
    const sourceId = `src_meta_restate_deleted_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    const requests: URL[] = [];
    const data = deletedObjectsDay("2026-09-02");
    data.onRequest = url => { if (url.pathname.endsWith("/insights")) requests.push(url); };
    await withMetaFetch(data, () => connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-03")));
    expect(await spendByGrain(sourceId, "2026-09-02")).toEqual({ campaign: 75, adset: 75, ad: 75 });
    expect(requests.map(url => [url.searchParams.get("level"), JSON.parse(url.searchParams.get("filtering") ?? "[]")[0]?.field]))
      .toEqual([["campaign", "campaign.effective_status"], ["adset", "adset.effective_status"], ["ad", "ad.effective_status"]]);
  }, 120_000);

  it("a failed one-day insights batch retains the complete last-good snapshot", async () => {
    const workspaceId = `ws_meta_batch_last_good_${randomUUID()}`;
    const sourceId = `src_meta_batch_last_good_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-03"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-03", "2026-09-03"))
    );
    const before = await db.query(
      "select spend::text, updated_at::text from meta_ads_campaign_daily where source_id=$1 and occurred_on='2026-09-03'",
      [sourceId],
    );
    const broken = fixture("2026-09-03");
    broken.adInsights[0]!.spend = "999";
    // The hot lane reads only the ad grain; its failure must keep the last-good snapshot of all three.
    broken.failLevel = "ad";
    await expect(withMetaFetch(broken, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-03", "2026-09-03"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "hot_insights",
      metaAdsRequestBudget: 12,
    }))).rejects.toThrow();
    expect(await db.query(
      "select spend::text, updated_at::text from meta_ads_campaign_daily where source_id=$1 and occurred_on='2026-09-03'",
      [sourceId],
    )).toEqual(before);
    expect(await db.query(
      "select count(distinct grain)::integer as grains from meta_ads_coverage_daily where source_id=$1 and occurred_on='2026-09-03'",
      [sourceId],
    )).toEqual([{ grains: 3 }]);
  }, 120_000);

  it("batches known continuation cursors and accounts each logical page", async () => {
    const workspaceId = `ws_meta_batch_pages_${randomUUID()}`;
    const sourceId = `src_meta_batch_pages_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-04"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-04", "2026-09-04"))
    );
    const next = fixture("2026-09-05");
    const batches: string[][] = [];
    next.onBatch = urls => batches.push(urls);
    next.batchItem = (level, url, rows) => level === "campaign" && !url.searchParams.has("after")
      ? { body: { data: rows, paging: { cursors: { after: "campaign-page-2" }, next: "https://graph.facebook.com/v25.0/act_123/insights?level=campaign&after=campaign-page-2" } } }
      : { body: { data: url.searchParams.has("after") ? [] : rows, paging: {} } };
    const request: SyncRequest = {
      ...syncRequest(workspaceId, sourceId, "2026-09-05", "2026-09-05"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "settled_history",
      metaAdsRequestBudget: 12,
    };
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request));
    expect(batches.map(batch => batch.length)).toEqual([3, 1]);
    expect(batches[1]?.[0]).toContain("after=campaign-page-2");
    const telemetry = (await db.query<{request_telemetry: Record<string, unknown>}>("select request_telemetry from sync_runs where id=$1", [request.syncRunId]))[0]?.request_telemetry;
    expect(telemetry).toMatchObject({ schemaVersion: 2, lane: "settled_history", requestCount: 4, pageCount: 4 });
  }, 120_000);

  it("allows an implicit 30-day insights refresh to read beyond twelve serial pages", async () => {
    const workspaceId = `ws_meta_implicit_wide_budget_${randomUUID()}`;
    const sourceId = `src_meta_implicit_wide_budget_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-05"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-05", "2026-09-05"))
    );
    const next = fixture("2026-09-06", { empty: true });
    let insightCalls = 0;
    next.edgeResponse = (edge, url) => {
      if (edge !== "insights") return undefined;
      insightCalls += 1;
      const level = url.searchParams.get("level");
      const page = Number(url.searchParams.get("after") ?? "0");
      const paging = level === "campaign" && page < 12
        ? { next: `https://graph.facebook.com/v25.0/${ACCOUNT}/insights?level=campaign&after=${page + 1}` }
        : {};
      return new Response(JSON.stringify({ data: [], paging }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const request: SyncRequest = {
      workspaceId,sourceId,provider:"meta_ads",syncRunId:`sync_${randomUUID()}`,encryptionKey:KEY,
      refreshWindowDays:30,metaAdsSyncMode:"insights_only",metaAdsRequestLane:"settled_history",metaAdsRequestBudget:20,
    };
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request));
    expect(insightCalls).toBe(15);
    expect(await db.query(
      "select (request_telemetry->'budget'->>'limit')::integer as limit,(request_telemetry->>'requestCount')::integer as requests from sync_runs where id=$1",
      [request.syncRunId],
    )).toEqual([{limit:20,requests:15}]);
  },120_000);

  it("rejects an 11-used plus 2-continuation batch without phantom spend or another outer POST", async () => {
    const workspaceId = `ws_meta_batch_budget_${randomUUID()}`;
    const sourceId = `src_meta_batch_budget_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-05"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-05", "2026-09-05"))
    );
    const next = fixture("2026-09-06", { empty: true });
    let batches = 0;
    next.onBatch = () => { batches += 1; };
    next.batchItem = (level, url) => {
      const page = Number(url.searchParams.get("after") ?? "0");
      const continues = level !== "ad" || page < 2;
      return { body: { data: [], paging: continues
        ? { cursors: { after: String(page + 1) }, next: `https://graph.facebook.com/v25.0/act_123/insights?level=${level}&after=${page + 1}` }
        : {} } };
    };
    const request: SyncRequest = {
      ...syncRequest(workspaceId, sourceId, "2026-09-06", "2026-09-06"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "settled_history",
      metaAdsRequestBudget: 12,
    };
    await expect(withMetaFetch(next, () => connectorFor("meta_ads").sync(db, request)))
      .rejects.toMatchObject({ code: "provider_rate_budget_exhausted" });
    expect(batches).toBe(4);
    expect(await db.query(
      "select (request_telemetry->>'requestCount')::integer as requests,(request_telemetry->'budget'->>'remaining')::integer as remaining from sync_runs where id=$1",
      [request.syncRunId],
    )).toEqual([{requests:11,remaining:1}]);
  }, 120_000);

  it.each([false, true])("retains malformed sibling pressure and lets code 17 win regardless of order (%s)", async (reverse) => {
    const workspaceId = `ws_meta_batch_malformed_pressure_${randomUUID()}`;
    const sourceId = `src_meta_batch_malformed_pressure_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-06"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-06", "2026-09-06"))
    );
    const malformed = { code: 500, headers: [{name:"x-app-usage",value:JSON.stringify({call_count:10})}] };
    const throttled = { code: 400, headers: [{name:"x-app-usage",value:JSON.stringify({call_count:55})}], body: JSON.stringify({error:{code:17}}) };
    const valid = { code: 200, headers: [], body: JSON.stringify({data:[],paging:{}}) };
    const next = fixture("2026-09-07", { empty: true });
    next.outerBatchResponse = new Response(JSON.stringify(reverse ? [throttled,malformed,valid] : [malformed,throttled,valid]), {
      status: 200,
      headers: {"content-type":"application/json"},
    });
    const signals: Array<{maxPercent:number|null;throttled?:boolean}> = [];
    await expect(withMetaFetch(next, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-07", "2026-09-07"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "settled_history",
      metaAdsOnResponse: async signal => { signals.push(signal); },
    }))).rejects.toMatchObject({code:"provider_rate_limited",retryable:true});
    expect(signals).toEqual([expect.objectContaining({maxPercent:55,throttled:true})]);
  },120_000);

  it("aggregates sibling pressure before publishing one cadence sample", async () => {
    const workspaceId = `ws_meta_batch_pressure_${randomUUID()}`;
    const sourceId = `src_meta_batch_pressure_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-06"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-06", "2026-09-06"))
    );
    const next = fixture("2026-09-07", { empty: true });
    next.batchItem = level => ({ utilization: level === "campaign" ? 10 : level === "adset" ? 55 : 30 });
    const signals: Array<{maxPercent:number|null}> = [];
    await withMetaFetch(next, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-07", "2026-09-07"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "settled_history",
      metaAdsOnResponse: async signal => { signals.push(signal); },
    }));
    expect(signals).toEqual([expect.objectContaining({ maxPercent: 55 })]);
  }, 120_000);

  it("publishes code-17 sibling pressure before failing the required snapshot", async () => {
    const workspaceId = `ws_meta_batch_code17_${randomUUID()}`;
    const sourceId = `src_meta_batch_code17_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-07"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-07", "2026-09-07"))
    );
    const next = fixture("2026-09-08", { empty: true });
    next.batchItem = level => level === "adset"
      ? { code: 400, utilization: 47, body: { error: { code: 17, message: "rate limited" } } }
      : { utilization: 9 };
    const signals: Array<{maxPercent:number|null;throttled?:boolean}> = [];
    await expect(withMetaFetch(next, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-08", "2026-09-08"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "settled_history",
      metaAdsOnResponse: async signal => { signals.push(signal); },
    }))).rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });
    expect(signals).toEqual([expect.objectContaining({ maxPercent: 47, throttled: true })]);
    expect(await db.query("select id from meta_ads_campaign_daily where source_id=$1 and occurred_on='2026-09-08'", [sourceId])).toEqual([]);
  }, 120_000);

  it("lets a later code-17 sibling win over an earlier generic 500", async () => {
    const workspaceId = `ws_meta_batch_error_precedence_${randomUUID()}`;
    const sourceId = `src_meta_batch_error_precedence_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-07"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-07", "2026-09-07"))
    );
    const next = fixture("2026-09-08", { empty: true });
    next.batchItem = level => level === "campaign"
      ? {code:500,body:{error:{code:2}}}
      : level === "adset"
        ? {code:400,body:{error:{code:17}}}
        : {};
    await expect(withMetaFetch(next, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-08", "2026-09-08"),
      metaAdsSyncMode:"insights_only",metaAdsRequestLane:"settled_history",
    }))).rejects.toMatchObject({code:"provider_rate_limited",retryable:true});
  },120_000);

  it("publishes outer batch pressure before classifying a non-2xx transport failure", async () => {
    const workspaceId = `ws_meta_batch_outer_pressure_${randomUUID()}`;
    const sourceId = `src_meta_batch_outer_pressure_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-08"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-08", "2026-09-08"))
    );
    const next = fixture("2026-09-09", { empty: true });
    next.outerBatchResponse = new Response(JSON.stringify({ error: { code: 17 } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-app-usage": JSON.stringify({ call_count: 88 }),
      },
    });
    const signals: Array<{maxPercent:number|null;throttled?:boolean}> = [];
    await expect(withMetaFetch(next, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-09", "2026-09-09"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "hot_insights",
      metaAdsOnResponse: async signal => { signals.push(signal); },
    }))).rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });
    expect(signals).toEqual([expect.objectContaining({ maxPercent: 88, throttled: true })]);
  }, 120_000);

  it("fails before provider work when stored account metadata is incomplete", async () => {
    const workspaceId = `ws_meta_batch_metadata_${randomUUID()}`;
    const sourceId = `src_meta_batch_metadata_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-08"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-08", "2026-09-08"))
    );
    await db.query("update meta_ads_accounts set timezone_name=null where workspace_id=$1 and source_id=$2", [workspaceId, sourceId]);
    let batches = 0;
    const next = fixture("2026-09-09", { empty: true });
    next.onBatch = () => { batches += 1; };
    await expect(withMetaFetch(next, () => connectorFor("meta_ads").sync(db, {
      ...syncRequest(workspaceId, sourceId, "2026-09-09", "2026-09-09"),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "hot_insights",
    }))).rejects.toMatchObject({ code: "provider_api_error", retryable: true });
    expect(batches).toBe(0);
  }, 120_000);

  it.each([
    ["mid-load", "insert into meta_ads_adset_daily", "2026-09-08", "2026-09-08"],
    ["CLOSE", "insert into meta_ads_coverage_daily", "2026-09-08", "2026-09-08"],
    ["ISO-bound CLOSE", "insert into meta_ads_coverage_daily", "2026-09-08T12:00:00.000Z", "2026-09-08T12:00:00.000Z"],
  ])("rolls back one-day atomic publication on %s failure", async (_phase, failingSql, since, until) => {
    const workspaceId = `ws_meta_atomic_${randomUUID()}`;
    const sourceId = `src_meta_atomic_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture("2026-09-08"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-08", "2026-09-08"))
    );
    const beforeFacts = await Promise.all(["campaign", "adset", "ad"].map(grain => db.query(
      `select spend::text,updated_at::text from meta_ads_${grain}_daily where source_id=$1 and occurred_on='2026-09-08' order by id`,
      [sourceId],
    )));
    const beforeCoverage = await db.query(
      "select grain,row_count,sync_run_id,closed_at::text from meta_ads_coverage_daily where source_id=$1 and occurred_on='2026-09-08' order by grain",
      [sourceId],
    );
    const failingDb: InfiniteOsDb = {
      ...db,
      withTransaction: async fn => db.withTransaction(tx => fn({
        ...tx,
        query: (async (sql: string, params?: unknown[]) => {
          if (sql.includes(failingSql)) throw new Error(`forced ${_phase} publication failure`);
          return tx.query(sql, params);
        }) as InfiniteOsDb["query"],
      })),
    };
    const changed = fixture("2026-09-08");
    for (const rows of [changed.campaignInsights, changed.adsetInsights, changed.adInsights]) rows[0]!.spend = "999";
    const request: SyncRequest = {
      ...syncRequest(workspaceId, sourceId, since, until),
      metaAdsSyncMode: "insights_only",
      metaAdsRequestLane: "hot_insights",
    };
    await expect(withMetaFetch(changed, () => connectorFor("meta_ads").sync(failingDb, request)))
      .rejects.toThrow(`forced ${_phase} publication failure`);
    expect(await Promise.all(["campaign", "adset", "ad"].map(grain => db.query(
      `select spend::text,updated_at::text from meta_ads_${grain}_daily where source_id=$1 and occurred_on='2026-09-08' order by id`,
      [sourceId],
    )))).toEqual(beforeFacts);
    expect(await db.query(
      "select grain,row_count,sync_run_id,closed_at::text from meta_ads_coverage_daily where source_id=$1 and occurred_on='2026-09-08' order by grain",
      [sourceId],
    )).toEqual(beforeCoverage);
    expect(await db.query(
      "select status,request_telemetry->>'lane' as lane,(request_telemetry->>'requestCount')::integer as requests from sync_runs where id=$1",
      [request.syncRunId],
    )).toEqual([{status:"failed",lane:"hot_insights",requests:1}]);
  }, 120_000);

  it("uses atomic publication for an effective one-day hot window without explicit bounds", async () => {
    const workspaceId = `ws_meta_atomic_implicit_${randomUUID()}`;
    const sourceId = `src_meta_atomic_implicit_${randomUUID()}`;
    const day = metaAdsSettledWindow(new Date().toISOString(), "Europe/London", 1).since;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture(day), () => connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, day, day)));
    const before = await db.query("select spend::text,updated_at::text from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2",[sourceId,day]);
    const failingDb: InfiniteOsDb = {
      ...db,
      withTransaction: async fn => db.withTransaction(tx => fn({
        ...tx,
        query: (async (sql: string, params?: unknown[]) => {
          if (sql.includes("insert into meta_ads_coverage_daily")) throw new Error("forced implicit CLOSE failure");
          return tx.query(sql, params);
        }) as InfiniteOsDb["query"],
      })),
    };
    const changed = fixture(day);
    changed.campaignInsights[0]!.spend = "999";
    await expect(withMetaFetch(changed, () => connectorFor("meta_ads").sync(failingDb, {
      workspaceId,sourceId,provider:"meta_ads",syncRunId:`sync_${randomUUID()}`,encryptionKey:KEY,
      refreshWindowDays:1,metaAdsSyncMode:"insights_only",metaAdsRequestLane:"hot_insights",metaAdsRequestBudget:12,
    }))).rejects.toThrow("forced implicit CLOSE failure");
    expect(await db.query("select spend::text,updated_at::text from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2",[sourceId,day])).toEqual(before);
  },120_000);

  it("queues a concurrent reader until the atomic three-grain publication commits", async () => {
    const workspaceId = `ws_meta_atomic_reader_${randomUUID()}`;
    const sourceId = `src_meta_atomic_reader_${randomUUID()}`;
    const day = "2026-09-10";
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture(day), () => connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, day, day)));
    let readerSettled = false;
    let readerWasBlocked = false;
    let reader: Promise<Array<{grain:string;spend:string}>> | null = null;
    const observingDb: InfiniteOsDb = {
      ...db,
      withTransaction: async fn => db.withTransaction(tx => fn({
        ...tx,
        query: (async (sql: string, params?: unknown[]) => {
          const result = await tx.query(sql, params);
          if (!reader && sql.includes("insert into meta_ads_campaign_daily")) {
            reader = db.query<{grain:string;spend:string}>(
              `select 'campaign' as grain,spend::text from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2
               union all select 'adset',spend::text from meta_ads_adset_daily where source_id=$1 and occurred_on=$2
               union all select 'ad',spend::text from meta_ads_ad_daily where source_id=$1 and occurred_on=$2
               order by grain`,
              [sourceId,day],
            );
            void reader.then(() => { readerSettled = true; });
            await new Promise(resolve => setTimeout(resolve, 0));
            readerWasBlocked = !readerSettled;
          }
          return result;
        }) as InfiniteOsDb["query"],
      })),
    };
    const changed = fixture(day);
    for (const rows of [changed.campaignInsights,changed.adsetInsights,changed.adInsights]) rows[0]!.spend="999";
    await withMetaFetch(changed,()=>connectorFor("meta_ads").sync(observingDb,{
      ...syncRequest(workspaceId,sourceId,day,day),metaAdsSyncMode:"insights_only",metaAdsRequestLane:"hot_insights",
    }));
    expect(readerWasBlocked).toBe(true);
    expect(await reader).toEqual([
      {grain:"ad",spend:"999.000000"},{grain:"adset",spend:"999.000000"},{grain:"campaign",spend:"999.000000"},
    ]);
  },120_000);

  it("publishes the 6000-record atomic bound within the worker deadline and rejects 6001", async () => {
    const workspaceId = `ws_meta_atomic_bound_${randomUUID()}`;
    const sourceId = `src_meta_atomic_bound_${randomUUID()}`;
    const day = "2026-09-11";
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(fixture(day), () => connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, day, day)));
    const bounded = fixture(day,{empty:true});
    bounded.campaignInsights = Array.from({length:6000},(_,index)=>({
      campaign_id:`bound_${index}`,campaign_name:`Bound ${index}`,date_start:day,spend:"1",clicks:"0",impressions:"1",
      account_currency:"GBP",objective:"OUTCOME_AWARENESS",actions:[],action_values:[],
    }));
    const started = Date.now();
    await withMetaFetch(bounded,()=>connectorFor("meta_ads").sync(db,{
      ...syncRequest(workspaceId,sourceId,day,day),metaAdsSyncMode:"insights_only",metaAdsRequestLane:"settled_history",
    }));
    expect(Date.now()-started).toBeLessThan(60_000);
    expect(await db.query("select count(*)::integer as rows from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2",[sourceId,day])).toEqual([{rows:6000}]);
    const oversized = fixture(day,{empty:true});
    oversized.campaignInsights = [...bounded.campaignInsights,{...bounded.campaignInsights[0],campaign_id:"bound_6000",campaign_name:"Bound 6000"}];
    await expect(withMetaFetch(oversized,()=>connectorFor("meta_ads").sync(db,{
      ...syncRequest(workspaceId,sourceId,day,day),metaAdsSyncMode:"insights_only",metaAdsRequestLane:"settled_history",
    }))).rejects.toThrow("6000-record atomic publication limit");
    expect(await db.query("select count(*)::integer as rows from meta_ads_campaign_daily where source_id=$1 and occurred_on=$2",[sourceId,day])).toEqual([{rows:6000}]);
  },120_000);

  it("insights-only accepts a completed snapshot with zero entities",async()=>{
    const workspaceId=`ws_empty_snapshot_${randomUUID()}`,sourceId=`src_empty_snapshot_${randomUUID()}`;await seedSource(workspaceId,sourceId);
    const empty=fixture("2026-09-01",{empty:true});empty.campaigns=[];empty.adsets=[];empty.ads=[];
    await withMetaFetch(empty,()=>connectorFor("meta_ads").sync(db,syncRequest(workspaceId,sourceId,"2026-09-01","2026-09-01")));
    let edges=0;const next=fixture("2026-09-02",{empty:true});next.edgeResponse=edge=>{if(["campaigns","adsets","ads"].includes(edge))edges+=1;return undefined;};
    await withMetaFetch(next,()=>connectorFor("meta_ads").sync(db,{...syncRequest(workspaceId,sourceId,"2026-09-02","2026-09-02"),metaAdsSyncMode:"insights_only"}));
    expect(edges).toBe(0);expect(await db.query("select cursor_value from sync_cursors where source_id=$1 and cursor_key=$2",[sourceId,`meta_ads_entities_scan:${ACCOUNT}`])).toHaveLength(1);
    expect(await db.query("select grain,row_count from meta_ads_coverage_daily where source_id=$1 and occurred_on='2026-09-02' order by grain",[sourceId])).toEqual([
      {grain:"ad",row_count:0},{grain:"adset",row_count:0},{grain:"campaign",row_count:0},
    ]);
  },120_000);

  it("a Meta-only mode cannot suppress another provider's cursor or health",async()=>{
    const workspaceId=`ws_non_meta_${randomUUID()}`,sourceId=`src_non_meta_${randomUUID()}`;
    await db.withTransaction(async tx=>{await tx.ensureWorkspace(workspaceId,workspaceId);await tx.ensureFirstPhaseDatasets(workspaceId);});
    const dataset=(await db.query<{id:string}>("select id from datasets where workspace_id=$1 and key='web'",[workspaceId]))[0]!;
    await db.query("insert into sources(id,workspace_id,dataset_id,provider,connection_name,account_external_id,status) values($1,$2,$3,'stripe','fixture','acct_fixture','connected')",[sourceId,workspaceId,dataset.id]);
    await db.query("insert into connection_credentials(id,workspace_id,source_id,credential_kind,encrypted_payload) values($1,$2,$3,'fixture','fixture-encrypted')",[`cred_${randomUUID()}`,workspaceId,sourceId]);
    await connectorFor("stripe").sync(db,{workspaceId,sourceId,provider:"stripe",syncRunId:`sync_${randomUUID()}`,encryptionKey:KEY,windowSince:"2026-09-01",windowUntil:"2026-09-02",metaAdsSyncMode:"inventory_only"});
    expect(await db.query("select cursor_value from sync_cursors where source_id=$1 and cursor_key='stripe_invoice'",[sourceId])).toEqual([{cursor_value:"2026-09-02"}]);
    expect((await db.query("select status,last_synced_at is not null as advanced from sources where id=$1",[sourceId]))[0]).toEqual({status:"connected",advanced:true});
  },120_000);

  it("hands fresh signed media to the caller without persisting URL capabilities",async()=>{
    const workspaceId=`ws_media_${randomUUID()}`,sourceId=`src_media_${randomUUID()}`;
    await seedSource(workspaceId,sourceId);
    const seen:Array<{creativeId:string;slotKey:string;url:string}>=[];
    const request=syncRequest(workspaceId,sourceId,'2026-09-01','2026-09-01');
    request.metaAdsOnMedia=async media=>{seen.push(...media);};
    await withMetaFetch(fixture('2026-09-01'),()=>connectorFor('meta_ads').sync(db,request));
    expect(seen.some(item=>item.creativeId==='cr1'&&item.slotKey==='creative.image'&&item.url.includes('raw-signed-secret'))).toBe(true);
    expect(seen.some(item=>item.slotKey==='creative.thumbnail'&&item.url.includes('thumb-secret'))).toBe(true);
    const rows=await db.query("select metadata_json,asset_descriptors from meta_ads_entity_versions where source_id=$1",[sourceId]);
    expect(JSON.stringify(rows)).not.toContain('raw-signed-secret');expect(JSON.stringify(rows)).not.toContain('thumb-secret');
  },120_000);

  // Meta returns a freshly minted `emg1` preview URL for dynamic video creatives on nearly every
  // read. Those rotations must not mint creative or ad versions (each fake version re-queues the
  // creative's media downstream and replaces the version the Ads screen is showing).
  function rotatedThumbnailFixture(path: string, body = "Copy"): MetaFixture {
    const data = fixture("2026-09-01");
    const ad = data.ads[0] as { creative: Record<string, unknown> };
    ad.creative = { ...ad.creative, body, thumbnail_url: `https://external-dub4-1.xx.fbcdn.net/emg1/v/t13/${path}` };
    return data;
  }

  async function currentVersionCounts(sourceId: string): Promise<Record<string, number>> {
    const rows = await db.query<{ entity_type: string; entity_id: string; versions: number }>(
      `select entity_type, entity_id, count(*)::int as versions from meta_ads_entity_versions
        where source_id = $1 and entity_type in ('ad','creative') group by entity_type, entity_id`,
      [sourceId],
    );
    return Object.fromEntries(rows.map((row) => [`${row.entity_type}:${row.entity_id}`, row.versions]));
  }

  it("does not re-version an ad or creative when only Meta's rendered thumbnail_url rotates", async () => {
    const workspaceId = `ws_meta_thumb_${randomUUID()}`;
    const sourceId = `src_meta_thumb_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    for (const path of ["8893140978873974957", "15505404890301949775", "4411223344556677889"]) {
      await withMetaFetch(rotatedThumbnailFixture(path), () =>
        connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
      );
    }
    expect(await currentVersionCounts(sourceId)).toEqual({ "ad:a1": 1, "creative:cr1": 1 });
    // The stored snapshot is still what Meta returned (first observation), not a rewritten copy.
    const [creative] = await db.query<{ metadata_json: { thumbnail_url: string } }>(
      "select metadata_json from meta_ads_entity_versions where source_id=$1 and entity_type='creative' and valid_to is null",
      [sourceId],
    );
    expect(creative?.metadata_json.thumbnail_url).toBe("https://external-dub4-1.xx.fbcdn.net/emg1/v/t13/8893140978873974957");

    // A real edit still versions both the creative and the ad that embeds it.
    await withMetaFetch(rotatedThumbnailFixture("9999999999999999999", "New copy"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    expect(await currentVersionCounts(sourceId)).toEqual({ "ad:a1": 2, "creative:cr1": 2 });
  }, 120_000);

  it("adopts a legacy full-metadata payload_hash in place instead of minting a one-time version", async () => {
    const workspaceId = `ws_meta_legacy_${randomUUID()}`;
    const sourceId = `src_meta_legacy_${randomUUID()}`;
    await seedSource(workspaceId, sourceId);
    await withMetaFetch(rotatedThumbnailFixture("8893140978873974957"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    // Rows written before this fix carry sha256 over the FULL metadata, rotating URLs included.
    const stored = await db.query<{ id: string; metadata_json: Record<string, unknown> }>(
      "select id, metadata_json from meta_ads_entity_versions where source_id=$1 and valid_to is null",
      [sourceId],
    );
    for (const row of stored) {
      const legacyHash = createHash("sha256").update(canonicalMetaAdsJson(row.metadata_json)).digest("hex");
      await db.query("update meta_ads_entity_versions set payload_hash=$2 where id=$1", [row.id, legacyHash]);
    }

    await withMetaFetch(rotatedThumbnailFixture("15505404890301949775"), () =>
      connectorFor("meta_ads").sync(db, syncRequest(workspaceId, sourceId, "2026-09-01", "2026-09-01"))
    );
    expect(await currentVersionCounts(sourceId)).toEqual({ "ad:a1": 1, "creative:cr1": 1 });
    const rekeyed = await db.query<{ payload_hash: string; metadata_json: Record<string, unknown> }>(
      "select payload_hash, metadata_json from meta_ads_entity_versions where source_id=$1 and valid_to is null",
      [sourceId],
    );
    expect(rekeyed.length).toBe(stored.length);
    for (const row of rekeyed) expect(row.payload_hash).toBe(metaAdsEntityVersionFingerprint(row.metadata_json));
  }, 120_000);

});
