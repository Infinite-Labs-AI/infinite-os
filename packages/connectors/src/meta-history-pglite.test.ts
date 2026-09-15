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
        { id: "a1", campaign_id: "c1", adset_id: "s1", name: "Ad one", status: options.changedStatus ? "PAUSED" : "ACTIVE", effective_status: options.changedStatus ? "PAUSED" : "ACTIVE", creative: { id: "cr1", title: "Hook", body: "Copy", image_hash: "img1", image_url: "https://scontent.xx.fbcdn.net/img1.jpg?oh=raw-signed-secret&oe=123", asset_feed_spec: { videos: [{ video_id: "v2" }] } } },
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
      expect.objectContaining({ slotKey: "creative.image", providerAssetId: "img1", sourceUrl: null }),
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
    ]));
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain("signed-image");
    expect(stored).not.toContain("signed-thumb");
    expect(stored).not.toContain("signed-asset");
    expect(stored).not.toContain("signed-carousel");
    expect(stored).not.toContain("?oh=");
    expect(stored).not.toContain("?token=");
    expect(stored).not.toContain("?stp=");
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
});
