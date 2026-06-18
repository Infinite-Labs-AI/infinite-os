import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  decryptCredentialPayload,
  encryptCredentialPayload,
  isEncryptedCredentialPayload,
  refreshOAuthToken
} from "@infinite-os/core";
import { type FirstPhaseProvider, type InfiniteOsDb, assertFirstPhaseProvider } from "@infinite-os/db";

export interface SyncRequest {
  workspaceId: string;
  sourceId: string;
  provider: FirstPhaseProvider;
  syncRunId: string;
  mode?: string;
  refreshWindowDays?: number;
  backfillWindow?: string;
  // Phase 0 plumbing: optional Meta Ads insights grain overrides. Unset today (so the
  // connector falls back to campaign/daily — identical to prior behavior); a later phase
  // can set these to request adset/ad level or a different time_increment.
  metaAdsInsightsLevel?: string;
  metaAdsInsightsTimeIncrement?: string;
}

export interface SyncPlan {
  cursorKey: string;
  cursorStart: string | null;
  cursorEnd: string;
  refreshWindowDays: number;
  mode: "fixture" | "live";
  backfillWindow?: string;
}

export interface SyncResult {
  provider: FirstPhaseProvider;
  recordsExtracted: number;
  recordsLoaded: number;
  cursorKey: string;
  cursorValue: string;
}

export interface ExtractedRecord<T> {
  externalId: string;
  objectType: string;
  payloadVersion: string;
  sourceUpdatedAt?: string | null;
  payload: T;
}

export interface GrowthConnector {
  provider: FirstPhaseProvider;
  testConnection(db: InfiniteOsDb, request: SyncRequest): Promise<ConnectionTestResult>;
  planSync(db: InfiniteOsDb, request: SyncRequest): Promise<SyncPlan>;
  extract(db: InfiniteOsDb, request: SyncRequest, plan: SyncPlan): Promise<ExtractedRecord<unknown>[]>;
  sync(db: InfiniteOsDb, request: SyncRequest): Promise<SyncResult>;
}

export interface ConnectionTestResult {
  ok: boolean;
  mode: "fixture" | "live";
  provider: FirstPhaseProvider;
  accountExternalId?: string;
}

export type SetupProviderId = "ga4" | "posthog" | "x";

export const SETUP_PROVIDER_TO_CONNECTOR_PROVIDER = {
  ga4: "google_analytics_4",
  posthog: "posthog",
  x: "x"
} as const satisfies Record<SetupProviderId, FirstPhaseProvider>;

export interface SetupConnectSourceActionInput {
  provider: FirstPhaseProvider;
  connectionName: string;
  credentialKind: string;
  credentialPayload: Record<string, unknown>;
  accountExternalId?: string;
  // When set, the connect action links the source to this live oauth_tokens row and stores only
  // non-secret metadata in connection_credentials (the token is not copied).
  oauthTokenId?: string;
}

export interface Ga4SetupCredentialInput {
  propertyId: string;
  accessToken: string;
  apiBaseUrl?: string | null;
  refreshToken?: string;
  expiresAt?: string;
  refreshWindowDays?: number;
}

export interface PostHogSetupCredentialInput {
  projectId: string | number;
  apiHost?: string | null;
  personalApiKey?: string;
  accessToken?: string;
  refreshWindowDays?: number;
}

export interface XSetupCredentialInput {
  bearerToken: string;
  userId: string;
  username: string;
  apiBaseUrl?: string | null;
  refreshWindowDays?: number;
  maxPages?: number;
}

export function connectorProviderForSetupProvider(provider: SetupProviderId): FirstPhaseProvider {
  return SETUP_PROVIDER_TO_CONNECTOR_PROVIDER[provider];
}

export function ga4CredentialFromSetup(input: Ga4SetupCredentialInput): Record<string, unknown> {
  return compactCredential({
    mode: "live",
    propertyId: requireNonEmptyString(input.propertyId, "propertyId"),
    accessToken: requireNonEmptyString(input.accessToken, "accessToken"),
    apiBaseUrl: optionalNonEmptyString(input.apiBaseUrl),
    refreshToken: optionalNonEmptyString(input.refreshToken),
    expiresAt: optionalNonEmptyString(input.expiresAt),
    refreshWindowDays: input.refreshWindowDays
  });
}

export function ga4ConnectSourceFromSetup(
  input: Ga4SetupCredentialInput & { connectionName?: string; oauthTokenId?: string }
): SetupConnectSourceActionInput {
  const credentialPayload = ga4CredentialFromSetup(input);
  return {
    provider: connectorProviderForSetupProvider("ga4"),
    connectionName: input.connectionName ?? "Google Analytics 4",
    credentialKind: "oauth_access_token",
    accountExternalId: String(credentialPayload.propertyId),
    credentialPayload,
    oauthTokenId: optionalNonEmptyString(input.oauthTokenId)
  };
}

export function posthogCredentialFromSetup(
  input: PostHogSetupCredentialInput
): Record<string, unknown> {
  const personalApiKey = optionalNonEmptyString(input.personalApiKey);
  const accessToken = optionalNonEmptyString(input.accessToken);
  if (!personalApiKey && !accessToken) {
    throw new Error("PostHog setup requires either a personalApiKey or accessToken");
  }
  return compactCredential({
    mode: "live",
    projectId: input.projectId,
    apiHost: optionalNonEmptyString(input.apiHost),
    personalApiKey,
    accessToken,
    refreshWindowDays: input.refreshWindowDays
  });
}

export function posthogConnectSourceFromSetup(
  input: PostHogSetupCredentialInput & { connectionName?: string }
): SetupConnectSourceActionInput {
  const credentialPayload = posthogCredentialFromSetup(input);
  return {
    provider: connectorProviderForSetupProvider("posthog"),
    connectionName: input.connectionName ?? "PostHog",
    credentialKind: credentialPayload.accessToken ? "oauth_access_token" : "personal_api_key",
    accountExternalId: String(credentialPayload.projectId),
    credentialPayload
  };
}

export function xCredentialFromSetup(input: XSetupCredentialInput): Record<string, unknown> {
  return compactCredential({
    mode: "live",
    bearerToken: requireNonEmptyString(input.bearerToken, "bearerToken"),
    userId: requireNonEmptyString(input.userId, "userId"),
    username: requireNonEmptyString(input.username, "username").replace(/^@/, ""),
    apiBaseUrl: optionalNonEmptyString(input.apiBaseUrl),
    refreshWindowDays: input.refreshWindowDays,
    maxPages: input.maxPages
  });
}

export function xConnectSourceFromSetup(
  input: XSetupCredentialInput & { connectionName?: string }
): SetupConnectSourceActionInput {
  const credentialPayload = xCredentialFromSetup(input);
  return {
    provider: connectorProviderForSetupProvider("x"),
    connectionName: input.connectionName ?? "X",
    credentialKind: "bearer_token",
    accountExternalId: String(credentialPayload.userId),
    credentialPayload
  };
}

interface SourceCredential<T extends Record<string, unknown> = Record<string, unknown>> {
  kind: string;
  payload: T;
}

interface Ga4Credential {
  [key: string]: unknown;
  mode?: "fixture" | "live";
  propertyId?: string;
  accessToken?: string;
  apiBaseUrl?: string;
  refreshWindowDays?: number;
}

interface PostHogCredential {
  [key: string]: unknown;
  mode?: "fixture" | "live";
  projectId?: string | number;
  personalApiKey?: string;
  apiHost?: string;
  refreshWindowDays?: number;
}

interface StripeCredential {
  [key: string]: unknown;
  mode?: "fixture" | "live";
  secretKey?: string;
  apiBaseUrl?: string;
  refreshWindowDays?: number;
}

interface XCredential {
  [key: string]: unknown;
  mode?: "fixture" | "live";
  bearerToken?: string;
  userId?: string;
  username?: string;
  apiBaseUrl?: string;
  refreshWindowDays?: number;
  maxPages?: number;
}

interface ShopifyCredential {
  [key: string]: unknown;
  mode?: "fixture" | "live";
  storeDomain?: string;
  adminAccessToken?: string;
  apiVersion?: string;
  refreshWindowDays?: number;
}

export interface MetaAdsCredential {
  [key: string]: unknown;
  mode?: "fixture" | "live";
  transport?: "marketing_api" | "api" | "mcp_stdio" | "mcp" | "meta_ads_cli" | "cli";
  adAccountId?: string;
  accessToken?: string;
  apiVersion?: string;
  refreshWindowDays?: number;
  cliCommand?: string;
  mcpCommand?: string;
  mcpToolName?: string;
}

interface ShopifyOrderRow {
  kind: "order";
  externalId: string;
  orderId: string;
  orderName: string;
  customerId: string | null;
  customerEmail: string | null;
  currency: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  subtotalPriceAmount: number;
  totalTaxAmount: number;
  totalDiscountAmount: number;
  totalPriceAmount: number;
  occurredOn: string;
  createdAt: string;
  processedAt: string | null;
  lineItems: ShopifyLineItemRow[];
}

interface ShopifyLineItemRow {
  lineItemId: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  priceAmount: number;
  lineTotalAmount: number;
  vendor: string | null;
  productType: string | null;
  status: string | null;
}

interface ShopifyProductSnapshotRow {
  kind: "product";
  externalId: string;
  productId: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  createdAt: string;
  updatedAt: string;
}

type ShopifySyncRow = ShopifyOrderRow | ShopifyProductSnapshotRow;

// One persisted child conversion row (§2.3), produced per canonical result_type for a
// campaign-day. The writer fans these into meta_ads_campaign_conversions_daily.
interface MetaAdsConversionRow {
  resultType: string;
  results: number;
  // Purchase-type ONLY (§2.3 guard); null for lead and other non-purchase types.
  conversionValue: number | null;
  attributionSetting: string;
  isPrimary: boolean;
  // 'derived_from_canonical_mapping' | 'meta_results'
  resultsSource: string;
}

interface MetaAdsCampaignDailyRow {
  externalId: string;
  adAccountId: string;
  campaignId: string;
  campaignName: string | null;
  occurredOn: string;
  spend: number;
  clicks: number;
  // §2.2 additions.
  inlineLinkClicks: number;
  landingPageViews: number;
  impressions: number;
  reach: number;
  cpm: number | null;
  cpc: number | null;
  ctr: number | null;
  currency: string | null;
  attributionSetting: string;
  apiVersion: string;
  // Full actions[] + action_values[] (with per-window subvalues), persisted as jsonb.
  actionsRaw: unknown;
  // Coarse objective + adset optimization_goal (drive the §4b mapping).
  objective: string | null;
  optimizationGoal: string | null;
  // The typed child conversion rows derived for this campaign-day (§2.3).
  conversions: MetaAdsConversionRow[];
}

interface XProfileSnapshot {
  userId: string;
  username: string | null;
  capturedAt: string;
  publicMetrics: {
    followersCount: number;
    followingCount: number;
    tweetCount: number;
    listedCount: number;
    likeCount: number;
  };
}

interface Ga4Row {
  kind: "overview";
  externalId: string;
  reportingDate: string;
  country: string;
  landingPage: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  sessionDefaultChannelGroup: string;
  hostName: string;
  deviceCategory: string;
  sessions: number;
  activeUsers: number;
  totalUsers: number;
  newUsers: number;
  screenPageViews: number;
  engagedSessions: number;
  engagementRate: number; // 0..1
  averageSessionDuration: number; // seconds
  keyEvents: number;
}

interface Ga4PageRow {
  kind: "page";
  externalId: string;
  reportingDate: string;
  hostName: string;
  pagePath: string;
  pageTitle: string;
  screenPageViews: number;
  sessions: number;
  engagedSessions: number;
  averageSessionDuration: number; // seconds
  keyEvents: number;
}

// The GA4 connector is multi-objectType (Report A overview rows + Report C page
// rows). The tagged union carries an explicit `kind` discriminator so
// toExtractedRecord / writeGa4Truth can branch on it; fixtures route through
// toExtractedRecord too, so the tag classifies them.
type Ga4SyncRow = Ga4Row | Ga4PageRow;

interface PostHogEventRow {
  externalId: string;
  eventId: string;
  eventName: string;
  distinctId: string;
  personId: string;
  sessionId: string;
  email: string | null;
  occurredAt: string;
  landingPage: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  properties: Record<string, unknown>;
}

interface StripeInvoiceRow {
  externalId: string;
  invoiceId: string;
  customerId: string;
  customerEmail: string | null;
  customerName: string | null;
  subscriptionId: string | null;
  currency: string;
  amountPaid: number;
  amountDue: number;
  paidAt: string | null;
  createdAt: string;
  periodEnd: string | null;
  externalOrderId: string | null;
  lines: StripeInvoiceLineRow[];
}

interface StripeInvoiceLineRow {
  lineId: string;
  productId: string | null;
  productName: string | null;
  priceId: string | null;
  amountCents: number;
  periodStart: string | null;
  periodEnd: string | null;
}

interface XPostRow {
  externalId: string;
  postId: string;
  authorId: string;
  conversationId: string | null;
  postUrl: string;
  bodyText: string;
  publishedAt: string | null;
  capturedAt: string;
  publicMetrics: XPublicMetrics;
  profileSnapshot?: XProfileSnapshot;
}

interface XPublicMetrics {
  retweetCount: number;
  replyCount: number;
  likeCount: number;
  quoteCount: number;
  bookmarkCount: number;
  impressionCount: number;
}

export function connectorFor(provider: string): GrowthConnector {
  assertFirstPhaseProvider(provider);
  if (provider === "google_analytics_4") return ga4Connector;
  if (provider === "posthog") return posthogConnector;
  if (provider === "shopify") return shopifyConnector;
  if (provider === "meta_ads") return metaAdsConnector;
  if (provider === "x") return xConnector;
  return stripeConnector;
}

const ga4Connector = createConnector<Ga4Credential, Ga4SyncRow>({
  provider: "google_analytics_4",
  fixtureRows: () => GA4_ROWS,
  fixtureObjectType: "ga4_run_report",
  toExtractedRecord(row, plan) {
    return {
      externalId: row.externalId,
      objectType: row.kind === "page" ? "ga4_page_report" : "ga4_run_report",
      payloadVersion: plan.mode === "fixture" ? "fixture-v1" : "live-v1",
      sourceUpdatedAt: plan.mode === "fixture" ? null : plan.cursorEnd,
      payload: row
    };
  },
  async testLive(_db, _request, credential) {
    const propertyId = requireCredential(credential, "propertyId");
    const accessToken = requireCredential(credential, "accessToken");
    await fetchJson(`${ga4BaseUrl(credential)}/${ga4PropertyPath(propertyId)}:runReport`, {
      method: "POST",
      headers: bearerHeaders(accessToken),
      body: JSON.stringify({
        dateRanges: [{ startDate: "yesterday", endDate: "today" }],
        dimensions: [{ name: "date" }],
        metrics: [{ name: "activeUsers" }],
        limit: "1"
      })
    });
    return { ok: true, mode: "live", provider: "google_analytics_4", accountExternalId: propertyId };
  },
  async planLive(db, request, credential) {
    return defaultPlan(db, request, "ga4_run_report", credential.refreshWindowDays ?? 7, "live");
  },
  async extractLive(_db, _request, plan, credential) {
    const propertyId = requireCredential(credential, "propertyId");
    const accessToken = requireCredential(credential, "accessToken");
    const reportUrl = `${ga4BaseUrl(credential)}/${ga4PropertyPath(propertyId)}:runReport`;
    const dateRanges = [{ startDate: daysAgo(plan.refreshWindowDays), endDate: "today" }];

    // Report A — daily traffic overview.
    const overviewResponse = await runGa4ReportWithKeyEventsFallback(
      reportUrl,
      accessToken,
      {
        dateRanges,
        // GA4 Data API caps a single runReport at 9 dimensions. The storage unique key
        // (writeGa4Truth) is the 9-tuple below; pageReferrer is NOT part of that key, so it
        // is the one dropped to stay within the limit (referrer is stored as "(not set)").
        dimensions: [
          { name: "date" },
          { name: "country" },
          { name: "landingPagePlusQueryString" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
          { name: "sessionCampaignName" },
          { name: "sessionDefaultChannelGroup" },
          { name: "hostName" },
          { name: "deviceCategory" }
        ],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "totalUsers" },
          { name: "newUsers" },
          { name: "screenPageViews" },
          { name: "engagedSessions" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
          { name: "keyEvents" }
        ],
        limit: "10000"
      },
      8
    );
    const overviewRows = (overviewResponse.rows ?? []).map((row) => ga4OverviewRow(row));

    // Report C — page-level (top pages).
    const pageResponse = await runGa4ReportWithKeyEventsFallback(
      reportUrl,
      accessToken,
      {
        dateRanges,
        dimensions: [
          { name: "date" },
          { name: "hostName" },
          { name: "pagePath" },
          { name: "pageTitle" }
        ],
        metrics: [
          { name: "screenPageViews" },
          { name: "sessions" },
          { name: "engagedSessions" },
          { name: "averageSessionDuration" },
          { name: "keyEvents" }
        ],
        limit: "10000"
      },
      4
    );
    const pageRows = (pageResponse.rows ?? []).map((row) => ga4PageRow(row));

    return [...overviewRows, ...pageRows];
  },
  writeTruth: writeGa4Truth
});

const posthogConnector = createConnector<PostHogCredential, PostHogEventRow>({
  provider: "posthog",
  fixtureRows: () => POSTHOG_EVENTS,
  fixtureObjectType: "posthog_event",
  async testLive(_db, _request, credential) {
    const projectId = String(requireCredential(credential, "projectId"));
    await posthogQuery(credential, projectId, posthogAuthToken(credential), "select 1 as ok", {});
    return { ok: true, mode: "live", provider: "posthog", accountExternalId: projectId };
  },
  async planLive(db, request, credential) {
    return defaultPlan(db, request, "posthog_event", credential.refreshWindowDays ?? 7, "live");
  },
  async extractLive(_db, _request, plan, credential) {
    const projectId = String(requireCredential(credential, "projectId"));
    const rows = await posthogQuery<PostHogQueryRow[]>(
      credential,
      projectId,
      posthogAuthToken(credential),
      `
        select uuid, event, distinct_id, person_id, properties, timestamp
        from events
        where timestamp >= ${posthogDateTimeLiteral(cursorStartIso(plan))}
        order by timestamp asc
        limit 10000
      `,
      {}
    );
    return rows.map((row) => posthogEventRow(row));
  },
  writeTruth: writePostHogTruth
});

const stripeConnector = createConnector<StripeCredential, StripeInvoiceRow>({
  provider: "stripe",
  fixtureRows: () => STRIPE_INVOICES,
  fixtureObjectType: "stripe_invoice",
  async testLive(_db, _request, credential) {
    const secretKey = requireCredential(credential, "secretKey");
    await stripeGet<{ data: unknown[] }>(credential, secretKey, "/v1/customers", { limit: "1" });
    return { ok: true, mode: "live", provider: "stripe" };
  },
  async planLive(db, request, credential) {
    return defaultPlan(db, request, "stripe_invoice", credential.refreshWindowDays ?? 30, "live");
  },
  async extractLive(_db, _request, plan, credential) {
    const secretKey = requireCredential(credential, "secretKey");
    const invoices = await stripeList<StripeInvoiceApi>(
      credential,
      secretKey,
      "/v1/invoices",
      {
        limit: "100",
        status: "paid",
        "created[gte]": String(Math.floor(new Date(cursorStartIso(plan)).getTime() / 1000)),
        "expand[]": ["data.customer", "data.subscription"]
      }
    );
    const rows: StripeInvoiceRow[] = [];
    for (const invoice of invoices) {
      const lines = await stripeInvoiceLines(credential, secretKey, invoice);
      rows.push(stripeInvoiceRow(invoice, lines));
    }
    return rows;
  },
  writeTruth: writeStripeTruth
});

const xConnector = createConnector<XCredential, XPostRow>({
  provider: "x",
  fixtureRows: () => X_POSTS,
  fixtureObjectType: "x_post",
  async testLive(db, request, credential) {
    const bearerToken = requireCredential(credential, "bearerToken");
    const user = await xResolveUser(credential, bearerToken);
    await persistXProfileSnapshot(db, request, user, new Date().toISOString());
    return { ok: true, mode: "live", provider: "x", accountExternalId: user.id };
  },
  async planLive(db, request, credential) {
    return defaultPlan(
      db,
      request,
      "x_user_timeline",
      request.refreshWindowDays ?? credential.refreshWindowDays ?? 7,
      "live",
      undefined,
      { ignoreCursor: request.refreshWindowDays !== undefined }
    );
  },
  async extractLive(_db, _request, plan, credential) {
    const bearerToken = requireCredential(credential, "bearerToken");
    const user = await xResolveUser(credential, bearerToken);
    return xTimelinePosts(credential, bearerToken, user, plan);
  },
  writeTruth: writeXTruth
});

const shopifyConnector = createConnector<ShopifyCredential, ShopifySyncRow>({
  provider: "shopify",
  fixtureRows: () => [],
  fixtureObjectType: "shopify_order",
  toExtractedRecord(row, _plan) {
    return {
      externalId: row.externalId,
      objectType: row.kind === "order" ? "shopify_order" : "shopify_product",
      payloadVersion: "live-v1",
      sourceUpdatedAt: row.kind === "order" ? row.processedAt ?? row.createdAt : row.updatedAt,
      payload: row
    };
  },
  async testLive(_db, _request, credential) {
    const storeDomain = requireCredential(credential, "storeDomain");
    const adminAccessToken = requireCredential(credential, "adminAccessToken");
    const response = await shopifyGraphql<{ shop?: { myshopifyDomain?: string | null } }>(
      credential,
      adminAccessToken,
      `
        query InfiniteOsShopifyStore {
          shop {
            myshopifyDomain
          }
        }
      `
    );
    return {
      ok: true,
      mode: "live",
      provider: "shopify",
      accountExternalId: response.shop?.myshopifyDomain ?? storeDomain
    };
  },
  async planLive(db, request, credential) {
    return defaultPlan(db, request, "shopify_order", credential.refreshWindowDays ?? 30, "live");
  },
  async extractLive(_db, _request, plan, credential) {
    const adminAccessToken = requireCredential(credential, "adminAccessToken");
    const rows: ShopifySyncRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      const response: ShopifyOrdersResponse = await shopifyGraphql<ShopifyOrdersResponse>(
        credential,
        adminAccessToken,
        `
          query InfiniteOsShopifyOrders($cursor: String, $query: String!) {
            orders(first: 50, after: $cursor, sortKey: PROCESSED_AT, reverse: false, query: $query) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  name
                  createdAt
                  processedAt
                  displayFinancialStatus
                  displayFulfillmentStatus
                  customer {
                    id
                    email
                  }
                  currentSubtotalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  currentTotalTaxSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  currentTotalDiscountsSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  currentTotalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItems(first: 100) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    edges {
                      node {
                        id
                        sku
                        quantity
                        name
                        originalUnitPriceSet {
                          shopMoney {
                            amount
                            currencyCode
                          }
                        }
                        product {
                          id
                          title
                          vendor
                          productType
                          status
                        }
                        variant {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        {
          cursor,
          query: `processed_at:>=${shopifySearchTimestamp(cursorStartIso(plan))}`
        }
      );
      const edges: Array<{ node?: ShopifyOrderNode | null } | null> = response.orders?.edges ?? [];
      for (const edge of edges) {
        const node = edge?.node;
        if (!node?.id) continue;
        const lineItems = await shopifyAllOrderLineItems(credential, adminAccessToken, node);
        rows.push(shopifyOrderRow(node, lineItems));
      }
      if (!response.orders?.pageInfo?.hasNextPage || !response.orders.pageInfo.endCursor) {
        break;
      }
      cursor = response.orders.pageInfo.endCursor;
    }
    cursor = null;
    for (;;) {
      const response: ShopifyProductsResponse = await shopifyGraphql<ShopifyProductsResponse>(
        credential,
        adminAccessToken,
        `
          query InfiniteOsShopifyProducts($cursor: String, $query: String!) {
            products(first: 100, after: $cursor, sortKey: UPDATED_AT, reverse: false, query: $query) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  title
                  vendor
                  productType
                  status
                  createdAt
                  updatedAt
                }
              }
            }
          }
        `,
        {
          cursor,
          query: `updated_at:>=${shopifySearchTimestamp(cursorStartIso(plan))}`
        }
      );
      const edges: Array<{ node?: ShopifyProductNode | null } | null> = response.products?.edges ?? [];
      rows.push(
        ...edges
          .map((edge: { node?: ShopifyProductNode | null } | null) => edge?.node)
          .filter((node: ShopifyProductNode | null | undefined): node is ShopifyProductNode => Boolean(node?.id))
          .map((node: ShopifyProductNode) => shopifyProductRow(node))
      );
      if (!response.products?.pageInfo?.hasNextPage || !response.products.pageInfo.endCursor) {
        return rows;
      }
      cursor = response.products.pageInfo.endCursor;
    }
  },
  async writeTruth(tx, request, rows, rawIds) {
    await writeShopifyTruth(tx, request, rows, rawIds);
  }
});

const metaAdsConnector = createConnector<MetaAdsCredential, MetaAdsCampaignDailyRow>({
  provider: "meta_ads",
  fixtureRows: () => [],
  fixtureObjectType: "meta_ads_campaign_daily",
  async testLive(_db, _request, credential) {
    const adAccountId = metaAdsAccountId(credential);
    if (isMetaAdsMcpTransport(credential)) {
      await metaAdsMcpInsights(credential, {
        adAccountId,
        fields: META_ADS_INSIGHTS_PROBE_FIELDS,
        level: "campaign",
        limit: "1",
        datePreset: "today"
      });
    } else if (isMetaAdsCliTransport(credential)) {
      await metaAdsCliInsights(credential, {
        fields: META_ADS_INSIGHTS_PROBE_FIELDS,
        limit: "1",
        datePreset: "today"
      });
    } else {
      const accessToken = requireCredential(credential, "accessToken");
      await fetchJson<MetaAdsInsightsResponse>(
        metaAdsInsightsUrl(credential, {
          adAccountId,
          datePreset: "today",
          fields: META_ADS_INSIGHTS_PROBE_FIELDS,
          level: "campaign",
          limit: "1"
        }),
        {
          method: "GET",
          headers: bearerHeaders(accessToken)
        }
      );
    }
    return {
      ok: true,
      mode: "live",
      provider: "meta_ads",
      accountExternalId: adAccountId
    };
  },
  async planLive(db, request, credential) {
    return defaultPlan(
      db,
      request,
      "meta_ads_campaign_daily",
      request.refreshWindowDays ?? credential.refreshWindowDays ?? 30,
      "live",
      request.backfillWindow,
      { ignoreCursor: request.mode === "backfill" || Boolean(request.backfillWindow) }
    );
  },
  async extractLive(_db, request, plan, credential) {
    const adAccountId = metaAdsAccountId(credential);
    const timeOptions = metaAdsTimeOptions(plan);
    const { level, timeIncrement } = metaAdsInsightsGrain(request);
    // §4 — the extract context pins the Graph API version and records the attribution
    // request shape on every row produced from this run.
    const context: MetaAdsInsightsContext = {
      apiVersion: metaAdsApiVersion(credential),
      attributionSetting: META_ADS_ATTRIBUTION_SETTING
    };
    const rows: MetaAdsCampaignDailyRow[] = [];
    if (isMetaAdsMcpTransport(credential)) {
      let after: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = await metaAdsMcpInsights(credential, {
          adAccountId,
          fields: META_ADS_INSIGHTS_FIELDS,
          level,
          limit: "100",
          timeIncrement,
          attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
          ...timeOptions,
          after
        });
        rows.push(
          ...(response.data ?? []).map((row: MetaAdsInsightsRow) =>
            metaAdsCampaignDailyRow(adAccountId, row, context)
          )
        );
        const nextAfter = metaAdsPagingAfter(response);
        if (!nextAfter) {
          return rows;
        }
        after = nextAfter;
      }
      throw new ConnectorError("provider_api_error", "Meta Ads MCP pagination exceeded the page limit", true);
    }
    if (isMetaAdsCliTransport(credential)) {
      const response = await metaAdsCliInsights(credential, {
        fields: META_ADS_INSIGHTS_FIELDS,
        limit: "100",
        timeIncrement: "daily",
        attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
        ...timeOptions
      });
      return (response.data ?? []).map((row: MetaAdsInsightsRow) =>
        metaAdsCampaignDailyRow(adAccountId, row, context)
      );
    }
    const accessToken = requireCredential(credential, "accessToken");
    let nextUrl: string | null = metaAdsInsightsUrl(credential, {
      adAccountId,
      fields: META_ADS_INSIGHTS_FIELDS,
      level,
      limit: "100",
      timeIncrement,
      attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
      ...timeOptions
    });
    while (nextUrl) {
      const response: MetaAdsInsightsResponse = await fetchJson<MetaAdsInsightsResponse>(nextUrl, {
        method: "GET",
        headers: bearerHeaders(accessToken)
      });
      rows.push(
        ...(response.data ?? []).map((row: MetaAdsInsightsRow) =>
          metaAdsCampaignDailyRow(adAccountId, row, context)
        )
      );
      nextUrl = response.paging?.next ?? null;
    }
    return rows;
  },
  async writeTruth(tx, request, rows, rawIds) {
    await writeMetaAdsTruth(tx, request, rows, rawIds);
  }
});

function createConnector<
  Credential extends Record<string, unknown>,
  Row extends { externalId: string }
>(options: {
  provider: FirstPhaseProvider;
  fixtureObjectType: string;
  fixtureRows: () => Row[];
  testLive: (db: InfiniteOsDb, request: SyncRequest, credential: Credential) => Promise<ConnectionTestResult>;
  planLive: (db: InfiniteOsDb, request: SyncRequest, credential: Credential) => Promise<SyncPlan>;
  extractLive: (
    db: InfiniteOsDb,
    request: SyncRequest,
    plan: SyncPlan,
    credential: Credential
  ) => Promise<Row[]>;
  writeTruth: (tx: InfiniteOsDb, request: SyncRequest, rows: Row[], rawIds: string[]) => Promise<void>;
  toExtractedRecord?: (row: Row, plan: SyncPlan) => ExtractedRecord<unknown>;
}): GrowthConnector {
  return {
    provider: options.provider,
    async testConnection(db, request) {
      const credential = await sourceCredential<Credential>(db, request);
      if (isFixtureCredential(credential)) {
        return { ok: true, mode: "fixture", provider: options.provider };
      }
      return options.testLive(db, request, credential.payload);
    },
    async planSync(db, request) {
      const credential = await sourceCredential<Credential>(db, request);
      if (isFixtureCredential(credential)) {
        return defaultPlan(db, request, options.fixtureObjectType, 7, "fixture");
      }
      return options.planLive(db, request, credential.payload);
    },
    async extract(db, request, plan) {
      const credential = await sourceCredential<Credential>(db, request);
      const rows = isFixtureCredential(credential)
        ? options.fixtureRows()
        : await options.extractLive(db, request, plan, credential.payload);
      return rows.map((row) =>
        options.toExtractedRecord
          ? options.toExtractedRecord(row, plan)
          : {
              externalId: row.externalId,
              objectType: options.fixtureObjectType,
              payloadVersion: plan.mode === "fixture" ? "fixture-v1" : "live-v1",
              sourceUpdatedAt: plan.mode === "fixture" ? null : plan.cursorEnd,
              payload: row
            }
      );
    },
    async sync(db, request) {
      const plan = await this.planSync(db, request);
      let extracted: ExtractedRecord<unknown>[];
      try {
        await this.testConnection(db, request);
        extracted = await this.extract(db, request, plan);
      } catch (error) {
        await recordSyncFailure(db, request, plan, providerError(error));
        throw error;
      }
      return syncExtractedBatch(db, request, plan, extracted, (tx, rawIds) =>
        options.writeTruth(
          tx,
          request,
          extracted.map((record) => record.payload as Row),
          rawIds
        )
      );
    }
  };
}

async function defaultPlan(
  db: InfiniteOsDb,
  request: SyncRequest,
  cursorKey: string,
  refreshWindowDays: number,
  mode: "fixture" | "live",
  backfillWindow?: string,
  options: { ignoreCursor?: boolean } = {}
): Promise<SyncPlan> {
  const cursor = await db.one<{ cursor_value: string }>(
    "select cursor_value from sync_cursors where source_id = $1 and cursor_key = $2",
    [request.sourceId, cursorKey]
  );
  const cursorValue = typeof cursor?.cursor_value === "string" && cursor.cursor_value.trim() !== ""
    ? cursor.cursor_value
    : null;
  return {
    cursorKey,
    cursorStart: options.ignoreCursor ? null : cursorValue,
    cursorEnd: new Date().toISOString(),
    refreshWindowDays,
    mode,
    ...(backfillWindow ? { backfillWindow } : {})
  };
}

async function syncExtractedBatch(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  records: ExtractedRecord<unknown>[],
  writeTruth: (tx: InfiniteOsDb, rawIds: string[]) => Promise<void>
): Promise<SyncResult> {
  return db.withTransaction(async (tx) => {
    await tx.updateSourceStatus(request.sourceId, "syncing");
    await tx.query(
      `
        insert into sync_runs (id, workspace_id, source_id, status)
        values ($1, $2, $3, 'running')
        on conflict (id) do nothing
      `,
      [request.syncRunId, request.workspaceId, request.sourceId]
    );
    const batchId = `batch_${randomUUID()}`;
    await tx.query(
      `
        insert into sync_batches (
          id, sync_run_id, workspace_id, source_id, status, batch_type, cursor_key,
          cursor_start, cursor_end, records_seen
        )
        values ($1,$2,$3,$4,'running',$5,$6,$7,$8,$9)
      `,
      [
        batchId,
        request.syncRunId,
        request.workspaceId,
        request.sourceId,
        plan.cursorKey,
        plan.cursorKey,
        plan.cursorStart,
        plan.cursorEnd,
        records.length
      ]
    );
    const rawIds: string[] = [];
    for (const record of records) {
      const proposedRawId = `raw_${randomUUID()}`;
      const rawRecord = await tx.one<{ id: string }>(
        `
          insert into raw_records (
            id, workspace_id, source_id, sync_batch_id, provider, object_type,
            external_id, payload, payload_version, source_record_hash, source_updated_at
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::timestamptz)
          on conflict (source_id, object_type, external_id, source_record_hash)
          do update set payload = raw_records.payload
          returning id
        `,
        [
          proposedRawId,
          request.workspaceId,
          request.sourceId,
          batchId,
          request.provider,
          record.objectType,
          record.externalId,
          JSON.stringify(record.payload),
          record.payloadVersion,
          hashRecord(record.payload),
          record.sourceUpdatedAt ?? null
        ]
      );
      const rawId = rawRecord?.id ?? proposedRawId;
      rawIds.push(rawId);
      await tx.query(
        `
          insert into sync_batch_records (id, sync_batch_id, raw_record_id, record_status)
          values ($1,$2,$3,'raw_written')
        `,
        [`sbr_${randomUUID()}`, batchId, rawId]
      );
    }
    await writeTruth(tx, rawIds);
    await tx.query("update sync_batch_records set record_status = 'provider_truth_written' where sync_batch_id = $1", [
      batchId
    ]);
    await tx.query(
      "update sync_batches set status = 'succeeded', finished_at = now(), records_written = $2 where id = $1",
      [batchId, records.length]
    );
    await tx.query(
      `
        update sync_runs
        set status = 'succeeded', finished_at = now(),
          records_extracted = $2, records_loaded = $2
        where id = $1
      `,
      [request.syncRunId, records.length]
    );
    await tx.query(
      `
        insert into sync_cursors (id, workspace_id, source_id, cursor_key, cursor_value)
        values ($1,$2,$3,$4,$5)
        on conflict (source_id, cursor_key)
        do update set cursor_value = excluded.cursor_value, updated_at = now()
      `,
      [`cursor_${randomUUID()}`, request.workspaceId, request.sourceId, plan.cursorKey, plan.cursorEnd]
    );
    await tx.updateSourceStatus(request.sourceId, "connected", plan.cursorEnd);
    return {
      provider: request.provider,
      recordsExtracted: records.length,
      recordsLoaded: records.length,
      cursorKey: plan.cursorKey,
      cursorValue: plan.cursorEnd
    };
  });
}

async function recordSyncFailure(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  error: { code: string; message: string; retryable: boolean }
): Promise<void> {
  await db.withTransaction(async (tx) => {
    await tx.query(
      `
        insert into sync_runs (id, workspace_id, source_id, status, finished_at, error)
        values ($1, $2, $3, 'failed', now(), $4)
        on conflict (id) do update set status = 'failed', finished_at = now(), error = excluded.error
      `,
      [request.syncRunId, request.workspaceId, request.sourceId, error.message]
    );
    await tx.query(
      `
        insert into sync_errors (
          id, workspace_id, source_id, sync_run_id, error_code, error_message, retryable
        )
        values ($1,$2,$3,$4,$5,$6,$7)
      `,
      [`err_${randomUUID()}`, request.workspaceId, request.sourceId, request.syncRunId, error.code, error.message, error.retryable]
    );
    await tx.query(
      `
        insert into sync_cursors (id, workspace_id, source_id, cursor_key, cursor_value)
        values ($1,$2,$3,$4,$5)
        on conflict (source_id, cursor_key) do nothing
      `,
      [`cursor_${randomUUID()}`, request.workspaceId, request.sourceId, plan.cursorKey, plan.cursorStart ?? ""]
    );
    await tx.updateSourceStatus(request.sourceId, "error");
  });
}

async function sourceCredential<T extends Record<string, unknown>>(
  db: InfiniteOsDb,
  request: SyncRequest
): Promise<SourceCredential<T>> {
  const row = await db.one<{
    credential_kind: string;
    encrypted_payload: string;
    oauth_token_id: string | null;
  }>(
    `
      select credential_kind, encrypted_payload, oauth_token_id
      from connection_credentials
      where workspace_id = $1 and source_id = $2 and revoked_at is null
      order by created_at desc
      limit 1
    `,
    [request.workspaceId, request.sourceId]
  );
  if (!row) {
    throw new ConnectorError("provider_auth_failed", `missing credentials for ${request.sourceId}`, false);
  }
  // Backward-compatible: a NULL oauth_token_id keeps reading encrypted_payload exactly as
  // before (non-OAuth credentials such as PostHog/X, plus any un-migrated OAuth rows).
  if (!row.oauth_token_id) {
    return {
      kind: row.credential_kind,
      payload: parseCredentialPayload<T>(row.encrypted_payload)
    };
  }
  // OAuth bridge: follow the FK to the live oauth_tokens row, refresh on demand, and merge the
  // live token over the non-secret metadata stored in encrypted_payload (e.g. propertyId).
  const metadata = parseCredentialPayload<Record<string, unknown>>(row.encrypted_payload);
  const liveToken = await resolveLiveOAuthCredential(db, request, row.oauth_token_id);
  return {
    kind: row.credential_kind,
    payload: { ...metadata, ...liveToken } as unknown as T
  };
}

async function resolveLiveOAuthCredential(
  db: InfiniteOsDb,
  request: SyncRequest,
  oauthTokenId: string
): Promise<Record<string, unknown>> {
  const tokenRow = await db.one<{ encrypted_payload: string; expires_at: string | null }>(
    `
      select ot.encrypted_payload, ot.expires_at
      from oauth_tokens ot
      where ot.id = $1 and ot.workspace_id = $2 and ot.revoked_at is null
      limit 1
    `,
    [oauthTokenId, request.workspaceId]
  );
  if (!tokenRow) {
    throw new ConnectorError(
      "provider_auth_failed",
      `oauth token ${oauthTokenId} for ${request.sourceId} is missing or revoked`,
      false
    );
  }

  const tokenPayload = decryptCredentialPayload<Record<string, unknown>>(
    tokenRow.encrypted_payload,
    requiredEncryptionKey()
  );
  const accessToken = stringField(tokenPayload.accessToken);
  const expiresAt = stringField(tokenPayload.expiresAt) ?? tokenRow.expires_at ?? undefined;

  if (accessToken && !isExpiredTimestamp(expiresAt)) {
    return compactOAuthCredential(accessToken, stringField(tokenPayload.refreshToken), expiresAt);
  }

  // Expired (or missing) access token: refresh in place using the app credentials snapshot.
  const refreshed = await refreshLinkedOAuthToken(db, request, oauthTokenId, tokenPayload);
  if (refreshed) {
    return compactOAuthCredential(refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt);
  }
  if (accessToken) {
    // Could not refresh (e.g. no app credentials); fall back to the stored token and let the
    // provider reject it if it is truly expired.
    return compactOAuthCredential(accessToken, stringField(tokenPayload.refreshToken), expiresAt);
  }
  throw new ConnectorError(
    "provider_auth_failed",
    `oauth token ${oauthTokenId} for ${request.sourceId} has no usable access token`,
    false
  );
}

async function refreshLinkedOAuthToken(
  db: InfiniteOsDb,
  request: SyncRequest,
  oauthTokenId: string,
  tokenPayload: Record<string, unknown>
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | null> {
  const appPayload = await oauthAppPayloadForToken(db, request, tokenPayload);
  const refreshToken = stringField(tokenPayload.refreshToken);
  const clientId = stringField(appPayload.clientId);
  const clientSecret = stringField(appPayload.clientSecret);
  const tokenUrl = stringField(appPayload.tokenUrl) ?? "https://oauth2.googleapis.com/token";
  if (!refreshToken || !clientId || !clientSecret) {
    return null;
  }

  const refreshed = await refreshOAuthToken({ tokenUrl, clientId, clientSecret, refreshToken });
  if (!refreshed) {
    return null;
  }
  const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
  const nextPayload = compactRecord({
    accessToken: refreshed.accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: refreshed.expiresAt,
    oauthApp: Object.keys(appPayload).length > 0 ? appPayload : undefined
  });
  await db.query(
    `
      update oauth_tokens
      set encrypted_payload = $2, expires_at = $3, last_rotated_at = now(), revoked_at = null
      where id = $1 and workspace_id = $4
    `,
    [
      oauthTokenId,
      encryptCredentialPayload(nextPayload, requiredEncryptionKey()),
      refreshed.expiresAt ?? null,
      request.workspaceId
    ]
  );
  return {
    accessToken: refreshed.accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: refreshed.expiresAt
  };
}

async function oauthAppPayloadForToken(
  db: InfiniteOsDb,
  request: SyncRequest,
  tokenPayload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (isRecord(tokenPayload.oauthApp)) {
    return tokenPayload.oauthApp;
  }
  const appRow = await db.one<{ encrypted_payload: string }>(
    `
      select encrypted_payload
      from oauth_apps
      where workspace_id = $1 and provider = $2 and revoked_at is null
      order by created_at desc
      limit 1
    `,
    [request.workspaceId, request.provider]
  );
  if (!appRow) {
    return {};
  }
  return decryptCredentialPayload<Record<string, unknown>>(appRow.encrypted_payload, requiredEncryptionKey());
}

function compactOAuthCredential(
  accessToken: string,
  refreshToken: string | undefined,
  expiresAt: string | undefined
): Record<string, unknown> {
  return compactRecord({ accessToken, refreshToken, expiresAt });
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null)
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isExpiredTimestamp(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return true;
  }
  // Treat tokens within a 60s window of expiry as expired to avoid racing the boundary.
  return parsed <= Date.now() + 60_000;
}

function parseCredentialPayload<T extends Record<string, unknown>>(payload: string): T {
  if (payload === "fixture-encrypted" || payload === "fixture") {
    return { mode: "fixture" } as unknown as T;
  }
  if (isEncryptedCredentialPayload(payload)) {
    return decryptCredentialPayload<T>(payload, requiredEncryptionKey());
  }
  throw new ConnectorError("provider_auth_failed", "credential payload must be encrypted", false);
}

function requiredEncryptionKey(): string {
  const key = process.env.GROWTH_OS_ENCRYPTION_KEY ?? projectEncryptionKey();
  if (!key) {
    throw new ConnectorError("provider_auth_failed", "GROWTH_OS_ENCRYPTION_KEY is required to read credentials", false);
  }
  return key;
}

function projectEncryptionKey(): string | undefined {
  const root = resolve(process.env.GROWTH_OS_WORKSPACE_ROOT ?? process.cwd());
  const envPath = join(root, ".growth-os", ".env");
  if (!existsSync(envPath)) {
    return undefined;
  }
  const match = readFileSync(envPath, "utf8").match(/^GROWTH_OS_ENCRYPTION_KEY=(.*)$/m);
  return match?.[1]?.trim() || undefined;
}

function isFixtureCredential(credential: SourceCredential): boolean {
  return credential.kind === "fixture" || credential.payload.mode === "fixture";
}

function requireCredential(credential: Record<string, unknown>, key: string): string {
  const value = credential[key];
  if (value === undefined || value === null || value === "") {
    throw new ConnectorError("provider_auth_failed", `${key} credential is required`, false);
  }
  return String(value);
}

// The connector is multi-objectType: the framework feeds a mixed array of overview +
// page rows into one writeTruth. Branch on the `kind` discriminator and route each row
// to its own fact table (rawIds stays index-aligned with the mixed array).
async function writeGa4Truth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: Ga4SyncRow[],
  rawIds: string[]
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "page") {
      await writeGa4PageTruth(tx, request, row, rawIds[index]);
    } else {
      await writeGa4OverviewTruth(tx, request, row, rawIds[index]);
    }
  }
}

async function writeGa4OverviewTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  row: Ga4Row,
  rawId: string
): Promise<void> {
  await tx.query(
    `
      insert into ga4_report_snapshot_fact (
        id, workspace_id, source_id, raw_record_id, reporting_date, country,
        landing_page, referrer, utm_source, utm_medium, utm_campaign,
        session_default_channel_group, host_name, device_category,
        sessions, active_users, total_users, new_users, screen_page_views,
        engaged_sessions, engagement_rate, average_session_duration, key_events
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      -- This on-conflict column list matches migration 0024's ga4_report_snapshot_unique by SET
      -- (Postgres matches the conflict target by column set, order-independent). It is intentionally
      -- a different order from the INSERT column list above; do NOT "align" them by reordering the values.
      on conflict (source_id, reporting_date, country, landing_page, utm_source, utm_medium, utm_campaign, session_default_channel_group, device_category, host_name)
      do update set sessions = excluded.sessions, active_users = excluded.active_users,
        total_users = excluded.total_users, new_users = excluded.new_users,
        screen_page_views = excluded.screen_page_views, engaged_sessions = excluded.engaged_sessions,
        engagement_rate = excluded.engagement_rate, average_session_duration = excluded.average_session_duration,
        key_events = excluded.key_events, raw_record_id = excluded.raw_record_id
    `,
    [
      `ga4_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      row.reportingDate,
      row.country,
      row.landingPage,
      row.referrer,
      row.utmSource,
      row.utmMedium,
      row.utmCampaign,
      row.sessionDefaultChannelGroup,
      row.hostName,
      row.deviceCategory,
      row.sessions,
      row.activeUsers,
      row.totalUsers,
      row.newUsers,
      row.screenPageViews,
      row.engagedSessions,
      row.engagementRate,
      row.averageSessionDuration,
      row.keyEvents
    ]
  );
  await writeLineage(
    tx,
    request,
    "ga4_report_snapshot_fact",
    `${row.reportingDate}:${row.country}:${row.landingPage}:${row.utmSource}:${row.utmMedium}:${row.utmCampaign}:${row.sessionDefaultChannelGroup}:${row.deviceCategory}:${row.hostName}`,
    rawId
  );
}

async function writeGa4PageTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  row: Ga4PageRow,
  rawId: string
): Promise<void> {
  await tx.query(
    `
      insert into ga4_page_report_fact (
        id, workspace_id, source_id, raw_record_id, reporting_date,
        host_name, page_path, page_title,
        screen_page_views, sessions, engaged_sessions,
        average_session_duration, key_events
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      -- Matches migration 0025's ga4_page_report_unique.
      on conflict (source_id, reporting_date, host_name, page_path)
      do update set page_title = excluded.page_title,
        screen_page_views = excluded.screen_page_views, sessions = excluded.sessions,
        engaged_sessions = excluded.engaged_sessions,
        average_session_duration = excluded.average_session_duration,
        key_events = excluded.key_events, raw_record_id = excluded.raw_record_id
    `,
    [
      `ga4_page_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      row.reportingDate,
      row.hostName,
      row.pagePath,
      row.pageTitle,
      row.screenPageViews,
      row.sessions,
      row.engagedSessions,
      row.averageSessionDuration,
      row.keyEvents
    ]
  );
  await writeLineage(
    tx,
    request,
    "ga4_page_report_fact",
    `${row.reportingDate}:${row.hostName}:${row.pagePath}`,
    rawId
  );
}

async function writePostHogTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: PostHogEventRow[],
  rawIds: string[]
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    await tx.query(
      `
        insert into posthog_event_truth (
          id, workspace_id, source_id, raw_record_id, event_id, event_name,
          distinct_id, person_id, session_id, occurred_at, landing_page,
          referrer, utm_source, utm_medium, utm_campaign, properties
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
        on conflict (source_id, event_id)
        do update set raw_record_id = excluded.raw_record_id, properties = excluded.properties
      `,
      [
        `phe_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        row.eventId,
        row.eventName,
        row.distinctId,
        row.personId,
        row.sessionId,
        row.occurredAt,
        row.landingPage,
        row.referrer,
        row.utmSource,
        row.utmMedium,
        row.utmCampaign,
        JSON.stringify(row.properties)
      ]
    );
    await writeLineage(tx, request, "posthog_event_truth", row.eventId, rawIds[index]);
    await tx.query(
      `
        insert into posthog_person_current (
          id, workspace_id, source_id, raw_record_id, person_id, email, created_at_source, properties
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        on conflict (source_id, person_id)
        do update set email = excluded.email, properties = excluded.properties, updated_at = now()
      `,
      [
        `php_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        row.personId,
        row.email,
        row.occurredAt,
        JSON.stringify({ email: row.email, distinct_id: row.distinctId })
      ]
    );
    await writeLineage(tx, request, "posthog_person_current", row.personId, rawIds[index]);
    await tx.query(
      `
        insert into posthog_person_distinct_ids (id, workspace_id, source_id, person_id, distinct_id)
        values ($1,$2,$3,$4,$5)
        on conflict (source_id, distinct_id) do nothing
      `,
      [`phd_${randomUUID()}`, request.workspaceId, request.sourceId, row.personId, row.distinctId]
    );
    await writeLineage(tx, request, "posthog_person_distinct_ids", row.distinctId, rawIds[index]);
    await tx.query(
      `
        insert into posthog_session_fact (
          id, workspace_id, source_id, raw_record_id, session_id, distinct_id,
          started_at, ended_at, landing_page, referrer, utm_source, utm_medium, utm_campaign
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict (source_id, session_id)
        do update set ended_at = excluded.ended_at, raw_record_id = excluded.raw_record_id
      `,
      [
        `phs_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        row.sessionId,
        row.distinctId,
        row.occurredAt,
        row.occurredAt,
        row.landingPage,
        row.referrer,
        row.utmSource,
        row.utmMedium,
        row.utmCampaign
      ]
    );
    await writeLineage(tx, request, "posthog_session_fact", row.sessionId, rawIds[index]);
  }
}

async function writeStripeTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: StripeInvoiceRow[],
  rawIds: string[]
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    const invoice = rows[index];
    await tx.query(
      `
        insert into stripe_customers (
          id, workspace_id, source_id, raw_record_id, stripe_customer_id, email, name, created_at_source
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (source_id, stripe_customer_id)
        do update set email = excluded.email, name = excluded.name
      `,
      [
        `cus_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        invoice.customerId,
        invoice.customerEmail,
        invoice.customerName,
        invoice.createdAt
      ]
    );
    await writeLineage(tx, request, "stripe_customers", invoice.customerId, rawIds[index]);
    await tx.query(
      `
        insert into stripe_invoices (
          id, workspace_id, source_id, raw_record_id, stripe_invoice_id,
          stripe_customer_id, status, currency, amount_paid, amount_due,
          paid_at, created_at_source, external_order_id
        )
        values ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10,$11,$12)
        on conflict (source_id, stripe_invoice_id)
        do update set amount_paid = excluded.amount_paid, amount_due = excluded.amount_due,
          paid_at = excluded.paid_at, external_order_id = excluded.external_order_id
      `,
      [
        `inv_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        invoice.invoiceId,
        invoice.customerId,
        invoice.currency,
        invoice.amountPaid,
        invoice.amountDue,
        invoice.paidAt,
        invoice.createdAt,
        invoice.externalOrderId
      ]
    );
    await writeLineage(tx, request, "stripe_invoices", invoice.invoiceId, rawIds[index]);
    for (const line of invoice.lines) {
      if (line.productId) {
        await tx.query(
          `
            insert into stripe_products (id, workspace_id, source_id, raw_record_id, stripe_product_id, name, active)
            values ($1,$2,$3,$4,$5,$6,true)
            on conflict (source_id, stripe_product_id) do update set name = excluded.name
          `,
          [`prod_${randomUUID()}`, request.workspaceId, request.sourceId, rawIds[index], line.productId, line.productName]
        );
        await writeLineage(tx, request, "stripe_products", line.productId, rawIds[index]);
      }
      if (line.priceId && line.productId) {
        await tx.query(
          `
            insert into stripe_prices (
              id, workspace_id, source_id, raw_record_id, stripe_price_id,
              stripe_product_id, currency, unit_amount, recurring_interval, active
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,'month',true)
            on conflict (source_id, stripe_price_id)
            do update set unit_amount = excluded.unit_amount
          `,
          [
            `price_${randomUUID()}`,
            request.workspaceId,
            request.sourceId,
            rawIds[index],
            line.priceId,
            line.productId,
            invoice.currency,
            line.amountCents
          ]
        );
        await writeLineage(tx, request, "stripe_prices", line.priceId, rawIds[index]);
      }
      await tx.query(
        `
          insert into stripe_invoice_lines (
            id, workspace_id, source_id, raw_record_id, stripe_line_id,
            stripe_invoice_id, stripe_product_id, stripe_price_id, amount_cents,
            currency, period_start, period_end, external_order_id
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          on conflict (source_id, stripe_line_id)
          do update set amount_cents = excluded.amount_cents, external_order_id = excluded.external_order_id
        `,
        [
          `line_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          rawIds[index],
          line.lineId,
          invoice.invoiceId,
          line.productId,
          line.priceId,
          line.amountCents,
          invoice.currency,
          line.periodStart,
          line.periodEnd,
          invoice.externalOrderId
        ]
      );
      await writeLineage(tx, request, "stripe_invoice_lines", line.lineId, rawIds[index]);
    }
    if (invoice.subscriptionId) {
      await tx.query(
        `
          insert into stripe_subscriptions (
            id, workspace_id, source_id, raw_record_id, stripe_subscription_id,
            stripe_customer_id, status, current_period_start, current_period_end, created_at_source
          )
          values ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)
          on conflict (source_id, stripe_subscription_id)
          do update set status = excluded.status, current_period_end = excluded.current_period_end
        `,
        [
          `sub_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          rawIds[index],
          invoice.subscriptionId,
          invoice.customerId,
          invoice.createdAt,
          invoice.periodEnd,
          invoice.createdAt
        ]
      );
      await writeLineage(tx, request, "stripe_subscriptions", invoice.subscriptionId, rawIds[index]);
    }
  }
}

async function writeXTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: XPostRow[],
  rawIds: string[]
): Promise<void> {
  const profileSnapshot = rows[0]?.profileSnapshot;
  if (profileSnapshot) {
    await tx.query(
      `
        insert into x_profile_snapshot (
          id, workspace_id, source_id, captured_at, x_user_id, username,
          followers_count, following_count, tweet_count, listed_count,
          like_count, public_metrics
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
        on conflict (source_id, captured_at)
        do update set x_user_id = excluded.x_user_id,
          username = excluded.username,
          followers_count = excluded.followers_count,
          following_count = excluded.following_count,
          tweet_count = excluded.tweet_count,
          listed_count = excluded.listed_count,
          like_count = excluded.like_count,
          public_metrics = excluded.public_metrics
      `,
      [
        `xps_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        profileSnapshot.capturedAt,
        profileSnapshot.userId,
        profileSnapshot.username,
        profileSnapshot.publicMetrics.followersCount,
        profileSnapshot.publicMetrics.followingCount,
        profileSnapshot.publicMetrics.tweetCount,
        profileSnapshot.publicMetrics.listedCount,
        profileSnapshot.publicMetrics.likeCount,
        JSON.stringify(profileSnapshot.publicMetrics)
      ]
    );
    if (rawIds[0]) {
      await writeLineage(tx, request, "x_profile_snapshot", `${profileSnapshot.userId}:${profileSnapshot.capturedAt}`, rawIds[0]);
    }
  }
  for (let index = 0; index < rows.length; index += 1) {
    const post = rows[index];
    await tx.query(
      `
        insert into x_post (
          id, workspace_id, source_id, raw_record_id, x_post_id, author_id,
          conversation_id, post_url, body_text, published_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (source_id, x_post_id)
        do update set raw_record_id = excluded.raw_record_id,
          author_id = excluded.author_id,
          conversation_id = excluded.conversation_id,
          post_url = excluded.post_url,
          body_text = excluded.body_text,
          published_at = excluded.published_at,
          updated_at = now()
      `,
      [
        `xp_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        post.postId,
        post.authorId,
        post.conversationId,
        post.postUrl,
        post.bodyText,
        post.publishedAt
      ]
    );
    await writeLineage(tx, request, "x_post", post.postId, rawIds[index]);
    await tx.query(
      `
        insert into x_post_metric_snapshot (
          id, workspace_id, source_id, raw_record_id, x_post_id, captured_at,
          retweet_count, reply_count, like_count, quote_count, bookmark_count,
          impression_count, public_metrics
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        on conflict (source_id, x_post_id, captured_at)
        do update set raw_record_id = excluded.raw_record_id,
          retweet_count = excluded.retweet_count,
          reply_count = excluded.reply_count,
          like_count = excluded.like_count,
          quote_count = excluded.quote_count,
          bookmark_count = excluded.bookmark_count,
          impression_count = excluded.impression_count,
          public_metrics = excluded.public_metrics
      `,
      [
        `xpm_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        post.postId,
        post.capturedAt,
        post.publicMetrics.retweetCount,
        post.publicMetrics.replyCount,
        post.publicMetrics.likeCount,
        post.publicMetrics.quoteCount,
        post.publicMetrics.bookmarkCount,
        post.publicMetrics.impressionCount,
        JSON.stringify(post.publicMetrics)
      ]
    );
    await writeLineage(tx, request, "x_post_metric_snapshot", `${post.postId}:${post.capturedAt}`, rawIds[index]);
  }
}

async function writeShopifyTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: ShopifySyncRow[],
  rawIds: string[]
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "product") {
      await tx.query(
        `
          insert into shopify_products (
            id, workspace_id, source_id, raw_record_id, shopify_product_id, title, vendor,
            product_type, status, created_at_source, updated_at_source
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          on conflict (source_id, shopify_product_id)
          do update set
            raw_record_id = excluded.raw_record_id,
            title = excluded.title,
            vendor = excluded.vendor,
            product_type = excluded.product_type,
            status = excluded.status,
            updated_at_source = excluded.updated_at_source,
            updated_at = now()
        `,
        [
          `shp_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          rawIds[index],
          row.productId,
          row.title,
          row.vendor,
          row.productType,
          row.status,
          row.createdAt,
          row.updatedAt
        ]
      );
      await writeLineage(tx, request, "shopify_products", row.productId, rawIds[index]);
      continue;
    }
    const order = row;
    await tx.query(
      `
        insert into shopify_orders (
          id, workspace_id, source_id, raw_record_id, shopify_order_id, shopify_order_name,
          customer_id, customer_email, currency, financial_status, fulfillment_status,
          subtotal_price_amount, total_tax_amount, total_discount_amount, total_price_amount,
          occurred_on, created_at_source, processed_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        on conflict (source_id, shopify_order_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          customer_email = excluded.customer_email,
          financial_status = excluded.financial_status,
          fulfillment_status = excluded.fulfillment_status,
          subtotal_price_amount = excluded.subtotal_price_amount,
          total_tax_amount = excluded.total_tax_amount,
          total_discount_amount = excluded.total_discount_amount,
          total_price_amount = excluded.total_price_amount,
          occurred_on = excluded.occurred_on,
          processed_at = excluded.processed_at,
          updated_at = now()
      `,
      [
        `sho_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        order.orderId,
        order.orderName,
        order.customerId,
        order.customerEmail,
        order.currency,
        order.financialStatus,
        order.fulfillmentStatus,
        order.subtotalPriceAmount,
        order.totalTaxAmount,
        order.totalDiscountAmount,
        order.totalPriceAmount,
        order.occurredOn,
        order.createdAt,
        order.processedAt
      ]
    );
    await writeLineage(tx, request, "shopify_orders", order.orderId, rawIds[index]);
    for (const line of order.lineItems) {
      await tx.query(
        `
          insert into shopify_order_lines (
            id, workspace_id, source_id, raw_record_id, shopify_line_item_id, shopify_order_id,
            shopify_product_id, shopify_variant_id, title, sku, quantity, price_amount, line_total_amount
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          on conflict (source_id, shopify_line_item_id)
          do update set
            raw_record_id = excluded.raw_record_id,
            shopify_product_id = excluded.shopify_product_id,
            shopify_variant_id = excluded.shopify_variant_id,
            title = excluded.title,
            sku = excluded.sku,
            quantity = excluded.quantity,
            price_amount = excluded.price_amount,
            line_total_amount = excluded.line_total_amount,
            updated_at = now()
        `,
        [
          `shl_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          rawIds[index],
          line.lineItemId,
          order.orderId,
          line.productId,
          line.variantId,
          line.title,
          line.sku,
          line.quantity,
          line.priceAmount,
          line.lineTotalAmount
        ]
      );
      await writeLineage(tx, request, "shopify_order_lines", line.lineItemId, rawIds[index]);
    }
  }
}

// §2.1 — fold the campaign×day delivery rows down to one dimension row per campaign and
// upsert meta_ads_campaigns. The dimension carries the account currency + coarse objective +
// display name the §5 Stripe-join views LEFT JOIN for currency/objective. Without this writer
// dim.currency/dim.objective were always NULL (so is_mapped was always false and the Stripe
// ROAS numerator was always 0). The dimension is campaign-grain, so we keep the LAST non-null
// value seen across the synced days for each (source, account, campaign) — last-write-wins,
// matching the §4c restatement model. Currency/objective rarely change within a window; when
// they do, the most recent day's value wins.
function metaAdsDimensionRows(
  rows: MetaAdsCampaignDailyRow[]
): Map<string, { adAccountId: string; campaignId: string; name: string | null; objective: string | null; currency: string | null }> {
  const dims = new Map<
    string,
    { adAccountId: string; campaignId: string; name: string | null; objective: string | null; currency: string | null }
  >();
  for (const row of rows) {
    const key = `${row.adAccountId}:${row.campaignId}`;
    const existing = dims.get(key);
    dims.set(key, {
      adAccountId: row.adAccountId,
      campaignId: row.campaignId,
      // Coalesce so a later day with a null field does not erase an earlier non-null value.
      name: row.campaignName ?? existing?.name ?? null,
      objective: row.objective ?? existing?.objective ?? null,
      currency: row.currency ?? existing?.currency ?? null
    });
  }
  return dims;
}

async function writeMetaAdsCampaignDimension(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsCampaignDailyRow[],
  rawIds: string[]
): Promise<void> {
  // A raw_record_id for provenance (any row from this run; the dimension is a fold, not a
  // single source row). Use the first row's raw id when present.
  const rawRecordId = rawIds[0] ?? null;
  for (const dim of metaAdsDimensionRows(rows).values()) {
    await tx.query(
      `
        insert into meta_ads_campaigns (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id,
          name, objective, currency
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (source_id, ad_account_id, campaign_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          -- coalesce so a re-sync that momentarily lacks a field never nulls a known value.
          name = coalesce(excluded.name, meta_ads_campaigns.name),
          objective = coalesce(excluded.objective, meta_ads_campaigns.objective),
          currency = coalesce(excluded.currency, meta_ads_campaigns.currency),
          updated_at = now()
      `,
      [
        `madm_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawRecordId,
        dim.adAccountId,
        dim.campaignId,
        dim.name,
        dim.objective,
        dim.currency
      ]
    );
    // Lineage carries an FK to raw_records, so only write it when a real raw id exists for
    // this run (the dimension is a fold of the day rows; a fabricated id would break the FK).
    if (rawRecordId) {
      await writeLineage(tx, request, "meta_ads_campaigns", `${dim.adAccountId}:${dim.campaignId}`, rawRecordId);
    }
  }
}

async function writeMetaAdsTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsCampaignDailyRow[],
  rawIds: string[]
): Promise<void> {
  // §2.1 — populate the campaign dimension first so the §5 join views have currency/objective.
  await writeMetaAdsCampaignDimension(tx, request, rows, rawIds);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    // §4c restatement — the unique key (source_id, ad_account_id, campaign_id,
    // occurred_on) makes this last-write-wins. Re-syncing the rolling 28-day window
    // overwrites spend/clicks/conversion columns/actions_raw so late-attributed
    // conversions restate history without drift.
    await tx.query(
      `
        insert into meta_ads_campaign_daily (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, campaign_name,
          occurred_on, spend, clicks, inline_link_clicks, landing_page_views, impressions, reach,
          cpm, cpc, ctr, currency, attribution_setting, actions_raw, api_version
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21
        )
        on conflict (source_id, ad_account_id, campaign_id, occurred_on)
        do update set
          raw_record_id = excluded.raw_record_id,
          campaign_name = excluded.campaign_name,
          spend = excluded.spend,
          clicks = excluded.clicks,
          inline_link_clicks = excluded.inline_link_clicks,
          landing_page_views = excluded.landing_page_views,
          impressions = excluded.impressions,
          reach = excluded.reach,
          cpm = excluded.cpm,
          cpc = excluded.cpc,
          ctr = excluded.ctr,
          currency = excluded.currency,
          attribution_setting = excluded.attribution_setting,
          actions_raw = excluded.actions_raw,
          api_version = excluded.api_version,
          updated_at = now()
      `,
      [
        `mad_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        row.adAccountId,
        row.campaignId,
        row.campaignName,
        row.occurredOn,
        row.spend,
        row.clicks,
        row.inlineLinkClicks,
        row.landingPageViews,
        row.impressions,
        row.reach,
        row.cpm,
        row.cpc,
        row.ctr,
        row.currency,
        row.attributionSetting,
        JSON.stringify(row.actionsRaw ?? {}),
        row.apiVersion
      ]
    );
    await writeLineage(
      tx,
      request,
      "meta_ads_campaign_daily",
      `${row.adAccountId}:${row.campaignId}:${row.occurredOn}`,
      rawIds[index]
    );
    await writeMetaAdsConversionRows(tx, request, row, rawIds[index]);
  }
}

// §2.3 / §4c — fan the derived child conversion rows into
// meta_ads_campaign_conversions_daily. Each row is upserted on
// (source_id, ad_account_id, campaign_id, occurred_on, result_type) so a re-sync
// restates results/conversion_value last-write-wins. result_type travels on every
// row (the REQUIRED partition) so CPL/CPA never blend.
async function writeMetaAdsConversionRows(
  tx: InfiniteOsDb,
  request: SyncRequest,
  row: MetaAdsCampaignDailyRow,
  rawRecordId: string
): Promise<void> {
  for (const conversion of row.conversions) {
    await tx.query(
      `
        insert into meta_ads_campaign_conversions_daily (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id,
          occurred_on, result_type, results, conversion_value, attribution_setting,
          is_primary, results_source
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict (source_id, ad_account_id, campaign_id, occurred_on, result_type)
        do update set
          raw_record_id = excluded.raw_record_id,
          results = excluded.results,
          conversion_value = excluded.conversion_value,
          attribution_setting = excluded.attribution_setting,
          is_primary = excluded.is_primary,
          results_source = excluded.results_source,
          updated_at = now()
      `,
      [
        `madc_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawRecordId,
        row.adAccountId,
        row.campaignId,
        row.occurredOn,
        conversion.resultType,
        conversion.results,
        conversion.conversionValue,
        conversion.attributionSetting,
        conversion.isPrimary,
        conversion.resultsSource
      ]
    );
    await writeLineage(
      tx,
      request,
      "meta_ads_campaign_conversions_daily",
      `${row.adAccountId}:${row.campaignId}:${row.occurredOn}:${conversion.resultType}`,
      rawRecordId
    );
  }
}

async function writeLineage(
  tx: InfiniteOsDb,
  request: SyncRequest,
  providerTable: string,
  providerRowId: string,
  rawRecordId: string
): Promise<void> {
  await tx.query(
    `
      insert into record_lineage (
        id, workspace_id, canonical_table, canonical_id, provider,
        provider_table, provider_row_id, raw_record_id, normalization_version
      )
      values ($1,$2,$3,$4,$5,$3,$4,$6,'live-v1')
      on conflict (workspace_id, provider_table, provider_row_id, raw_record_id)
      do update set normalization_version = excluded.normalization_version
    `,
    [`lineage_${randomUUID()}`, request.workspaceId, providerTable, providerRowId, request.provider, rawRecordId]
  );
}

function ga4BaseUrl(credential: Ga4Credential): string {
  return credential.apiBaseUrl ?? "https://analyticsdata.googleapis.com/v1beta";
}

function ga4PropertyPath(propertyId: string): string {
  return propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
}

// Report A (overview) parser. Reads dimensionValues/metricValues positionally by the
// KNOWN index of this request's field order (see extractLive above):
//   dims:    [date, country, landingPagePlusQueryString, sessionSource, sessionMedium,
//             sessionCampaignName, sessionDefaultChannelGroup, hostName, deviceCategory]
//             (pageReferrer was dropped — GA4 caps runReport at 9 dimensions and referrer
//             is not part of the storage unique key; it is stored as "(not set)".)
//   metrics: [sessions, activeUsers, totalUsers, newUsers, screenPageViews,
//             engagedSessions, engagementRate, averageSessionDuration, keyEvents]
function ga4OverviewRow(row: Ga4RunReportRow): Ga4Row {
  const dimensions = (row.dimensionValues ?? []).map((value) => value.value ?? "");
  const metric = (index: number) => row.metricValues?.[index]?.value;
  const reportingDate = dimensions[0]?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || daysAgo(0);
  return {
    kind: "overview",
    externalId: `ga4:${dimensions.join(":")}`,
    reportingDate,
    country: dimensions[1] || "unknown",
    landingPage: dimensions[2] || "(not set)",
    referrer: "(not set)",
    utmSource: dimensions[3] || "(not set)",
    utmMedium: dimensions[4] || "(not set)",
    utmCampaign: dimensions[5] || "(not set)",
    sessionDefaultChannelGroup: dimensions[6] || "(not set)",
    hostName: dimensions[7] || "(not set)",
    deviceCategory: dimensions[8] || "(not set)",
    sessions: integerOrZero(metric(0)),
    activeUsers: integerOrZero(metric(1)),
    totalUsers: integerOrZero(metric(2)),
    newUsers: integerOrZero(metric(3)),
    screenPageViews: integerOrZero(metric(4)),
    engagedSessions: integerOrZero(metric(5)),
    engagementRate: numberOrZero(metric(6)),
    averageSessionDuration: numberOrZero(metric(7)),
    keyEvents: integerOrZero(metric(8))
  };
}

// Report C (page-level) parser. Reads dimensionValues/metricValues positionally by
// THIS request's field order:
//   dims:    [date, hostName, pagePath, pageTitle]
//   metrics: [screenPageViews, sessions, engagedSessions, averageSessionDuration,
//             keyEvents]
function ga4PageRow(row: Ga4RunReportRow): Ga4PageRow {
  const dimensions = (row.dimensionValues ?? []).map((value) => value.value ?? "");
  const metric = (index: number) => row.metricValues?.[index]?.value;
  const reportingDate = dimensions[0]?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || daysAgo(0);
  return {
    kind: "page",
    externalId: `ga4_page:${dimensions.join(":")}`,
    reportingDate,
    hostName: dimensions[1] || "(not set)",
    pagePath: dimensions[2] || "(not set)",
    pageTitle: dimensions[3] || "(not set)",
    screenPageViews: integerOrZero(metric(0)),
    sessions: integerOrZero(metric(1)),
    engagedSessions: integerOrZero(metric(2)),
    averageSessionDuration: numberOrZero(metric(3)),
    keyEvents: integerOrZero(metric(4))
  };
}

// keyEvents → conversions fallback. `fetchJson` THROWS on non-2xx (incl. 400), so we
// cannot inspect the status — we wrap the call in try/catch and string-match the error
// message (which embeds the GA4 400 body via responseSafeDetail) for an invalid
// `keyEvents` metric. On match, retry the SAME report with `conversions` substituted at
// the keyEvents metric index, then re-label the response metric header back to
// `keyEvents` so the positional parser maps it into the keyEvents field. We do NOT call
// getMetadata per sync (extra quota) — the fallback is cheaper and self-healing.
async function runGa4ReportWithKeyEventsFallback(
  reportUrl: string,
  accessToken: string,
  requestBody: Ga4RunReportRequest,
  keyEventsMetricIndex: number
): Promise<Ga4RunReportResponse> {
  try {
    return await fetchJson<Ga4RunReportResponse>(reportUrl, {
      method: "POST",
      headers: bearerHeaders(accessToken),
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    if (!isInvalidKeyEventsError(error)) {
      throw error;
    }
    const fallbackMetrics = requestBody.metrics.map((entry, index) =>
      index === keyEventsMetricIndex ? { name: "conversions" } : entry
    );
    console.warn(
      "[ga4] keyEvents metric rejected (400); retrying report with conversions and mapping into keyEvents"
    );
    return fetchJson<Ga4RunReportResponse>(reportUrl, {
      method: "POST",
      headers: bearerHeaders(accessToken),
      body: JSON.stringify({ ...requestBody, metrics: fallbackMetrics })
    });
  }
}

function isInvalidKeyEventsError(error: unknown): boolean {
  if (!(error instanceof ConnectorError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  // The GA4 400 body names the offending metric; only retry when it's keyEvents.
  return (
    (error.code === "provider_api_error" || message.includes("400")) &&
    message.includes("keyevents")
  );
}

async function posthogQuery<T>(
  credential: PostHogCredential,
  projectId: string,
  authToken: string,
  query: string,
  values: Record<string, unknown>
): Promise<T> {
  const response = await fetchJson<PostHogQueryResponse<T>>(
    `${posthogHost(credential)}/api/projects/${projectId}/query/`,
    {
      method: "POST",
      headers: bearerHeaders(authToken),
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query,
          values
        }
      })
    }
  );
  return normalizePostHogQueryResults<T>(response);
}

function normalizePostHogQueryResults<T>(response: PostHogQueryResponse<T>): T {
  const results = response.results;
  const columns = (response.columns ?? []).map((column) =>
    typeof column === "string"
      ? column
      : typeof column.name === "string"
        ? column.name
        : typeof column.key === "string"
          ? column.key
          : ""
  );
  if (
    Array.isArray(results) &&
    results.every((row) => Array.isArray(row)) &&
    columns.some((column) => column !== "")
  ) {
    return results.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column || `column_${index}`, row[index]]))
    ) as T;
  }
  return results;
}

function posthogDateTimeLiteral(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ConnectorError("provider_api_error", `invalid PostHog cursor timestamp: ${value}`, false);
  }
  return `toDateTime('${date.toISOString().slice(0, 19).replace("T", " ")}')`;
}

function posthogHost(credential: PostHogCredential): string {
  return credential.apiHost ?? "https://app.posthog.com";
}

function posthogAuthToken(credential: PostHogCredential): string {
  if (typeof credential.personalApiKey === "string" && credential.personalApiKey.trim() !== "") {
    return credential.personalApiKey;
  }
  if (typeof credential.accessToken === "string" && credential.accessToken.trim() !== "") {
    return credential.accessToken;
  }
  throw new Error("PostHog credentials require either personalApiKey or accessToken");
}

function posthogEventRow(row: PostHogQueryRow): PostHogEventRow {
  const properties = posthogProperties(row.properties);
  const personId = String(row.person_id ?? properties.person_id ?? row.distinct_id ?? "unknown_person");
  const sessionId = String(properties.$session_id ?? properties.session_id ?? `${row.distinct_id}:${row.timestamp}`);
  return {
    externalId: `posthog:${row.uuid}`,
    eventId: String(row.uuid),
    eventName: String(row.event),
    distinctId: String(row.distinct_id ?? personId),
    personId,
    sessionId,
    email: stringOrNull(properties.email),
    occurredAt: isoFromUnknown(row.timestamp),
    landingPage: stringOrNull(properties.$current_url ?? properties.landing_page),
    referrer: stringOrNull(properties.$referrer ?? properties.referrer),
    utmSource: stringOrNull(properties.utm_source ?? properties.$utm_source),
    utmMedium: stringOrNull(properties.utm_medium ?? properties.$utm_medium),
    utmCampaign: stringOrNull(properties.utm_campaign ?? properties.$utm_campaign),
    properties
  };
}

function posthogProperties(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function stripeGet<T>(
  credential: StripeCredential,
  secretKey: string,
  path: string,
  params: Record<string, string | string[]>
): Promise<T> {
  const url = new URL(`${credential.apiBaseUrl ?? "https://api.stripe.com"}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return fetchJson<T>(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`
    }
  });
}

async function stripeList<T>(
  credential: StripeCredential,
  secretKey: string,
  path: string,
  params: Record<string, string | string[]>
): Promise<T[]> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const response = await stripeGet<StripeListResponse<T>>(credential, secretKey, path, {
      ...params,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    items.push(...(response.data ?? []));
    if (!response.has_more || !response.data.length) {
      return items;
    }
    startingAfter = String((response.data[response.data.length - 1] as { id?: string }).id);
  }
}

async function stripeInvoiceLines(
  credential: StripeCredential,
  secretKey: string,
  invoice: StripeInvoiceApi
): Promise<StripeInvoiceLineApi[]> {
  const inline = invoice.lines?.data ?? [];
  if (!invoice.lines?.has_more) {
    return inline;
  }
  return stripeList<StripeInvoiceLineApi>(credential, secretKey, `/v1/invoices/${invoice.id}/lines`, {
    limit: "100"
  });
}

function stripeInvoiceRow(invoice: StripeInvoiceApi, lines: StripeInvoiceLineApi[]): StripeInvoiceRow {
  const customer = objectOrString(invoice.customer);
  const subscription = objectOrString(invoice.subscription);
  return {
    externalId: `stripe:${invoice.id}`,
    invoiceId: invoice.id,
    customerId: customer.id ?? String(invoice.customer ?? ""),
    customerEmail: stringOrNull(customer.email),
    customerName: stringOrNull(customer.name),
    subscriptionId: subscription.id ?? stringOrNull(invoice.subscription),
    currency: invoice.currency ?? "usd",
    amountPaid: Number(invoice.amount_paid ?? 0),
    amountDue: Number(invoice.amount_due ?? 0),
    paidAt: invoice.status_transitions?.paid_at ? unixToIso(invoice.status_transitions.paid_at) : null,
    createdAt: unixToIso(invoice.created),
    periodEnd: typeof subscription.current_period_end === "number" ? unixToIso(subscription.current_period_end) : null,
    externalOrderId: stringOrNull(invoice.metadata?.external_order_id ?? invoice.metadata?.order_id),
    lines: lines.map((line) => stripeInvoiceLineRow(line))
  };
}

function stripeInvoiceLineRow(line: StripeInvoiceLineApi): StripeInvoiceLineRow {
  const price = objectOrString(line.price ?? line.pricing?.price_details?.price);
  const product = objectOrString(price.product ?? line.pricing?.price_details?.product);
  return {
    lineId: line.id,
    productId: product.id ?? stringOrNull(price.product ?? line.pricing?.price_details?.product),
    productName: stringOrNull(product.name ?? line.description),
    priceId: price.id ?? stringOrNull(line.pricing?.price_details?.price),
    amountCents: Number(line.amount ?? line.amount_excluding_tax ?? 0),
    periodStart: line.period?.start ? unixToIso(line.period.start) : null,
    periodEnd: line.period?.end ? unixToIso(line.period.end) : null
  };
}

async function xResolveUser(credential: XCredential, bearerToken: string): Promise<XUser> {
  const username = typeof credential.username === "string" ? credential.username.replace(/^@/, "") : undefined;
  if (username) {
    const response = await fetchJson<XUserLookupResponse>(
      `${xBaseUrl(credential)}/2/users/by/username/${encodeURIComponent(username)}?user.fields=username,public_metrics`,
      {
        method: "GET",
        headers: bearerHeaders(bearerToken)
      }
    );
    if (!response.data?.id) {
      throw new ConnectorError("provider_auth_failed", `X username not found: ${username}`, false);
    }
    return response.data;
  }
  const userId = requireCredential(credential, "userId");
  const response = await fetchJson<XUserLookupResponse>(
    `${xBaseUrl(credential)}/2/users/${encodeURIComponent(userId)}?user.fields=username,public_metrics`,
    {
      method: "GET",
      headers: bearerHeaders(bearerToken)
    }
  );
  if (!response.data?.id) {
    throw new ConnectorError("provider_auth_failed", `X user id not found: ${userId}`, false);
  }
  return response.data;
}

async function xTimelinePosts(
  credential: XCredential,
  bearerToken: string,
  user: XUser,
  plan: SyncPlan
): Promise<XPostRow[]> {
  const posts: XPostRow[] = [];
  const maxPages = Math.max(1, Math.min(Number(credential.maxPages ?? 1), 10));
  let paginationToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${xBaseUrl(credential)}/2/users/${encodeURIComponent(user.id)}/tweets`);
    url.searchParams.set("max_results", "100");
    url.searchParams.set("tweet.fields", "author_id,conversation_id,created_at,public_metrics");
    url.searchParams.set("start_time", cursorStartIso(plan));
    if (paginationToken) {
      url.searchParams.set("pagination_token", paginationToken);
    }
    const response = await fetchJson<XTimelineResponse>(url.toString(), {
      method: "GET",
      headers: bearerHeaders(bearerToken)
    });
    posts.push(...(response.data ?? []).map((post) => xPostRow(post, user, plan.cursorEnd)));
    paginationToken = response.meta?.next_token;
    if (!paginationToken) {
      return posts;
    }
  }
  return posts;
}

function xPostRow(post: XApiPost, user: XUser, capturedAt: string): XPostRow {
  const metrics = post.public_metrics ?? {};
  const userMetrics = user.public_metrics ?? {};
  return {
    externalId: `x:${post.id}`,
    postId: post.id,
    authorId: post.author_id ?? user.id,
    conversationId: stringOrNull(post.conversation_id),
    postUrl: `https://x.com/${user.username ?? "i"}/status/${post.id}`,
    bodyText: post.text,
    publishedAt: post.created_at ? new Date(post.created_at).toISOString() : null,
    capturedAt,
    publicMetrics: {
      retweetCount: Number(metrics.retweet_count ?? 0),
      replyCount: Number(metrics.reply_count ?? 0),
      likeCount: Number(metrics.like_count ?? 0),
      quoteCount: Number(metrics.quote_count ?? 0),
      bookmarkCount: Number(metrics.bookmark_count ?? 0),
      impressionCount: Number(metrics.impression_count ?? 0)
    },
    profileSnapshot: {
      userId: user.id,
      username: stringOrNull(user.username),
      capturedAt,
      publicMetrics: {
        followersCount: Number(userMetrics.followers_count ?? 0),
        followingCount: Number(userMetrics.following_count ?? 0),
        tweetCount: Number(userMetrics.tweet_count ?? 0),
        listedCount: Number(userMetrics.listed_count ?? 0),
        likeCount: Number(userMetrics.like_count ?? 0)
      }
    }
  };
}

async function persistXProfileSnapshot(
  db: InfiniteOsDb,
  request: SyncRequest,
  user: XUser,
  capturedAt: string
): Promise<void> {
  const userMetrics = user.public_metrics ?? {};
  await db.query(
    `
      insert into x_profile_snapshot (
        id, workspace_id, source_id, captured_at, x_user_id, username,
        followers_count, following_count, tweet_count, listed_count,
        like_count, public_metrics
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      on conflict (source_id, captured_at)
      do update set x_user_id = excluded.x_user_id,
        username = excluded.username,
        followers_count = excluded.followers_count,
        following_count = excluded.following_count,
        tweet_count = excluded.tweet_count,
        listed_count = excluded.listed_count,
        like_count = excluded.like_count,
        public_metrics = excluded.public_metrics
    `,
    [
      `xps_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      capturedAt,
      user.id,
      stringOrNull(user.username),
      Number(userMetrics.followers_count ?? 0),
      Number(userMetrics.following_count ?? 0),
      Number(userMetrics.tweet_count ?? 0),
      Number(userMetrics.listed_count ?? 0),
      Number(userMetrics.like_count ?? 0),
      JSON.stringify({
        followersCount: Number(userMetrics.followers_count ?? 0),
        followingCount: Number(userMetrics.following_count ?? 0),
        tweetCount: Number(userMetrics.tweet_count ?? 0),
        listedCount: Number(userMetrics.listed_count ?? 0),
        likeCount: Number(userMetrics.like_count ?? 0)
      })
    ]
  );
}

function xBaseUrl(credential: XCredential): string {
  return credential.apiBaseUrl ?? "https://api.x.com";
}

function shopifyApiVersion(credential: ShopifyCredential): string {
  return credential.apiVersion ?? "2026-01";
}

function shopifyGraphqlUrl(credential: ShopifyCredential): string {
  const storeDomain = normalizedShopifyStoreDomain(requireCredential(credential, "storeDomain"));
  return `https://${storeDomain}/admin/api/${shopifyApiVersion(credential)}/graphql.json`;
}

async function shopifyGraphql<T>(
  credential: ShopifyCredential,
  adminAccessToken: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetchJson<{ data?: T; errors?: Array<{ message?: string }> }>(shopifyGraphqlUrl(credential), {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": adminAccessToken
    },
    body: JSON.stringify({ query, variables })
  });
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new ConnectorError(
      "provider_api_error",
      response.errors.map((error) => error.message || "unknown Shopify GraphQL error").join("; "),
      true
    );
  }
  if (!response.data) {
    throw new ConnectorError("provider_api_error", "Shopify GraphQL response missing data", true);
  }
  return response.data;
}

function shopifySearchTimestamp(value: string): string {
  return value.replace(/\.\d{3}Z$/, "Z");
}

function normalizedShopifyStoreDomain(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== "https:") {
    throw new ConnectorError("provider_auth_failed", "Shopify store domain must use https", false);
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new ConnectorError("provider_auth_failed", "Shopify store domain cannot include credentials or a port", false);
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new ConnectorError("provider_auth_failed", "Shopify store domain must be a bare store hostname", false);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(hostname)) {
    throw new ConnectorError("provider_auth_failed", "Shopify store domain must be a valid *.myshopify.com hostname", false);
  }
  return hostname;
}

async function shopifyAllOrderLineItems(
  credential: ShopifyCredential,
  adminAccessToken: string,
  node: ShopifyOrderNode
): Promise<ShopifyLineItemNode[]> {
  const initialEdges = node.lineItems?.edges ?? [];
  const lines = initialEdges
    .map((edge) => edge?.node)
    .filter((line): line is ShopifyLineItemNode => Boolean(line?.id));
  let cursor = node.lineItems?.pageInfo?.endCursor ?? null;
  let hasNextPage = Boolean(node.lineItems?.pageInfo?.hasNextPage);
  while (hasNextPage && node.id) {
    const response: ShopifyOrderLineItemsResponse = await shopifyGraphql<ShopifyOrderLineItemsResponse>(
      credential,
      adminAccessToken,
      `
        query InfiniteOsShopifyOrderLineItems($orderId: ID!, $cursor: String) {
          order(id: $orderId) {
            lineItems(first: 100, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  sku
                  quantity
                  name
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  product {
                    id
                    title
                    vendor
                    productType
                    status
                  }
                  variant {
                    id
                  }
                }
              }
            }
          }
        }
      `,
      { orderId: node.id, cursor }
    );
    const nextEdges = response.order?.lineItems?.edges ?? [];
    lines.push(
      ...nextEdges
        .map((edge) => edge?.node)
        .filter((line): line is ShopifyLineItemNode => Boolean(line?.id))
    );
    hasNextPage = Boolean(response.order?.lineItems?.pageInfo?.hasNextPage);
    cursor = response.order?.lineItems?.pageInfo?.endCursor ?? null;
  }
  return lines;
}

function shopifyOrderRow(node: ShopifyOrderNode, lineNodes?: ShopifyLineItemNode[]): ShopifyOrderRow {
  const orderId = node.id ?? "unknown_shopify_order";
  const subtotal = moneyAmountMinor(node.currentSubtotalPriceSet?.shopMoney?.amount);
  const totalTax = moneyAmountMinor(node.currentTotalTaxSet?.shopMoney?.amount);
  const totalDiscount = moneyAmountMinor(node.currentTotalDiscountsSet?.shopMoney?.amount);
  const totalPrice = moneyAmountMinor(node.currentTotalPriceSet?.shopMoney?.amount);
  const currency =
    node.currentTotalPriceSet?.shopMoney?.currencyCode
    ?? node.currentSubtotalPriceSet?.shopMoney?.currencyCode
    ?? "USD";
  const lineItems = (lineNodes ?? [])
    .map((line) => {
      const priceAmount = moneyAmountMinor(line.originalUnitPriceSet?.shopMoney?.amount);
      return {
        lineItemId: line.id ?? "unknown_shopify_line_item",
        orderId,
        productId: stringOrNull(line.product?.id),
        variantId: stringOrNull(line.variant?.id),
        title: line.product?.title ?? line.name ?? "Untitled product",
        sku: stringOrNull(line.sku),
        quantity: Number(line.quantity ?? 0),
        priceAmount,
        lineTotalAmount: priceAmount * Number(line.quantity ?? 0),
        vendor: stringOrNull(line.product?.vendor),
        productType: stringOrNull(line.product?.productType),
        status: stringOrNull(line.product?.status)
      };
    });
  return {
    kind: "order",
    externalId: `shopify:${orderId}`,
    orderId,
    orderName: node.name ?? orderId,
    customerId: stringOrNull(node.customer?.id),
    customerEmail: stringOrNull(node.customer?.email),
    currency,
    financialStatus: stringOrNull(node.displayFinancialStatus),
    fulfillmentStatus: stringOrNull(node.displayFulfillmentStatus),
    subtotalPriceAmount: subtotal,
    totalTaxAmount: totalTax,
    totalDiscountAmount: totalDiscount,
    totalPriceAmount: totalPrice,
    occurredOn: (node.processedAt ?? node.createdAt ?? new Date().toISOString()).slice(0, 10),
    createdAt: isoFromUnknown(node.createdAt),
    processedAt: node.processedAt ? isoFromUnknown(node.processedAt) : null,
    lineItems
  };
}

function shopifyProductRow(node: ShopifyProductNode): ShopifyProductSnapshotRow {
  const productId = node.id ?? "unknown_shopify_product";
  return {
    kind: "product",
    externalId: `shopify_product:${productId}`,
    productId,
    title: node.title ?? "Untitled product",
    vendor: stringOrNull(node.vendor),
    productType: stringOrNull(node.productType),
    status: stringOrNull(node.status),
    createdAt: isoFromUnknown(node.createdAt),
    updatedAt: isoFromUnknown(node.updatedAt ?? node.createdAt)
  };
}

function moneyAmountMinor(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function metaAdsAccountId(credential: MetaAdsCredential): string {
  const value = requireCredential(credential, "adAccountId").replace(/^act_/, "");
  return `act_${value}`;
}

function isMetaAdsMcpTransport(credential: MetaAdsCredential): boolean {
  return credential.transport === "mcp_stdio" || credential.transport === "mcp";
}

function isMetaAdsCliTransport(credential: MetaAdsCredential): boolean {
  return credential.transport === "meta_ads_cli" || credential.transport === "cli";
}

// Default anchored to v25.0 to match the bundled facebook_business v25.0.1 SDK
// that the captured WRITE shapes were recovered from. Configurable per-credential.
function metaAdsApiVersion(credential: MetaAdsCredential): string {
  return credential.apiVersion ?? "v25.0";
}

// Meta Ads insights grain defaults. Phase 0 plumbing: `level` + `time_increment` are
// now resolved through these constants instead of being hardcoded inline at each call
// site, so a later phase can request adset/ad grain or a non-daily increment by passing
// overrides on the SyncRequest. The DEFAULTS reproduce today's behavior EXACTLY
// (campaign grain, daily increment), so with no override the emitted insights request is
// byte-for-byte identical to before this change.
const META_ADS_INSIGHTS_DEFAULT_LEVEL = "campaign";
const META_ADS_INSIGHTS_DEFAULT_TIME_INCREMENT = "1";

// §4 — the SINGLE source of truth for the insights field list, hoisted so all three
// transports (direct Graph, MCP, CLI) request EXACTLY the same fields. Previously the
// list was duplicated inline at each call site; any drift between transports is a bug.
//
// Added in Phase 1 (§4): inline_link_clicks, actions, action_values, results,
// cost_per_result, result_values_performance_indicator (the result_type source string),
// frequency, objective (campaign), optimization_goal (adset). We deliberately do NOT
// request `landing_page_view_actions` (not a real field → API error); landing page views
// are extracted from actions[action_type='landing_page_view'] (NON-omni) instead.
//
// account_currency (§2.1, LOAD-BEARING): the ad-account currency is read from each
// insights row's `account_currency` field (a valid Insights field that the API only
// returns when explicitly requested). It populates meta_ads_campaign_daily.currency AND
// the meta_ads_campaigns dimension; it is the reconciliation axis for the Meta↔Stripe
// value join (§5). Without it in this list, currency is ALWAYS null in live mode and the
// Stripe ROAS join can never reconcile a currency — so it MUST be requested here.
const META_ADS_INSIGHTS_FIELDS = [
  "campaign_id",
  "campaign_name",
  "date_start",
  "spend",
  "clicks",
  "inline_link_clicks",
  "impressions",
  "reach",
  "frequency",
  "cpm",
  "cpc",
  "ctr",
  "actions",
  "action_values",
  "results",
  "cost_per_result",
  "result_values_performance_indicator",
  "objective",
  "optimization_goal",
  "account_currency"
].join(",");

// §4 — the smaller field set used only by the connectivity probe (testLive). It does
// NOT need the conversion fields; keep it minimal so the probe stays cheap.
const META_ADS_INSIGHTS_PROBE_FIELDS = "campaign_id,date_start,impressions,clicks,spend";

// §4 / §7 — attribution reality post-Jan-2026. Request the three windows whose
// per-window subvalues we sum into the headline (7d_click + 1d_view). We HARD-EXCLUDE
// 7d_view / 28d_view (removed Jan 2026 → silent empty), and we do NOT send
// use_unified_attribution_setting or action_report_time (both no-ops post-2026-01-12).
// The element `value` field on each actions[]/action_values[] entry is 7d_click ONLY —
// the headline must be COMPUTED as element['7d_click'] + element['1d_view'].
const META_ADS_ATTRIBUTION_WINDOWS = ["1d_click", "7d_click", "1d_view"] as const;

// The attribution_setting string we persist describing the REQUEST shape (provenance,
// not a lever). Matches the windows we send.
const META_ADS_ATTRIBUTION_SETTING = META_ADS_ATTRIBUTION_WINDOWS.join(",");

// ──────────────────────────────────────────────────────────────────────────────────
// §4b — Objective → canonical-event mapping (the load-bearing artifact).
//
// Committed as code/config because it is OUR deterministic control point: the headline
// conversion number is THIS mapping applied to actions[] — we NEVER sum actions[]
// variants (the §0 Ultima trap: the same 2 leads appeared under 4 action_types; summing
// gives 8). We pick exactly ONE canonical action_type per (campaign, result_type) and
// derive both the COUNT (from actions[]) and the VALUE (from action_values[]) from the
// SAME channel.
//
// PRECEDENCE (§4b): key on the adset `optimization_goal` FIRST (the real driver of
// result_type), then fall back to the campaign `objective` (ODAX = 6 outcomes). Within a
// resolved entry, the `primary` action_type is tried first; `fallbacks` are
// SAME-POPULATION variants only — NEVER omni_* (a different population: web+app+offline,
// not a duplicate). The first action_type present in actions[] wins; we stop there.
//
// `resultType` is the canonical conversion type label stored on the child fact. `value`
// flags whether a conversion_value is meaningful for this type (purchase-only guard,
// §2.3): a configured lead value must NOT be stored as revenue.
interface MetaCanonicalEventRule {
  resultType: string;
  // Ordered: primary first, then SAME-POPULATION fallbacks. NEVER omni_*.
  actionTypes: string[];
  // Whether conversion_value is meaningful for this result type (purchase-only).
  value: boolean;
}

// Keyed by adset optimization_goal (uppercase, as Meta returns it).
const META_OPTIMIZATION_GOAL_RULES: Record<string, MetaCanonicalEventRule> = {
  LEAD_GENERATION: {
    resultType: "lead",
    // Same-population lead variants; the Ultima 4-action_types collapse to ONE of these.
    actionTypes: ["lead", "offsite_conversion.fb_pixel_lead", "onsite_web_lead"],
    value: false
  },
  // OFFSITE_CONVERSIONS with custom_event=PURCHASE → pixel purchase. Count AND value come
  // from offsite_conversion.fb_pixel_purchase (same channel). NEVER omni_purchase.
  OFFSITE_CONVERSIONS: {
    resultType: "purchase",
    actionTypes: ["offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"],
    value: true
  },
  LANDING_PAGE_VIEWS: {
    resultType: "landing_page_view",
    // Non-omni: omni_landing_page_view is a broader population, excluded.
    actionTypes: ["landing_page_view"],
    value: false
  },
  LINK_CLICKS: {
    resultType: "link_click",
    actionTypes: ["link_click"],
    value: false
  }
};

// Coarse fallback keyed by campaign objective (ODAX, 6 outcomes) when optimization_goal
// is absent. Same action_type drives BOTH count and value.
const META_OBJECTIVE_RULES: Record<string, MetaCanonicalEventRule | null> = {
  OUTCOME_LEADS: { resultType: "lead", actionTypes: ["lead"], value: false },
  OUTCOME_SALES: {
    resultType: "purchase",
    actionTypes: ["offsite_conversion.fb_pixel_purchase"],
    value: true
  },
  OUTCOME_TRAFFIC: { resultType: "link_click", actionTypes: ["link_click"], value: false },
  OUTCOME_ENGAGEMENT: {
    resultType: "post_engagement",
    actionTypes: ["post_engagement"],
    value: false
  },
  // Awareness has no conversion event (reach/impressions only) — no canonical result.
  OUTCOME_AWARENESS: null,
  OUTCOME_APP_PROMOTION: {
    resultType: "mobile_app_install",
    actionTypes: ["mobile_app_install"],
    value: false
  }
};

// Resolve the canonical-event rule for a row: optimization_goal (adset) FIRST, then
// objective (campaign). Returns null when the objective is awareness (no conversion) or
// nothing matches.
function metaCanonicalEventRule(
  optimizationGoal: string | null,
  objective: string | null
): MetaCanonicalEventRule | null {
  const goalKey = optimizationGoal?.toUpperCase();
  if (goalKey && goalKey in META_OPTIMIZATION_GOAL_RULES) {
    return META_OPTIMIZATION_GOAL_RULES[goalKey];
  }
  const objectiveKey = objective?.toUpperCase();
  if (objectiveKey && objectiveKey in META_OBJECTIVE_RULES) {
    return META_OBJECTIVE_RULES[objectiveKey];
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────────
// §4 — actions[]/action_values[] parsing (deterministic, never sum variants).
//
// Each element looks like { action_type, value, '1d_click'?, '7d_click'?, '1d_view'? }.
// The element-level `value` is 7d_click ONLY (post-Jan-2026); the headline window we
// compute is 7d_click + 1d_view from the per-window subvalues. If subvalues are absent
// (older payloads), we fall back to the element `value`.

interface MetaActionElement {
  action_type?: string | null;
  value?: string | number | null;
  "1d_click"?: string | number | null;
  "7d_click"?: string | number | null;
  "1d_view"?: string | number | null;
  [key: string]: unknown;
}

// Compute the headline (7d_click + 1d_view) for one action element. Per-window
// subvalues are summed; if neither subvalue is present we fall back to `value`
// (which is 7d_click only) so we never lose the count entirely.
function metaHeadlineWindowValue(element: MetaActionElement): number {
  const sevenDayClick = element["7d_click"];
  const oneDayView = element["1d_view"];
  if (sevenDayClick !== undefined || oneDayView !== undefined) {
    return numberOrZero(sevenDayClick) + numberOrZero(oneDayView);
  }
  return numberOrZero(element.value);
}

// Find the FIRST action element whose action_type is in `actionTypes` (precedence
// order). Returns the matched element — we STOP at the first match and never sum across
// variants (the Ultima trap). Returns null when none of the canonical action types are
// present.
function metaPickCanonicalAction(
  actions: MetaActionElement[] | undefined | null,
  actionTypes: string[]
): MetaActionElement | null {
  if (!Array.isArray(actions)) {
    return null;
  }
  for (const actionType of actionTypes) {
    const match = actions.find((element) => element.action_type === actionType);
    if (match) {
      return match;
    }
  }
  return null;
}

// Sum the headline window value for a SPECIFIC action_type across the actions array
// (used for non-omni landing_page_view extraction). There is normally one element per
// action_type, but summing is safe because we filter to a single action_type first.
function metaSumActionType(
  actions: MetaActionElement[] | undefined | null,
  actionType: string
): number {
  if (!Array.isArray(actions)) {
    return 0;
  }
  return actions
    .filter((element) => element.action_type === actionType)
    .reduce((total, element) => total + metaHeadlineWindowValue(element), 0);
}

function metaInsightsActions(row: MetaAdsInsightsRow): MetaActionElement[] | null {
  return Array.isArray(row.actions) ? (row.actions as MetaActionElement[]) : null;
}

function metaInsightsActionValues(row: MetaAdsInsightsRow): MetaActionElement[] | null {
  return Array.isArray(row.action_values) ? (row.action_values as MetaActionElement[]) : null;
}

function metaInsightsResultsValue(row: MetaAdsInsightsRow): number | null {
  // Meta's `results` field is an array of objects, each with a `values` array of
  // { value } entries — the parallel "objective_results" family. We sum the values of
  // the first result element as the reconciliation cross-check count.
  const results = row.results;
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }
  const first = results[0] as { values?: Array<{ value?: string | number | null }> };
  if (!Array.isArray(first.values)) {
    return null;
  }
  const total = first.values.reduce((sum, entry) => sum + numberOrZero(entry?.value), 0);
  return Number.isFinite(total) ? total : null;
}

function metaInsightsReportedResultType(row: MetaAdsInsightsRow): string | null {
  // result_values_performance_indicator is Meta's own result_type source-of-truth
  // string (e.g. 'actions:offsite_conversion.fb_pixel_purchase'); strip the 'actions:'
  // prefix to get the bare action_type.
  const indicator = stringOrNull(
    row.result_values_performance_indicator as string | null | undefined
  );
  if (!indicator) {
    return null;
  }
  return indicator.replace(/^actions:/, "");
}

// Cross-check: does Meta's reported result indicator name an action_type that belongs
// to OUR canonical rule for this row? Used only to flag a meta_results fallback whose
// type we could NOT verify (so reconciliation drift is visible), never to relabel the
// stored result_type. When Meta reports no indicator we treat it as verified (nothing
// to contradict).
function metaResultTypeMatchesRule(
  row: MetaAdsInsightsRow,
  rule: MetaCanonicalEventRule
): boolean {
  const reported = metaInsightsReportedResultType(row);
  if (!reported) {
    return true;
  }
  return rule.actionTypes.includes(reported);
}

function metaAdsInsightsGrain(request: SyncRequest): {
  level: string;
  timeIncrement: string;
} {
  return {
    level: request.metaAdsInsightsLevel ?? META_ADS_INSIGHTS_DEFAULT_LEVEL,
    timeIncrement: request.metaAdsInsightsTimeIncrement ?? META_ADS_INSIGHTS_DEFAULT_TIME_INCREMENT
  };
}

function metaAdsTimeOptions(plan: SyncPlan): {
  datePreset?: string;
  timeRange?: { since: string; until: string };
} {
  if (plan.backfillWindow === "all_time") {
    return { datePreset: "maximum" };
  }
  return {
    timeRange: {
      since: cursorStartIso(plan).slice(0, 10),
      until: plan.cursorEnd.slice(0, 10)
    }
  };
}

function metaAdsInsightsUrl(
  credential: MetaAdsCredential,
  options: {
    adAccountId: string;
    fields: string;
    level: string;
    limit?: string;
    datePreset?: string;
    timeIncrement?: string;
    timeRange?: { since: string; until: string };
    // §4 — request per-window subvalues so the headline 7d_click+1d_view is computable.
    attributionWindows?: readonly string[];
  }
): string {
  const url = new URL(`https://graph.facebook.com/${metaAdsApiVersion(credential)}/${options.adAccountId}/insights`);
  url.searchParams.set("fields", options.fields);
  url.searchParams.set("level", options.level);
  if (options.limit) url.searchParams.set("limit", options.limit);
  if (options.datePreset) {
    url.searchParams.set("date_preset", options.datePreset);
  }
  if (options.timeIncrement) {
    url.searchParams.set("time_increment", options.timeIncrement);
  }
  if (options.timeRange) {
    url.searchParams.set("time_range", JSON.stringify(options.timeRange));
  }
  if (options.attributionWindows && options.attributionWindows.length > 0) {
    // 7d_view / 28d_view are hard-excluded (removed Jan 2026); use_unified_attribution_setting
    // and action_report_time are no-ops post-2026-01-12 and deliberately NOT sent.
    url.searchParams.set("action_attribution_windows", JSON.stringify([...options.attributionWindows]));
  }
  return url.toString();
}

interface MetaAdsInsightsContext {
  apiVersion: string;
  attributionSetting: string;
}

// §4 — derive the typed child conversion rows for one campaign-day from the raw
// actions[]/action_values[] arrays, using the §4b objective→canonical-event mapping.
//
// DETERMINISTIC, NEVER SUM VARIANTS: we resolve ONE canonical rule (optimization_goal
// first, then objective), pick the FIRST present action_type from its precedence list,
// and take the COUNT (from actions[]) and VALUE (from action_values[]) from that SAME
// action_type — the same pixel channel. This is what collapses the §0 Ultima 4
// action_types to a single result (2 leads, not 8).
//
// conversion_value is populated ONLY when the rule is value-bearing (purchase-type),
// per the §2.3 guard — a configured lead value is never stored as revenue.
function metaAdsConversionRows(
  row: MetaAdsInsightsRow,
  context: MetaAdsInsightsContext
): MetaAdsConversionRow[] {
  const rule = metaCanonicalEventRule(
    stringOrNull(row.optimization_goal),
    stringOrNull(row.objective)
  );
  if (!rule) {
    // Awareness / unmapped objective: no conversion result for this row.
    return [];
  }
  const actions = metaInsightsActions(row);
  const canonicalAction = metaPickCanonicalAction(actions, rule.actionTypes);
  if (!canonicalAction || !canonicalAction.action_type) {
    // The canonical event did not fire for this campaign-day; Meta's own results
    // field is the fallback so a blank actions[] does not null the headline.
    const metaResults = metaInsightsResultsValue(row);
    if (metaResults === null) {
      return [];
    }
    // Keep the result_type label consistent with the canonical mapping (clean labels
    // like 'lead'/'purchase'). Meta's result_values_performance_indicator is used only
    // as a cross-check (metaResultTypeMatchesRule), never as the stored label — mixing
    // raw action_type strings into result_type would fracture the REQUIRED partition.
    return [
      {
        resultType: rule.resultType,
        results: metaResults,
        conversionValue: null,
        attributionSetting: context.attributionSetting,
        isPrimary: true,
        // Distinguish a clean cross-check match from a type-mismatched fallback so a
        // reconciliation drift is visible in results_source.
        resultsSource: metaResultTypeMatchesRule(row, rule)
          ? "meta_results"
          : "meta_results_unverified_type"
      }
    ];
  }
  // Count from the SAME canonical channel (headline window = 7d_click + 1d_view).
  const results = metaHeadlineWindowValue(canonicalAction);
  // Value ONLY for purchase-type rules, from action_values[] of the SAME action_type.
  let conversionValue: number | null = null;
  if (rule.value) {
    const valueElement = metaPickCanonicalAction(
      metaInsightsActionValues(row),
      [canonicalAction.action_type]
    );
    conversionValue = valueElement ? metaHeadlineWindowValue(valueElement) : 0;
  }
  return [
    {
      resultType: rule.resultType,
      results,
      conversionValue,
      attributionSetting: context.attributionSetting,
      isPrimary: true,
      resultsSource: "derived_from_canonical_mapping"
    }
  ];
}

function metaAdsCampaignDailyRow(
  adAccountId: string,
  row: MetaAdsInsightsRow,
  context: MetaAdsInsightsContext
): MetaAdsCampaignDailyRow {
  const occurredOn = row.date_start ?? daysAgo(0);
  const actions = metaInsightsActions(row);
  // Landing page views from actions[action_type='landing_page_view'], NON-omni
  // (omni_landing_page_view is a broader population and is deliberately excluded).
  const landingPageViews = Math.round(metaSumActionType(actions, "landing_page_view"));
  return {
    externalId: `meta_ads:${adAccountId}:${row.campaign_id ?? "unknown"}:${occurredOn}`,
    adAccountId,
    campaignId: String(row.campaign_id ?? "unknown"),
    campaignName: stringOrNull(row.campaign_name),
    occurredOn,
    spend: numberOrZero(row.spend),
    clicks: integerOrZero(row.clicks),
    inlineLinkClicks: integerOrZero(row.inline_link_clicks),
    landingPageViews,
    impressions: integerOrZero(row.impressions),
    reach: integerOrZero(row.reach),
    cpm: numberOrNull(row.cpm),
    cpc: numberOrNull(row.cpc),
    ctr: numberOrNull(row.ctr),
    currency: stringOrNull(row.account_currency)?.toLowerCase() ?? null,
    attributionSetting: context.attributionSetting,
    apiVersion: context.apiVersion,
    // Persist the full actions[] + action_values[] for audit/recompute.
    actionsRaw: {
      actions: actions ?? [],
      action_values: metaInsightsActionValues(row) ?? []
    },
    objective: stringOrNull(row.objective),
    optimizationGoal: stringOrNull(row.optimization_goal),
    conversions: metaAdsConversionRows(row, context)
  };
}

async function metaAdsMcpInsights(
  credential: MetaAdsCredential,
  input: {
    adAccountId: string;
    fields: string;
    level: string;
    limit?: string;
    datePreset?: string;
    timeIncrement?: string;
    timeRange?: { since: string; until: string };
    after?: string;
    attributionWindows?: readonly string[];
  }
): Promise<MetaAdsInsightsResponse> {
  const mcpCommand = requireCredential(credential, "mcpCommand");
  const mcpToolName = credential.mcpToolName ? String(credential.mcpToolName) : undefined;
  const accessToken = metaAdsCliAccessToken(credential);
  const result = await callMcpToolOverStdio(
    mcpCommand,
    mcpToolName,
    {
      ad_account_id: input.adAccountId,
      level: input.level,
      fields: input.fields.split(","),
      limit: input.limit ? Number(input.limit) : undefined,
      date_preset: input.datePreset,
      time_increment: input.timeIncrement ? Number(input.timeIncrement) : undefined,
      time_range: input.timeRange,
      // §4 — MCP takes the windows as an array of enum strings (native shape).
      action_attribution_windows:
        input.attributionWindows && input.attributionWindows.length > 0
          ? [...input.attributionWindows]
          : undefined,
      after: input.after
    },
    {
      AD_ACCOUNT_ID: metaAdsCliAccountId(credential),
      ...(accessToken ? { ACCESS_TOKEN: accessToken } : {})
    }
  );
  return coerceMetaAdsInsightsResponse(result);
}

async function metaAdsCliInsights(
  credential: MetaAdsCredential,
  input: {
    fields: string;
    limit?: string;
    datePreset?: string;
    timeIncrement?: "daily" | "weekly" | "monthly" | "all_days";
    timeRange?: { since: string; until: string };
    attributionWindows?: readonly string[];
  }
): Promise<MetaAdsInsightsResponse> {
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    "insights",
    "get",
    "--fields",
    input.fields
  ];
  if (input.limit) {
    args.push("--limit", input.limit);
  }
  if (input.datePreset) {
    args.push("--date-preset", input.datePreset);
  }
  if (input.timeIncrement) {
    args.push("--time-increment", input.timeIncrement);
  }
  if (input.timeRange) {
    args.push("--since", input.timeRange.since, "--until", input.timeRange.until);
  }
  if (input.attributionWindows && input.attributionWindows.length > 0) {
    // §4 — CLI takes each window as a repeated --action-attribution-window flag.
    for (const window of input.attributionWindows) {
      args.push("--action-attribution-window", window);
    }
  }
  return coerceMetaAdsInsightsResponse(await callMetaAdsCliJson(credential, args));
}

function metaAdsPagingAfter(response: MetaAdsInsightsResponse): string | undefined {
  const cursorAfter = response.paging?.cursors?.after;
  if (cursorAfter) {
    return cursorAfter;
  }
  const next = response.paging?.next;
  if (!next) {
    return undefined;
  }
  try {
    const parsed = new URL(next);
    return parsed.searchParams.get("after") ?? undefined;
  } catch {
    throw new ConnectorError("provider_api_error", "Meta Ads MCP response included an unsupported pagination cursor", true);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Meta Ads WRITE / management block (PR #3, STAGE 1 — money-safety core).
//
// Direct Graph-API POST transport (the `marketing_api` path). Structured behind
// the existing `isMetaAdsCliTransport`/`isMetaAdsMcpTransport` switch so a CLI
// write transport can slot in later — for now writes ONLY run on the direct
// Graph path; CLI/MCP transports refuse the write with a non-retryable error.
//
// MONEY-SAFETY INVARIANTS enforced here (each has a regression test):
//  1. CREATE ALWAYS PAUSED — every create helper hard-codes status:"PAUSED" in
//     the POST body, ignores any caller-supplied status, and verifies the echoed
//     status === PAUSED (errors + flags a money-safety violation otherwise).
//  3. WRITES NON-RETRYABLE — `metaAdsGraphPost` does NOT inherit the read path's
//     retryable:true. Every create + every status transition surfaces as
//     retryable:false for ALL status codes (incl. 429/5xx). Reads (list/get)
//     keep the normal retryable taxonomy via `fetchJson`.
//  6. NEVER LOG TOKEN — token only ever rides in `bearerHeaders` (Authorization
//     header), never in the URL or a logged body. `safeUrlForLogs` strips query.
//
// The Graph payload SHAPES below were recovered from the bundled
// facebook_business v25.0.1 SDK + the meta CLI v1.0.1 compiled command binaries.
// Items marked [INFERRED] were not directly observed at runtime and carry the
// `// VERIFY against a real Meta sandbox capture before live use` comment.
// ───────────────────────────────────────────────────────────────────────────

export type MetaWriteEntity = "campaign" | "adset" | "ad" | "creative";
export type MetaEntityStatus = "ACTIVE" | "PAUSED";

const META_CREATE_STATUS = "PAUSED" as const;

// Edge under /act_{ad_account_id}/<edge> for each create. Confirmed-SDK edges.
const META_CREATE_EDGE: Record<MetaWriteEntity, string> = {
  campaign: "campaigns",
  adset: "adsets",
  creative: "adcreatives",
  ad: "ads"
};

// Graph node prefix for list/get reads (the plural edge per object, read off
// /act_{ad_account_id}/<edge>). Same literals as the create edges.
const META_READ_EDGE = META_CREATE_EDGE;

interface MetaGraphWriteResponse {
  id?: string | null;
  // Some create edges echo the resulting status (campaign/adset/ad). Creatives
  // have no status. We read it leniently for the create-never-ACTIVE guard.
  status?: string | null;
  effective_status?: string | null;
  [key: string]: unknown;
}

export interface MetaCampaignCreateInput {
  name: string;
  objective: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface MetaAdSetCreateInput {
  name: string;
  campaignId: string;
  optimizationGoal: string;
  billingEvent: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  bidAmount?: number;
  startTime?: string;
  endTime?: string;
  targetingCountries?: string[];
  pixelId?: string;
  customEventType?: string;
}

export interface MetaCreativeCreateInput {
  name: string;
  pageId: string;
  imageHash?: string;
  // Optional Instagram identity (object_story_spec.instagram_user_id).
  instagramUserId?: string;
  linkUrl?: string;
  body?: string;
  title?: string;
  description?: string;
  callToAction?: string;
}

export interface MetaAdCreateInput {
  name: string;
  adsetId: string;
  creativeId: string;
}

export interface MetaWriteResult {
  ok: boolean;
  id: string;
  // The status the entity is in after the call. For creates this MUST be PAUSED
  // (the guard throws otherwise) — surfaced so the action handler can audit it.
  status: MetaEntityStatus | null;
}

export interface MetaStatusResult {
  ok: boolean;
  id: string;
  status: MetaEntityStatus;
}

export interface MetaDeleteResult {
  ok: boolean;
  id: string;
  deleted: boolean;
}

// Form-encode a Graph WRITE payload. Meta's WRITE edges expect
// application/x-www-form-urlencoded: every NESTED object/array value is encoded
// as a JSON STRING in its own field (special_ad_categories, targeting,
// object_story_spec, promoted_object, creative …), scalars are sent verbatim.
// This mirrors the READ path's `url.searchParams.set("time_range",
// JSON.stringify(...))` convention. `null`/`undefined` fields are dropped.
function metaFormEncode(params: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "object") {
      // Nested object or array → JSON string in its own field.
      form.set(key, JSON.stringify(value));
    } else {
      // Scalar (string/number/boolean) → verbatim.
      form.set(key, String(value));
    }
  }
  return form;
}

// Core write transport. Mirrors `metaAdsInsightsUrl` + `bearerHeaders` but POSTs
// and — critically — translates EVERY non-2xx into a NON-retryable
// ConnectorError (retryable:false), regardless of status code. This is what
// keeps a money write off the worker's retry machinery. Token only in the
// Authorization header; never in the URL (the URL has no query at all here).
async function metaAdsGraphPost(
  credential: MetaAdsCredential,
  path: string,
  params: Record<string, unknown>
): Promise<MetaGraphWriteResponse> {
  return metaAdsGraphWrite(credential, "POST", path, params);
}

// Core write transport, shared by POST writes (create/status) and DELETE
// (delete). Critically, it translates EVERY non-2xx — and every network failure
// — into a NON-retryable ConnectorError (retryable:false) regardless of status
// code (INVARIANT 3). This keeps a money/cleanup write off the worker's retry
// machinery. Token only in the Authorization header; never in the URL. DELETE
// targets a node (`/{id}`) and sends no body; POST form-encodes its params.
async function metaAdsGraphWrite(
  credential: MetaAdsCredential,
  method: "POST" | "DELETE",
  path: string,
  params: Record<string, unknown>
): Promise<MetaGraphWriteResponse> {
  if (isMetaAdsCliTransport(credential) || isMetaAdsMcpTransport(credential)) {
    // A CLI/MCP write transport is a deliberate later add. Until then refuse
    // loudly and non-retryably rather than silently dropping a money write.
    throw new ConnectorError(
      "provider_unsupported",
      "Meta Ads writes require the direct Graph-API transport (marketing_api); the CLI/MCP write transport is not implemented yet",
      false
    );
  }
  const accessToken = requireCredential(credential, "accessToken");
  const url = `https://graph.facebook.com/${metaAdsApiVersion(credential)}/${path}`;
  const safeUrl = safeUrlForLogs(url);
  const isPost = method === "POST";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        // Meta Graph WRITE endpoints take application/x-www-form-urlencoded.
        // Nested object/array fields (special_ad_categories, targeting,
        // object_story_spec, promoted_object, creative) must each be a JSON
        // STRING in their own field — mirrors the READ path's per-field
        // `JSON.stringify(time_range)` convention. Sending native nested JSON
        // (Content-Type: application/json) is REJECTED by the real Graph API.
        // DELETE is a bodyless node call, so it carries no Content-Type.
        ...(isPost ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...bearerHeaders(accessToken)
      },
      ...(isPost ? { body: metaFormEncode(params).toString() } : {})
    });
  } catch (error) {
    // Network/transport failure on a write is NON-retryable too: we never
    // want the action handler to silently re-issue a create/delete.
    throw new ConnectorError(
      "provider_api_error",
      `Meta Ads write request failed for ${safeUrl}: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  if (!response.ok) {
    const detail = await responseSafeDetail(response);
    const code =
      response.status === 401 || response.status === 403
        ? "provider_auth_failed"
        : response.status === 429
          ? "provider_rate_limited"
          : "provider_api_error";
    throw new ConnectorError(
      code,
      providerHttpErrorMessage("Meta Ads write failed", response.status, safeUrl, detail),
      // INVARIANT 3: writes are non-retryable for ALL status codes (incl 429/5xx).
      false
    );
  }
  return (await response.json()) as MetaGraphWriteResponse;
}

// Reads the echoed status from a create response leniently. Campaign/adset/ad
// creates may echo `status`; if absent we treat it as PAUSED (we only ever sent
// PAUSED). The guard's job is to catch an UNEXPECTED ACTIVE echo.
function metaEchoedStatus(response: MetaGraphWriteResponse): MetaEntityStatus | null {
  const raw = response.status ?? response.effective_status;
  if (typeof raw !== "string") {
    return null;
  }
  const upper = raw.toUpperCase();
  return upper === "ACTIVE" ? "ACTIVE" : upper === "PAUSED" ? "PAUSED" : null;
}

// INVARIANT 1: after any create, the entity must NOT be ACTIVE. If Graph ever
// echoes ACTIVE we throw a non-retryable money-safety error so the handler can
// audit-log a violation. Returns the (PAUSED-or-null) status to surface upward.
function assertCreateNotActive(entity: MetaWriteEntity, id: string, response: MetaGraphWriteResponse): MetaEntityStatus | null {
  const status = metaEchoedStatus(response);
  if (status === "ACTIVE") {
    throw new ConnectorError(
      "money_safety_violation",
      `Meta Ads ${entity} ${id} was created ACTIVE despite a PAUSED create request — refusing to proceed`,
      false
    );
  }
  return status;
}

function requireGraphId(entity: MetaWriteEntity, response: MetaGraphWriteResponse): string {
  const id = response.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ConnectorError(
      "provider_api_error",
      `Meta Ads ${entity} create response did not include an id`,
      false
    );
  }
  return id;
}

// Optional integer-cents fields are sent as JSON numbers. Budgets/bids = integer
// minor units (cents) per the captured CLI/doc contract.
function metaCents(value: number | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ConnectorError("provider_api_error", "Meta Ads budgets/bids must be non-negative integer cents", false);
  }
  return value;
}

// ── Enum normalization + allow-list validation ────────────────────────────────
// Meta Graph enums are UPPERCASE. We normalize (uppercase + trim) BEFORE the POST
// and validate against a known allow-list so a typo'd enum surfaces as a clear,
// NON-retryable error at our boundary instead of an opaque Graph #100 rejection
// (and so a lowercase value never reaches the wire). Allow-lists below cover the
// STANDARD surface this PR ships; extend them as new objectives/goals are added.
//
// VERIFY against a real Meta sandbox capture before live use: the exact accepted
// enum members evolve per Graph version — these lists reflect the captured SDK /
// docs for v25 and should be reconciled against a sandbox on go-live.
const META_OBJECTIVE_VALUES = new Set<string>([
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES"
]);
const META_OPTIMIZATION_GOAL_VALUES = new Set<string>([
  "NONE",
  "APP_INSTALLS",
  "AD_RECALL_LIFT",
  "ENGAGED_USERS",
  "EVENT_RESPONSES",
  "IMPRESSIONS",
  "LEAD_GENERATION",
  "QUALITY_LEAD",
  "LINK_CLICKS",
  "OFFSITE_CONVERSIONS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "QUALITY_CALL",
  "REACH",
  "LANDING_PAGE_VIEWS",
  "VISIT_INSTAGRAM_PROFILE",
  "VALUE",
  "THRUPLAY",
  "CONVERSATIONS"
]);
const META_BILLING_EVENT_VALUES = new Set<string>([
  "APP_INSTALLS",
  "CLICKS",
  "IMPRESSIONS",
  "LINK_CLICKS",
  "NONE",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "THRUPLAY",
  "PURCHASE",
  "LISTING_INTERACTION"
]);
const META_CALL_TO_ACTION_VALUES = new Set<string>([
  "OPEN_LINK",
  "LIKE_PAGE",
  "SHOP_NOW",
  "PLAY_GAME",
  "INSTALL_APP",
  "USE_APP",
  "INSTALL_MOBILE_APP",
  "USE_MOBILE_APP",
  "BOOK_TRAVEL",
  "LISTEN_MUSIC",
  "LEARN_MORE",
  "SIGN_UP",
  "DOWNLOAD",
  "WATCH_MORE",
  "NO_BUTTON",
  "CALL_NOW",
  "APPLY_NOW",
  "BUY_NOW",
  "GET_OFFER",
  "GET_QUOTE",
  "GET_DIRECTIONS",
  "SUBSCRIBE",
  "CONTACT_US",
  "ORDER_NOW",
  "DONATE_NOW",
  "SAY_THANKS",
  "SELL_NOW",
  "SHARE",
  "BOOK_NOW",
  "MESSAGE_PAGE",
  "REQUEST_TIME",
  "SEE_MENU",
  "GET_SHOWTIMES",
  "WHATSAPP_MESSAGE"
]);
const META_CUSTOM_EVENT_TYPE_VALUES = new Set<string>([
  "AD_IMPRESSION",
  "RATE",
  "TUTORIAL_COMPLETION",
  "CONTACT",
  "CUSTOMIZE_PRODUCT",
  "DONATE",
  "FIND_LOCATION",
  "SCHEDULE",
  "START_TRIAL",
  "SUBMIT_APPLICATION",
  "SUBSCRIBE",
  "ADD_TO_CART",
  "ADD_TO_WISHLIST",
  "INITIATED_CHECKOUT",
  "ADD_PAYMENT_INFO",
  "PURCHASE",
  "LEAD",
  "COMPLETE_REGISTRATION",
  "CONTENT_VIEW",
  "SEARCH",
  "SERVICE_BOOKING_REQUEST",
  "MESSAGING_CONVERSATION_STARTED_7D",
  "LEVEL_ACHIEVED",
  "ACHIEVEMENT_UNLOCKED",
  "SPENT_CREDITS",
  "LISTING_INTERACTION",
  "OTHER"
]);

// Normalize an enum value to UPPERCASE and validate it against an allow-list.
// Unknown values throw a clear NON-retryable ConnectorError so a bad enum can
// never reach the Graph POST. `undefined` passes through (optional fields).
function metaEnum(
  value: string | undefined,
  allowed: Set<string>,
  field: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!allowed.has(normalized)) {
    throw new ConnectorError(
      "provider_api_error",
      `Unsupported Meta Ads ${field}: "${value}" (expected one of ${[...allowed].join(", ")})`,
      false
    );
  }
  return normalized;
}

// ── Create: Campaign ── POST /act_{id}/campaigns ──────────────────────────────
export async function createMetaCampaign(
  credential: MetaAdsCredential,
  input: MetaCampaignCreateInput
): Promise<MetaWriteResult> {
  const adAccountId = metaAdsAccountId(credential);
  // VERIFY against a real Meta sandbox capture before live use:
  //   `special_ad_categories: []` is [INFERRED-REQUIRED] by Graph v25 (POST
  //   rejects campaigns without it). The field is present in the SDK; its
  //   requiredness was not observed at runtime.
  // FIX 3: normalize+validate enums to UPPERCASE before they reach the Graph POST.
  const objective = metaEnum(input.objective, META_OBJECTIVE_VALUES, "objective")!;
  const params: Record<string, unknown> = {
    name: input.name,
    objective,
    status: META_CREATE_STATUS, // INVARIANT 1: hard-coded PAUSED, ignores any caller status.
    special_ad_categories: [] // VERIFY against a real Meta sandbox capture before live use
  };
  const dailyBudget = metaCents(input.dailyBudget);
  const lifetimeBudget = metaCents(input.lifetimeBudget);
  if (dailyBudget !== undefined) params.daily_budget = dailyBudget;
  if (lifetimeBudget !== undefined) params.lifetime_budget = lifetimeBudget;

  const response = await metaAdsGraphPost(credential, `${adAccountId}/${META_CREATE_EDGE.campaign}`, params);
  const id = requireGraphId("campaign", response);
  const status = assertCreateNotActive("campaign", id, response);
  return { ok: true, id, status };
}

// ── Create: Ad Set ── POST /act_{id}/adsets ───────────────────────────────────
export async function createMetaAdSet(
  credential: MetaAdsCredential,
  input: MetaAdSetCreateInput
): Promise<MetaWriteResult> {
  const adAccountId = metaAdsAccountId(credential);
  // FIX 3: normalize+validate enums to UPPERCASE before they reach the Graph POST.
  const optimizationGoal = metaEnum(input.optimizationGoal, META_OPTIMIZATION_GOAL_VALUES, "optimization goal")!;
  const billingEvent = metaEnum(input.billingEvent, META_BILLING_EVENT_VALUES, "billing event")!;
  const params: Record<string, unknown> = {
    name: input.name,
    campaign_id: input.campaignId,
    optimization_goal: optimizationGoal,
    billing_event: billingEvent,
    status: META_CREATE_STATUS // INVARIANT 1: hard-coded PAUSED, ignores any caller status.
  };
  const dailyBudget = metaCents(input.dailyBudget);
  const lifetimeBudget = metaCents(input.lifetimeBudget);
  const bidAmount = metaCents(input.bidAmount);
  if (dailyBudget !== undefined) params.daily_budget = dailyBudget;
  if (lifetimeBudget !== undefined) params.lifetime_budget = lifetimeBudget;
  if (bidAmount !== undefined) params.bid_amount = bidAmount;
  if (input.startTime) params.start_time = input.startTime;
  if (input.endTime) params.end_time = input.endTime;
  // VERIFY against a real Meta sandbox capture before live use:
  //   `targeting` minimum shape — Graph usually demands at least geo_locations.
  //   The inner key geo_locations.countries is [CONFIRMED-SDK]; whether the CLI
  //   adds default targeting_automation/placements is [INFERRED].
  if (input.targetingCountries && input.targetingCountries.length > 0) {
    params.targeting = { geo_locations: { countries: input.targetingCountries } }; // VERIFY against a real Meta sandbox capture before live use
  }
  if (input.pixelId) {
    // promoted_object only when a pixel is supplied (conversion adsets).
    // FIX 3: custom_event_type is an enum → normalize+validate before the POST.
    const customEventType =
      metaEnum(input.customEventType, META_CUSTOM_EVENT_TYPE_VALUES, "custom event type") ?? "PURCHASE";
    params.promoted_object = {
      pixel_id: input.pixelId,
      custom_event_type: customEventType
    };
  }

  const response = await metaAdsGraphPost(credential, `${adAccountId}/${META_CREATE_EDGE.adset}`, params);
  const id = requireGraphId("adset", response);
  const status = assertCreateNotActive("adset", id, response);
  return { ok: true, id, status };
}

// ── Create: Ad Creative (STANDARD single-image only) ──────────────────────────
// POST /act_{id}/adcreatives. STANDARD scope: link_data OR photo_data only — no
// child_attachments / asset_feed_spec (carousel/DCO are deferred to PR #4+).
// NOTE: creatives have no go-live status; nothing to PAUSE-guard here.
export async function createMetaCreative(
  credential: MetaAdsCredential,
  input: MetaCreativeCreateInput
): Promise<MetaWriteResult> {
  const adAccountId = metaAdsAccountId(credential);
  if (!input.imageHash) {
    // Image upload (POST /act_{id}/adimages → image_hash) happens before this in
    // the action handler; the STANDARD creative needs a hash to reference.
    throw new ConnectorError(
      "provider_api_error",
      "Meta Ads STANDARD creative requires an image_hash (upload the image via /adimages first)",
      false
    );
  }
  const objectStorySpec: Record<string, unknown> = { page_id: input.pageId };
  if (input.instagramUserId) {
    objectStorySpec.instagram_user_id = input.instagramUserId;
  }
  if (input.linkUrl) {
    // Link ad. Key is "name" (NOT "title") for the headline — [CONFIRMED-SDK].
    const linkData: Record<string, unknown> = {
      link: input.linkUrl,
      image_hash: input.imageHash
    };
    if (input.body) linkData.message = input.body;
    if (input.title) linkData.name = input.title;
    if (input.description) linkData.description = input.description;
    if (input.callToAction) {
      // FIX 3: call_to_action.type is an enum → normalize+validate before the POST.
      const callToAction = metaEnum(input.callToAction, META_CALL_TO_ACTION_VALUES, "call to action")!;
      linkData.call_to_action = {
        type: callToAction,
        value: { link: input.linkUrl }
      };
    }
    objectStorySpec.link_data = linkData;
  } else {
    // STANDARD single-image PHOTO post. VERIFY against a real Meta sandbox
    // capture before live use: the --body → photo_data.caption mapping is
    // [INFERRED] (the keys are [CONFIRMED-SDK], the CLI's flag→key choice is not).
    const photoData: Record<string, unknown> = { image_hash: input.imageHash };
    if (input.body) photoData.caption = input.body; // VERIFY against a real Meta sandbox capture before live use
    objectStorySpec.photo_data = photoData;
  }

  const response = await metaAdsGraphPost(credential, `${adAccountId}/${META_CREATE_EDGE.creative}`, {
    name: input.name,
    object_story_spec: objectStorySpec
  });
  const id = requireGraphId("creative", response);
  // Creatives have no status; report null (no PAUSE/ACTIVE concept).
  return { ok: true, id, status: null };
}

// ── Create: Ad ── POST /act_{id}/ads ──────────────────────────────────────────
export async function createMetaAd(
  credential: MetaAdsCredential,
  input: MetaAdCreateInput
): Promise<MetaWriteResult> {
  const adAccountId = metaAdsAccountId(credential);
  // tracking_specs is [INFERRED] for the STANDARD path and omitted — verify the
  // element shape against a sandbox capture before adding it.
  const params: Record<string, unknown> = {
    name: input.name,
    adset_id: input.adsetId,
    creative: { creative_id: input.creativeId }, // key 'creative' wraps {creative_id} — [CONFIRMED-SDK]
    status: META_CREATE_STATUS // INVARIANT 1: hard-coded PAUSED, ignores any caller status.
  };

  const response = await metaAdsGraphPost(credential, `${adAccountId}/${META_CREATE_EDGE.ad}`, params);
  const id = requireGraphId("ad", response);
  const status = assertCreateNotActive("ad", id, response);
  return { ok: true, id, status };
}

// ── Status transition (activate / pause) ── POST /{entity_id} ─────────────────
// NOT an edge under act_; POST to the node id with { status }. Per-level only —
// never cascades. This is the SEPARATE, gated money-spending transition.
// Still NON-retryable (goes through metaAdsGraphPost). The activate confirm gate
// lives in the CLI layer (later stage); here we just perform the transition.
export async function setMetaEntityStatus(
  credential: MetaAdsCredential,
  entityId: string,
  status: MetaEntityStatus
): Promise<MetaStatusResult> {
  if (status !== "ACTIVE" && status !== "PAUSED") {
    throw new ConnectorError("provider_api_error", `Unsupported Meta entity status: ${String(status)}`, false);
  }
  const response = await metaAdsGraphPost(credential, entityId, { status });
  // Graph returns { success: true } for node status POSTs; trust the 2xx and
  // echo back the requested status. (No id is returned by the node POST.)
  const echoed = metaEchoedStatus(response);
  return { ok: true, id: entityId, status: echoed ?? status };
}

// ── Delete (cleanup) ── DELETE /{entity_id} ──────────────────────────────────
// Destructive, irreversible removal of a campaign/adset/ad node. Like the status
// transition this is a NODE call (no act_ edge, no body) and rides the SAME
// non-retryable write transport (INVARIANT 3: a delete is never auto-retried).
// Graph answers a successful DELETE with `{ success: true }`. Token only ever
// travels in the Authorization header (bearerHeaders); the URL has no query and
// is `safeUrlForLogs`-scrubbed in any error path — the token is never logged.
export async function deleteMetaEntity(
  credential: MetaAdsCredential,
  entityId: string
): Promise<MetaDeleteResult> {
  await metaAdsGraphWrite(credential, "DELETE", entityId, {});
  // A non-2xx already threw a non-retryable ConnectorError above; reaching here
  // means Graph returned a 2xx `{ success: true }`.
  return { ok: true, id: entityId, deleted: true };
}

// ── Reads: list / get ── normal retryable taxonomy via fetchJson ──────────────
interface MetaListResponse {
  data?: Array<Record<string, unknown>>;
  paging?: { next?: string | null } | null;
}

export async function listMetaEntities(
  credential: MetaAdsCredential,
  entity: MetaWriteEntity,
  options: { limit?: number; fields?: string } = {}
): Promise<Array<Record<string, unknown>>> {
  const accessToken = requireCredential(credential, "accessToken");
  const adAccountId = metaAdsAccountId(credential);
  const url = new URL(`https://graph.facebook.com/${metaAdsApiVersion(credential)}/${adAccountId}/${META_READ_EDGE[entity]}`);
  url.searchParams.set("fields", options.fields ?? metaDefaultReadFields(entity));
  if (options.limit) {
    url.searchParams.set("limit", String(options.limit));
  }
  const response = await fetchJson<MetaListResponse>(url.toString(), {
    method: "GET",
    headers: bearerHeaders(accessToken)
  });
  return response.data ?? [];
}

export async function getMetaEntity(
  credential: MetaAdsCredential,
  entityId: string,
  // FIX 1: `get` must surface the SAME full field set as `list` per object type.
  // Graph returns ONLY `{id}` when no `fields` param is supplied, so — exactly
  // like `listMetaEntities` — we ALWAYS set `fields`, defaulting to the canonical
  // per-entity set via `metaDefaultReadFields(entity)`. An explicit
  // `options.fields` still overrides; `options.entity` selects the default set.
  // (`entity` is optional for back-compat; when omitted with no explicit fields
  // we fall back to the campaign field set so a get never degrades to id-only.)
  options: { fields?: string; entity?: MetaWriteEntity } = {}
): Promise<Record<string, unknown>> {
  const accessToken = requireCredential(credential, "accessToken");
  const url = new URL(`https://graph.facebook.com/${metaAdsApiVersion(credential)}/${entityId}`);
  url.searchParams.set("fields", options.fields ?? metaDefaultReadFields(options.entity ?? "campaign"));
  return fetchJson<Record<string, unknown>>(url.toString(), {
    method: "GET",
    headers: bearerHeaders(accessToken)
  });
}

function metaDefaultReadFields(entity: MetaWriteEntity): string {
  switch (entity) {
    case "campaign":
      return "id,name,status,objective,effective_status";
    case "adset":
      return "id,name,status,campaign_id,optimization_goal,billing_event,effective_status";
    case "ad":
      return "id,name,status,adset_id,effective_status";
    case "creative":
      return "id,name,object_story_spec";
  }
}

// ── Lightweight dedup helper (idempotency) ────────────────────────────────────
// INVARIANT 4: dedup is keyed by (workspace_id, source_id, client_token). The
// durable table lives in the analytical-engine handler (a later stage); this is
// the pure key + check helper the handler reuses so the dedup shape is defined
// and unit-tested in one place alongside the writes.
export interface MetaDedupRecord {
  clientToken: string;
  entityId: string;
}

export function metaDedupKey(workspaceId: string, sourceId: string, clientToken: string): string {
  return `${workspaceId}::${sourceId}::${clientToken}`;
}

// Returns the existing entity id if a record with this client token is already
// present (→ handler returns deduped:true and skips the POST), else undefined.
export function findMetaDedupHit(
  existing: ReadonlyArray<MetaDedupRecord>,
  clientToken: string | undefined
): string | undefined {
  if (!clientToken) {
    return undefined;
  }
  return existing.find((record) => record.clientToken === clientToken)?.entityId;
}

// Resolve a live, OAuth-bridged MetaAdsCredential for an operator WRITE handler.
// The connector's `sync()` path reads credentials through the module-private
// `sourceCredential` (which follows the oauth_tokens FK + refreshes on demand);
// the write handlers in the analytical-engine run INLINE and need the same
// resolved credential without going through a connector method. This thin
// exported wrapper reuses that exact resolver (no duplicate decrypt/refresh
// logic, no token ever leaving the credential object) so a Meta write reuses
// the same live-token bridge a Meta read/sync does.
export async function resolveMetaAdsCredential(
  db: InfiniteOsDb,
  request: { workspaceId: string; sourceId: string }
): Promise<MetaAdsCredential> {
  const credential = await sourceCredential<MetaAdsCredential>(db, {
    workspaceId: request.workspaceId,
    sourceId: request.sourceId,
    provider: "meta_ads",
    syncRunId: `write_${Date.now()}`
  });
  return credential.payload;
}

function metaAdsCliAccountId(credential: MetaAdsCredential): string {
  return requireCredential(credential, "adAccountId").replace(/^act_/i, "");
}

// The `meta` CLI (and the MCP server) read the system-user token from the ACCESS_TOKEN
// env var. Read it leniently from the already-decrypted credential: for transport
// meta_ads_cli the connect flow marks accessToken NOT-required, so it can legitimately be
// absent when the operator relies on the CLI's own ambient auth — in that case we leave the
// inherited process.env.ACCESS_TOKEN untouched rather than hard-failing. NEVER log/echo this.
function metaAdsCliAccessToken(credential: MetaAdsCredential): string | undefined {
  const token = credential.accessToken;
  return typeof token === "string" && token.trim() ? token : undefined;
}

// Best-effort preflight so a missing binary surfaces an actionable, non-retryable error
// instead of the cryptic, retried-forever "failed to start" from the child 'error' handler.
// Caveat: a PATH walk with existsSync does not verify the +x bit or resolve OS shims; it
// catches the common "pip not run / not on PATH" case cheaply without an extra spawn.
function ensureExecutableOnPath(executable: string, label: string): void {
  const message = `${label}: "${executable}" was not found. Install Meta's Ads CLI: pip install meta-ads`;
  if (executable.includes("/")) {
    if (!existsSync(resolve(executable))) {
      throw new ConnectorError("provider_auth_failed", message, false);
    }
    return;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (pathDirs.some((dir) => existsSync(join(dir, executable)))) {
    return;
  }
  throw new ConnectorError("provider_auth_failed", message, false);
}

async function callMcpToolOverStdio(
  command: string,
  toolName: string | undefined,
  args: Record<string, unknown>,
  env?: Record<string, string>
): Promise<unknown> {
  const { executable, args: commandArgs } = parseProcessCommand(command, "MCP command");
  ensureExecutableOnPath(executable, "MCP command");
  const child = spawn(executable, commandArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: { ...process.env, ...(env ?? {}) }
  });
  let nextId = 1;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = "";
  const MCP_TIMEOUT_MS = 15_000;
  const MCP_MAX_STDOUT_BYTES = 1_000_000;
  const MCP_MAX_STDERR_BYTES = 4_096;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let settled = false;

  const cleanup = () => {
    settled = true;
    clearTimeout(timeout);
    timeout.unref?.();
    child.stdin.end();
    child.kill();
  };

  const rejectAll = (message: string) => {
    if (settled) return;
    cleanup();
    for (const { reject } of pending.values()) {
      reject(new ConnectorError("provider_api_error", message, true));
    }
    pending.clear();
  };

  const timeout = setTimeout(() => {
    rejectAll("MCP command timed out before returning a response");
  }, MCP_TIMEOUT_MS);

  child.stderr.on("data", (chunk) => {
    stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(0, MCP_MAX_STDERR_BYTES);
  });

  child.on("error", () => {
    rejectAll("MCP command failed to start");
  });

  child.on("exit", (code) => {
    if (pending.size > 0) {
      rejectAll(code === 0 ? "MCP command exited before responding" : `MCP command exited before responding (code=${String(code)})`);
    }
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    if (stdoutBuffer.length > MCP_MAX_STDOUT_BYTES) {
      rejectAll("MCP command produced too much output");
      return;
    }
    for (;;) {
      const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerText = stdoutBuffer.slice(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        rejectAll("MCP response missing Content-Length header");
        child.kill();
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyLength = Number(match[1]);
      if (stdoutBuffer.length < bodyStart + bodyLength) break;
      const body = stdoutBuffer.slice(bodyStart, bodyStart + bodyLength).toString("utf8");
      stdoutBuffer = stdoutBuffer.slice(bodyStart + bodyLength);
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        rejectAll("MCP command returned invalid JSON");
        return;
      }
      if (typeof message.id === "number" && pending.has(message.id)) {
        const resolver = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) {
          resolver.reject(
            new ConnectorError(
              "provider_api_error",
              message.error.message ?? "MCP tool call failed",
              true
            )
          );
        } else {
          resolver.resolve(message.result);
        }
      }
    }
  });

  const send = (payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });

  const notification = (method: string, params: Record<string, unknown> = {}) => {
    send({ jsonrpc: "2.0", method, params });
  };

  try {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "infinite-os", version: "0.1.0" }
    });
    notification("notifications/initialized", {});
    const toolsList = await request("tools/list", {});
    const resolvedToolName = resolveMcpToolName(toolsList, toolName);
    const result = await request("tools/call", {
      name: resolvedToolName,
      arguments: args
    });
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function callMetaAdsCliJson(credential: MetaAdsCredential, args: string[]): Promise<unknown> {
  const { executable, args: commandArgs } = parseProcessCommand(
    typeof credential.cliCommand === "string" && credential.cliCommand.trim() ? credential.cliCommand : "meta",
    "Meta Ads CLI command"
  );
  ensureExecutableOnPath(executable, "Meta Ads CLI command");
  const accessToken = metaAdsCliAccessToken(credential);
  const child = spawn(executable, [...commandArgs, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      AD_ACCOUNT_ID: metaAdsCliAccountId(credential),
      ...(accessToken ? { ACCESS_TOKEN: accessToken } : {})
    }
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const CLI_TIMEOUT_MS = 30_000;
  const CLI_MAX_STDOUT_BYTES = 1_000_000;
  const CLI_MAX_STDERR_BYTES = 4_096;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      timeout.unref?.();
      fn();
    };
    const fail = (message: string) => {
      finish(() => {
        child.kill();
        reject(new ConnectorError("provider_api_error", message, true));
      });
    };
    const timeout = setTimeout(() => {
      fail("Meta Ads CLI command timed out");
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = `${stdoutBuffer}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > CLI_MAX_STDOUT_BYTES) {
        fail("Meta Ads CLI command produced too much output");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(0, CLI_MAX_STDERR_BYTES);
    });
    child.on("error", () => {
      fail("Meta Ads CLI command failed to start");
    });
    child.on("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : "";
        fail(`Meta Ads CLI command failed${detail}`);
        return;
      }
      finish(() => {
        try {
          resolve(JSON.parse(stdoutBuffer));
        } catch {
          reject(new ConnectorError("provider_api_error", "Meta Ads CLI command returned invalid JSON", true));
        }
      });
    });
  });
}

function parseProcessCommand(command: string, label: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping || quote) {
    throw new ConnectorError("provider_auth_failed", `${label} has invalid quoting`, false);
  }
  if (current) {
    tokens.push(current);
  }
  const [executable, ...args] = tokens;
  if (!executable) {
    throw new ConnectorError("provider_auth_failed", `${label} is required`, false);
  }
  return { executable, args };
}

function resolveMcpToolName(toolsList: unknown, explicitToolName: string | undefined): string {
  const tools = Array.isArray((toolsList as { tools?: unknown[] } | undefined)?.tools)
    ? ((toolsList as { tools?: Array<{ name?: unknown }> }).tools ?? [])
    : [];
  if (explicitToolName) {
    return explicitToolName;
  }
  const candidate = tools
    .map((tool) => (typeof tool?.name === "string" ? tool.name : undefined))
    .find((name): name is string => Boolean(name && /(insight|campaign|report|ads)/i.test(name)));
  if (!candidate) {
    throw new ConnectorError("provider_api_error", "No suitable MCP tool name found for Meta Ads", true);
  }
  return candidate;
}

function coerceMetaAdsInsightsResponse(value: unknown): MetaAdsInsightsResponse {
  if (Array.isArray(value)) {
    return { data: value as MetaAdsInsightsRow[] };
  }
  if (isRecord(value)) {
    const recordValue = value;
    if (Array.isArray(recordValue.data)) {
      return recordValue as MetaAdsInsightsResponse;
    }
    if (Array.isArray(recordValue.rows)) {
      return { data: recordValue.rows as MetaAdsInsightsRow[] };
    }
    const structured = isRecord(recordValue.structuredContent) ? recordValue.structuredContent : undefined;
    if (structured && Array.isArray(structured.data)) {
      return structured as MetaAdsInsightsResponse;
    }
    if (Array.isArray(recordValue.content)) {
      for (const item of recordValue.content) {
        if (!isRecord(item) || typeof item.text !== "string") continue;
        try {
          const parsed = JSON.parse(item.text);
          if (isRecord(parsed) && Array.isArray(parsed.data)) {
            return parsed as MetaAdsInsightsResponse;
          }
        } catch {
          // ignore non-JSON text content
        }
      }
    }
  }
  throw new ConnectorError("provider_api_error", "Meta Ads MCP response did not include insight rows", true);
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const safeUrl = safeUrlForLogs(url);
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError(
      "provider_auth_failed",
      providerHttpErrorMessage("provider auth failed", response.status, safeUrl, await responseSafeDetail(response)),
      false
    );
  }
  if (response.status === 429) {
    throw new ConnectorError(
      "provider_rate_limited",
      providerHttpErrorMessage("provider rate limited", response.status, safeUrl, await responseSafeDetail(response)),
      true
    );
  }
  if (!response.ok) {
    throw new ConnectorError(
      "provider_api_error",
      providerHttpErrorMessage("provider request failed", response.status, safeUrl, await responseSafeDetail(response)),
      true
    );
  }
  return response.json() as Promise<T>;
}

async function responseSafeDetail(response: Response): Promise<string | undefined> {
  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) {
      return undefined;
    }
    return redactProviderErrorDetail(trimmed);
  } catch {
    return undefined;
  }
}

function providerHttpErrorMessage(
  prefix: string,
  status: number,
  safeUrl: string,
  detail: string | undefined
): string {
  return detail
    ? `${prefix} ${status} for ${safeUrl}: ${detail}`
    : `${prefix} ${status} for ${safeUrl}`;
}

function redactProviderErrorDetail(detail: string): string {
  return detail
    .replace(/phx_[A-Za-z0-9_-]+/g, "phx_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]*[A-Za-z0-9_~+/=-]/gi, "Bearer [redacted]");
}

function safeUrlForLogs(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.replace(/\?.*$/, "");
  }
}

class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

function providerError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof ConnectorError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "provider_api_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true
  };
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function cursorStartIso(plan: SyncPlan): string {
  return typeof plan.cursorStart === "string" && plan.cursorStart.trim() !== ""
    ? plan.cursorStart
    : new Date(Date.now() - plan.refreshWindowDays * 24 * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function hashRecord(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function integerOrZero(value: unknown): number {
  return Math.round(numberOrZero(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requireNonEmptyString(value: string | number | undefined | null, field: string): string {
  const normalized = optionalNonEmptyString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function optionalNonEmptyString(value: string | number | undefined | null): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function compactCredential<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
  ) as T;
}

function isoFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  if (typeof value === "number") {
    return unixToIso(value);
  }
  return new Date().toISOString();
}

function unixToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

function objectOrString(value: unknown): Record<string, unknown> & { id?: string } {
  if (value && typeof value === "object") {
    return value as Record<string, unknown> & { id?: string };
  }
  return typeof value === "string" ? { id: value } : {};
}

interface Ga4RunReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  limit: string;
}

interface Ga4RunReportResponse {
  rows?: Ga4RunReportRow[];
}

interface Ga4RunReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface PostHogQueryResponse<T> {
  results: T;
  columns?: Array<string | { name?: string; key?: string }>;
}

interface PostHogQueryRow {
  uuid: string;
  event: string;
  distinct_id?: string;
  person_id?: string;
  properties?: unknown;
  timestamp: string;
}

interface StripeListResponse<T> {
  data: T[];
  has_more: boolean;
}

interface StripeInvoiceApi {
  id: string;
  customer?: string | Record<string, unknown>;
  subscription?: string | Record<string, unknown>;
  currency?: string;
  amount_paid?: number;
  amount_due?: number;
  created: number;
  metadata?: Record<string, string>;
  status_transitions?: { paid_at?: number };
  lines?: { data?: StripeInvoiceLineApi[]; has_more?: boolean };
}

interface StripeInvoiceLineApi {
  id: string;
  amount?: number;
  amount_excluding_tax?: number;
  description?: string;
  price?: string | Record<string, unknown>;
  pricing?: { price_details?: { price?: string | Record<string, unknown>; product?: string | Record<string, unknown> } };
  period?: { start?: number; end?: number };
}

interface XUser {
  id: string;
  username?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    listed_count?: number;
    like_count?: number;
  };
}

interface XUserLookupResponse {
  data?: XUser;
}

interface ShopifyMoneyNode {
  amount?: string | null;
  currencyCode?: string | null;
}

interface ShopifyMoneySetNode {
  shopMoney?: ShopifyMoneyNode | null;
}

interface ShopifyLineItemNode {
  id?: string | null;
  sku?: string | null;
  quantity?: number | null;
  name?: string | null;
  originalUnitPriceSet?: ShopifyMoneySetNode | null;
  product?: {
    id?: string | null;
    title?: string | null;
    vendor?: string | null;
    productType?: string | null;
    status?: string | null;
  } | null;
  variant?: {
    id?: string | null;
  } | null;
}

interface ShopifyOrderNode {
  id?: string | null;
  name?: string | null;
  createdAt?: string | null;
  processedAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  customer?: {
    id?: string | null;
    email?: string | null;
  } | null;
  currentSubtotalPriceSet?: ShopifyMoneySetNode | null;
  currentTotalTaxSet?: ShopifyMoneySetNode | null;
  currentTotalDiscountsSet?: ShopifyMoneySetNode | null;
  currentTotalPriceSet?: ShopifyMoneySetNode | null;
  lineItems?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    edges?: Array<{ node?: ShopifyLineItemNode | null } | null> | null;
  } | null;
}

interface ShopifyProductNode {
  id?: string | null;
  title?: string | null;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface ShopifyOrdersResponse {
  orders?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    edges?: Array<{ node?: ShopifyOrderNode | null } | null> | null;
  } | null;
}

interface ShopifyProductsResponse {
  products?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    edges?: Array<{ node?: ShopifyProductNode | null } | null> | null;
  } | null;
}

interface ShopifyOrderLineItemsResponse {
  order?: {
    lineItems?: {
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
      edges?: Array<{ node?: ShopifyLineItemNode | null } | null> | null;
    } | null;
  } | null;
}

interface MetaAdsInsightsRow {
  campaign_id?: string | null;
  campaign_name?: string | null;
  date_start?: string | null;
  spend?: string | number | null;
  clicks?: string | number | null;
  inline_link_clicks?: string | number | null;
  impressions?: string | number | null;
  reach?: string | number | null;
  frequency?: string | number | null;
  cpm?: string | number | null;
  cpc?: string | number | null;
  ctr?: string | number | null;
  // §4 conversion fields. actions[]/action_values[] carry per-window subvalues
  // ('1d_click','7d_click','1d_view') alongside the element-level `value` (7d_click only).
  actions?: MetaActionElement[] | null;
  action_values?: MetaActionElement[] | null;
  // Meta's own results family (reconciliation cross-check). Array of result objects,
  // each with a `values` array of { value } entries.
  results?: Array<{ values?: Array<{ value?: string | number | null }> }> | null;
  cost_per_result?: Array<{ values?: Array<{ value?: string | number | null }> }> | null;
  // The result_type source-of-truth string (e.g. 'actions:offsite_conversion.fb_pixel_purchase').
  result_values_performance_indicator?: string | null;
  // Campaign objective (coarse key) + adset optimization_goal (the real result driver).
  objective?: string | null;
  optimization_goal?: string | null;
  // Account currency (§2.1, load-bearing for the Stripe value join). account_currency is
  // a valid Insights field that the API returns only when explicitly requested — it IS in
  // META_ADS_INSIGHTS_FIELDS, so live insights rows carry it and the delivery fact +
  // campaign dimension are populated WITHOUT a second ad-account read.
  account_currency?: string | null;
}

interface MetaAdsInsightsResponse {
  data?: MetaAdsInsightsRow[];
  paging?: {
    next?: string | null;
    cursors?: {
      after?: string | null;
    } | null;
  } | null;
}

interface XTimelineResponse {
  data?: XApiPost[];
  meta?: { next_token?: string };
}

interface XApiPost {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
}

const GA4_OVERVIEW_ROWS: Ga4Row[] = [
  {
    kind: "overview",
    externalId: "ga4-uk-week",
    reportingDate: "2026-06-01",
    country: "UK",
    landingPage: "/",
    referrer: "https://google.com",
    utmSource: "google",
    utmMedium: "organic",
    utmCampaign: "brand",
    sessionDefaultChannelGroup: "Organic Search",
    hostName: "rtk.dev",
    deviceCategory: "desktop",
    sessions: 80,
    activeUsers: 100,
    totalUsers: 120,
    newUsers: 70,
    screenPageViews: 240,
    engagedSessions: 60,
    engagementRate: 0.75,
    averageSessionDuration: 95.5,
    keyEvents: 12
  },
  {
    kind: "overview",
    externalId: "ga4-us-week",
    reportingDate: "2026-06-01",
    country: "US",
    landingPage: "/pricing",
    referrer: "https://newsletter.example",
    utmSource: "newsletter",
    utmMedium: "email",
    utmCampaign: "launch",
    sessionDefaultChannelGroup: "Email",
    hostName: "rtk.dev",
    deviceCategory: "mobile",
    sessions: 40,
    activeUsers: 50,
    totalUsers: 60,
    newUsers: 30,
    screenPageViews: 110,
    engagedSessions: 25,
    engagementRate: 0.625,
    averageSessionDuration: 60.0,
    keyEvents: 4
  }
];

const GA4_PAGE_ROWS: Ga4PageRow[] = [
  {
    kind: "page",
    externalId: "ga4-page-home",
    reportingDate: "2026-06-01",
    hostName: "rtk.dev",
    pagePath: "/",
    pageTitle: "Home",
    screenPageViews: 180,
    sessions: 70,
    engagedSessions: 55,
    averageSessionDuration: 88.0,
    keyEvents: 9
  },
  {
    kind: "page",
    externalId: "ga4-page-pricing",
    reportingDate: "2026-06-01",
    hostName: "rtk.dev",
    pagePath: "/pricing",
    pageTitle: "Pricing",
    screenPageViews: 95,
    sessions: 40,
    engagedSessions: 30,
    averageSessionDuration: 64.5,
    keyEvents: 5
  }
];

// Fixture mode feeds a mixed array (overview + page) through toExtractedRecord, which
// classifies each by its `kind` tag.
const GA4_ROWS: Ga4SyncRow[] = [...GA4_OVERVIEW_ROWS, ...GA4_PAGE_ROWS];

const POSTHOG_EVENTS: PostHogEventRow[] = [
  {
    externalId: "ph-signup-1",
    eventId: "ph_evt_1",
    eventName: "signup",
    distinctId: "anon_1",
    personId: "person_1",
    sessionId: "session_1",
    email: "founder@example.com",
    occurredAt: "2026-06-01T10:00:00.000Z",
    landingPage: "/",
    referrer: "https://google.com",
    utmSource: "google",
    utmMedium: "organic",
    utmCampaign: "brand",
    properties: { plan: "starter" }
  },
  {
    externalId: "ph-signup-2",
    eventId: "ph_evt_2",
    eventName: "signup",
    distinctId: "anon_2",
    personId: "person_2",
    sessionId: "session_2",
    email: "operator@example.com",
    occurredAt: "2026-06-02T11:00:00.000Z",
    landingPage: "/pricing",
    referrer: "https://newsletter.example",
    utmSource: "newsletter",
    utmMedium: "email",
    utmCampaign: "launch",
    properties: { plan: "pro" }
  }
];

const STRIPE_INVOICES: StripeInvoiceRow[] = [
  {
    externalId: "stripe-inv-1",
    invoiceId: "in_001",
    customerId: "cus_001",
    customerEmail: "founder@example.com",
    customerName: "Founder Example",
    subscriptionId: "sub_001",
    currency: "usd",
    amountPaid: 4900,
    amountDue: 0,
    paidAt: "2026-06-02T09:00:00.000Z",
    createdAt: "2026-06-02T09:00:00.000Z",
    periodEnd: "2026-07-02T09:00:00.000Z",
    externalOrderId: "order_001",
    lines: [
      {
        lineId: "il_001",
        productId: "prod_growth",
        productName: "Infinite OS Pro",
        priceId: "price_monthly",
        amountCents: 4900,
        periodStart: "2026-06-02T09:00:00.000Z",
        periodEnd: "2026-07-02T09:00:00.000Z"
      }
    ]
  }
];

const X_POSTS: XPostRow[] = [
  {
    externalId: "x-post-1",
    postId: "1800000000000000001",
    authorId: "2244994945",
    conversationId: "1800000000000000001",
    postUrl: "https://x.com/XDevelopers/status/1800000000000000001",
    bodyText: "Infinite OS fixture post",
    publishedAt: "2026-06-01T12:00:00.000Z",
    capturedAt: "2026-06-03T00:00:00.000Z",
    publicMetrics: {
      retweetCount: 5,
      replyCount: 2,
      likeCount: 42,
      quoteCount: 1,
      bookmarkCount: 3,
      impressionCount: 1000
    }
  }
];
