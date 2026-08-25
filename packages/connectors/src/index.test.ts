import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentialPayload, encryptCredentialPayload } from "@infinite-os/core";
import { type InfiniteOsDb } from "@infinite-os/db";

import {
  __testOnlySyncExtractedBatch,
  classifySyncFailure,
  connectorFor,
  connectorProviderForSetupProvider,
  createMetaAd,
  createMetaAdSet,
  createMetaCampaign,
  createMetaCreative,
  deleteMetaEntity,
  fetchMetaLiveInsights,
  findMetaDedupHit,
  ga4ConnectSourceFromSetup,
  getMetaEntity,
  listMetaAssets,
  listMetaEntities,
  metaDedupKey,
  posthogConnectSourceFromSetup,
  resolveMetaAdsCredential,
  setMetaEntityStatus,
  updateMetaBudget,
  xCredentialFromSetup,
  xConnectSourceFromSetup,
  type ExtractedRecord,
  type MetaAdsCredential,
  type MetaDedupRecord,
  type SyncPlan,
  type SyncRequest
} from "./index.js";

const TEST_ENCRYPTION_KEY = "connector-test-encryption-key";

// Stripe sync now picks a LANE (full replacement vs the 15-minute Events delta) at PLAN time, so
// extract() no longer infers one — a missing lane is a planning bug, not a defaultable field.
// Every test below drives extract() directly with a hand-built plan and is about the FULL lane's
// extraction behaviour, so it pins the lane explicitly. Delta-lane behaviour lives in
// stripe-delta.test.ts.
const STRIPE_FULL_LANE = {
  lane: "full",
  reason: "no_watermark",
  coverageGapReason: null
} as const;

describe("first-phase connector registry", () => {
  it("registers GA4, PostHog, Stripe, X, Shopify, and Meta Ads connectors", () => {
    expect(connectorFor("google_analytics_4").provider).toBe("google_analytics_4");
    expect(connectorFor("posthog").provider).toBe("posthog");
    expect(connectorFor("stripe").provider).toBe("stripe");
    expect(connectorFor("x").provider).toBe("x");
    expect(connectorFor("shopify").provider).toBe("shopify");
    expect(connectorFor("meta_ads").provider).toBe("meta_ads");
  });
});

describe("setup credential adapters", () => {
  it("maps setup provider ids to explicit connector provider ids", () => {
    expect(connectorProviderForSetupProvider("ga4")).toBe("google_analytics_4");
    expect(connectorProviderForSetupProvider("posthog")).toBe("posthog");
    expect(connectorProviderForSetupProvider("x")).toBe("x");
  });

  it("builds GA4 connect_source inputs from setup output without guessing ids", () => {
    expect(
      ga4ConnectSourceFromSetup({
        propertyId: "properties/123",
        accessToken: "ga4-token",
        apiBaseUrl: "https://analyticsdata.googleapis.com/v1beta"
      })
    ).toEqual({
      provider: "google_analytics_4",
      connectionName: "Google Analytics 4",
      credentialKind: "oauth_access_token",
      accountExternalId: "properties/123",
      credentialPayload: {
        mode: "live",
        propertyId: "properties/123",
        accessToken: "ga4-token",
        apiBaseUrl: "https://analyticsdata.googleapis.com/v1beta"
      }
    });
  });

  it("supports PostHog personal API keys or OAuth access tokens explicitly", () => {
    expect(
      posthogConnectSourceFromSetup({
        projectId: "42",
        personalApiKey: "phx_personal",
        apiHost: "https://us.i.posthog.com"
      })
    ).toMatchObject({
      provider: "posthog",
      credentialKind: "personal_api_key",
      accountExternalId: "42",
      credentialPayload: {
        mode: "live",
        projectId: "42",
        personalApiKey: "phx_personal",
        apiHost: "https://us.i.posthog.com"
      }
    });
    expect(
      posthogConnectSourceFromSetup({
        projectId: 84,
        accessToken: "oauth-token",
        apiHost: "https://eu.i.posthog.com"
      })
    ).toMatchObject({
      provider: "posthog",
      credentialKind: "oauth_access_token",
      accountExternalId: "84",
      credentialPayload: {
        mode: "live",
        projectId: 84,
        accessToken: "oauth-token",
        apiHost: "https://eu.i.posthog.com"
      }
    });
  });

  it("builds X connector payloads from setup output using raw bearer credentials only", () => {
    expect(
      xConnectSourceFromSetup({
        bearerToken: "x-secret",
        userId: "99",
        username: "@growthos"
      })
    ).toEqual({
      provider: "x",
      connectionName: "X",
      credentialKind: "bearer_token",
      accountExternalId: "99",
      credentialPayload: {
        mode: "live",
        bearerToken: "x-secret",
        userId: "99",
        username: "growthos"
      }
    });
  });

  it("rejects an X setup missing the bearer token before it is stored", () => {
    expect(() =>
      xCredentialFromSetup({
        bearerToken: "",
        userId: "99",
        username: "@growthos"
      })
    ).toThrow("bearerToken is required");
  });
});

describe("live provider clients", () => {
  it("tests GA4 credentials and extracts overview + page + event runReport rows", async () => {
    const requests: Array<{ url: string; body: Ga4ReportBody | null; authorization: string | null }> = [];
    await withMockFetch(async (url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Ga4ReportBody) : null;
      requests.push({
        url,
        body,
        authorization: headerValue(init.headers, "Authorization")
      });
      // Call-aware mock: testConnection asks for a single `date` dim; Report A is
      // overview-shaped (9 dims / 9 metrics); Report C is page-shaped (4 dims /
      // 5 metrics, includes pagePath); Report E is event-shaped (3 dims, includes
      // eventName). A shared single-shape mock mis-parses.
      if (isGa4PageReportBody(body)) {
        return jsonResponse({ rows: [ga4PageReportRowFixture()] });
      }
      if (isGa4EventReportBody(body)) {
        return jsonResponse({
          rows: [ga4EventReportRowFixture()],
          metadata: { timeZone: "Europe/London", currencyCode: "GBP" }
        });
      }
      if (isGa4OverviewReportBody(body)) {
        return jsonResponse({ rows: [ga4OverviewReportRowFixture()] });
      }
      // testConnection probe.
      return jsonResponse({ rows: [] });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/123",
            accessToken: "ga4-token",
            apiBaseUrl: "https://ga4.test"
          })
        }
      });
      const connector = connectorFor("google_analytics_4");
      await expect(connector.testConnection(db, request("google_analytics_4"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        accountExternalId: "properties/123"
      });
      const plan: SyncPlan = {
        cursorKey: "ga4_run_report",
        cursorStart: null,
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      };
      const rows = await connector.extract(db, request("google_analytics_4"), plan);

      // requests[0] = testConnection, [1] = Report A (overview), [2] = Report C (page),
      // [3] = Report E (event-name).
      expect(requests[0]).toMatchObject({
        url: "https://ga4.test/properties/123:runReport",
        authorization: "Bearer ga4-token"
      });
      expect(requests[1].body).toMatchObject({
        dimensions: expect.arrayContaining([
          { name: "landingPagePlusQueryString" },
          { name: "sessionSource" },
          { name: "sessionDefaultChannelGroup" },
          { name: "hostName" },
          { name: "deviceCategory" }
        ]),
        metrics: expect.arrayContaining([
          { name: "newUsers" },
          { name: "screenPageViews" },
          { name: "engagedSessions" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
          { name: "keyEvents" }
        ])
      });
      expect(requests[2].body).toMatchObject({
        dimensions: expect.arrayContaining([
          { name: "hostName" },
          { name: "pagePath" },
          { name: "pageTitle" }
        ]),
        metrics: expect.arrayContaining([
          { name: "screenPageViews" },
          { name: "sessions" },
          { name: "engagedSessions" },
          { name: "averageSessionDuration" },
          { name: "keyEvents" }
        ])
      });

      // Regression guard: GA4 caps a single runReport at 9 dimensions. pageReferrer was
      // dropped to fit; re-adding a 10th dimension would 400 against the live API.
      expect(ga4DimNames(requests[1].body)).toHaveLength(9);
      expect(ga4DimNames(requests[1].body)).not.toContain("pageReferrer");

      const overviewRecord = rows.find((row) => row.objectType === "ga4_run_report");
      const pageRecord = rows.find((row) => row.objectType === "ga4_page_report");
      expect(overviewRecord).toMatchObject({
        externalId: "ga4:20260601:United Kingdom:/:google:organic:brand:Organic Search:rtk.dev:desktop",
        objectType: "ga4_run_report",
        payload: {
          kind: "overview",
          reportingDate: "2026-06-01",
          country: "United Kingdom",
          sessionDefaultChannelGroup: "Organic Search",
          hostName: "rtk.dev",
          deviceCategory: "desktop",
          sessions: 10,
          totalUsers: 12,
          newUsers: 7,
          screenPageViews: 30,
          engagedSessions: 6,
          engagementRate: 0.75,
          averageSessionDuration: 95.5,
          keyEvents: 3
        }
      });
      expect(pageRecord).toMatchObject({
        objectType: "ga4_page_report",
        payload: {
          kind: "page",
          reportingDate: "2026-06-01",
          hostName: "rtk.dev",
          pagePath: "/pricing",
          pageTitle: "Pricing",
          screenPageViews: 42,
          sessions: 18,
          engagedSessions: 14,
          averageSessionDuration: 73.5,
          keyEvents: 6
        }
      });

      // Report E — event-name grain (the per-event key_events split).
      expect(requests[3].body).toMatchObject({
        dimensions: [{ name: "date" }, { name: "hostName" }, { name: "eventName" }],
        metrics: [{ name: "eventCount" }, { name: "keyEvents" }]
      });
      const eventRecord = rows.find((row) => row.objectType === "ga4_event_report");
      expect(eventRecord).toMatchObject({
        externalId: "ga4_event:20260601:rtk.dev:download_click",
        objectType: "ga4_event_report",
        payload: {
          kind: "event",
          reportingDate: "2026-06-01",
          hostName: "rtk.dev",
          eventName: "download_click",
          eventCount: 21,
          keyEvents: 5
        }
      });

      // Extraction recorded the snapshot-replacement contract for CLOSE: the refreshed window,
      // per-report staged counts, and the property metadata from the response.
      expect(plan.ga4SnapshotReplacement).toMatchObject({
        stagedOverviewRows: 1,
        stagedPageRows: 1,
        stagedEventRows: 1,
        propertyTimeZone: "Europe/London",
        dataThroughDate: "2026-06-01"
      });
      expect(plan.ga4SnapshotReplacement?.windowStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(plan.ga4SnapshotReplacement?.windowEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("falls back from keyEvents to conversions on a GA4 400 and maps it into keyEvents", async () => {
    const requests: Array<{ body: Ga4ReportBody | null }> = [];
    await withMockFetch(async (_url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Ga4ReportBody) : null;
      requests.push({ body });
      if (!body) {
        return jsonResponse({ rows: [] });
      }
      const metricNames = body.metrics.map((entry) => entry.name);
      // First time a report asks for keyEvents, reject with a GA4-style 400 naming the
      // invalid metric. fetchJson throws on 400; the connector retries with conversions.
      if (metricNames.includes("keyEvents")) {
        return new Response(
          JSON.stringify({
            error: { code: 400, message: "Field keyEvents is not a valid metric." }
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      if (isGa4PageReportBody(body)) {
        return jsonResponse({ rows: [ga4PageReportRowFixture({ keyEvents: "11" })] });
      }
      if (isGa4EventReportBody(body)) {
        return jsonResponse({ rows: [ga4EventReportRowFixture({ keyEvents: "4" })] });
      }
      if (isGa4OverviewReportBody(body)) {
        return jsonResponse({ rows: [ga4OverviewReportRowFixture({ keyEvents: "9" })] });
      }
      return jsonResponse({ rows: [] });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/123",
            accessToken: "ga4-token",
            apiBaseUrl: "https://ga4.test"
          })
        }
      });
      const connector = connectorFor("google_analytics_4");
      const rows = await connector.extract(db, request("google_analytics_4"), {
        cursorKey: "ga4_run_report",
        cursorStart: null,
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      });

      // Each report retried with `conversions` substituted for keyEvents.
      const retried = requests.filter((entry) => entry.body?.metrics.some((m) => m.name === "conversions"));
      expect(retried.length).toBe(3);
      for (const entry of retried) {
        expect(entry.body?.metrics.map((m) => m.name)).not.toContain("keyEvents");
      }

      const overviewRecord = rows.find((row) => row.objectType === "ga4_run_report");
      const pageRecord = rows.find((row) => row.objectType === "ga4_page_report");
      const eventRecord = rows.find((row) => row.objectType === "ga4_event_report");
      // The conversions value is mapped back into the keyEvents field positionally.
      expect((overviewRecord?.payload as { keyEvents: number }).keyEvents).toBe(9);
      expect((pageRecord?.payload as { keyEvents: number }).keyEvents).toBe(11);
      expect((eventRecord?.payload as { keyEvents: number }).keyEvents).toBe(4);
    });
  });

  it("plans PostHog cursor windows and maps event properties", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    await withMockFetch(async (_url, init) => {
      requests.push({ body: JSON.parse(String(init.body)) });
      return jsonResponse({
        columns: [
          { name: "uuid" },
          { name: "event" },
          { name: "distinct_id" },
          { name: "person_id" },
          { name: "properties" },
          { name: "timestamp" }
        ],
        results: [
          [
            "evt_1",
            "signup",
            "anon_1",
            "person_1",
            JSON.stringify({
              email: "founder@example.com",
              $session_id: "session_1",
              $current_url: "/pricing",
              $referrer: "https://newsletter.example",
              utm_source: "newsletter",
              utm_medium: "email",
              utm_campaign: "launch"
            }),
            "2026-06-02T10:00:00.000Z"
          ]
        ]
      });
    }, async () => {
      const db = fakeDb({
        cursorValue: "2026-06-01T00:00:00.000Z",
        credential: {
          credential_kind: "personal_api_key",
          encrypted_payload: encryptedCredential({
            mode: "live",
            projectId: 42,
            personalApiKey: "ph-key",
            apiHost: "https://posthog.test"
          })
        }
      });
      const connector = connectorFor("posthog");
      await expect(connector.planSync(db, request("posthog"))).resolves.toMatchObject({
        cursorKey: "posthog_event",
        cursorStart: "2026-06-01T00:00:00.000Z",
        mode: "live"
      });
      const rows = await connector.extract(db, request("posthog"), {
        cursorKey: "posthog_event",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      });

      expect(rows[0]).toMatchObject({
        externalId: "posthog:evt_1",
        objectType: "posthog_event",
        payload: {
          eventId: "evt_1",
          eventName: "signup",
          personId: "person_1",
          sessionId: "session_1",
          utmSource: "newsletter"
        }
      });
      const query = (requests[0]?.body.query as { query?: string; values?: Record<string, unknown> } | undefined);
      expect(query?.query).toContain("toDateTime('2026-06-01 00:00:00')");
      expect(query?.query).not.toContain("{start_time}");
      expect(query?.values).toEqual({});
    });
  });

  it("treats an empty PostHog cursor as no cursor", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    await withMockFetch(async (_url, init) => {
      requests.push({ body: JSON.parse(String(init.body)) });
      return jsonResponse({
        columns: [{ name: "uuid" }, { name: "event" }, { name: "distinct_id" }, { name: "timestamp" }],
        results: []
      });
    }, async () => {
      const db = fakeDb({
        cursorValue: "",
        credential: {
          credential_kind: "personal_api_key",
          encrypted_payload: encryptedCredential({
            mode: "live",
            projectId: 42,
            personalApiKey: "ph-key",
            apiHost: "https://posthog.test"
          })
        }
      });
      const connector = connectorFor("posthog");
      const plan = await connector.planSync(db, request("posthog"));

      expect(plan.cursorStart).toBeNull();
      await expect(connector.extract(db, request("posthog"), plan)).resolves.toEqual([]);
      const query = (requests[0]?.body.query as { query?: string; values?: Record<string, unknown> } | undefined);
      expect(query?.query).toMatch(/where timestamp >= toDateTime\('\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'\)/);
      expect(query?.values).toEqual({});
    });
  });

  it("accepts a PostHog OAuth access token for queryability checks", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    await withMockFetch(async (url, init) => {
      requests.push({
        url,
        authorization: headerValue(init.headers, "Authorization")
      });
      return jsonResponse({ results: [{ ok: 1 }] });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            projectId: "oauth-project",
            accessToken: "oauth-secret",
            apiHost: "https://oauth.posthog.test"
          })
        }
      });
      await expect(connectorFor("posthog").testConnection(db, request("posthog"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        accountExternalId: "oauth-project"
      });
      expect(requests).toEqual([
        {
          url: "https://oauth.posthog.test/api/projects/oauth-project/query/",
          authorization: "Bearer oauth-secret"
        }
      ]);
    });
  });

  it("paginates Stripe invoices, preserves Basil subscription references, and extracts subscription lifecycle rows", async () => {
    const urls: string[] = [];
    await withMockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/v1/customers")) {
        return jsonResponse({ data: [], has_more: false });
      }
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({
          data: [stripeSubscription("sub_1")],
          has_more: false
        });
      }
      if (url.includes("/v1/coupons/coupon_item")) {
        return jsonResponse({
          id: "coupon_item",
          duration: "forever",
          amount_off: null,
          percent_off: 25,
          currency: null,
        });
      }
      if (url.includes("starting_after=in_1")) {
        return jsonResponse({
          data: [
            stripeInvoice("in_2", {
              lines: { data: [stripeLine("il_2")], has_more: false }
            })
          ],
          has_more: false
        });
      }
      return jsonResponse({
        data: [
          stripeInvoice("in_1", {
            lines: { data: [stripeLine("il_1")], has_more: false }
          })
        ],
        has_more: true
      });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "api_key",
          encrypted_payload: encryptedCredential({
            mode: "live",
            secretKey: "sk_test",
            apiBaseUrl: "https://stripe.test"
          })
        }
      });
      const connector = connectorFor("stripe");
      await expect(connector.testConnection(db, request("stripe"))).resolves.toMatchObject({
        ok: true,
        mode: "live"
      });
      const rows = await connector.extract(db, request("stripe"), {
        cursorKey: "stripe_invoice",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
        stripeSyncLane: STRIPE_FULL_LANE,
      });

      expect(urls.some((url) => url.includes("starting_after=in_1"))).toBe(true);
      expect(urls.some((url) => url.includes("/v1/subscriptions"))).toBe(true);
      const invoiceListUrl = new URL(urls.find((url) => url.includes("/v1/invoices?")) ?? "");
      expect(invoiceListUrl.searchParams.getAll("expand[]")).toEqual(["data.customer"]);
      const subscriptionListUrl = new URL(urls.find((url) => url.includes("/v1/subscriptions?")) ?? "");
      expect(subscriptionListUrl.searchParams.getAll("expand[]")).toEqual([
        "data.customer",
        "data.items.data.price",
        "data.discounts.source.coupon",
        "data.items.data.discounts"
      ]);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        objectType: "stripe_invoice",
        payload: {
          invoiceId: "in_1",
          customerId: "cus_1",
          subscriptionId: "sub_1",
          externalOrderId: "order_1",
          lines: [{ lineId: "il_1", productId: "prod_1", priceId: "price_1" }]
        }
      });
      expect(rows[2]).toMatchObject({
        objectType: "stripe_subscription",
        payload: {
          subscriptionId: "sub_1",
          customerId: "cus_1",
          customerEmail: "internal@example.test",
          customerMetricsClassification: "internal_test",
          status: "active",
          trialEnd: "2026-06-10T12:00:00.000Z",
          discountsSynced: true,
          discounts: [
            {
              discountId: "di_forever",
              amountOff: 1000,
              percentOff: null,
              currency: "usd",
              duration: "forever",
              startsAt: "2026-07-07T14:29:11.000Z",
              endsAt: null,
            },
          ],
          items: [
            {
              itemId: "si_1",
              priceId: "price_1",
              productId: "prod_1",
              unitAmount: 4900,
              quantity: 1,
              recurringInterval: "month",
              discounts: [
                {
                  discountId: "di_item",
                  amountOff: null,
                  percentOff: 25,
                  currency: null,
                  duration: "forever",
                  startsAt: "2026-07-07T14:29:11.000Z",
                  endsAt: null,
                },
              ],
            }
          ]
        }
      });
    });
  });

  it("fully pages subscription items before preserving price classification and ordered discounts", async () => {
    const urls: string[] = [];
    const completeItems = Array.from({ length: 11 }, (_, index) => ({
      id: `si_page_${index}`,
      quantity: index === 0 ? null : index === 1 ? 0 : index + 1,
      discounts: index === 0
        ? [
            {
              id: "di_item_percent",
              start: 1_780_000_000,
              end: null,
              source: {
                coupon: {
                  duration: "forever",
                  percent_off: 20,
                  amount_off: null,
                  currency: null,
                },
              },
            },
            {
              id: "di_item_amount",
              start: 1_780_000_001,
              end: null,
              source: {
                coupon: {
                  duration: "forever",
                  percent_off: null,
                  amount_off: 500,
                  currency: "usd",
                },
              },
            },
          ]
        : [],
      price: {
        id: `price_page_${index}`,
        product: { id: `prod_page_${index}` },
        currency: "usd",
        unit_amount: index === 10 ? null : 6000,
        billing_scheme: index === 10 ? "tiered" : "per_unit",
        custom_unit_amount: null,
        recurring: {
          interval: "month",
          interval_count: 3,
          usage_type: index === 9 ? "metered" : "licensed",
        },
      },
    }));

    await withMockFetch(async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({
          data: [stripeSubscription("sub_paged", {
            items: { data: completeItems.slice(0, 10), has_more: true },
          })],
          has_more: false,
        });
      }
      if (parsed.pathname === "/v1/subscription_items") {
        return jsonResponse({ data: completeItems, has_more: false });
      }
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({ data: [], has_more: false });
      }
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: null,
          cursorEnd: "2026-08-04T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      );

      const itemListRequest = urls.find(
        (url) => new URL(url).pathname === "/v1/subscription_items",
      );
      expect(itemListRequest).toBeDefined();
      const itemListUrl = new URL(itemListRequest ?? "https://missing.invalid");
      expect(itemListUrl.searchParams.get("subscription")).toBe("sub_paged");
      expect(itemListUrl.searchParams.get("limit")).toBe("100");
      expect(itemListUrl.searchParams.getAll("expand[]")).toEqual([
        "data.price",
        "data.price.currency_options",
        "data.discounts",
      ]);

      const subscription = rows.find((row) => row.objectType === "stripe_subscription");
      expect(subscription?.payload).toMatchObject({
        subscriptionId: "sub_paged",
        itemsSynced: true,
        discountsSynced: true,
      });
      const subscriptionItems = (
        subscription?.payload as { items?: Array<Record<string, unknown>> } | undefined
      )?.items ?? [];
      expect(subscriptionItems).toHaveLength(11);
      expect(subscriptionItems[0]).toMatchObject({
        itemId: "si_page_0",
        quantity: null,
        recurringInterval: "month",
        recurringIntervalCount: 3,
        recurringUsageType: "licensed",
        billingScheme: "per_unit",
        customUnitAmount: false,
        discounts: [
          {
            discountId: "di_item_percent",
            position: 0,
            percentOff: 20,
            complete: true,
          },
          {
            discountId: "di_item_amount",
            position: 1,
            amountOff: 500,
            currency: "usd",
            complete: true,
          },
        ],
      });
      expect(subscriptionItems[1]).toMatchObject({
        itemId: "si_page_1",
        quantity: 0,
      });
    });
  });

  it("preserves conditional coupon and price evidence instead of collapsing it to default scalars", async () => {
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({
          data: [stripeSubscription("sub_conditional", {
            currency: "gbp",
            discounts: [
              {
                id: "di_product_restricted",
                start: 1_780_000_000,
                end: null,
                source: {
                  coupon: {
                    id: "coupon_product",
                    duration: "forever",
                    percent_off: 100,
                    amount_off: null,
                    currency: null,
                    applies_to: { products: ["prod_a"] },
                  },
                },
              },
              {
                id: "di_currency_option",
                start: 1_780_000_001,
                end: null,
                source: {
                  coupon: {
                    id: "coupon_currency",
                    duration: "forever",
                    percent_off: null,
                    amount_off: 1000,
                    currency: "usd",
                  },
                },
              },
              {
                id: "di_currency_option_missing",
                start: 1_780_000_002,
                end: null,
                source: {
                  coupon: {
                    id: "coupon_currency_missing",
                    duration: "forever",
                    percent_off: null,
                    amount_off: 1000,
                    currency: "usd",
                  },
                },
              },
            ],
            items: {
              data: [{
                id: "si_conditional",
                quantity: 6,
                discounts: [],
                price: {
                  id: "price_conditional",
                  product: { id: "prod_a" },
                  currency: "usd",
                  unit_amount: 1000,
                  billing_scheme: "per_unit",
                  custom_unit_amount: null,
                  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
                  transform_quantity: { divide_by: 5, round: "up" },
                },
              }],
              has_more: false,
            },
          })],
          has_more: false,
        });
      }
      if (parsed.pathname === "/v1/prices/price_conditional") {
        return jsonResponse({
          id: "price_conditional",
          product: { id: "prod_a" },
          currency: "usd",
          unit_amount: 1000,
          currency_options: { gbp: { unit_amount: 900, custom_unit_amount: null } },
          billing_scheme: "per_unit",
          custom_unit_amount: null,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          transform_quantity: { divide_by: 5, round: "up" },
        });
      }
      if (parsed.pathname === "/v1/coupons/coupon_currency") {
        return jsonResponse({
          id: "coupon_currency",
          duration: "forever",
          percent_off: null,
          amount_off: 1000,
          currency: "usd",
          currency_options: { gbp: { amount_off: 800 } },
        });
      }
      if (parsed.pathname === "/v1/coupons/coupon_currency_missing") {
        return jsonResponse({
          id: "coupon_currency_missing",
          duration: "forever",
          percent_off: null,
          amount_off: 1000,
          currency: "usd",
          currency_options: { eur: { amount_off: 900 } },
        });
      }
      if (parsed.pathname === "/v1/invoices") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: null,
          cursorEnd: "2026-08-04T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      );

      const subscription = rows.find((row) => row.objectType === "stripe_subscription");
      expect(subscription?.payload).toMatchObject({
        subscriptionId: "sub_conditional",
        discountsSynced: false,
        discounts: [
          {
            discountId: "di_product_restricted",
            appliesToProductIds: ["prod_a"],
            complete: false,
            incompleteReason: "product_restricted_discount_unsupported",
          },
          {
            discountId: "di_currency_option",
            amountOff: 800,
            currency: "gbp",
            amountOffCurrencyOptions: { gbp: 800 },
            currencyOptionResolved: true,
            complete: true,
          },
          {
            discountId: "di_currency_option_missing",
            amountOff: 1000,
            currency: "usd",
            amountOffCurrencyOptions: { eur: 900 },
            currencyOptionResolved: false,
            complete: false,
            incompleteReason: "discount_currency_option_unresolved",
          },
        ],
        items: [{
          itemId: "si_conditional",
          productId: "prod_a",
          currency: "gbp",
          unitAmount: 900,
          defaultCurrency: "usd",
          defaultUnitAmount: 1000,
          priceCurrencyOptions: { gbp: { unitAmount: 900, customUnitAmount: false } },
          currencyOptionResolved: true,
          transformQuantityDivideBy: 5,
          transformQuantityRound: "up",
        }],
      });
    });
  });

  // Origin is classified by KEY PRESENCE, because that is the only signal that separates
  // "Stripe says this invoice has no subscription parent" from "this API shape cannot say".
  // Before the fix, `'non_subscription'` needed a non-null `parent` object carrying a `type`,
  // so EVERY standalone dashboard invoice landed on `'unknown'` — and 0054 counts unknown paid
  // invoices over all time in `completeness_sufficient`, so one manual invoice ever would have
  // blocked trial acquisition + conversion metrics permanently.
  //
  // Note on the fixtures: these objects are JSON.stringify'd into the mock response, and
  // JSON.stringify DROPS undefined-valued keys — so `parent: undefined` here reaches the
  // extractor as a genuinely ABSENT key, which is what the legacy-API cases need.
  it("normalizes modern, legacy, and explicitly missing invoice subscription relationships", async () => {
    await withMockFetch(async (url) => {
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({ data: [], has_more: false });
      }
      return jsonResponse({
        data: [
          stripeInvoice("in_modern"),
          stripeInvoice("in_legacy", {
            parent: undefined,
            subscription: "sub_legacy",
          }),
          // Current API, standalone invoice: `parent` is present and explicitly null.
          stripeInvoice("in_standalone_modern", {
            parent: null,
            subscription: undefined,
          }),
          // Current API, non-subscription parent (e.g. a quote): present, not subscription-shaped.
          stripeInvoice("in_quote_parent", {
            parent: { type: "quote_details", quote_details: { quote: "qt_1" } },
            subscription: undefined,
          }),
          // Pre-2025-03-31 API version: no `parent` key at all, `subscription` present-and-null.
          stripeInvoice("in_standalone_legacy", {
            parent: undefined,
            subscription: null,
          }),
          // Neither key present at all — genuinely undeterminable, and the ONLY unknown case.
          stripeInvoice("in_unlinked", {
            parent: undefined,
            subscription: undefined,
          }),
        ],
        has_more: false,
      });
    }, async () => {
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      );

      const invoices = rows.filter((row) => row.objectType === "stripe_invoice");
      expect(invoices.map((row) => row.payload)).toMatchObject([
        { invoiceId: "in_modern", subscriptionId: "sub_1", subscriptionOrigin: "subscription" },
        { invoiceId: "in_legacy", subscriptionId: "sub_legacy", subscriptionOrigin: "subscription" },
        { invoiceId: "in_standalone_modern", subscriptionId: null, subscriptionOrigin: "non_subscription" },
        { invoiceId: "in_quote_parent", subscriptionId: null, subscriptionOrigin: "non_subscription" },
        { invoiceId: "in_standalone_legacy", subscriptionId: null, subscriptionOrigin: "non_subscription" },
        { invoiceId: "in_unlinked", subscriptionId: null, subscriptionOrigin: "unknown" },
      ]);
    });
  });

  it("rejects a Stripe invoice with no status instead of assuming it was paid", async () => {
    // `String(invoice.status ?? "paid")` turned an unreadable record into revenue. A paid-invoice
    // view keys entirely off status = 'paid', so this was the cheapest possible way to fabricate
    // money. Refuse the record; a non-retryable typed failure surfaces as an explicit source error.
    await withMockFetch(async (url) => {
      if (url.includes("/v1/subscriptions")) return jsonResponse({ data: [], has_more: false });
      if (url.includes("/v1/events")) return jsonResponse({ data: [], has_more: false });
      return jsonResponse({
        data: [stripeInvoice("in_no_status", { status: undefined })],
        has_more: false,
      });
    }, async () => {
      await expect(connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: null,
          cursorEnd: "2026-08-04T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      )).rejects.toThrow(/in_no_status returned no status/);
    });
  });

  it("rejects a Stripe invoice with no currency instead of inventing usd", async () => {
    // `invoice.currency ?? "usd"` silently mislabeled the one field every downstream
    // exponent/formatting decision keys on. Same contract-violation stance as missing status.
    await withMockFetch(async (url) => {
      if (url.includes("/v1/subscriptions")) return jsonResponse({ data: [], has_more: false });
      if (url.includes("/v1/events")) return jsonResponse({ data: [], has_more: false });
      return jsonResponse({
        data: [stripeInvoice("in_no_currency", { currency: undefined })],
        has_more: false,
      });
    }, async () => {
      await expect(connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: null,
          cursorEnd: "2026-08-04T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      )).rejects.toThrow(/in_no_currency returned no currency/);
    });
  });

  it("keeps a customer-less Stripe invoice null rather than collapsing it onto a synthetic customer", async () => {
    // `String(invoice.customer ?? "")` wrote the empty string, so every customer-less invoice
    // shared one stripe_customers row that then participated in the eligibility join.
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
      if (parsed.pathname === "/v1/subscriptions") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({
          data: [stripeInvoice("in_no_customer", { customer: null })],
          has_more: false,
        });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    // No synthetic customer row, and no lineage claiming one.
    expect(queryLog.some((entry) => entry.sql.includes("insert into stripe_customers"))).toBe(false);
    const invoiceUpsert = queryLog.find((entry) => entry.sql.includes("insert into stripe_invoices"));
    expect(invoiceUpsert?.params?.[4]).toBe("in_no_customer");
    expect(invoiceUpsert?.params?.[5]).toBeNull();
  });

  it("captures Stripe credit-note amounts so revenue consumers can net post-payment refunds", async () => {
    // recognized_revenue stays GROSS by design; what was missing was any refund signal at all.
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
      if (parsed.pathname === "/v1/subscriptions") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({
          data: [
            stripeInvoice("in_credited", {
              post_payment_credit_notes_amount: 1500,
              pre_payment_credit_notes_amount: 0,
            }),
            // Absent stays NULL, never a defaulted 0: consumers must be able to tell
            // "Stripe reported nothing" from "Stripe reported zero".
            stripeInvoice("in_uncredited"),
          ],
          has_more: false,
        });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    // Scoped to the LOAD-phase writer. The reconciliation lane emits its own repair upsert against
    // the same table at CLOSE, and it is distinguishable by carrying no `raw_record_id` (a repair
    // has no raw-record provenance of its own). Against this in-memory fake every read returns
    // nothing, so the reconciler sees every remote row as `missing_local` and repairs it — an
    // artifact of the mock, not of the connector: on a real DB the LOAD transactions have already
    // committed those rows by CLOSE (see the PGlite bootstrap test in stripe-delta.test.ts, where
    // a first full sync drifts on exactly one field and the pass after it is clean).
    const invoiceUpserts = queryLog.filter((entry) =>
      entry.sql.includes("insert into stripe_invoices") && entry.sql.includes("raw_record_id"),
    );
    expect(invoiceUpserts).toHaveLength(2);
    expect(invoiceUpserts[0]?.sql).toContain("post_payment_credit_notes_amount");
    expect(invoiceUpserts[0]?.sql).toMatch(
      /post_payment_credit_notes_amount\s*=\s*excluded\.post_payment_credit_notes_amount/,
    );
    expect(invoiceUpserts[0]?.params?.[15]).toBe(1500);
    expect(invoiceUpserts[0]?.params?.[16]).toBe(0);
    expect(invoiceUpserts[1]?.params?.[15]).toBeNull();
    expect(invoiceUpserts[1]?.params?.[16]).toBeNull();
  });

  it("writes an inert Stripe subscription placeholder from an invoice instead of forcing 'active'", async () => {
    // The invoice payload carries no subscription status and no current_period_end. Force-writing
    // status='active' + a null period end on conflict OVERWROTE real subscription truth, and
    // because LOAD is chunked into separate transactions a chunk failure could COMMIT that
    // corruption (a canceled subscription counted as paying). A phantom row — an invoice naming a
    // subscription /v1/subscriptions never listed — additionally landed 'active' with
    // items_sync_complete=false, which the 0056 lifecycle view's fail-closed bool_or turns into a
    // workspace-wide NULL for current_paid_subscribers.
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
      if (parsed.pathname === "/v1/subscriptions") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({ data: [stripeInvoice("in_placeholder")], has_more: false });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    const placeholder = queryLog.find((entry) =>
      entry.sql.includes("insert into stripe_subscriptions"),
    );
    expect(placeholder?.sql).toContain("'unknown'");
    expect(placeholder?.sql).not.toContain("'active'");
    expect(placeholder?.sql).toContain("on conflict (source_id, stripe_subscription_id) do nothing");
    expect(placeholder?.sql).not.toMatch(/status\s*=\s*excluded\.status/);
    expect(placeholder?.sql).not.toMatch(/current_period_end\s*=\s*excluded\.current_period_end/);
  });

  it("lets real Stripe subscription truth overwrite an invoice-written placeholder", async () => {
    // The other half of the contract: the placeholder must be PROMOTABLE. The subscription lane's
    // upsert overwrites status unconditionally, so a placeholder written first in the same run
    // (or a previous one) is corrected the moment /v1/subscriptions lists the subscription.
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
      if (parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({
          data: [stripeSubscription("sub_1", {
            status: "canceled",
            canceled_at: 1760500000,
            discounts: [],
            items: {
              data: [{
                id: "si_promoted",
                quantity: 1,
                discounts: [],
                price: {
                  id: "price_promoted",
                  product: { id: "prod_promoted" },
                  currency: "usd",
                  unit_amount: 4900,
                  billing_scheme: "per_unit",
                  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
                },
              }],
              has_more: false,
            },
          })],
          has_more: false,
        });
      }
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({ data: [stripeInvoice("in_promoted")], has_more: false });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    // LOAD-phase writers only — see the `raw_record_id` note on the credit-note test above.
    const subscriptionWrites = queryLog.filter((entry) =>
      entry.sql.includes("insert into stripe_subscriptions") && entry.sql.includes("raw_record_id"),
    );
    expect(subscriptionWrites).toHaveLength(2);
    // The invoice-derived placeholder never overwrites …
    expect(subscriptionWrites[0]?.sql).toContain("do nothing");
    // … and the real subscription row does, carrying the true (terminal) status.
    expect(subscriptionWrites[1]?.sql).toMatch(/status\s*=\s*excluded\.status/);
    expect(subscriptionWrites[1]?.params?.[6]).toBe("canceled");
  });

  it("discovers an old invoice through its later invoice.paid event and deduplicates duplicate events", async () => {
    const urls: string[] = [];
    await withMockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/v1/events")) {
        return jsonResponse({
          data: [
            stripeInvoicePaidEvent("evt_late_a", "in_late", 1783209600),
            stripeInvoicePaidEvent("evt_late_b", "in_late", 1783209601),
          ],
          has_more: false,
        });
      }
      if (url.includes("/v1/invoices/in_late")) {
        return jsonResponse(stripeInvoice("in_late", {
          created: 1775001600,
          status_transitions: { paid_at: 1783209600 },
          lines: { data: [stripeLine("il_late")], has_more: false },
        }));
      }
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({ data: [], has_more: false });
      }
      return jsonResponse({ data: [], has_more: false });
    }, async () => {
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeInvoiceState: {
            backfill_state: "complete",
            backfill_starting_after: null,
            latest_successful_stripe_cutoff: "2026-07-04T00:00:00.000Z",
            event_window_from: null,
            event_window_to: null,
            event_starting_after: null,
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: "2026-07-05T00:00:00.000Z",
          cursorEnd: "2026-07-06T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      );

      expect(urls.some((url) => url.includes("/v1/events"))).toBe(true);
      expect(urls.some((url) => url.includes("/v1/invoices/in_late"))).toBe(true);
      expect(rows.filter((row) => row.objectType === "stripe_invoice")).toHaveLength(1);
      expect(rows.find((row) => row.objectType === "stripe_invoice")?.payload).toMatchObject({
        invoiceId: "in_late",
        paidAt: "2026-07-05T00:00:00.000Z",
      });
    });
  });

  it("polls a fixed lagged half-open subscription lifecycle segment independently of invoice reconciliation", async () => {
    const urls: string[] = [];
    const plan: SyncPlan = {
      cursorKey: "stripe_invoice",
      cursorStart: null,
      cursorEnd: "2026-08-04T00:00:00.789Z",
      refreshWindowDays: 30,
      mode: "live",
      stripeSyncLane: STRIPE_FULL_LANE,
    };
    await withMockFetch(async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({ data: [], has_more: false });
      }
      if (parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({
          data: [stripeSubscription("sub_current_trial", {
            status: "trialing",
            discounts: [],
            items: { data: [], has_more: false },
          })],
          has_more: false,
        });
      }
      if (parsed.pathname === "/v1/events") {
        return jsonResponse({
          data: [stripeSubscriptionEvent("evt_trial_start", "customer.subscription.updated", 1_753_050_000, {
            data: {
              object: stripeSubscription("sub_trial", { status: "trialing" }),
              previous_attributes: { status: "active" },
            },
          })],
          has_more: false,
        });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        plan,
      );

      const lifecycleUrl = urls
        .map((url) => new URL(url))
        .find((url) => url.pathname === "/v1/events" && url.searchParams.getAll("types[]").length > 0);
      expect(lifecycleUrl).toBeDefined();
      expect(lifecycleUrl?.searchParams.getAll("types[]")).toEqual([
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.paused",
        "customer.subscription.resumed",
        "customer.subscription.trial_will_end",
      ]);
      expect(lifecycleUrl?.searchParams.get("created[gte]")).toBe(String(
        Date.parse("2026-07-06T23:55:00.000Z") / 1000,
      ));
      expect(lifecycleUrl?.searchParams.get("created[lt]")).toBe(String(
        Date.parse("2026-08-03T23:55:00.000Z") / 1000,
      ));
      expect(lifecycleUrl?.searchParams.has("created[lte]")).toBe(false);
      expect(rows.find((row) => row.objectType === "stripe_subscription_event")?.payload).toMatchObject({
        stripeEventId: "evt_trial_start",
        eventType: "customer.subscription.updated",
        subscriptionId: "sub_trial",
        livemode: true,
        currentStatus: "trialing",
        previousStatus: "active",
      });
      expect(rows.find((row) => row.objectType === "stripe_subscription")?.payload).toMatchObject({
        subscriptionId: "sub_current_trial",
        liveMode: true,
      });
      expect((plan as SyncPlan & { stripeTrialCheckpoint?: unknown }).stripeTrialCheckpoint).toMatchObject({
        segmentFrom: "2026-07-06T23:55:00.000Z",
        segmentToExclusive: "2026-08-03T23:55:00.000Z",
        segmentComplete: true,
        latestClosedSegmentToExclusive: "2026-08-03T23:55:00.000Z",
      });
    });
  });

  it("resumes the exact persisted lifecycle segment cursor instead of recomputing retention bootstrap", async () => {
    const urls: string[] = [];
    const plan: SyncPlan = {
      cursorKey: "stripe_invoice",
      cursorStart: null,
      cursorEnd: "2026-08-04T00:00:00.789Z",
      refreshWindowDays: 30,
      mode: "live",
      stripeSyncLane: STRIPE_FULL_LANE,
    };
    await withMockFetch(async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/invoices" || parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({ data: [], has_more: false });
      }
      if (parsed.pathname === "/v1/events") {
        return jsonResponse({ data: [], has_more: false });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeTrialState: {
            current_segment_from: "2026-07-20T00:00:00.000Z",
            current_segment_to_exclusive: "2026-07-21T00:00:00.000Z",
            current_segment_starting_after: "evt_resume",
            continuous_coverage_from: null,
            closed_through_exclusive: null,
            retention_gap_count: 0,
          },
        }),
        request("stripe"),
        plan,
      );

      const lifecycleUrl = urls
        .map((url) => new URL(url))
        .find((url) => url.pathname === "/v1/events" && url.searchParams.getAll("types[]").length > 0);
      expect(lifecycleUrl?.searchParams.get("created[gte]")).toBe(String(
        Date.parse("2026-07-20T00:00:00.000Z") / 1000,
      ));
      expect(lifecycleUrl?.searchParams.get("created[lt]")).toBe(String(
        Date.parse("2026-07-21T00:00:00.000Z") / 1000,
      ));
      expect(lifecycleUrl?.searchParams.get("starting_after")).toBe("evt_resume");
      expect(plan.stripeTrialCheckpoint).toMatchObject({
        segmentFrom: "2026-07-20T00:00:00.000Z",
        segmentToExclusive: "2026-07-21T00:00:00.000Z",
        segmentComplete: true,
      });
    });
  });

  it("canonicalizes a new overlap segment to Stripe's integer-second event bounds", async () => {
    const urls: string[] = [];
    const plan: SyncPlan = {
      cursorKey: "stripe_invoice",
      cursorStart: null,
      cursorEnd: "2026-08-04T00:00:00.789Z",
      refreshWindowDays: 30,
      mode: "live",
      stripeSyncLane: STRIPE_FULL_LANE,
    };
    await withMockFetch(async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/invoices" || parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({ data: [], has_more: false });
      }
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeTrialState: {
            current_segment_from: null,
            current_segment_to_exclusive: null,
            current_segment_starting_after: null,
            continuous_coverage_from: "2026-07-06T23:55:00.000Z",
            closed_through_exclusive: "2026-08-03T00:00:00.000Z",
            retention_gap_count: 0,
          },
        }),
        request("stripe"),
        plan,
      );
    });

    const lifecycleUrl = urls
      .map((url) => new URL(url))
      .find((url) => url.pathname === "/v1/events" && url.searchParams.getAll("types[]").length > 0);
    expect(lifecycleUrl?.searchParams.get("created[gte]")).toBe(String(
      Date.parse("2026-08-02T23:55:00.000Z") / 1000,
    ));
    expect(lifecycleUrl?.searchParams.get("created[lt]")).toBe(String(
      Date.parse("2026-08-03T23:55:00.000Z") / 1000,
    ));
    expect(plan.stripeTrialCheckpoint).toMatchObject({
      segmentFrom: "2026-08-02T23:55:00.000Z",
      segmentToExclusive: "2026-08-03T23:55:00.000Z",
      resetContinuousCoverage: false,
    });
  });

  it("abandons fractional persisted resume bounds instead of claiming mismatched coverage", async () => {
    const urls: string[] = [];
    const plan: SyncPlan = {
      cursorKey: "stripe_invoice",
      cursorStart: null,
      cursorEnd: "2026-08-04T00:00:00.789Z",
      refreshWindowDays: 30,
      mode: "live",
      stripeSyncLane: STRIPE_FULL_LANE,
    };
    await withMockFetch(async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/invoices" || parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({ data: [], has_more: false });
      }
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeTrialState: {
            current_segment_from: "2026-07-20T00:00:00.789Z",
            current_segment_to_exclusive: "2026-07-21T00:00:00.789Z",
            current_segment_starting_after: "evt_unsafe_resume",
            continuous_coverage_from: null,
            closed_through_exclusive: null,
            retention_gap_count: 0,
          },
        }),
        request("stripe"),
        plan,
      );
    });

    const lifecycleUrl = urls
      .map((url) => new URL(url))
      .find((url) => url.pathname === "/v1/events" && url.searchParams.getAll("types[]").length > 0);
    expect(lifecycleUrl?.searchParams.get("starting_after")).toBeNull();
    expect(lifecycleUrl?.searchParams.get("created[gte]")).toBe(String(
      Date.parse("2026-07-06T23:55:00.000Z") / 1000,
    ));
    expect(lifecycleUrl?.searchParams.get("created[lt]")).toBe(String(
      Date.parse("2026-08-03T23:55:00.000Z") / 1000,
    ));
    expect(plan.stripeTrialCheckpoint).toMatchObject({
      segmentFrom: "2026-07-06T23:55:00.000Z",
      segmentToExclusive: "2026-08-03T23:55:00.000Z",
      segmentStartingAfter: null,
      resetContinuousCoverage: false,
    });
  });

  it("starts a new continuous retention segment and records a gap when the prior cutoff is stale", async () => {
    const plan: SyncPlan = {
      cursorKey: "stripe_invoice",
      cursorStart: null,
      cursorEnd: "2026-08-04T00:00:00.000Z",
      refreshWindowDays: 30,
      mode: "live",
      stripeSyncLane: STRIPE_FULL_LANE,
    };
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/invoices" || parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({ data: [], has_more: false });
      }
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeTrialState: {
            current_segment_from: null,
            current_segment_to_exclusive: null,
            current_segment_starting_after: null,
            continuous_coverage_from: "2026-06-01T00:00:00.000Z",
            closed_through_exclusive: "2026-06-02T00:00:00.000Z",
            retention_gap_count: 1,
          },
        }),
        request("stripe"),
        plan,
      );
    });

    expect(plan.stripeTrialCheckpoint).toMatchObject({
      segmentFrom: "2026-07-06T23:55:00.000Z",
      segmentToExclusive: "2026-08-03T23:55:00.000Z",
      resetContinuousCoverage: true,
      retentionGapReason: "event_retention_gap",
    });
  });

  it("resumes an interrupted all-history paid-invoice backfill without a creation-time floor", async () => {
    const urls: string[] = [];
    await withMockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/v1/subscriptions") || url.includes("/v1/events")) {
        return jsonResponse({ data: [], has_more: false });
      }
      return jsonResponse({
        data: [stripeInvoice("in_historical", { created: 1609459200 })],
        has_more: false,
      });
    }, async () => {
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeInvoiceState: {
            backfill_state: "in_progress",
            backfill_starting_after: "in_resume",
            latest_successful_stripe_cutoff: null,
            event_window_from: "2026-07-01T00:00:00.000Z",
            event_window_to: "2026-07-06T00:00:00.000Z",
            event_starting_after: null,
          },
        }),
        request("stripe"),
        {
          cursorKey: "stripe_invoice",
          cursorStart: "2026-07-05T00:00:00.000Z",
          cursorEnd: "2026-07-06T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
          stripeSyncLane: STRIPE_FULL_LANE,
        },
      );

      const invoiceListUrl = new URL(
        urls.find((url) => url.includes("/v1/invoices?")) ?? "https://missing.test",
      );
      expect(invoiceListUrl.searchParams.get("starting_after")).toBe("in_resume");
      expect(invoiceListUrl.searchParams.has("created[gte]")).toBe(false);
      expect(rows.find((row) => row.objectType === "stripe_invoice")?.payload).toMatchObject({
        invoiceId: "in_historical",
      });
    });
  });

  it("re-enters bounded full reconciliation when the paid-event cutoff is older than safe retention", async () => {
    const urls: string[] = [];
    await withMockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({ data: [], has_more: false });
      }
      return jsonResponse({
        data: [stripeInvoice("in_stale_reconcile", { created: 1609459200 })],
        has_more: false,
      });
    }, async () => {
      const plan: SyncPlan = {
        cursorKey: "stripe_invoice",
        cursorStart: "2026-07-31T00:00:00.000Z",
        cursorEnd: "2026-08-01T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
        stripeSyncLane: STRIPE_FULL_LANE,
      };
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
          stripeInvoiceState: {
            backfill_state: "complete",
            backfill_starting_after: null,
            latest_successful_stripe_cutoff: "2026-06-01T00:00:00.000Z",
            event_window_from: null,
            event_window_to: null,
            event_starting_after: null,
          },
        }),
        request("stripe"),
        plan,
      );

      const invoiceListUrl = new URL(
        urls.find((url) => url.includes("/v1/invoices?")) ?? "https://missing.test",
      );
      expect(invoiceListUrl.searchParams.has("created[gte]")).toBe(false);
      expect(urls.some((url) => {
        const parsed = new URL(url);
        return parsed.pathname === "/v1/events" && parsed.searchParams.get("type") === "invoice.paid";
      })).toBe(false);
      expect(rows.find((row) => row.objectType === "stripe_invoice")?.payload).toMatchObject({
        invoiceId: "in_stale_reconcile",
      });
      expect(plan.stripeInvoiceCheckpoint).toMatchObject({
        backfillState: "complete",
        latestSuccessfulStripeCutoff: "2026-08-01T00:00:00.000Z",
      });
    });
  });

  it("bounds an initial all-history crawl and checkpoints the exact next paid-invoice page", async () => {
    const invoiceUrls: string[] = [];
    let page = 0;
    await withMockFetch(async (url) => {
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({ data: [], has_more: false });
      }
      if (url.includes("/v1/invoices?")) {
        invoiceUrls.push(url);
        page += 1;
        return jsonResponse({
          data: [stripeInvoice(`in_page_${page}`, { created: 1500000000 - page })],
          has_more: true,
        });
      }
      if (url.includes("/v1/events?")) return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      const plan: SyncPlan = {
        cursorKey: "stripe_invoice",
        cursorStart: null,
        cursorEnd: "2026-08-01T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
        stripeSyncLane: STRIPE_FULL_LANE,
      };
      const rows = await connectorFor("stripe").extract(
        fakeDb({
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
        plan,
      );

      expect(invoiceUrls).toHaveLength(5);
      expect(invoiceUrls.every((url) => !new URL(url).searchParams.has("created[gte]"))).toBe(true);
      expect(new URL(invoiceUrls[1]).searchParams.get("starting_after")).toBe("in_page_1");
      expect(rows.filter((row) => row.objectType === "stripe_invoice")).toHaveLength(5);
      expect(plan.stripeInvoiceCheckpoint).toMatchObject({
        backfillState: "in_progress",
        backfillStartingAfter: "in_page_5",
        eventWindowFrom: "2026-08-01T00:00:00.000Z",
        latestSuccessfulStripeCutoff: null,
      });
    });
  });

  it("tests Shopify credentials and extracts order rows from GraphQL Admin", async () => {
    const requests: Array<{ url: string; body: unknown; token: string | null }> = [];
    await withMockFetch(async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({
        url,
        body,
        token: headerValue(init.headers, "X-Shopify-Access-Token")
      });
      if (typeof body?.query === "string" && body.query.includes("shop {")) {
        return jsonResponse({ data: { shop: { myshopifyDomain: "demo-shop.myshopify.com" } } });
      }
      if (typeof body?.query === "string" && body.query.includes("products(")) {
        return jsonResponse({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: "gid://shopify/Product/200",
                    title: "Logo Tee",
                    vendor: "Infinite OS",
                    productType: "Apparel",
                    status: "ACTIVE",
                    createdAt: "2026-05-01T10:00:00.000Z",
                    updatedAt: "2026-06-02T09:00:00.000Z"
                  }
                }
              ]
            }
          }
        });
      }
      return jsonResponse({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: {
                  id: "gid://shopify/Order/1001",
                  name: "#1001",
                  createdAt: "2026-06-02T10:00:00.000Z",
                  processedAt: "2026-06-02T10:05:00.000Z",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "FULFILLED",
                  customer: {
                    id: "gid://shopify/Customer/501",
                    email: "buyer@example.com"
                  },
                  currentSubtotalPriceSet: {
                    shopMoney: { amount: "100.00", currencyCode: "USD" }
                  },
                  currentTotalTaxSet: {
                    shopMoney: { amount: "5.00", currencyCode: "USD" }
                  },
                  currentTotalDiscountsSet: {
                    shopMoney: { amount: "10.00", currencyCode: "USD" }
                  },
                  currentTotalPriceSet: {
                    shopMoney: { amount: "95.00", currencyCode: "USD" }
                  },
                  lineItems: {
                    edges: [
                      {
                        node: {
                          id: "gid://shopify/LineItem/1",
                          sku: "tee-1",
                          quantity: 2,
                          name: "Logo Tee",
                          originalUnitPriceSet: {
                            shopMoney: { amount: "50.00", currencyCode: "USD" }
                          },
                          product: {
                            id: "gid://shopify/Product/200",
                            title: "Logo Tee",
                            vendor: "Infinite OS",
                            productType: "Apparel",
                            status: "ACTIVE"
                          },
                          variant: { id: "gid://shopify/ProductVariant/300" }
                        }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "admin_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            storeDomain: "demo-shop.myshopify.com",
            adminAccessToken: "shpat_test",
            apiVersion: "2026-01"
          })
        }
      });
      const connector = connectorFor("shopify");
      await expect(connector.testConnection(db, request("shopify"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "shopify",
        accountExternalId: "demo-shop.myshopify.com"
      });
      const rows = await connector.extract(db, request("shopify"), {
        cursorKey: "shopify_order",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
      });

      expect(requests[0]).toMatchObject({
        url: "https://demo-shop.myshopify.com/admin/api/2026-01/graphql.json",
        token: "shpat_test"
      });
      expect(requests[1]?.body).toMatchObject({
        variables: expect.objectContaining({ cursor: null })
      });
      expect(String((requests[1]?.body as { query?: string } | undefined)?.query ?? "")).toContain("orders(");
      expect(String((requests[2]?.body as { query?: string } | undefined)?.query ?? "")).toContain("products(");
      expect(rows[0]).toMatchObject({
        externalId: "shopify:gid://shopify/Order/1001",
        objectType: "shopify_order",
        payload: {
          orderId: "gid://shopify/Order/1001",
          orderName: "#1001",
          customerEmail: "buyer@example.com",
          currency: "USD",
          totalPriceAmount: 9500,
          lineItems: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              productId: "gid://shopify/Product/200",
              variantId: "gid://shopify/ProductVariant/300",
              quantity: 2,
              lineTotalAmount: 10000
            }
          ]
        }
      });
      expect(rows[1]).toMatchObject({
        externalId: "shopify_product:gid://shopify/Product/200",
        objectType: "shopify_product",
        payload: {
          productId: "gid://shopify/Product/200",
          title: "Logo Tee",
          vendor: "Infinite OS",
          productType: "Apparel",
          status: "ACTIVE"
        }
      });
    });
  });

  it("rejects invalid Shopify store domains before sending the admin token", async () => {
    const requests: string[] = [];
    await withMockFetch(async (url) => {
      requests.push(url);
      return jsonResponse({});
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "admin_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            storeDomain: "evil.example.com",
            adminAccessToken: "shpat_test"
          })
        }
      });
      await expect(connectorFor("shopify").testConnection(db, request("shopify"))).rejects.toThrow(/myshopify\.com/);
      expect(requests).toHaveLength(0);
    });
  });

  it("paginates Shopify order line items past the first 100 rows", async () => {
    await withMockFetch(async (_url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (typeof body?.query === "string" && body.query.includes("shop {")) {
        return jsonResponse({ data: { shop: { myshopifyDomain: "demo-shop.myshopify.com" } } });
      }
      if (typeof body?.query === "string" && body.query.includes("order(id: $orderId)")) {
        return jsonResponse({
          data: {
            order: {
              lineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: "gid://shopify/LineItem/2",
                      sku: "tee-2",
                      quantity: 1,
                      name: "Backup Tee",
                      originalUnitPriceSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } },
                      product: {
                        id: "gid://shopify/Product/201",
                        title: "Backup Tee",
                        vendor: "Infinite OS",
                        productType: "Apparel",
                        status: "ACTIVE"
                      },
                      variant: { id: "gid://shopify/ProductVariant/301" }
                    }
                  }
                ]
              }
            }
          }
        });
      }
      if (typeof body?.query === "string" && body.query.includes("products(")) {
        return jsonResponse({
          data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } }
        });
      }
      return jsonResponse({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: {
                  id: "gid://shopify/Order/1001",
                  name: "#1001",
                  createdAt: "2026-06-02T10:00:00.000Z",
                  processedAt: "2026-06-02T10:05:00.000Z",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "FULFILLED",
                  customer: { id: "gid://shopify/Customer/501", email: "buyer@example.com" },
                  currentSubtotalPriceSet: { shopMoney: { amount: "125.00", currencyCode: "USD" } },
                  currentTotalTaxSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
                  currentTotalDiscountsSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
                  currentTotalPriceSet: { shopMoney: { amount: "130.00", currencyCode: "USD" } },
                  lineItems: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                    edges: [
                      {
                        node: {
                          id: "gid://shopify/LineItem/1",
                          sku: "tee-1",
                          quantity: 2,
                          name: "Logo Tee",
                          originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
                          product: {
                            id: "gid://shopify/Product/200",
                            title: "Logo Tee",
                            vendor: "Infinite OS",
                            productType: "Apparel",
                            status: "ACTIVE"
                          },
                          variant: { id: "gid://shopify/ProductVariant/300" }
                        }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "admin_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            storeDomain: "demo-shop.myshopify.com",
            adminAccessToken: "shpat_test",
            apiVersion: "2026-01"
          })
        }
      });
      const rows = await connectorFor("shopify").extract(db, request("shopify"), {
        cursorKey: "shopify_order",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
      });
      expect(rows[0]).toMatchObject({
        payload: {
          lineItems: [
            expect.objectContaining({ lineItemId: "gid://shopify/LineItem/1" }),
            expect.objectContaining({ lineItemId: "gid://shopify/LineItem/2" })
          ]
        }
      });
    });
  });

  it("tests Meta Ads credentials and extracts daily campaign insight rows", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const router = metaGraphMockRouter({
      data: [
        {
          campaign_id: "1200000001",
          campaign_name: "Scale Growth",
          date_start: "2026-06-01",
          spend: "123.45",
          clicks: "89",
          impressions: "4567",
          reach: "3200",
          cpm: "27.03",
          cpc: "1.39",
          ctr: "1.95"
        }
      ],
      paging: {}
    });
    await withMockFetch(async (url, init) => {
      requests.push({
        url,
        authorization: headerValue(init.headers, "Authorization")
      });
      return router(url);
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "marketing_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await expect(connector.testConnection(db, request("meta_ads"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "meta_ads",
        accountExternalId: "act_1234567890"
      });
      const rows = await connector.extract(db, request("meta_ads"), {
        cursorKey: "meta_ads_campaign_daily",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
      });

      // The probe (testConnection) is the first request — a level=campaign /insights GET.
      expect(requests[0]).toMatchObject({
        url: expect.stringContaining("https://graph.facebook.com/v24.0/act_1234567890/insights"),
        authorization: "Bearer meta-access-token"
      });
      expect(requests[0]?.url).not.toContain("access_token=");
      // The extract's CAMPAIGN insights request (found by level=campaign, distinct from the
      // probe — it carries the full field list + attribution windows). Located by predicate
      // because the extract now also issues the /adsets + /campaigns edge reads + the adset
      // insights pass, so positional indices are no longer stable.
      const campaignInsights = requests.filter(
        (entry) => isMetaCampaignInsightsRequest(entry.url) && entry.url.includes("action_attribution_windows=")
      );
      const extractCampaignInsights = campaignInsights[campaignInsights.length - 1];
      expect(extractCampaignInsights?.url).toContain("time_increment=1");
      // Phase-1 (§4) field list: spend/clicks/impressions/reach/cpm/cpc/ctr PLUS the
      // conversion fields (inline_link_clicks, frequency, actions, action_values,
      // results, cost_per_result, result_values_performance_indicator, objective,
      // optimization_goal). All transports request the SAME list (META_ADS_INSIGHTS_FIELDS).
      expect(extractCampaignInsights?.url).toContain(
        "campaign_id%2Ccampaign_name%2Cdate_start%2Cspend%2Cclicks%2Cinline_link_clicks%2Cimpressions%2Creach%2Cfrequency%2Ccpm%2Ccpc%2Cctr%2Cactions%2Caction_values%2Cresults%2Ccost_per_result%2Cresult_values_performance_indicator%2Cobjective%2Coptimization_goal"
      );
      // §4 — per-window attribution requested (1d_click,7d_click,1d_view); the
      // headline 7d_click+1d_view is computed from the subvalues. 7d_view/28d_view
      // are hard-excluded and use_unified_attribution_setting is NOT sent (a no-op).
      expect(extractCampaignInsights?.url).toContain("action_attribution_windows=");
      expect(extractCampaignInsights?.url).toContain("1d_click");
      expect(extractCampaignInsights?.url).toContain("7d_click");
      expect(extractCampaignInsights?.url).toContain("1d_view");
      expect(extractCampaignInsights?.url).not.toContain("7d_view");
      expect(extractCampaignInsights?.url).not.toContain("28d_view");
      expect(extractCampaignInsights?.url).not.toContain("use_unified_attribution_setting");
      // §4b — the adset insights pass requests adset_id,adset_name in addition (level=adset).
      const adsetInsights = requests.find((entry) => isMetaAdsetInsightsRequest(entry.url));
      expect(adsetInsights?.url).toContain("adset_id");
      expect(adsetInsights?.url).toContain("adset_name");
      expect(rows[0]).toMatchObject({
        externalId: "meta_ads:act_1234567890:1200000001:2026-06-01",
        objectType: "meta_ads_campaign_daily",
        payload: {
          adAccountId: "act_1234567890",
          campaignId: "1200000001",
          campaignName: "Scale Growth",
          occurredOn: "2026-06-01",
          spend: 123.45,
          clicks: 89,
          impressions: 4567,
          reach: 3200
        }
      });
    });
  });

  it("emits the Phase-1 default Meta Ads insights request (level=campaign, time_increment=1, conversion fields + attribution windows)", async () => {
    // Grain guard: `level`/`time_increment` are resolved through defaults — with no
    // SyncRequest override the emitted request keeps campaign grain + daily increment.
    // Phase-1 (§4) additionally pins the full conversion field list and the
    // action_attribution_windows. If a future edit changes the default grain, drops
    // level/time_increment, or drifts the field list across transports, this fails.
    const requests: Array<{ url: string }> = [];
    await withMockFetch(async (url) => {
      requests.push({ url });
      return jsonResponse({ data: [], paging: {} });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "marketing_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await connector.extract(db, request("meta_ads"), {
        cursorKey: "meta_ads_campaign_daily",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
      });

      // The CAMPAIGN insights request (located by predicate — the extract now also issues
      // the /adsets + /campaigns edge reads and an adset insights pass, so requests[0] is no
      // longer the campaign insights GET).
      const campaignInsightsUrl = new URL(
        requests.map((entry) => entry.url).find((url) => isMetaCampaignInsightsRequest(url)) ?? ""
      );
      expect(campaignInsightsUrl.searchParams.get("level")).toBe("campaign");
      expect(campaignInsightsUrl.searchParams.get("time_increment")).toBe("1");
      // account_currency is REQUESTED (§2.1, load-bearing for the Stripe join). It is a
      // valid Insights field the API returns only when asked; if it ever falls out of the
      // list, currency goes null in live mode and the Meta↔Stripe ROAS join can't reconcile.
      // The CAMPAIGN pass keeps EXACTLY the Phase-1 field list (no adset_id — that is added
      // only at level=adset).
      expect(campaignInsightsUrl.searchParams.get("fields")).toBe(
        "campaign_id,campaign_name,date_start,spend,clicks,inline_link_clicks,impressions,reach,frequency,cpm,cpc,ctr,actions,action_values,results,cost_per_result,result_values_performance_indicator,objective,optimization_goal,account_currency"
      );
      expect(campaignInsightsUrl.searchParams.get("fields")).toContain("account_currency");
      expect(campaignInsightsUrl.searchParams.get("limit")).toBe("100");
      // §4 — attribution windows sent as a JSON array; 7d_view/28d_view excluded.
      expect(JSON.parse(campaignInsightsUrl.searchParams.get("action_attribution_windows") ?? "[]")).toEqual([
        "1d_click",
        "7d_click",
        "1d_view"
      ]);
      // §4b — the internal adset insights pass adds adset_id,adset_name to the field list.
      const adsetInsightsUrl = new URL(
        requests.map((entry) => entry.url).find((url) => isMetaAdsetInsightsRequest(url)) ?? ""
      );
      expect(adsetInsightsUrl.searchParams.get("level")).toBe("adset");
      expect(adsetInsightsUrl.searchParams.get("fields")).toBe(
        "adset_id,adset_name,campaign_id,campaign_name,date_start,spend,clicks,inline_link_clicks,impressions,reach,frequency,cpm,cpc,ctr,actions,action_values,results,cost_per_result,result_values_performance_indicator,objective,optimization_goal,account_currency"
      );
    });
  });

  it("threads Meta Ads insights grain overrides through to the request (plumbing is real)", async () => {
    // Proves the params are genuinely wired (not dead defaults): a future phase can set
    // adset grain / hourly increment via the SyncRequest and the call honors them.
    const requests: Array<{ url: string }> = [];
    await withMockFetch(async (url) => {
      requests.push({ url });
      return jsonResponse({ data: [], paging: {} });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "marketing_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await connector.extract(
        db,
        { ...request("meta_ads"), metaAdsInsightsLevel: "adset", metaAdsInsightsTimeIncrement: "all_days" },
        {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        }
      );

      // With an explicit level=adset override, the campaign pass is skipped; only the adset
      // insights pass runs (after the /adsets + /campaigns edge reads). Locate it by predicate.
      const insightsUrl = new URL(
        requests.map((entry) => entry.url).find((url) => isMetaAdsetInsightsRequest(url)) ?? ""
      );
      expect(insightsUrl.searchParams.get("level")).toBe("adset");
      expect(insightsUrl.searchParams.get("time_increment")).toBe("all_days");
      // And no campaign insights pass was issued (the explicit override pins adset grain).
      expect(requests.some((entry) => isMetaCampaignInsightsRequest(entry.url))).toBe(false);
    });
  });

  it("uses Meta Ads backfill request options when planning and extracting", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const router = metaGraphMockRouter({
      data: [
        {
          campaign_id: "1200000001",
          campaign_name: "Scale Growth",
          date_start: "2026-06-01",
          spend: "123.45",
          clicks: "89",
          impressions: "4567",
          reach: "3200"
        }
      ],
      paging: {}
    });
    await withMockFetch(async (url, init) => {
      requests.push({
        url,
        authorization: headerValue(init.headers, "Authorization")
      });
      return router(url);
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "marketing_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      const sixMonthPlan = await connector.planSync(db, {
        ...request("meta_ads"),
        backfillWindow: "6_months",
        refreshWindowDays: 180
      });
      expect(sixMonthPlan).toMatchObject({
        cursorKey: "meta_ads_campaign_daily",
        refreshWindowDays: 180,
        backfillWindow: "6_months"
      });

      const allTimePlan = await connector.planSync(db, {
        ...request("meta_ads"),
        backfillWindow: "all_time"
      });
      const rows = await connector.extract(
        db,
        { ...request("meta_ads"), backfillWindow: "all_time" },
        allTimePlan
      );

      // The all_time backfill date options ride the CAMPAIGN insights request (the edge reads
      // carry no time window). Located by predicate since the extract issues edges first.
      const campaignInsights = requests.find((entry) => isMetaCampaignInsightsRequest(entry.url));
      expect(campaignInsights?.url).toContain("date_preset=maximum");
      expect(campaignInsights?.url).not.toContain("time_range=");
      expect(campaignInsights?.authorization).toBe("Bearer meta-access-token");
      expect(rows[0]).toMatchObject({
        externalId: "meta_ads:act_1234567890:1200000001:2026-06-01"
      });
    });
  });

  it("ignores an existing Meta Ads cursor when planning an explicit backfill", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const router = metaGraphMockRouter({
      data: [
        {
          campaign_id: "1200000001",
          campaign_name: "Scale Growth",
          date_start: "2026-03-17",
          spend: "8.29",
          clicks: "37",
          impressions: "1314"
        }
      ],
      paging: {}
    });
    await withMockFetch(async (url, init) => {
      requests.push({
        url,
        authorization: headerValue(init.headers, "Authorization")
      });
      return router(url);
    }, async () => {
      const db = fakeDb({
        cursorValue: "2026-06-05T04:08:40.304Z",
        credential: {
          credential_kind: "marketing_api_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      const plan = await connector.planSync(db, {
        ...request("meta_ads"),
        mode: "backfill",
        refreshWindowDays: 120
      });

      await connector.extract(db, { ...request("meta_ads"), mode: "backfill", refreshWindowDays: 120 }, plan);

      // The backfill time window rides the CAMPAIGN insights request (the edge reads carry
      // none). Located by predicate since the extract issues edges first.
      const campaignInsights = requests.find((entry) => isMetaCampaignInsightsRequest(entry.url));
      const queryUrl = new URL(campaignInsights?.url ?? "");
      const timeRange = JSON.parse(queryUrl.searchParams.get("time_range") ?? "{}") as {
        since?: string;
        until?: string;
      };
      expect(timeRange.since).not.toBe("2026-06-05");
      expect(timeRange.since).toMatch(/20\d\d-\d\d-\d\d/);
      expect(campaignInsights?.authorization).toBe("Bearer meta-access-token");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // §9 GOLDEN FIXTURE — the live Ultima lead-gen probe. The SAME 2 leads appear
  // under 4 action_types; the §4b canonical-event mapping must collapse this to
  // exactly 2 leads (NOT 8). This is the acceptance gate for "never sum actions[]".
  const ULTIMA_PROBE = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/meta-ultima-leadgen-probe.json", import.meta.url)),
      "utf8"
    )
  ) as { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };

  async function extractUltimaRow(): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown> = {};
    await withMockFetch(
      async () => jsonResponse({ data: ULTIMA_PROBE.data, paging: ULTIMA_PROBE.paging }),
      async () => {
        const db = fakeDb({
          credential: {
            credential_kind: "marketing_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              adAccountId: "9900000001",
              accessToken: "meta-access-token",
              apiVersion: "v25.0"
            })
          }
        });
        const connector = connectorFor("meta_ads");
        const rows = await connector.extract(db, request("meta_ads"), {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        });
        payload = rows[0]?.payload as Record<string, unknown>;
      }
    );
    return payload;
  }

  it("§9: collapses the Ultima 4 lead action_types to exactly 2 leads (never sums actions[])", async () => {
    const payload = await extractUltimaRow();
    const conversions = payload.conversions as Array<Record<string, unknown>>;

    // Exactly ONE conversion row for this lead-gen campaign-day, of type 'lead'.
    expect(conversions).toHaveLength(1);
    const lead = conversions[0];
    expect(lead.resultType).toBe("lead");

    // THE ACCEPTANCE GATE: 2 leads, NOT 8. The 4 action_types (lead,
    // offsite_conversion.fb_pixel_lead, onsite_web_lead, offsite_lead_add_20_s_calls)
    // each report 2 (headline 7d_click+1d_view = 1+1); summing all four gives 8.
    // The deterministic mapping picks ONE canonical action_type and stops → 2.
    expect(lead.results).toBe(2);
    expect(lead.results).not.toBe(8);

    // §2.3 guard: lead-gen carries NO revenue — conversion_value must stay null.
    expect(lead.conversionValue).toBeNull();

    // Provenance: derived from OUR mapping (not Meta's results field) since the
    // canonical action fired.
    expect(lead.resultsSource).toBe("derived_from_canonical_mapping");
    expect(lead.isPrimary).toBe(true);
    expect(lead.attributionSetting).toBe("1d_click,7d_click,1d_view");
  });

  it("§9: regression — naively summing every lead action_type would yield 8, proving dedup is load-bearing", async () => {
    // This asserts the SHAPE of the trap so a future revert to summing actions[] is
    // caught: the raw fixture genuinely reports 4 lead action_types that each sum to
    // 2 (total 8). If someone changes the parser to sum variants, the §9 test above
    // flips from 2 to 8 and fails — this test documents WHY that is wrong.
    const leadActionTypes = [
      "lead",
      "offsite_conversion.fb_pixel_lead",
      "onsite_web_lead",
      "offsite_lead_add_20_s_calls"
    ];
    const actions = ULTIMA_PROBE.data[0].actions as Array<Record<string, unknown>>;
    const summedAcrossVariants = actions
      .filter((a) => leadActionTypes.includes(String(a.action_type)))
      .reduce((total, a) => total + Number(a["7d_click"]) + Number(a["1d_view"]), 0);
    // The trap: 4 variants x (1 + 1) = 8 — the WRONG number the connector must avoid.
    expect(summedAcrossVariants).toBe(8);

    // And the connector's actual output is 2, never this summed figure.
    const payload = await extractUltimaRow();
    const conversions = payload.conversions as Array<Record<string, unknown>>;
    expect(conversions[0].results).not.toBe(summedAcrossVariants);
    expect(conversions[0].results).toBe(2);
  });

  it("§9: extracts non-omni landing_page_views (excludes omni_landing_page_view) and the §2.2 delivery columns", async () => {
    const payload = await extractUltimaRow();

    // landing_page_view headline window 7d_click(188)+1d_view(12)=200; the
    // omni_landing_page_view variant (240+30=270) is NOT counted.
    expect(payload.landingPageViews).toBe(200);
    expect(payload.inlineLinkClicks).toBe(274);
    expect(payload.currency).toBe("usd");
    expect(payload.apiVersion).toBe("v25.0");
    expect(payload.attributionSetting).toBe("1d_click,7d_click,1d_view");
    // actions_raw preserves the full arrays for audit/recompute.
    const actionsRaw = payload.actionsRaw as { actions?: unknown[]; action_values?: unknown[] };
    expect(Array.isArray(actionsRaw.actions)).toBe(true);
    expect((actionsRaw.actions ?? []).length).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phase-2 slice-1a §9 GOLDEN ADSET FIXTURE — two ad sets under one campaign. The
  // re-key on adset_id must keep the two adset rows DISTINCT (campaign-keyed they
  // collapse to one corrupted row); status (effective/configured) must be POPULATED
  // from the /adsets + /campaigns edge reads; typed conversions must be correct at
  // adset grain; and adset-summed results (2+2=4) must NOT equal the campaign total.
  const ADSET_PROBE = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/meta-ultima-adset-grain-probe.json", import.meta.url)),
      "utf8"
    )
  ) as {
    insights: Array<Record<string, unknown>>;
    adsetsEdge: { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };
    campaignsEdge: { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };
    archivedAdsetInsights: Array<Record<string, unknown>>;
    adsetsEdgeWithArchived: { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };
  };

  // Route the direct-Graph calls: /adsets + /campaigns edges return the fixture status
  // rows; the adset insights pass returns the two adset rows; the campaign insights pass
  // returns empty (this fixture exercises the adset grain).
  function adsetProbeRouter(url: string): Response {
    if (url.includes("/adsets")) {
      return jsonResponse(ADSET_PROBE.adsetsEdge);
    }
    if (url.includes("/campaigns")) {
      return jsonResponse(ADSET_PROBE.campaignsEdge);
    }
    if (isMetaAdsetInsightsRequest(url)) {
      return jsonResponse({ data: ADSET_PROBE.insights, paging: {} });
    }
    return jsonResponse({ data: [], paging: {} });
  }

  async function extractAdsetRows(): Promise<Array<Record<string, unknown>>> {
    let rows: Array<Record<string, unknown>> = [];
    await withMockFetch(
      async (url) => adsetProbeRouter(url),
      async () => {
        const db = fakeDb({
          credential: {
            credential_kind: "marketing_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              adAccountId: "9900000001",
              accessToken: "meta-access-token",
              apiVersion: "v25.0"
            })
          }
        });
        const extracted = await connectorFor("meta_ads").extract(db, request("meta_ads"), {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        });
        rows = extracted as unknown as Array<Record<string, unknown>>;
      }
    );
    return rows;
  }

  it("§9 adset: RE-KEYS externalId on adset_id so two adsets under one campaign never collapse", async () => {
    const rows = await extractAdsetRows();
    const adsetRows = rows.filter((row) => row.objectType === "meta_ads_adset_daily");
    // Two DISTINCT adset rows (not one collapsed/corrupted row).
    expect(adsetRows).toHaveLength(2);
    const externalIds = adsetRows.map((row) => row.externalId);
    expect(new Set(externalIds).size).toBe(2);
    // The re-key is on adset_id (not campaign_id) — the #1 corruption fix.
    expect(externalIds).toContain("meta_ads:adset:act_9900000001:220000000000201:2026-06-01");
    expect(externalIds).toContain("meta_ads:adset:act_9900000001:220000000000202:2026-06-01");
  });

  it("§9 adset: populates effective/configured status from the /adsets edge (ACTIVE + PAUSED)", async () => {
    const rows = await extractAdsetRows();
    const byAdset = new Map(
      rows
        .filter((row) => row.objectType === "meta_ads_adset_daily")
        .map((row) => [(row.payload as Record<string, unknown>).adsetId as string, row.payload as Record<string, unknown>])
    );
    const active = byAdset.get("220000000000201");
    const paused = byAdset.get("220000000000202");
    // Status is NOT on insights — it is folded in from the /adsets edge read (§4a). Both are
    // populated (no longer NULL): one live ad set, one paused.
    expect(active?.effectiveStatus).toBe("ACTIVE");
    expect(active?.configuredStatus).toBe("ACTIVE");
    expect(paused?.effectiveStatus).toBe("PAUSED");
    expect(paused?.configuredStatus).toBe("PAUSED");
    // optimization_goal + billing_event also fold in from the edge (per-adset, exact at grain).
    expect(active?.optimizationGoal).toBe("LEAD_GENERATION");
    expect(active?.billingEvent).toBe("IMPRESSIONS");
    // campaign_id is carried (never the key).
    expect(active?.campaignId).toBe("120000000000111");
  });

  it("§9 adset: typed conversions are correct at adset grain (each adset collapses to 2 leads)", async () => {
    const rows = await extractAdsetRows();
    const adsetRows = rows.filter((row) => row.objectType === "meta_ads_adset_daily");
    for (const row of adsetRows) {
      const payload = row.payload as Record<string, unknown>;
      const conversions = payload.conversions as Array<Record<string, unknown>>;
      // Each adset reports the SAME 3 lead action_types; the §4b mapping collapses to ONE
      // 'lead' row of 2 (headline 7d_click+1d_view = 1+1), never the summed 6.
      expect(conversions).toHaveLength(1);
      expect(conversions[0].resultType).toBe("lead");
      expect(conversions[0].results).toBe(2);
      expect(conversions[0].conversionValue).toBeNull();
      expect(conversions[0].resultsSource).toBe("derived_from_canonical_mapping");
    }
  });

  it("§9 adset: spend is additive across adsets but conversions are NOT (the divergence rule)", async () => {
    const rows = await extractAdsetRows();
    const adsetRows = rows
      .filter((row) => row.objectType === "meta_ads_adset_daily")
      .map((row) => row.payload as Record<string, unknown>);
    // Spend IS additive: 260.00 + 152.83 = 412.83 (the campaign-grain spend in the §9 probe).
    const summedSpend = adsetRows.reduce((total, row) => total + Number(row.spend), 0);
    expect(Number(summedSpend.toFixed(2))).toBe(412.83);
    // Conversions are NOT additive to the campaign total: adset-summed leads = 2 + 2 = 4, but
    // the campaign reports 3 (Meta dedups across ad sets). The connector stores each grain as
    // reported and NEVER derives the campaign total from the adset sum.
    const summedLeads = adsetRows.reduce((total, row) => {
      const conversions = row.conversions as Array<Record<string, unknown>>;
      return total + Number(conversions[0].results);
    }, 0);
    expect(summedLeads).toBe(4);
    expect(summedLeads).not.toBe(3);
  });

  it("§7a adset: the /adsets + /campaigns edge reads pass an effective_status filter that includes ARCHIVED", async () => {
    const edgeUrls: string[] = [];
    await withMockFetch(
      async (url) => {
        if (url.includes("/adsets") || url.includes("/campaigns")) {
          edgeUrls.push(url);
        }
        return adsetProbeRouter(url);
      },
      async () => {
        const db = fakeDb({
          credential: {
            credential_kind: "marketing_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              adAccountId: "9900000001",
              accessToken: "meta-access-token",
              apiVersion: "v25.0"
            })
          }
        });
        await connectorFor("meta_ads").extract(db, request("meta_ads"), {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        });
      }
    );
    // Both status edge reads must constrain effective_status (default-excludes archived).
    const adsetsUrl = edgeUrls.find((url) => url.includes("/adsets"));
    const campaignsUrl = edgeUrls.find((url) => url.includes("/campaigns"));
    expect(adsetsUrl).toBeDefined();
    expect(campaignsUrl).toBeDefined();
    for (const url of [adsetsUrl, campaignsUrl]) {
      const filter = new URL(url as string).searchParams.get("effective_status");
      expect(filter).not.toBeNull();
      const parsed = JSON.parse(filter as string) as string[];
      // The filter must surface PAUSED *and* ARCHIVED so on/off history stays queryable.
      expect(parsed).toContain("ACTIVE");
      expect(parsed).toContain("PAUSED");
      expect(parsed).toContain("ARCHIVED");
    }
  });

  it("§7a adset: a recently-archived adset with residual insights keeps effective_status=ARCHIVED (not NULL)", async () => {
    // The /adsets edge returns ACTIVE+PAUSED+ARCHIVED ONLY because the connector passes the
    // status filter; the archived adset (203) still has an insights row in the rolling window.
    let rows: Array<Record<string, unknown>> = [];
    await withMockFetch(
      async (url) => {
        if (url.includes("/adsets")) return jsonResponse(ADSET_PROBE.adsetsEdgeWithArchived);
        if (url.includes("/campaigns")) return jsonResponse(ADSET_PROBE.campaignsEdge);
        if (isMetaAdsetInsightsRequest(url)) {
          return jsonResponse({
            data: [...ADSET_PROBE.insights, ...ADSET_PROBE.archivedAdsetInsights],
            paging: {}
          });
        }
        return jsonResponse({ data: [], paging: {} });
      },
      async () => {
        const db = fakeDb({
          credential: {
            credential_kind: "marketing_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              adAccountId: "9900000001",
              accessToken: "meta-access-token",
              apiVersion: "v25.0"
            })
          }
        });
        const extracted = await connectorFor("meta_ads").extract(db, request("meta_ads"), {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        });
        rows = extracted as unknown as Array<Record<string, unknown>>;
      }
    );
    const archived = rows
      .filter((row) => row.objectType === "meta_ads_adset_daily")
      .map((row) => row.payload as Record<string, unknown>)
      .find((payload) => payload.adsetId === "220000000000203");
    expect(archived).toBeDefined();
    // The regression lock: its status is ARCHIVED (labelable), never NULL/status-unknown.
    expect(archived?.effectiveStatus).toBe("ARCHIVED");
    expect(archived?.configuredStatus).toBe("ARCHIVED");
  });

  it("§9 adset: the dispatching writer upserts the adset dim + facts on adset_id-keyed unique keys", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(
      async (url) => adsetProbeRouter(url),
      async () => {
        await connectorFor("meta_ads").sync(
          fakeDb({
            queryLog: queries,
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          request("meta_ads")
        );
      }
    );
    const sqls = queries.map((entry) => entry.sql);
    const adsetDimIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_adsets"));
    const adsetDailyIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_adset_daily"));
    const adsetConvIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_adset_conversions_daily"));
    // §7a dim-before-fact: the adset dim is upserted before the adset facts.
    expect(adsetDimIndex).toBeGreaterThanOrEqual(0);
    expect(adsetDailyIndex).toBeGreaterThan(adsetDimIndex);
    expect(adsetConvIndex).toBeGreaterThan(adsetDimIndex);
    // The conflict targets are RE-KEYED on adset_id (the #1 corruption fix).
    expect(sqls.some((sql) => sql.includes("on conflict (source_id, ad_account_id, adset_id)"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("on conflict (source_id, ad_account_id, adset_id, occurred_on)"))).toBe(true);
    expect(
      sqls.some((sql) => sql.includes("on conflict (source_id, ad_account_id, adset_id, occurred_on, result_type)"))
    ).toBe(true);
    // The adset dim upsert carries the on/off status read off the /adsets edge.
    const adsetDim = queries.find((entry) => entry.sql.includes("insert into meta_ads_adsets"));
    expect(adsetDim?.params).toContain("LEAD_GENERATION");
    expect((adsetDim?.params ?? []).some((p) => p === "ACTIVE" || p === "PAUSED")).toBe(true);
  });

  it("§9 adset: backfills campaign on/off status from the /campaigns edge (no longer NULL)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(
      async (url) => {
        // This run includes a campaign insights row so the campaign dim is written + the
        // /campaigns edge status backfills onto it.
        if (url.includes("/adsets")) return jsonResponse(ADSET_PROBE.adsetsEdge);
        if (url.includes("/campaigns")) return jsonResponse(ADSET_PROBE.campaignsEdge);
        if (isMetaAdsetInsightsRequest(url)) return jsonResponse({ data: ADSET_PROBE.insights, paging: {} });
        // campaign insights pass — one campaign-grain row.
        return jsonResponse({
          data: [
            {
              campaign_id: "120000000000111",
              campaign_name: "Ultima — Lead Gen Q2",
              date_start: "2026-06-01",
              objective: "OUTCOME_LEADS",
              spend: "412.83",
              account_currency: "USD"
            }
          ],
          paging: {}
        });
      },
      async () => {
        await connectorFor("meta_ads").sync(
          fakeDb({
            queryLog: queries,
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          request("meta_ads")
        );
      }
    );
    // The campaign dim upsert now sets effective_status/configured_status (the Phase-1 NULL
    // gap) WITHOUT disturbing name/objective/currency.
    const campaignDim = queries.find((entry) => entry.sql.includes("insert into meta_ads_campaigns"));
    expect(campaignDim?.sql).toContain("effective_status = coalesce(excluded.effective_status");
    expect(campaignDim?.params).toContain("ACTIVE");
    expect(campaignDim?.params).toContain("OUTCOME_LEADS");
  });

  it("§4e adset: backs off then FAILS LOUD when the insights throttle header stays high after retries", async () => {
    // The §4e backoff reads x-fb-ads-insights-throttle (which fetchJson discards) off the
    // /insights response and, on a sustained high acc_id_util_pct, retries with backoff and
    // THEN throws a retryable rate-limit error rather than returning a silently-truncated
    // window (it never returns a partial window that looks complete). The edge reads (no
    // throttle header) succeed; every /insights GET returns acc_id_util_pct=99 → after the
    // retry budget the extract must reject. (Under vitest the backoff sleeps are collapsed.)
    await expect(
      (async () => {
        await withMockFetch(
          async (url) => {
            if (url.includes("/adsets")) return jsonResponse({ data: [], paging: {} });
            if (url.includes("/campaigns")) return jsonResponse({ data: [], paging: {} });
            // /insights — echo a high-utilization throttle header.
            return new Response(JSON.stringify({ data: [], paging: {} }), {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 1.2, acc_id_util_pct: 99 })
              }
            });
          },
          async () => {
            await connectorFor("meta_ads").extract(
              fakeDb({
                credential: {
                  credential_kind: "marketing_api_access_token",
                  encrypted_payload: encryptedCredential({
                    mode: "live",
                    adAccountId: "1234567890",
                    accessToken: "meta-access-token",
                    apiVersion: "v25.0"
                  })
                }
              }),
              request("meta_ads"),
              {
                cursorKey: "meta_ads_campaign_daily",
                cursorStart: "2026-06-01T00:00:00.000Z",
                cursorEnd: "2026-06-03T00:00:00.000Z",
                refreshWindowDays: 30,
                mode: "live",
              }
            );
          }
        );
      })()
    ).rejects.toThrow(/throttle high/);
  });

  it("§4d adset: a NORMAL throttle utilization does not fail the run", async () => {
    // Below the ceiling the run proceeds (no false-positive fail-loud). acc_id_util_pct=12.
    const router = (url: string): Response => {
      if (url.includes("/adsets") || url.includes("/campaigns")) {
        return jsonResponse({ data: [], paging: {} });
      }
      return new Response(JSON.stringify({ data: [], paging: {} }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-fb-ads-insights-throttle": JSON.stringify({ acc_id_util_pct: 12 })
        }
      });
    };
    await withMockFetch(
      async (url) => router(url),
      async () => {
        const rows = await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "1234567890",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          request("meta_ads"),
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2026-06-01T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
          }
        );
        // Empty data + a sub-ceiling throttle = a clean, empty extract.
        expect(rows).toEqual([]);
      }
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phase-2 slice-1b §9 GOLDEN AD FIXTURE — two ads (+ one orphan) under one ad set.
  // The re-key on ad_id must keep the ad rows DISTINCT; creative_id must parse from
  // creative{id}; status (effective/configured) must be POPULATED from the /ads edge;
  // typed conversions must be correct at ad grain (carried optimization_goal from the
  // adset map); ad-summed results (2+2=4) must NOT equal the adset total (3); the orphan
  // ad must carry a NULL adset_id + NULL creative_id without failing (§7a).
  // ────────────────────────────────────────────────────────────────────────────
  const AD_PROBE = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/meta-ultima-ad-grain-probe.json", import.meta.url)),
      "utf8"
    )
  ) as {
    insights: Array<Record<string, unknown>>;
    adsEdge: { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };
    adsetsEdge: { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };
    campaignsEdge: { data: Array<Record<string, unknown>>; paging: Record<string, unknown> };
  };

  // Route the direct-Graph calls: /ads + /adsets + /campaigns edges return the fixture
  // rows; the ad insights pass returns the three ad rows; the campaign + adset insights
  // passes return empty (this fixture exercises the ad grain). Pin level=ad via the
  // SyncRequest override so ONLY the ad pass runs (single time_range, not the backfill loop).
  function adProbeRouter(url: string): Response {
    if (isMetaAdsEdgeRequest(url)) {
      return jsonResponse(AD_PROBE.adsEdge);
    }
    if (url.includes("/adsets")) {
      return jsonResponse(AD_PROBE.adsetsEdge);
    }
    if (url.includes("/campaigns")) {
      return jsonResponse(AD_PROBE.campaignsEdge);
    }
    if (isMetaAdInsightsRequest(url)) {
      return jsonResponse({ data: AD_PROBE.insights, paging: {} });
    }
    return jsonResponse({ data: [], paging: {} });
  }

  async function extractAdRows(): Promise<Array<Record<string, unknown>>> {
    let rows: Array<Record<string, unknown>> = [];
    await withMockFetch(
      async (url) => adProbeRouter(url),
      async () => {
        const db = fakeDb({
          credential: {
            credential_kind: "marketing_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              adAccountId: "9900000001",
              accessToken: "meta-access-token",
              apiVersion: "v25.0"
            })
          }
        });
        const extracted = await connectorFor("meta_ads").extract(
          db,
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad" },
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2026-06-01T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
          }
        );
        rows = extracted as unknown as Array<Record<string, unknown>>;
      }
    );
    return rows;
  }

  it("§4c ad: the level=ad insights pass requests ad_id,ad_name,adset_id,campaign_id", async () => {
    const requests: string[] = [];
    await withMockFetch(
      async (url) => {
        requests.push(url);
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad" },
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2026-06-01T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
          }
        );
      }
    );
    const adInsightsUrl = new URL(requests.find((url) => isMetaAdInsightsRequest(url)) ?? "");
    expect(adInsightsUrl.searchParams.get("level")).toBe("ad");
    // The ad field list PREPENDS the ad identity + the carried parent ids.
    // The ad field list PREPENDS ad_id,ad_name,adset_id; campaign_id,campaign_name already lead
    // the base field list (the carried parent keys are echoed at every grain — not duplicated).
    expect(adInsightsUrl.searchParams.get("fields")).toBe(
      "ad_id,ad_name,adset_id,campaign_id,campaign_name,date_start,spend,clicks,inline_link_clicks,impressions,reach,frequency,cpm,cpc,ctr,actions,action_values,results,cost_per_result,result_values_performance_indicator,objective,optimization_goal,account_currency"
    );
    // The /ads edge requests creative{id} (the field-expansion, NO body) + the parent ids.
    const adsEdgeRequest = requests.find((url) => isMetaAdsEdgeRequest(url));
    expect(adsEdgeRequest).toBeDefined();
    const adsEdgeUrl = new URL(adsEdgeRequest ?? "");
    expect(adsEdgeUrl.searchParams.get("fields")).toContain("creative{id}");
    expect(adsEdgeUrl.searchParams.get("fields")).toContain("adset_id");
    expect(adsEdgeUrl.searchParams.get("fields")).toContain("campaign_id");
  });

  it("§9 ad: RE-KEYS externalId on ad_id so two ads under one adset never collapse", async () => {
    const rows = await extractAdRows();
    const adRows = rows.filter((row) => row.objectType === "meta_ads_ad_daily");
    // Three DISTINCT ad rows (two real + one orphan), never one collapsed/corrupted row.
    expect(adRows).toHaveLength(3);
    const externalIds = adRows.map((row) => row.externalId);
    expect(new Set(externalIds).size).toBe(3);
    // The re-key is on ad_id (not adset_id/campaign_id) — the #1 corruption fix.
    expect(externalIds).toContain("meta_ads:ad:act_9900000001:330000000000301:2026-06-01");
    expect(externalIds).toContain("meta_ads:ad:act_9900000001:330000000000302:2026-06-01");
  });

  it("§9 ad: parses creative_id from creative{id} + populates status from the /ads edge", async () => {
    const rows = await extractAdRows();
    const byAd = new Map(
      rows
        .filter((row) => row.objectType === "meta_ads_ad_daily")
        .map((row) => [(row.payload as Record<string, unknown>).adId as string, row.payload as Record<string, unknown>])
    );
    const active = byAd.get("330000000000301");
    const paused = byAd.get("330000000000302");
    // creative_id parsed from the nested creative{id} field-expansion (NO body fetched).
    expect(active?.creativeId).toBe("cr_900001");
    expect(paused?.creativeId).toBe("cr_900002");
    // Status is NOT on insights — folded in from the /ads edge (§4a). One live, one paused.
    expect(active?.effectiveStatus).toBe("ACTIVE");
    expect(active?.configuredStatus).toBe("ACTIVE");
    expect(paused?.effectiveStatus).toBe("PAUSED");
    expect(paused?.configuredStatus).toBe("PAUSED");
    // Parent ids carried (never the key).
    expect(active?.adsetId).toBe("220000000000201");
    expect(active?.campaignId).toBe("120000000000111");
  });

  it("§7a ad: an orphan ad (no adset) carries NULL adset_id + NULL creative_id without failing", async () => {
    const rows = await extractAdRows();
    const orphan = rows
      .filter((row) => row.objectType === "meta_ads_ad_daily")
      .map((row) => row.payload as Record<string, unknown>)
      .find((payload) => payload.adId === "330000000000303");
    expect(orphan).toBeDefined();
    // §7a — the ad exists with no resolvable ad set + no creative; both are carried NULL.
    expect(orphan?.adsetId).toBeNull();
    expect(orphan?.creativeId).toBeNull();
    // It still carries its campaign + its own status (ACTIVE).
    expect(orphan?.campaignId).toBe("120000000000111");
    expect(orphan?.effectiveStatus).toBe("ACTIVE");
  });

  it("§4e ad: typed conversions are correct at ad grain (carried optimization_goal → 2 leads each)", async () => {
    const rows = await extractAdRows();
    const withAdset = rows
      .filter((row) => row.objectType === "meta_ads_ad_daily")
      .map((row) => row.payload as Record<string, unknown>)
      .filter((payload) => payload.adId !== "330000000000303");
    for (const payload of withAdset) {
      const conversions = payload.conversions as Array<Record<string, unknown>>;
      // §4e — optimization_goal is carried from the ADSET dim (LEAD_GENERATION), so the §4b
      // mapping collapses the 3 lead action_types to ONE 'lead' row of 2 (7d_click+1d_view),
      // never the summed 6, and never via roll-up from a coarser grain.
      expect(conversions).toHaveLength(1);
      expect(conversions[0].resultType).toBe("lead");
      expect(conversions[0].results).toBe(2);
      expect(conversions[0].conversionValue).toBeNull();
      expect(conversions[0].resultsSource).toBe("derived_from_canonical_mapping");
    }
  });

  it("§9 ad: spend is additive but conversions are NOT summed to the adset (stored-not-derived)", async () => {
    const rows = await extractAdRows();
    const adRows = rows
      .filter((row) => row.objectType === "meta_ads_ad_daily")
      .map((row) => row.payload as Record<string, unknown>);
    // Spend IS additive: 160 + 100 + 12 = 272.00.
    const summedSpend = adRows.reduce((total, row) => total + Number(row.spend), 0);
    expect(Number(summedSpend.toFixed(2))).toBe(272.0);
    // Conversions are NOT additive to the adset total: ad-summed leads = 2 + 2 = 4, but the
    // adset reports 3 (Meta dedups across ads within the ad set). The connector stores each
    // grain as reported and NEVER derives the adset total from the ad sum.
    const summedLeads = adRows.reduce((total, row) => {
      const conversions = (row.conversions as Array<Record<string, unknown>>) ?? [];
      return total + (conversions[0] ? Number(conversions[0].results) : 0);
    }, 0);
    expect(summedLeads).toBe(4);
    expect(summedLeads).not.toBe(3);
  });

  it("§9 ad: the dispatching writer upserts the ad dim + facts on ad_id-keyed unique keys (dim-before-fact)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(
      async (url) => adProbeRouter(url),
      async () => {
        await connectorFor("meta_ads").sync(
          fakeDb({
            queryLog: queries,
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad" }
        );
      }
    );
    const sqls = queries.map((entry) => entry.sql);
    const adDimIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_ads"));
    const adDailyIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_ad_daily"));
    const adConvIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_ad_conversions_daily"));
    // §7a dim-before-fact: the ad dim is upserted before the ad facts.
    expect(adDimIndex).toBeGreaterThanOrEqual(0);
    expect(adDailyIndex).toBeGreaterThan(adDimIndex);
    expect(adConvIndex).toBeGreaterThan(adDimIndex);
    // The conflict targets are RE-KEYED on ad_id (the #1 corruption fix).
    expect(sqls.some((sql) => sql.includes("on conflict (source_id, ad_account_id, ad_id)"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("on conflict (source_id, ad_account_id, ad_id, occurred_on)"))).toBe(true);
    expect(
      sqls.some((sql) => sql.includes("on conflict (source_id, ad_account_id, ad_id, occurred_on, result_type)"))
    ).toBe(true);
    // The ad dim upsert carries creative_id (coalesced, freeze-on-disappearance) + status.
    const adDim = queries.find((entry) => entry.sql.includes("insert into meta_ads_ads"));
    expect(adDim?.sql).toContain("creative_id = coalesce(excluded.creative_id");
    expect((adDim?.params ?? []).some((p) => p === "cr_900001" || p === "cr_900002")).toBe(true);
  });

  it("§4d ad: a backfill (all_time) is issued MONTH-BY-MONTH, never date_preset=maximum", async () => {
    const insightsUrls: string[] = [];
    await withMockFetch(
      async (url) => {
        if (isMetaAdInsightsRequest(url)) {
          insightsUrls.push(url);
          return jsonResponse({ data: [], paging: {} });
        }
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad", backfillWindow: "all_time" },
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2026-03-01T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
            backfillWindow: "all_time"
          }
        );
      }
    );
    // The ad backfill must NEVER use date_preset=maximum (it 1487534s at ad grain).
    for (const url of insightsUrls) {
      expect(new URL(url).searchParams.get("date_preset")).toBeNull();
      expect(new URL(url).searchParams.get("time_range")).not.toBeNull();
    }
    // Mar 1 → Jun 3 spans 4 calendar-month windows (Mar, Apr, May, Jun) — one request each.
    expect(insightsUrls.length).toBe(4);
    const ranges = insightsUrls.map((url) => JSON.parse(new URL(url).searchParams.get("time_range") as string));
    expect(ranges[0]).toEqual({ since: "2026-03-01", until: "2026-03-31" });
    expect(ranges[3]).toEqual({ since: "2026-06-01", until: "2026-06-03" });
  });

  it("§4d ad: a BOUNDED backfill (12_months) is also issued MONTH-BY-MONTH, never one wide time_range", async () => {
    // REGRESSION GUARD: the CLI's 3/6/12-month backfills queue backfillWindow:'12_months'
    // (NOT 'all_time') with refreshWindowDays:365. The ad pass must chunk these EXACTLY like
    // all_time — a single un-chunked 365-day level=ad daily request is the wide-range shape
    // that trips Meta 100/subcode 1487534. The chunk decision is driven by plan.backfillWindow,
    // not the date_preset=maximum sentinel.
    const insightsUrls: string[] = [];
    await withMockFetch(
      async (url) => {
        if (isMetaAdInsightsRequest(url)) {
          insightsUrls.push(url);
          return jsonResponse({ data: [], paging: {} });
        }
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad", backfillWindow: "12_months" },
          {
            // A 12-month backfill: cursorStart pinned ~12 months before cursorEnd. The plan
            // carries backfillWindow:'12_months' (a bounded window — NOT all_time).
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2025-06-03T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 365,
            mode: "live",
            backfillWindow: "12_months"
          }
        );
      }
    );
    expect(insightsUrls.length).toBeGreaterThan(1);
    // No request may use date_preset, and NO single time_range may exceed 31 days (a month).
    for (const url of insightsUrls) {
      expect(new URL(url).searchParams.get("date_preset")).toBeNull();
      const range = JSON.parse(new URL(url).searchParams.get("time_range") as string) as {
        since: string;
        until: string;
      };
      const span =
        (new Date(`${range.until}T00:00:00Z`).getTime() - new Date(`${range.since}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000);
      expect(span).toBeLessThanOrEqual(31);
    }
    // Jun 2025 → Jun 2026 is 13 calendar-month windows; the first starts at the pinned cursor.
    const ranges = insightsUrls.map((url) => JSON.parse(new URL(url).searchParams.get("time_range") as string));
    expect(ranges[0]).toEqual({ since: "2025-06-03", until: "2025-06-30" });
    expect(ranges[ranges.length - 1]).toEqual({ since: "2026-06-01", until: "2026-06-03" });
  });

  it("§4d ad: a BOUNDED backfill narrows to weeks on a forced 1487534 (no whole-run failure)", async () => {
    // The bounded path must carry the SAME 1487534 classify-and-retry-narrower as all_time:
    // force the first month window to the data-volume error, then succeed on the week retries.
    const insightsRanges: Array<{ since: string; until: string }> = [];
    let firstWindowFailed = false;
    await withMockFetch(
      async (url) => {
        if (isMetaAdInsightsRequest(url)) {
          const range = JSON.parse(new URL(url).searchParams.get("time_range") as string);
          if (!firstWindowFailed && range.since === "2025-06-03" && range.until === "2025-06-30") {
            firstWindowFailed = true;
            return new Response(
              JSON.stringify({
                error: { message: "Please reduce the amount of data", code: 100, error_subcode: 1487534 }
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          insightsRanges.push(range);
          return jsonResponse({ data: [], paging: {} });
        }
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad", backfillWindow: "12_months" },
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2025-06-03T00:00:00.000Z",
            cursorEnd: "2025-06-30T00:00:00.000Z",
            refreshWindowDays: 365,
            mode: "live",
            backfillWindow: "12_months"
          }
        );
      }
    );
    expect(firstWindowFailed).toBe(true);
    // The failed month was retried as ≤7-day sub-windows covering the whole month, no failure.
    expect(insightsRanges.length).toBeGreaterThan(1);
    for (const range of insightsRanges) {
      const span =
        (new Date(`${range.until}T00:00:00Z`).getTime() - new Date(`${range.since}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000);
      expect(span).toBeLessThanOrEqual(6);
    }
    expect(insightsRanges[0].since).toBe("2025-06-03");
    expect(insightsRanges[insightsRanges.length - 1].until).toBe("2025-06-30");
  });

  it("§9 ad: the ad read path issues NO Graph write verb (GET-only boundary)", async () => {
    // BOUNDARY: slice-1b adds only GET edge + insights reads. Capture every fetch method on the
    // ad path and assert none is a write verb — locking the read-only boundary into the gate so
    // a future POST/PUT/PATCH/DELETE regression on the ad path is caught.
    const methods: string[] = [];
    await withMockFetch(
      async (url, init) => {
        methods.push(((init?.method ?? "GET") as string).toUpperCase());
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad" },
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2026-06-01T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
          }
        );
      }
    );
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(["POST", "PUT", "PATCH", "DELETE"]).not.toContain(method);
      expect(method).toBe("GET");
    }
  });

  it("§4d ad: a window that returns subcode 1487534 retries NARROWER (week sub-windows)", async () => {
    // Force the FIRST month window to 1487534, then succeed on the week retries. The connector
    // must classify the subcode + re-issue that ONE window split into weeks (never fail the run).
    const insightsRanges: Array<{ since: string; until: string }> = [];
    let firstWindowFailed = false;
    await withMockFetch(
      async (url) => {
        if (isMetaAdInsightsRequest(url)) {
          const range = JSON.parse(new URL(url).searchParams.get("time_range") as string);
          // The first March MONTH window (a full calendar month) trips the data-volume error
          // once; the WEEK sub-windows (until < the month end) succeed.
          if (!firstWindowFailed && range.since === "2026-03-01" && range.until === "2026-03-31") {
            firstWindowFailed = true;
            return new Response(
              JSON.stringify({
                error: { message: "Please reduce the amount of data", code: 100, error_subcode: 1487534 }
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          insightsRanges.push(range);
          return jsonResponse({ data: [], paging: {} });
        }
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad", backfillWindow: "all_time" },
          {
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2026-03-01T00:00:00.000Z",
            cursorEnd: "2026-03-31T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
            backfillWindow: "all_time"
          }
        );
      }
    );
    // The failed March month was retried as WEEK windows (each ≤ 7 days), all succeeding.
    expect(firstWindowFailed).toBe(true);
    expect(insightsRanges.length).toBeGreaterThan(1);
    // Every retried sub-window is at most a week wide (the narrower retry granularity).
    for (const range of insightsRanges) {
      const span =
        (new Date(`${range.until}T00:00:00Z`).getTime() - new Date(`${range.since}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000);
      expect(span).toBeLessThanOrEqual(6);
    }
    // The sub-windows cover the whole month start→end (no silent truncation).
    expect(insightsRanges[0].since).toBe("2026-03-01");
    expect(insightsRanges[insightsRanges.length - 1].until).toBe("2026-03-31");
  });

  it("§4d ad: the backfill start is CLAMPED to the 37-month retention floor (older windows not requested)", async () => {
    const insightsRanges: Array<{ since: string; until: string }> = [];
    await withMockFetch(
      async (url) => {
        if (isMetaAdInsightsRequest(url)) {
          insightsRanges.push(JSON.parse(new URL(url).searchParams.get("time_range") as string));
          return jsonResponse({ data: [], paging: {} });
        }
        return adProbeRouter(url);
      },
      async () => {
        await connectorFor("meta_ads").extract(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "9900000001",
                accessToken: "meta-access-token",
                apiVersion: "v25.0"
              })
            }
          }),
          { ...request("meta_ads"), metaAdsInsightsLevel: "ad", backfillWindow: "all_time" },
          {
            // Ask for a start 5 years before the cursorEnd — well past the 37-month floor.
            cursorKey: "meta_ads_campaign_daily",
            cursorStart: "2021-06-03T00:00:00.000Z",
            cursorEnd: "2026-06-03T00:00:00.000Z",
            refreshWindowDays: 30,
            mode: "live",
            backfillWindow: "all_time"
          }
        );
      }
    );
    // The earliest requested window must not start before 37 months before Jun 3 2026
    // (≈ 2023-05-03). 2021 is silently empty at Meta, so we never ask for it.
    const earliest = insightsRanges.map((r) => r.since).sort()[0];
    expect(earliest >= "2023-05-01").toBe(true);
    expect(earliest < "2023-06-15").toBe(true);
  });

  it("supports Meta Ads extraction through a configured MCP stdio command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-os-meta-mcp-"));
    const script = join(dir, "server.mjs");
    writeFileSync(
      script,
      `
import process from "node:process";
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
}
function handle(message) {
  if (message.method === "initialize" && message.id) {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-meta-mcp", version: "1.0.0" } } });
    return;
  }
  if (message.method === "tools/list" && message.id) {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "get_campaign_insights" }] } });
    return;
  }
  if (message.method === "tools/call" && message.id) {
    const after = message.params?.arguments?.after;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        structuredContent: after === "page-2"
          ? {
              data: [
                {
                  campaign_id: "1200000002",
                  campaign_name: "Retargeting",
                  date_start: "2026-06-02",
                  spend: "67.89",
                  clicks: "34",
                  impressions: "2100",
                  reach: "1800",
                  cpm: "32.33",
                  cpc: "2.00",
                  ctr: "1.62"
                }
              ]
            }
          : {
              data: [
                {
                  campaign_id: "1200000001",
                  campaign_name: "Scale Growth",
                  date_start: "2026-06-01",
                  spend: "123.45",
                  clicks: "89",
                  impressions: "4567",
                  reach: "3200",
                  cpm: "27.03",
                  cpc: "1.39",
                  ctr: "1.95"
                }
              ],
              paging: {
                cursors: {
                  after: "page-2"
                }
              }
            }
      }
    });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      process.exit(1);
    }
    const bodyStart = headerEnd + 4;
    const length = Number(match[1]);
    if (buffer.length < bodyStart + length) break;
    const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.slice(bodyStart + length);
    handle(JSON.parse(body));
  }
});
      `.trim(),
      "utf8"
    );
    try {
      const db = fakeDb({
        credential: {
          credential_kind: "mcp_server_command",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "mcp_stdio",
            adAccountId: "1234567890",
            mcpCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
            mcpToolName: "get_campaign_insights"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await expect(connector.testConnection(db, request("meta_ads"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "meta_ads",
        accountExternalId: "act_1234567890"
      });
      const rows = await connector.extract(db, request("meta_ads"), {
        cursorKey: "meta_ads_campaign_daily",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        externalId: "meta_ads:act_1234567890:1200000001:2026-06-01",
        objectType: "meta_ads_campaign_daily",
        payload: {
          campaignId: "1200000001",
          spend: 123.45,
          clicks: 89
        }
      });
      expect(rows[1]).toMatchObject({
        externalId: "meta_ads:act_1234567890:1200000002:2026-06-02",
        objectType: "meta_ads_campaign_daily",
        payload: {
          campaignId: "1200000002",
          spend: 67.89,
          clicks: 34
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports Meta Ads extraction through the official Ads CLI command shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-os-meta-cli-"));
    const script = join(dir, "meta-cli.mjs");
    writeFileSync(
      script,
      `
import process from "node:process";
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
if (argValue("--output") !== "json") process.exit(2);
if (!args.includes("ads") || !args.includes("insights") || !args.includes("get")) process.exit(3);
if (argValue("--ad-account-id") !== "1234567890") process.exit(4);
if (process.env.AD_ACCOUNT_ID !== "1234567890") process.exit(5);
const fields = argValue("--fields") ?? "";
if (!fields.includes("campaign_id") || !fields.includes("spend")) process.exit(6);
if (argValue("--date-preset") === "today") {
  console.log(JSON.stringify({ data: [] }));
  process.exit(0);
}
if (argValue("--since") !== "2026-06-01" || argValue("--until") !== "2026-06-03") process.exit(7);
if (argValue("--time-increment") !== "daily") process.exit(8);
console.log(JSON.stringify({
  data: [
    {
      campaign_id: "1200000003",
      campaign_name: "CLI Growth",
      date_start: "2026-06-01",
      spend: "44.50",
      clicks: "22",
      impressions: "1200",
      reach: "1000",
      cpm: "37.08",
      cpc: "2.02",
      ctr: "1.83"
    }
  ]
}));
      `.trim(),
      "utf8"
    );
    try {
      const db = fakeDb({
        credential: {
          credential_kind: "ads_cli",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "meta_ads_cli",
            adAccountId: "1234567890",
            cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await expect(connector.testConnection(db, request("meta_ads"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "meta_ads",
        accountExternalId: "act_1234567890"
      });
      // An EXPLICIT bounded span is a windowed request under the two-regime date logic (the
      // 2026-07-11 steady-state fix): the request window pins the CLI's --since/--until verbatim.
      // (A steady-state run — no window — now re-pulls the rolling refresh window instead; see
      // the "re-pulls the rolling refresh window" regression below.)
      const rows = await connector.extract(
        db,
        { ...request("meta_ads"), windowSince: "2026-06-01T00:00:00.000Z", windowUntil: "2026-06-03T00:00:00.000Z" },
        {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        }
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        externalId: "meta_ads:act_1234567890:1200000003:2026-06-01",
        objectType: "meta_ads_campaign_daily",
        payload: {
          campaignId: "1200000003",
          campaignName: "CLI Growth",
          spend: 44.5,
          clicks: 22,
          impressions: 1200
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Worker-portability (2026-07-05 incident) ── a transport=meta_ads_cli credential that
  // stores its OWN accessToken must read via the PRIMARY direct-Graph transport, NOT the CLI.
  // The credential's cliCommand is an absolute path on the CONNECT-TIME host; a sync claimed by
  // a different worker (the dockerized growth-os worker has no /Users mount) used to throw a
  // non-retryable `provider_auth_failed` "meta ... was not found", flipping a HEALTHY
  // system-user source to status='error' ("reconnect or revoke"). The CLI would have been handed
  // this same token via ACCESS_TOKEN, so direct Graph is the same authorization, host-free.
  it("reads via direct Graph (not the CLI) when a meta_ads_cli credential stores its own token", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const router = metaGraphMockRouter({
      data: [
        {
          campaign_id: "1200000003",
          campaign_name: "Portable Growth",
          date_start: "2026-06-01",
          spend: "44.50",
          clicks: "22",
          impressions: "1200"
        }
      ],
      paging: {}
    });
    await withMockFetch(async (url, init) => {
      requests.push({ url, authorization: headerValue(init.headers, "Authorization") });
      return router(url);
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "ads_cli",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "meta_ads_cli",
            adAccountId: "1234567890",
            accessToken: "test-system-user-token",
            // The connect-time host's binary — DELIBERATELY nonexistent here. Success below
            // proves reads no longer depend on it (before the fix: non-retryable
            // provider_auth_failed "was not found" from ensureExecutableOnPath).
            cliCommand: "/nonexistent-connect-host/.local/bin/meta"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await expect(connector.testConnection(db, request("meta_ads"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "meta_ads",
        accountExternalId: "act_1234567890"
      });
      const rows = await connector.extract(db, request("meta_ads"), {
        cursorKey: "meta_ads_campaign_daily",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live",
      });
      // The probe is a direct-Graph insights GET with header (never query-string) auth.
      expect(requests[0]).toMatchObject({
        url: expect.stringContaining("https://graph.facebook.com/v25.0/act_1234567890/insights"),
        authorization: "Bearer test-system-user-token"
      });
      for (const seen of requests) {
        expect(seen.url).not.toContain("access_token=");
        expect(seen.url).not.toContain("test-system-user-token");
      }
      // The extract rode the primary path (campaign row present; edge/adset/ad passes served
      // empty by the router) — a CLI-path extract would have needed the nonexistent binary.
      const campaignRow = rows.find((row) => row.objectType === "meta_ads_campaign_daily");
      expect(campaignRow).toMatchObject({
        externalId: "meta_ads:act_1234567890:1200000003:2026-06-01",
        payload: {
          campaignId: "1200000003",
          campaignName: "Portable Growth",
          spend: 44.5,
          clicks: 22,
          impressions: 1200
        }
      });
    });
  });

  // ── fetchMetaLiveInsights (run_meta_live_insights transport) ── live whole-window
  // aggregate read; same canonical conversion semantics as the sync path, direct Graph only.
  it("fetchMetaLiveInsights aggregates the window (no time_increment), paginates, sorts by spend, truncates", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const page2 = "https://graph.facebook.com/v25.0/act_777/insights?after=cursor2";
    await withMockFetch(async (url, init) => {
      requests.push({ url, authorization: headerValue(init.headers, "Authorization") });
      if (url === page2) {
        return new Response(
          JSON.stringify({
            data: [{ ad_id: "a3", ad_name: "Third", campaign_id: "c1", spend: "5" }],
            paging: {}
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            { ad_id: "a1", ad_name: "Mid", campaign_id: "c1", spend: "50" },
            { ad_id: "a2", ad_name: "Big", campaign_id: "c1", spend: "900" }
          ],
          paging: { next: page2 }
        }),
        { status: 200 }
      );
    }, async () => {
      const credential: MetaAdsCredential = {
        mode: "live",
        transport: "marketing_api",
        adAccountId: "777",
        accessToken: "live-read-token"
      };
      const result = await fetchMetaLiveInsights(credential, {
        level: "ad",
        datePreset: "last_7d",
        limit: 2
      });
      // Aggregate request shape: ad-grain fields, preset window, attribution windows,
      // and NO time_increment (whole-window aggregate — never per-day rows).
      const first = new URL(requests[0].url);
      expect(first.pathname).toBe("/v25.0/act_777/insights");
      expect(first.searchParams.get("level")).toBe("ad");
      expect(first.searchParams.get("date_preset")).toBe("last_7d");
      expect(first.searchParams.get("time_increment")).toBeNull();
      expect(first.searchParams.get("fields")).toContain("ad_id,ad_name,adset_id");
      // Header (never query-string) auth; the token never rides a URL.
      expect(requests[0].authorization).toBe("Bearer live-read-token");
      for (const seen of requests) {
        expect(seen.url).not.toContain("live-read-token");
      }
      // Both pages consumed, spend-desc sort, honest truncation.
      expect(requests).toHaveLength(2);
      expect(result.rows.map((row) => row.adName)).toEqual(["Big", "Mid"]);
      expect(result).toMatchObject({ totalRows: 3, truncated: true });
    });
  });

  // REUSE pin (founder requirement 2026-07-11): the live read rides the SHIPPED transport
  // selection — ambient-auth CLI credentials read via the meta CLI exactly like the sync path;
  // stored-token credentials ride direct Graph (PR #74's rule). No transport logic of its own.
  it("fetchMetaLiveInsights rides the meta CLI for an ambient-auth credential (campaign level), zero HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-os-meta-live-cli-"));
    const script = join(dir, "meta-cli.mjs");
    writeFileSync(
      script,
      `
import process from "node:process";
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
if (process.env.ACCESS_TOKEN !== "ambient-live-token") process.exit(9);
if (process.env.AD_ACCOUNT_ID !== "1234567890") process.exit(8);
// The live read must request a whole-window aggregate: a --time-increment flag is a bug.
if (args.includes("--time-increment")) process.exit(7);
if (argValue("--date-preset") !== "last_7d") process.exit(6);
console.log(JSON.stringify({ data: [
  { campaign_id: "c9", campaign_name: "CLI Live", spend: "12.5", impressions: "800", clicks: "9" }
] }));
      `.trim(),
      "utf8"
    );
    const previousToken = process.env.ACCESS_TOKEN;
    process.env.ACCESS_TOKEN = "ambient-live-token";
    let fetched = 0;
    try {
      await withMockFetch(async () => {
        fetched += 1;
        return new Response("{}", { status: 200 });
      }, async () => {
        const credential: MetaAdsCredential = {
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
        };
        const result = await fetchMetaLiveInsights(credential, {
          level: "campaign",
          datePreset: "last_7d",
          limit: 10
        });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          campaignId: "c9",
          campaignName: "CLI Live",
          spend: 12.5
        });
        // The whole read authenticated through the CLI — graph.facebook.com was never dialed.
        expect(fetched).toBe(0);
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.ACCESS_TOKEN;
      } else {
        process.env.ACCESS_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchMetaLiveInsights fails typed for a finer-than-campaign level on an ambient-auth CLI credential", async () => {
    let fetched = 0;
    await withMockFetch(async () => {
      fetched += 1;
      return new Response("{}", { status: 200 });
    }, async () => {
      // The shipped CLI read carries no level flag (campaign grain only this slice) — a
      // level=ad request must fail typed, never silently answer at the wrong grain.
      const credential: MetaAdsCredential = {
        mode: "live",
        transport: "meta_ads_cli",
        adAccountId: "777",
        cliCommand: "/nonexistent/meta"
      };
      await expect(
        fetchMetaLiveInsights(credential, { level: "ad", datePreset: "last_7d", limit: 10 })
      ).rejects.toThrow("meta_live_level_unavailable");
      expect(fetched).toBe(0);
    });
  });

  it("fetchMetaLiveInsights rides direct Graph when a meta_ads_cli credential stores its own token (PR #74 rule)", async () => {
    const requests: string[] = [];
    await withMockFetch(async (url) => {
      requests.push(url);
      return new Response(JSON.stringify({ data: [], paging: {} }), { status: 200 });
    }, async () => {
      const credential: MetaAdsCredential = {
        mode: "live",
        transport: "meta_ads_cli",
        adAccountId: "777",
        accessToken: "stored-token",
        cliCommand: "/nonexistent-connect-host/.local/bin/meta"
      };
      const result = await fetchMetaLiveInsights(credential, {
        level: "ad",
        datePreset: "last_7d",
        limit: 10
      });
      // Direct Graph took the read (the nonexistent binary proves the CLI was not needed),
      // and level=ad works on this transport.
      expect(requests[0]).toContain("https://graph.facebook.com/v25.0/act_777/insights");
      expect(new URL(requests[0]).searchParams.get("level")).toBe("ad");
      expect(result.rows).toEqual([]);
    });
  });

  // ── Steady-state window regression (2026-07-11 zero-loop incident) ── the harness CLOSE step
  // ratchets the cursor forward on EVERY succeeded run (records or not), so cursor-driven windows
  // degenerate to the inter-sync gap after one legitimately-empty answer and never recover —
  // "synced" forever with 0 records. Meta must re-pull the rolling refresh window like GA4 (#83).
  it("meta steady-state extract re-pulls the rolling refresh window even with a ratcheted cursor", async () => {
    const requests: string[] = [];
    const router = metaGraphMockRouter({ data: [], paging: {} });
    await withMockFetch(async (url) => {
      requests.push(url);
      return router(url);
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "marketing_api",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "marketing_api",
            adAccountId: "1234567890",
            accessToken: "test-token"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      const nowIso = new Date().toISOString();
      // The incident state: the stored cursor has been ratcheted to "now" by empty runs.
      await connector.extract(db, request("meta_ads"), {
        cursorKey: "meta_ads_campaign_daily",
        cursorStart: nowIso,
        cursorEnd: nowIso,
        refreshWindowDays: 30,
        mode: "live",
      });
      const campaignInsights = requests.find(
        (u) => u.includes("/insights") && new URL(u).searchParams.get("level") === "campaign"
      );
      expect(campaignInsights).toBeDefined();
      const timeRange = JSON.parse(
        String(new URL(String(campaignInsights)).searchParams.get("time_range"))
      ) as { since: string; until: string };
      const expectedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      // The 30-day reconcile window — NOT the degenerate [today..today] the cursor implies.
      expect(timeRange).toEqual({ since: expectedSince, until: nowIso.slice(0, 10) });
    });
  });

  it("meta windowed backfill still honors the explicit [since, until] span verbatim", async () => {
    const requests: string[] = [];
    const router = metaGraphMockRouter({ data: [], paging: {} });
    await withMockFetch(async (url) => {
      requests.push(url);
      return router(url);
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "marketing_api",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "marketing_api",
            adAccountId: "1234567890",
            accessToken: "test-token"
          })
        }
      });
      const connector = connectorFor("meta_ads");
      // An orchestrator-style bounded window: the plan carries the request window verbatim
      // (defaultPlan sets cursorStart/cursorEnd from windowSince/windowUntil).
      await connector.extract(
        db,
        { ...request("meta_ads"), windowSince: "2026-05-01T00:00:00.000Z", windowUntil: "2026-05-31T00:00:00.000Z" },
        {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-05-01T00:00:00.000Z",
          cursorEnd: "2026-05-31T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live",
        }
      );
      const campaignInsights = requests.find(
        (u) => u.includes("/insights") && new URL(u).searchParams.get("level") === "campaign"
      );
      const timeRange = JSON.parse(
        String(new URL(String(campaignInsights)).searchParams.get("time_range"))
      ) as { since: string; until: string };
      expect(timeRange).toEqual({ since: "2026-05-01", until: "2026-05-31" });
    });
  });

  it("preserves an ambient ACCESS_TOKEN when the credential omits a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-os-meta-cli-ambient-"));
    const script = join(dir, "meta-cli.mjs");
    writeFileSync(
      script,
      `
import process from "node:process";
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
if (process.env.ACCESS_TOKEN !== "ambient-operator-token") process.exit(9);
if (argValue("--date-preset") === "today") {
  console.log(JSON.stringify({ data: [] }));
  process.exit(0);
}
console.log(JSON.stringify({ data: [] }));
      `.trim(),
      "utf8"
    );
    const previousToken = process.env.ACCESS_TOKEN;
    process.env.ACCESS_TOKEN = "ambient-operator-token";
    try {
      const db = fakeDb({
        credential: {
          credential_kind: "ads_cli",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "meta_ads_cli",
            adAccountId: "1234567890",
            cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
          })
        }
      });
      const connector = connectorFor("meta_ads");
      await expect(connector.testConnection(db, request("meta_ads"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "meta_ads"
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.ACCESS_TOKEN;
      } else {
        process.env.ACCESS_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AMBIENT-auth scope: with no stored accessToken the CLI is the only possible authenticator,
  // so a missing binary is genuinely fatal here. (A credential WITH a token routes reads to
  // direct Graph instead — see the worker-portability test above.)
  it("fails fast with an actionable, non-retryable error when the meta binary is missing", async () => {
    const db = fakeDb({
      credential: {
        credential_kind: "ads_cli",
        encrypted_payload: encryptedCredential({
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          cliCommand: "definitely-not-a-real-binary-xyz"
        })
      }
    });
    const connector = connectorFor("meta_ads");
    await expect(connector.testConnection(db, request("meta_ads"))).rejects.toMatchObject({
      code: "provider_auth_failed",
      retryable: false,
      message: expect.stringContaining("pip install meta-ads")
    });
  });

  it("uses X app-only bearer auth and maps timeline public metrics", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    await withMockFetch(async (url, init) => {
      requests.push({ url, authorization: headerValue(init.headers, "Authorization") });
      if (url.includes("/2/users/by/username/XDevelopers")) {
        return jsonResponse({ data: { id: "2244994945", username: "XDevelopers" } });
      }
      return jsonResponse({
        data: [
          {
            id: "1800000000000000001",
            text: "X public metrics post",
            author_id: "2244994945",
            conversation_id: "1800000000000000001",
            created_at: "2026-06-02T10:00:00.000Z",
            public_metrics: {
              retweet_count: 7,
              reply_count: 3,
              like_count: 88,
              quote_count: 2,
              bookmark_count: 5,
              impression_count: 9001
            }
          }
        ],
        meta: {}
      });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "bearer_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            bearerToken: "x-bearer-token",
            username: "XDevelopers",
            apiBaseUrl: "https://x.test"
          })
        }
      });
      const connector = connectorFor("x");
      await expect(connector.testConnection(db, request("x"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "x",
        accountExternalId: "2244994945"
      });
      const rows = await connector.extract(db, request("x"), {
        cursorKey: "x_user_timeline",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      });

      expect(requests.every((entry) => entry.authorization === "Bearer x-bearer-token")).toBe(true);
      expect(requests[1].url).toContain("/2/users/by/username/XDevelopers");
      expect(requests[2].url).toContain("/2/users/2244994945/tweets");
      expect(requests[2].url).toContain("tweet.fields=author_id%2Cconversation_id%2Ccreated_at%2Cpublic_metrics");
      expect(rows[0]).toMatchObject({
        externalId: "x:1800000000000000001",
        objectType: "x_post",
        payload: {
          postId: "1800000000000000001",
          authorId: "2244994945",
          postUrl: "https://x.com/XDevelopers/status/1800000000000000001",
          publicMetrics: {
            retweetCount: 7,
            replyCount: 3,
            likeCount: 88,
            quoteCount: 2,
            bookmarkCount: 5,
            impressionCount: 9001
          }
        }
      });
    });
  });

  it("honors explicit X sync refresh windows instead of reusing the incremental cursor", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    await withMockFetch(async (url, init) => {
      requests.push({ url, authorization: headerValue(init.headers, "Authorization") });
      if (url.includes("/2/users/by/username/YourHandle")) {
        return jsonResponse({ data: { id: "83950207", username: "YourHandle" } });
      }
      return jsonResponse({ data: [], meta: {} });
    }, async () => {
      const db = fakeDb({
        cursorValue: "2026-06-06T15:34:32.364Z",
        credential: {
          credential_kind: "bearer_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            bearerToken: "x-bearer-token",
            username: "YourHandle",
            apiBaseUrl: "https://x.test"
          })
        }
      });
      await connectorFor("x").extract(db, { ...request("x"), refreshWindowDays: 30 }, await connectorFor("x").planSync(db, {
        ...request("x"),
        refreshWindowDays: 30
      }));
    });

    const timelineRequest = requests.find((entry) => entry.url.includes("/2/users/83950207/tweets"));
    expect(timelineRequest?.url).toContain("start_time=");
    expect(timelineRequest?.url).not.toContain("2026-06-06T15%3A34%3A32.364Z");
  });

  it("writes X raw rows before provider truth and uses idempotent upserts", async () => {
    const queries: string[] = [];
    const result = await connectorFor("x").sync(
      fakeDb({
        queries,
        credential: {
          credential_kind: "fixture",
          encrypted_payload: "fixture-encrypted"
        }
      }),
      request("x")
    );

    const rawIndex = queries.findIndex((sql) => sql.includes("insert into raw_records"));
    const postIndex = queries.findIndex((sql) => sql.includes("insert into x_post"));
    const metricIndex = queries.findIndex((sql) => sql.includes("insert into x_post_metric_snapshot"));
    expect(result).toMatchObject({ provider: "x", recordsExtracted: 1, recordsLoaded: 1 });
    expect(rawIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBeGreaterThan(rawIndex);
    expect(metricIndex).toBeGreaterThan(postIndex);
    expect(queries.some((sql) => sql.includes("on conflict (source_id, x_post_id)"))).toBe(true);
    expect(queries.some((sql) => sql.includes("on conflict (source_id, x_post_id, captured_at)"))).toBe(true);
  });

  // metrics_classification used to be a one-way trapdoor: `coalesce(excluded, stored)` on EVERY
  // customer upsert meant deleting the infinite_metrics_classification tag in Stripe could never
  // clear it, so a customer tagged internal_test once was excluded from every business metric
  // forever. The fix distinguishes "metadata authoritatively observed" (expanded customer) from
  // "customer not expanded", NOT "incoming value is null".
  it("writes an observed Stripe classification directly so removing the tag clears it", async () => {
    const stripeLiveQueries = async (
      queries: string[],
      customer: unknown,
    ): Promise<void> => {
      await withMockFetch(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
        if (parsed.pathname === "/v1/subscriptions") return jsonResponse({ data: [], has_more: false });
        if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
        if (parsed.pathname === "/v1/invoices") {
          return jsonResponse({
            data: [stripeInvoice("in_classification", { customer })],
            has_more: false,
          });
        }
        throw new Error(`unexpected Stripe test URL: ${url}`);
      }, async () => {
        await connectorFor("stripe").sync(
          fakeDb({
            queries,
            credential: {
              credential_kind: "api_key",
              encrypted_payload: encryptedCredential({
                mode: "live",
                secretKey: "sk_test",
                apiBaseUrl: "https://stripe.test",
              }),
            },
          }),
          request("stripe"),
        );
      });
    };

    const directAssignment =
      /metrics_classification\s*=\s*excluded\.metrics_classification/;
    const preservingAssignment =
      /metrics_classification\s*=\s*coalesce\(\s*excluded\.metrics_classification,\s*stripe_customers\.metrics_classification\s*\)/;

    // Tag PRESENT on an expanded customer -> set it.
    const tagged: string[] = [];
    await stripeLiveQueries(tagged, {
      id: "cus_tagged",
      email: "internal@example.test",
      metadata: { infinite_metrics_classification: "internal_test" },
    });
    const taggedUpserts = tagged.filter((sql) => sql.includes("insert into stripe_customers"));
    expect(taggedUpserts.length).toBeGreaterThan(0);
    for (const sql of taggedUpserts) expect(sql).toMatch(directAssignment);

    // Tag REMOVED on a later expanded sync -> the same direct write CLEARS the stored value,
    // because an expanded customer's metadata is the whole truth including its absence.
    const untagged: string[] = [];
    await stripeLiveQueries(untagged, { id: "cus_untagged", email: "founder@example.com", metadata: {} });
    const untaggedUpserts = untagged.filter((sql) => sql.includes("insert into stripe_customers"));
    expect(untaggedUpserts.length).toBeGreaterThan(0);
    for (const sql of untaggedUpserts) {
      expect(sql).toMatch(directAssignment);
      expect(sql).not.toMatch(preservingAssignment);
    }
    const untaggedUpsert = untagged.indexOf(untaggedUpserts[0]!);
    expect(untaggedUpsert).toBeGreaterThan(-1);

    // Customer NOT expanded (bare id string) -> metadata was never observable, so preserve.
    const unexpanded: string[] = [];
    await stripeLiveQueries(unexpanded, "cus_unexpanded");
    const unexpandedUpserts = unexpanded.filter((sql) => sql.includes("insert into stripe_customers"));
    expect(unexpandedUpserts.length).toBeGreaterThan(0);
    for (const sql of unexpandedUpserts) expect(sql).toMatch(preservingAssignment);

    // Customer DELETED in Stripe -> the {id, deleted: true} stub carries no metadata, which is
    // absence-of-observation, not an observed absence. It must preserve, never clear, the stored
    // classification — otherwise deleting an internal_test customer re-admits their history.
    const deleted: string[] = [];
    await stripeLiveQueries(deleted, { id: "cus_deleted", deleted: true });
    const deletedUpserts = deleted.filter((sql) => sql.includes("insert into stripe_customers"));
    expect(deletedUpserts.length).toBeGreaterThan(0);
    for (const sql of deletedUpserts) expect(sql).toMatch(preservingAssignment);
  });

  it("binds a null classification on the authoritative expanded-customer upsert", async () => {
    // Output-level proof for the clearing case: the bound parameter really is null, so the
    // direct assignment above writes null rather than silently re-binding a stale value.
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
      if (parsed.pathname === "/v1/subscriptions") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/invoices") {
        return jsonResponse({
          data: [stripeInvoice("in_cleared", {
            customer: { id: "cus_cleared", email: "founder@example.com", metadata: {} },
          })],
          has_more: false,
        });
      }
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    const upsert = queryLog.find((entry) => entry.sql.includes("insert into stripe_customers"));
    expect(upsert?.params?.[4]).toBe("cus_cleared");
    expect(upsert?.params?.[7]).toBeNull();
  });

  it("replaces each complete Stripe subscription item and discount set inside its write transaction", async () => {
    const queries: string[] = [];
    await withMockFetch(async (url) => {
      if (url.includes("/v1/customers")) return jsonResponse({ data: [] });
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({
          data: [stripeSubscription("sub_replace", {
            discounts: [],
            items: {
              data: [{
                id: "si_replace",
                quantity: 1,
                discounts: [],
                price: {
                  id: "price_replace",
                  product: { id: "prod_replace" },
                  currency: "usd",
                  unit_amount: 6000,
                  billing_scheme: "per_unit",
                  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
                },
              }],
              has_more: false,
            },
          })],
          has_more: false,
        });
      }
      if (url.includes("/v1/invoices?")) return jsonResponse({ data: [], has_more: false });
      if (url.includes("/v1/events?")) return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queries,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    const itemReplacement = queries.find((sql) =>
      sql.includes("delete from stripe_subscription_items"),
    );
    const discountReplacement = queries.find((sql) =>
      sql.includes("delete from stripe_subscription_discounts"),
    );
    expect(itemReplacement).toContain("workspace_id = $1");
    expect(itemReplacement).toContain("source_id = $2");
    expect(itemReplacement).toContain("stripe_subscription_id = $3");
    expect(discountReplacement).toContain("workspace_id = $1");
    expect(discountReplacement).toContain("source_id = $2");
    expect(discountReplacement).toContain("stripe_subscription_id = $3");
  });

  it("preserves prior Stripe child truth when a later subscription-item page fails", async () => {
    const queries: string[] = [];
    let itemPages = 0;
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/customers") return jsonResponse({ data: [] });
      if (parsed.pathname === "/v1/subscriptions") {
        return jsonResponse({
          data: [stripeSubscription("sub_partial", {
            discounts: [],
            items: { data: [], has_more: true },
          })],
          has_more: false,
        });
      }
      if (parsed.pathname === "/v1/subscription_items") {
        itemPages += 1;
        if (itemPages === 1) {
          return jsonResponse({
            data: Array.from({ length: 10 }, (_, index) => ({
              id: `si_partial_${index}`,
              quantity: 1,
              discounts: [],
              price: {
                id: `price_partial_${index}`,
                currency: "usd",
                unit_amount: 1000,
                billing_scheme: "per_unit",
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              },
            })),
            has_more: true,
          });
        }
        throw new Error("forced later item-page failure");
      }
      if (parsed.pathname === "/v1/invoices") return jsonResponse({ data: [], has_more: false });
      if (parsed.pathname === "/v1/events") return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await expect(connectorFor("stripe").sync(
        fakeDb({
          queries,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      )).rejects.toThrow("forced later item-page failure");
    });

    expect(itemPages).toBe(2);
    expect(queries.some((sql) => sql.includes("delete from stripe_subscription_items"))).toBe(false);
    expect(queries.some((sql) => sql.includes("delete from stripe_subscription_discounts"))).toBe(false);
  });

  it("refreshes every mutable normalized invoice field and raw pointer on a newer version", async () => {
    const queries: string[] = [];

    await connectorFor("stripe").sync(
      fakeDb({
        queries,
        credential: {
          credential_kind: "fixture",
          encrypted_payload: "fixture-encrypted",
        },
      }),
      request("stripe"),
    );

    const invoiceUpsert = queries.find((sql) => sql.includes("insert into stripe_invoices")) ?? "";
    expect(invoiceUpsert).toContain("stripe_subscription_id");
    expect(invoiceUpsert).toContain("subscription_origin");
    expect(invoiceUpsert).toMatch(/raw_record_id\s*=\s*excluded\.raw_record_id/);
    expect(invoiceUpsert).toMatch(/stripe_subscription_id\s*=\s*excluded\.stripe_subscription_id/);
    expect(invoiceUpsert).toMatch(/subscription_origin\s*=\s*excluded\.subscription_origin/);
    expect(invoiceUpsert).toMatch(/status\s*=\s*excluded\.status/);
    expect(invoiceUpsert).toMatch(/currency\s*=\s*excluded\.currency/);
    expect(invoiceUpsert).toMatch(/amount_paid\s*=\s*excluded\.amount_paid/);
    expect(invoiceUpsert).toMatch(/amount_due\s*=\s*excluded\.amount_due/);
    expect(invoiceUpsert).toMatch(/paid_at\s*=\s*excluded\.paid_at/);
    expect(invoiceUpsert).toMatch(/stripe_customer_id\s*=\s*excluded\.stripe_customer_id/);
  });

  it("advances Stripe reconciliation state only after normalized invoice truth in successful CLOSE", async () => {
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      if (url.includes("/v1/customers")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/v1/subscriptions")) {
        return jsonResponse({ data: [], has_more: false });
      }
      if (url.includes("/v1/invoices?")) {
        return jsonResponse({ data: [stripeInvoice("in_checkpoint")], has_more: false });
      }
      if (url.includes("/v1/events?")) return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      );
    });

    const invoiceWrite = queryLog.findIndex((entry) => entry.sql.includes("insert into stripe_invoices"));
    const stateWrite = queryLog.findIndex((entry) => entry.sql.includes("insert into stripe_invoice_sync_state"));
    const cursorWrite = queryLog.findIndex((entry) => entry.sql.includes("insert into sync_cursors"));
    expect(invoiceWrite).toBeGreaterThan(-1);
    expect(stateWrite).toBeGreaterThan(invoiceWrite);
    expect(cursorWrite).toBeGreaterThan(stateWrite);
    expect(queryLog[stateWrite]?.params?.[3]).toBe("complete");
  });

  it("does not advance Stripe reconciliation state when normalized invoice loading fails", async () => {
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    await withMockFetch(async (url) => {
      if (url.includes("/v1/customers")) return jsonResponse({ data: [] });
      if (url.includes("/v1/subscriptions")) return jsonResponse({ data: [], has_more: false });
      if (url.includes("/v1/invoices?")) {
        return jsonResponse({ data: [stripeInvoice("in_failed_checkpoint")], has_more: false });
      }
      if (url.includes("/v1/events?")) return jsonResponse({ data: [], has_more: false });
      throw new Error(`unexpected Stripe test URL: ${url}`);
    }, async () => {
      await expect(connectorFor("stripe").sync(
        fakeDb({
          queryLog,
          failOnSqlIncludes: "insert into stripe_invoices",
          credential: {
            credential_kind: "api_key",
            encrypted_payload: encryptedCredential({
              mode: "live",
              secretKey: "sk_test",
              apiBaseUrl: "https://stripe.test",
            }),
          },
        }),
        request("stripe"),
      )).rejects.toThrow("forced fake DB write failure");
    });

    expect(queryLog.some((entry) => entry.sql.includes("insert into stripe_invoice_sync_state"))).toBe(false);
  });

  it("loads a whole chunk with ONE multi-row raw_records INSERT and ONE multi-row sync_batch_records INSERT", async () => {
    // Unit-level guard for the "multi-row inserts" change: one statement per chunk,
    // not one INSERT per record. (Alignment/chunk-boundary/idempotency correctness
    // is proven end-to-end against real PGlite in sync-batch-chunking.test.ts.)
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    let sourceStatus = "connected";
    const db: InfiniteOsDb = {
      async one() {
        return null;
      },
      query: (async (sql: string, params?: unknown[]) => {
        queryLog.push({ sql, params });
        if (sql.includes("select provider, status") && sql.includes("for update")) {
          return [{ provider: "posthog", status: sourceStatus }];
        }
        if (sql.includes("select id from sync_runs")) {
          return [{ id: "r" }];
        }
        return [];
      }) as InfiniteOsDb["query"],
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus(_sourceId, status) {
        sourceStatus = status;
      },
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      withTransaction(fn) {
        return fn(this);
      }
    };
    const records: ExtractedRecord<unknown>[] = [0, 1, 2].map((i) => ({
      externalId: `e${i}`,
      objectType: "obj",
      payloadVersion: "v1",
      sourceUpdatedAt: null,
      payload: { i }
    }));
    const request: SyncRequest = { workspaceId: "w", sourceId: "s", provider: "posthog", syncRunId: "r" };
    const plan: SyncPlan = {
      cursorKey: "k",
      cursorStart: null,
      cursorEnd: "2026-07-08T00:00:00.000Z",
      refreshWindowDays: 7,
      mode: "live"
    };

    await __testOnlySyncExtractedBatch(db, request, plan, records, async () => {});

    const rawInserts = queryLog.filter((q) => q.sql.includes("insert into raw_records"));
    expect(rawInserts).toHaveLength(1); // ONE statement for all 3 records
    // 3 VALUES tuples (one `::jsonb` cast per row) + 3 rows * 11 bound params.
    expect((rawInserts[0].sql.match(/::jsonb/g) ?? []).length).toBe(3);
    expect(rawInserts[0].params).toHaveLength(33);

    const sbrInserts = queryLog.filter(
      (q) => q.sql.includes("insert into sync_batch_records") && q.sql.includes("values")
    );
    expect(sbrInserts).toHaveLength(1); // ONE statement for all 3 records
    expect(sbrInserts[0].params).toHaveLength(9); // 3 rows * 3 params
  });

  it("rethrows the ORIGINAL chunk error even when the failure-marking tx itself fails (never masked)", async () => {
    // If the DB is broken (the likely cause of a chunk failure), the catch block's
    // marking tx throws too. The loader must log-and-continue past the marking
    // failure and rethrow the ORIGINAL error — a masked root cause is worse than
    // batch/run rows left at 'running'.
    let sourceStatus = "connected";
    const db: InfiniteOsDb = {
      async one() {
        return null;
      },
      query: (async (sql: string) => {
        if (sql.includes("select provider, status") && sql.includes("for update")) {
          return [{ provider: "posthog", status: sourceStatus }];
        }
        if (sql.includes("select id from sync_runs")) {
          return [{ id: "r" }];
        }
        if (sql.includes("update sync_runs") && sql.includes("returning id")) {
          throw new Error("db broke during failure marking");
        }
        return [];
      }) as InfiniteOsDb["query"],
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus(_sourceId, status) {
        sourceStatus = status;
      },
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      withTransaction(fn) {
        return fn(this);
      }
    };
    const records: ExtractedRecord<unknown>[] = [
      { externalId: "e0", objectType: "obj", payloadVersion: "v1", sourceUpdatedAt: null, payload: {} }
    ];
    const request: SyncRequest = { workspaceId: "w", sourceId: "s", provider: "posthog", syncRunId: "r" };
    const plan: SyncPlan = {
      cursorKey: "k",
      cursorStart: null,
      cursorEnd: "2026-07-08T00:00:00.000Z",
      refreshWindowDays: 7,
      mode: "live"
    };

    const originalError = new Error("writeTruth exploded");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        __testOnlySyncExtractedBatch(db, request, plan, records, async () => {
          throw originalError;
        })
      ).rejects.toBe(originalError); // the ORIGINAL error, not "db broke during failure marking"
      // The marking failure was logged, not swallowed silently.
      expect(
        consoleError.mock.calls.some((call) => String(call[0]).includes("failure-marking failed"))
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("writes Shopify raw rows before order, line, and product truth", async () => {
    const queries: string[] = [];
    await withMockFetch(async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (typeof body?.query === "string" && body.query.includes("shop {")) {
        return jsonResponse({ data: { shop: { myshopifyDomain: "demo-shop.myshopify.com" } } });
      }
      if (typeof body?.query === "string" && body.query.includes("products(")) {
        return jsonResponse({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: "gid://shopify/Product/200",
                    title: "Logo Tee",
                    vendor: "Infinite OS",
                    productType: "Apparel",
                    status: "ACTIVE",
                    createdAt: "2026-05-01T10:00:00.000Z",
                    updatedAt: "2026-06-02T09:00:00.000Z"
                  }
                }
              ]
            }
          }
        });
      }
      return jsonResponse({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: {
                  id: "gid://shopify/Order/1001",
                  name: "#1001",
                  createdAt: "2026-06-02T10:00:00.000Z",
                  processedAt: "2026-06-02T10:05:00.000Z",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "FULFILLED",
                  customer: { id: "gid://shopify/Customer/501", email: "buyer@example.com" },
                  currentSubtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
                  currentTotalTaxSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
                  currentTotalDiscountsSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
                  currentTotalPriceSet: { shopMoney: { amount: "95.00", currencyCode: "USD" } },
                  lineItems: {
                    edges: [
                      {
                        node: {
                          id: "gid://shopify/LineItem/1",
                          sku: "tee-1",
                          quantity: 2,
                          name: "Logo Tee",
                          originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
                          product: {
                            id: "gid://shopify/Product/200",
                            title: "Logo Tee",
                            vendor: "Infinite OS",
                            productType: "Apparel",
                            status: "ACTIVE"
                          },
                          variant: { id: "gid://shopify/ProductVariant/300" }
                        }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      });
    }, async () => {
      const result = await connectorFor("shopify").sync(
        fakeDb({
          queries,
          credential: {
            credential_kind: "admin_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              storeDomain: "demo-shop.myshopify.com",
              adminAccessToken: "shpat_test",
              apiVersion: "2026-01"
            })
          }
        }),
        request("shopify")
      );

      const rawIndex = queries.findIndex((sql) => sql.includes("insert into raw_records"));
      const orderIndex = queries.findIndex((sql) => sql.includes("insert into shopify_orders"));
      const lineIndex = queries.findIndex((sql) => sql.includes("insert into shopify_order_lines"));
      const productIndex = queries.findIndex((sql) => sql.includes("insert into shopify_products"));
      expect(result).toMatchObject({ provider: "shopify", recordsExtracted: 2, recordsLoaded: 2 });
      expect(rawIndex).toBeGreaterThanOrEqual(0);
      expect(orderIndex).toBeGreaterThan(rawIndex);
      expect(lineIndex).toBeGreaterThan(orderIndex);
      expect(productIndex).toBeGreaterThan(lineIndex);
      expect(queries.some((sql) => sql.includes("on conflict (source_id, shopify_order_id)"))).toBe(true);
      expect(queries.some((sql) => sql.includes("on conflict (source_id, shopify_line_item_id)"))).toBe(true);
      expect(queries.some((sql) => sql.includes("on conflict (source_id, shopify_product_id)"))).toBe(true);
    });
  });

  it("writes Meta Ads raw rows + the campaign dimension before campaign-daily truth", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const router = metaGraphMockRouter({
      data: [
        {
          campaign_id: "1200000001",
          campaign_name: "Scale Growth",
          date_start: "2026-06-01",
          spend: "123.45",
          clicks: "89",
          impressions: "4567",
          reach: "3200",
          cpm: "27.03",
          cpc: "1.39",
          ctr: "1.95",
          objective: "OUTCOME_LEADS",
          account_currency: "USD"
        }
      ],
      paging: {}
    });
    await withMockFetch(async (url) => router(url), async () => {
      const result = await connectorFor("meta_ads").sync(
        fakeDb({
          queryLog: queries,
          credential: {
            credential_kind: "marketing_api_access_token",
            encrypted_payload: encryptedCredential({
              mode: "live",
              adAccountId: "1234567890",
              accessToken: "meta-access-token",
              apiVersion: "v24.0"
            })
          }
        }),
        request("meta_ads")
      );

      const sqls = queries.map((entry) => entry.sql);
      const rawIndex = sqls.findIndex((sql) => sql.includes("insert into raw_records"));
      const dimIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_campaigns"));
      const truthIndex = sqls.findIndex((sql) => sql.includes("insert into meta_ads_campaign_daily"));
      expect(result).toMatchObject({ provider: "meta_ads", recordsExtracted: 1, recordsLoaded: 1 });
      expect(rawIndex).toBeGreaterThanOrEqual(0);
      // §2.1 — the dimension is populated (currency/objective for the §5 Stripe join), and it
      // is written BEFORE the delivery fact so the join views always have a campaign row.
      expect(dimIndex).toBeGreaterThanOrEqual(0);
      expect(dimIndex).toBeLessThan(truthIndex);
      expect(truthIndex).toBeGreaterThan(rawIndex);
      expect(queries.some((entry) => entry.sql.includes("on conflict (source_id, ad_account_id, campaign_id, occurred_on)"))).toBe(true);
      // The dimension upsert carries the load-bearing currency (lowercased) + objective so
      // dim.currency / dim.objective are no longer always NULL on the join views.
      const dimQuery = queries.find((entry) => entry.sql.includes("insert into meta_ads_campaigns"));
      expect(dimQuery?.sql).toContain("on conflict (source_id, ad_account_id, campaign_id)");
      expect(dimQuery?.params).toContain("usd"); // currency lowercased
      expect(dimQuery?.params).toContain("OUTCOME_LEADS"); // coarse objective
      expect(dimQuery?.params).toContain("1200000001"); // campaign_id
    });
  });

  it("classifies provider auth failures and rate limits", async () => {
    await withMockFetch(async () => new Response("unauthorized", { status: 401 }), async () => {
      await expect(
        connectorFor("stripe").testConnection(
          fakeDb({
            credential: {
              credential_kind: "api_key",
              encrypted_payload: encryptedCredential({ mode: "live", secretKey: "bad", apiBaseUrl: "https://stripe.test" })
            }
          }),
          request("stripe")
        )
      ).rejects.toThrow(/provider auth failed/);
    });

    await withMockFetch(async () => new Response("rate limited", { status: 429 }), async () => {
      await expect(
        connectorFor("posthog").testConnection(
          fakeDb({
            credential: {
              credential_kind: "personal_api_key",
              encrypted_payload: encryptedCredential({
                mode: "live",
                projectId: 1,
                personalApiKey: "ph-key",
                apiHost: "https://posthog.test"
              })
            }
          }),
          request("posthog")
        )
      ).rejects.toThrow(/provider rate limited/);
    });

    await withMockFetch(
      async () => new Response(
        JSON.stringify({
          type: "authentication_error",
          code: "permission_denied",
          detail: "API key missing required scope 'query:read'",
          key: "phx_secret_to_redact",
          authorization: "Bearer oauth-secret-token"
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
      async () => {
        await expect(
          connectorFor("posthog").testConnection(
            fakeDb({
              credential: {
                credential_kind: "personal_api_key",
                encrypted_payload: encryptedCredential({
                  mode: "live",
                  projectId: 1,
                  personalApiKey: "ph-key",
                  apiHost: "https://posthog.test"
                })
              }
            }),
            request("posthog")
          )
        ).rejects.toThrow(
          /provider auth failed 403 for https:\/\/posthog\.test\/api\/projects\/1\/query\/: .*query:read.*phx_\[redacted\].*Bearer \[redacted\]/
        );
      }
    );

    await withMockFetch(async () => new Response("unauthorized", { status: 401 }), async () => {
      await expect(
        connectorFor("x").testConnection(
          fakeDb({
            credential: {
              credential_kind: "bearer_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                bearerToken: "bad",
                username: "XDevelopers",
                apiBaseUrl: "https://x.test"
              })
            }
          }),
          request("x")
        )
      ).rejects.toThrow(/provider auth failed/);
    });

    await withMockFetch(async () => new Response("rate limited", { status: 429 }), async () => {
      await expect(
        connectorFor("x").testConnection(
          fakeDb({
            credential: {
              credential_kind: "bearer_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                bearerToken: "x-bearer-token",
                userId: "2244994945",
                apiBaseUrl: "https://x.test"
              })
            }
          }),
          request("x")
        )
      ).rejects.toThrow(/provider rate limited/);
    });

    await withMockFetch(async () => new Response("unauthorized", { status: 401 }), async () => {
      await expect(
        connectorFor("meta_ads").testConnection(
          fakeDb({
            credential: {
              credential_kind: "marketing_api_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                adAccountId: "1234567890",
                accessToken: "meta-secret-token",
                apiVersion: "v24.0"
              })
            }
          }),
          request("meta_ads")
        )
      ).rejects.not.toThrow(/meta-secret-token|access_token=/);
    });
  });

  it("records pre-raw provider failures as sync errors", async () => {
    const queries: string[] = [];
    await withMockFetch(async () => new Response("unauthorized", { status: 401 }), async () => {
      await expect(
        connectorFor("google_analytics_4").sync(
          fakeDb({
            queries,
            credential: {
              credential_kind: "oauth_access_token",
              encrypted_payload: encryptedCredential({
                mode: "live",
                propertyId: "123",
                accessToken: "bad",
                apiBaseUrl: "https://ga4.test"
              })
            }
          }),
          request("google_analytics_4")
        )
      ).rejects.toThrow(/provider auth failed/);
    });

    expect(queries.some((sql) => sql.includes("insert into sync_errors"))).toBe(true);
    expect(queries.some((sql) => sql.includes("insert into raw_records"))).toBe(false);
  });

  it("records an undecryptable credential (key mismatch) as a non-retryable failure + marks the source error", async () => {
    // Regression guard: the decrypt happens in planSync. Pre-fix, planSync ran OUTSIDE sync()'s
    // try/catch, so a key-mismatch threw before recordSyncFailure could run — the source stayed
    // "connected" and the worker re-enqueued the doomed sync forever (silent failure).
    const prev = process.env.GROWTH_OS_ENCRYPTION_KEY;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "engine-current-key-not-a-default-aaaaaaaa";
    try {
      // Credential encrypted under a DIFFERENT key than the engine is configured with.
      const wrongKeyPayload = encryptCredentialPayload(
        { mode: "live", propertyId: "123", accessToken: "x", apiBaseUrl: "https://ga4.test" },
        "a-different-but-valid-key-bbbbbbbbbbbbbbbb"
      );
      const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
      const statuses: Array<{ id: string; status: string }> = [];
      const db = fakeDb({
        queryLog,
        credential: { credential_kind: "oauth_access_token", encrypted_payload: wrongKeyPayload }
      });
      db.updateSourceStatus = async (id: string, status: string) => {
        statuses.push({ id, status });
      };
      const req = request("google_analytics_4");

      await expect(connectorFor("google_analytics_4").sync(db, req)).rejects.toThrow(
        /could not be decrypted/
      );

      const syncErr = queryLog.find((q) => q.sql.includes("insert into sync_errors"));
      expect(syncErr, "a sync_errors row must be recorded on a decrypt failure").toBeTruthy();
      expect(syncErr?.params).toContain("credential_undecryptable");
      expect(syncErr?.params).toContain(false); // retryable = false (retrying never helps a key mismatch)
      expect(statuses).toContainEqual({ id: req.sourceId, status: "error" });
    } finally {
      // Restore exactly — assigning `undefined` would set the env var to the string "undefined".
      if (prev === undefined) {
        delete process.env.GROWTH_OS_ENCRYPTION_KEY;
      } else {
        process.env.GROWTH_OS_ENCRYPTION_KEY = prev;
      }
    }
  });
});

describe("classifySyncFailure (status-escalation classifier)", () => {
  // Untyped network/transport failures reach recordSyncFailure via providerError as
  // retryable provider_api_error — one message per undici/socket error string class.
  const NETWORK_MESSAGES = [
    "fetch failed",
    "connect ECONNREFUSED 127.0.0.1:443",
    "connect ETIMEDOUT 157.240.3.35:443",
    "getaddrinfo ENOTFOUND graph.facebook.com",
    "getaddrinfo EAI_AGAIN graph.facebook.com",
    "socket hang up",
    "read ECONNRESET",
    "The operation was aborted"
  ];

  it("classifies every network/transport error class as transient", () => {
    for (const message of NETWORK_MESSAGES) {
      expect(
        classifySyncFailure({ code: "provider_api_error", message, retryable: true }),
        message
      ).toBe("transient");
    }
  });

  it("classifies provider 5xx and 429 responses as transient", () => {
    expect(
      classifySyncFailure({
        code: "provider_api_error",
        message: "provider request failed 503 for https://ga4.test/run",
        retryable: true
      })
    ).toBe("transient");
    expect(
      classifySyncFailure({
        code: "provider_rate_limited",
        message: "provider rate limited 429 for https://graph.facebook.com/v25.0/act_1/insights",
        retryable: true
      })
    ).toBe("transient");
  });

  it("classifies typed provider auth rejections (401/403) as terminal", () => {
    expect(
      classifySyncFailure({
        code: "provider_auth_failed",
        message: "provider auth failed 401 for https://ga4.test/run",
        retryable: false
      })
    ).toBe("terminal");
  });

  it("classifies credential_undecryptable as terminal even if mislabeled retryable", () => {
    expect(
      classifySyncFailure({
        code: "credential_undecryptable",
        message: "stored credential could not be decrypted",
        retryable: true
      })
    ).toBe("terminal");
  });

  it("classifies any deliberately non-retryable typed error as terminal", () => {
    expect(
      classifySyncFailure({
        code: "provider_api_error",
        message: "Meta Ads write request failed for https://graph.facebook.com/v25.0/act_1/campaigns: boom",
        retryable: false
      })
    ).toBe("terminal");
  });

  it("classifies Meta OAuthException 190/102/200 bodies as terminal despite their retryable HTTP-400 shape", () => {
    // Meta ships credential-grade OAuth rejections as HTTP 400, which the status taxonomy
    // types retryable provider_api_error — the body sniff must catch them anyway.
    for (const code of [190, 102, 200]) {
      expect(
        classifySyncFailure({
          code: "provider_api_error",
          message: `provider request failed 400 for https://graph.facebook.com/v25.0/act_1/insights: {"error":{"message":"Error validating access token: Session has expired","type":"OAuthException","code":${code},"fbtrace_id":"AbC"}}`,
          retryable: true
        }),
        `OAuthException code ${code}`
      ).toBe("terminal");
    }
  });

  it("keeps Meta OAuthException-labeled THROTTLES transient (Meta labels #4/#17/#32 OAuthException too)", () => {
    for (const code of [4, 17, 32]) {
      expect(
        classifySyncFailure({
          code: "provider_api_error",
          message: `provider request failed 400 for https://graph.facebook.com/v25.0/act_1/insights: {"error":{"message":"(#${code}) Application request limit reached","type":"OAuthException","code":${code},"is_transient":true}}`,
          retryable: true
        }),
        `OAuthException code ${code}`
      ).toBe("transient");
    }
  });
});

describe("proportionate sync-failure status escalation", () => {
  // The live 2026-07-19 incident: the machine slept mid-fetch, undici threw "fetch failed",
  // and the source parked at status='error' — a terminal state nothing retries — on the
  // FIRST transient failure of a perfectly valid credential.
  const ga4Credential = () => ({
    credential_kind: "oauth_access_token",
    encrypted_payload: encryptedCredential({
      mode: "live",
      propertyId: "123",
      accessToken: "still-valid",
      apiBaseUrl: "https://ga4.test"
    })
  });

  it("a single transient network failure records the failed run but leaves source status untouched", async () => {
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    const statuses: Array<{ id: string; status: string }> = [];
    const db = fakeDb({ queryLog, credential: ga4Credential(), consecutiveSyncFailures: 1 });
    db.updateSourceStatus = async (id: string, status: string) => {
      statuses.push({ id, status });
    };

    await withMockFetch(
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        await expect(connectorFor("google_analytics_4").sync(db, request("google_analytics_4"))).rejects.toThrow(
          /fetch failed/
        );
      }
    );

    // The failure stays visible — run + error rows are recorded honestly...
    expect(queryLog.some((q) => q.sql.includes("insert into sync_runs") && q.sql.includes("'failed'"))).toBe(true);
    expect(queryLog.some((q) => q.sql.includes("insert into sync_errors"))).toBe(true);
    // ...and the consecutive-failure counter advances through the TIME-GATED update (0045):
    // the increment stamps last_counted_sync_failure_at and only matches when the previous
    // counted failure is beyond the spacing window, bound as the ms parameter.
    const gatedIncrement = queryLog.find((q) =>
      q.sql.includes("consecutive_sync_failures = consecutive_sync_failures + 1")
    );
    expect(gatedIncrement?.sql).toContain("last_counted_sync_failure_at = now()");
    expect(gatedIncrement?.sql).toContain("last_counted_sync_failure_at is null");
    expect(gatedIncrement?.params).toContain(45 * 60 * 1000);
    // The pre-provider claim is observable, but the failure never parks the source. The
    // direct restore-to-connected SQL preserves the counted streak and scheduler rotation.
    expect(statuses).toEqual([{ id: "source_google_analytics_4", status: "syncing" }]);
    expect(queryLog.some((q) => q.sql.includes("set status = 'connected'") && q.sql.includes("status = 'syncing'"))).toBe(true);
  });

  it("a burst duplicate (time gate blocks the increment) leaves the streak AND status untouched, even at the threshold", async () => {
    // The C4a/C5 failure mode the gate exists for: attempts cluster — scheduler ticks during
    // one offline stretch, or a job runner's own retries seconds apart within one scheduled
    // run — so a blocked increment must not evaluate the threshold. Prior counted strikes
    // already at threshold-crossing height (RETURNING would have said 3) must NOT park the
    // source when this attempt is a duplicate of the SAME episode.
    const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
    const statuses: Array<{ id: string; status: string }> = [];
    const db = fakeDb({
      queryLog,
      credential: ga4Credential(),
      consecutiveSyncFailures: 3,
      failureStreakGateBlocked: true
    });
    db.updateSourceStatus = async (id: string, status: string) => {
      statuses.push({ id, status });
    };

    await withMockFetch(
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        await expect(connectorFor("google_analytics_4").sync(db, request("google_analytics_4"))).rejects.toThrow(
          /fetch failed/
        );
      }
    );

    // Still recorded honestly — the gate is not a masking fallback...
    expect(queryLog.some((q) => q.sql.includes("insert into sync_runs") && q.sql.includes("'failed'"))).toBe(true);
    expect(queryLog.some((q) => q.sql.includes("insert into sync_errors"))).toBe(true);
    // ...but no strike counted → no park. Only the pre-provider claim is visible through
    // updateSourceStatus; the direct connected restore preserves streak state.
    expect(statuses).toEqual([{ id: "source_google_analytics_4", status: "syncing" }]);
    expect(queryLog.some((q) => q.sql.includes("set status = 'connected'") && q.sql.includes("status = 'syncing'"))).toBe(true);
  });

  it("escalates to error once the transient-failure streak reaches the threshold (3 counted episodes)", async () => {
    const statuses: Array<{ id: string; status: string }> = [];
    const db = fakeDb({ credential: ga4Credential(), consecutiveSyncFailures: 3 });
    db.updateSourceStatus = async (id: string, status: string) => {
      statuses.push({ id, status });
    };
    const req = request("google_analytics_4");

    await withMockFetch(
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        await expect(connectorFor("google_analytics_4").sync(db, req)).rejects.toThrow(/fetch failed/);
      }
    );

    // Third consecutive transient failure → the path is genuinely dead → park it.
    expect(statuses).toContainEqual({ id: req.sourceId, status: "error" });
  });

  it("a provider auth rejection still parks the source immediately on the first failure", async () => {
    const statuses: Array<{ id: string; status: string }> = [];
    const db = fakeDb({ credential: ga4Credential(), consecutiveSyncFailures: 1 });
    db.updateSourceStatus = async (id: string, status: string) => {
      statuses.push({ id, status });
    };
    const req = request("google_analytics_4");

    await withMockFetch(
      async () => new Response("unauthorized", { status: 401 }),
      async () => {
        await expect(connectorFor("google_analytics_4").sync(db, req)).rejects.toThrow(/provider auth failed/);
      }
    );

    expect(statuses).toContainEqual({ id: req.sourceId, status: "error" });
  });

  it("a terminal failure parks immediately even when the time gate blocked the streak increment", async () => {
    // Terminal classification (auth rejection, credential_undecryptable) never consults the
    // streak — the 0045 gate must not delay the park by even one attempt.
    const statuses: Array<{ id: string; status: string }> = [];
    const db = fakeDb({
      credential: ga4Credential(),
      failureStreakGateBlocked: true
    });
    db.updateSourceStatus = async (id: string, status: string) => {
      statuses.push({ id, status });
    };
    const req = request("google_analytics_4");

    await withMockFetch(
      async () => new Response("unauthorized", { status: 401 }),
      async () => {
        await expect(connectorFor("google_analytics_4").sync(db, req)).rejects.toThrow(/provider auth failed/);
      }
    );

    expect(statuses).toContainEqual({ id: req.sourceId, status: "error" });
  });
});

describe("oauth_token_id dual-read", () => {
  it("reads the live linked oauth token and merges it with encrypted_payload metadata", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    await withMockFetch(async (url, init) => {
      requests.push({ url, authorization: headerValue(init.headers, "Authorization") });
      return jsonResponse({ rows: [] });
    }, async () => {
      const queries: string[] = [];
      const db = oauthFakeDb({
        // Metadata only — no token here. The token comes from oauth_tokens.
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/777",
            apiBaseUrl: "https://ga4.test"
          }),
          oauth_token_id: "oauth_token_live"
        },
        oauthTokens: {
          oauth_token_live: {
            encrypted_payload: encryptedCredential({
              accessToken: "fresh-access-token",
              refreshToken: "refresh-token",
              expiresAt: new Date(Date.now() + 3600_000).toISOString()
            }),
            expires_at: new Date(Date.now() + 3600_000).toISOString()
          }
        },
        queries
      });

      await expect(
        connectorFor("google_analytics_4").testConnection(db, request("google_analytics_4"))
      ).resolves.toMatchObject({ ok: true, mode: "live", accountExternalId: "properties/777" });

      expect(requests[0]).toMatchObject({
        url: "https://ga4.test/properties/777:runReport",
        authorization: "Bearer fresh-access-token"
      });
      // Valid token => no refresh and no oauth_tokens UPDATE.
      expect(requests).toHaveLength(1);
      expect(queries.some((sql) => sql.includes("update oauth_tokens"))).toBe(false);
    });
  });

  it("refreshes an expired linked oauth token in place and uses the new token", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: string | null }> = [];
    await withMockFetch(async (url, init) => {
      requests.push({
        url,
        authorization: headerValue(init.headers, "Authorization"),
        body: init.body ? String(init.body) : null
      });
      if (url.includes("/token")) {
        return jsonResponse({ access_token: "rotated-access-token", expires_in: 3600 });
      }
      return jsonResponse({ rows: [] });
    }, async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const db = oauthFakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/888",
            apiBaseUrl: "https://ga4.test"
          }),
          oauth_token_id: "oauth_token_expired"
        },
        oauthTokens: {
          oauth_token_expired: {
            encrypted_payload: encryptedCredential({
              accessToken: "stale-access-token",
              refreshToken: "stored-refresh-token",
              expiresAt: new Date(Date.now() - 3600_000).toISOString(),
              oauthApp: {
                clientId: "client-id",
                clientSecret: "client-secret",
                tokenUrl: "https://oauth2.test/token"
              }
            }),
            expires_at: new Date(Date.now() - 3600_000).toISOString()
          }
        },
        queryLog: queries
      });

      await expect(
        connectorFor("google_analytics_4").testConnection(db, request("google_analytics_4"))
      ).resolves.toMatchObject({ ok: true, mode: "live" });

      const tokenCall = requests.find((req) => req.url === "https://oauth2.test/token");
      expect(tokenCall).toBeDefined();
      expect(tokenCall?.body).toContain("grant_type=refresh_token");
      expect(tokenCall?.body).toContain("refresh_token=stored-refresh-token");

      const runReportCall = requests.find((req) => req.url.includes("runReport"));
      expect(runReportCall?.authorization).toBe("Bearer rotated-access-token");

      const update = queries.find((entry) => entry.sql.includes("update oauth_tokens"));
      expect(update).toBeDefined();
      expect(update?.params?.[0]).toBe("oauth_token_expired");
    });
  });

  it("keeps reading encrypted_payload (no oauth_tokens lookup) when oauth_token_id is NULL", async () => {
    const requests: Array<{ authorization: string | null }> = [];
    await withMockFetch(async (_url, init) => {
      requests.push({ authorization: headerValue(init.headers, "Authorization") });
      return jsonResponse({ rows: [] });
    }, async () => {
      const queries: string[] = [];
      const db = oauthFakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/legacy",
            accessToken: "legacy-token",
            apiBaseUrl: "https://ga4.test"
          }),
          oauth_token_id: null
        },
        oauthTokens: {},
        queries
      });

      await connectorFor("google_analytics_4").testConnection(db, request("google_analytics_4"));

      expect(requests[0].authorization).toBe("Bearer legacy-token");
      expect(queries.some((sql) => sql.includes("oauth_tokens"))).toBe(false);
    });
  });

  it("reads a non-OAuth credential directly from encrypted_payload (NULL oauth_token_id)", async () => {
    await withMockFetch(async () => jsonResponse({ results: [] }), async () => {
      const queries: string[] = [];
      const db = oauthFakeDb({
        credential: {
          credential_kind: "personal_api_key",
          encrypted_payload: encryptedCredential({
            mode: "live",
            projectId: 99,
            personalApiKey: "ph-personal-key",
            apiHost: "https://posthog.test"
          }),
          oauth_token_id: null
        },
        oauthTokens: {},
        queries
      });

      await expect(
        connectorFor("posthog").testConnection(db, request("posthog"))
      ).resolves.toMatchObject({ ok: true, mode: "live", accountExternalId: "99" });
      expect(queries.some((sql) => sql.includes("oauth_tokens"))).toBe(false);
    });
  });
});

// ── Cloud-default credential custody: SyncRequest.encryptionKey per-workspace override ───────
// Proves the READ/refresh seam: a caller-supplied per-workspace key wins over process.env at
// EVERY decrypt/re-encrypt site, and the oauth re-encrypt uses the SAME key as the decrypt (so a
// later read still decrypts). The env is deliberately set to a DIFFERENT key throughout — if the
// override did not win, every decrypt would throw "could not be decrypted".
describe("SyncRequest.encryptionKey (per-workspace custody override)", () => {
  const PER_WS_KEY = "per-workspace-key-1111111111111111111111";
  const WRONG_ENV_KEY = "wrong-env-key-2222222222222222222222";

  function withWrongEnvKey<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GROWTH_OS_ENCRYPTION_KEY;
    process.env.GROWTH_OS_ENCRYPTION_KEY = WRONG_ENV_KEY;
    return (async () => {
      try {
        return await fn();
      } finally {
        if (prev === undefined) {
          delete process.env.GROWTH_OS_ENCRYPTION_KEY;
        } else {
          process.env.GROWTH_OS_ENCRYPTION_KEY = prev;
        }
      }
    })();
  }

  it("decrypts an oauth_tokens credential under the request key, ignoring a wrong process.env key", async () => {
    await withWrongEnvKey(async () => {
      const requests: Array<{ url: string; authorization: string | null }> = [];
      await withMockFetch(async (url, init) => {
        requests.push({ url, authorization: headerValue(init.headers, "Authorization") });
        return jsonResponse({ rows: [] });
      }, async () => {
        const db = oauthFakeDb({
          credential: {
            credential_kind: "oauth_access_token",
            // Metadata + token both encrypted under the PER-WORKSPACE key (NOT the env key).
            encrypted_payload: encryptedCredentialWith(
              { mode: "live", propertyId: "properties/ws1", apiBaseUrl: "https://ga4.test" },
              PER_WS_KEY
            ),
            oauth_token_id: "oauth_token_ws1"
          },
          oauthTokens: {
            oauth_token_ws1: {
              encrypted_payload: encryptedCredentialWith(
                {
                  accessToken: "ws1-access-token",
                  refreshToken: "ws1-refresh-token",
                  expiresAt: new Date(Date.now() + 3600_000).toISOString()
                },
                PER_WS_KEY
              ),
              expires_at: new Date(Date.now() + 3600_000).toISOString()
            }
          }
        });

        await expect(
          connectorFor("google_analytics_4").testConnection(db, {
            ...request("google_analytics_4"),
            encryptionKey: PER_WS_KEY
          })
        ).resolves.toMatchObject({ ok: true, mode: "live", accountExternalId: "properties/ws1" });
        expect(requests[0]?.authorization).toBe("Bearer ws1-access-token");
      });
    });
  });

  it("WITHOUT the request key, the same wrong-env credential fails to decrypt (control)", async () => {
    await withWrongEnvKey(async () => {
      await withMockFetch(async () => jsonResponse({ rows: [] }), async () => {
        const db = oauthFakeDb({
          credential: {
            credential_kind: "oauth_access_token",
            encrypted_payload: encryptedCredentialWith(
              { mode: "live", propertyId: "properties/ws1", apiBaseUrl: "https://ga4.test" },
              PER_WS_KEY
            ),
            oauth_token_id: "oauth_token_ws1"
          },
          oauthTokens: {
            oauth_token_ws1: {
              encrypted_payload: encryptedCredentialWith(
                { accessToken: "ws1-access-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
                PER_WS_KEY
              ),
              expires_at: new Date(Date.now() + 3600_000).toISOString()
            }
          }
        });

        // No encryptionKey on the request → falls back to the (wrong) env key → decrypt fails.
        await expect(
          connectorFor("google_analytics_4").testConnection(db, request("google_analytics_4"))
        ).rejects.toThrow(/could not be decrypted/);
      });
    });
  });

  it("re-encrypts a refreshed oauth token under the SAME request key (not the env key)", async () => {
    await withWrongEnvKey(async () => {
      await withMockFetch(async (url) => {
        if (url.includes("/token")) {
          return jsonResponse({ access_token: "rotated-under-ws-key", expires_in: 3600 });
        }
        return jsonResponse({ rows: [] });
      }, async () => {
        const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
        const db = oauthFakeDb({
          credential: {
            credential_kind: "oauth_access_token",
            encrypted_payload: encryptedCredentialWith(
              { mode: "live", propertyId: "properties/ws1", apiBaseUrl: "https://ga4.test" },
              PER_WS_KEY
            ),
            oauth_token_id: "oauth_token_expired_ws1"
          },
          oauthTokens: {
            oauth_token_expired_ws1: {
              encrypted_payload: encryptedCredentialWith(
                {
                  accessToken: "stale-access-token",
                  refreshToken: "ws1-refresh-token",
                  // Expired → forces the in-place refresh + re-encrypt path.
                  expiresAt: new Date(Date.now() - 3600_000).toISOString(),
                  oauthApp: {
                    clientId: "client-id",
                    clientSecret: "client-secret",
                    tokenUrl: "https://oauth2.test/token"
                  }
                },
                PER_WS_KEY
              ),
              expires_at: new Date(Date.now() - 3600_000).toISOString()
            }
          },
          queryLog
        });

        await expect(
          connectorFor("google_analytics_4").testConnection(db, {
            ...request("google_analytics_4"),
            encryptionKey: PER_WS_KEY
          })
        ).resolves.toMatchObject({ ok: true, mode: "live" });

        const update = queryLog.find((entry) => entry.sql.includes("update oauth_tokens"));
        expect(update, "the expired token must have been re-encrypted in place").toBeDefined();
        const reEncrypted = String(update?.params?.[1]);

        // The re-encrypt used the PER-WORKSPACE key: it decrypts under PER_WS_KEY and carries the
        // rotated token. It must NOT decrypt under the wrong env key.
        const roundTripped = decryptCredentialPayload<Record<string, unknown>>(reEncrypted, PER_WS_KEY);
        expect(roundTripped.accessToken).toBe("rotated-under-ws-key");
        expect(() => decryptCredentialPayload(reEncrypted, WRONG_ENV_KEY)).toThrow();
      });
    });
  });

  it("decrypts a NON-OAuth (direct payload) credential under the request key too", async () => {
    await withWrongEnvKey(async () => {
      await withMockFetch(async () => jsonResponse({ results: [] }), async () => {
        const db = oauthFakeDb({
          credential: {
            credential_kind: "personal_api_key",
            encrypted_payload: encryptedCredentialWith(
              { mode: "live", projectId: 42, personalApiKey: "ph-ws-key", apiHost: "https://posthog.test" },
              PER_WS_KEY
            ),
            oauth_token_id: null
          },
          oauthTokens: {}
        });

        await expect(
          connectorFor("posthog").testConnection(db, { ...request("posthog"), encryptionKey: PER_WS_KEY })
        ).resolves.toMatchObject({ ok: true, mode: "live", accountExternalId: "42" });
      });
    });
  });
});

// ── Cloud-default windowed backfill: SyncRequest.windowSince/windowUntil + monotonic cursor ──
// Proves the windowing seam (defaultPlan honors an explicit [since, until]; GA4 derives its date
// range from an EXPLICIT request window and otherwise re-pulls its rolling reconcile window) and the
// monotonic-cursor write (greatest()) that lets many bounded windows land out-of-order / be retried
// without ever regressing the cursor.
describe("windowed backfill seam (windowSince/windowUntil)", () => {
  function posthogCredentialDb(cursorValue?: string, queries?: string[]) {
    return fakeDb({
      credential: {
        credential_kind: "personal_api_key",
        encrypted_payload: encryptedCredential({
          mode: "live",
          projectId: 7,
          personalApiKey: "ph-key",
          apiHost: "https://posthog.test"
        })
      },
      ...(cursorValue ? { cursorValue } : {}),
      ...(queries ? { queries } : {})
    });
  }

  it("defaultPlan: windowSince/windowUntil override cursorStart/cursorEnd", async () => {
    const plan = await connectorFor("posthog").planSync(posthogCredentialDb(), {
      ...request("posthog"),
      windowSince: "2024-01-01T00:00:00.000Z",
      windowUntil: "2024-01-31T00:00:00.000Z"
    });
    expect(plan.cursorStart).toBe("2024-01-01T00:00:00.000Z");
    expect(plan.cursorEnd).toBe("2024-01-31T00:00:00.000Z");
  });

  it("defaultPlan: the window wins even over a stored incremental cursor", async () => {
    const plan = await connectorFor("posthog").planSync(posthogCredentialDb("2025-05-05T00:00:00.000Z"), {
      ...request("posthog"),
      windowSince: "2024-01-01T00:00:00.000Z",
      windowUntil: "2024-01-31T00:00:00.000Z"
    });
    expect(plan.cursorStart).toBe("2024-01-01T00:00:00.000Z");
    expect(plan.cursorEnd).toBe("2024-01-31T00:00:00.000Z");
  });

  it("defaultPlan: without a window, behavior is unchanged (stored cursor / now)", async () => {
    const before = Date.now();
    const noCursor = await connectorFor("posthog").planSync(posthogCredentialDb(), request("posthog"));
    expect(noCursor.cursorStart).toBeNull();
    expect(Date.parse(noCursor.cursorEnd)).toBeGreaterThanOrEqual(before);

    const withCursor = await connectorFor("posthog").planSync(
      posthogCredentialDb("2025-05-05T00:00:00.000Z"),
      request("posthog")
    );
    expect(withCursor.cursorStart).toBe("2025-05-05T00:00:00.000Z");
  });

  it("GA4 extract derives dateRanges from the plan window", async () => {
    const bodies: Array<Record<string, unknown> | null> = [];
    await withMockFetch(async (_url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      bodies.push(body);
      if (isGa4PageReportBody(body as unknown as Ga4ReportBody)) return jsonResponse({ rows: [ga4PageReportRowFixture()] });
      if (isGa4OverviewReportBody(body as unknown as Ga4ReportBody)) return jsonResponse({ rows: [ga4OverviewReportRowFixture()] });
      return jsonResponse({ rows: [] });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/123",
            accessToken: "ga4-token",
            apiBaseUrl: "https://ga4.test"
          })
        }
      });
      // An EXPLICIT backfill window (request.windowSince/windowUntil) is what makes GA4 honor the
      // bounded span — defaultPlan mirrors it onto cursorStart/cursorEnd, so the plan matches too.
      await connectorFor("google_analytics_4").extract(
        db,
        {
          ...request("google_analytics_4"),
          windowSince: "2024-01-01T00:00:00.000Z",
          windowUntil: "2024-01-31T00:00:00.000Z"
        },
        {
          cursorKey: "ga4_run_report",
          cursorStart: "2024-01-01T00:00:00.000Z",
          cursorEnd: "2024-01-31T00:00:00.000Z",
          refreshWindowDays: 7,
          mode: "live"
        }
      );
      const overview = bodies.find((b) => isGa4OverviewReportBody(b as unknown as Ga4ReportBody));
      expect((overview as { dateRanges?: unknown }).dateRanges).toEqual([
        { startDate: "2024-01-01", endDate: "2024-01-31" }
      ]);
    });
  });

  it("GA4 extract falls back to the rolling refresh window when the plan carries no window", async () => {
    const bodies: Array<Record<string, unknown> | null> = [];
    await withMockFetch(async (_url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      bodies.push(body);
      if (isGa4PageReportBody(body as unknown as Ga4ReportBody)) return jsonResponse({ rows: [ga4PageReportRowFixture()] });
      if (isGa4OverviewReportBody(body as unknown as Ga4ReportBody)) return jsonResponse({ rows: [ga4OverviewReportRowFixture()] });
      return jsonResponse({ rows: [] });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/123",
            accessToken: "ga4-token",
            apiBaseUrl: "https://ga4.test"
          })
        }
      });
      const expectedStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await connectorFor("google_analytics_4").extract(db, request("google_analytics_4"), {
        cursorKey: "ga4_run_report",
        cursorStart: null,
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      });
      const overview = bodies.find((b) => isGa4OverviewReportBody(b as unknown as Ga4ReportBody)) as unknown as {
        dateRanges: Array<{ startDate: string; endDate: string }>;
      };
      // No request window → endDate is GA4's 'today' keyword (property-local, not the UTC cursor date);
      // startDate is the rolling refresh window.
      expect(overview.dateRanges[0].endDate).toBe("today");
      expect(overview.dateRanges[0].startDate).toBe(expectedStart);
    });
  });

  it("GA4 steady-state (stored cursor, NO window) re-pulls the full rolling reconcile window", async () => {
    // Regression: after the first sync the stored cursor is ~now, so plan.cursorStart is non-null.
    // GA4 must NOT start from that cursor (that would collapse the reconcile to the inter-sync gap and
    // miss Google's late-restated conversions/attribution) — with no explicit request window it re-pulls
    // [daysAgo(refreshWindowDays), today] every tick.
    const bodies: Array<Record<string, unknown> | null> = [];
    await withMockFetch(async (_url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      bodies.push(body);
      if (isGa4PageReportBody(body as unknown as Ga4ReportBody)) return jsonResponse({ rows: [ga4PageReportRowFixture()] });
      if (isGa4OverviewReportBody(body as unknown as Ga4ReportBody)) return jsonResponse({ rows: [ga4OverviewReportRowFixture()] });
      return jsonResponse({ rows: [] });
    }, async () => {
      const db = fakeDb({
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            propertyId: "properties/123",
            accessToken: "ga4-token",
            apiBaseUrl: "https://ga4.test"
          })
        }
      });
      const expectedStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      // A stored incremental cursor (a prior sync's cursorEnd, ~now) — NOT an explicit window.
      await connectorFor("google_analytics_4").extract(db, request("google_analytics_4"), {
        cursorKey: "ga4_run_report",
        cursorStart: "2026-06-02T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      });
      const overview = bodies.find((b) => isGa4OverviewReportBody(b as unknown as Ga4ReportBody)) as unknown as {
        dateRanges: Array<{ startDate: string; endDate: string }>;
      };
      // Start IGNORES the stored cursor → rolling window; end is 'today'.
      expect(overview.dateRanges[0].startDate).toBe(expectedStart);
      expect(overview.dateRanges[0].endDate).toBe("today");
    });
  });

  it("the CLOSE cursor upsert is monotonic — greatest(existing, incoming)", async () => {
    const queries: string[] = [];
    const db = posthogCredentialDb(undefined, queries);
    const plan: SyncPlan = {
      cursorKey: "posthog_event",
      cursorStart: null,
      cursorEnd: "2026-07-08T00:00:00.000Z",
      refreshWindowDays: 7,
      mode: "live"
    };
    await __testOnlySyncExtractedBatch(db, request("posthog"), plan, [], async () => {});
    const upsert = queries.find((sql) => sql.includes("insert into sync_cursors"));
    expect(upsert, "the CLOSE tx must upsert sync_cursors").toBeDefined();
    // Monotonic: never regress the cursor when out-of-order / retried windows land.
    expect(upsert).toContain("greatest(sync_cursors.cursor_value, excluded.cursor_value)");
    // And it must NOT be the old unconditional overwrite.
    expect(upsert).not.toMatch(/set cursor_value = excluded\.cursor_value\b/);
  });
});

// ── Meta Ads WRITE / management (PR #3 STAGE 1 — money-safety core) ───────────
describe("Meta Ads WRITE helpers", () => {
  const metaWriteCredential: MetaAdsCredential = {
    mode: "live",
    transport: "marketing_api",
    adAccountId: "1234567890",
    accessToken: "meta-write-token",
    apiVersion: "v25.0"
  };

  interface CapturedWrite {
    url: string;
    method: string | undefined;
    authorization: string | null;
    contentType: string | null;
    // The decoded WRITE body. WRITE POSTs are form-encoded
    // (application/x-www-form-urlencoded): each nested object/array field is a
    // JSON STRING, so we URL-decode the form and JSON.parse any field whose
    // value is a JSON object/array. Scalars (name/objective/budgets) stay as
    // strings — assertions account for that. GET reads have no body → null.
    body: Record<string, unknown> | null;
    // The raw form field map BEFORE JSON-parsing nested fields, so a test can
    // assert that nested fields are sent as JSON STRINGS on the wire.
    rawForm: Record<string, string> | null;
  }

  // Decode a form-encoded WRITE body. Mirrors the production `metaFormEncode`:
  // every field is a string; nested-object/array fields are JSON strings, which
  // we parse back so the shape assertions read naturally.
  function decodeWriteBody(raw: string): { body: Record<string, unknown>; rawForm: Record<string, string> } {
    const params = new URLSearchParams(raw);
    const body: Record<string, unknown> = {};
    const rawForm: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      rawForm[key] = value;
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        // A nested object/array field — sent as a JSON string per the wire format.
        body[key] = JSON.parse(value);
      } else {
        body[key] = value;
      }
    }
    return { body, rawForm };
  }

  function captureWrites(
    responder: (capture: CapturedWrite) => Response | Promise<Response>,
    fn: (captured: CapturedWrite[]) => Promise<void>
  ) {
    const captured: CapturedWrite[] = [];
    return withMockFetch(
      (url, init) => {
        let body: Record<string, unknown> | null = null;
        let rawForm: Record<string, string> | null = null;
        if (typeof init.body === "string") {
          try {
            const decoded = decodeWriteBody(init.body);
            body = decoded.body;
            rawForm = decoded.rawForm;
          } catch {
            body = null;
            rawForm = null;
          }
        }
        const capture: CapturedWrite = {
          url,
          method: init.method,
          authorization: headerValue(init.headers, "Authorization"),
          contentType: headerValue(init.headers, "Content-Type"),
          body,
          rawForm
        };
        captured.push(capture);
        return responder(capture);
      },
      () => fn(captured)
    );
  }

  it("POSTs to the correct edge per object with the bearer header and never the token in the URL", async () => {
    // Campaign → /campaigns
    await captureWrites(
      () => jsonResponse({ id: "120000000000001", status: "PAUSED" }),
      async (captured) => {
        const result = await createMetaCampaign(metaWriteCredential, {
          name: "Launch",
          objective: "OUTCOME_TRAFFIC"
        });
        expect(result).toEqual({ ok: true, id: "120000000000001", status: "PAUSED" });
        expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/act_1234567890/campaigns");
        expect(captured[0].method).toBe("POST");
        expect(captured[0].authorization).toBe("Bearer meta-write-token");
        expect(captured[0].url).not.toContain("access_token");
        expect(captured[0].url).not.toContain("meta-write-token");
      }
    );

    // Ad set → /adsets
    await captureWrites(
      () => jsonResponse({ id: "120000000000002", status: "PAUSED" }),
      async (captured) => {
        await createMetaAdSet(metaWriteCredential, {
          name: "AdSet",
          campaignId: "120000000000001",
          optimizationGoal: "LINK_CLICKS",
          billingEvent: "IMPRESSIONS"
        });
        expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/act_1234567890/adsets");
      }
    );

    // Creative → /adcreatives
    await captureWrites(
      () => jsonResponse({ id: "120000000000003" }),
      async (captured) => {
        await createMetaCreative(metaWriteCredential, {
          name: "Creative",
          pageId: "page_1",
          imageHash: "hash_abc"
        });
        expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/act_1234567890/adcreatives");
      }
    );

    // Ad → /ads
    await captureWrites(
      () => jsonResponse({ id: "120000000000004", status: "PAUSED" }),
      async (captured) => {
        await createMetaAd(metaWriteCredential, {
          name: "Ad",
          adsetId: "120000000000002",
          creativeId: "120000000000003"
        });
        expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/act_1234567890/ads");
      }
    );
  });

  it("sends the documented Graph payload shapes for each create (form-encoded wire)", async () => {
    await captureWrites(
      () => jsonResponse({ id: "c1", status: "PAUSED" }),
      async (captured) => {
        await createMetaCampaign(metaWriteCredential, {
          name: "Launch",
          objective: "OUTCOME_SALES",
          dailyBudget: 5000
        });
        // WIRE FORMAT: form-encoded, scalars verbatim (budgets become strings),
        // nested arrays/objects are JSON STRINGS in their own field.
        expect(captured[0].contentType).toBe("application/x-www-form-urlencoded");
        expect(captured[0].body).toEqual({
          name: "Launch",
          objective: "OUTCOME_SALES",
          status: "PAUSED",
          special_ad_categories: [],
          daily_budget: "5000"
        });
        // special_ad_categories must ride as a JSON STRING on the wire.
        expect(captured[0].rawForm?.special_ad_categories).toBe("[]");
      }
    );

    await captureWrites(
      () => jsonResponse({ id: "as1", status: "PAUSED" }),
      async (captured) => {
        await createMetaAdSet(metaWriteCredential, {
          name: "AdSet",
          campaignId: "c1",
          optimizationGoal: "OFFSITE_CONVERSIONS",
          billingEvent: "IMPRESSIONS",
          dailyBudget: 2500,
          targetingCountries: ["US", "CA"],
          pixelId: "px_1"
        });
        expect(captured[0].contentType).toBe("application/x-www-form-urlencoded");
        expect(captured[0].body).toEqual({
          name: "AdSet",
          campaign_id: "c1",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          status: "PAUSED",
          daily_budget: "2500",
          targeting: { geo_locations: { countries: ["US", "CA"] } },
          promoted_object: { pixel_id: "px_1", custom_event_type: "PURCHASE" }
        });
        // targeting + promoted_object ride as JSON STRINGS on the wire.
        expect(captured[0].rawForm?.targeting).toBe(
          JSON.stringify({ geo_locations: { countries: ["US", "CA"] } })
        );
        expect(captured[0].rawForm?.promoted_object).toBe(
          JSON.stringify({ pixel_id: "px_1", custom_event_type: "PURCHASE" })
        );
      }
    );

    // Link creative → object_story_spec.link_data (headline key is "name").
    await captureWrites(
      () => jsonResponse({ id: "cr1" }),
      async (captured) => {
        await createMetaCreative(metaWriteCredential, {
          name: "LinkCreative",
          pageId: "page_1",
          imageHash: "hash_abc",
          linkUrl: "https://example.com",
          body: "50% off everything!",
          title: "Shop Now",
          description: "Limited time offer",
          callToAction: "SHOP_NOW"
        });
        expect(captured[0].contentType).toBe("application/x-www-form-urlencoded");
        expect(captured[0].body).toEqual({
          name: "LinkCreative",
          object_story_spec: {
            page_id: "page_1",
            link_data: {
              link: "https://example.com",
              image_hash: "hash_abc",
              message: "50% off everything!",
              name: "Shop Now",
              description: "Limited time offer",
              call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com" } }
            }
          }
        });
        // object_story_spec is a single JSON-string field on the wire.
        expect(captured[0].rawForm?.object_story_spec).toBe(
          JSON.stringify({
            page_id: "page_1",
            link_data: {
              link: "https://example.com",
              image_hash: "hash_abc",
              message: "50% off everything!",
              name: "Shop Now",
              description: "Limited time offer",
              call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com" } }
            }
          })
        );
      }
    );

    // Photo creative (no link) → object_story_spec.photo_data, --body → caption.
    await captureWrites(
      () => jsonResponse({ id: "cr2" }),
      async (captured) => {
        await createMetaCreative(metaWriteCredential, {
          name: "PhotoCreative",
          pageId: "page_1",
          imageHash: "hash_xyz",
          body: "Check out our latest product!"
        });
        expect(captured[0].body).toEqual({
          name: "PhotoCreative",
          object_story_spec: {
            page_id: "page_1",
            photo_data: { image_hash: "hash_xyz", caption: "Check out our latest product!" }
          }
        });
      }
    );

    await captureWrites(
      () => jsonResponse({ id: "ad1", status: "PAUSED" }),
      async (captured) => {
        await createMetaAd(metaWriteCredential, {
          name: "Ad",
          adsetId: "as1",
          creativeId: "cr1"
        });
        expect(captured[0].body).toEqual({
          name: "Ad",
          adset_id: "as1",
          creative: { creative_id: "cr1" },
          status: "PAUSED"
        });
        // creative wraps {creative_id} as a JSON STRING on the wire.
        expect(captured[0].rawForm?.creative).toBe(JSON.stringify({ creative_id: "cr1" }));
      }
    );
  });

  describe("money-safety: create never yields ACTIVE", () => {
    it("hard-codes PAUSED in the body and ignores any caller-supplied status", async () => {
      await captureWrites(
        () => jsonResponse({ id: "c1", status: "PAUSED" }),
        async (captured) => {
          // Sneak an ACTIVE status in via the loose credential index signature /
          // an extra input field — the helper must drop it and send PAUSED.
          await createMetaCampaign(metaWriteCredential, {
            name: "Sneaky",
            objective: "OUTCOME_TRAFFIC",
            status: "ACTIVE"
          } as Parameters<typeof createMetaCampaign>[1]);
          expect(captured[0].body?.status).toBe("PAUSED");
          expect(JSON.stringify(captured[0].body)).not.toContain("ACTIVE");
        }
      );
    });

    it("errors (and reports a money-safety violation) when Graph echoes ACTIVE on a create", async () => {
      await captureWrites(
        () => jsonResponse({ id: "c1", status: "ACTIVE" }),
        async () => {
          await expect(
            createMetaCampaign(metaWriteCredential, { name: "X", objective: "OUTCOME_TRAFFIC" })
          ).rejects.toMatchObject({ code: "money_safety_violation", retryable: false });
        }
      );
    });

    it("accepts a create that echoes no status (treated as PAUSED)", async () => {
      await captureWrites(
        () => jsonResponse({ id: "c1" }),
        async () => {
          await expect(
            createMetaCampaign(metaWriteCredential, { name: "X", objective: "OUTCOME_TRAFFIC" })
          ).resolves.toMatchObject({ ok: true, id: "c1", status: null });
        }
      );
    });
  });

  describe("enum normalization + allow-list validation (FIX 3)", () => {
    it("uppercases objective / optimizationGoal / billingEvent / customEventType / callToAction before the POST", async () => {
      // Campaign objective lowercase → uppercased on the wire.
      await captureWrites(
        () => jsonResponse({ id: "c1", status: "PAUSED" }),
        async (captured) => {
          await createMetaCampaign(metaWriteCredential, {
            name: "X",
            objective: "outcome_sales"
          });
          expect(captured[0].body?.objective).toBe("OUTCOME_SALES");
        }
      );

      // Ad set goal/billing/customEventType lowercase → uppercased.
      await captureWrites(
        () => jsonResponse({ id: "as1", status: "PAUSED" }),
        async (captured) => {
          await createMetaAdSet(metaWriteCredential, {
            name: "AS",
            campaignId: "c1",
            optimizationGoal: "offsite_conversions",
            billingEvent: "impressions",
            pixelId: "px_1",
            customEventType: "purchase"
          });
          expect(captured[0].body?.optimization_goal).toBe("OFFSITE_CONVERSIONS");
          expect(captured[0].body?.billing_event).toBe("IMPRESSIONS");
          expect(captured[0].body?.promoted_object).toEqual({
            pixel_id: "px_1",
            custom_event_type: "PURCHASE"
          });
        }
      );

      // Creative call-to-action lowercase → uppercased inside link_data.
      await captureWrites(
        () => jsonResponse({ id: "cr1" }),
        async (captured) => {
          await createMetaCreative(metaWriteCredential, {
            name: "CR",
            pageId: "page_1",
            imageHash: "hash_abc",
            linkUrl: "https://example.com",
            callToAction: "shop_now"
          });
          const oss = captured[0].body?.object_story_spec as Record<string, unknown>;
          const linkData = oss.link_data as Record<string, unknown>;
          expect((linkData.call_to_action as Record<string, unknown>).type).toBe("SHOP_NOW");
        }
      );
    });

    it("rejects an UNKNOWN enum value with a clear non-retryable error (never POSTs)", async () => {
      await withMockFetch(
        () => jsonResponse({ id: "should-not-happen" }),
        async () => {
          await expect(
            createMetaCampaign(metaWriteCredential, { name: "X", objective: "OUTCOME_BOGUS" })
          ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
          await expect(
            createMetaAdSet(metaWriteCredential, {
              name: "AS",
              campaignId: "c1",
              optimizationGoal: "NOT_A_GOAL",
              billingEvent: "IMPRESSIONS"
            })
          ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
          await expect(
            createMetaAdSet(metaWriteCredential, {
              name: "AS",
              campaignId: "c1",
              optimizationGoal: "LINK_CLICKS",
              billingEvent: "NOT_A_BILLING_EVENT"
            })
          ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
          await expect(
            createMetaCreative(metaWriteCredential, {
              name: "CR",
              pageId: "page_1",
              imageHash: "hash_abc",
              linkUrl: "https://example.com",
              callToAction: "NOT_A_CTA"
            })
          ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
        }
      );
    });
  });

  describe("status transitions (activate / pause)", () => {
    it("activate POSTs status:ACTIVE to the entity NODE (not an act_ edge)", async () => {
      await captureWrites(
        () => jsonResponse({ success: true }),
        async (captured) => {
          const result = await setMetaEntityStatus(metaWriteCredential, "120000000000001", "ACTIVE");
          expect(result).toEqual({ ok: true, id: "120000000000001", status: "ACTIVE" });
          expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/120000000000001");
          expect(captured[0].method).toBe("POST");
          expect(captured[0].body).toEqual({ status: "ACTIVE" });
          expect(captured[0].authorization).toBe("Bearer meta-write-token");
        }
      );
    });

    it("pause POSTs status:PAUSED to the entity NODE", async () => {
      await captureWrites(
        () => jsonResponse({ success: true }),
        async (captured) => {
          const result = await setMetaEntityStatus(metaWriteCredential, "120000000000002", "PAUSED");
          expect(result).toEqual({ ok: true, id: "120000000000002", status: "PAUSED" });
          expect(captured[0].body).toEqual({ status: "PAUSED" });
        }
      );
    });
  });

  describe("budget update (scale / reduce / reallocate)", () => {
    it("POSTs daily_budget ONLY to the campaign NODE /{id} — never a status field, never an act_ edge", async () => {
      await captureWrites(
        () => jsonResponse({ success: true }),
        async (captured) => {
          const result = await updateMetaBudget(metaWriteCredential, "120000000000010", 5000, "campaign");
          expect(result).toEqual({ ok: true, id: "120000000000010", entity: "campaign" });
          // Node id, NOT an act_/<edge> path.
          expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/120000000000010");
          expect(captured[0].url).not.toContain("act_");
          expect(captured[0].method).toBe("POST");
          // MONEY-SAFETY: daily_budget only (form-encoded → string). A `status` field
          // here would let a budget change flip delivery — it must never be present.
          expect(captured[0].body).toEqual({ daily_budget: "5000" });
          expect(captured[0].body).not.toHaveProperty("status");
          expect(captured[0].contentType).toBe("application/x-www-form-urlencoded");
          // Token only in the Authorization header, never in the URL.
          expect(captured[0].authorization).toBe("Bearer meta-write-token");
          expect(captured[0].url).not.toContain("meta-write-token");
          expect(captured[0].url).not.toContain("access_token");
        }
      );
    });

    it("targets the ad-set NODE for entity=adset (campaign-budget-optimization off)", async () => {
      await captureWrites(
        () => jsonResponse({ success: true }),
        async (captured) => {
          const result = await updateMetaBudget(metaWriteCredential, "120000000000020", 2500, "adset");
          expect(result).toEqual({ ok: true, id: "120000000000020", entity: "adset" });
          expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/120000000000020");
          expect(captured[0].body).toEqual({ daily_budget: "2500" });
        }
      );
    });

    it("rejects entity=ad (Meta has no ad-level budget) BEFORE any POST — non-retryable", async () => {
      await withMockFetch(
        () => jsonResponse({ success: true }),
        async () => {
          // `ad` is a valid MetaWriteEntity but never a budget target.
          await expect(
            updateMetaBudget(metaWriteCredential, "120000000000030", 5000, "ad")
          ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
        }
      );
    });

    it("rejects a non-integer / zero / negative budget BEFORE any POST — non-retryable", async () => {
      for (const bad of [12.5, 0, -100]) {
        await withMockFetch(
          () => jsonResponse({ success: "should-not-happen" }),
          async () => {
            await expect(
              updateMetaBudget(metaWriteCredential, "120000000000010", bad, "campaign")
            ).rejects.toMatchObject({ retryable: false });
          }
        );
      }
    });

    // INVARIANT 3: a budget change is a money write — NON-retryable for ALL status
    // codes (must never inherit the read retryable:true taxonomy).
    for (const status of [500, 429, 503, 400] as const) {
      it(`marks a budget-update failure (${status}) as retryable:false`, async () => {
        await captureWrites(
          () => new Response("{\"error\":{\"message\":\"boom\"}}", { status }),
          async () => {
            await expect(
              updateMetaBudget(metaWriteCredential, "120000000000010", 5000, "campaign")
            ).rejects.toMatchObject({ retryable: false });
          }
        );
      });
    }

    // NOTE: budget updates on the meta_ads_cli transport now route through the bundled `meta` CLI
    // (updateMetaBudgetViaCli) instead of being refused provider_unsupported. That behavior is
    // exercised against the fake CLI in the "CLI WRITE transport" describe below (it needs the CLI
    // spawn harness, which this direct-Graph describe does not set up).
  });

  describe("delete (cleanup)", () => {
    it("issues DELETE to the entity NODE /{id} (not an act_ edge) with no body", async () => {
      await captureWrites(
        () => jsonResponse({ success: true }),
        async (captured) => {
          const result = await deleteMetaEntity(metaWriteCredential, "120000000000005");
          expect(result).toEqual({ ok: true, id: "120000000000005", deleted: true });
          expect(captured[0].method).toBe("DELETE");
          // Node id, NOT an act_/<edge> path.
          expect(captured[0].url).toBe("https://graph.facebook.com/v25.0/120000000000005");
          expect(captured[0].url).not.toContain("act_");
          // DELETE is bodyless.
          expect(captured[0].body).toBeNull();
          // Token only in the Authorization header, never in the URL.
          expect(captured[0].authorization).toBe("Bearer meta-write-token");
          expect(captured[0].url).not.toContain("access_token");
          expect(captured[0].url).not.toContain("meta-write-token");
        }
      );
    });

    it("returns {id, deleted:true} on Meta's {success:true}", async () => {
      await captureWrites(
        () => jsonResponse({ success: true }),
        async () => {
          const result = await deleteMetaEntity(metaWriteCredential, "abc123");
          expect(result).toEqual({ ok: true, id: "abc123", deleted: true });
        }
      );
    });

    // INVARIANT 3: a delete is a write — NON-retryable for ALL status codes,
    // including 429/5xx (must NOT inherit the read retryable:true taxonomy).
    for (const status of [500, 429, 503, 400] as const) {
      it(`marks a delete failure (${status}) as retryable:false`, async () => {
        await captureWrites(
          () => new Response("{\"error\":{\"message\":\"boom\"}}", { status }),
          async () => {
            await expect(deleteMetaEntity(metaWriteCredential, "120000000000005")).rejects.toMatchObject({
              retryable: false
            });
          }
        );
      });
    }

    it("marks a network failure on a delete as retryable:false", async () => {
      await withMockFetch(
        () => {
          throw new Error("ECONNRESET");
        },
        async () => {
          await expect(deleteMetaEntity(metaWriteCredential, "120000000000005")).rejects.toMatchObject({
            retryable: false,
            code: "provider_api_error"
          });
        }
      );
    });

    it("refuses a delete on the CLI transport when no entity hint is supplied (non-retryable)", async () => {
      await withMockFetch(
        () => jsonResponse({ success: true }),
        async () => {
          await expect(
            deleteMetaEntity({ ...metaWriteCredential, transport: "meta_ads_cli" }, "120000000000005")
          ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
        }
      );
    });
  });

  describe("writes are NON-retryable for ALL status codes", () => {
    for (const status of [500, 429, 503, 400] as const) {
      it(`marks a create failure (${status}) as retryable:false`, async () => {
        await captureWrites(
          () => new Response("{\"error\":{\"message\":\"boom\"}}", { status }),
          async () => {
            await expect(
              createMetaCampaign(metaWriteCredential, { name: "X", objective: "OUTCOME_TRAFFIC" })
            ).rejects.toMatchObject({ retryable: false });
          }
        );
      });

      it(`marks an activate failure (${status}) as retryable:false`, async () => {
        await captureWrites(
          () => new Response("{\"error\":{\"message\":\"boom\"}}", { status }),
          async () => {
            await expect(
              setMetaEntityStatus(metaWriteCredential, "120000000000001", "ACTIVE")
            ).rejects.toMatchObject({ retryable: false });
          }
        );
      });
    }

    it("marks a network failure on a write as retryable:false", async () => {
      await withMockFetch(
        () => {
          throw new Error("ECONNRESET");
        },
        async () => {
          await expect(
            createMetaCampaign(metaWriteCredential, { name: "X", objective: "OUTCOME_TRAFFIC" })
          ).rejects.toMatchObject({ retryable: false, code: "provider_api_error" });
        }
      );
    });
  });

  describe("reads (list/get) keep the normal retryable taxonomy", () => {
    it("lists campaigns via GET with default fields and the bearer header", async () => {
      await captureWrites(
        () => jsonResponse({ data: [{ id: "c1", name: "Launch", status: "PAUSED" }] }),
        async (captured) => {
          const rows = await listMetaEntities(metaWriteCredential, "campaign", { limit: 10 });
          expect(rows).toEqual([{ id: "c1", name: "Launch", status: "PAUSED" }]);
          expect(captured[0].method).toBe("GET");
          expect(captured[0].url).toContain("https://graph.facebook.com/v25.0/act_1234567890/campaigns");
          expect(captured[0].url).toContain("limit=10");
          expect(captured[0].url).toContain("fields=");
          expect(captured[0].authorization).toBe("Bearer meta-write-token");
          expect(captured[0].url).not.toContain("meta-write-token");
        }
      );
    });

    it("gets a single entity by node id with an explicit field set", async () => {
      await captureWrites(
        () => jsonResponse({ id: "c1", name: "Launch", status: "PAUSED" }),
        async (captured) => {
          const entity = await getMetaEntity(metaWriteCredential, "c1", { fields: "id,name,status" });
          expect(entity).toEqual({ id: "c1", name: "Launch", status: "PAUSED" });
          expect(captured[0].method).toBe("GET");
          expect(captured[0].url).toContain("https://graph.facebook.com/v25.0/c1");
          // The explicit override is honored verbatim.
          expect(captured[0].url).toContain("fields=id%2Cname%2Cstatus");
          expect(captured[0].authorization).toBe("Bearer meta-write-token");
          expect(captured[0].url).not.toContain("meta-write-token");
        }
      );
    });

    // FIX 1 (revert-proof): with no explicit `fields`, `get` must default the
    // SAME full per-type field set as `list` — never the id-only Graph default.
    // These assertions fail if `getMetaEntity` reverts to omitting `fields`.
    const getDefaultFieldCases: Array<{ entity: "campaign" | "adset" | "ad" | "creative"; expected: string[] }> = [
      { entity: "campaign", expected: ["id", "name", "status", "objective", "effective_status"] },
      {
        entity: "adset",
        expected: ["id", "name", "status", "campaign_id", "optimization_goal", "billing_event", "effective_status"]
      },
      { entity: "ad", expected: ["id", "name", "status", "adset_id", "effective_status"] },
      { entity: "creative", expected: ["id", "name", "object_story_spec"] }
    ];
    for (const { entity, expected } of getDefaultFieldCases) {
      it(`get on a ${entity} requests the FULL default field set (mirrors list)`, async () => {
        await captureWrites(
          () => jsonResponse({ id: "x1", name: "Thing" }),
          async (captured) => {
            await getMetaEntity(metaWriteCredential, "x1", { entity });
            expect(captured[0].method).toBe("GET");
            // The exact field string `list` would send for this entity must be
            // present on the get URL — a get that surfaces only `{id}` fails here.
            const decoded = decodeURIComponent(captured[0].url);
            expect(decoded).toContain(`fields=${expected.join(",")}`);
            for (const field of expected) {
              expect(decoded).toContain(field);
            }
            // The id-only regression: a bare `fields=id` (or no fields) is rejected.
            expect(decoded).not.toMatch(/[?&]fields=id(&|$)/);
            expect(captured[0].url).not.toContain("meta-write-token");
          }
        );
      });
    }

    it("get and list request the IDENTICAL field set for the same object type", async () => {
      let getUrl = "";
      let listUrl = "";
      await captureWrites(
        () => jsonResponse({ id: "a1" }),
        async (captured) => {
          await getMetaEntity(metaWriteCredential, "a1", { entity: "adset" });
          getUrl = captured[0].url;
        }
      );
      await captureWrites(
        () => jsonResponse({ data: [] }),
        async (captured) => {
          await listMetaEntities(metaWriteCredential, "adset");
          listUrl = captured[0].url;
        }
      );
      const getFields = new URL(getUrl).searchParams.get("fields");
      const listFields = new URL(listUrl).searchParams.get("fields");
      expect(getFields).toBe(listFields);
      expect(getFields).toBe("id,name,status,campaign_id,optimization_goal,billing_event,effective_status");
    });

    it("get keeps the normal retryable taxonomy (429 → retryable:true)", async () => {
      await captureWrites(
        () => new Response("{}", { status: 429 }),
        async () => {
          await expect(getMetaEntity(metaWriteCredential, "c1", { entity: "campaign" })).rejects.toMatchObject({
            retryable: true,
            code: "provider_rate_limited"
          });
        }
      );
    });

    it("surfaces a 429 on a READ as retryable:true (normal taxonomy)", async () => {
      await captureWrites(
        () => new Response("{}", { status: 429 }),
        async () => {
          await expect(listMetaEntities(metaWriteCredential, "campaign")).rejects.toMatchObject({
            retryable: true,
            code: "provider_rate_limited"
          });
        }
      );
    });
  });

  describe("MCP write transport is still refused (out of scope)", () => {
    it("refuses a write when transport is mcp_stdio (non-retryable)", async () => {
      await withMockFetch(
        () => jsonResponse({ id: "should-not-happen" }),
        async () => {
          await expect(
            createMetaCampaign(
              { ...metaWriteCredential, transport: "mcp_stdio" },
              { name: "X", objective: "OUTCOME_TRAFFIC" }
            )
          ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
        }
      );
    });
  });

  // ── CLI WRITE transport ── meta ads <entity> <action> … via the spawned `meta`
  // CLI. Mirrors the CLI insights tests: a fake node `meta` records its argv to a
  // file and emits the `--output json` body, so we assert the exact tokens AND that
  // the money-safety contract (PAUSED, never ACTIVE, non-retryable) is preserved.
  describe("CLI WRITE transport (meta ads <entity> …)", () => {
    // Build a fake `meta` CLI that writes its argv (JSON array) to argvOut and
    // prints `body` to stdout (optionally behind a human prefix line to exercise
    // the JSON-prefix stripping). Returns a cliCommand string for the credential.
    function fakeCliWriter(dir: string, body: unknown, opts: { prefix?: string; pretty?: boolean; emptyStdout?: boolean } = {}): string {
      const script = join(dir, "meta-cli-write.mjs");
      const prefixLine = opts.prefix ? `console.log(${JSON.stringify(opts.prefix)});` : "";
      // `pretty` emits json.dumps(indent=2)-style multi-line output — the shape real Python CLIs
      // produce, which the JSON extractor must still parse to the OUTER envelope.
      const serialized = opts.pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body);
      // emptyStdout models the REAL `meta` delete / budget-update / status writes: exit 0 with NO
      // stdout body at all. The parser must treat that as success, not "invalid JSON".
      const stdoutLine = opts.emptyStdout ? "" : `console.log(${JSON.stringify(serialized)});`;
      writeFileSync(
        script,
        `
import process from "node:process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(args));
writeFileSync(${JSON.stringify(join(dir, "env-token.json"))}, JSON.stringify(process.env.ACCESS_TOKEN ?? null));
writeFileSync(${JSON.stringify(join(dir, "cwd.json"))}, JSON.stringify(process.cwd()));
${prefixLine}
${stdoutLine}
        `.trim(),
        "utf8"
      );
      return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    }

    function cliCredential(dir: string, body: unknown, opts?: { prefix?: string; pretty?: boolean; emptyStdout?: boolean }): MetaAdsCredential {
      return {
        mode: "live",
        transport: "meta_ads_cli",
        adAccountId: "1234567890",
        accessToken: "cli-write-token",
        cliCommand: fakeCliWriter(dir, body, opts)
      };
    }

    function recordedArgv(dir: string): string[] {
      return JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    }

    function recordedCwd(dir: string): string {
      return JSON.parse(readFileSync(join(dir, "cwd.json"), "utf8")) as string;
    }

    // The ACCESS_TOKEN the fake CLI actually saw in its env (null when absent). This is the
    // POSITIVE injection assertion: with reads now routed off the CLI for token-carrying
    // credentials, the WRITE path is the only place callMetaAdsCliJson still hands the stored
    // credential token to the CLI — a regression there would otherwise ship green (the stderr
    // scrub tests only assert the token's ABSENCE from messages).
    function recordedEnvToken(dir: string): string | null {
      return JSON.parse(readFileSync(join(dir, "env-token.json"), "utf8")) as string | null;
    }

    function fakeCliWriterThatRecordsMedia(dir: string, body: unknown): string {
      const script = join(dir, "fake-meta-cli-media.mjs");
      const serialized = JSON.stringify(body);
      writeFileSync(
        script,
        `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(args));
const videoPath = args.includes("--video") ? args[args.indexOf("--video") + 1] : null;
const imagePath = args.includes("--image") ? args[args.indexOf("--image") + 1] : null;
const mediaPath = videoPath ?? imagePath;
writeFileSync(
  ${JSON.stringify(join(dir, "media-observation.json"))},
  JSON.stringify({
    mediaPath,
    existsAtSpawn: mediaPath ? existsSync(mediaPath) : false,
    contentsBase64: mediaPath && existsSync(mediaPath) ? readFileSync(mediaPath).toString("base64") : null
  })
);
console.log(${JSON.stringify(serialized)});
        `.trim(),
        "utf8"
      );
      return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    }

    function recordedMediaObservation(dir: string): {
      mediaPath: string | null;
      existsAtSpawn: boolean;
      contentsBase64: string | null;
    } {
      return JSON.parse(readFileSync(join(dir, "media-observation.json"), "utf8")) as {
        mediaPath: string | null;
        existsAtSpawn: boolean;
        contentsBase64: string | null;
      };
    }

    function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), "growth-os-meta-cli-write-"));
      return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
    }

    it("creates a campaign via `meta ads campaign create` with --status paused (NEVER active)", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaCampaign(
          cliCredential(dir, { id: "120000000000010", status: "PAUSED" }),
          { name: "CLI Camp", objective: "outcome_traffic", dailyBudget: 5000 }
        );
        expect(result).toEqual({ ok: true, id: "120000000000010", status: "PAUSED" });
        const argv = recordedArgv(dir);
        expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "campaign", "create"]);
        expect(argv).toContain("--name");
        expect(argv[argv.indexOf("--name") + 1]).toBe("CLI Camp");
        // Enum normalized to UPPERCASE before the CLI.
        expect(argv[argv.indexOf("--objective") + 1]).toBe("OUTCOME_TRAFFIC");
        // Budget passed as integer cents.
        expect(argv[argv.indexOf("--daily-budget") + 1]).toBe("5000");
        // MONEY-SAFETY: --status paused, NEVER active.
        expect(argv[argv.indexOf("--status") + 1]).toBe("paused");
        expect(argv).not.toContain("active");
        // POSITIVE injection assertion: the stored credential token reached the CLI as
        // ACCESS_TOKEN (writes rely on this; prod has no ambient ACCESS_TOKEN).
        expect(recordedEnvToken(dir)).toBe("cli-write-token");
      });
    });

    // ── Write-response PARSE regression (the shipped bug) ──────────────────────────────────────
    // The real `meta` CLI create prints the entity wrapped in a single-element ARRAY. The old
    // requireGraphId read `response.id` off that array → undefined → "did not include an id", and
    // the real (PAUSED) campaign was orphaned. It ALSO blinded the create-never-ACTIVE guard (an
    // ACTIVE echo inside the array was never seen). These pin the normalized extraction.
    it("parses the real `meta` CLI create envelope when stdout is a single-element ARRAY", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaCampaign(
          cliCredential(dir, [{ id: "120000000000013", status: "PAUSED" }]),
          { name: "Array Envelope", objective: "OUTCOME_TRAFFIC" }
        );
        expect(result).toEqual({ ok: true, id: "120000000000013", status: "PAUSED" });
      });
    });

    it("parses a create envelope that nests the entity under `data`", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaCampaign(
          cliCredential(dir, { data: { id: "120000000000014", status: "PAUSED" } }),
          { name: "Nested Envelope", objective: "OUTCOME_TRAFFIC" }
        );
        expect(result).toEqual({ ok: true, id: "120000000000014", status: "PAUSED" });
      });
    });

    it("MONEY-SAFETY: an ACTIVE echo inside the ARRAY envelope still trips the create-never-ACTIVE guard", async () => {
      await withTmp(async (dir) => {
        await expect(
          createMetaCampaign(
            cliCredential(dir, [{ id: "120000000000015", status: "ACTIVE" }]),
            { name: "Active Array", objective: "OUTCOME_TRAFFIC" }
          )
        ).rejects.toMatchObject({ code: "money_safety_violation", retryable: false });
      });
    });

    it("accepts the real `meta` CLI delete shape: exit 0 with EMPTY stdout (no JSON body)", async () => {
      await withTmp(async (dir) => {
        const result = await deleteMetaEntity(
          cliCredential(dir, null, { emptyStdout: true }),
          "120000000000060",
          "campaign"
        );
        expect(result).toEqual({ ok: true, id: "120000000000060", deleted: true });
      });
    });

    it("updates a campaign budget via `meta ads campaign update --daily-budget` (empty-stdout success, NEVER --status)", async () => {
      await withTmp(async (dir) => {
        const result = await updateMetaBudget(
          cliCredential(dir, null, { emptyStdout: true }),
          "120000000000010",
          7000,
          "campaign"
        );
        expect(result).toEqual({ ok: true, id: "120000000000010", entity: "campaign" });
        const argv = recordedArgv(dir);
        expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "campaign", "update"]);
        expect(argv[argv.indexOf("--daily-budget") + 1]).toBe("7000");
        // MONEY-SAFETY: a budget write NEVER carries --status, so it cannot flip delivery state.
        expect(argv).not.toContain("--status");
        // POSITIONAL hardening: entity id LAST, preceded by `--`.
        expect(argv.slice(-2)).toEqual(["--", "120000000000010"]);
      });
    });

    it("updates an ad-set budget via `meta ads adset update --daily-budget`", async () => {
      await withTmp(async (dir) => {
        const result = await updateMetaBudget(
          cliCredential(dir, null, { emptyStdout: true }),
          "120000000000020",
          3000,
          "adset"
        );
        expect(result).toEqual({ ok: true, id: "120000000000020", entity: "adset" });
        const argv = recordedArgv(dir);
        expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "adset", "update"]);
        expect(argv[argv.indexOf("--daily-budget") + 1]).toBe("3000");
      });
    });

    it("passes --no-color and --no-input as GLOBAL flags (before the `ads` group) so prompts can't hang and colour can't corrupt the JSON body", async () => {
      await withTmp(async (dir) => {
        await createMetaCampaign(
          cliCredential(dir, { id: "120000000000017", status: "PAUSED" }),
          { name: "Flags", objective: "OUTCOME_TRAFFIC" }
        );
        const argv = recordedArgv(dir);
        expect(argv).toContain("--no-color");
        expect(argv).toContain("--no-input");
        expect(argv.indexOf("--no-color")).toBeLessThan(argv.indexOf("ads"));
        expect(argv.indexOf("--no-input")).toBeLessThan(argv.indexOf("ads"));
      });
    });

    it("spawns the Meta CLI from a stable existing cwd (GROWTH_OS_HOME), not the daemon's inherited cwd", async () => {
      await withTmp(async (dir) => {
        const stableHome = join(dir, "growth-home");
        mkdirSync(stableHome, { recursive: true });
        const previous = process.env.GROWTH_OS_HOME;
        process.env.GROWTH_OS_HOME = stableHome;
        try {
          await createMetaCampaign(
            cliCredential(dir, { id: "120000000000018", status: "PAUSED" }),
            { name: "Stable CWD", objective: "OUTCOME_TRAFFIC" }
          );
          expect(realpathSync(recordedCwd(dir))).toBe(realpathSync(stableHome));
        } finally {
          if (previous === undefined) {
            delete process.env.GROWTH_OS_HOME;
          } else {
            process.env.GROWTH_OS_HOME = previous;
          }
        }
      });
    });

    it("strips a human prefix line before parsing the campaign id", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaCampaign(
          cliCredential(dir, { id: "120000000000011" }, { prefix: "Created campaign 120000000000011 (PAUSED)" }),
          { name: "Prefixed", objective: "OUTCOME_SALES" }
        );
        expect(result).toMatchObject({ ok: true, id: "120000000000011" });
      });
    });

    it("creates an ad set via `meta ads adset create <CAMPAIGN_ID>` with mapped flags", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaAdSet(cliCredential(dir, { id: "120000000000020", status: "PAUSED" }), {
          name: "CLI AdSet",
          campaignId: "120000000000010",
          optimizationGoal: "link_clicks",
          billingEvent: "impressions",
          dailyBudget: 3000,
          targetingCountries: ["US", "CA"],
          pixelId: "px_1"
        });
        expect(result).toMatchObject({ ok: true, id: "120000000000020", status: "PAUSED" });
        const argv = recordedArgv(dir);
        expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "adset", "create"]);
        // POSITIONAL hardening: the campaign id is the LAST token, preceded by `--`.
        expect(argv[argv.length - 1]).toBe("120000000000010");
        expect(argv[argv.length - 2]).toBe("--");
        expect(argv.indexOf("--")).toBe(argv.length - 2); // exactly one `--`, at the end
        expect(argv[argv.indexOf("--optimization-goal") + 1]).toBe("LINK_CLICKS");
        expect(argv[argv.indexOf("--billing-event") + 1]).toBe("IMPRESSIONS");
        expect(argv[argv.indexOf("--daily-budget") + 1]).toBe("3000");
        expect(argv[argv.indexOf("--targeting-countries") + 1]).toBe("US,CA");
        expect(argv[argv.indexOf("--pixel-id") + 1]).toBe("px_1");
        // pixel ⇒ default conversion event PURCHASE.
        expect(argv[argv.indexOf("--custom-event-type") + 1]).toBe("PURCHASE");
        expect(argv[argv.indexOf("--status") + 1]).toBe("paused");
      });
    });

    // review BLOCKER (full fix): the CLI's `creative create --image` takes a FILE path. The engine
    // downloads imageUrl to a temp file and passes it as --image. A hash-only input still fails loud.
    it("downloads imageUrl to a temp file and passes it as --image (creative create)", async () => {
      await withTmp(async (dir) => {
        const imageBytes = Buffer.from("fake-png-bytes");
        let fetchedUrl: string | undefined;
        let imagePathArg: string | undefined;
        let imageFileContents: Buffer | undefined;
        await withMockFetch(
          (url) => {
            fetchedUrl = url;
            return new Response(imageBytes, { status: 200 });
          },
          async () => {
            const result = await createMetaCreative(cliCredential(dir, { id: "120000000000050" }), {
              name: "CLI Creative!",
              pageId: "page_1",
              imageUrl: "https://cdn.example.com/banner.png",
              linkUrl: "https://example.com",
              body: "Buy now",
              title: "Headline",
              callToAction: "shop_now"
            });
            expect(result).toEqual({ ok: true, id: "120000000000050", status: null });
            const argv = recordedArgv(dir);
            expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "creative", "create"]);
            imagePathArg = argv[argv.indexOf("--image") + 1];
            // The --image arg is a real temp file path that existed at spawn time; capture its bytes.
            // (The builder deletes it in a finally, so read it INSIDE the fake CLI is not possible here —
            // instead assert the path shape + that the download happened.)
            expect(argv[argv.indexOf("--page-id") + 1]).toBe("page_1");
            expect(argv[argv.indexOf("--link-url") + 1]).toBe("https://example.com");
            expect(argv[argv.indexOf("--body") + 1]).toBe("Buy now");
            expect(argv[argv.indexOf("--title") + 1]).toBe("Headline");
            // CTA normalized to UPPERCASE before the CLI.
            expect(argv[argv.indexOf("--call-to-action") + 1]).toBe("SHOP_NOW");
          }
        );
        expect(fetchedUrl).toBe("https://cdn.example.com/banner.png");
        expect(imagePathArg).toBeDefined();
        // Path lives under the OS temp dir and is named from the slugged creative name.
        expect(imagePathArg).toContain(tmpdir());
        expect(imagePathArg).toContain("meta-creative-cli-creative-");
        // BLOCKER fix: the temp file MUST carry an allowed image extension (the CLI validates --image by
        // extension). Here it comes from the URL path (.png) since the mock Response has no Content-Type.
        expect(imagePathArg).toMatch(/\.png$/);
        // Temp file cleaned up in the finally.
        expect(existsSync(imagePathArg as string)).toBe(false);
        void imageFileContents;
      });
    });

    it("derives the temp-file extension from Content-Type, and defaults to .jpg when unknown", async () => {
      // Content-Type wins over the URL path: a webp content-type on an extensionless URL → .webp.
      await withTmp(async (dir) => {
        let imagePathArg: string | undefined;
        await withMockFetch(
          () => new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "image/webp" } }),
          async () => {
            await createMetaCreative(cliCredential(dir, { id: "120000000000051" }), {
              name: "Webp",
              pageId: "page_1",
              imageUrl: "https://cdn.example.com/asset?id=99" // no extension in the URL
            });
            imagePathArg = recordedArgv(dir)[recordedArgv(dir).indexOf("--image") + 1];
          }
        );
        expect(imagePathArg).toMatch(/\.webp$/);
      });

      // No Content-Type AND no URL extension → default .jpg (never extensionless, which the CLI rejects).
      await withTmp(async (dir) => {
        let imagePathArg: string | undefined;
        await withMockFetch(
          () => new Response(Buffer.from("x"), { status: 200 }),
          async () => {
            await createMetaCreative(cliCredential(dir, { id: "120000000000052" }), {
              name: "NoExt",
              pageId: "page_1",
              imageUrl: "https://cdn.example.com/asset"
            });
            imagePathArg = recordedArgv(dir)[recordedArgv(dir).indexOf("--image") + 1];
          }
        );
        expect(imagePathArg).toMatch(/\.jpg$/);
      });
    });

    it("downloads videoUrl to a temp file and passes it as --video (not DCO --videos)", async () => {
      await withTmp(async (dir) => {
        const videoBytes = Buffer.from("fake-mov-bytes");
        let fetchedUrl: string | undefined;
        let videoPathArg: string | undefined;
        const credential: MetaAdsCredential = {
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          accessToken: "cli-write-token",
          cliCommand: fakeCliWriterThatRecordsMedia(dir, { id: "120000000000053" })
        };
        await withMockFetch(
          (url) => {
            fetchedUrl = url;
            return new Response(videoBytes, { status: 200, headers: { "content-type": "video/quicktime" } });
          },
          async () => {
            const result = await createMetaCreative(credential, {
              name: "CLI Video Creative!",
              pageId: "page_1",
              videoUrl: "https://cdn.example.com/promo?id=99",
              linkUrl: "https://example.com",
              body: "Watch now",
              title: "Video Headline",
              callToAction: "learn_more"
            });
            expect(result).toEqual({ ok: true, id: "120000000000053", status: null });
            const argv = recordedArgv(dir);
            expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "creative", "create"]);
            expect(argv).toContain("--video");
            expect(argv).not.toContain("--videos");
            expect(argv).not.toContain("--image");
            videoPathArg = argv[argv.indexOf("--video") + 1];
            expect(argv[argv.indexOf("--page-id") + 1]).toBe("page_1");
            expect(argv[argv.indexOf("--link-url") + 1]).toBe("https://example.com");
            expect(argv[argv.indexOf("--body") + 1]).toBe("Watch now");
            expect(argv[argv.indexOf("--title") + 1]).toBe("Video Headline");
            expect(argv[argv.indexOf("--call-to-action") + 1]).toBe("LEARN_MORE");
          }
        );
        expect(fetchedUrl).toBe("https://cdn.example.com/promo?id=99");
        expect(videoPathArg).toBeDefined();
        expect(videoPathArg).toContain(tmpdir());
        expect(videoPathArg).toContain("meta-creative-cli-video-creative-");
        expect(videoPathArg).toMatch(/\.mov$/);
        const observation = recordedMediaObservation(dir);
        expect(observation.mediaPath).toBe(videoPathArg);
        expect(observation.existsAtSpawn).toBe(true);
        expect(observation.contentsBase64).toBe(videoBytes.toString("base64"));
        expect(existsSync(videoPathArg as string)).toBe(false);
      });
    });

    it("derives video temp-file extensions from URL paths when Content-Type is generic", async () => {
      await withTmp(async (dir) => {
        const credential: MetaAdsCredential = {
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          accessToken: "cli-write-token",
          cliCommand: fakeCliWriterThatRecordsMedia(dir, { id: "120000000000054" })
        };
        let videoPathArg: string | undefined;
        await withMockFetch(
          () => new Response(Buffer.from("mp4"), { status: 200, headers: { "content-type": "application/octet-stream" } }),
          async () => {
            await createMetaCreative(credential, {
              name: "MP4 Video",
              pageId: "page_1",
              videoUrl: "https://cdn.example.com/video.mp4?download=1"
            });
            const argv = recordedArgv(dir);
            videoPathArg = argv[argv.indexOf("--video") + 1];
          }
        );
        expect(videoPathArg).toMatch(/\.mp4$/);
      });
    });

    it("rejects CLI creative create when imageUrl and videoUrl are both supplied", async () => {
      await withTmp(async (dir) => {
        await withMockFetch(
          () => new Response(Buffer.from("should-not-download"), { status: 200 }),
          async () => {
            await expect(
              createMetaCreative(cliCredential(dir, { id: "should-not-happen" }), {
                name: "Ambiguous Creative",
                pageId: "page_1",
                imageUrl: "https://cdn.example.com/banner.png",
                videoUrl: "https://cdn.example.com/promo.mp4"
              })
            ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
          }
        );
        expect(existsSync(join(dir, "argv.json"))).toBe(false);
      });
    });

    it("REFUSES creative create on the CLI transport when only a hash is supplied (no imageUrl), non-retryable", async () => {
      await withTmp(async (dir) => {
        // The throw precedes the spawn, so the CLI is never invoked (no argv.json written).
        await expect(
          createMetaCreative(cliCredential(dir, { id: "should-not-happen" }), {
            name: "CLI Creative",
            pageId: "page_1",
            imageHash: "hash_abc",
            linkUrl: "https://example.com"
          })
        ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
      });
    });

    // Review HIGH (path-with-space): the desktop stores a BARE absolute path as cliCommand. The engine
    // must spawn it VERBATIM (not via parseProcessCommand, which splits on whitespace). Prove a path
    // CONTAINING A SPACE — common on personal Macs (/Users/John Smith/…) — spawns correctly.
    it("spawns a bare ABSOLUTE cliCommand with a SPACE in its path verbatim (not whitespace-split)", async () => {
      await withTmp(async (dir) => {
        const spaced = join(dir, "John Smith bin"); // a dir with spaces
        mkdirSync(spaced, { recursive: true });
        const exe = join(spaced, "meta"); // bare executable, no `node` prefix, no quotes
        writeFileSync(
          exe,
          `#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(
            join(dir, "argv.json"),
          )}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ id: "120000000000099", status: "PAUSED" }));\n`,
          "utf8",
        );
        chmodSync(exe, 0o755);
        const cred: MetaAdsCredential = {
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          accessToken: "cli-write-token",
          cliCommand: exe, // bare absolute path WITH a space
        };
        const result = await createMetaCampaign(cred, { name: "Spaced", objective: "OUTCOME_TRAFFIC" });
        expect(result).toEqual({ ok: true, id: "120000000000099", status: "PAUSED" });
        // The CLI actually ran (argv recorded) — proving the spaced path was NOT split.
        expect(recordedArgv(dir).slice(0, 5)).toEqual(["--no-color", "--no-input", "--output", "json", "ads"]);
      });
    });

    it("creates an ad via `meta ads ad create <ADSET_ID>` with --status paused", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaAd(cliCredential(dir, { id: "120000000000040", status: "PAUSED" }), {
          name: "CLI Ad",
          adsetId: "120000000000020",
          creativeId: "120000000000030"
        });
        expect(result).toMatchObject({ ok: true, id: "120000000000040", status: "PAUSED" });
        const argv = recordedArgv(dir);
        expect(argv.slice(0, 9)).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "ad", "create"]);
        // POSITIONAL hardening: the adset id is the LAST token, preceded by `--`.
        expect(argv[argv.length - 1]).toBe("120000000000020"); // positional adset id
        expect(argv[argv.length - 2]).toBe("--");
        expect(argv[argv.indexOf("--creative-id") + 1]).toBe("120000000000030");
        expect(argv[argv.indexOf("--status") + 1]).toBe("paused");
        expect(argv).not.toContain("active");
      });
    });

    it("MONEY-SAFETY: a CLI create that echoes ACTIVE throws money_safety_violation (non-retryable)", async () => {
      await withTmp(async (dir) => {
        await expect(
          createMetaCampaign(cliCredential(dir, { id: "120000000000099", status: "ACTIVE" }), {
            name: "Rogue",
            objective: "OUTCOME_TRAFFIC"
          })
        ).rejects.toMatchObject({ code: "money_safety_violation", retryable: false });
      });
    });

    it("sets entity status via `meta ads <entity> update <ID> --status`", async () => {
      await withTmp(async (dir) => {
        const result = await setMetaEntityStatus(
          cliCredential(dir, { id: "120000000000010", status: "ACTIVE" }),
          "120000000000010",
          "ACTIVE",
          "campaign"
        );
        expect(result).toEqual({ ok: true, id: "120000000000010", status: "ACTIVE" });
        const argv = recordedArgv(dir);
        expect(argv).toEqual([
          "--no-color",
          "--no-input",
          "--output",
          "json",
          "ads",
          "--ad-account-id",
          "1234567890",
          "campaign",
          "update",
          "--status",
          "active",
          // POSITIONAL hardening: the entity id is LAST, preceded by `--`.
          "--",
          "120000000000010"
        ]);
      });
    });

    it("deletes an entity via `meta ads <entity> delete <ID> --force`", async () => {
      await withTmp(async (dir) => {
        const result = await deleteMetaEntity(
          cliCredential(dir, { success: true }),
          "120000000000040",
          "ad"
        );
        expect(result).toEqual({ ok: true, id: "120000000000040", deleted: true });
        const argv = recordedArgv(dir);
        // POSITIONAL hardening: --force first, then `--`, then the entity id LAST.
        expect(argv).toEqual(["--no-color", "--no-input", "--output", "json", "ads", "--ad-account-id", "1234567890", "ad", "delete", "--force", "--", "120000000000040"]);
      });
    });

    it("normalizes a transient CLI write failure to NON-retryable (INVARIANT 3)", async () => {
      await withTmp(async (dir) => {
        // A fake CLI that exits non-zero — callMetaAdsCliJson would mark this
        // retryable:true on the read path; the write wrapper re-stamps it false.
        const script = join(dir, "meta-cli-fail.mjs");
        writeFileSync(script, `process.exit(1);`, "utf8");
        const credential: MetaAdsCredential = {
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
        };
        await expect(
          createMetaCampaign(credential, { name: "X", objective: "OUTCOME_TRAFFIC" })
        ).rejects.toMatchObject({ retryable: false });
      });
    });

    // ── ENUM per-transport validation (review HIGH) ── a Graph-valid enum that is NOT
    // in the CLI's narrower Click choice set must throw a clear non-retryable error
    // BEFORE the CLI is spawned (no argv.json written).
    it("rejects a Graph-valid objective that the CLI choice set does NOT accept (before spawn)", async () => {
      await withTmp(async (dir) => {
        // OUTCOME_TRAFFIC is fine; there is no objective valid on Graph but not on the CLI
        // in this set — so prove the gate fires for an optimization goal instead below, and
        // confirm a CLI-only-invalid goal short-circuits.
        await expect(
          createMetaAdSet(cliCredential(dir, { id: "should-not-happen" }), {
            name: "Set",
            campaignId: "120000000000010",
            // AD_RECALL_LIFT is Graph-valid (in META_OPTIMIZATION_GOAL_VALUES) but NOT a CLI choice.
            optimizationGoal: "AD_RECALL_LIFT",
            billingEvent: "IMPRESSIONS"
          })
        ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
        // The throw precedes the spawn — the CLI never ran.
        expect(existsSync(join(dir, "argv.json"))).toBe(false);
      });
    });

    it("rejects a Graph-valid billing event (PURCHASE) not in the CLI choice set (before spawn)", async () => {
      await withTmp(async (dir) => {
        await expect(
          createMetaAdSet(cliCredential(dir, { id: "should-not-happen" }), {
            name: "Set",
            campaignId: "120000000000010",
            optimizationGoal: "LINK_CLICKS",
            // PURCHASE is in META_BILLING_EVENT_VALUES but is NOT a CLI billing-event choice.
            billingEvent: "PURCHASE"
          })
        ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
        expect(existsSync(join(dir, "argv.json"))).toBe(false);
      });
    });

    it("rejects a Graph-valid CTA (GET_DIRECTIONS) not in the CLI choice set (before spawn)", async () => {
      await withTmp(async (dir) => {
        await withMockFetch(
          () => new Response(Buffer.from("img"), { status: 200 }),
          async () => {
            await expect(
              createMetaCreative(cliCredential(dir, { id: "should-not-happen" }), {
                name: "Creative",
                pageId: "page_1",
                imageUrl: "https://cdn.example.com/x.png",
                // GET_DIRECTIONS is in META_CALL_TO_ACTION_VALUES but is NOT a CLI CTA choice.
                callToAction: "GET_DIRECTIONS"
              })
            ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
          }
        );
        expect(existsSync(join(dir, "argv.json"))).toBe(false);
      });
    });

    it("accepts a CLI-supported enum on the CLI transport (regression: gate is not over-eager)", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaAdSet(cliCredential(dir, { id: "120000000000060", status: "PAUSED" }), {
          name: "Set",
          campaignId: "120000000000010",
          optimizationGoal: "offsite_conversions", // in both Graph + CLI sets
          billingEvent: "impressions"
        });
        expect(result).toMatchObject({ ok: true, id: "120000000000060" });
      });
    });

    // ── stripJsonPrefix hardening (review) ── a multi-line "Created … {id} \n [{…}]"
    // style output must still parse to the trailing JSON body.
    it("parses the trailing JSON body past a human prefix line that itself contains a brace", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaCampaign(
          cliCredential(
            dir,
            { id: "120000000000070", status: "PAUSED" },
            // Prefix line contains a brace — the naive first-`{` slice would break on this.
            { prefix: "Created campaign 'Summer {Sale} 2026' 120000000000070" }
          ),
          { name: "Braced", objective: "OUTCOME_SALES" }
        );
        expect(result).toMatchObject({ ok: true, id: "120000000000070" });
      });
    });

    // ── Pretty-printed / nested JSON (regression) ── a CLI that emits multi-line json.dumps(indent=2)
    // output must parse to the OUTER envelope, not the innermost
    // nested object. The JSON extractor walks start indices and previously overwrote its match with
    // every later valid block, so for nested pretty JSON the last-STARTING valid block — the deepest
    // object — won. That dropped the `{id,…}` envelope → callers saw an object with no `id`/`ok`
    // → "unrecognized JSON shape" and EVERY connection test failed regardless of auth.
    it("parses the OUTER envelope from pretty-printed multi-line JSON with a nested object (regression)", async () => {
      await withTmp(async (dir) => {
        const result = await createMetaCampaign(
          cliCredential(
            dir,
            // Nested body: the innermost `{ "country": "US" }` is the last-starting valid JSON block.
            { id: "120000000000099", status: "PAUSED", audience: { geo: { country: "US" } } },
            { pretty: true }
          ),
          { name: "Nested", objective: "OUTCOME_SALES" }
        );
        // Without the `start = i` fix the extractor returns `{ "country": "US" }` (no id) and this fails.
        expect(result).toMatchObject({ ok: true, id: "120000000000099" });
      });
    });

    // ── Token-stderr scrub (review, defense-in-depth) ── a non-zero exit whose stderr
    // echoes the EAA…-shaped token must NOT leak the token into the error message.
    it("scrubs an EAA-shaped token from CLI stderr in the error message", async () => {
      await withTmp(async (dir) => {
        const script = join(dir, "meta-cli-leak.mjs");
        // Emit a token-shaped string + the actual ACCESS_TOKEN on stderr, then exit non-zero.
        writeFileSync(
          script,
          `process.stderr.write("auth failed for EAAabc123DEF456 token=" + (process.env.ACCESS_TOKEN || ""));\nprocess.exit(1);`,
          "utf8"
        );
        const credential: MetaAdsCredential = {
          mode: "live",
          transport: "meta_ads_cli",
          adAccountId: "1234567890",
          accessToken: "EAAsecretLiveToken999",
          cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
        };
        await expect(
          createMetaCampaign(credential, { name: "X", objective: "OUTCOME_TRAFFIC" })
        ).rejects.toMatchObject({
          retryable: false,
          message: expect.not.stringContaining("EAAabc123DEF456")
        });
        await createMetaCampaign(credential, { name: "X", objective: "OUTCOME_TRAFFIC" }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).not.toContain("EAAabc123DEF456");
          expect(message).not.toContain("EAAsecretLiveToken999");
          expect(message).toContain("[REDACTED]");
        });
      });
    });

    // ── Ambient-token stderr scrub (review fix) ── in "ambient auth" mode the credential carries
    // NO accessToken and the CLI uses the INHERITED process.env.ACCESS_TOKEN. That token is NOT
    // EAA-prefixed here, so the regex fallback cannot catch it — only scrubbing the value the CLI
    // actually uses keeps it out of the error message (and out of sync_errors.error_message).
    it("scrubs the INHERITED process.env.ACCESS_TOKEN (ambient mode, non-EAA token) from CLI stderr", async () => {
      const prior = process.env.ACCESS_TOKEN;
      process.env.ACCESS_TOKEN = "sysuser-PLAINTEXT-secret-2f8b9";
      try {
        await withTmp(async (dir) => {
          const script = join(dir, "meta-cli-ambient-leak.mjs");
          // Echo the inherited (non-EAA) token on stderr, then exit non-zero.
          writeFileSync(
            script,
            `process.stderr.write("cli error: token=" + (process.env.ACCESS_TOKEN || ""));\nprocess.exit(1);`,
            "utf8"
          );
          // No accessToken on the credential → metaAdsCliAccessToken returns undefined → ambient mode.
          const credential: MetaAdsCredential = {
            mode: "live",
            transport: "meta_ads_cli",
            adAccountId: "1234567890",
            cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
          };
          await createMetaCampaign(credential, { name: "X", objective: "OUTCOME_TRAFFIC" }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).not.toContain("sysuser-PLAINTEXT-secret-2f8b9");
            expect(message).toContain("[REDACTED]");
            expect((error as { retryable?: boolean }).retryable).toBe(false);
          });
        });
      } finally {
        if (prior === undefined) {
          delete process.env.ACCESS_TOKEN;
        } else {
          process.env.ACCESS_TOKEN = prior;
        }
      }
    });
  });

  describe("dedup helper", () => {
    it("derives a stable composite key", () => {
      expect(metaDedupKey("ws_1", "src_1", "tok_1")).toBe("ws_1::src_1::tok_1");
    });

    it("returns the existing entity id when the client token already exists", () => {
      const existing: MetaDedupRecord[] = [
        { clientToken: "tok_a", entityId: "c_a" },
        { clientToken: "tok_b", entityId: "c_b" }
      ];
      expect(findMetaDedupHit(existing, "tok_b")).toBe("c_b");
    });

    it("returns undefined for an unseen token or when no token is supplied", () => {
      const existing: MetaDedupRecord[] = [{ clientToken: "tok_a", entityId: "c_a" }];
      expect(findMetaDedupHit(existing, "tok_z")).toBeUndefined();
      expect(findMetaDedupHit(existing, undefined)).toBeUndefined();
    });
  });

  it("requires an image_hash for a STANDARD creative (upload happens first)", async () => {
    await withMockFetch(
      () => jsonResponse({ id: "should-not-happen" }),
      async () => {
        await expect(
          createMetaCreative(metaWriteCredential, { name: "NoImage", pageId: "page_1" })
        ).rejects.toMatchObject({ code: "provider_api_error", retryable: false });
      }
    );
  });

  it("rejects non-integer / negative budgets before POSTing", async () => {
    await withMockFetch(
      () => jsonResponse({ id: "should-not-happen" }),
      async () => {
        await expect(
          createMetaCampaign(metaWriteCredential, {
            name: "BadBudget",
            objective: "OUTCOME_TRAFFIC",
            dailyBudget: 12.5
          })
        ).rejects.toMatchObject({ retryable: false });
      }
    );
  });
});

describe("resolveMetaAdsCredential (operator write credential resolver)", () => {
  it("reuses the oauth_tokens bridge and merges the live token over stored metadata", async () => {
    const credential = await resolveMetaAdsCredential(
      oauthFakeDb({
        // Only non-secret metadata lives in connection_credentials; the live
        // system-user token is followed through the oauth_tokens FK — exactly
        // the bridge the read/sync path uses.
        credential: {
          credential_kind: "oauth_access_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "marketing_api",
            adAccountId: "act_555",
            apiVersion: "v25.0"
          }),
          oauth_token_id: "meta_token_live"
        },
        oauthTokens: {
          meta_token_live: {
            encrypted_payload: encryptedCredential({
              accessToken: "live-meta-write-token",
              refreshToken: "meta-refresh",
              expiresAt: new Date(Date.now() + 3600_000).toISOString()
            }),
            expires_at: new Date(Date.now() + 3600_000).toISOString()
          }
        }
      }),
      { workspaceId: "workspace", sourceId: "src_meta" }
    );

    expect(credential).toMatchObject({
      adAccountId: "act_555",
      apiVersion: "v25.0",
      accessToken: "live-meta-write-token"
    });
  });

  it("reads encrypted_payload directly when there is no linked oauth token", async () => {
    const credential = await resolveMetaAdsCredential(
      oauthFakeDb({
        credential: {
          credential_kind: "system_user_token",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "marketing_api",
            adAccountId: "act_777",
            accessToken: "inline-meta-token"
          }),
          oauth_token_id: null
        },
        oauthTokens: {}
      }),
      { workspaceId: "workspace", sourceId: "src_meta" }
    );

    expect(credential.accessToken).toBe("inline-meta-token");
    expect(credential.adAccountId).toBe("act_777");
  });
});

function request(provider: "google_analytics_4" | "posthog" | "stripe" | "x" | "shopify" | "meta_ads") {
  return {
    workspaceId: "workspace",
    sourceId: `source_${provider}`,
    provider,
    syncRunId: `sync_${provider}`
  };
}

function encryptedCredential(payload: Record<string, unknown>): string {
  process.env.GROWTH_OS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  return encryptCredentialPayload(payload, TEST_ENCRYPTION_KEY);
}

// Encrypt under an EXPLICIT key without touching process.env — used to prove the
// SyncRequest.encryptionKey override wins over (and is independent of) the env default.
function encryptedCredentialWith(payload: Record<string, unknown>, key: string): string {
  return encryptCredentialPayload(payload, key);
}

function fakeDb(options: {
  credential: { credential_kind: string; encrypted_payload: string };
  cursorValue?: string;
  stripeInvoiceState?: Record<string, unknown>;
  stripeTrialState?: Record<string, unknown>;
  queries?: string[];
  // Optional params-aware log (mirrors oauthFakeDb.queryLog) for tests that assert on the
  // bound values, e.g. the campaign-dimension currency/objective upsert.
  queryLog?: Array<{ sql: string; params?: unknown[] }>;
  failOnSqlIncludes?: string;
  // Value the consecutive_sync_failures increment RETURNING yields — simulates how many
  // COUNTED failures (including this one) have now accrued. Defaults to 1 (first counted
  // failure of an episode).
  consecutiveSyncFailures?: number;
  // Simulates the 0045 time gate BLOCKING the increment (a burst duplicate within
  // TRANSIENT_FAILURE_STREAK_MIN_SPACING_MS of the last counted failure): the gated UPDATE
  // matches no row, so its RETURNING yields null.
  failureStreakGateBlocked?: boolean;
  sourceProvider?: string;
  sourceStatus?: string;
}): InfiniteOsDb {
  let currentSourceStatus = options.sourceStatus ?? "connected";
  const record = (sql: string, params?: unknown[]) => {
    options.queries?.push(sql);
    options.queryLog?.push({ sql, params });
  };
  return {
    async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
      record(sql, params);
      if (sql.includes("connection_credentials")) {
        return options.credential as T;
      }
      if (sql.includes("sync_cursors") && options.cursorValue) {
        return { cursor_value: options.cursorValue } as T;
      }
      if (sql.includes("from stripe_invoice_sync_state")) {
        return (options.stripeInvoiceState ?? null) as T | null;
      }
      if (sql.includes("from stripe_trial_history_coverage")) {
        return (options.stripeTrialState ?? null) as T | null;
      }
      if (sql.includes("consecutive_sync_failures")) {
        if (options.failureStreakGateBlocked) {
          return null;
        }
        return { consecutive_sync_failures: options.consecutiveSyncFailures ?? 1 } as T;
      }
      return null;
    },
    query: (async (sql: string, params?: unknown[]) => {
      record(sql, params);
      if (options.failOnSqlIncludes && sql.includes(options.failOnSqlIncludes)) {
        throw new Error("forced fake DB write failure");
      }
      if (sql.includes("select provider, status") && sql.includes("for update")) {
        const sourceId = String(params?.[0] ?? "");
        return [{
          provider: options.sourceProvider
            ?? (sourceId.startsWith("source_") ? sourceId.slice("source_".length) : "posthog"),
          status: currentSourceStatus
        }];
      }
      if (sql.includes("select id from sync_runs")) {
        return [{ id: String(params?.[0] ?? "sync_run") }];
      }
      if (sql.includes("update sync_runs") && sql.includes("returning id")) {
        return [{ id: String(params?.[0] ?? "sync_run") }];
      }
      if (sql.includes("insert into stripe_trial_history_segments") && sql.includes("returning id")) {
        return [{ id: String(params?.[0] ?? "stripe_trial_segment") }];
      }
      if (sql.includes("update sources set status = 'connected'") && sql.includes("status = 'syncing'")) {
        currentSourceStatus = "connected";
      }
      if (sql.includes("select id from sources") && sql.includes("for update")) {
        return [{ id: String(params?.[0] ?? "src_1") }];
      }
      return [];
    }) as InfiniteOsDb["query"],
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return {};
    },
    async updateSourceStatus(_sourceId, status) {
      currentSourceStatus = status;
    },
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

function oauthFakeDb(options: {
  credential: { credential_kind: string; encrypted_payload: string; oauth_token_id: string | null };
  oauthTokens: Record<string, { encrypted_payload: string; expires_at: string | null }>;
  oauthApp?: { encrypted_payload: string };
  queries?: string[];
  queryLog?: Array<{ sql: string; params?: unknown[] }>;
}): InfiniteOsDb {
  const record = (sql: string, params?: unknown[]) => {
    options.queries?.push(sql);
    options.queryLog?.push({ sql, params });
  };
  return {
    async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
      record(sql, params);
      if (sql.includes("connection_credentials")) {
        return options.credential as T;
      }
      if (sql.includes("from oauth_tokens")) {
        const tokenId = String(params?.[0] ?? "");
        return (options.oauthTokens[tokenId] ?? null) as T | null;
      }
      if (sql.includes("from oauth_apps")) {
        return (options.oauthApp ?? null) as T | null;
      }
      return null;
    },
    async query(sql: string, params?: unknown[]) {
      record(sql, params);
      return [];
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return {};
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

async function withMockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

// Phase-2 slice-1a/1b — the Meta direct-Graph extract now issues, per run: the /ads +
// /adsets + /campaigns status EDGE reads (§4a), the campaign /insights pass, AND internal
// adset + ad /insights passes (§4c). This router lets a CAMPAIGN-GRAIN test supply ONLY the
// campaign insights body: the edge reads + the adset AND ad insights passes return empty, so
// the grain fan-out doesn't pollute campaign-grain assertions or record counts.
function metaGraphMockRouter(insightsBody: { data: unknown[]; paging?: unknown }) {
  return async (url: string): Promise<Response> => {
    if (url.includes("/adsets") || url.includes("/campaigns") || isMetaAdsEdgeRequest(url)) {
      return jsonResponse({ data: [], paging: {} });
    }
    if (isMetaAdsetInsightsRequest(url) || isMetaAdInsightsRequest(url)) {
      return jsonResponse({ data: [], paging: {} });
    }
    return jsonResponse({ data: insightsBody.data, paging: insightsBody.paging ?? {} });
  };
}

// Is this a Meta /insights request at level=adset? (the internal adset pass.)
function isMetaAdsetInsightsRequest(url: string): boolean {
  return url.includes("/insights") && new URL(url).searchParams.get("level") === "adset";
}

// Phase-2 slice-1b — is this a Meta /insights request at level=ad? (the ad pass.)
function isMetaAdInsightsRequest(url: string): boolean {
  return url.includes("/insights") && new URL(url).searchParams.get("level") === "ad";
}

// Is this the /act_<id>/ads EDGE read (NOT /adsets, NOT /insights)? The path segment after
// the account id is exactly "ads" — match on the pathname's final segment, not a substring,
// so /adsets (which also contains "/ads") is excluded.
function isMetaAdsEdgeRequest(url: string): boolean {
  if (url.includes("/insights")) return false;
  const segments = new URL(url).pathname.split("/");
  return segments[segments.length - 1] === "ads";
}

// Is this a Meta /insights request at level=campaign? (the campaign pass / probe.)
function isMetaCampaignInsightsRequest(url: string): boolean {
  return url.includes("/insights") && new URL(url).searchParams.get("level") === "campaign";
}

function headerValue(headers: RequestInit["headers"], key: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(key);
  return (headers as Record<string, string>)[key] ?? null;
}

interface Ga4ReportBody {
  dimensions: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  limit?: string;
}

function ga4DimNames(body: Ga4ReportBody | null): string[] {
  return (body?.dimensions ?? []).map((entry) => entry.name);
}

function isGa4PageReportBody(body: Ga4ReportBody | null): boolean {
  return ga4DimNames(body).includes("pagePath");
}

function isGa4OverviewReportBody(body: Ga4ReportBody | null): boolean {
  const dims = ga4DimNames(body);
  return dims.includes("landingPagePlusQueryString") && dims.includes("sessionDefaultChannelGroup");
}

function isGa4EventReportBody(body: Ga4ReportBody | null): boolean {
  return ga4DimNames(body).includes("eventName");
}

function ga4OverviewReportRowFixture(overrides?: { keyEvents?: string }) {
  return {
    dimensionValues: [
      { value: "20260601" },
      { value: "United Kingdom" },
      { value: "/" },
      { value: "google" },
      { value: "organic" },
      { value: "brand" },
      { value: "Organic Search" },
      { value: "rtk.dev" },
      { value: "desktop" }
    ],
    metricValues: [
      { value: "10" },
      { value: "8" },
      { value: "12" },
      { value: "7" },
      { value: "30" },
      { value: "6" },
      { value: "0.75" },
      { value: "95.5" },
      { value: overrides?.keyEvents ?? "3" }
    ]
  };
}

function ga4EventReportRowFixture(overrides?: { keyEvents?: string }) {
  return {
    dimensionValues: [
      { value: "20260601" },
      { value: "rtk.dev" },
      { value: "download_click" }
    ],
    metricValues: [
      { value: "21" },
      { value: overrides?.keyEvents ?? "5" }
    ]
  };
}

function ga4PageReportRowFixture(overrides?: { keyEvents?: string }) {
  return {
    dimensionValues: [
      { value: "20260601" },
      { value: "rtk.dev" },
      { value: "/pricing" },
      { value: "Pricing" }
    ],
    metricValues: [
      { value: "42" },
      { value: "18" },
      { value: "14" },
      { value: "73.5" },
      { value: overrides?.keyEvents ?? "6" }
    ]
  };
}

function stripeInvoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customer: { id: "cus_1", email: "founder@example.com", name: "Founder" },
    parent: {
      subscription_details: {
        subscription: { id: "sub_1", current_period_end: 1780000000 }
      }
    },
    // Every real Stripe invoice carries a status; the extractor now refuses to invent one.
    status: "paid",
    currency: "usd",
    amount_paid: 4900,
    amount_due: 0,
    created: 1760000000,
    status_transitions: { paid_at: 1760000100 },
    metadata: { external_order_id: "order_1" },
    ...overrides
  };
}

function stripeInvoicePaidEvent(id: string, invoiceId: string, created: number) {
  return {
    id,
    type: "invoice.paid",
    created,
    data: { object: { id: invoiceId } },
  };
}

function stripeSubscriptionEvent(
  id: string,
  type: string,
  created: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    created,
    api_version: "2025-06-30.basil",
    livemode: true,
    data: { object: stripeSubscription("sub_event") },
    ...overrides,
  };
}

function stripeSubscription(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    livemode: true,
    customer: {
      id: "cus_1",
      email: "internal@example.test",
      name: "Internal",
      metadata: { infinite_metrics_classification: "internal_test" },
    },
    status: "active",
    current_period_start: 1760000000,
    current_period_end: 1762600000,
    created: 1759500000,
    trial_start: 1759500000,
    trial_end: 1781092800,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    discounts: [
      {
        id: "di_forever",
        start: 1783434551,
        end: null,
        source: {
          type: "coupon",
          coupon: {
            id: "coupon_forever",
            duration: "forever",
            amount_off: 1000,
            percent_off: null,
            currency: "usd",
          },
        },
      },
    ],
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          discounts: [
            {
              id: "di_item",
              start: 1783434551,
              end: null,
              source: { type: "coupon", coupon: "coupon_item" },
            },
          ],
          price: {
            id: "price_1",
            product: { id: "prod_1", name: "Infinite OS Pro" },
            currency: "usd",
            unit_amount: 4900,
            recurring: { interval: "month" }
          }
        }
      ]
    },
    ...overrides
  };
}

function stripeLine(id: string) {
  return {
    id,
    amount: 4900,
    description: "Infinite OS Pro",
    price: {
      id: "price_1",
      product: { id: "prod_1", name: "Infinite OS Pro" }
    },
    period: { start: 1760000000, end: 1762600000 }
  };
}

describe("listMetaAssets (asset discovery for the connect picker)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Route Graph requests to canned JSON by URL substring. Records the order of calls. */
  function stubGraph(routes: Array<{ match: string; body: unknown; status?: number }>) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        calls.push(u);
        const hit = routes.find((r) => u.includes(r.match));
        const status = hit?.status ?? 200;
        return {
          status,
          ok: status >= 200 && status < 300,
          json: async () => hit?.body ?? {},
          text: async () => JSON.stringify(hit?.body ?? {})
        } as Response;
      })
    );
    return calls;
  }

  it("SYSTEM-USER token: /me/adaccounts empty -> /me/businesses -> /{biz}/owned_ad_accounts -> pixels", async () => {
    const calls = stubGraph([
      { match: "/me/adaccounts", body: { data: [] } }, // system-user token sees no personal accounts
      { match: "/me/businesses", body: { data: [{ id: "biz_1", name: "Acme" }] } },
      { match: "/biz_1/owned_ad_accounts", body: { data: [{ id: "act_99", account_id: "99", name: "Acme Ads", currency: "USD" }] } },
      { match: "/act_99/adspixels", body: { data: [{ id: "px_1", name: "Acme Pixel" }] } }
    ]);

    const snap = await listMetaAssets("sys-user-token");

    expect(snap.tokenKind).toBe("system_user_token");
    expect(snap.adAccounts).toEqual([{ id: "act_99", account_id: "99", name: "Acme Ads", currency: "USD" }]);
    expect(snap.pixels).toEqual([{ id: "px_1", name: "Acme Pixel" }]);
    expect(snap.pixelsByAccount["act_99"]).toEqual([{ id: "px_1", name: "Acme Pixel" }]);
    // The system-user edge MUST be hit (not /me/adaccounts as the source of truth).
    expect(calls.some((u) => u.includes("/biz_1/owned_ad_accounts"))).toBe(true);
    // Bearer-token reads — the token must never leak into a URL.
    expect(calls.every((u) => !u.includes("sys-user-token"))).toBe(true);
  });

  it("OAuth-user token: resolves accounts directly via /me/adaccounts (no business fallback)", async () => {
    const calls = stubGraph([
      { match: "/me/adaccounts", body: { data: [{ id: "act_1", account_id: "1", name: "My Ads", currency: "USD" }] } },
      { match: "/act_1/adspixels", body: { data: [] } },
      { match: "/me/businesses", body: { data: [] } }
    ]);

    const snap = await listMetaAssets("oauth-user-token");

    expect(snap.tokenKind).toBe("user_token");
    expect(snap.adAccounts).toHaveLength(1);
    expect(calls.some((u) => u.includes("owned_ad_accounts"))).toBe(false); // no system-user fallback
  });

  it("rejects an empty token without hitting the wire", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(listMetaAssets("  ")).rejects.toMatchObject({ code: "provider_auth_failed" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an explicit businessId skips /me/businesses discovery", async () => {
    const calls = stubGraph([
      { match: "/me/adaccounts", body: { data: [] } },
      { match: "/biz_x/owned_ad_accounts", body: { data: [{ id: "act_x", account_id: "x", name: "X", currency: "USD" }] } },
      { match: "/act_x/adspixels", body: { data: [] } }
    ]);
    const snap = await listMetaAssets("sys-user-token", { businessId: "biz_x" });
    expect(snap.adAccounts).toHaveLength(1);
    expect(calls.some((u) => u.includes("/me/businesses"))).toBe(false);
  });

  it("an invalid token surfaces provider_auth_failed (validate-before-bind)", async () => {
    stubGraph([
      { match: "/me/adaccounts", body: { error: { message: "bad token" } }, status: 401 }, // swallowed -> business path
      { match: "/me/businesses", body: { error: { message: "bad token" } }, status: 401 } // throws
    ]);
    await expect(listMetaAssets("bogus")).rejects.toMatchObject({ code: "provider_auth_failed" });
  });
});
