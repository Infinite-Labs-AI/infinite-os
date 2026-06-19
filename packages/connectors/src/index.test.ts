import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encryptCredentialPayload } from "@infinite-os/core";
import { type InfiniteOsDb } from "@infinite-os/db";

import {
  connectorFor,
  connectorProviderForSetupProvider,
  createMetaAd,
  createMetaAdSet,
  createMetaCampaign,
  createMetaCreative,
  deleteMetaEntity,
  findMetaDedupHit,
  ga4ConnectSourceFromSetup,
  getMetaEntity,
  listMetaEntities,
  metaDedupKey,
  posthogConnectSourceFromSetup,
  resolveMetaAdsCredential,
  setMetaEntityStatus,
  xConnectSourceFromSetup,
  type MetaAdsCredential,
  type MetaDedupRecord
} from "./index.js";

const TEST_ENCRYPTION_KEY = "connector-test-encryption-key";

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
});

describe("live provider clients", () => {
  it("tests GA4 credentials and extracts overview + page runReport rows", async () => {
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
      // 5 metrics, includes pagePath). A shared single-shape mock mis-parses.
      if (isGa4PageReportBody(body)) {
        return jsonResponse({ rows: [ga4PageReportRowFixture()] });
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
      const rows = await connector.extract(db, request("google_analytics_4"), {
        cursorKey: "ga4_run_report",
        cursorStart: null,
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 7,
        mode: "live"
      });

      // requests[0] = testConnection, [1] = Report A (overview), [2] = Report C (page).
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
      expect(retried.length).toBe(2);
      for (const entry of retried) {
        expect(entry.body?.metrics.map((m) => m.name)).not.toContain("keyEvents");
      }

      const overviewRecord = rows.find((row) => row.objectType === "ga4_run_report");
      const pageRecord = rows.find((row) => row.objectType === "ga4_page_report");
      // The conversions value is mapped back into the keyEvents field positionally.
      expect((overviewRecord?.payload as { keyEvents: number }).keyEvents).toBe(9);
      expect((pageRecord?.payload as { keyEvents: number }).keyEvents).toBe(11);
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

  it("paginates Stripe invoices and preserves line-item references", async () => {
    const urls: string[] = [];
    await withMockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/v1/customers")) {
        return jsonResponse({ data: [], has_more: false });
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
        mode: "live"
      });

      expect(urls.some((url) => url.includes("starting_after=in_1"))).toBe(true);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        objectType: "stripe_invoice",
        payload: {
          invoiceId: "in_1",
          customerId: "cus_1",
          externalOrderId: "order_1",
          lines: [{ lineId: "il_1", productId: "prod_1", priceId: "price_1" }]
        }
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
        mode: "live"
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
        mode: "live"
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
        mode: "live"
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
        mode: "live"
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
          mode: "live"
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
              adAccountId: "887743100560299",
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
          mode: "live"
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
              adAccountId: "887743100560299",
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
          mode: "live"
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
    expect(externalIds).toContain("meta_ads:adset:act_887743100560299:220000000000201:2026-06-01");
    expect(externalIds).toContain("meta_ads:adset:act_887743100560299:220000000000202:2026-06-01");
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
              adAccountId: "887743100560299",
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
          mode: "live"
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
              adAccountId: "887743100560299",
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
          mode: "live"
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
                adAccountId: "887743100560299",
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
                adAccountId: "887743100560299",
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
                mode: "live"
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
            mode: "live"
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
              adAccountId: "887743100560299",
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
            mode: "live"
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
                adAccountId: "887743100560299",
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
            mode: "live"
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
    expect(externalIds).toContain("meta_ads:ad:act_887743100560299:330000000000301:2026-06-01");
    expect(externalIds).toContain("meta_ads:ad:act_887743100560299:330000000000302:2026-06-01");
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
                adAccountId: "887743100560299",
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
                adAccountId: "887743100560299",
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
                adAccountId: "887743100560299",
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
                adAccountId: "887743100560299",
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
        mode: "live"
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
      const rows = await connector.extract(db, request("meta_ads"), {
        cursorKey: "meta_ads_campaign_daily",
        cursorStart: "2026-06-01T00:00:00.000Z",
        cursorEnd: "2026-06-03T00:00:00.000Z",
        refreshWindowDays: 30,
        mode: "live"
      });

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

  it("injects ACCESS_TOKEN into the spawned meta CLI env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-os-meta-cli-token-"));
    const script = join(dir, "meta-cli.mjs");
    // The fake script asserts the token is present and never echoes it back.
    writeFileSync(
      script,
      `
import process from "node:process";
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
if (process.env.ACCESS_TOKEN !== "test-system-user-token") process.exit(9);
if (argValue("--date-preset") === "today") {
  console.log(JSON.stringify({ data: [] }));
  process.exit(0);
}
console.log(JSON.stringify({ data: [] }));
      `.trim(),
      "utf8"
    );
    const previousToken = process.env.ACCESS_TOKEN;
    delete process.env.ACCESS_TOKEN;
    try {
      const db = fakeDb({
        credential: {
          credential_kind: "ads_cli",
          encrypted_payload: encryptedCredential({
            mode: "live",
            transport: "meta_ads_cli",
            adAccountId: "1234567890",
            accessToken: "test-system-user-token",
            cliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
          })
        }
      });
      const connector = connectorFor("meta_ads");
      // Before the fix the child exits 9 → connector throws → this resolve fails.
      await expect(connector.testConnection(db, request("meta_ads"))).resolves.toMatchObject({
        ok: true,
        mode: "live",
        provider: "meta_ads"
      });
      // The token must never leak into a thrown error message.
      try {
        await connector.extract(db, request("meta_ads"), {
          cursorKey: "meta_ads_campaign_daily",
          cursorStart: "2026-06-01T00:00:00.000Z",
          cursorEnd: "2026-06-03T00:00:00.000Z",
          refreshWindowDays: 30,
          mode: "live"
        });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("test-system-user-token");
        throw error;
      }
    } finally {
      if (previousToken === undefined) {
        delete process.env.ACCESS_TOKEN;
      } else {
        process.env.ACCESS_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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

    it("refuses a delete when the transport is meta_ads_cli (non-retryable)", async () => {
      await withMockFetch(
        () => jsonResponse({ success: true }),
        async () => {
          await expect(
            deleteMetaEntity({ ...metaWriteCredential, transport: "meta_ads_cli" }, "120000000000005")
          ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
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

  describe("CLI/MCP write transports are refused (non-retryable)", () => {
    it("refuses a write when transport is meta_ads_cli", async () => {
      await withMockFetch(
        () => jsonResponse({ id: "should-not-happen" }),
        async () => {
          await expect(
            createMetaCampaign(
              { ...metaWriteCredential, transport: "meta_ads_cli" },
              { name: "X", objective: "OUTCOME_TRAFFIC" }
            )
          ).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });
        }
      );
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

function fakeDb(options: {
  credential: { credential_kind: string; encrypted_payload: string };
  cursorValue?: string;
  queries?: string[];
  // Optional params-aware log (mirrors oauthFakeDb.queryLog) for tests that assert on the
  // bound values, e.g. the campaign-dimension currency/objective upsert.
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
      if (sql.includes("sync_cursors") && options.cursorValue) {
        return { cursor_value: options.cursorValue } as T;
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
    subscription: { id: "sub_1", current_period_end: 1780000000 },
    currency: "usd",
    amount_paid: 4900,
    amount_due: 0,
    created: 1760000000,
    status_transitions: { paid_at: 1760000100 },
    metadata: { external_order_id: "order_1" },
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
