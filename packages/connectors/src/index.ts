import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  CredentialDecryptError,
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
  // §4c grain discriminant. The dispatching writer routes by this tag; the extracted
  // record's objectType + the factory's payload round-trip carry it untouched. Campaign
  // rows fold into meta_ads_campaign_* (the byte-for-byte Phase-1 path).
  grain: "campaign";
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
  // §4a campaign-status backfill: the on/off status read off the /campaigns edge and
  // folded onto the campaign dim by the writer (fixes the Phase-1 NULL-status gap). NULL
  // when the edge read did not return this campaign.
  effectiveStatus: string | null;
  configuredStatus: string | null;
  // The typed child conversion rows derived for this campaign-day (§2.3).
  conversions: MetaAdsConversionRow[];
}

// Phase-2 slice-1a §2.2/§2.3 — the ADSET-grain delivery+conversions row. Mirrors the
// campaign row at adset grain, RE-KEYED on adset_id (the #1 corruption fix), and carries
// the adset dim attributes (optimization_goal, billing_event, on/off status) folded out of
// the net-new /adsets edge read (§4a) so the dispatching writer can upsert the adset dim
// before the adset facts (§7a). campaign_id is CARRIED (never the key).
interface MetaAdsAdsetDailyRow {
  grain: "adset";
  // RE-KEYED on adset_id (§4c): `meta_ads:adset:<act>:<adset_id>:<day>`. Reusing the
  // campaign-keyed externalId would collapse every adset onto one corrupted raw_record.
  externalId: string;
  adAccountId: string;
  campaignId: string;
  adsetId: string;
  adsetName: string | null;
  occurredOn: string;
  spend: number;
  clicks: number;
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
  actionsRaw: unknown;
  // Adset dim attributes (from the /adsets edge — §4a). optimization_goal is per-adset, so
  // the §4b canonical-event mapping is EXACT at this grain.
  optimizationGoal: string | null;
  billingEvent: string | null;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  // Typed child conversion rows derived for this adset-day (§2.3), keyed by adset_id.
  conversions: MetaAdsConversionRow[];
}

// Phase-2 slice-1b §2.2/§2.3 — the AD-grain delivery+conversions row. Mirrors the adset
// row at AD grain, RE-KEYED on ad_id (the #1 corruption fix). campaign_id is CARRIED (never
// the key); adset_id is CARRIED and NULLABLE (orphan tolerance, §7a ad-with-no-adset). The
// ad dim attributes (creative_id, on/off status) are folded out of the net-new /ads edge
// read (§4a) so the dispatching writer can upsert the ad dim before the ad facts (§7a).
// optimization_goal is an ADSET property carried in-memory from the adset-dim map (§4e) —
// it is NOT a field on this row; it only drives the §4b conversion mapping at map time.
interface MetaAdsAdDailyRow {
  grain: "ad";
  // RE-KEYED on ad_id (§4c): `meta_ads:ad:<act>:<ad_id>:<day>`. Reusing the adset/campaign
  // externalId would collapse every ad of an adset onto one corrupted raw_record.
  externalId: string;
  adAccountId: string;
  campaignId: string;
  // CARRIED parent adset id; NULLABLE — an ad can exist with no resolvable ad set (§7a).
  adsetId: string | null;
  adId: string;
  adName: string | null;
  // The creative id from the /ads edge creative{id} field-expansion (§4a). NULLABLE
  // (ad-with-no-creative); coalesced on dim upsert so a later null never wipes it. NO body.
  creativeId: string | null;
  occurredOn: string;
  spend: number;
  clicks: number;
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
  actionsRaw: unknown;
  // Ad dim status attributes (from the /ads edge — §4a). NO optimization_goal/billing_event
  // (those are adset properties; the §4b mapping carries optimization_goal in-memory, §4e).
  effectiveStatus: string | null;
  configuredStatus: string | null;
  // Typed child conversion rows derived for this ad-day (§2.3), keyed by ad_id. The §4b
  // mapping is computed against the PARENT adset's optimization_goal (carried, §4e).
  conversions: MetaAdsConversionRow[];
}

// §4c — the grain-tagged extract union. extractLive emits a flat array of all three grains;
// the dispatching writeMetaAdsTruth routes each row to its grain's dim+daily+conversions
// writer. Every member carries `externalId` (the factory's Row constraint) + `grain`.
type MetaAdsSyncRow = MetaAdsCampaignDailyRow | MetaAdsAdsetDailyRow | MetaAdsAdDailyRow;

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

const metaAdsConnector = createConnector<MetaAdsCredential, MetaAdsSyncRow>({
  provider: "meta_ads",
  fixtureRows: () => [],
  fixtureObjectType: "meta_ads_campaign_daily",
  // §4c — objectType tracks the row's grain so raw_records / extracted records are tagged
  // by grain (adset rows are also RE-KEYED on adset_id in externalId, keeping them distinct).
  toExtractedRecord: (row, plan) => ({
    externalId: row.externalId,
    // §4c — objectType tracks grain (campaign | adset | ad) so raw_records/extracted records
    // are grain-tagged; each grain's externalId is re-keyed on its id, keeping rows distinct.
    objectType:
      row.grain === "ad"
        ? "meta_ads_ad_daily"
        : row.grain === "adset"
          ? "meta_ads_adset_daily"
          : "meta_ads_campaign_daily",
    payloadVersion: plan.mode === "fixture" ? "fixture-v1" : "live-v1",
    sourceUpdatedAt: plan.mode === "fixture" ? null : plan.cursorEnd,
    payload: row
  }),
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

    // ── MCP / CLI transports — campaign grain only this slice (§4d lean scope). There is
    // no edge reader wired for these transports, so status degrades to NULL (the dim
    // writer coalesces, never nulls a known value) and no adset pass runs. The emitted
    // request is byte-for-byte identical to before this change.
    if (isMetaAdsMcpTransport(credential)) {
      const rows: MetaAdsSyncRow[] = [];
      let after: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = await metaAdsMcpInsights(credential, {
          adAccountId,
          fields: metaAdsInsightsFieldsForLevel(level),
          level,
          limit: "100",
          timeIncrement,
          attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
          ...timeOptions,
          after
        });
        rows.push(...(response.data ?? []).map((row) => metaAdsCampaignDailyRow(adAccountId, row, context)));
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
        fields: metaAdsInsightsFieldsForLevel(level),
        limit: "100",
        timeIncrement: "daily",
        attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
        ...timeOptions
      });
      return (response.data ?? []).map((row) => metaAdsCampaignDailyRow(adAccountId, row, context));
    }

    // ── Direct Graph (marketing_api) — the PRIMARY transport. This is where §4a/§4b/§4c/§4d
    // land: read the status edges first (§7a dim-before-fact), then run the campaign pass
    // (status-enriched) PLUS an internal adset pass (the worker never sets the grain flag),
    // each with the §4d fail-loud page cap.
    const accessToken = requireCredential(credential, "accessToken");

    // §4a — net-new edge reads. The adset dim map (status + optimization_goal) drives the
    // adset rows; the campaign status map backfills the campaign dim's NULL-status gap; the
    // ad dim map (status + creative_id + parent ids) drives the ad rows (§4c). All header-
    // aware GETs (§4b) — no ad-account mutation anywhere.
    const adsetDims = await metaAdsReadAdsetDims(credential);
    const campaignStatus = await metaAdsReadCampaignStatus(credential);
    const adDims = await metaAdsReadAdAdims(credential);

    const rows: MetaAdsSyncRow[] = [];

    // The campaign insights pass runs unless the caller EXPLICITLY pinned a finer grain (the
    // Phase-0 plumbing override level=adset/ad). With no override (the worker's path) level is
    // campaign and all three passes run (§4f: 3 passes/sync is deliberate — no roll-up).
    if (level !== "adset" && level !== "ad") {
      await metaAdsFetchInsightsPages(
        accessToken,
        metaAdsInsightsUrl(credential, {
          adAccountId,
          fields: metaAdsInsightsFieldsForLevel("campaign"),
          level: "campaign",
          limit: "100",
          timeIncrement,
          attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
          ...timeOptions
        }),
        (row) => rows.push(metaAdsCampaignDailyRow(adAccountId, row, context, campaignStatus))
      );
    }

    // §4b/§4c — the adset insights pass. Runs on the primary transport unless the caller
    // EXPLICITLY pinned level=ad (then only the ad pass runs). The worker does not request a
    // finer grain via the flag, so the adset fan-out lives here alongside campaign + ad.
    if (level !== "ad") {
      await metaAdsFetchInsightsPages(
        accessToken,
        metaAdsInsightsUrl(credential, {
          adAccountId,
          fields: metaAdsInsightsFieldsForLevel("adset"),
          level: "adset",
          limit: "100",
          timeIncrement,
          attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
          ...timeOptions
        }),
        (row) => rows.push(metaAdsAdsetDailyRow(adAccountId, row, context, adsetDims))
      );
    }

    // §4c/§4d/§4e — the AD insights pass (the FINEST grain, the §4f third unconditional pass).
    // Re-keys on ad_id; carries optimization_goal from the adsetDims map (§4e). VOLUME: the ad
    // grain cannot survive a wide single window (Meta 100/1487534), so EVERY backfill — whether
    // the all_time sentinel OR a bounded 3/6/12-month / --days N window — is issued MONTH-BY-
    // MONTH (metaAdsFetchAdInsightsChunked, 37-month clamp, 1487534 → week-narrower retry). The
    // chunk decision is driven by plan.backfillWindow + window width, NOT the date_preset=maximum
    // sentinel: a bounded multi-month backfill is exactly the wide level=ad request that trips
    // 1487534, so it MUST chunk too. Only a genuinely-small trailing incremental refresh (no
    // backfillWindow, ≤ one month) stays a SINGLE request.
    const adRowSink = (row: MetaAdsInsightsRow) =>
      rows.push(metaAdsAdDailyRow(adAccountId, row, context, adDims, adsetDims));
    const adUrlFor = (range: { since: string; until: string }) =>
      metaAdsInsightsUrl(credential, {
        adAccountId,
        fields: metaAdsInsightsFieldsForLevel("ad"),
        level: "ad",
        limit: "100",
        timeIncrement,
        timeRange: range,
        attributionWindows: META_ADS_ATTRIBUTION_WINDOWS
      });
    // The chunked windows are resolved from the plan (all_time → no timeRange; bounded backfill
    // → a finite timeRange). For the single-request path we need a concrete trailing window: use
    // timeOptions.timeRange when present, else the plan's resolved span (the all_time case never
    // reaches the single-request branch because plan.backfillWindow forces chunking).
    const adTrailingRange = timeOptions.timeRange ?? {
      since: cursorStartIso(plan).slice(0, 10),
      until: plan.cursorEnd.slice(0, 10)
    };
    if (metaAdsAdPassNeedsChunking(plan, adTrailingRange)) {
      // §4d — month-by-month backfill (or a defensively-wide incremental window). Clamp the
      // start to the 37-month retention floor; iterate calendar months; one metaAdsFetchInsights
      // Pages call per window, narrowing to weeks on a 1487534 data-volume error.
      for (const window of metaAdsAdBackfillWindows(plan)) {
        await metaAdsFetchAdInsightsChunked(accessToken, window, adUrlFor, adRowSink);
      }
    } else {
      // Incremental trailing window — single request (the rolling sync is small enough). Still
      // wrapped in the chunk helper so a surprise 1487534 narrows to weeks instead of failing.
      await metaAdsFetchAdInsightsChunked(
        accessToken,
        adTrailingRange,
        adUrlFor,
        adRowSink
      );
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
      // planSync resolves (and DECRYPTS) the credential, so it MUST run inside the try: a decrypt
      // failure here (key mismatch) used to throw before recordSyncFailure could run, leaving the
      // source `connected` forever while the worker silently re-enqueued the doomed sync. `plan` is
      // null until planSync succeeds; recordSyncFailure tolerates that.
      let plan: SyncPlan | null = null;
      let extracted: ExtractedRecord<unknown>[];
      try {
        plan = await this.planSync(db, request);
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
  // `plan` is null when the failure happened DURING planning (e.g. an undecryptable credential), so
  // there is no cursor to preserve — the cursor write is skipped in that case.
  request: SyncRequest,
  plan: SyncPlan | null,
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
    if (plan) {
      await tx.query(
        `
          insert into sync_cursors (id, workspace_id, source_id, cursor_key, cursor_value)
          values ($1,$2,$3,$4,$5)
          on conflict (source_id, cursor_key) do nothing
        `,
        [`cursor_${randomUUID()}`, request.workspaceId, request.sourceId, plan.cursorKey, plan.cursorStart ?? ""]
      );
    }
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
interface MetaAdsCampaignDim {
  adAccountId: string;
  campaignId: string;
  name: string | null;
  objective: string | null;
  currency: string | null;
  // §4a campaign-status backfill (from the /campaigns edge), folded onto the dim.
  effectiveStatus: string | null;
  configuredStatus: string | null;
}

function metaAdsDimensionRows(rows: MetaAdsCampaignDailyRow[]): Map<string, MetaAdsCampaignDim> {
  const dims = new Map<string, MetaAdsCampaignDim>();
  for (const row of rows) {
    const key = `${row.adAccountId}:${row.campaignId}`;
    const existing = dims.get(key);
    dims.set(key, {
      adAccountId: row.adAccountId,
      campaignId: row.campaignId,
      // Coalesce so a later day with a null field does not erase an earlier non-null value.
      name: row.campaignName ?? existing?.name ?? null,
      objective: row.objective ?? existing?.objective ?? null,
      currency: row.currency ?? existing?.currency ?? null,
      effectiveStatus: row.effectiveStatus ?? existing?.effectiveStatus ?? null,
      configuredStatus: row.configuredStatus ?? existing?.configuredStatus ?? null
    });
  }
  return dims;
}

// Phase-2 slice-1a §4a/§4c — fold the adset day rows into the adset dimension. Mirrors
// metaAdsDimensionRows at adset grain; carries the status + optimization_goal/billing_event
// read off the /adsets edge so the dim writer can populate them (last-write-wins, coalesce).
interface MetaAdsAdsetDimFold {
  adAccountId: string;
  campaignId: string;
  adsetId: string;
  name: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  currency: string | null;
}

function metaAdsAdsetDimensionRows(rows: MetaAdsAdsetDailyRow[]): Map<string, MetaAdsAdsetDimFold> {
  const dims = new Map<string, MetaAdsAdsetDimFold>();
  for (const row of rows) {
    const key = `${row.adAccountId}:${row.adsetId}`;
    const existing = dims.get(key);
    dims.set(key, {
      adAccountId: row.adAccountId,
      campaignId: row.campaignId,
      adsetId: row.adsetId,
      name: row.adsetName ?? existing?.name ?? null,
      optimizationGoal: row.optimizationGoal ?? existing?.optimizationGoal ?? null,
      billingEvent: row.billingEvent ?? existing?.billingEvent ?? null,
      effectiveStatus: row.effectiveStatus ?? existing?.effectiveStatus ?? null,
      configuredStatus: row.configuredStatus ?? existing?.configuredStatus ?? null,
      currency: row.currency ?? existing?.currency ?? null
    });
  }
  return dims;
}

// Phase-2 slice-1b §4a/§4c — fold the ad day rows into the ad dimension. Mirrors
// metaAdsAdsetDimensionRows at ad grain; carries creative_id + status read off the /ads edge.
// adset_id is NULLABLE (orphan tolerance); coalesce so a re-sync momentarily lacking a value
// (incl. a creative that disappears) never nulls a previously-seen field (§7 freeze-on-disappear).
interface MetaAdsAdDimFold {
  adAccountId: string;
  campaignId: string;
  adsetId: string | null;
  adId: string;
  name: string | null;
  creativeId: string | null;
  effectiveStatus: string | null;
  configuredStatus: string | null;
}

function metaAdsAdDimensionRows(rows: MetaAdsAdDailyRow[]): Map<string, MetaAdsAdDimFold> {
  const dims = new Map<string, MetaAdsAdDimFold>();
  for (const row of rows) {
    const key = `${row.adAccountId}:${row.adId}`;
    const existing = dims.get(key);
    dims.set(key, {
      adAccountId: row.adAccountId,
      campaignId: row.campaignId,
      adsetId: row.adsetId ?? existing?.adsetId ?? null,
      adId: row.adId,
      name: row.adName ?? existing?.name ?? null,
      creativeId: row.creativeId ?? existing?.creativeId ?? null,
      effectiveStatus: row.effectiveStatus ?? existing?.effectiveStatus ?? null,
      configuredStatus: row.configuredStatus ?? existing?.configuredStatus ?? null
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
          name, objective, currency, effective_status, configured_status
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (source_id, ad_account_id, campaign_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          -- coalesce so a re-sync that momentarily lacks a field never nulls a known value.
          name = coalesce(excluded.name, meta_ads_campaigns.name),
          objective = coalesce(excluded.objective, meta_ads_campaigns.objective),
          currency = coalesce(excluded.currency, meta_ads_campaigns.currency),
          -- §4a campaign-status backfill: fills the Phase-1 NULL gap WITHOUT disturbing
          -- name/objective/currency. coalesce so a transport without an edge read (MCP/CLI,
          -- status null) never erases a previously-read status.
          effective_status = coalesce(excluded.effective_status, meta_ads_campaigns.effective_status),
          configured_status = coalesce(excluded.configured_status, meta_ads_campaigns.configured_status),
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
        dim.currency,
        dim.effectiveStatus,
        dim.configuredStatus
      ]
    );
    // Lineage carries an FK to raw_records, so only write it when a real raw id exists for
    // this run (the dimension is a fold of the day rows; a fabricated id would break the FK).
    if (rawRecordId) {
      await writeLineage(tx, request, "meta_ads_campaigns", `${dim.adAccountId}:${dim.campaignId}`, rawRecordId);
    }
  }
}

// §4c — the DISPATCHING writer. extractLive emits a grain-tagged union (campaign + adset
// rows); this splits by grain and routes each to its own dim+daily+conversions writer. The
// campaign path is byte-for-byte the Phase-1 writer; the adset path RE-KEYS on adset_id.
// rawIds are positional (one per extracted row), so we carry each grain's rawId alongside.
async function writeMetaAdsTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsSyncRow[],
  rawIds: string[]
): Promise<void> {
  const campaignRows: MetaAdsCampaignDailyRow[] = [];
  const campaignRawIds: string[] = [];
  const adsetRows: MetaAdsAdsetDailyRow[] = [];
  const adsetRawIds: string[] = [];
  const adRows: MetaAdsAdDailyRow[] = [];
  const adRawIds: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.grain === "ad") {
      adRows.push(row);
      adRawIds.push(rawIds[index]);
    } else if (row.grain === "adset") {
      adsetRows.push(row);
      adsetRawIds.push(rawIds[index]);
    } else {
      campaignRows.push(row);
      campaignRawIds.push(rawIds[index]);
    }
  }
  // §7a dim-before-fact: each grain's writer upserts its dim before its facts. The three
  // grains are written independently (no roll-up); ad facts carry adset_id/campaign_id plain.
  await writeMetaAdsCampaignTruth(tx, request, campaignRows, campaignRawIds);
  await writeMetaAdsAdsetTruth(tx, request, adsetRows, adsetRawIds);
  await writeMetaAdsAdTruth(tx, request, adRows, adRawIds);
}

async function writeMetaAdsCampaignTruth(
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

// ──────────────────────────────────────────────────────────────────────────────────
// Phase-2 slice-1a §4c — the ADSET-grain writer trio. Mirrors the campaign writers,
// RE-KEYED on adset_id (the #1 corruption fix): the dim conflict key is
// (source_id, ad_account_id, adset_id), the daily key adds occurred_on, the conversions
// key adds result_type. campaign_id is CARRIED on every row but is never the key. §7a
// dim-before-fact: the dim upsert runs before the facts.
// ──────────────────────────────────────────────────────────────────────────────────
async function writeMetaAdsAdsetDimension(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsAdsetDailyRow[],
  rawIds: string[]
): Promise<void> {
  const rawRecordId = rawIds[0] ?? null;
  for (const dim of metaAdsAdsetDimensionRows(rows).values()) {
    await tx.query(
      `
        insert into meta_ads_adsets (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, adset_id,
          name, optimization_goal, billing_event, effective_status, configured_status, currency
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict (source_id, ad_account_id, adset_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          -- coalesce so a re-sync momentarily lacking a field never nulls a known value;
          -- §7a don't-delete-on-disappearance: a paused/archived adset retains its row +
          -- last effective_status, so on/off history stays queryable.
          campaign_id = coalesce(excluded.campaign_id, meta_ads_adsets.campaign_id),
          name = coalesce(excluded.name, meta_ads_adsets.name),
          optimization_goal = coalesce(excluded.optimization_goal, meta_ads_adsets.optimization_goal),
          billing_event = coalesce(excluded.billing_event, meta_ads_adsets.billing_event),
          effective_status = coalesce(excluded.effective_status, meta_ads_adsets.effective_status),
          configured_status = coalesce(excluded.configured_status, meta_ads_adsets.configured_status),
          currency = coalesce(excluded.currency, meta_ads_adsets.currency),
          updated_at = now()
      `,
      [
        `mada_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawRecordId,
        dim.adAccountId,
        dim.campaignId,
        dim.adsetId,
        dim.name,
        dim.optimizationGoal,
        dim.billingEvent,
        dim.effectiveStatus,
        dim.configuredStatus,
        dim.currency
      ]
    );
    if (rawRecordId) {
      await writeLineage(tx, request, "meta_ads_adsets", `${dim.adAccountId}:${dim.adsetId}`, rawRecordId);
    }
  }
}

async function writeMetaAdsAdsetTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsAdsetDailyRow[],
  rawIds: string[]
): Promise<void> {
  // §7a — upsert the adset dim BEFORE the adset facts (so status/optimization_goal exist).
  await writeMetaAdsAdsetDimension(tx, request, rows, rawIds);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    // §4c restatement — unique key (source_id, ad_account_id, adset_id, occurred_on) is
    // RE-KEYED on adset_id, so each adset's day row is distinct (no campaign-keyed collapse)
    // and a re-sync of the rolling window is last-write-wins.
    await tx.query(
      `
        insert into meta_ads_adset_daily (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, adset_id,
          adset_name, occurred_on, spend, clicks, inline_link_clicks, landing_page_views,
          impressions, reach, cpm, cpc, ctr, currency, attribution_setting, actions_raw, api_version
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22
        )
        on conflict (source_id, ad_account_id, adset_id, occurred_on)
        do update set
          raw_record_id = excluded.raw_record_id,
          campaign_id = excluded.campaign_id,
          adset_name = excluded.adset_name,
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
        `madd_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        row.adAccountId,
        row.campaignId,
        row.adsetId,
        row.adsetName,
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
      "meta_ads_adset_daily",
      `${row.adAccountId}:${row.adsetId}:${row.occurredOn}`,
      rawIds[index]
    );
    await writeMetaAdsAdsetConversionRows(tx, request, row, rawIds[index]);
  }
}

// §2.3 / §4c — fan the adset day's typed child conversions into
// meta_ads_adset_conversions_daily. Unique key RE-KEYED on adset_id (+ result_type
// partition). NEVER summed up to campaign — Meta dedups conversions only within an ad set.
async function writeMetaAdsAdsetConversionRows(
  tx: InfiniteOsDb,
  request: SyncRequest,
  row: MetaAdsAdsetDailyRow,
  rawRecordId: string
): Promise<void> {
  for (const conversion of row.conversions) {
    await tx.query(
      `
        insert into meta_ads_adset_conversions_daily (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, adset_id,
          occurred_on, result_type, results, conversion_value, attribution_setting,
          is_primary, results_source
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        on conflict (source_id, ad_account_id, adset_id, occurred_on, result_type)
        do update set
          raw_record_id = excluded.raw_record_id,
          campaign_id = excluded.campaign_id,
          results = excluded.results,
          conversion_value = excluded.conversion_value,
          attribution_setting = excluded.attribution_setting,
          is_primary = excluded.is_primary,
          results_source = excluded.results_source,
          updated_at = now()
      `,
      [
        `madac_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawRecordId,
        row.adAccountId,
        row.campaignId,
        row.adsetId,
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
      "meta_ads_adset_conversions_daily",
      `${row.adAccountId}:${row.adsetId}:${row.occurredOn}:${conversion.resultType}`,
      rawRecordId
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────────
// Phase-2 slice-1b §4c/§7a — the AD-grain writer trio. Mirrors the adset writers, RE-KEYED
// on ad_id (the #1 corruption fix): the dim conflict key is (source_id, ad_account_id,
// ad_id), the daily key adds occurred_on, the conversions key adds result_type. campaign_id
// is CARRIED on every row; adset_id is CARRIED and NULLABLE (§7a). creative_id coalesces on
// upsert (freeze-on-disappearance, §7). §7a dim-before-fact: the dim upsert runs before facts.
// ──────────────────────────────────────────────────────────────────────────────────
async function writeMetaAdsAdDimension(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsAdDailyRow[],
  rawIds: string[]
): Promise<void> {
  const rawRecordId = rawIds[0] ?? null;
  for (const dim of metaAdsAdDimensionRows(rows).values()) {
    await tx.query(
      `
        insert into meta_ads_ads (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, adset_id,
          ad_id, name, creative_id, effective_status, configured_status
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (source_id, ad_account_id, ad_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          -- coalesce so a re-sync momentarily lacking a field never nulls a known value;
          -- §7 freeze-on-disappearance: a paused/archived ad (or a creative that drops out of
          -- the edge response) retains its row + last creative_id/status, so on/off + creative
          -- lifecycle history stays queryable. adset_id is NULLABLE (orphan tolerance, §7a).
          campaign_id = coalesce(excluded.campaign_id, meta_ads_ads.campaign_id),
          adset_id = coalesce(excluded.adset_id, meta_ads_ads.adset_id),
          name = coalesce(excluded.name, meta_ads_ads.name),
          creative_id = coalesce(excluded.creative_id, meta_ads_ads.creative_id),
          effective_status = coalesce(excluded.effective_status, meta_ads_ads.effective_status),
          configured_status = coalesce(excluded.configured_status, meta_ads_ads.configured_status),
          updated_at = now()
      `,
      [
        `madx_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawRecordId,
        dim.adAccountId,
        dim.campaignId,
        dim.adsetId,
        dim.adId,
        dim.name,
        dim.creativeId,
        dim.effectiveStatus,
        dim.configuredStatus
      ]
    );
    if (rawRecordId) {
      await writeLineage(tx, request, "meta_ads_ads", `${dim.adAccountId}:${dim.adId}`, rawRecordId);
    }
  }
}

async function writeMetaAdsAdTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: MetaAdsAdDailyRow[],
  rawIds: string[]
): Promise<void> {
  // §7a — upsert the ad dim BEFORE the ad facts (so creative_id/status exist).
  await writeMetaAdsAdDimension(tx, request, rows, rawIds);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    // §4c restatement — unique key (source_id, ad_account_id, ad_id, occurred_on) is RE-KEYED
    // on ad_id, so each ad's day row is distinct (no adset/campaign-keyed collapse) and a
    // re-sync of the rolling window is last-write-wins.
    await tx.query(
      `
        insert into meta_ads_ad_daily (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, adset_id,
          ad_id, ad_name, occurred_on, spend, clicks, inline_link_clicks, landing_page_views,
          impressions, reach, cpm, cpc, ctr, currency, attribution_setting, actions_raw, api_version
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23
        )
        on conflict (source_id, ad_account_id, ad_id, occurred_on)
        do update set
          raw_record_id = excluded.raw_record_id,
          campaign_id = excluded.campaign_id,
          adset_id = excluded.adset_id,
          ad_name = excluded.ad_name,
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
        `madad_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        row.adAccountId,
        row.campaignId,
        row.adsetId,
        row.adId,
        row.adName,
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
      "meta_ads_ad_daily",
      `${row.adAccountId}:${row.adId}:${row.occurredOn}`,
      rawIds[index]
    );
    await writeMetaAdsAdConversionRows(tx, request, row, rawIds[index]);
  }
}

// §2.3 / §4c — fan the ad day's typed child conversions into meta_ads_ad_conversions_daily.
// Unique key RE-KEYED on ad_id (+ result_type partition). NEVER summed up to adset or
// campaign — Meta dedups conversions only within an ad set, so ad sums can EXCEED the adset.
async function writeMetaAdsAdConversionRows(
  tx: InfiniteOsDb,
  request: SyncRequest,
  row: MetaAdsAdDailyRow,
  rawRecordId: string
): Promise<void> {
  for (const conversion of row.conversions) {
    await tx.query(
      `
        insert into meta_ads_ad_conversions_daily (
          id, workspace_id, source_id, raw_record_id, ad_account_id, campaign_id, adset_id,
          ad_id, occurred_on, result_type, results, conversion_value, attribution_setting,
          is_primary, results_source
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        on conflict (source_id, ad_account_id, ad_id, occurred_on, result_type)
        do update set
          raw_record_id = excluded.raw_record_id,
          campaign_id = excluded.campaign_id,
          adset_id = excluded.adset_id,
          results = excluded.results,
          conversion_value = excluded.conversion_value,
          attribution_setting = excluded.attribution_setting,
          is_primary = excluded.is_primary,
          results_source = excluded.results_source,
          updated_at = now()
      `,
      [
        `madadc_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawRecordId,
        row.adAccountId,
        row.campaignId,
        row.adsetId,
        row.adId,
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
      "meta_ads_ad_conversions_daily",
      `${row.adAccountId}:${row.adId}:${row.occurredOn}:${conversion.resultType}`,
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

// §4b — the grain-aware insights field list. At level=adset we ADD adset_id,adset_name so
// the row mapper can RE-KEY on adset_id (the #1 corruption fix) and carry adset_name. At
// campaign grain (the default) it is byte-for-byte META_ADS_INSIGHTS_FIELDS — so the
// existing campaign request is unchanged. The fields are gated on level=adset so the
// shared field list never silently adds adset_id to the campaign request (or to the
// MCP/CLI transports, which stay campaign-grain this slice).
function metaAdsInsightsFieldsForLevel(level: string): string {
  // Phase-2 slice-1b §4c — at level=ad we PREPEND ad_id,ad_name,adset_id so the ad row mapper
  // can re-key on ad_id (the #1 corruption fix) AND carry the parent adset_id (also the key the
  // §4e optimization_goal carry uses to look up the adset dim). campaign_id is NOT prepended —
  // it already leads META_ADS_INSIGHTS_FIELDS (the carried parent key is echoed at every grain).
  if (level === "ad") {
    return `ad_id,ad_name,adset_id,${META_ADS_INSIGHTS_FIELDS}`;
  }
  if (level === "adset") {
    return `adset_id,adset_name,${META_ADS_INSIGHTS_FIELDS}`;
  }
  return META_ADS_INSIGHTS_FIELDS;
}

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

// ──────────────────────────────────────────────────────────────────────────────────
// Phase-2 slice-1b §4d — MONTH-BY-MONTH DATE-CHUNKING for the level=ad BACKFILL.
//
// WHY (the founder-chosen volume solution): a level=ad + daily + wide-range + many-ads
// insights request trips Meta error 100 / subcode 1487534 ("reduce the amount of data"),
// and date_preset=maximum at ad grain WILL fail outright. So the ad backfill is NEVER one
// request — it is issued in MONTH-sized time_range windows. Each window is small enough to
// return synchronously; a window that STILL 1487534s is retried NARROWER (split into weeks).
// Async report-run jobs are deferred to Slice 2 (this is the §10 locked decision).
//
// 37-MONTH CLAMP: Meta retains ad-grain insights for ~37 months; older windows silently
// return empty. We CLAMP the backfill start to 37 months ago rather than asking for windows
// that can only ever be empty (label-don't-fail). Incremental daily syncs (the trailing
// rolling window) are small enough to stay single-request and never enter this chunk loop.
// ──────────────────────────────────────────────────────────────────────────────────
const META_ADS_AD_BACKFILL_MAX_MONTHS = 37;

// A single inclusive [since, until] day window (YYYY-MM-DD), the shape time_range wants.
interface MetaAdsDateWindow {
  since: string;
  until: string;
}

function metaAdsIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Clamp the backfill start to at most META_ADS_AD_BACKFILL_MAX_MONTHS before `until`. Returns
// the LATER of the requested start and the 37-month floor (older → silently-empty windows).
function metaAdsClampBackfillStart(sinceDay: string, untilDay: string): string {
  const until = new Date(`${untilDay}T00:00:00.000Z`);
  // Anchor the month shift to day-1 BEFORE subtracting months so setUTCMonth never overflows a
  // short target month (e.g. until=2026-03-31 minus 37mo must land in Feb 2023, not Mar 3). We
  // then re-apply the original day-of-month, clamped to the target month's length, so the floor
  // is exactly N months before `until` without the day-of-month carrying into the next month.
  const day = until.getUTCDate();
  const floor = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));
  floor.setUTCMonth(floor.getUTCMonth() - META_ADS_AD_BACKFILL_MAX_MONTHS);
  const lastDayOfFloorMonth = new Date(
    Date.UTC(floor.getUTCFullYear(), floor.getUTCMonth() + 1, 0)
  ).getUTCDate();
  floor.setUTCDate(Math.min(day, lastDayOfFloorMonth));
  const floorDay = metaAdsIsoDay(floor);
  return sinceDay < floorDay ? floorDay : sinceDay;
}

// Split [since, until] into consecutive MONTH-sized windows (calendar-month boundaries; the
// first/last windows are partial). Each window is one metaAdsFetchInsightsPages call.
function metaAdsMonthWindows(sinceDay: string, untilDay: string): MetaAdsDateWindow[] {
  const windows: MetaAdsDateWindow[] = [];
  if (sinceDay > untilDay) {
    return windows;
  }
  let cursor = new Date(`${sinceDay}T00:00:00.000Z`);
  const until = new Date(`${untilDay}T00:00:00.000Z`);
  while (cursor <= until) {
    // The end of THIS calendar month (or `until`, whichever is earlier).
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const windowUntil = monthEnd < until ? monthEnd : until;
    windows.push({ since: metaAdsIsoDay(cursor), until: metaAdsIsoDay(windowUntil) });
    // Advance to the first day of the next month.
    cursor = new Date(Date.UTC(windowUntil.getUTCFullYear(), windowUntil.getUTCMonth() + 1, 1));
  }
  return windows;
}

// Split one window into WEEK-sized sub-windows (the narrower retry when a month 1487534s).
function metaAdsWeekWindows(window: MetaAdsDateWindow): MetaAdsDateWindow[] {
  const windows: MetaAdsDateWindow[] = [];
  let cursor = new Date(`${window.since}T00:00:00.000Z`);
  const until = new Date(`${window.until}T00:00:00.000Z`);
  while (cursor <= until) {
    const weekEnd = new Date(cursor);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const windowUntil = weekEnd < until ? weekEnd : until;
    windows.push({ since: metaAdsIsoDay(cursor), until: metaAdsIsoDay(windowUntil) });
    cursor = new Date(windowUntil);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

// §4d — inclusive day-span (days) of a [since, until] window. Used to decide whether the ad
// pass must chunk: any range wider than a single calendar slice is too wide for one level=ad
// daily request on a many-ads account (the Meta 100/1487534 trigger).
function metaAdsWindowSpanDays(window: MetaAdsDateWindow): number {
  const since = new Date(`${window.since}T00:00:00.000Z`).getTime();
  const until = new Date(`${window.until}T00:00:00.000Z`).getTime();
  return Math.round((until - since) / (24 * 60 * 60 * 1000));
}

// §4d — the day a single un-chunked level=ad request is safe up to. A trailing incremental
// refresh (≤ this many days) stays ONE request; anything wider is routed through the
// month-chunk loop. 31 ≈ the widest month so a one-month refresh never needlessly splits.
const META_ADS_AD_SINGLE_REQUEST_MAX_DAYS = 31;

// §4d — resolve the ad pass's chunked [since, until] windows from the plan. This is the SINGLE
// source of truth for the ad backfill range and applies to EVERY backfill shape, not just the
// all_time sentinel:
//   * all_time          → cursorStart is null → cursorStartIso falls back to the refresh window
//                         (or, in practice, the worker's all_time intent); clamped to 37 months.
//   * 3/6/12_months,
//     --days N, any
//     mode=backfill      → cursorStart pinned by the plan; the FULL multi-month span is chunked.
// The start is always clamped to the 37-month retention floor (older windows return empty at
// Meta — label-don't-fail). Returns month-sized windows ready for metaAdsFetchAdInsightsChunked.
function metaAdsAdBackfillWindows(plan: SyncPlan): MetaAdsDateWindow[] {
  const untilDay = plan.cursorEnd.slice(0, 10);
  const sinceDay = metaAdsClampBackfillStart(cursorStartIso(plan).slice(0, 10), untilDay);
  return metaAdsMonthWindows(sinceDay, untilDay);
}

// §4d — does the ad insights pass need the month-chunk loop, or is the trailing window small
// enough for one request? A BACKFILL (any backfillWindow, including all_time) ALWAYS chunks —
// the whole point is to never issue a wide level=ad request. A non-backfill incremental sync
// chunks only when its trailing window is wider than the single-request ceiling (a defensive
// net for very-high-cardinality accounts whose 30d daily refresh could still 1487534).
function metaAdsAdPassNeedsChunking(plan: SyncPlan, range: MetaAdsDateWindow): boolean {
  if (plan.backfillWindow !== undefined) {
    return true;
  }
  return metaAdsWindowSpanDays(range) > META_ADS_AD_SINGLE_REQUEST_MAX_DAYS;
}

interface MetaAdsInsightsContext {
  apiVersion: string;
  attributionSetting: string;
}

// §4d — fail-loud volume guard for the PRIMARY (direct-Graph) insights transport. Two
// limits, both THROW rather than silently truncate:
//   * page cap — a runaway cursor that never terminates is a dropped-page bug, not an
//     empty result. We refuse past META_ADS_INSIGHTS_PAGE_LIMIT pages.
//   * throttle — Meta echoes x-fb-ads-insights-throttle (acc_id_util_pct) ONLY on
//     /insights responses. fetchJson discards response.headers, so we use a header-aware
//     fetch HERE (not fetchJson) and THROW when utilization crosses the ceiling so a
//     near-throttle run never returns a partial window that looks complete.
const META_ADS_INSIGHTS_PAGE_LIMIT = 1000;
const META_ADS_THROTTLE_CEILING_PCT = 95;

// §4e — real backoff-with-retry on high utilization (replaces the slice-1a fail-loud throw).
// When acc_id_util_pct crosses the ceiling we sleep and retry the SAME request up to
// META_ADS_THROTTLE_MAX_RETRIES times, with an exponential backoff (base * 2^attempt). Only
// AFTER the retries are exhausted do we fail loud (refusing to truncate the window). The
// backoff is reachable on BOTH transports now that edge reads are header-aware (§4b).
const META_ADS_THROTTLE_MAX_RETRIES = 4;
const META_ADS_THROTTLE_BACKOFF_BASE_MS = 1000;

// §4d — Meta error code 100 / subcode 1487534 ("Please reduce the amount of data you're
// asking for") fires on wide-range, high-cardinality reads (level=ad + daily + many ads +
// long window, and date_preset=maximum at ad grain). It surfaces as a 400 carrying the
// subcode in the JSON error body. The chunk-loop caller classifies it to retry the window
// NARROWER (month → week) rather than failing the whole backfill.
const META_ADS_DATA_VOLUME_ERROR_SUBCODE = 1487534;

// Sleep helper for the throttle backoff. Resolves after `ms` milliseconds. Under vitest the
// delay is collapsed to a microtask so the retry control-flow is exercised without real
// wall-clock waits (the retry COUNT/sequence is asserted, not the literal sleep duration).
function metaAdsSleep(ms: number): Promise<void> {
  if (process.env.VITEST) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse acc_id_util_pct out of the x-fb-ads-insights-throttle header. The header is a JSON
// object like {"app_id_util_pct":1.2,"acc_id_util_pct":42.0,"ads_api_access_tier":"..."}.
// Returns null when the header is absent/unparseable (the common case — we do NOT fail on a
// missing header, only on an explicit high utilization).
function metaAdsThrottleUtilization(header: string | null): number | null {
  if (!header) {
    return null;
  }
  try {
    const parsed = JSON.parse(header) as { acc_id_util_pct?: number };
    return typeof parsed.acc_id_util_pct === "number" ? parsed.acc_id_util_pct : null;
  } catch {
    return null;
  }
}

// §4d — does this thrown error carry Meta's "reduce the amount of data" subcode (1487534)?
// The subcode is preserved in the ConnectorError.message (responseSafeDetail keeps the JSON
// error body; redactProviderErrorDetail only strips tokens), so we match it textually — the
// transport helpers branch only on HTTP status and never structurally parse error_subcode.
// Matching the subcode (a stable Meta constant) keeps the narrower-retry trigger explicit.
function isMetaAdsDataVolumeError(error: unknown): boolean {
  if (!(error instanceof ConnectorError)) {
    return false;
  }
  return error.message.includes(String(META_ADS_DATA_VOLUME_ERROR_SUBCODE));
}

// §4b/§4e — a single header-aware GET with throttle backoff-with-retry. Reads the
// x-fb-ads-insights-throttle header (which fetchJson discards) and, on high acc_id_util_pct,
// sleeps + retries the SAME request rather than failing loud. Mirrors fetchJson's retryable
// taxonomy for the status branches (401/403 non-retryable auth, 429 retryable, other non-2xx
// retryable). Returns the OK Response with its body still unread so the caller can json() it.
// Used by BOTH the edge reader (§4b) and the insights pager (§4e). 429s also back off here.
async function metaAdsFetchWithThrottleBackoff(url: string, init: RequestInit): Promise<Response> {
  const safeUrl = safeUrlForLogs(url);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status === 401 || response.status === 403) {
      throw new ConnectorError(
        "provider_auth_failed",
        providerHttpErrorMessage("provider auth failed", response.status, safeUrl, await responseSafeDetail(response)),
        false
      );
    }
    // §4e — a 429 (hard rate limit) backs off and retries like a high-utilization response;
    // only after the retry budget is exhausted does it surface as the retryable error.
    if (response.status === 429) {
      if (attempt < META_ADS_THROTTLE_MAX_RETRIES) {
        await metaAdsSleep(META_ADS_THROTTLE_BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }
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
    // §4e — back off on high account utilization BEFORE consuming the window. Sleep + retry
    // the same request; fail loud only once the retry budget is spent (refusing to truncate).
    const utilization = metaAdsThrottleUtilization(response.headers.get("x-fb-ads-insights-throttle"));
    if (utilization !== null && utilization >= META_ADS_THROTTLE_CEILING_PCT) {
      if (attempt < META_ADS_THROTTLE_MAX_RETRIES) {
        await metaAdsSleep(META_ADS_THROTTLE_BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }
      throw new ConnectorError(
        "provider_rate_limited",
        `Meta Ads insights throttle high (acc_id_util_pct=${utilization} >= ${META_ADS_THROTTLE_CEILING_PCT}) after ${META_ADS_THROTTLE_MAX_RETRIES} retries; refusing to truncate the window`,
        true
      );
    }
    return response;
  }
}

// §4d — page through a direct-Graph /insights URL, invoking `onRow` for every row, with the
// fail-loud page cap + throttle guard. Header-aware (reads x-fb-ads-insights-throttle, which
// fetchJson would discard); otherwise mirrors fetchJson's retryable taxonomy (401/403 auth
// non-retryable, 429 rate-limited retryable, other non-2xx api_error retryable).
async function metaAdsFetchInsightsPages(
  accessToken: string,
  firstUrl: string,
  onRow: (row: MetaAdsInsightsRow) => void
): Promise<void> {
  let nextUrl: string | null = firstUrl;
  for (let page = 0; page < META_ADS_INSIGHTS_PAGE_LIMIT; page += 1) {
    if (!nextUrl) {
      return;
    }
    // §4e — header-aware GET with real throttle backoff-with-retry (was fail-loud in
    // slice-1a). A 400 carrying error_subcode 1487534 surfaces as a retryable
    // provider_api_error here; the §4d chunk-loop caller classifies it (isMetaAdsDataVolume-
    // Error) and retries the WINDOW narrower — this pager itself does not narrow.
    const response = await metaAdsFetchWithThrottleBackoff(nextUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json", ...bearerHeaders(accessToken) }
    });
    const body = (await response.json()) as MetaAdsInsightsResponse;
    for (const row of body.data ?? []) {
      onRow(row);
    }
    nextUrl = body.paging?.next ?? null;
  }
  // §4d — the cursor never terminated within the page cap. A dropped/looping cursor must
  // FAIL the run rather than return a silently-truncated set.
  throw new ConnectorError(
    "provider_api_error",
    `Meta Ads insights pagination exceeded the ${META_ADS_INSIGHTS_PAGE_LIMIT}-page limit (refusing to truncate)`,
    true
  );
}

// Phase-2 slice-1b §4d — run the level=ad BACKFILL over MONTH-sized windows. For each month
// window we issue one metaAdsFetchInsightsPages call; if Meta answers a window with subcode
// 1487534 ("reduce the amount of data") we DO NOT fail the backfill — we retry that ONE
// window split into WEEK sub-windows. Any error that is NOT a data-volume error (auth, a
// genuine 5xx after retries, the page-cap throw) propagates unchanged. `urlFor` builds the
// /insights URL for a given time_range so the loop owns only the windowing, not the field set.
async function metaAdsFetchAdInsightsChunked(
  accessToken: string,
  window: MetaAdsDateWindow,
  urlFor: (range: MetaAdsDateWindow) => string,
  onRow: (row: MetaAdsInsightsRow) => void
): Promise<void> {
  try {
    await metaAdsFetchInsightsPages(accessToken, urlFor(window), onRow);
  } catch (error) {
    // §4d — ONLY a data-volume (1487534) error triggers the narrower retry; everything else
    // (auth/rate-limit-after-retries/page-cap) is a real failure and re-throws.
    if (!isMetaAdsDataVolumeError(error)) {
      throw error;
    }
    // The month window is still too wide — split it into weeks and retry each sub-window.
    for (const week of metaAdsWeekWindows(window)) {
      await metaAdsFetchInsightsPages(accessToken, urlFor(week), onRow);
    }
  }
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
  context: MetaAdsInsightsContext,
  // §4a — campaign on/off status from the /campaigns edge backfill, keyed by campaign_id.
  // Optional so the existing call sites (and fixtures) stay unchanged; absent → NULL status
  // (today's behavior), present → folds into the campaign dim's effective/configured_status.
  statusByCampaignId?: Map<string, MetaAdsEntityStatus>
): MetaAdsCampaignDailyRow {
  const occurredOn = row.date_start ?? daysAgo(0);
  const actions = metaInsightsActions(row);
  // Landing page views from actions[action_type='landing_page_view'], NON-omni
  // (omni_landing_page_view is a broader population and is deliberately excluded).
  const landingPageViews = Math.round(metaSumActionType(actions, "landing_page_view"));
  const campaignId = String(row.campaign_id ?? "unknown");
  const status = statusByCampaignId?.get(campaignId);
  return {
    grain: "campaign",
    externalId: `meta_ads:${adAccountId}:${campaignId}:${occurredOn}`,
    adAccountId,
    campaignId,
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
    effectiveStatus: status?.effectiveStatus ?? null,
    configuredStatus: status?.configuredStatus ?? null,
    conversions: metaAdsConversionRows(row, context)
  };
}

// Phase-2 slice-1a §4b/§4c — map one adset-level insights row to an ADSET-grain row.
// externalId is RE-KEYED on adset_id (the #1 corruption fix). The adset dim attributes
// (optimization_goal, billing_event, status) come from the /adsets edge map (§4a), NOT
// from the insights row — status is not on insights. The §4b conversion mapping keys on
// the adset's optimization_goal (from the dim) first, then falls back to the row fields.
function metaAdsAdsetDailyRow(
  adAccountId: string,
  row: MetaAdsInsightsRow,
  context: MetaAdsInsightsContext,
  adsetById: Map<string, MetaAdsAdsetDim>
): MetaAdsAdsetDailyRow {
  const occurredOn = row.date_start ?? daysAgo(0);
  const actions = metaInsightsActions(row);
  const landingPageViews = Math.round(metaSumActionType(actions, "landing_page_view"));
  const adsetId = String(row.adset_id ?? "unknown");
  const dim = adsetById.get(adsetId);
  // optimization_goal precedence: the per-adset dim value (exact) wins over the insights
  // echo; the §4b mapping is computed against the dim's optimization_goal at this grain.
  const optimizationGoal = dim?.optimizationGoal ?? stringOrNull(row.optimization_goal);
  const conversionRow: MetaAdsInsightsRow = {
    ...row,
    optimization_goal: optimizationGoal ?? row.optimization_goal ?? null
  };
  return {
    grain: "adset",
    externalId: `meta_ads:adset:${adAccountId}:${adsetId}:${occurredOn}`,
    adAccountId,
    // Carry the parent campaign_id: prefer the insights echo, fall back to the dim.
    campaignId: String(row.campaign_id ?? dim?.campaignId ?? "unknown"),
    adsetId,
    adsetName: stringOrNull(row.adset_name) ?? dim?.name ?? null,
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
    currency: stringOrNull(row.account_currency)?.toLowerCase() ?? dim?.currency ?? null,
    attributionSetting: context.attributionSetting,
    apiVersion: context.apiVersion,
    actionsRaw: {
      actions: actions ?? [],
      action_values: metaInsightsActionValues(row) ?? []
    },
    optimizationGoal,
    billingEvent: dim?.billingEvent ?? null,
    effectiveStatus: dim?.effectiveStatus ?? null,
    configuredStatus: dim?.configuredStatus ?? null,
    conversions: metaAdsConversionRows(conversionRow, context)
  };
}

// Phase-2 slice-1b §4c/§4e — map one AD-level insights row to an AD-grain row. externalId is
// RE-KEYED on ad_id (the #1 corruption fix). The ad dim attributes (creative_id, status) come
// from the /ads edge map (§4a); the parent adset_id/campaign_id are carried (adset_id is
// NULLABLE, §7a). The §4b conversion mapping needs optimization_goal — an ADSET property — so
// it is carried in-memory from the ADSET-dim map keyed on the row's adset_id (§4e), NOT from
// the ad dim and NOT from the ad insights row (level=ad insights does not echo it reliably).
function metaAdsAdDailyRow(
  adAccountId: string,
  row: MetaAdsInsightsRow,
  context: MetaAdsInsightsContext,
  adById: Map<string, MetaAdsAdDim>,
  adsetById: Map<string, MetaAdsAdsetDim>
): MetaAdsAdDailyRow {
  const occurredOn = row.date_start ?? daysAgo(0);
  const actions = metaInsightsActions(row);
  const landingPageViews = Math.round(metaSumActionType(actions, "landing_page_view"));
  const adId = String(row.ad_id ?? "unknown");
  const dim = adById.get(adId);
  // Carry the parent adset_id (NULLABLE): prefer the insights echo, fall back to the ad dim.
  const adsetId = stringOrNull(row.adset_id) ?? dim?.adsetId ?? null;
  // §4e — optimization_goal is carried from the PARENT ADSET dim (keyed on adset_id), the
  // exact driver of the §4b result_type mapping. We rebuild the conversion row with it so
  // metaAdsConversionRows resolves the same canonical rule it does at adset grain. Fall back
  // to the campaign objective echo (already on the row) when the ad has no resolvable adset.
  const adsetDim = adsetId ? adsetById.get(adsetId) : undefined;
  const optimizationGoal = adsetDim?.optimizationGoal ?? stringOrNull(row.optimization_goal);
  const conversionRow: MetaAdsInsightsRow = {
    ...row,
    optimization_goal: optimizationGoal ?? row.optimization_goal ?? null
  };
  return {
    grain: "ad",
    externalId: `meta_ads:ad:${adAccountId}:${adId}:${occurredOn}`,
    adAccountId,
    // Carry the parent campaign_id: prefer the insights echo, fall back to the ad dim.
    campaignId: String(row.campaign_id ?? dim?.campaignId ?? "unknown"),
    adsetId,
    adId,
    adName: stringOrNull(row.ad_name) ?? dim?.name ?? null,
    // creative_id from the /ads edge (creative{id}); freeze-on-disappearance is the writer's
    // coalesce — here we just surface the last-seen value from the dim map.
    creativeId: dim?.creativeId ?? null,
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
    actionsRaw: {
      actions: actions ?? [],
      action_values: metaInsightsActionValues(row) ?? []
    },
    effectiveStatus: dim?.effectiveStatus ?? null,
    configuredStatus: dim?.configuredStatus ?? null,
    conversions: metaAdsConversionRows(conversionRow, context)
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

// ──────────────────────────────────────────────────────────────────────────────────
// Phase-2 slice-1a §4a — net-new GET /adsets + /campaigns EDGE readers (status source).
//
// Status (effective_status/configured_status) is NOT on insights rows — the connector
// folds dims OUT of insights and never reads an edge during sync. Real status requires a
// net-new authenticated Graph GET on /act_<id>/adsets (+ a /campaigns status backfill that
// fixes the Phase-1 NULL-status gap). These ride the READ transport (fetchJson, the normal
// retryable taxonomy) — NEVER metaAdsGraphPost (the WRITE transport, force-non-retryable).
// All GETs (reads). No ad-account mutation anywhere here — fully in the open-core boundary.
// ──────────────────────────────────────────────────────────────────────────────────

// Hard page ceiling for the edge reads (§4d fail-loud volume guard, primary transport). If
// the cursor never terminates within this many pages we THROW rather than silently truncate.
const META_ADS_EDGE_PAGE_LIMIT = 200;

// §7a — the /adsets + /campaigns edges DEFAULT-EXCLUDE archived (and deleted) entities from
// the result set. Without an explicit effective_status filter, a recently-archived adset or
// campaign that still has insights rows in the rolling window is absent from the dim/status
// map, so its status falls back to NULL — exactly the on/off regression the spec calls out
// (a paused/archived adset must be LABELED as such, not treated as status-unknown). Passing
// this superset filter returns active+paused+archived (incl. inherited campaign/adset-paused
// and the in-process/with-issues delivery states) on BOTH edges so status stays populated and
// on/off history stays queryable. DELETED is intentionally omitted (hard-removed, no insights).
const META_ADS_EDGE_STATUS_FILTER = [
  "ACTIVE",
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO"
] as const;

// The on/off status pair for a campaign or adset, read off its Graph node. effectiveStatus
// = Meta's COMPUTED delivery state (incl. inherited CAMPAIGN_PAUSED/ADSET_PAUSED);
// configuredStatus = the operator-set value (the Graph `status` field).
interface MetaAdsEntityStatus {
  effectiveStatus: string | null;
  configuredStatus: string | null;
}

// One adset dim row read off /act_<id>/adsets. optimization_goal is per-adset, so the §4b
// canonical-event mapping is EXACT at adset grain. currency is NOT a real adset-node field
// (it is carried via the campaign FK / insights account_currency) so it stays null here.
interface MetaAdsAdsetDim extends MetaAdsEntityStatus {
  adsetId: string;
  campaignId: string | null;
  name: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  currency: string | null;
}

// Phase-2 slice-1b §4a — one ad dim row read off /act_<id>/ads. The ad node carries its
// parent adset_id + campaign_id (carried onto the ad facts) and the creative{id}
// field-expansion (creative?.id). status comes from here (it is not on insights). NO
// optimization_goal here — that is an ADSET property the §4b mapping carries in-memory from
// the adset-dim map (§4e). adsetId is NULLABLE (orphan tolerance, §7a ad-with-no-adset).
interface MetaAdsAdDim extends MetaAdsEntityStatus {
  adId: string;
  campaignId: string | null;
  adsetId: string | null;
  name: string | null;
  // From the creative{id} field-expansion — the creative id ONLY, never a creative body.
  creativeId: string | null;
}

// One Graph edge node as returned by /act_<id>/<edge>. Loose by design (Graph echoes only
// requested fields). NOTE: Graph returns the operator-configured status under `status`
// (NOT `configured_status`); effective_status is its own field. We map `status` into the
// configured_status column.
interface MetaAdsEdgeNode {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  effective_status?: string | null;
  configured_status?: string | null;
  objective?: string | null;
  optimization_goal?: string | null;
  billing_event?: string | null;
  campaign_id?: string | null;
  // §4a — the parent adset id, echoed on the /ads edge (carried onto the ad dim/facts).
  adset_id?: string | null;
  // §4a — the creative{id} field-expansion on the /ads edge: a nested object carrying only
  // the creative id (NO body is requested). creative?.id ?? null becomes the ad's creative_id.
  creative?: { id?: string | null } | null;
}

interface MetaAdsEdgeResponse {
  data?: MetaAdsEdgeNode[];
  paging?: {
    next?: string | null;
    cursors?: { after?: string | null } | null;
  } | null;
}

// Map a Graph node's status fields into our pair. configured_status falls back to the
// Graph `status` field (the operator-set value); effective_status is the computed state.
function metaAdsEdgeNodeStatus(node: MetaAdsEdgeNode): MetaAdsEntityStatus {
  return {
    effectiveStatus: stringOrNull(node.effective_status),
    // Graph returns the configured value as `status`; accept either spelling.
    configuredStatus: stringOrNull(node.configured_status) ?? stringOrNull(node.status)
  };
}

// Cursor-paginated GET over an /act_<id>/<edge> read. §4b — HEADER-AWARE: it does its OWN
// raw fetch() (NOT fetchJson, which discards response.headers) so edge reads honor the
// x-fb-ads-insights-throttle / X-Business-Use-Case-Usage utilization headers — the same
// pattern metaAdsFetchInsightsPages uses for /insights. §4e — real backoff-with-retry on
// high utilization (metaAdsFetchWithThrottleBackoff) rather than fail-loud, now that the
// headers are reachable on edges. §4d fail-loud: a hard page cap that THROWS on overrun (no
// silent truncation). bearerHeaders keeps the token in Authorization only, never the URL.
// Direct-Graph (marketing_api) only — MCP/CLI transports have no edge reader this slice
// (status degrades to NULL with a caveat). The 'ads' edge (§4a) is added to the union.
async function metaAdsReadEdge(
  credential: MetaAdsCredential,
  edge: "adsets" | "campaigns" | "ads",
  fields: string
): Promise<MetaAdsEdgeNode[]> {
  const accessToken = requireCredential(credential, "accessToken");
  const adAccountId = metaAdsAccountId(credential);
  const nodes: MetaAdsEdgeNode[] = [];
  let after: string | undefined;
  for (let page = 0; page < META_ADS_EDGE_PAGE_LIMIT; page += 1) {
    const url = new URL(`https://graph.facebook.com/${metaAdsApiVersion(credential)}/${adAccountId}/${edge}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "100");
    // §7a — include archived/paused entities (default-excluded) so their status stays
    // populated for any insights row still inside the rolling window. See the constant.
    url.searchParams.set("effective_status", JSON.stringify([...META_ADS_EDGE_STATUS_FILTER]));
    if (after) {
      url.searchParams.set("after", after);
    }
    // §4b/§4e — header-aware GET with throttle backoff. Mirrors fetchJson's retryable
    // taxonomy (401/403 non-retryable, 429 retryable, other non-2xx retryable) but reads the
    // throttle headers fetchJson would discard and backs off instead of failing loud.
    const response = await metaAdsFetchWithThrottleBackoff(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json", ...bearerHeaders(accessToken) }
    });
    const body = (await response.json()) as MetaAdsEdgeResponse;
    nodes.push(...(body.data ?? []));
    const nextAfter = metaAdsPagingAfter(body as MetaAdsInsightsResponse);
    if (!nextAfter) {
      return nodes;
    }
    after = nextAfter;
  }
  // §4d — the cursor never terminated within the cap. Fail LOUD (retryable) rather than
  // returning a silently-truncated status set that would label live entities as unknown.
  throw new ConnectorError(
    "provider_api_error",
    `Meta Ads /${edge} edge pagination exceeded the ${META_ADS_EDGE_PAGE_LIMIT}-page limit (refusing to truncate status)`,
    true
  );
}

// §4a — read /act_<id>/adsets and build the adset dim map keyed by adset_id. Status comes
// from here (it is not on insights); optimization_goal/billing_event/campaign_id too.
async function metaAdsReadAdsetDims(credential: MetaAdsCredential): Promise<Map<string, MetaAdsAdsetDim>> {
  const nodes = await metaAdsReadEdge(
    credential,
    "adsets",
    "id,name,optimization_goal,billing_event,effective_status,status,campaign_id"
  );
  const dims = new Map<string, MetaAdsAdsetDim>();
  for (const node of nodes) {
    const adsetId = stringOrNull(node.id);
    if (!adsetId) {
      continue;
    }
    const status = metaAdsEdgeNodeStatus(node);
    dims.set(adsetId, {
      adsetId,
      campaignId: stringOrNull(node.campaign_id),
      name: stringOrNull(node.name),
      optimizationGoal: stringOrNull(node.optimization_goal),
      billingEvent: stringOrNull(node.billing_event),
      currency: null,
      effectiveStatus: status.effectiveStatus,
      configuredStatus: status.configuredStatus
    });
  }
  return dims;
}

// Phase-2 slice-1b §4a — read /act_<id>/ads and build the ad dim map keyed by ad_id. Status,
// creative_id, and the parent adset_id/campaign_id come from here (none are on insights). The
// field set requests creative{id} (the field-expansion, NO body). optimization_goal is NOT
// read here — it is an ADSET property the §4b mapping carries from the adset-dim map (§4e).
async function metaAdsReadAdAdims(credential: MetaAdsCredential): Promise<Map<string, MetaAdsAdDim>> {
  const nodes = await metaAdsReadEdge(
    credential,
    "ads",
    "id,name,creative{id},adset_id,campaign_id,effective_status,status"
  );
  const dims = new Map<string, MetaAdsAdDim>();
  for (const node of nodes) {
    const adId = stringOrNull(node.id);
    if (!adId) {
      continue;
    }
    const status = metaAdsEdgeNodeStatus(node);
    dims.set(adId, {
      adId,
      campaignId: stringOrNull(node.campaign_id),
      // §7a — NULLABLE adset_id (ad-with-no-adset tolerated; carried, not required).
      adsetId: stringOrNull(node.adset_id),
      name: stringOrNull(node.name),
      // creative{id} field-expansion → creative?.id ?? null. NEVER a creative body.
      creativeId: stringOrNull(node.creative?.id),
      effectiveStatus: status.effectiveStatus,
      configuredStatus: status.configuredStatus
    });
  }
  return dims;
}

// §4a — read /act_<id>/campaigns for the campaign-status BACKFILL (fixes the Phase-1 NULL
// gap). Keyed by campaign_id; only the status pair is consumed (objective is refreshed via
// insights). The writer coalesces this into the existing campaign dim WITHOUT disturbing
// name/objective/currency.
async function metaAdsReadCampaignStatus(credential: MetaAdsCredential): Promise<Map<string, MetaAdsEntityStatus>> {
  const nodes = await metaAdsReadEdge(credential, "campaigns", "id,effective_status,status,objective");
  const statuses = new Map<string, MetaAdsEntityStatus>();
  for (const node of nodes) {
    const campaignId = stringOrNull(node.id);
    if (!campaignId) {
      continue;
    }
    statuses.set(campaignId, metaAdsEdgeNodeStatus(node));
  }
  return statuses;
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
  // A downloadable image URL. Used by the meta_ads_cli transport, whose `creative
  // create --image` flag needs a local image FILE (the CLI uploads it itself). The
  // builder downloads this URL to a temp file and passes it as --image. The direct
  // Graph path ignores it (it references a pre-uploaded image_hash instead).
  imageUrl?: string;
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
    // Carry the entity id (4th arg) so the handler can locate + best-effort PAUSE the entity that
    // is now LIVE and spending — the throw alone stops OUR flow but does not stop Meta's spend.
    throw new ConnectorError(
      "money_safety_violation",
      `Meta Ads ${entity} ${id} was created ACTIVE despite a PAUSED create request — refusing to proceed`,
      false,
      id
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

// ── CLI choice sets (review HIGH: ENUM per-transport validation) ──────────────
// The META_*_VALUES allow-lists above are SUPERSETS of what the `meta` CLI's Click
// `--objective` / `--optimization-goal` / `--billing-event` / `--custom-event-type`
// / `--call-to-action` choice sets accept. A Graph-valid value that is NOT in the
// CLI's set hard-fails INSIDE the CLI (Click "Invalid value" → non-zero exit) AFTER
// we have already spawned the process. These sets mirror the REAL CLI's Click
// choices (verified via `meta ads <sub> --help`), expressed UPPERCASE to match the
// already-normalized value the *ViaCli builders hold. Validate against these BEFORE
// spawning so an unsupported-on-CLI enum throws a clear non-retryable error early.
const META_CLI_OBJECTIVE_VALUES = new Set<string>([
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC"
]);
const META_CLI_OPTIMIZATION_GOAL_VALUES = new Set<string>([
  "APP_INSTALLS",
  "CONVERSATIONS",
  "EVENT_RESPONSES",
  "IMPRESSIONS",
  "LANDING_PAGE_VIEWS",
  "LEAD_GENERATION",
  "LINK_CLICKS",
  "OFFSITE_CONVERSIONS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "REACH",
  "THRUPLAY",
  "VALUE"
]);
const META_CLI_BILLING_EVENT_VALUES = new Set<string>([
  "APP_INSTALLS",
  "CLICKS",
  "IMPRESSIONS",
  "LINK_CLICKS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "THRUPLAY"
]);
const META_CLI_CUSTOM_EVENT_TYPE_VALUES = new Set<string>([
  "ADD_PAYMENT_INFO",
  "ADD_TO_CART",
  "ADD_TO_WISHLIST",
  "COMPLETE_REGISTRATION",
  "CONTACT",
  "CONTENT_VIEW",
  "CUSTOMIZE_PRODUCT",
  "DONATE",
  "FIND_LOCATION",
  "INITIATED_CHECKOUT",
  "LEAD",
  "OTHER",
  "PURCHASE",
  "SCHEDULE",
  "SEARCH",
  "START_TRIAL",
  "SUBMIT_APPLICATION",
  "SUBSCRIBE"
]);
const META_CLI_CALL_TO_ACTION_VALUES = new Set<string>([
  "APPLY_NOW",
  "BOOK_TRAVEL",
  "BUY_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "GET_OFFER",
  "GET_QUOTE",
  "LEARN_MORE",
  "NO_BUTTON",
  "OPEN_LINK",
  "SHOP_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
  "WATCH_MORE"
]);

// Assert an already-UPPERCASE-normalized enum value is accepted on the `meta_ads_cli`
// transport (i.e. is a member of the CLI's Click choice set). A value valid on Graph
// but NOT in the CLI set throws a clear NON-retryable ConnectorError BEFORE the CLI is
// spawned — so a Graph-only enum fails fast and uniformly rather than as an opaque,
// retryable "CLI command failed" after a process spawn. `undefined` passes through.
function assertMetaCliEnum(value: string | undefined, allowed: Set<string>, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!allowed.has(value)) {
    throw new ConnectorError(
      "provider_unsupported",
      `${field} '${value}' is not supported on the meta_ads_cli transport`,
      false
    );
  }
}

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
  if (isMetaAdsCliTransport(credential)) {
    return createMetaCampaignViaCli(credential, input);
  }
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
  if (isMetaAdsCliTransport(credential)) {
    return createMetaAdSetViaCli(credential, input);
  }
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
  if (isMetaAdsCliTransport(credential)) {
    return createMetaCreativeViaCli(credential, input);
  }
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
  if (isMetaAdsCliTransport(credential)) {
    return createMetaAdViaCli(credential, input);
  }
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
  status: MetaEntityStatus,
  // The entity token (campaign|adset|ad) selects the CLI subcommand. The direct
  // Graph node POST does NOT need it (it targets /{id}); it's only required for the
  // CLI transport, which has no entity-agnostic update path.
  entity?: MetaWriteEntity
): Promise<MetaStatusResult> {
  if (status !== "ACTIVE" && status !== "PAUSED") {
    throw new ConnectorError("provider_api_error", `Unsupported Meta entity status: ${String(status)}`, false);
  }
  if (isMetaAdsCliTransport(credential)) {
    if (!entity) {
      throw new ConnectorError(
        "provider_api_error",
        "Meta Ads CLI status change requires an entity (campaign|adset|ad) to select the subcommand",
        false
      );
    }
    return setMetaEntityStatusViaCli(credential, entity, entityId, status);
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
  entityId: string,
  // The entity token (campaign|adset|ad) selects the CLI subcommand. The direct
  // Graph node DELETE does NOT need it; required only for the CLI transport.
  entity?: MetaWriteEntity
): Promise<MetaDeleteResult> {
  if (isMetaAdsCliTransport(credential)) {
    if (!entity) {
      throw new ConnectorError(
        "provider_api_error",
        "Meta Ads CLI delete requires an entity (campaign|adset|ad) to select the subcommand",
        false
      );
    }
    return deleteMetaEntityViaCli(credential, entity, entityId);
  }
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

// ── Asset discovery (list_meta_assets) ───────────────────────────────────────
// Enumerate the ad accounts + pixels a RAW token can see, so the desktop connect
// flow can populate the account/pixel picker AND validate the token BEFORE binding
// (a token that resolves zero accounts is rejected upstream). Ported from the web
// app's fetchMetaAssets (src/lib/integrations/meta-fetch-assets.ts), preserving the
// SYSTEM-USER vs OAuth split: `/me/adaccounts` is the OAuth-user path; a SYSTEM-USER
// token (the desktop's connect path — a Business Settings system user, NOT an FB-app
// OAuth user) returns nothing there, so we fall back to `/me/businesses` ->
// `/{businessId}/owned_ad_accounts`. Pixels come from `/{account}/adspixels`.
//
// No MetaAdsCredential here on purpose: the token is raw (not yet a connected source),
// so we take the access token directly rather than the credential envelope.
const META_ASSETS_API_VERSION = "v25.0"; // matches metaAdsApiVersion's default

export interface MetaAdAccount {
  id: string;
  account_id: string;
  name: string;
  currency: string;
}
export interface MetaPixel {
  id: string;
  name: string;
}
export interface MetaBusiness {
  id: string;
  name: string;
}
export interface MetaAssetsSnapshot {
  /** Which token class resolved the accounts — drives the desktop's wording. */
  tokenKind: "user_token" | "system_user_token";
  adAccounts: MetaAdAccount[];
  pixels: MetaPixel[];
  businesses: MetaBusiness[];
  pixelsByAccount: Record<string, MetaPixel[]>;
}

interface MetaGraphList<T> {
  data?: T[];
  paging?: { next?: string | null } | null;
}

/** Paginate a Graph list edge with a bearer token. Bounded so a runaway `next` can't loop forever. */
async function paginateMetaGraph<T>(initialUrl: string, accessToken: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = initialUrl;
  let pages = 0;
  while (next && pages < 50) {
    pages += 1;
    const json: MetaGraphList<T> = await fetchJson<MetaGraphList<T>>(next, {
      method: "GET",
      headers: bearerHeaders(accessToken)
    });
    if (json.data) items.push(...json.data);
    next = json.paging?.next ?? null;
  }
  return items;
}

export async function listMetaAssets(
  accessToken: string,
  options: { apiVersion?: string; businessId?: string } = {}
): Promise<MetaAssetsSnapshot> {
  if (!accessToken || accessToken.trim() === "") {
    throw new ConnectorError("provider_auth_failed", "accessToken is required to list Meta assets", false);
  }
  const base = `https://graph.facebook.com/${options.apiVersion ?? META_ASSETS_API_VERSION}`;
  const snapshot: MetaAssetsSnapshot = {
    tokenKind: "user_token",
    adAccounts: [],
    pixels: [],
    businesses: [],
    pixelsByAccount: {}
  };

  // 1. OAuth-user path. A system-user token returns 200-empty here (it owns no personal accounts);
  //    an auth error is swallowed so we still try the system-user path below — an actually-invalid
  //    token then throws on `/me/businesses`/owned_ad_accounts and surfaces as provider_auth_failed.
  try {
    snapshot.adAccounts = await paginateMetaGraph<MetaAdAccount>(
      `${base}/me/adaccounts?fields=id,account_id,name,currency&limit=100`,
      accessToken
    );
  } catch {
    snapshot.adAccounts = [];
  }

  // 2. SYSTEM-USER path: enumerate business-owned accounts. An explicit businessId skips discovery.
  if (snapshot.adAccounts.length === 0) {
    snapshot.tokenKind = "system_user_token";
    const businesses = options.businessId
      ? [{ id: options.businessId, name: options.businessId }]
      : await paginateMetaGraph<MetaBusiness>(`${base}/me/businesses?fields=id,name`, accessToken);
    snapshot.businesses = businesses;
    for (const biz of businesses) {
      const owned = await paginateMetaGraph<MetaAdAccount>(
        `${base}/${biz.id}/owned_ad_accounts?fields=id,account_id,name,currency&limit=100`,
        accessToken
      );
      snapshot.adAccounts.push(...owned);
    }
  }

  // 3. Pixels per account. One account's failure must not sink the whole snapshot (it may simply
  //    lack pixel-read on that account), so per-account fetches are best-effort.
  for (const account of snapshot.adAccounts) {
    try {
      const pixels = await paginateMetaGraph<MetaPixel>(
        `${base}/${account.id}/adspixels?fields=id,name`,
        accessToken
      );
      if (pixels.length > 0) {
        snapshot.pixelsByAccount[account.id] = pixels;
        for (const p of pixels) {
          if (!snapshot.pixels.some((x) => x.id === p.id)) snapshot.pixels.push(p);
        }
      }
    } catch {
      // best-effort per account
    }
  }

  // 4. Businesses (when the OAuth path resolved accounts and we never fetched them in step 2).
  if (snapshot.businesses.length === 0) {
    try {
      snapshot.businesses = await paginateMetaGraph<MetaBusiness>(`${base}/me/businesses?fields=id,name`, accessToken);
    } catch {
      // best-effort
    }
  }

  return snapshot;
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

// Defense-in-depth (review): redact Meta token material from CLI stderr before it is
// embedded in a ConnectorError message. Removes the EXACT ACCESS_TOKEN value (when known)
// and any EAA…-shaped token substring. The token normally travels only via the env var,
// never in argv or output — this is a belt-and-suspenders scrub for a CLI that echoes it.
function scrubMetaToken(text: string, accessToken: string | undefined): string {
  let scrubbed = text;
  if (accessToken && accessToken.length > 0) {
    scrubbed = scrubbed.split(accessToken).join("[REDACTED]");
  }
  // Meta user/system-user tokens are EAA-prefixed base64url (may contain _ and -). Scrub any such substring.
  scrubbed = scrubbed.replace(/EAA[A-Za-z0-9_-]+/g, "[REDACTED]");
  return scrubbed;
}

async function callMetaAdsCliJson(credential: MetaAdsCredential, args: string[]): Promise<unknown> {
  const rawCliCommand =
    typeof credential.cliCommand === "string" && credential.cliCommand.trim() ? credential.cliCommand.trim() : "meta";
  // An ABSOLUTE path that exists as a file (the desktop stores exactly this) is used VERBATIM as the
  // executable — NOT run through parseProcessCommand, which tokenizes on whitespace and would split a
  // home dir containing a space (e.g. "/Users/John Smith/.local/bin/meta") into a broken executable +
  // bogus args. Only a non-path command (e.g. "uv run meta") falls back to the whitespace tokenizer.
  let executable: string;
  let commandArgs: string[];
  if (rawCliCommand.startsWith("/") && existsSync(rawCliCommand)) {
    executable = rawCliCommand;
    commandArgs = [];
  } else {
    ({ executable, args: commandArgs } = parseProcessCommand(rawCliCommand, "Meta Ads CLI command"));
    ensureExecutableOnPath(executable, "Meta Ads CLI command");
  }
  const accessToken = metaAdsCliAccessToken(credential);
  // The CLI reads its token from ACCESS_TOKEN: our explicit credential value when present, else the
  // INHERITED process.env.ACCESS_TOKEN (the documented "ambient auth" mode where the credential
  // carries no token). For stderr redaction we must scrub whichever value the CLI ACTUALLY uses —
  // relying on the credential value alone leaves the inherited token un-scrubbed (it is NOT always
  // EAA-prefixed, so the regex fallback can miss it), letting a CLI stderr echo leak it into the
  // ConnectorError message and onward into sync_errors.error_message.
  const tokenForScrub =
    accessToken ??
    (typeof process.env.ACCESS_TOKEN === "string" && process.env.ACCESS_TOKEN.trim()
      ? process.env.ACCESS_TOKEN
      : undefined);
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
        // Defense-in-depth (review): scrub token-shaped substrings (and the actual
        // ACCESS_TOKEN value the CLI uses — explicit OR ambient/inherited) from stderr
        // BEFORE embedding it in the error message, so a CLI that echoes the token in a
        // diagnostic never leaks it.
        const scrubbed = scrubMetaToken(stderrBuffer.trim(), tokenForScrub);
        const detail = scrubbed ? `: ${scrubbed}` : "";
        fail(`Meta Ads CLI command failed${detail}`);
        return;
      }
      finish(() => {
        try {
          // Some `meta` CLI commands prepend a human line (e.g. "Created campaign …")
          // before the `--output json` payload. Strip any leading non-JSON prefix up
          // to the first `{`/`[` so the structured body still parses. A pure-JSON
          // stdout (the read/insights path) is unaffected — it already starts with `{`.
          resolve(JSON.parse(stripJsonPrefix(stdoutBuffer)));
        } catch {
          reject(new ConnectorError("provider_api_error", "Meta Ads CLI command returned invalid JSON", true));
        }
      });
    });
  });
}

// Extract the `--output json` payload the `meta` CLI prints, tolerating human prefix
// lines (e.g. "Created campaign 120…"). HARDENED (review): slicing at the FIRST `{`/`[`
// anywhere in stdout is fragile — a human prefix line that itself contains a brace
// (e.g. "Created campaign 'Sale {summer}'") would start the slice mid-prefix and break
// the parse. Instead, prefer the LAST line that wholly JSON.parses; if no single line
// parses, fall back to the LAST balanced top-level JSON block in the full text. Throws
// loudly (returns the raw input → downstream JSON.parse fails) when no JSON is found.
function stripJsonPrefix(raw: string): string {
  // 1) Prefer the last line that is itself valid JSON (the common `--output json` case:
  //    the structured body is printed as a single trailing line).
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (line[0] === "{" || line[0] === "[") {
      try {
        JSON.parse(line);
        return line;
      } catch {
        // not a complete JSON line — keep scanning upward.
      }
    }
  }
  // 2) Fall back to the LAST balanced top-level JSON block found anywhere in the text
  //    (handles a payload spread across multiple lines after a prefix line).
  const block = lastBalancedJsonBlock(raw);
  if (block !== null) {
    return block;
  }
  // 3) No JSON found — return the raw input so the strict JSON.parse downstream throws a
  //    clear "invalid JSON".
  return raw;
}

// Find the LAST balanced top-level JSON object/array block in `text`, or null if none
// parses. Scans each `{`/`[` start, walks to the matching close (string-aware so braces
// inside quoted strings don't miscount), and JSON.parses the candidate; returns the last
// one that parses cleanly.
function lastBalancedJsonBlock(text: string): string | null {
  let found: string | null = null;
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") {
      continue;
    }
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            found = candidate;
          } catch {
            // not valid JSON — ignore this candidate.
          }
          break;
        }
      }
    }
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// Meta Ads CLI WRITE builders (PR — CLI write transport).
//
// Mirrors `metaAdsCliInsights`: build the `meta ads <entity> <action> …` argv from
// the per-op spec and run it via `callMetaAdsCliJson`, which injects AD_ACCOUNT_ID /
// ACCESS_TOKEN as env. The CLI does the Graph POST itself; we parse the id (and any
// echoed status) out of the `--output json` body.
//
// MONEY-SAFETY parity with the direct Graph path is enforced HERE too:
//  • creates pass `--status paused` (and the CLI also defaults PAUSED) — INVARIANT 1.
//    THIS FLAG is what GUARANTEES the create lands PAUSED. The `assertCreateNotActive`
//    echo check below is a best-effort SECONDARY guard ONLY: the CLI's `--output json`
//    body may OMIT `status`, in which case the echo guard is a NO-OP (status comes back
//    null) — so the PAUSED guarantee rests on `--status paused`, not on the echo.
//  • the parsed response is run through `assertCreateNotActive` — a Graph echo of
//    ACTIVE throws a non-retryable `money_safety_violation` exactly as on the
//    direct path (a no-op when the CLI omits status — see above).
//  • EVERY error coming out of a CLI write is normalized to retryable:false
//    (INVARIANT 3) via `metaAdsCliWrite`, even though the read path's
//    `callMetaAdsCliJson` marks transient CLI failures retryable. A money write
//    must never re-run on the worker's retry queue.
// ───────────────────────────────────────────────────────────────────────────

// Run a CLI write argv and return the parsed Graph response. Wraps
// `callMetaAdsCliJson` so that ANY error (timeout, non-zero exit, invalid JSON,
// missing binary) surfaces as a NON-retryable ConnectorError — INVARIANT 3.
async function metaAdsCliWrite(credential: MetaAdsCredential, args: string[]): Promise<MetaGraphWriteResponse> {
  let raw: unknown;
  try {
    raw = await callMetaAdsCliJson(credential, args);
  } catch (error) {
    if (error instanceof ConnectorError) {
      // Re-stamp as non-retryable: a create/status/delete must never auto-retry.
      throw new ConnectorError(error.code, error.message, false);
    }
    throw new ConnectorError(
      "provider_api_error",
      `Meta Ads CLI write failed: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new ConnectorError("provider_api_error", "Meta Ads CLI write returned a non-object JSON body", false);
  }
  return raw as MetaGraphWriteResponse;
}

// Push an optional integer-cents flag (validated by metaCents) onto a CLI argv.
function pushCentsFlag(args: string[], flag: string, value: number | undefined): void {
  const cents = metaCents(value);
  if (cents !== undefined) {
    args.push(flag, String(cents));
  }
}

// ── CLI Create: Campaign ── meta ads campaign create … ────────────────────────
async function createMetaCampaignViaCli(
  credential: MetaAdsCredential,
  input: MetaCampaignCreateInput
): Promise<MetaWriteResult> {
  // FIX 3 parity: normalize+validate the enum BEFORE it reaches the CLI.
  const objective = metaEnum(input.objective, META_OBJECTIVE_VALUES, "objective")!;
  // Per-transport gate (review HIGH): reject a Graph-valid objective the CLI's Click
  // choice set does NOT accept, BEFORE spawning, so it fails fast + non-retryably.
  assertMetaCliEnum(objective, META_CLI_OBJECTIVE_VALUES, "objective");
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    "campaign",
    "create",
    "--name",
    input.name,
    "--objective",
    objective,
    // INVARIANT 1: hard-code PAUSED (the CLI also defaults PAUSED). NEVER `active`.
    "--status",
    "paused"
  ];
  pushCentsFlag(args, "--daily-budget", input.dailyBudget);
  pushCentsFlag(args, "--lifetime-budget", input.lifetimeBudget);
  const response = await metaAdsCliWrite(credential, args);
  const id = requireGraphId("campaign", response);
  const status = assertCreateNotActive("campaign", id, response);
  return { ok: true, id, status };
}

// ── CLI Create: Ad Set ── meta ads adset create <CAMPAIGN_ID> … ───────────────
async function createMetaAdSetViaCli(
  credential: MetaAdsCredential,
  input: MetaAdSetCreateInput
): Promise<MetaWriteResult> {
  const optimizationGoal = metaEnum(input.optimizationGoal, META_OPTIMIZATION_GOAL_VALUES, "optimization goal")!;
  const billingEvent = metaEnum(input.billingEvent, META_BILLING_EVENT_VALUES, "billing event")!;
  // Per-transport gate (review HIGH): reject Graph-valid goal/billing the CLI's Click
  // choice sets do NOT accept (e.g. AD_RECALL_LIFT, PURCHASE billing), BEFORE spawning.
  assertMetaCliEnum(optimizationGoal, META_CLI_OPTIMIZATION_GOAL_VALUES, "optimization goal");
  assertMetaCliEnum(billingEvent, META_CLI_BILLING_EVENT_VALUES, "billing event");
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    "adset",
    "create",
    "--name",
    input.name,
    "--optimization-goal",
    optimizationGoal,
    "--billing-event",
    billingEvent,
    // INVARIANT 1: hard-code PAUSED.
    "--status",
    "paused"
  ];
  pushCentsFlag(args, "--daily-budget", input.dailyBudget);
  pushCentsFlag(args, "--lifetime-budget", input.lifetimeBudget);
  pushCentsFlag(args, "--bid-amount", input.bidAmount);
  if (input.startTime) args.push("--start-time", input.startTime);
  if (input.endTime) args.push("--end-time", input.endTime);
  if (input.targetingCountries && input.targetingCountries.length > 0) {
    args.push("--targeting-countries", input.targetingCountries.join(","));
  }
  if (input.pixelId) {
    args.push("--pixel-id", input.pixelId);
    // Mirror the Graph path: default the conversion event to PURCHASE when a pixel
    // is supplied. Validate/normalize first so a bad enum throws non-retryably.
    const customEventType =
      metaEnum(input.customEventType, META_CUSTOM_EVENT_TYPE_VALUES, "custom event type") ?? "PURCHASE";
    // Per-transport gate (review HIGH): reject a Graph-valid custom_event_type the CLI's
    // Click choice set does NOT accept, BEFORE spawning. (PURCHASE default is in-set.)
    assertMetaCliEnum(customEventType, META_CLI_CUSTOM_EVENT_TYPE_VALUES, "custom event type");
    args.push("--custom-event-type", customEventType);
  }
  // POSITIONAL hardening (review): "--" ends option parsing; everything after it is a
  // positional, so the CAMPAIGN_ID goes LAST (after all flags) and a leading-dash id can
  // never be misparsed as an option.
  args.push("--", input.campaignId);
  const response = await metaAdsCliWrite(credential, args);
  const id = requireGraphId("adset", response);
  const status = assertCreateNotActive("adset", id, response);
  return { ok: true, id, status };
}

// ── CLI Create: Ad Creative ── meta ads creative create … ────────────────────
// Creatives have no go-live status; nothing to PAUSE-guard. The CLI's `--image`
// flag needs a local image FILE (the CLI uploads it itself), NOT a pre-uploaded
// Graph image_hash. So this builder requires `imageUrl`: it downloads the URL to a
// temp file, passes `--image <tempfile>`, runs the CLI, then deletes the temp file
// in a finally. If ONLY an imageHash is supplied (no URL), there is no file to hand
// the CLI and a hash can't become a file → fail loud, non-retryable (review BLOCKER).
async function createMetaCreativeViaCli(
  credential: MetaAdsCredential,
  input: MetaCreativeCreateInput
): Promise<MetaWriteResult> {
  if (!input.imageUrl) {
    // A hash can't become a file. Surface a clear, non-retryable error rather than
    // passing a hash as a bogus --image path (which the CLI rejects as missing file).
    throw new ConnectorError(
      "provider_unsupported",
      "Meta creative creation via the `meta` CLI requires an imageUrl: the CLI's --image expects an " +
        "image FILE path, but only a pre-uploaded image_hash was supplied. Provide imageUrl, or use " +
        "the direct-Graph transport for creatives.",
      false
    );
  }
  // FIX 3 parity: normalize+validate the CTA enum BEFORE it reaches the CLI, and gate
  // it against the CLI's narrower Click choice set (review HIGH).
  const callToAction = metaEnum(input.callToAction, META_CALL_TO_ACTION_VALUES, "call to action");
  assertMetaCliEnum(callToAction, META_CLI_CALL_TO_ACTION_VALUES, "call to action");

  const tempPath = await downloadToTempFile(input.imageUrl, input.name);
  try {
    const args = [
      "--output",
      "json",
      "ads",
      "--ad-account-id",
      metaAdsCliAccountId(credential),
      "creative",
      "create",
      "--name",
      input.name,
      "--image",
      tempPath,
      "--page-id",
      input.pageId
    ];
    if (input.instagramUserId) args.push("--instagram-actor-id", input.instagramUserId);
    if (input.linkUrl) args.push("--link-url", input.linkUrl);
    if (input.body) args.push("--body", input.body);
    if (input.title) args.push("--title", input.title);
    if (input.description) args.push("--description", input.description);
    if (callToAction) args.push("--call-to-action", callToAction);
    const response = await metaAdsCliWrite(credential, args);
    const id = requireGraphId("creative", response);
    // Creatives have no status; report null (no PAUSE/ACTIVE concept).
    return { ok: true, id, status: null };
  } finally {
    // Best-effort cleanup; never let a unlink failure mask the real result/error.
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore — the temp file lives under os.tmpdir() and is reaped by the OS.
    }
  }
}

// Download an image URL to a uniquely-named temp file under os.tmpdir() and return
// the path. Used by createMetaCreativeViaCli to satisfy the CLI's `--image FILE`.
// Throws a NON-retryable ConnectorError on a non-2xx response or a fetch failure so
// a money-adjacent creative create never silently proceeds with a missing/bad file.
let metaCreativeTempCounter = 0;

// The `meta` CLI validates --image by FILE EXTENSION (_validate_media_path); an extensionless temp
// file fails immediately with "Unsupported format ''". So the temp file MUST carry an allowed image
// extension. Derive it from the HTTP Content-Type, else the URL path, else default to .jpg.
const META_CLI_IMAGE_EXTS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const META_CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp"
};
function metaImageExt(contentType: string | null, url: string): string {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (META_CONTENT_TYPE_EXT[ct]) return META_CONTENT_TYPE_EXT[ct];
  // URL path extension fallback (strip query/fragment first).
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  if (dot !== -1) {
    const ext = path.slice(dot).toLowerCase();
    if (META_CLI_IMAGE_EXTS.has(ext)) return ext;
  }
  return ".jpg"; // last-resort default — an allowed extension so the CLI never rejects on format
}

async function downloadToTempFile(url: string, label: string): Promise<string> {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "creative";
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new ConnectorError(
      "provider_api_error",
      `Meta creative image download failed: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  if (!response.ok) {
    throw new ConnectorError(
      "provider_api_error",
      `Meta creative image download failed: ${response.status} ${safeUrlForLogs(url)}`,
      false
    );
  }
  // Extension MUST be derived AFTER the fetch (Content-Type wins) — the CLI rejects an extensionless file.
  const ext = metaImageExt(response.headers.get("content-type"), url);
  const tempPath = join(tmpdir(), `meta-creative-${slug}-${Date.now()}-${metaCreativeTempCounter++}${ext}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(tempPath, bytes);
  return tempPath;
}

// ── CLI Create: Ad ── meta ads ad create <ADSET_ID> … ────────────────────────
async function createMetaAdViaCli(
  credential: MetaAdsCredential,
  input: MetaAdCreateInput
): Promise<MetaWriteResult> {
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    "ad",
    "create",
    "--name",
    input.name,
    "--creative-id",
    input.creativeId,
    // INVARIANT 1: hard-code PAUSED.
    "--status",
    "paused",
    // POSITIONAL hardening (review): "--" ends option parsing; the ADSET_ID positional
    // goes LAST so a leading-dash id can never be misparsed as an option.
    "--",
    input.adsetId // positional ADSET_ID
  ];
  const response = await metaAdsCliWrite(credential, args);
  const id = requireGraphId("ad", response);
  const status = assertCreateNotActive("ad", id, response);
  return { ok: true, id, status };
}

// ── CLI Status transition ── meta ads <entity> update <ID> --status … ─────────
// The CLI selects the subcommand by entity token. setMetaEntityStatus is entity-
// agnostic at the function level, so the CLI path takes the entity explicitly.
async function setMetaEntityStatusViaCli(
  credential: MetaAdsCredential,
  entity: MetaWriteEntity,
  entityId: string,
  status: MetaEntityStatus
): Promise<MetaStatusResult> {
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    metaCliEntityToken(entity),
    "update",
    "--status",
    status.toLowerCase(),
    // POSITIONAL hardening (review): "--" ends option parsing; the entity ID positional
    // goes LAST so a leading-dash id can never be misparsed as an option.
    "--",
    entityId
  ];
  const response = await metaAdsCliWrite(credential, args);
  const echoed = metaEchoedStatus(response);
  return { ok: true, id: entityId, status: echoed ?? status };
}

// ── CLI Delete ── meta ads <entity> delete <ID> --force ───────────────────────
async function deleteMetaEntityViaCli(
  credential: MetaAdsCredential,
  entity: MetaWriteEntity,
  entityId: string
): Promise<MetaDeleteResult> {
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    metaCliEntityToken(entity),
    "delete",
    "--force",
    // POSITIONAL hardening (review): "--" ends option parsing; the entity ID positional
    // goes LAST so a leading-dash id can never be misparsed as an option.
    "--",
    entityId
  ];
  await metaAdsCliWrite(credential, args);
  return { ok: true, id: entityId, deleted: true };
}

// The CLI uses the entity token directly as the `ads <token> …` subcommand.
// Creatives have no update/delete subcommand in this slice — guard against it.
function metaCliEntityToken(entity: MetaWriteEntity): string {
  if (entity === "creative") {
    throw new ConnectorError(
      "provider_unsupported",
      "Meta Ads CLI status/delete is not supported for creatives",
      false
    );
  }
  return entity;
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
    public readonly retryable: boolean,
    // Optional: the Graph entity id involved in the error. Set on a money_safety_violation so the
    // handler can identify (and best-effort PAUSE) an entity that unexpectedly landed ACTIVE.
    public readonly entityId?: string
  ) {
    super(message);
  }
}

function providerError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof ConnectorError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  // A key-mismatch decrypt failure is NOT retryable — retrying the same undecryptable credential
  // forever never helps (the worker only re-enqueues connected/degraded sources, so a non-retryable
  // typed code lets the failure flip the source to `error` and stop the doomed loop). Reconnecting
  // the source re-stores the credential under the current key.
  if (error instanceof CredentialDecryptError) {
    return { code: "credential_undecryptable", message: error.message, retryable: false };
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
  // §4b — adset identity, present ONLY when level=adset (added to the field list at that
  // grain). campaign_id is still echoed at adset grain (the carried parent key).
  adset_id?: string | null;
  adset_name?: string | null;
  // Phase-2 slice-1b §4c — ad identity, present ONLY when level=ad (added to the field list at
  // that grain). adset_id + campaign_id are still echoed at ad grain (the carried parent keys).
  ad_id?: string | null;
  ad_name?: string | null;
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
