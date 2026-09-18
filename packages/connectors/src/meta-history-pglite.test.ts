import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { connectorFor, type SyncRequest } from "./index.js";

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
};

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
    globalThis.fetch = (async (input: string | URL | Request) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const headers = {
        "content-type": "application/json",
        "x-fb-ads-insights-throttle": JSON.stringify({ acc_id_util_pct: 11 }),
      };
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
        const rows = level === "campaign"
          ? fixture.campaignInsights
          : level === "adset"
            ? fixture.adsetInsights
            : fixture.adInsights;
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
    expect(before).toHaveLength(2);
    delta.edgeResponse=(edge,url)=>edge==='ads'?new Response(JSON.stringify(url.searchParams.has('after')?{error:{code:100,message:'failed second page'}}:{data:[],paging:{cursors:{after:'page2'},next:'https://graph.facebook.com/page2'}}),{status:url.searchParams.has('after')?400:200,headers:{'content-type':'application/json'}}):undefined;
    await expect(withMetaFetch(delta,()=>connectorFor('meta_ads').sync(db,syncRequest(workspaceId,sourceId,'2026-09-01','2026-09-01')))).rejects.toThrow();
    expect(await db.query("select cursor_key,cursor_value from sync_cursors where source_id=$1 and cursor_key like 'meta_ads_entities_%' order by cursor_key",[sourceId])).toEqual(before);
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

});
