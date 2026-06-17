import { describe, expect, it, vi } from "vitest";
import {
  decryptCredentialPayload,
  encryptCredentialPayload,
  isEncryptedCredentialPayload
} from "@infinite-os/core";
import { type InfiniteOsDb } from "@infinite-os/db";
import { createInfiniteOsRegistry } from "@infinite-os/runtime";

import {
  aggregateExpression,
  analyticalBoot,
  caveatsForMetric,
  connectedSourceFromEnvelope,
  createActionHandlers,
  derivePriorRange,
  metricColumn,
  metricView,
  queryabilityStatusFromSourceVerification,
  queuedSourceSyncFromEnvelope,
  unsupportedReason
} from "./index.js";

describe("analytical engine smoke", () => {
  it("exports the analytical boot marker", () => {
    expect(analyticalBoot).toBe(true);
  });

  // DEDUP single-source-of-truth: apps/worker imports these four functions instead of
  // duplicating them. This test pins the public surface so an accidental un-export
  // (which would silently break the worker's saved-report routing) fails here.
  it("exports the metric-routing functions consumed by apps/worker", () => {
    expect(typeof metricView).toBe("function");
    expect(typeof metricColumn).toBe("function");
    expect(typeof aggregateExpression).toBe("function");
    expect(typeof caveatsForMetric).toBe("function");
    // Behavior the worker relies on for GA4 traffic metrics.
    expect(metricView("page_views")).toBe("queryable.vw_site_traffic");
    expect(metricColumn("page_views")).toBe("page_views");
    expect(aggregateExpression("page_views", metricColumn("page_views"))).toBe("sum(page_views)");
    expect(aggregateExpression("engagement_rate", metricColumn("engagement_rate"))).toBe(
      "case when sum(sessions) = 0 then null else sum(engagement_rate * sessions) / sum(sessions) end"
    );
  });

  describe("Meta Ads queryable metrics (Phase 0)", () => {
    it("routes impressions/reach/cpm/cpc/ctr to vw_meta_ads_campaign_daily", () => {
      for (const metric of ["impressions", "reach", "cpm", "cpc", "ctr"]) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_daily");
      }
      // spend/clicks unchanged.
      expect(metricView("meta_ads_spend")).toBe("queryable.vw_meta_ads_campaign_daily");
      expect(metricView("meta_ads_clicks")).toBe("queryable.vw_meta_ads_campaign_daily");
    });

    it("sums the additive Meta metrics (impressions, reach)", () => {
      expect(aggregateExpression("impressions", metricColumn("impressions"))).toBe("sum(impressions)");
      expect(aggregateExpression("reach", metricColumn("reach"))).toBe("sum(reach)");
    });

    it("RECOMPUTES cpm/cpc/ctr from summed bases — never avg(per-row ratio)", () => {
      // LOAD-BEARING: these MUST divide summed numerator by summed denominator. If anyone
      // reverts to avg(cpm)/avg(cpc)/avg(ctr) (per-row ratio averaging) these assertions fail.
      const cpm = aggregateExpression("cpm", metricColumn("cpm"));
      expect(cpm).toBe("sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000");
      expect(cpm).not.toContain("avg(");

      const cpc = aggregateExpression("cpc", metricColumn("cpc"));
      expect(cpc).toBe("sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0)");
      expect(cpc).not.toContain("avg(");

      const ctr = aggregateExpression("ctr", metricColumn("ctr"));
      expect(ctr).toBe("sum(meta_ads_clicks) / nullif(sum(impressions), 0)");
      expect(ctr).not.toContain("avg(");
    });

    it("flags reach as APPROXIMATE and keeps the read-only marketing-api caveat on all 5", () => {
      expect(caveatsForMetric("reach")).toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
      for (const metric of ["impressions", "reach", "cpm", "cpc", "ctr"]) {
        expect(caveatsForMetric(metric)).toContain("read_only_marketing_api_reporting");
      }
      // impressions is exact (additive) — must NOT carry the reach approximation flag.
      expect(caveatsForMetric("impressions")).not.toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
    });
  });

  it("does not export the deterministic question resolver as a public surface", async () => {
    const module = await import("./index.js");
    expect("resolveQuestion" in module).toBe(false);
  });

  it("does not resolve out-of-phase questions and classifies handoff reasons", () => {
    const cases = [
      ["What content drove the most traffic this week?", "content_linkage_not_implemented"],
      ["What's my most popular content this week?", "content_linkage_not_implemented"],
      ["Which posts led to revenue?", "content_linkage_not_implemented"],
      [
        "How do Meta Ads, Meta CAPI, and billing data compare for this campaign?",
        "attribution_model_not_implemented"
      ],
      [
        "Where is MRR growth coming from this month: new business, expansion, reactivation, or reduced churn?",
        "provider_not_in_first_phase"
      ],
      ["Which trials look likely to convert this week, and which ones are stalling?", "attribution_model_not_implemented"],
      ["Which paid campaigns are paying back fast enough by channel and segment?", "attribution_model_not_implemented"],
      ["Which customer segments have the best 90-day retention?", "provider_not_in_first_phase"],
      ["How much did Shopify gross this week?", "content_linkage_not_implemented"],
      [
        "Where are users dropping off between visit, signup, checkout, and purchase?",
        "attribution_model_not_implemented"
      ]
    ] as const;

    for (const [question, reason] of cases) {
      expect(unsupportedReason(question)).toBe(reason);
    }
  });

  it("runs an end-to-end Meta journey query through the action registry", async () => {
    const registry = createInfiniteOsRegistry(createActionHandlers(journeyTestDb()));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;
    const plan = {
      intent: "rank_entities_by_outcome",
      actor: { grain: "person" },
      journeyTemplateId: "touchpoint_to_paid_conversion",
      entity: { type: "campaign" },
      outcome: { id: "meta_ads_clicks", window: "30d" },
      timeRange: { start: "2026-05-01", end: "2026-06-07" },
      ranking: { metric: "meta_ads_clicks", direction: "desc" },
      limit: 2
    };

    const search = await registry.execute(
      "search_context",
      { query: "Meta campaign performance", kinds: ["metric", "source", "journey_template"], limit: 5 },
      context
    );
    const resolved = await registry.execute(
      "resolve_entity",
      { entityType: "campaign", query: "launch" },
      context
    );
    const validation = await registry.execute(
      "validate_journey_plan",
      { plan },
      context
    );
    const result = await registry.execute(
      "run_journey_query",
      { plan, validationId: "validation_meta", limit: 2 },
      context
    );

    expect(search.status).toBe("ok");
    expect(JSON.stringify(search.data)).toContain("meta_ads_clicks");
    expect(resolved.status).toBe("resolved");
    expect(resolved.data).toMatchObject({
      candidates: expect.arrayContaining([expect.objectContaining({ entityType: "campaign" })])
    });
    expect(validation.status).toBe("ok");
    expect(result.status).toBe("resolved");
    expect(result.data).toMatchObject({
      answer: expect.stringContaining("Meta Ads"),
      rows: expect.arrayContaining([
        expect.objectContaining({
          campaign_id: "cmp_launch",
          meta_ads_clicks: "42"
        })
      ])
    });
    expect(result.evidence?.[0]).toMatchObject({
      id: "evidence:journey:meta_ads_clicks:campaign",
      kind: "query_result"
    });
  });

  it("runs an end-to-end X content journey query with bounded post evidence", async () => {
    const registry = createInfiniteOsRegistry(createActionHandlers(journeyTestDb()));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;
    const plan = {
      intent: "rank_entities_by_outcome",
      actor: { grain: "person" },
      journeyTemplateId: "entity_to_downstream_outcome",
      entity: { type: "content_item" },
      outcome: { id: "x_public_engagement", window: "30d" },
      timeRange: { start: "2026-05-01", end: "2026-06-07" },
      ranking: { metric: "x_public_engagement", direction: "desc" },
      limit: 2
    };

    const result = await registry.execute(
      "run_journey_query",
      { plan, validationId: "validation_x", limit: 2 },
      context
    );

    expect(result.status).toBe("resolved");
    expect(result.data).toMatchObject({
      answer: expect.stringContaining("X"),
      rows: expect.arrayContaining([
        expect.objectContaining({
          x_post_id: "x_1",
          body_text: "Demo request launch thread",
          x_public_engagement: "80"
        })
      ])
    });
    expect(JSON.stringify(result.data)).not.toContain("secret");
  });

  it("fetches evidence and verifies claims from journey evidence handles", async () => {
    const registry = createInfiniteOsRegistry(createActionHandlers(journeyTestDb()));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;

    const evidence = await registry.execute(
      "fetch_evidence",
      { evidenceHandleId: "evidence:journey:meta_ads_clicks:campaign", limit: 2 },
      context
    );
    const verification = await registry.execute(
      "verify_claims",
      {
        claims: ["Meta campaign evidence is available"],
        evidenceHandleIds: ["evidence:journey:meta_ads_clicks:campaign"]
      },
      context
    );

    expect(evidence.status).toBe("ok");
    expect(evidence.data).toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ campaign_id: "cmp_launch" })])
    });
    expect(verification.status).toBe("resolved");
    expect(verification.data).toMatchObject({
      claims: [
        {
          claim: "Meta campaign evidence is available",
          status: "verified"
        }
      ]
    });
  });

  it("stores live source credentials as encrypted envelopes and omits secrets from output", async () => {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const stored: { credential_kind?: string; encrypted_payload?: string } = {};
    // FIX 4: vi.stubGlobal/unstubAllGlobals — deterministic under parallel CI.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ data: [], has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })) as typeof fetch
    );
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        return {
          id: "src_stripe_live",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const handlers = createActionHandlers(db);
      const result = await handlers.connect_source?.(
        {
          provider: "stripe",
          connectionName: "Stripe Live",
          credentialPayload: {
            mode: "live",
            secretKey: "sk_test_secret",
            accountId: "acct_123",
            apiBaseUrl: "https://stripe.test"
          }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      expect(stored.credential_kind).toBe("api_key");
      expect(isEncryptedCredentialPayload(String(stored.encrypted_payload))).toBe(true);
      expect(stored.encrypted_payload).not.toContain("sk_test_secret");
      expect(JSON.stringify(result)).not.toContain("sk_test_secret");
      expect(result?.data).toMatchObject({
        connectionTest: { ok: true, mode: "live", provider: "stripe" }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("links OAuth sources to oauth_tokens and stores only non-secret metadata", async () => {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const stored: {
      credential_kind?: string;
      encrypted_payload?: string;
      oauth_token_id?: string | null;
    } = {};
    // FIX 4: vi.stubGlobal/unstubAllGlobals — deterministic under parallel CI.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ rows: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })) as typeof fetch
    );
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        // The connector dual-reads oauth_tokens for the live token during the connection test.
        if (sql.includes("from oauth_tokens")) {
          return {
            encrypted_payload: encryptForTest({
              accessToken: "ga4-access-token",
              refreshToken: "ga4-refresh-token",
              expiresAt: new Date(Date.now() + 3600_000).toISOString()
            }),
            expires_at: new Date(Date.now() + 3600_000).toISOString()
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        stored.oauth_token_id = input.oauthTokenId ?? null;
        return {
          id: "src_ga4_live",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const handlers = createActionHandlers(db);
      const result = await handlers.connect_source?.(
        {
          provider: "google_analytics_4",
          connectionName: "Google Analytics 4",
          oauthTokenId: "oauth_token_ga4",
          credentialPayload: {
            mode: "live",
            propertyId: "properties/555",
            accessToken: "ga4-access-token",
            refreshToken: "ga4-refresh-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            apiBaseUrl: "https://ga4.test"
          }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      expect(stored.credential_kind).toBe("oauth_access_token");
      expect(stored.oauth_token_id).toBe("oauth_token_ga4");
      expect(isEncryptedCredentialPayload(String(stored.encrypted_payload))).toBe(true);
      // Tokens must NOT be copied into connection_credentials.
      expect(stored.encrypted_payload).not.toContain("ga4-access-token");
      expect(stored.encrypted_payload).not.toContain("ga4-refresh-token");
      const metadata = decryptCredentialPayload<Record<string, unknown>>(
        String(stored.encrypted_payload),
        "analytical-test-encryption-key"
      );
      expect(metadata).toEqual({
        mode: "live",
        propertyId: "properties/555",
        apiBaseUrl: "https://ga4.test"
      });
      expect(metadata.accessToken).toBeUndefined();
      expect(metadata.expiresAt).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("ga4-refresh-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stores non-OAuth credentials directly with a NULL oauth_token_id", async () => {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const stored: {
      credential_kind?: string;
      encrypted_payload?: string;
      oauth_token_id?: string | null;
    } = {};
    // FIX 4: vi.stubGlobal/unstubAllGlobals — deterministic under parallel CI.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })) as typeof fetch
    );
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        stored.oauth_token_id = input.oauthTokenId ?? null;
        return {
          id: "src_posthog_live",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const handlers = createActionHandlers(db);
      await handlers.connect_source?.(
        {
          provider: "posthog",
          connectionName: "PostHog",
          credentialPayload: {
            mode: "live",
            projectId: "42",
            personalApiKey: "ph-personal-key",
            apiHost: "https://posthog.test"
          }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      expect(stored.credential_kind).toBe("personal_api_key");
      expect(stored.oauth_token_id).toBeNull();
      // The credential itself is stored in encrypted_payload for non-OAuth providers.
      const payload = decryptCredentialPayload<Record<string, unknown>>(
        String(stored.encrypted_payload),
        "analytical-test-encryption-key"
      );
      expect(payload).toMatchObject({ personalApiKey: "ph-personal-key", projectId: "42" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives Shopify and Meta Ads source identities from credential payloads", async () => {
    const stored: { credential_kind?: string; encrypted_payload?: string } = {};
    const connected: Array<{ provider: string; accountExternalId?: string }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        connected.push({
          provider: input.provider,
          accountExternalId: input.accountExternalId
        });
        return {
          id: `src_${input.provider}`,
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const context = {
      workspaceId: "workspace",
      authority: "operator",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    } as const;

    await handlers.connect_source?.(
      {
        provider: "shopify",
        credentialKind: "fixture",
        connectionName: "Shopify",
        credentialPayload: {
          storeDomain: "HTTPS://Scale-Growth.myshopify.com/admin",
          adminAccessToken: "shpat_secret"
        }
      },
      context
    );
    await handlers.connect_source?.(
      {
        provider: "meta_ads",
        credentialKind: "fixture",
        connectionName: "Meta Ads",
        credentialPayload: {
          adAccountId: "1234567890",
          accessToken: "meta-secret"
        }
      },
      context
    );

    expect(connected).toEqual([
      { provider: "shopify", accountExternalId: "scale-growth.myshopify.com" },
      { provider: "meta_ads", accountExternalId: "act_1234567890" }
    ]);
  });

  it("auto-queues an incremental sync when connecting an X source whose connection test passes", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        return {
          id: "src_x",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.connect_source?.(
      {
        provider: "x",
        credentialKind: "fixture",
        connectionName: "X Public Metrics",
        credentialPayload: { username: "XDevelopers" }
      },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([
      {
        workspaceId: "workspace",
        jobType: "source_sync",
        payload: { sourceId: "src_x", mode: "incremental" }
      }
    ]);
    expect(result?.data).toMatchObject({
      initialSync: { queued: true, sourceId: "src_x", mode: "incremental" }
    });
  });

  it("auto-queues an incremental sync when reconnecting an X source whose connection test passes", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        if (sql.includes("provider from sources")) {
          return { provider: "x" } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.reconnect_source?.(
      { sourceId: "src_x" },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([
      {
        workspaceId: "workspace",
        jobType: "source_sync",
        payload: { sourceId: "src_x", mode: "incremental" }
      }
    ]);
    expect(result?.data).toMatchObject({
      initialSync: { queued: true, sourceId: "src_x", mode: "incremental" }
    });
  });

  it("does not auto-queue a sync when an X connection test fails", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(): Promise<T | null> {
        // No credential row -> the X connector's testConnection throws provider_auth_failed.
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        return {
          id: "src_x",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);

    await expect(
      handlers.connect_source?.(
        {
          provider: "x",
          credentialKind: "fixture",
          connectionName: "X Public Metrics",
          credentialPayload: { username: "XDevelopers" }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow();

    expect(jobs).toEqual([]);
  });

  it("does not auto-queue a sync for non-X providers on connect", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        return {
          id: "src_posthog",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.connect_source?.(
      {
        provider: "posthog",
        credentialKind: "fixture",
        connectionName: "PostHog",
        credentialPayload: { projectId: "42" }
      },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([]);
    expect(result?.data).toMatchObject({ initialSync: undefined });
  });

  it("queues source backfills with the selected refresh window payload", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_backfill", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.start_source_sync?.(
      {
        sourceId: "src_meta_ads",
        mode: "backfill",
        backfillWindow: "6_months",
        refreshWindowDays: 180
      },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([
      {
        workspaceId: "workspace",
        jobType: "source_backfill",
        payload: {
          sourceId: "src_meta_ads",
          mode: "backfill",
          backfillWindow: "6_months",
          refreshWindowDays: 180
        }
      }
    ]);
    expect(result?.status).toBe("queued");
  });

  it("honors large immediate X sync windows for first-post coverage refreshes", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const statuses: Array<{ sourceId: string; status: string; lastSyncedAt?: string }> = [];
    let rawRecordIndex = 0;
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("provider from sources")) {
          return { provider: "x" } as T;
        }
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        if (sql.includes("sync_cursors")) {
          return null;
        }
        if (sql.includes("insert into raw_records")) {
          rawRecordIndex += 1;
          return { id: `raw_${rawRecordIndex}` } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus(sourceId, status, lastSyncedAt) {
        statuses.push({ sourceId, status, ...(lastSyncedAt ? { lastSyncedAt } : {}) });
      },
      async createJob() {
        throw new Error("sync_source_now should not queue jobs");
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);

    const result = await handlers.sync_source_now?.(
      { sourceId: "src_x", refreshWindowDays: 3650, reason: "first X answer" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "agent",
        sessionId: "session"
      }
    );

    expect(result?.status).toBe("ok");
    expect(result?.data).toMatchObject({
      sourceId: "src_x",
      provider: "x",
      refreshWindowDays: 3650,
      recordsExtracted: 1,
      recordsLoaded: 1
    });
    expect(statuses.map((entry) => entry.status)).toEqual(["syncing", "connected"]);
    expect(queries.some((entry) => entry.sql.includes("insert into sync_runs"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("insert into x_post"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("insert into tool_execution_log"))).toBe(true);
  });

  it("supports occurred_on range filters for analytical queries", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_revenue_by_source")) {
          return [{ recognized_revenue: "12000" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-04" }
        ]
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      rows: [{ recognized_revenue: "12000" }],
      metric: "recognized_revenue",
      view: "queryable.vw_revenue_by_source"
    });
    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"));
    expect(aggregateQuery?.sql).toContain("occurred_on >= $2");
    expect(aggregateQuery?.sql).toContain("occurred_on <= $3");
    expect(aggregateQuery?.params).toEqual(["workspace", "2026-06-01", "2026-06-04", 500]);
  });

  it("supports ordered X post breakdowns by published_at for recency questions", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_x_post_public_metrics")) {
          return [{ x_post_id: "1", body_text: "latest", published_at: "2026-06-04T10:00:00.000Z", x_public_engagement: "4" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["x_post_id", "post_url", "body_text", "published_at"],
        orderBy: { field: "published_at", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 1
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      metric: "x_public_engagement",
      view: "queryable.vw_x_post_public_metrics",
      groupBy: ["x_post_id", "post_url", "body_text", "published_at"],
      orderBy: { field: "published_at", direction: "desc" }
    });
    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_x_post_public_metrics"));
    expect(aggregateQuery?.sql).toContain("group by x_post_id, post_url, body_text, published_at");
    expect(aggregateQuery?.sql).toContain("order by published_at desc");
    expect(aggregateQuery?.sql).toContain("source_id = $2");
  });

  it("drills down x_post_count to authored x_post rows so the latest tweet content is retrievable", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from x_post")) {
          return [
            {
              post_row_id: "xp_1",
              source_id: "src_x_1",
              x_post_id: "2063231313730306485",
              author_id: "founder",
              conversation_id: "2063231313730306485",
              post_url: "https://x.com/YourHandle/status/2063231313730306485",
              body_text: "latest authored tweet",
              published_at: "2026-06-06T12:07:32.000Z",
              x_post_count: 1,
              x_comment_count: 0
            }
          ] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.drilldown_result?.(
      {
        metric: "x_post_count",
        limit: 1
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const drilldownQuery = queries.find((entry) => entry.sql.includes("from x_post"));
    expect(drilldownQuery?.sql).toBeDefined();
    expect(drilldownQuery?.sql).toContain("order by published_at desc");
    expect(queries.some((entry) => entry.sql.includes("from posthog_event_truth"))).toBe(false);
    const data = result?.data as { rows?: Array<Record<string, unknown>> } | undefined;
    expect(data?.rows?.[0]).toMatchObject({
      x_post_id: "2063231313730306485",
      body_text: "latest authored tweet",
      post_url: "https://x.com/YourHandle/status/2063231313730306485"
    });
    expect(result?.provenance).toContain("drilldown.x_authored_post_rows");
  });

  it("rejects metric and view mismatches before executing SQL", async () => {
    const queries: string[] = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        queries.push(sql);
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await expect(
      handlers.run_metric_query?.(
        {
          metric: "x_post_count",
          view: "queryable.vw_x_post_public_metrics"
        },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow("unsupported_view_for_metric:x_post_count:queryable.vw_x_post_public_metrics");
    expect(queries).toHaveLength(0);
  });

  it("maps X recency aliases like post_created_at to published_at", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_x_authored_activity")) {
          return [{ x_post_id: "1", body_text: "latest", published_at: "2026-06-04T10:00:00.000Z", x_post_count: "1" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await handlers.run_breakdown_query?.(
      {
        metric: "x_post_count",
        view: "queryable.vw_x_authored_activity",
        groupBy: ["x_post_id", "body_text", "published_at"],
        orderBy: { field: "post_created_at", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 1
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_x_authored_activity"));
    expect(aggregateQuery?.sql).toContain("order by published_at desc");
  });

  it("supports X hour-of-day breakdowns via derived published_at buckets", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_x_post_public_metrics")) {
          return [{ published_hour_utc: 9, x_public_engagement: "42" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["published_hour_utc"],
        orderBy: { field: "x_public_engagement", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 24
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      groupBy: ["published_hour_utc"],
      orderBy: { field: "x_public_engagement", direction: "desc" }
    });
    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_x_post_public_metrics"));
    expect(aggregateQuery?.sql).toContain("extract(hour from published_at at time zone 'utc')::int as published_hour_utc");
    expect(aggregateQuery?.sql).toContain("group by extract(hour from published_at at time zone 'utc')::int");
  });

  it("supports natural X aliases for text, content type, and engaged-with handle breakdowns", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent" as const,
      surface: "api" as const,
      actorId: "operator",
      sessionId: "session"
    };

    await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["post_text", "published_at"],
        orderBy: { field: "published_at", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 1
      },
      context
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["post_type"],
        orderBy: { field: "x_public_engagement", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 5
      },
      context
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "x_comment_count",
        view: "queryable.vw_x_authored_activity",
        groupBy: ["engaged_with"],
        orderBy: { field: "x_comment_count", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 3
      },
      context
    );

    const aggregateQueries = queries.filter((entry) => entry.sql.includes("from queryable.vw_x_"));
    expect(aggregateQueries[0]?.sql).toContain("body_text as body_text");
    expect(aggregateQueries[0]?.sql).toContain("order by published_at desc");
    expect(aggregateQueries[1]?.sql).toContain("as content_type");
    expect(aggregateQueries[1]?.sql).toContain("conversation_id is not null and conversation_id <> x_post_id");
    expect(aggregateQueries[1]?.sql).toContain("coalesce(body_text, '') ~* '(https?://|t\\.co/)'");
    expect(aggregateQueries[2]?.sql).toContain("as mentioned_handle");
    expect(aggregateQueries[2]?.sql).toContain("regexp_match(coalesce(body_text, ''), '@([A-Za-z0-9_]{1,15})')");
  });

  it("hydrates published_at into X view and metric metadata", async () => {
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        if (sql.includes("from queryable_views")) {
          return [{
            id: "queryable.vw_x_post_public_metrics",
            view_name: "vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          }] as T[];
        }
        if (sql.includes("from metric_definitions")) {
          return [{
            id: "x_public_engagement",
            source_view: "queryable.vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          }] as T[];
        }
        return [] as T[];
      },
      async one<T = Record<string, unknown>>(sql: string): Promise<T | null> {
        if (sql.includes("from queryable_views")) {
          return {
            id: "queryable.vw_x_post_public_metrics",
            view_name: "vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          } as T;
        }
        if (sql.includes("from metric_definitions")) {
          return {
            id: "x_public_engagement",
            source_view: "queryable.vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const viewsResult = await handlers.list_queryable_views?.({}, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });
    const metricResult = await handlers.describe_metric?.({ metricId: "x_public_engagement" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });

    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("published_at");
    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("published_hour_utc");
    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("content_type");
    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("mentioned_handle");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("published_at");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("published_hour_utc");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("content_type");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("mentioned_handle");
  });

  it("uses Shopify and Meta Ads authority and drilldown metadata for new metrics", async () => {
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        return [] as T[];
      },
      async one<T = Record<string, unknown>>(sql: string): Promise<T | null> {
        if (sql.includes("from metric_definitions") && sql.includes("shopify_gross_sales")) {
          return {
            id: "shopify_gross_sales",
            source_view: "queryable.vw_shopify_orders",
            allowed_dimensions: ["currency", "customer_email"],
            default_time_column: "occurred_on"
          } as T;
        }
        if (sql.includes("from metric_definitions") && sql.includes("meta_ads_spend")) {
          return {
            id: "meta_ads_spend",
            source_view: "queryable.vw_meta_ads_campaign_daily",
            allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
            default_time_column: "occurred_on"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const shopify = await handlers.explain_answer?.({ metric: "shopify_gross_sales" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });
    const metaAds = await handlers.explain_answer?.({ metric: "meta_ads_spend" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });

    expect(shopify?.data).toMatchObject({
      metric: "shopify_gross_sales",
      sourceAuthority: "Shopify order records are the first-phase commerce authority",
      drilldownAction: "drilldown.shopify_order_rows"
    });
    expect(shopify?.caveats).toContain("order_level_shopify_commerce_authority");
    expect(metaAds?.data).toMatchObject({
      metric: "meta_ads_spend",
      sourceAuthority: "Meta Ads campaign insights are the first-phase paid media authority",
      drilldownAction: "drilldown.meta_ads_campaign_rows"
    });
    expect(metaAds?.caveats).toContain("read_only_marketing_api_reporting");
  });

  it("uses PostHog event authority and drilldown metadata for event-count metrics", async () => {
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        return [] as T[];
      },
      async one<T = Record<string, unknown>>(sql: string): Promise<T | null> {
        if (sql.includes("from metric_definitions") && sql.includes("posthog_event_count")) {
          return {
            id: "posthog_event_count",
            source_view: "queryable.vw_posthog_events",
            allowed_dimensions: ["event_name", "landing_page", "referrer", "utm_source", "utm_medium", "utm_campaign"],
            default_time_column: "occurred_on"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const posthog = await handlers.explain_answer?.({ metric: "posthog_event_count" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });

    expect(posthog?.data).toMatchObject({
      metric: "posthog_event_count",
      sourceAuthority: "PostHog event records are the first-phase event authority",
      drilldownAction: "drilldown.posthog_event_provider_rows"
    });
    expect(posthog?.caveats).toContain("source_native_event_counts");
  });

  it("accepts breakdown dimensions for Shopify and Meta Ads queryable views", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_shopify_orders")) {
          return [{ currency: "USD", shopify_order_count: "4" }] as T[];
        }
        if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
          return [{ campaign_id: "1200000001", meta_ads_spend: "123.45" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await handlers.run_breakdown_query?.(
      {
        metric: "shopify_order_count",
        view: "queryable.vw_shopify_orders",
        groupBy: ["currency"],
        orderBy: { field: "shopify_order_count", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "meta_ads_spend",
        view: "queryable.vw_meta_ads_campaign_daily",
        groupBy: ["campaign_id"],
        orderBy: { field: "meta_ads_spend", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "meta_ads_clicks",
        view: "queryable.vw_meta_ads_campaign_daily",
        groupBy: ["campaign", "date"],
        orderBy: { field: "meta_ads_clicks", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_shopify_orders") && entry.sql.includes("currency as currency"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily") && entry.sql.includes("campaign_id as campaign_id"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily") && entry.sql.includes("campaign_name as campaign_name"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily") && entry.sql.includes("occurred_on as occurred_on"))).toBe(true);
  });

  // Phase 0 Change 1 end-to-end: these run the full run_metric_query handler against a
  // fake-db that EVALUATES the emitted aggregate SQL over a fixed campaign×day fixture.
  // Because the fixture's per-row ratios differ from the true volume-weighted ratio, a
  // revert to avg(per-row cpm/cpc/ctr) would return a DIFFERENT number and fail these.
  describe("run_metric_query for Meta Ads queryable metrics (Phase 0)", () => {
    // Two campaign×day rows for one campaign. Bases chosen so sum-then-divide differs
    // sharply from avg-of-per-row-ratios:
    //   day1: spend 100, clicks 10,  impressions 1000  -> cpm 100, cpc 10,   ctr 0.01
    //   day2: spend  20, clicks 80,  impressions 9000  -> cpm  2.222, cpc 0.25, ctr 0.00889
    // Correct (recomputed) totals over sums:
    //   sum spend 120, sum clicks 90, sum impressions 10000
    //   cpm = 120 / 10000 * 1000 = 12
    //   cpc = 120 / 90            = 1.3333...
    //   ctr = 90 / 10000          = 0.009
    //   impressions = 10000 ; reach (sum) = 5000
    const fixture = [
      { spend: 100, clicks: 10, impressions: 1000, reach: 3000, cpm: 100, cpc: 10, ctr: 0.01 },
      { spend: 20, clicks: 80, impressions: 9000, reach: 2000, cpm: 2.222, cpc: 0.25, ctr: 0.0088888 }
    ];
    const sums = {
      spend: fixture.reduce((acc, row) => acc + row.spend, 0),
      clicks: fixture.reduce((acc, row) => acc + row.clicks, 0),
      impressions: fixture.reduce((acc, row) => acc + row.impressions, 0),
      reach: fixture.reduce((acc, row) => acc + row.reach, 0)
    };

    // Evaluate ONLY the exact aggregate expressions Change 1 registers. Any other shape
    // (e.g. an avg(cpm) revert) is unrecognized and throws — so a wrong SQL can never
    // silently pass by returning a coincidentally-right number.
    function evalAggregate(metric: string, sql: string): number {
      const measure = sql.slice(sql.indexOf("select ") + "select ".length, sql.indexOf(` as ${metric}`)).trim();
      if (measure === "sum(impressions)") return sums.impressions;
      if (measure === "sum(reach)") return sums.reach;
      if (measure === "sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000") {
        return sums.spend / sums.impressions * 1000;
      }
      if (measure === "sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0)") {
        return sums.spend / sums.clicks;
      }
      if (measure === "sum(meta_ads_clicks) / nullif(sum(impressions), 0)") {
        return sums.clicks / sums.impressions;
      }
      throw new Error(`unexpected_aggregate_for_${metric}:${measure}`);
    }

    function metaAggregateFakeDb(metric: string, queries: Array<{ sql: string }>): InfiniteOsDb {
      return {
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          queries.push({ sql });
          if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
            return [{ [metric]: evalAggregate(metric, sql) }] as T[];
          }
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };
    }

    const ctx = {
      workspaceId: "workspace",
      authority: "tool_agent" as const,
      surface: "api" as const,
      actorId: "operator",
      sessionId: "session"
    };

    it("sums impressions and reach over the campaign×day grain", async () => {
      for (const metric of ["impressions", "reach"] as const) {
        const queries: Array<{ sql: string }> = [];
        const handlers = createActionHandlers(metaAggregateFakeDb(metric, queries));
        const result = await handlers.run_metric_query?.({ metric }, ctx);
        const sql = queries.find((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily"))?.sql;
        expect(sql).toContain(`sum(${metric}) as ${metric}`);
        expect(result?.data).toMatchObject({ metric, view: "queryable.vw_meta_ads_campaign_daily" });
        const rows = (result?.data as { rows: Array<Record<string, number>> }).rows;
        expect(rows[0]?.[metric]).toBe(sums[metric]);
      }
    });

    it("recomputes cpm/cpc/ctr from summed bases (avg-per-row would be wrong)", async () => {
      const expected: Record<string, number> = {
        cpm: (sums.spend / sums.impressions) * 1000, // 12
        cpc: sums.spend / sums.clicks, // 1.3333...
        ctr: sums.clicks / sums.impressions // 0.009
      };
      // The avg-of-per-row-ratio answer the revert would produce — proven DISTINCT here so
      // the equality assertion below genuinely rejects the averaged value.
      const avgPerRow: Record<string, number> = {
        cpm: (fixture[0]!.cpm + fixture[1]!.cpm) / 2,
        cpc: (fixture[0]!.cpc + fixture[1]!.cpc) / 2,
        ctr: (fixture[0]!.ctr + fixture[1]!.ctr) / 2
      };
      for (const metric of ["cpm", "cpc", "ctr"] as const) {
        const queries: Array<{ sql: string }> = [];
        const handlers = createActionHandlers(metaAggregateFakeDb(metric, queries));
        const result = await handlers.run_metric_query?.({ metric }, ctx);
        const sql = queries.find((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily"))?.sql;
        expect(sql).not.toContain(`avg(${metric})`);
        const rows = (result?.data as { rows: Array<Record<string, number>> }).rows;
        expect(rows[0]?.[metric]).toBeCloseTo(expected[metric]!, 9);
        // Guard the guard: the recomputed value must NOT equal the averaged value.
        expect(Math.abs(rows[0]![metric]! - avgPerRow[metric]!)).toBeGreaterThan(1e-6);
      }
    });

    it("flags reach as approximate on the run_metric_query envelope", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(metaAggregateFakeDb("reach", queries));
      const result = await handlers.run_metric_query?.({ metric: "reach" }, ctx);
      expect(result?.caveats).toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
      expect(result?.caveats).toContain("read_only_marketing_api_reporting");
    });
  });

  it("accepts event and channel breakdown dimensions for PostHog event counts", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_posthog_events")) {
          return [{ event_name: "signup", utm_source: "linkedin", posthog_event_count: "4" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await handlers.run_breakdown_query?.(
      {
        metric: "posthog_event_count",
        view: "queryable.vw_posthog_events",
        groupBy: ["event_name", "utm_source", "date"],
        filters: [{ field: "event_date", operator: "gte", value: "2026-06-01" }],
        orderBy: { field: "posthog_event_count", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_posthog_events") && entry.sql.includes("event_name as event_name"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_posthog_events") && entry.sql.includes("utm_source as utm_source"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_posthog_events") && entry.sql.includes("occurred_on as occurred_on"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("occurred_on >= $2"))).toBe(true);
  });

  it("routes GA4 traffic count metrics to vw_site_traffic with sum aggregates", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    for (const metric of ["page_views", "new_users", "key_events"]) {
      const result = await handlers.run_metric_query?.(
        { metric, view: "queryable.vw_site_traffic" },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );
      const aggregateQuery = queries.find(
        (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes(`sum(${metric})`)
      );
      expect(aggregateQuery?.sql).toBeDefined();
      expect(aggregateQuery?.sql).toContain(`sum(${metric}) as ${metric}`);
      expect(aggregateQuery?.params).toEqual(["workspace", 500]);
      expect(result?.caveats).toContain("source_native_attribution_only");
    }
  });

  it("uses session-weighted SQL for GA4 rate metrics (never sum/avg alone)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    await handlers.run_metric_query?.(
      { metric: "engagement_rate", view: "queryable.vw_site_traffic" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_metric_query?.(
      { metric: "average_session_duration", view: "queryable.vw_site_traffic" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const engagementSql = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes("engagement_rate * sessions")
    )?.sql;
    expect(engagementSql).toBeDefined();
    expect(engagementSql).toContain("sum(engagement_rate * sessions) / sum(sessions)");
    expect(engagementSql).not.toContain("sum(engagement_rate) as");

    const durationSql = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes("average_session_duration * sessions")
    )?.sql;
    expect(durationSql).toBeDefined();
    expect(durationSql).toContain("sum(average_session_duration * sessions) / sum(sessions)");
    expect(durationSql).not.toContain("sum(average_session_duration) as");
  });

  it("breaks GA4 traffic down by channel group and device category", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    await handlers.run_breakdown_query?.(
      {
        metric: "page_views",
        view: "queryable.vw_site_traffic",
        groupBy: ["session_default_channel_group"],
        orderBy: { field: "page_views", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "engaged_sessions",
        view: "queryable.vw_site_traffic",
        groupBy: ["device_category"],
        orderBy: { field: "engaged_sessions", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(
      queries.some(
        (entry) =>
          entry.sql.includes("from queryable.vw_site_traffic") &&
          entry.sql.includes("group by session_default_channel_group")
      )
    ).toBe(true);
    expect(
      queries.some(
        (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes("group by device_category")
      )
    ).toBe(true);
  });

  it("uses session-weighted SQL for a GA4 rate breakdown grouped by channel group", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    const result = await handlers.run_breakdown_query?.(
      {
        metric: "engagement_rate",
        view: "queryable.vw_site_traffic",
        groupBy: ["session_default_channel_group"],
        orderBy: { field: "engagement_rate", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      metric: "engagement_rate",
      view: "queryable.vw_site_traffic",
      groupBy: ["session_default_channel_group"],
      orderBy: { field: "engagement_rate", direction: "desc" }
    });
    const breakdownSql = queries.find(
      (entry) =>
        entry.sql.includes("from queryable.vw_site_traffic") &&
        entry.sql.includes("engagement_rate * sessions")
    )?.sql;
    expect(breakdownSql).toBeDefined();
    // Session-weighted rate, never sum/avg alone.
    expect(breakdownSql).toContain("sum(engagement_rate * sessions) / sum(sessions)");
    // ORDER BY references the aliased CASE output column, not the raw expression.
    expect(breakdownSql).toContain("order by engagement_rate desc");
    expect(breakdownSql).toContain("group by session_default_channel_group");
  });

  it("rejects page-only dimensions on the GA4 traffic view", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    await expect(
      handlers.run_breakdown_query?.(
        {
          metric: "page_views",
          view: "queryable.vw_site_traffic",
          groupBy: ["page_path"]
        },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow("unsupported_dimension:page_path");
  });

  it("routes page_views_by_page to the GA4 page view for top-page metric queries", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4PageFakeDb(queries);
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      { metric: "page_views_by_page", view: "queryable.vw_site_pages" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const aggregateQuery = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_pages") && entry.sql.includes("sum(page_views)")
    );
    expect(aggregateQuery?.sql).toBeDefined();
    // page_views_by_page is a count aliased to page_views in the view (identity).
    expect(aggregateQuery?.sql).toContain("sum(page_views) as page_views_by_page");
    expect(aggregateQuery?.params).toEqual(["workspace", 500]);
    expect(result?.caveats).toContain("source_native_attribution_only");
  });

  it("breaks page_views_by_page down by host and page path against vw_site_pages", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4PageFakeDb(queries);
    const handlers = createActionHandlers(db);

    await handlers.run_breakdown_query?.(
      {
        metric: "page_views_by_page",
        view: "queryable.vw_site_pages",
        groupBy: ["page_path", "page_title"],
        orderBy: { field: "page_views_by_page", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const breakdownSql = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_pages") && entry.sql.includes("group by")
    )?.sql;
    expect(breakdownSql).toBeDefined();
    expect(breakdownSql).toContain("group by page_path, page_title");
    expect(breakdownSql).toContain("order by page_views_by_page desc");
  });

  it("rejects traffic-only dimensions on the GA4 page view", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4PageFakeDb(queries);
    const handlers = createActionHandlers(db);

    await expect(
      handlers.run_breakdown_query?.(
        {
          metric: "page_views_by_page",
          view: "queryable.vw_site_pages",
          groupBy: ["device_category"]
        },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow("unsupported_dimension:device_category");
  });

  // PR3 Step 12 — drilldown source-isolation FIX (regression guard for the cross-site leak).
  it("isolates the site_visitors drilldown to the requested source_id", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { factHasRows: true });
    const handlers = createActionHandlers(db);

    await handlers.drilldown_result?.(
      {
        metric: "site_visitors",
        filters: [{ field: "source_id", operator: "equals", value: "src_ga4_rtk" }]
      },
      ga4Context()
    );

    const drilldownQuery = queries.find((entry) => entry.sql.includes("from ga4_report_snapshot_fact"));
    expect(drilldownQuery?.sql).toBeDefined();
    // The leak fix: source filter is now present (was workspace_id only).
    expect(drilldownQuery?.sql).toContain("($2::text is null or source_id = $2)");
    // Param bind order: [workspaceId, sourceIdFilter, limit].
    expect(drilldownQuery?.params?.[0]).toBe("workspace");
    expect(drilldownQuery?.params?.[1]).toBe("src_ga4_rtk");
  });

  // PR3 review FIX — the 6 GA4 daily-traffic metrics added in PR1 route their drilldown to
  // ga4_traffic_provider_rows (same as site_visitors), so providerTruthRows must hit the
  // source-isolated ga4_report_snapshot_fact query, NOT fall through to the posthog default.
  it("routes GA4 traffic-metric drilldowns to the source-isolated ga4_report_snapshot_fact query", async () => {
    for (const metric of ["page_views", "engagement_rate"]) {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const db = ga4ProbeFakeDb(queries, { factHasRows: true });
      const handlers = createActionHandlers(db);

      await handlers.drilldown_result?.(
        {
          metric,
          filters: [{ field: "source_id", operator: "equals", value: "src_ga4_rtk" }]
        },
        ga4Context()
      );

      const drilldownQuery = queries.find((entry) => entry.sql.includes("from ga4_report_snapshot_fact"));
      expect(drilldownQuery?.sql, `${metric} should drill into ga4_report_snapshot_fact`).toBeDefined();
      // Source isolation is preserved for the widened metric set.
      expect(drilldownQuery?.sql).toContain("($2::text is null or source_id = $2)");
      expect(drilldownQuery?.params?.[0]).toBe("workspace");
      expect(drilldownQuery?.params?.[1]).toBe("src_ga4_rtk");
      // Must NOT fall through to the posthog default provider-truth branch.
      expect(queries.some((entry) => entry.sql.includes("from posthog_event_truth"))).toBe(false);
    }
  });

  // PR3 Step 14 — per-site resolver maps {site} -> source_id filter on the aggregate.
  it("resolves a per-site metric query to the linked GA4 source_id", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: "src_ga4_rtk"
    });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      { metric: "page_views", site: "rtk.dev" },
      ga4Context()
    );

    const aggregateQuery = queries.find((entry) =>
      entry.sql.includes("from queryable.vw_site_traffic")
    );
    expect(aggregateQuery?.sql).toBeDefined();
    // source_id is exempt from the dimension gate and emitted as `source_id = $N`.
    expect(aggregateQuery?.sql).toContain("source_id = $2");
    expect(aggregateQuery?.params).toEqual(["workspace", "src_ga4_rtk", 500]);
    // A resolved single site must NOT be flagged as a cross-site aggregate.
    expect(result?.caveats).not.toContain("multi_site_aggregate");
  });

  it("resolves a per-site breakdown query to the linked GA4 source_id", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: "src_ga4_rtk"
    });
    const handlers = createActionHandlers(db);

    await handlers.run_breakdown_query?.(
      {
        metric: "page_views",
        site: "rtk.dev",
        groupBy: ["device_category"]
      },
      ga4Context()
    );

    const aggregateQuery = queries.find((entry) =>
      entry.sql.includes("from queryable.vw_site_traffic")
    );
    expect(aggregateQuery?.sql).toBeDefined();
    expect(aggregateQuery?.sql).toContain("group by device_category");
    expect(aggregateQuery?.sql).toContain("source_id = $2");
    expect(aggregateQuery?.params?.[1]).toBe("src_ga4_rtk");
  });

  it("falls back to the lone connected GA4 source when no site link exists", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: null, // no FK link
      loneSources: ["src_ga4_only"]
    });
    const handlers = createActionHandlers(db);

    await handlers.run_metric_query?.({ metric: "page_views", site: "rtk.dev" }, ga4Context());

    const aggregateQuery = queries.find((entry) =>
      entry.sql.includes("from queryable.vw_site_traffic")
    );
    expect(aggregateQuery?.params?.[1]).toBe("src_ga4_only");
  });

  it("throws site_ambiguous when a requested site cannot be resolved to a source", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: null,
      loneSources: ["src_ga4_a", "src_ga4_b"] // two sources -> not lone
    });
    const handlers = createActionHandlers(db);

    await expect(
      handlers.run_metric_query?.({ metric: "page_views", site: "rtk.dev" }, ga4Context())
    ).rejects.toThrow("site_ambiguous");
  });

  // PR3 Step 14 — never silently sum across GA4 properties.
  it("flags an un-scoped multi-site GA4 aggregate with the multi_site_aggregate caveat", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { factHasRows: true, ga4SourceCount: 2 });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "page_views" }, ga4Context());

    expect(result?.caveats).toContain("multi_site_aggregate");
  });

  it("does not flag multi_site_aggregate when only one GA4 source exists", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { factHasRows: true, ga4SourceCount: 1 });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "page_views" }, ga4Context());

    expect(result?.caveats).not.toContain("multi_site_aggregate");
  });

  // PR3 Step 13 — no-data honesty (metric handler).
  it("reports no_data_synced when the GA4 fact table is empty (metric query)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [{ page_views: null }], probeHasRows: false });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "page_views" }, ga4Context());

    expect(result?.caveats).toContain("no_data_synced");
    expect((result?.data as Record<string, unknown>)?.noData).toMatchObject({ reason: "not_synced" });
  });

  it("reports no_data_for_range when the fact has rows but the range is empty (metric query)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [{ page_views: null }], probeHasRows: true });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      {
        metric: "page_views",
        // Old range end so the freshness lag does NOT fire (deterministic assertion).
        filters: [{ field: "occurred_on", operator: "lte", value: "2020-01-01" }]
      },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_for_range");
    expect(result?.caveats).not.toContain("ga4_freshness_lag");
    expect((result?.data as Record<string, unknown>)?.noData).toMatchObject({ reason: "no_data_for_range" });
  });

  it("adds ga4_freshness_lag when an empty range ends within the GA4 mutation window", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [{ page_views: null }], probeHasRows: true });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      {
        metric: "page_views",
        filters: [{ field: "occurred_on", operator: "lte", value: new Date().toISOString().slice(0, 10) }]
      },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_for_range");
    expect(result?.caveats).toContain("ga4_freshness_lag");
    expect((result?.data as Record<string, unknown>)?.freshness).toMatchObject({ ga4FreshnessLag: true });
  });

  // PR3 Step 13 — the SAME classifier must fire for breakdown queries (empty groups -> []).
  it("reports no_data_synced for an empty breakdown query (breakdown handler)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [], probeHasRows: false });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_breakdown_query?.(
      { metric: "page_views", groupBy: ["device_category"] },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_synced");
  });

  it("reports no_data_for_range for an empty breakdown over a populated fact (breakdown handler)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [], probeHasRows: true });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_breakdown_query?.(
      {
        metric: "page_views",
        groupBy: ["device_category"],
        filters: [{ field: "occurred_on", operator: "lte", value: "2020-01-01" }]
      },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_for_range");
  });

  // PR3 Step 13 — key_events specifically: a returned 0 with a populated fact and NO
  // historical key_events > 0 means the key event is unconfigured, not a genuine zero.
  it("reports key_events_unconfigured when key_events is 0 and never configured", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, {
      aggregateRows: [{ key_events: "0" }],
      keyEventsEverConfigured: false
    });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "key_events" }, ga4Context());

    expect(result?.caveats).toContain("key_events_unconfigured");
  });

  it("does not report key_events_unconfigured when key_events was historically configured", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, {
      aggregateRows: [{ key_events: "0" }],
      keyEventsEverConfigured: true
    });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "key_events" }, ga4Context());

    expect(result?.caveats).not.toContain("key_events_unconfigured");
  });
});

function ga4Context() {
  return {
    workspaceId: "workspace",
    authority: "tool_agent" as const,
    surface: "api" as const,
    actorId: "operator",
    sessionId: "session"
  };
}

// Fake DB for the per-site resolver: serves workspace_sites + sources lookups via `one`/
// `query`, captures aggregate SQL, and returns a non-empty aggregate row (so the no-data
// classifier does not fire on the resolution-path tests).
function ga4SiteResolverFakeDb(
  queries: Array<{ sql: string; params?: unknown[] }>,
  config: { siteUrl: string; ga4SourceId: string | null; loneSources?: string[] }
): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from sources") && sql.includes("google_analytics_4")) {
        return (config.loneSources ?? []).map((id) => ({ id })) as T[];
      }
      if (sql.includes("from queryable.vw_site_traffic")) {
        return [{ page_views: "120" }] as T[];
      }
      // Existence probe / key_events probe — say data exists so no no-data caveat fires.
      if (sql.includes("from ga4_report_snapshot_fact")) {
        return [{ "?column?": 1 }] as T[];
      }
      return [] as T[];
    },
    async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
      // The url/id match query binds siteUrlOrId as $2; assert it so a wrong param bind
      // (e.g. resolver passing the metric instead of the site) fails the test. Only the
      // requested site resolves — any other lookup value misses, mirroring real SQL.
      if (sql.includes("from workspace_sites") && sql.includes("(url = $2 or id = $2)")) {
        return params?.[1] === config.siteUrl ? ({ ga4_source_id: config.ga4SourceId } as T) : null;
      }
      // The primary-site fallback query binds only workspaceId ($1) and selects on
      // is_primary; the resolver tests do not exercise a separate primary row, so it misses.
      if (sql.includes("from workspace_sites")) {
        return null;
      }
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

// Fake DB for no-data / multi-site classification: drives the aggregate result, the
// existence probe, the key_events historical probe, and the GA4-source count.
function ga4ProbeFakeDb(
  queries: Array<{ sql: string; params?: unknown[] }>,
  config: {
    aggregateRows?: Record<string, unknown>[];
    factHasRows?: boolean;
    probeHasRows?: boolean;
    ga4SourceCount?: number;
    keyEventsEverConfigured?: boolean;
  }
): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from sources") && sql.includes("google_analytics_4")) {
        const count = config.ga4SourceCount ?? 1;
        return Array.from({ length: count }, (_, i) => ({ id: `src_ga4_${i}` })) as T[];
      }
      // key_events historical probe.
      if (sql.includes("key_events > 0")) {
        return (config.keyEventsEverConfigured ? [{ "?column?": 1 }] : []) as T[];
      }
      // Existence probe (select 1 ... limit 1) against either GA4 fact table.
      if (
        (sql.includes("from ga4_report_snapshot_fact") || sql.includes("from ga4_page_report_fact")) &&
        sql.includes("select 1")
      ) {
        const hasRows = config.probeHasRows ?? config.factHasRows ?? false;
        return (hasRows ? [{ "?column?": 1 }] : []) as T[];
      }
      // Drilldown rows (richer select) — return whatever; presence is enough.
      if (sql.includes("from ga4_report_snapshot_fact") || sql.includes("from ga4_page_report_fact")) {
        return [] as T[];
      }
      // Aggregate against the queryable view.
      if (sql.includes("from queryable.vw_site_traffic") || sql.includes("from queryable.vw_site_pages")) {
        return (config.aggregateRows ?? [{ page_views: "120" }]) as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

function ga4PageFakeDb(queries: Array<{ sql: string; params?: unknown[] }>): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from queryable.vw_site_pages")) {
        return [{ page_views_by_page: "180" }] as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

function ga4TrafficFakeDb(queries: Array<{ sql: string; params?: unknown[] }>): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from queryable.vw_site_traffic")) {
        return [{ page_views: "120" }] as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

// COMPARISON — a db that returns metric values keyed by the inclusive date range present
// in the SQL params, so the primary and prior-range runAggregate calls can be told apart.
function comparisonFakeDb(
  view: string,
  metric: string,
  byRange: Record<string, Record<string, unknown> | null>,
  queries: Array<{ sql: string; params?: unknown[] }>
): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes(`from ${view}`)) {
        // Params for an ungrouped query: [workspace, ...filterValues, limit]. The two
        // date bounds (gte then lte) are the filter values; key by "gte..lte".
        const values = (params ?? []).slice(1, -1).map((value) => String(value));
        const gte = values.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
        const lte = [...values].reverse().find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
        const key = `${gte}..${lte}`;
        const row = byRange[key];
        return (row ? [row] : []) as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

const COMPARISON_CONTEXT = {
  workspaceId: "workspace",
  authority: "tool_agent",
  surface: "api",
  actorId: "operator",
  sessionId: "session"
} as const;

describe("run_metric_query comparison (compareTo)", () => {
  describe("derivePriorRange", () => {
    it("derives the immediately preceding equal-length inclusive range (prior_period)", () => {
      // 2026-06-01..2026-06-07 is 7 inclusive days -> prior is 2026-05-25..2026-05-31.
      expect(derivePriorRange("2026-06-01", "2026-06-07", "prior_period")).toEqual({
        gte: "2026-05-25",
        lte: "2026-05-31"
      });
    });

    it("treats a single-day range as length 1 (prior_period)", () => {
      expect(derivePriorRange("2026-06-04", "2026-06-04", "prior_period")).toEqual({
        gte: "2026-06-03",
        lte: "2026-06-03"
      });
    });

    it("never overlaps or gaps the current range (prior_period is contiguous)", () => {
      const current = { gte: "2026-06-01", lte: "2026-06-30" };
      const prior = derivePriorRange(current.gte, current.lte, "prior_period");
      // prior.lte is exactly the day before current.gte; no overlap, no gap.
      expect(prior?.lte).toBe("2026-05-31");
      // inclusive length is preserved (30 days).
      const len = (Date.parse(`${prior?.lte}T00:00:00Z`) - Date.parse(`${prior?.gte}T00:00:00Z`)) / 86_400_000 + 1;
      expect(len).toBe(30);
    });

    it("shifts both bounds back one calendar year (prior_year), no leap-day drift", () => {
      expect(derivePriorRange("2026-02-01", "2026-02-28", "prior_year")).toEqual({
        gte: "2025-02-01",
        lte: "2025-02-28"
      });
    });

    it("clamps a leap-day bound to Feb-28 in a non-leap prior year (real SQL date, never '2023-02-29')", () => {
      // 2024-02-29 shifted to 2023 must NOT yield the literal "2023-02-29" (not a real date;
      // Postgres rejects it and the whole prior re-run throws). Clamp to 2023-02-28.
      expect(derivePriorRange("2024-02-29", "2024-02-29", "prior_year")).toEqual({
        gte: "2023-02-28",
        lte: "2023-02-28"
      });
      // A leap -> leap shift (2024 -> 2020) keeps Feb-29 intact.
      expect(derivePriorRange("2024-02-29", "2024-02-29", "prior_year")).not.toBeNull();
      expect(derivePriorRange("2028-02-29", "2028-02-29", "prior_year")).toEqual({
        gte: "2027-02-28",
        lte: "2027-02-28"
      });
    });

    it("rejects an inverted or malformed range", () => {
      expect(derivePriorRange("2026-06-07", "2026-06-01", "prior_period")).toBeNull();
      expect(derivePriorRange("not-a-date", "2026-06-07", "prior_period")).toBeNull();
      expect(derivePriorRange("not-a-date", "2026-06-07", "prior_year")).toBeNull();
    });
  });

  it("attaches a comparison block re-running the aggregate over the prior period", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "12000" }, // current
        "2026-05-25..2026-05-31": { recognized_revenue: "10000" } // prior
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );

    // Primary rows unchanged (envelope stays additive).
    expect((result?.data as { rows: unknown }).rows).toEqual([{ recognized_revenue: "12000" }]);
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      mode: "prior_period",
      current: 12000,
      previous: 10000,
      absoluteDelta: 2000,
      percentDelta: 20,
      direction: "up",
      range: {
        current: { gte: "2026-06-01", lte: "2026-06-07" },
        previous: { gte: "2026-05-25", lte: "2026-05-31" }
      }
    });
    // Exactly two aggregate round-trips (primary + prior), both scoped to the same view.
    const aggregateRuns = queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"));
    expect(aggregateRuns).toHaveLength(2);
    // The prior query carries the derived prior bounds, not the current ones.
    expect(aggregateRuns[1]?.params).toEqual(["workspace", "2026-05-25", "2026-05-31", 500]);
    expect(result?.caveats).not.toContain("no_prior_baseline");
  });

  it("supports prior_year by shifting the year on both bounds", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-30": { recognized_revenue: "30000" },
        "2025-06-01..2025-06-30": { recognized_revenue: "25000" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_year",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-30" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: Record<string, unknown> }).comparison).toMatchObject({
      mode: "prior_year",
      current: 30000,
      previous: 25000,
      absoluteDelta: 5000,
      percentDelta: 20,
      direction: "up",
      range: {
        previous: { gte: "2025-06-01", lte: "2025-06-30" }
      }
    });
  });

  it("guards a zero/empty previous baseline (no divide-by-zero; percentDelta null + no_prior_baseline)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "5000" } // current only; prior absent -> []
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      mode: "prior_period",
      current: 5000,
      previous: null,
      percentDelta: null,
      direction: "new"
    });
    // Never Infinity/NaN that the LLM could verbalize as a real percentage.
    expect((comparison as { percentDelta: unknown }).percentDelta).toBeNull();
    expect(result?.caveats).toContain("no_prior_baseline");
  });

  it("reports previous=0 as new (not -100% or Infinity)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "8000" },
        "2026-05-25..2026-05-31": { recognized_revenue: "0" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 8000,
      previous: 0,
      absoluteDelta: 8000,
      percentDelta: null,
      direction: "new"
    });
    expect(result?.caveats).toContain("no_prior_baseline");
  });

  it("passes a null rate metric through honestly instead of zeroing it", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_site_traffic",
      "engagement_rate",
      {
        "2026-06-01..2026-06-07": { engagement_rate: "0.62" },
        "2026-05-25..2026-05-31": { engagement_rate: null } // legitimately null (zero sessions)
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "engagement_rate",
        view: "queryable.vw_site_traffic",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 0.62,
      previous: null, // NOT 0
      percentDelta: null,
      direction: "new"
    });
    expect(result?.caveats).toContain("no_prior_baseline");
  });

  it("reads X date bounds from published_at (not occurred_on) for the prior re-run", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_x_authored_activity",
      "x_post_count",
      {
        "2026-06-01..2026-06-07": { x_post_count: "14" },
        "2026-05-25..2026-05-31": { x_post_count: "10" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "x_post_count",
        view: "queryable.vw_x_authored_activity",
        compareTo: "prior_period",
        // The model expresses the range with the generic `date` alias; the engine
        // normalizes it to published_at for X views — comparison must follow that.
        filters: [
          { field: "date", operator: "gte", value: "2026-06-01" },
          { field: "date", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: Record<string, unknown> }).comparison).toMatchObject({
      current: 14,
      previous: 10,
      absoluteDelta: 4,
      direction: "up"
    });
    const aggregateRuns = queries.filter((entry) => entry.sql.includes("from queryable.vw_x_authored_activity"));
    expect(aggregateRuns).toHaveLength(2);
    expect(aggregateRuns[0]?.sql).toContain("published_at >=");
    expect(aggregateRuns[1]?.params).toEqual(["workspace", "2026-05-25", "2026-05-31", 500]);
  });

  it("omits the comparison block and adds comparison_requires_date_range when date bounds are missing", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      { "undefined..undefined": { recognized_revenue: "5000" } },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      { metric: "recognized_revenue", view: "queryable.vw_revenue_by_source", compareTo: "prior_period" },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).toContain("comparison_requires_date_range");
    // Only the primary query ran — no second round-trip without a date range.
    expect(queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"))).toHaveLength(1);
  });

  it("is a no-op without compareTo (byte-identical to a plain query)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      { "2026-06-01..2026-06-07": { recognized_revenue: "12000" } },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).not.toContain("comparison_requires_date_range");
    expect(result?.caveats).not.toContain("no_prior_baseline");
    expect(queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"))).toHaveLength(1);
  });

  it("runs the prior_year leap-day re-run end-to-end through the SQL handler (clamped bound, no crash)", async () => {
    // Regression for the major defect: the prior bound must be a REAL date the handler can
    // execute. 2024-02-29 -> 2023-02-28 (clamped); the prior aggregate runs with that bound.
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2024-02-29..2024-02-29": { recognized_revenue: "4000" },
        "2023-02-28..2023-02-28": { recognized_revenue: "3000" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_year",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2024-02-29" },
          { field: "occurred_on", operator: "lte", value: "2024-02-29" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      mode: "prior_year",
      current: 4000,
      previous: 3000,
      absoluteDelta: 1000,
      direction: "up",
      range: { previous: { gte: "2023-02-28", lte: "2023-02-28" } }
    });
    // The prior re-run actually executed and carried the CLAMPED bounds, not "2023-02-29".
    const aggregateRuns = queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"));
    expect(aggregateRuns).toHaveLength(2);
    expect(aggregateRuns[1]?.params).toEqual(["workspace", "2023-02-28", "2023-02-28", 500]);
    expect(result?.caveats).not.toContain("comparison_failed");
  });

  it("reports direction:flat when current equals a non-zero previous", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "12000" },
        "2026-05-25..2026-05-31": { recognized_revenue: "12000" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 12000,
      previous: 12000,
      absoluteDelta: 0,
      percentDelta: 0,
      direction: "flat"
    });
    expect(result?.caveats).not.toContain("no_prior_baseline");
  });

  it("treats flat-at-zero (current=0, previous=0) as flat WITHOUT a no_prior_baseline caveat", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "0" },
        "2026-05-25..2026-05-31": { recognized_revenue: "0" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 0,
      previous: 0,
      absoluteDelta: 0,
      percentDelta: null,
      direction: "flat"
    });
    // Flat-at-zero is genuinely flat — not a missing baseline.
    expect(result?.caveats).not.toContain("no_prior_baseline");
  });

  it("degrades to comparison_failed (keeps the primary rows) when the prior re-run throws", async () => {
    // The prior aggregate throwing — invalid date, transient DB error, unsupported_dimension
    // on a malformed prior filter — must NOT discard the already-successful primary answer.
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let aggregateCalls = 0;
    const view = "queryable.vw_revenue_by_source";
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes(`from ${view}`)) {
          aggregateCalls += 1;
          if (aggregateCalls === 1) {
            return [{ recognized_revenue: "9000" }] as T[]; // primary succeeds
          }
          throw new Error("date/time field value out of range"); // prior re-run fails
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view,
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    // Primary answer is preserved; the whole query did NOT crash.
    expect((result?.data as { rows: unknown }).rows).toEqual([{ recognized_revenue: "9000" }]);
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).toContain("comparison_failed");
  });

  it("does NOT attach a comparison block on run_breakdown_query (compareTo is run_metric_query-only)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      { "2026-06-01..2026-06-07": { recognized_revenue: "12000", provider: "stripe" } },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_breakdown_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        groupBy: ["provider"],
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).not.toContain("comparison_requires_date_range");
    // breakdown ran only its single primary aggregate — no prior re-run.
    expect(queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"))).toHaveLength(1);
  });
});

describe("setup action helpers", () => {
  it("derives queryability status from connection or sync verification separately from install state", () => {
    expect(queryabilityStatusFromSourceVerification({})).toBe("pending");
    expect(queryabilityStatusFromSourceVerification({ connectionTest: { ok: true } })).toBe("verified");
    expect(queryabilityStatusFromSourceVerification({ syncStatus: "succeeded" })).toBe("verified");
    expect(queryabilityStatusFromSourceVerification({ connectionTest: { ok: false } })).toBe("failed");
    expect(queryabilityStatusFromSourceVerification({ syncStatus: "failed" })).toBe("failed");
  });

  it("reads connect_source and start_source_sync envelopes without exposing secrets", () => {
    const connected = connectedSourceFromEnvelope({
      ok: true,
      actionId: "connect_source",
      authority: "operator",
      status: "queued",
      data: {
        source: { id: "src_ga4", provider: "google_analytics_4" },
        connectionTest: { ok: true, mode: "live", provider: "google_analytics_4", accountExternalId: "properties/123" },
        initialSync: { queued: true, sourceId: "src_ga4", mode: "incremental" }
      },
      provenance: ["sources"],
      caveats: [],
      truncated: false,
      nextActions: []
    });
    const queued = queuedSourceSyncFromEnvelope({
      ok: true,
      actionId: "start_source_sync",
      authority: "operator",
      status: "queued",
      data: {
        job: { id: "job_sync_1", jobType: "source_sync" }
      },
      provenance: ["job_runs"],
      caveats: [],
      truncated: false,
      nextActions: []
    });

    expect(connected).toMatchObject({
      sourceId: "src_ga4",
      connectionTest: { ok: true, accountExternalId: "properties/123" },
      initialSync: { queued: true, mode: "incremental" }
    });
    expect(queued).toEqual({
      job: { id: "job_sync_1", jobType: "source_sync" },
      jobId: "job_sync_1"
    });
  });
});

describe("Meta Ads management handlers (money-safety + audit + dedup)", () => {
  const operatorContext = {
    workspaceId: "workspace",
    authority: "operator",
    surface: "cli",
    actorId: "operator",
    sessionId: "session"
  } as const;

  interface AuditRow {
    action: string;
    status: string;
    source_id: string;
    actor_type: string;
    details: Record<string, unknown>;
  }

  interface GraphCall {
    url: string;
    method: string | undefined;
    authorization: string | null;
    body: Record<string, unknown> | null;
  }

  // In-memory model of the meta_write_dedup table (migration 0028): a UNIQUE key
  // on (workspace_id, source_id, client_token). `claim` rows are keyed by token;
  // an `insert ... on conflict do nothing` returns the new id only when no row
  // with that token exists yet (mirrors the DB's atomic claim).
  interface DedupRow {
    id: string;
    clientToken: string;
    entityId: string | null;
  }

  // A fake db that serves the meta_ads source + an encrypted Meta credential,
  // records integration_audit_log inserts, and models the atomic dedup table.
  // `dedup` pre-seeds a RESOLVED dedup row (a prior succeeded create) so a repeat
  // with the same client_token is deduped. `dedupRows` lets a test inspect claims.
  function metaWriteTestDb(options: {
    audits: AuditRow[];
    dedup?: { clientToken: string; entityId: string };
    dedupRows?: DedupRow[];
  }): InfiniteOsDb {
    const dedupRows: DedupRow[] = options.dedupRows ?? [];
    if (options.dedup) {
      dedupRows.push({
        id: "mwd_seed",
        clientToken: options.dedup.clientToken,
        entityId: options.dedup.entityId
      });
    }
    return {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        if (sql.includes("insert into integration_audit_log")) {
          const p = params ?? [];
          options.audits.push({
            source_id: String(p[2]),
            actor_type: String(p[3]),
            action: String(p[4]),
            status: String(p[5]),
            details: JSON.parse(String(p[6])) as Record<string, unknown>
          });
        }
        if (sql.includes("update meta_write_dedup")) {
          const p = params ?? [];
          const row = dedupRows.find((r) => r.id === String(p[0]));
          if (row) {
            row.entityId = String(p[1]);
          }
        }
        if (sql.includes("delete from meta_write_dedup")) {
          const p = params ?? [];
          const idx = dedupRows.findIndex((r) => r.id === String(p[0]) && r.entityId === null);
          if (idx !== -1) {
            dedupRows.splice(idx, 1);
          }
        }
        return [] as T[];
      },
      async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
        if (sql.includes("from sources")) {
          return { provider: "meta_ads" } as T;
        }
        if (sql.includes("from connection_credentials")) {
          return {
            credential_kind: "system_user_token",
            encrypted_payload: encryptForTest({
              mode: "live",
              transport: "marketing_api",
              adAccountId: "act_999",
              accessToken: "secret-meta-token",
              apiVersion: "v25.0"
            }),
            oauth_token_id: null
          } as T;
        }
        // Atomic dedup CLAIM: insert ... on conflict do nothing returning id.
        if (sql.includes("insert into meta_write_dedup")) {
          const p = params ?? [];
          const claimId = String(p[0]);
          const token = String(p[3]);
          const entity = String(p[4]);
          if (dedupRows.some((r) => r.clientToken === token)) {
            // Conflict → no row returned (someone else holds the key).
            return null;
          }
          dedupRows.push({ id: claimId, clientToken: token, entityId: null });
          void entity;
          return { id: claimId } as T;
        }
        // Read back the existing claim's entity id on a dedup hit.
        if (sql.includes("from meta_write_dedup")) {
          const token = String(params?.[2] ?? "");
          const row = dedupRows.find((r) => r.clientToken === token);
          return row ? ({ entity_id: row.entityId } as T) : null;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        // INVARIANT 3: a money write must NEVER enqueue a worker job.
        throw new Error("createJob must not be called by a Meta write handler");
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
  }

  // Decode a Meta WRITE POST body. WRITE POSTs are form-encoded
  // (application/x-www-form-urlencoded): each nested object/array field is a JSON
  // STRING, which we parse back so shape assertions read naturally. Scalars stay
  // strings. Mirrors the production `metaFormEncode` + the connector test decoder.
  function decodeMetaWriteBody(raw: string): Record<string, unknown> | null {
    try {
      const params = new URLSearchParams(raw);
      const body: Record<string, unknown> = {};
      for (const [key, value] of params.entries()) {
        const trimmed = value.trim();
        body[key] = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(value) : value;
      }
      return body;
    } catch {
      return null;
    }
  }

  async function withGraph(
    responder: (call: GraphCall) => Response | Promise<Response>,
    fn: (calls: GraphCall[]) => Promise<void>
  ): Promise<void> {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const calls: GraphCall[] = [];
    // FIX 4: vi.stubGlobal/unstubAllGlobals (deterministic under parallel CI)
    // instead of raw `globalThis.fetch = …` + try/finally restore. A contaminated
    // fetch from another concurrent test can no longer mask a money-safety
    // regression here.
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body =
        init?.body && typeof init.body === "string" ? decodeMetaWriteBody(init.body) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: GraphCall = {
        url,
        method: init?.method,
        authorization: headers.Authorization ?? headers.authorization ?? null,
        body
      };
      calls.push(call);
      return Promise.resolve(responder(call));
    }) as typeof fetch);
    try {
      await fn(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  it("creates a campaign INLINE, lands PAUSED, never logs the token or raw budget", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ id: "120000000000777", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.create_meta_campaign?.(
          {
            sourceId: "src_meta",
            name: "Demo Requests",
            objective: "OUTCOME_TRAFFIC",
            dailyBudget: 5000,
            clientToken: "tok_camp_1"
          },
          operatorContext
        );

        // INVARIANT 1: hard-coded PAUSED in the POST body, status echoed back.
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/act_999/campaigns");
        expect(calls[0].method).toBe("POST");
        expect(calls[0].body).toMatchObject({ status: "PAUSED", objective: "OUTCOME_TRAFFIC" });
        expect(calls[0].authorization).toBe("Bearer secret-meta-token");
        expect(result?.data).toMatchObject({ id: "120000000000777", status: "PAUSED", deduped: false });

        // INVARIANT 6: audit row stores presence flags + ids, NEVER the token/amount.
        const audit = audits.find((row) => row.action === "create_meta_campaign");
        expect(audit?.status).toBe("succeeded");
        expect(audit?.actor_type).toBe("operator");
        expect(audit?.details).toMatchObject({
          entity: "campaign",
          entity_id: "120000000000777",
          client_token: "tok_camp_1",
          status: "PAUSED",
          budget_present: true,
          deduped: false
        });
        const serialized = JSON.stringify(audits);
        expect(serialized).not.toContain("secret-meta-token");
        expect(serialized).not.toContain("5000");
        expect(serialized).not.toContain("daily_budget");
      }
    );
  });

  it("dedups a repeat create by client_token without a second POST", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({
      audits,
      dedup: { clientToken: "tok_dupe", entityId: "120000000000111" }
    });
    await withGraph(
      () => jsonResponse({ id: "should-not-be-created", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.create_meta_campaign?.(
          {
            sourceId: "src_meta",
            name: "Dup",
            objective: "OUTCOME_TRAFFIC",
            clientToken: "tok_dupe"
          },
          operatorContext
        );
        // No Graph POST happened.
        expect(calls).toHaveLength(0);
        expect(result?.data).toMatchObject({ id: "120000000000111", deduped: true });
        const audit = audits.find((row) => row.action === "create_meta_campaign");
        expect(audit?.details).toMatchObject({ deduped: true, entity_id: "120000000000111" });
      }
    );
  });

  it("ATOMIC dedup: two concurrent same-token creates POST exactly once (FIX 5)", async () => {
    const audits: AuditRow[] = [];
    const dedupRows: DedupRow[] = [];
    const db = metaWriteTestDb({ audits, dedupRows });
    await withGraph(
      () => jsonResponse({ id: "120000000000999", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        // Fire two creates with the SAME client_token concurrently. The UNIQUE
        // claim means only ONE wins the claim and POSTs; the other dedups.
        const [a, b] = await Promise.all([
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Race A", objective: "OUTCOME_TRAFFIC", clientToken: "tok_race" },
            operatorContext
          ),
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Race B", objective: "OUTCOME_TRAFFIC", clientToken: "tok_race" },
            operatorContext
          )
        ]);
        // THE money-safety guarantee: exactly ONE Graph POST despite two
        // concurrent same-token creates (the UNIQUE claim blocked the second).
        expect(calls).toHaveLength(1);
        // Exactly one result is the real create (deduped:false) and one is the
        // deduped short-circuit (deduped:true). The winner carries the concrete
        // id; the loser carries the existing id, or null if it read the claim
        // while the winner was still mid-flight (documented concurrent behavior).
        const results = [a?.data, b?.data] as Array<Record<string, unknown>>;
        const winner = results.find((d) => d.deduped === false);
        const loser = results.find((d) => d.deduped === true);
        expect(winner).toBeDefined();
        expect(loser).toBeDefined();
        expect(winner?.id).toBe("120000000000999");
        // Only ONE dedup row exists and it resolves to the created entity id.
        expect(dedupRows).toHaveLength(1);
        expect(dedupRows[0].entityId).toBe("120000000000999");
      }
    );
  });

  it("clientToken is OPTIONAL (opt-out): a tokenless create writes NO dedup row and is not deduped", async () => {
    const audits: AuditRow[] = [];
    const dedupRows: DedupRow[] = [];
    const db = metaWriteTestDb({ audits, dedupRows });
    await withGraph(
      () => jsonResponse({ id: "120000000000888", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        // No clientToken → no dedup row, normal POST.
        await handlers.create_meta_campaign?.(
          { sourceId: "src_meta", name: "NoToken", objective: "OUTCOME_TRAFFIC" },
          operatorContext
        );
        expect(calls).toHaveLength(1);
        expect(dedupRows).toHaveLength(0);
      }
    );
  });

  it("releases an un-resolved claim on a failed POST so the same token can retry", async () => {
    const audits: AuditRow[] = [];
    const dedupRows: DedupRow[] = [];
    const db = metaWriteTestDb({ audits, dedupRows });
    await withGraph(
      () => jsonResponse({ error: { message: "boom" } }, 500),
      async () => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Fails", objective: "OUTCOME_TRAFFIC", clientToken: "tok_fail" },
            operatorContext
          )
        ).rejects.toMatchObject({ retryable: false });
        // The un-resolved claim was released, so the poisoned token is freed.
        expect(dedupRows).toHaveLength(0);
      }
    );
  });

  it("audits a failure and re-throws when Graph echoes ACTIVE (money-safety violation)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ id: "120000000000222", status: "ACTIVE" }),
      async () => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Sneaky", objective: "OUTCOME_TRAFFIC" },
            operatorContext
          )
        ).rejects.toMatchObject({ code: "money_safety_violation", retryable: false });
        const audit = audits.find((row) => row.action === "create_meta_campaign");
        expect(audit?.status).toBe("failed");
        expect(audit?.details).toMatchObject({ error_code: "money_safety_violation" });
      }
    );
  });

  it("activates an entity (the spend-bearing transition) and audits activation:true", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ success: true, status: "ACTIVE" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.set_meta_entity_status?.(
          { sourceId: "src_meta", entityId: "120000000000333", status: "ACTIVE" },
          operatorContext
        );
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/120000000000333");
        expect(calls[0].body).toEqual({ status: "ACTIVE" });
        expect(result?.data).toMatchObject({ id: "120000000000333", status: "ACTIVE", activation: true });
        const audit = audits.find((row) => row.action === "set_meta_entity_status");
        expect(audit?.status).toBe("succeeded");
        expect(audit?.details).toMatchObject({ requested_status: "ACTIVE", activation: true });
      }
    );
  });

  it("deletes an entity INLINE (DELETE /{id}, bodyless, bearer-only) and audits with the token redacted", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      // Graph answers a successful DELETE with { success: true }.
      () => jsonResponse({ success: true }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.delete_meta_entity?.(
          { sourceId: "src_meta", entityId: "120000000000444", entity: "campaign" },
          operatorContext
        );
        // DELETE hits the NODE id (no act_ edge), is bodyless, bearer-only.
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/120000000000444");
        expect(calls[0].method).toBe("DELETE");
        expect(calls[0].url).not.toContain("act_");
        expect(calls[0].body).toBeNull();
        expect(calls[0].authorization).toBe("Bearer secret-meta-token");
        expect(result?.data).toMatchObject({ id: "120000000000444", deleted: true, entity: "campaign" });

        // Operator audit row: succeeded, action/entity-id/status recorded, token redacted.
        const audit = audits.find((row) => row.action === "delete_meta_entity");
        expect(audit?.status).toBe("succeeded");
        expect(audit?.actor_type).toBe("operator");
        expect(audit?.details).toMatchObject({
          action: "delete_meta_entity",
          entity: "campaign",
          entity_id: "120000000000444",
          deleted: true
        });
        const serialized = JSON.stringify(audits);
        expect(serialized).not.toContain("secret-meta-token");
        // INVARIANT 3: a destructive write must NEVER enqueue a worker job (the
        // fake db's createJob throws if called) — reaching here proves it ran inline.
      }
    );
  });

  it("audits a delete failure (non-retryable) and re-throws WITHOUT the token", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ error: { message: "boom" } }, 500),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.delete_meta_entity?.(
            { sourceId: "src_meta", entityId: "120000000000555", entity: "ad" },
            operatorContext
          )
        ).rejects.toMatchObject({ retryable: false });
        // The connector still issued exactly one DELETE; no retry, no second call.
        expect(calls).toHaveLength(1);
        const audit = audits.find((row) => row.action === "delete_meta_entity");
        expect(audit?.status).toBe("failed");
        expect(audit?.details).toMatchObject({ entity: "ad", entity_id: "120000000000555" });
        expect(JSON.stringify(audits)).not.toContain("secret-meta-token");
      }
    );
  });

  it("delete is non-retryable on a 429 too (never inherits the read retryable taxonomy)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ error: { message: "rate limited" } }, 429),
      async () => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.delete_meta_entity?.(
            { sourceId: "src_meta", entityId: "120000000000666", entity: "adset" },
            operatorContext
          )
        ).rejects.toMatchObject({ retryable: false });
      }
    );
  });

  it("refuses a non-Meta source before issuing the DELETE", async () => {
    const audits: AuditRow[] = [];
    const db: InfiniteOsDb = {
      ...metaWriteTestDb({ audits }),
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return { provider: "stripe" } as T;
        }
        return null;
      }
    };
    await withGraph(
      () => jsonResponse({ success: true }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.delete_meta_entity?.(
            { sourceId: "src_stripe", entityId: "120000000000777" },
            operatorContext
          )
        ).rejects.toThrow("source_provider_mismatch");
        expect(calls).toHaveLength(0);
      }
    );
  });

  it("lists entities as a read (no audit row, normal taxonomy)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ data: [{ id: "c1", name: "Camp", status: "PAUSED" }] }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.list_meta_entities?.(
          { sourceId: "src_meta", entity: "campaign", limit: 5 },
          { ...operatorContext, authority: "tool_agent" }
        );
        expect(calls[0].method).toBe("GET");
        expect(calls[0].url).toContain("/act_999/campaigns");
        expect(result?.data).toMatchObject({ entity: "campaign", count: 1 });
        // Reads do not write an audit row.
        expect(audits).toHaveLength(0);
      }
    );
  });

  // FIX 1 (downstream): get_meta_entity threads the entity-kind hint so the
  // connector requests the SAME full field set as `list` for that object type,
  // instead of degrading to Graph's id-only node. Revert-proof: dropping the
  // `entity` pass-through in the handler reverts the request to the campaign
  // default and fails the adset assertion below.
  it("get_meta_entity threads the entity kind so it requests the full per-type field set", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () =>
        jsonResponse({
          id: "as_1",
          name: "AS",
          status: "PAUSED",
          campaign_id: "cmp_1",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          effective_status: "PAUSED"
        }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.get_meta_entity?.(
          { sourceId: "src_meta", entityId: "as_1", entity: "adset" },
          { ...operatorContext, authority: "tool_agent" }
        );
        expect(calls[0].method).toBe("GET");
        const url = new URL(calls[0].url);
        expect(url.pathname.endsWith("/as_1")).toBe(true);
        // The adset default field set (NOT the campaign default) is requested.
        expect(url.searchParams.get("fields")).toBe(
          "id,name,status,campaign_id,optimization_goal,billing_event,effective_status"
        );
        // The full node — not just {id} — flows back through the envelope.
        expect(result?.data).toMatchObject({
          id: "as_1",
          entity: { id: "as_1", name: "AS", campaign_id: "cmp_1" }
        });
        // Reads do not write an audit row.
        expect(audits).toHaveLength(0);
      }
    );
  });

  it("get_meta_entity honors an explicit fields override", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ id: "cmp_1", name: "C" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await handlers.get_meta_entity?.(
          { sourceId: "src_meta", entityId: "cmp_1", entity: "campaign", fields: "id,name" },
          { ...operatorContext, authority: "tool_agent" }
        );
        expect(new URL(calls[0].url).searchParams.get("fields")).toBe("id,name");
      }
    );
  });

  it("refuses a non-Meta source before touching the Graph API", async () => {
    const audits: AuditRow[] = [];
    const db: InfiniteOsDb = {
      ...metaWriteTestDb({ audits }),
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return { provider: "stripe" } as T;
        }
        return null;
      }
    };
    await withGraph(
      () => jsonResponse({ id: "nope" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_stripe", name: "X", objective: "OUTCOME_TRAFFIC" },
            operatorContext
          )
        ).rejects.toThrow("source_provider_mismatch");
        expect(calls).toHaveLength(0);
      }
    );
  });
});

function journeyTestDb(): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      if (sql.includes("from sources")) {
        return [
          {
            id: "src_meta",
            provider: "meta_ads",
            connection_name: "Meta Ads",
            status: "connected",
            last_synced_at: "2026-06-07T00:00:00.000Z"
          },
          {
            id: "src_x",
            provider: "x",
            connection_name: "X",
            status: "connected",
            last_synced_at: "2026-06-07T00:00:00.000Z"
          }
        ] as T[];
      }
      if (sql.includes("from metric_definitions")) {
        return [
          {
            id: "meta_ads_clicks",
            name: "Meta Ads clicks",
            source_view: "queryable.vw_meta_ads_campaign_daily",
            description: "Daily Meta Ads clicks from campaign insights"
          },
          {
            id: "x_public_engagement",
            name: "X public engagement",
            source_view: "queryable.vw_x_post_public_metrics",
            description: "Read-only public engagement from latest X post metric snapshots"
          }
        ] as T[];
      }
      if (sql.includes("from queryable_views")) {
        return [
          {
            id: "queryable.vw_meta_ads_campaign_daily",
            description: "Meta Ads campaign daily insights view"
          },
          {
            id: "queryable.vw_x_post_public_metrics",
            description: "X read-only public post metric snapshot view"
          }
        ] as T[];
      }
      if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
        return [
          {
            campaign_id: "cmp_launch",
            campaign_name: "Launch Demo Requests",
            meta_ads_clicks: "42",
            meta_ads_spend: "123.45",
            impressions: "1000",
            ctr: "4.2"
          },
          {
            campaign_id: "cmp_retarg",
            campaign_name: "Retargeting",
            meta_ads_clicks: "12",
            meta_ads_spend: "88.10",
            impressions: "700",
            ctr: "1.7"
          }
        ] as T[];
      }
      if (sql.includes("from queryable.vw_x_post_public_metrics")) {
        return [
          {
            x_post_id: "x_1",
            post_url: "https://x.com/founder/status/x_1",
            body_text: "Demo request launch thread",
            published_at: "2026-06-06T10:00:00.000Z",
            x_public_engagement: "80",
            like_count: "50",
            reply_count: "12"
          },
          {
            x_post_id: "x_2",
            post_url: "https://x.com/founder/status/x_2",
            body_text: "Meta creative teardown",
            published_at: "2026-06-05T10:00:00.000Z",
            x_public_engagement: "31",
            like_count: "20",
            reply_count: "4"
          }
        ] as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

function encryptForTest(payload: Record<string, unknown>): string {
  return encryptCredentialPayload(payload, "analytical-test-encryption-key");
}
