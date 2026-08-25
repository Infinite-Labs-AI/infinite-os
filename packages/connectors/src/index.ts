import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import { writeStripeMrrMovementsAtClose } from "./stripe-mrr-movements.js";
import {
  STRIPE_DELTA_MAX_PAGES,
  STRIPE_DELTA_MAX_REFETCH_PER_RUN,
  STRIPE_DELTA_REFETCH_CONCURRENCY,
  STRIPE_EVENT_HARD_RETENTION_DAYS,
  STRIPE_EVENT_OVERLAP_MS,
  STRIPE_EVENT_SAFE_RETENTION_DAYS,
  STRIPE_EVENT_SAFETY_LAG_MS,
  StripeRequestTelemetry,
  isStripeEventSecondBoundary,
  planStripeDeltaSegment,
  readStripeOpenEventSegment,
  readStripeSyncWatermark,
  selectStripeSyncLane,
  stripeDeltaFanout,
  stripeDeltaFilterProductEvidence,
  stripeDeltaMapBounded,
  stripeDeltaMergeEventPages,
  stripeDeltaCoverageGap,
  stripeDeltaRefetchCount,
  stripeDeltaResolveRefetchTargets,
  stripeEventSecondBoundary,
  stripeTimestampMs,
  writeStripeSyncLaneAtClose,
  type StripeDeltaCheckpoint,
  type StripeEventApi,
  type StripeLaneDecision,
  type StripeSyncLaneCheckpoint,
} from "./stripe-delta.js";
import {
  applyReconciliation,
  captureLocalReconciliationProjection,
  computeReconciliationPlan,
  readStripeReconciliationWatermarks,
  reconciliationDue,
  stripeRemotePricesFromSubscriptions,
  type StripeReconcileRemoteCustomer,
  type StripeReconciliationDueReason,
  type StripeReconciliationLocalProjection,
  type StripeReconciliationRemoteState,
} from "./stripe-reconcile.js";
import { classifyStripeTrialEvents } from "./stripe-trial-spells.js";

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
  // Cloud-default credential custody: an explicit per-workspace encryption key. Server-side
  // (multi-tenant Trigger/Vercel) callers derive one key per workspace and pass it here so the
  // decrypt/re-encrypt path never touches process.env — see requiredEncryptionKey(override).
  // UNSET on desktop (single-tenant), where the process.env / .growth-os default is used, so
  // this is fully backward-compatible. Cloud-agnostic: it is just an opaque string.
  encryptionKey?: string;
  // Cloud-default windowed backfill: an explicit [windowSince, windowUntil] time window (ISO
  // 8601 or YYYY-MM-DD). Set by the cloud orchestrator to drive MANY bounded-window sync runs
  // so a mature Meta/GA4 history persists+advances the cursor without a 900s wall; each run is
  // self-contained and retries make forward progress. UNSET on desktop → today's incremental
  // behavior is identical. Honored at the single planning chokepoint (defaultPlan).
  windowSince?: string;
  windowUntil?: string;
}

export interface SyncPlan {
  cursorKey: string;
  cursorStart: string | null;
  cursorEnd: string;
  refreshWindowDays: number;
  mode: "fixture" | "live";
  backfillWindow?: string;
  // Stripe-only close checkpoint. Extraction computes the next bounded
  // reconciliation state, but it is persisted only in the successful batch
  // CLOSE transaction after raw + normalized truth has landed.
  stripeInvoiceCheckpoint?: StripeInvoiceCheckpoint;
  stripeTrialCheckpoint?: StripeTrialCheckpoint;
  // Stripe-only. Which lane (FULL replacement vs the 15-minute Events DELTA) this run took, and
  // the durable segment/watermark state it earned. Decided at PLAN time so the scheduler
  // stays dumb: it calls on a fixed cadence and the engine picks the lane.
  stripeSyncLane?: StripeLaneDecision;
  stripeLaneCheckpoint?: StripeSyncLaneCheckpoint;
  // Stripe-only. Present ONLY on a run that owes a full-set reconciliation. Decided at PLAN time
  // (which is also what forces the FULL lane), filled with the remote snapshot at EXTRACT time,
  // and consumed at CLOSE — see stripeReconciliationAtClose.
  stripeReconciliation?: StripeReconciliationRunPlan;
  // Stripe-only. Invoices the DELTA lane proved deleted: an `invoice.deleted` event in this window
  // plus a 404 on the retrieve of the same id. Applied at CLOSE (never during extraction, which
  // must stay read-only) so the removal rolls back with everything else if the close fails.
  stripeDeletedInvoiceIds?: string[];
  // Per-run provider request accounting, persisted to sync_runs.request_telemetry at CLOSE.
  requestTelemetry?: StripeRequestTelemetry;
  // GA4-only. Snapshot-replacement state, carried from EXTRACT into CLOSE (the Stripe checkpoint
  // pattern): EXTRACT records the exact refreshed [start, end] date window, how many rows each
  // report staged, and the response's property metadata; CLOSE prunes fact rows inside that window
  // whose keys this batch did not re-stage (GA4 restates attribution — obsolete "(not set)" keys
  // must go, or totals double-count) and persists the provider time zone / data-through date.
  // ABSENT on fixture syncs and on a failed/empty extract path → CLOSE prunes nothing (fail closed).
  ga4SnapshotReplacement?: Ga4SnapshotReplacementState;
}

/**
 * The GA4 snapshot-replacement contract for one sync run. Counts are PER REPORT because the
 * fail-closed rule is per fact table: a report that returned zero rows for a historical window
 * that may have data must keep the existing facts (an empty response is indistinguishable from a
 * provider hiccup), so its table is not pruned this run.
 */
export interface Ga4SnapshotReplacementState {
  /** Inclusive YYYY-MM-DD start of the refreshed window — the exact startDate sent to GA. */
  windowStartDate: string;
  /**
   * Inclusive YYYY-MM-DD end. When the request pinned windowUntil this is that bound; on the
   * steady-state path GA was asked for the 'today' KEYWORD (property-local), so the bound is
   * resolved as max(UTC today, latest staged reporting_date) — never beyond what this run could
   * have re-staged, so the prune can never reach past the refreshed span.
   */
  windowEndDate: string;
  stagedOverviewRows: number;
  stagedPageRows: number;
  stagedEventRows: number;
  /** GA4 response metadata.timeZone (property-local calendar for every date above). */
  propertyTimeZone: string | null;
  /** Latest property-local reporting_date present in any staged report (that day may be partial). */
  dataThroughDate: string | null;
}

/** The reconciliation a single sync run owes, carried from PLAN through EXTRACT into CLOSE. */
interface StripeReconciliationRunPlan {
  reason: StripeReconciliationDueReason;
  intervalMs: number;
  /**
   * The instant the remote read started; `stripe_sync_watermarks.reconciled_at` advances to
   * exactly this, so it must be the plan's own cursor end and never a fresh `now()` taken at CLOSE
   * (which would claim a comparison against state observed minutes earlier).
   */
  runStartedAt: string;
  /** Set by the FULL extractor. Absent at CLOSE means extraction never produced one — fail closed. */
  remote?: StripeReconciliationRemoteState;
  /**
   * Local canonical state as it stood BEFORE this run's LOAD committed, captured by the FULL
   * extractor. It is what makes drift MEASURABLE at all: `syncExtractedBatch` full-replaces
   * canonical state chunk by chunk before CLOSE opens, so a comparison taken at CLOSE is
   * remote-vs-what-we-just-wrote-from-that-same-remote and structurally cannot see the delta-lane
   * misses the ledger exists to count.
   *
   * Absent on a source that has never completed a full import: a first import is a BOOTSTRAP, not
   * drift — every object would read as `missing_local` and flood the ledger with rows that prove
   * nothing about the delta lane. Those runs keep the original live comparison, which still finds
   * (and repairs) the writer gaps.
   */
  localPreLoad?: StripeReconciliationLocalProjection;
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
  // Extraction tuning, same shape as refreshWindowDays: unset everywhere in production, so the
  // constants below apply. Present so a test (or a one-off recovery run on a pathological
  // source) can drive the pager without module-level mutable state.
  pageSize?: number;
  maxPagesPerRun?: number;
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

export interface XProfileSnapshot {
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

interface Ga4EventRow {
  kind: "event";
  externalId: string;
  reportingDate: string;
  hostName: string;
  eventName: string;
  eventCount: number;
  keyEvents: number;
}

// The GA4 connector is multi-objectType (Report A overview rows + Report C page
// rows + Report E event-name rows). The tagged union carries an explicit `kind`
// discriminator so toExtractedRecord / writeGa4Truth can branch on it; fixtures
// route through toExtractedRecord too, so the tag classifies them.
type Ga4SyncRow = Ga4Row | Ga4PageRow | Ga4EventRow;

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
  kind: "invoice";
  externalId: string;
  invoiceId: string;
  // Null when Stripe returned an invoice with no customer at all. Never "" — an empty
  // string would collapse every customer-less invoice onto one synthetic customer row
  // that then participates in the eligibility join.
  customerId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  customerMetricsClassification: string | null;
  // True only when the customer arrived as an EXPANDED object, i.e. its metadata was
  // actually observable. Then `customerMetricsClassification` is authoritative and a
  // null means "the tag is gone", not "we could not look". See writeStripeTruth.
  customerMetadataAuthoritative: boolean;
  subscriptionId: string | null;
  subscriptionOrigin: "subscription" | "non_subscription" | "unknown";
  status: string;
  currency: string;
  amountPaid: number;
  amountDue: number;
  // Credit notes issued against the invoice, in minor units. Post-payment credit notes
  // are the refund-shaped half; pre-payment ones only reduce what was ever owed.
  postPaymentCreditedMinor: number | null;
  prePaymentCreditedMinor: number | null;
  paidAt: string | null;
  createdAt: string;
  periodEnd: string | null;
  externalOrderId: string | null;
  lines: StripeInvoiceLineRow[];
}

interface StripeInvoiceSyncStateRow {
  backfill_state: "pending" | "in_progress" | "complete";
  backfill_starting_after: string | null;
  latest_successful_stripe_cutoff: string | Date | null;
  event_window_from: string | Date | null;
  event_window_to: string | Date | null;
  event_starting_after: string | null;
}

interface StripeInvoiceCheckpoint {
  backfillState: "pending" | "in_progress" | "complete";
  backfillStartingAfter: string | null;
  backfillCompletion: "clear" | "stamp" | "preserve";
  eventWindowFrom: string | null;
  eventWindowTo: string | null;
  eventStartingAfter: string | null;
  latestSuccessfulStripeCutoff: string | null;
}

interface StripeTrialCheckpoint {
  segmentFrom: string;
  segmentToExclusive: string;
  segmentComplete: boolean;
  segmentStartingAfter: string | null;
  latestClosedSegmentToExclusive: string | null;
  resetContinuousCoverage: boolean;
  retentionGapReason: string | null;
}

interface StripeTrialSyncStateRow {
  current_segment_from: string | Date | null;
  current_segment_to_exclusive: string | Date | null;
  current_segment_starting_after: string | null;
  continuous_coverage_from: string | Date | null;
  closed_through_exclusive: string | Date | null;
  retention_gap_count: number;
}

interface StripeSubscriptionRow {
  kind: "subscription";
  externalId: string;
  subscriptionId: string;
  liveMode: boolean | null;
  customerId: string | null;
  customerEmail: string | null;
  customerMetricsClassification: string | null;
  // See StripeInvoiceRow.customerMetadataAuthoritative.
  customerMetadataAuthoritative: boolean;
  status: string;
  currency: string | null;
  createdAt: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  endedAt: string | null;
  itemsSynced: boolean;
  discountsSynced: boolean;
  discounts: StripeDiscountRow[];
  items: StripeSubscriptionItemRow[];
}

// A CUSTOMER retrieved in its own right. The full sync only ever learns about customers as an
// expanded side-effect of an invoice or subscription, but the delta lane must be able to act on a
// bare `customer.updated` — that is how `infinite_metrics_classification` (business eligibility)
// changes reach us at all between full refreshes.
interface StripeCustomerRow {
  kind: "customer";
  externalId: string;
  customerId: string;
  email: string | null;
  name: string | null;
  metricsClassification: string | null;
  // A retrieved live customer is authoritative about its own metadata, including the ABSENCE of
  // the classification tag. A DELETED customer expands to a `{ id, deleted: true }` stub that
  // carries none, so it must never clear a stored classification. See stripeInvoiceRow.
  metadataAuthoritative: boolean;
  createdAt: string | null;
  deleted: boolean;
}

interface StripeSubscriptionEventRow {
  kind: "subscription_event";
  externalId: string;
  stripeEventId: string;
  eventType: string;
  eventCreatedAt: string;
  apiVersion: string | null;
  livemode: boolean | null;
  subscriptionId: string;
  customerId: string | null;
  currentStatus: string | null;
  previousStatus: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  endedAt: string | null;
  canceledAt: string | null;
  previousTrialStart: string | null;
  previousTrialEnd: string | null;
  segmentFrom: string;
  segmentToExclusive: string;
}

interface StripeSubscriptionItemRow {
  itemId: string;
  priceId: string | null;
  productId: string | null;
  currency: string | null;
  unitAmount: number | null;
  defaultCurrency: string | null;
  defaultUnitAmount: number | null;
  priceCurrencyOptions: Record<string, { unitAmount: number | null; customUnitAmount: boolean }>;
  currencyOptionResolved: boolean;
  quantity: number | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  recurringUsageType: string | null;
  billingScheme: string | null;
  customUnitAmount: boolean;
  transformQuantityDivideBy: number | null;
  transformQuantityRound: "up" | "down" | null;
  pricingState: string;
  discounts: StripeDiscountRow[];
}

interface StripeDiscountRow {
  discountId: string | null;
  // The COUPON behind the discount. Persisted so a `coupon.*` delta event can find the
  // subscriptions it revalues — Stripe emits no event on them (0058's local reverse index).
  couponId: string | null;
  position: number;
  amountOff: number | null;
  percentOff: number | null;
  currency: string | null;
  appliesToProductIds: string[];
  amountOffCurrencyOptions: Record<string, number>;
  currencyOptionResolved: boolean;
  duration: string | null;
  startsAt: string | null;
  endsAt: string | null;
  complete: boolean;
  incompleteReason: string | null;
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

export interface XPostRow {
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

export interface XPublicMetrics {
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
      objectType:
        row.kind === "page"
          ? "ga4_page_report"
          : row.kind === "event"
            ? "ga4_event_report"
            : "ga4_run_report",
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
    // Honor an explicit per-request horizon FIRST (the shopify/x/meta convention at their
    // callsites) — the cloud heartbeat dispatches GA4 with refreshWindowDays: 14 and must not be
    // silently overridden by the credential's setup-era pin. Default raised 7 → 14: Google
    // documents key-event attribution restating up to ~12 days after first capture, so a 7-day
    // reconcile window permanently froze restated days 8-12 (verified in prod as double-counted
    // key_events — see writeGa4Truth / ga4CloseSuccess).
    return defaultPlan(
      db,
      request,
      "ga4_run_report",
      request.refreshWindowDays ?? credential.refreshWindowDays ?? GA4_DEFAULT_REFRESH_WINDOW_DAYS,
      "live"
    );
  },
  async extractLive(_db, request, plan, credential) {
    const propertyId = requireCredential(credential, "propertyId");
    const accessToken = requireCredential(credential, "accessToken");
    const reportUrl = `${ga4BaseUrl(credential)}/${ga4PropertyPath(propertyId)}:runReport`;
    // GA4 date range — TWO regimes, keyed off whether an EXPLICIT backfill window was requested
    // (request.windowSince/windowUntil), NOT off the plan cursor. defaultPlan sets cursorStart =
    // windowSince ?? storedCursor, so a non-null cursorStart CANNOT distinguish a windowed backfill
    // from a steady-state run that simply has a stored cursor — reading plan.cursorStart directly
    // would collapse the steady-state window to the inter-sync gap.
    //   • Windowed backfill (request.windowSince/windowUntil set by the cloud orchestrator): honor the
    //     bounded [windowSince, windowUntil] span verbatim so each run persists+advances the cursor.
    //   • Steady-state incremental (no window — desktop + cloud heartbeat): re-pull the ROLLING
    //     [daysAgo(refreshWindowDays), today] reconcile window. GA4 restates late-processed conversions
    //     & attribution for days AFTER first capture, so we deliberately IGNORE the stored cursor and
    //     re-fetch the whole refresh window every tick (upsert dedupes) — otherwise restated numbers
    //     between the last sync and ~30d ago would never be re-pulled and would go stale.
    // GA4 dates are YYYY-MM-DD (slice the ISO window bounds); the non-window path uses GA4's 'today'
    // keyword so the end is property-local (not the UTC calendar date).
    const startDate = request.windowSince && plan.cursorStart
      ? plan.cursorStart.slice(0, 10)
      : daysAgo(plan.refreshWindowDays);
    const endDate = request.windowUntil ? plan.cursorEnd.slice(0, 10) : "today";
    const dateRanges = [{ startDate, endDate }];

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

    // Report E — event-name grain. key_events on Reports A/C is a property-wide lump; a second
    // key event (e.g. `purchase` next to `download_click`) makes any per-event reading impossible
    // without this dimension. Bounded like the others (a property's event taxonomy is small).
    const eventResponse = await runGa4ReportWithKeyEventsFallback(
      reportUrl,
      accessToken,
      {
        dateRanges,
        dimensions: [
          { name: "date" },
          { name: "hostName" },
          { name: "eventName" }
        ],
        metrics: [
          { name: "eventCount" },
          { name: "keyEvents" }
        ],
        limit: "10000"
      },
      1
    );
    const eventRows = (eventResponse.rows ?? []).map((row) => ga4EventRow(row));

    // Record the snapshot-replacement contract for CLOSE (see Ga4SnapshotReplacementState). The
    // steady-state end bound resolves GA's 'today' keyword: the UTC calendar date, widened to the
    // latest staged reporting_date when the property's local calendar is ahead of UTC — the prune
    // must cover every date this run re-staged and no date it could not have.
    const stagedDates = [...overviewRows, ...pageRows, ...eventRows]
      .map((row) => row.reportingDate)
      .sort();
    const maxStagedDate = stagedDates.at(-1) ?? null;
    const utcToday = daysAgo(0);
    const windowEndDate = request.windowUntil
      ? endDate
      : maxStagedDate && maxStagedDate > utcToday
        ? maxStagedDate
        : utcToday;
    plan.ga4SnapshotReplacement = {
      windowStartDate: startDate,
      windowEndDate,
      stagedOverviewRows: overviewRows.length,
      stagedPageRows: pageRows.length,
      stagedEventRows: eventRows.length,
      propertyTimeZone:
        overviewResponse.metadata?.timeZone ??
        pageResponse.metadata?.timeZone ??
        eventResponse.metadata?.timeZone ??
        null,
      dataThroughDate: maxStagedDate
    };

    return [...overviewRows, ...pageRows, ...eventRows];
  },
  writeTruth: writeGa4Truth,
  closeSuccess: ga4CloseSuccess
});

// Steady-state GA4 reconcile horizon. Google restates key-event attribution up to ~12 days after
// first capture; 14 covers that with margin. The prior 7 froze restated days 8-12 forever.
const GA4_DEFAULT_REFRESH_WINDOW_DAYS = 14;

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
    return extractPostHogEvents(plan, credential, projectId);
  },
  writeTruth: writePostHogTruth,
  closeSuccess: posthogCloseSuccess
});

// Rows per HogQL page. Unchanged from the old single-shot `limit 10000`, so one page costs the
// provider exactly what it always did — the difference is that there is now a NEXT page.
const POSTHOG_PAGE_SIZE = 10_000;

// Pages per run. 5 x 10k = 50k events, which is what the 900s cloud sync worker
// (connector-sync-run maxDuration) can extract AND load. Hitting the cap is not data loss: the
// run narrows plan.cursorEnd to what it actually loaded (see below), so the next run resumes
// exactly there and a large backlog drains over consecutive runs instead of timing out forever.
const POSTHOG_MAX_PAGES_PER_RUN = 5;

/** The (timestamp, uuid) pair the next page resumes after. */
interface PostHogKeyset {
  timestamp: string;
  uuid: string;
}

/**
 * Bounded, keyset-paginated PostHog event extraction.
 *
 * THREE properties, all load-bearing:
 *  1. BOUNDED BY THE PLAN WINDOW — `timestamp >= cursorStart and timestamp < cursorEnd`. The old
 *     query was lower-bounded only, so a windowed backfill run silently swept everything after
 *     its window and the plan's cursorEnd was a fiction.
 *  2. KEYSET CONTINUATION on (timestamp, uuid) — `timestamp > lastTs or (timestamp = lastTs and
 *     uuid > lastUuid)`. An OFFSET pager re-scans, and a timestamp-only cursor DROPS events that
 *     share the boundary instant. Note posthogDateTimeLiteral renders whole seconds, so the
 *     boundary second is RE-READ rather than skipped — inclusive-safe by construction, and the
 *     uuid de-dupe below keeps the batch clean.
 *  3. CAPPED AT POSTHOG_MAX_PAGES_PER_RUN, and a capped run tells the truth about it by narrowing
 *     `plan.cursorEnd` to the last event it actually loaded. The generic CLOSE advances the
 *     cursor from that same plan object AFTER truth commits (syncExtractedBatch), and
 *     posthogCloseSuccess rolls up that same span — so the cursor and the rollup window both
 *     describe what landed, never what was merely requested.
 */
async function extractPostHogEvents(
  plan: SyncPlan,
  credential: PostHogCredential,
  projectId: string
): Promise<PostHogEventRow[]> {
  const pageSize = posthogPositiveInt(credential.pageSize, POSTHOG_PAGE_SIZE, "pageSize");
  const maxPages = posthogPositiveInt(credential.maxPagesPerRun, POSTHOG_MAX_PAGES_PER_RUN, "maxPagesPerRun");
  const windowStart = posthogDateTimeLiteral(cursorStartIso(plan));
  const windowEnd = posthogDateTimeLiteral(plan.cursorEnd);
  const authToken = posthogAuthToken(credential);

  const rows: PostHogEventRow[] = [];
  const seenUuids = new Set<string>();
  // Explicitly annotated (here and on continuation/pageRows/lastRow below) because the keyset
  // genuinely feeds the next query that produces the next keyset — without annotations TS reports
  // that cycle as TS7022 rather than inferring through it.
  let keyset: PostHogKeyset | null = null;
  let drained = false;

  for (let page = 0; page < maxPages; page += 1) {
    const continuation: string = keyset
      ? `and (timestamp > ${posthogDateTimeLiteral(keyset.timestamp)} or (timestamp = ${posthogDateTimeLiteral(keyset.timestamp)} and uuid > '${posthogUuidLiteral(keyset.uuid)}'))`
      : "";
    const pageRows: PostHogQueryRow[] = await posthogQuery<PostHogQueryRow[]>(
      credential,
      projectId,
      authToken,
      `
        select uuid, event, distinct_id, person_id, properties, timestamp
        from events
        where timestamp >= ${windowStart}
          and timestamp < ${windowEnd}
          ${continuation}
        order by timestamp asc, uuid asc
        limit ${pageSize}
      `,
      {}
    );
    if (pageRows.length === 0) {
      drained = true;
      break;
    }

    const before = rows.length;
    for (const pageRow of pageRows) {
      const uuid = String(pageRow.uuid);
      if (seenUuids.has(uuid)) continue;
      seenUuids.add(uuid);
      rows.push(posthogEventRow(pageRow));
    }
    if (rows.length === before) {
      // The whole page was already seen, so the keyset cannot advance and looping would spin
      // forever. Only reachable if more than `pageSize` events share ONE second (the literal's
      // resolution). Fail loudly rather than silently truncate the window.
      throw new ConnectorError(
        "provider_api_error",
        `PostHog pagination stalled: ${pageRows.length} rows at ${keyset?.timestamp ?? "window start"} were all already read`,
        false
      );
    }

    const lastRow: PostHogQueryRow = pageRows[pageRows.length - 1];
    keyset = { timestamp: String(lastRow.timestamp), uuid: String(lastRow.uuid) };
    if (pageRows.length < pageSize) {
      drained = true;
      break;
    }
  }

  if (!drained && keyset) {
    // Cap hit with more of the window still unread. Claim only what landed. The boundary event
    // itself is re-read next run (`>=` lower bound) and de-duped by the truth upserts.
    plan.cursorEnd = isoFromUnknown(keyset.timestamp);
  }
  return rows;
}

function posthogPositiveInt(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConnectorError("provider_api_error", `PostHog ${field} must be a positive integer`, false);
  }
  return value;
}

// The keyset uuid is provider data interpolated into HogQL, so it is validated rather than
// escaped: PostHog event uuids are UUIDs, and anything outside this alphabet is a provider
// contract break we must not paper over by quoting it into the query.
function posthogUuidLiteral(uuid: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(uuid)) {
    throw new ConnectorError("provider_api_error", `unexpected PostHog event uuid: ${uuid}`, false);
  }
  return uuid;
}

type StripeSyncRow =
  | StripeInvoiceRow
  | StripeSubscriptionRow
  | StripeSubscriptionEventRow
  | StripeCustomerRow;

const STRIPE_SUBSCRIPTION_LIST_EXPANDS = [
  "data.customer",
  "data.items.data.price",
  "data.discounts.source.coupon",
  "data.items.data.discounts"
] as const;

// The same expands as the LIST above, minus the `data.` prefix — a retrieve returns the object,
// not a list envelope. Keeping the two in lockstep is what makes a delta-refetched subscription
// produce byte-comparable normalized rows to a full-sync one.
const STRIPE_SUBSCRIPTION_RETRIEVE_EXPANDS = [
  "customer",
  "items.data.price",
  "discounts.source.coupon",
  "items.data.discounts"
] as const;

const stripeConnector = createConnector<StripeCredential, StripeSyncRow>({
  provider: "stripe",
  fixtureRows: () => STRIPE_INVOICES,
  fixtureObjectType: "stripe_invoice",
  async testLive(_db, _request, credential) {
    const secretKey = requireCredential(credential, "secretKey");
    await stripeGet<{ data: unknown[] }>(credential, secretKey, "/v1/customers", { limit: "1" });
    return { ok: true, mode: "live", provider: "stripe" };
  },
  async planLive(db, request, credential) {
    const plan = await defaultPlan(
      db, request, "stripe_invoice", credential.refreshWindowDays ?? 30, "live"
    );
    plan.requestTelemetry = new StripeRequestTelemetry();
    // LANE SELECTION AT SYNC ENTRY. The scheduler calls on a fixed interval and
    // knows nothing about Stripe state; the engine decides FULL vs DELTA here so that contract
    // keeps the scheduler dumb. Both lanes run under the SAME `claimSourceSync` lease and the
    // same CLOSE ownership guard, so they can never interleave writes on one source.
    const nowMs = new Date(plan.cursorEnd).getTime();
    const watermark = await readStripeSyncWatermark(db, request);
    const openSegment = await readStripeOpenEventSegment(db, request);
    // The coverage gap is computed HERE, before lane selection, because it is also a
    // reconciliation trigger and `selectStripeSyncLane` needs the reconciliation answer as an
    // input. `stripeDeltaCoverageGap` is pure over the same two rows, so evaluating it twice
    // cannot disagree with the copy `selectStripeSyncLane` takes.
    const coverageGapReason = watermark
      ? stripeDeltaCoverageGap({ nowMs, watermark, openSegment })
      : null;
    const reconciliation = reconciliationDue(
      await readStripeReconciliationWatermarks(db, request),
      plan.cursorEnd,
      {
        triggers: {
          // The delta chain is broken THIS run: the snapshot has to be re-proven against a
          // complete remote set, because the events that would have repaired it are gone.
          retentionCoverageGap: coverageGapReason !== null,
          credentialOutageRecovered: await stripeCredentialOutageRecovered(db, request),
          // NOT WIRED — deliberately literal false. The connector sends no `Stripe-Version`
          // header and stores no per-source API version to compare against, so there is nothing
          // to detect a change with. (`stripe_subscription_lifecycle_events.api_version` and
          // `stripe_event_evidence.api_version` record the version of an INDIVIDUAL event, not a
          // per-source baseline.) Inventing that storage here would be a new durable contract
          // smuggled in behind a boolean; it belongs in its own change.
          apiVersionChanged: false,
          // NOT WIRED — deliberately literal false. Candidates a later change should promote to
          // real triggers, all of which are already computed elsewhere in this file:
          //   • `stripe_trial_history_coverage.incomplete_event_count > 0` / `incomplete_reasons`
          //   • a subscription whose `items_sync_complete` / `discounts_sync_complete` flag
          //     disagrees with the child rows actually present
          //   • `queryable.vw_stripe_subscription_recurring_value.value_state = 'unavailable'`
          //     on a subscription the metric views must fail closed on
          // Wiring any of them means deciding what a reconciliation is expected to FIX, which is
          // a product judgement, not plumbing: a parser gap (today's live symptom) is not
          // repairable by re-reading the same objects, so triggering on it would burn the read
          // budget every run without changing the number.
          invariantFailure: false,
        },
      },
    );
    const decision = selectStripeSyncLane({
      nowMs,
      watermark,
      openSegment,
      reconciliationDue: reconciliation.due,
    });
    plan.stripeSyncLane = decision;
    plan.requestTelemetry.setLane(decision.lane, decision.reason);
    if (reconciliation.due && reconciliation.reason) {
      plan.stripeReconciliation = {
        reason: reconciliation.reason,
        intervalMs: reconciliation.intervalMs,
        runStartedAt: plan.cursorEnd,
      };
      plan.requestTelemetry.setReconciliationDue(reconciliation.reason);
    }
    return plan;
  },
  async extractLive(db, request, plan, credential) {
    const secretKey = requireCredential(credential, "secretKey");
    const lane = plan.stripeSyncLane;
    if (!lane) throw new Error("Stripe sync lane was not planned");
    return lane.lane === "delta"
      ? stripeExtractDelta(db, request, plan, credential, secretKey)
      : stripeExtractFullRefresh(db, request, plan, credential, secretKey, lane);
  },
  writeTruth: writeStripeTruth,
  closeSuccess: writeStripeCloseSuccess,
  toExtractedRecord: (row, plan) => ({
    externalId: row.externalId,
    objectType: row.kind === "invoice"
      ? "stripe_invoice"
      : row.kind === "subscription"
        ? "stripe_subscription"
        : row.kind === "customer"
          ? "stripe_customer"
          : "stripe_subscription_event",
    payloadVersion: plan.mode === "fixture" ? "fixture-v1" : "live-v1",
    sourceUpdatedAt: plan.mode === "fixture"
      ? null
      : row.kind === "subscription_event"
        ? row.eventCreatedAt
        : plan.cursorEnd,
    payload: row
  })
});

/**
 * Was this source locked OUT by a credential-grade failure that it is now attempting to recover
 * from? Anything that changed in Stripe while we could not authenticate emitted events we can no
 * longer read once they age past retention, so the snapshot has to be re-proven.
 *
 * Read at PLAN time and acted on at CLOSE, which is exactly the right shape: CLOSE is only
 * reached when the credential DID work, so "was locked out at plan time + reached close" is the
 * recovery. The status column itself cannot be used — `claimSourceSync` has already moved the
 * source to `syncing` by the time any connector plans — so the durable evidence is the failure
 * streak (zeroed by every transition back to `connected`, see updateSourceStatus in @infinite-os/db)
 * paired with the classification of the last recorded error.
 *
 * DELIBERATELY NARROW: only the two TERMINAL, credential-grade codes count. A transient network
 * blip also advances the streak, and treating that as an outage would force a full reconciliation
 * (and its complete-list reads) after every flaky night — burning exactly the read allowance the
 * delta lane exists to protect.
 */
async function stripeCredentialOutageRecovered(
  db: InfiniteOsDb,
  request: SyncRequest,
): Promise<boolean> {
  const row = await db.one<{ failures: number; last_error_code: string | null }>(
    `select s.consecutive_sync_failures as failures,
            (select e.error_code
               from sync_errors e
              where e.workspace_id = s.workspace_id and e.source_id = s.id
                and e.sync_run_id is distinct from $3
              order by e.created_at desc, e.id desc
              limit 1) as last_error_code
       from sources s
      where s.id = $2 and s.workspace_id = $1`,
    [request.workspaceId, request.sourceId, request.syncRunId],
  );
  if (!row || Number(row.failures) <= 0 || !row.last_error_code) return false;
  return TERMINAL_SYNC_ERROR_CODES.has(row.last_error_code);
}

/**
 * Assemble the reconciliation lane's remote snapshot from what the FULL refresh already fetched.
 *
 * Every `listComplete` flag here is a load-bearing honesty claim — it is the ONLY thing standing
 * between the reconciler and inventing deletions:
 *   • subscriptions — TRUE. `stripeList` pages `/v1/subscriptions?status=all` to exhaustion.
 *   • invoices      — FALSE, always. `stripeReconcilePaidInvoices` returns either a BOUNDED page
 *                     of `status=paid` invoices (the backfill crawl) or the invoices named by
 *                     `invoice.paid` events. Neither is the invoice set.
 *   • customers     — FALSE. The full refresh never lists `/v1/customers`; customers are only ever
 *                     seen as an EXPANDED side-effect of a subscription or invoice.
 *   • prices        — FALSE by construction (see stripeRemotePricesFromSubscriptions).
 *
 * Customers are built from the raw expanded objects rather than from the normalized subscription
 * row on purpose: `StripeSubscriptionRow` carries the customer's email and classification but NOT
 * its `name`, and the reconciler compares `name`. Feeding it a null name would report drift on
 * every run and then "repair" a real stored name to null. `stripeCustomerRow` reads the whole
 * projection off the expanded object, and un-expanded / deleted-stub customers are skipped
 * entirely — they assert nothing about their own fields.
 */
function stripeFullRefreshRemoteState(
  subscriptions: StripeSubscriptionRow[],
  invoices: StripeInvoiceRow[],
  expandedCustomers: unknown[],
): StripeReconciliationRemoteState {
  const customers = new Map<string, StripeReconcileRemoteCustomer>();
  for (const candidate of expandedCustomers) {
    // A bare id string is a REFERENCE, not an observation.
    if (typeof candidate !== "object" || candidate === null) continue;
    const keyed = candidate as Record<string, unknown> & { id?: unknown };
    // An object we cannot key names no customer, so it can neither be compared nor prove anything
    // about deletion (this set is already `listComplete: false`). Skipped rather than thrown on:
    // this is a diagnostic side-path bolted onto the full refresh, and a shape the sync tolerated
    // yesterday must not start failing it today just because a reconciliation came due.
    if (typeof keyed.id !== "string" || keyed.id.trim() === "") continue;
    const row = stripeCustomerRow(keyed as Record<string, unknown> & { id?: string });
    // A deleted customer expands to a `{ id, deleted: true }` stub carrying no fields at all.
    if (!row.metadataAuthoritative) continue;
    customers.set(row.customerId, {
      customerId: row.customerId,
      email: row.email,
      name: row.name,
      metricsClassification: row.metricsClassification,
      metadataAuthoritative: true,
    });
  }
  return {
    customers: { rows: [...customers.values()], listComplete: false },
    subscriptions: { rows: subscriptions, listComplete: true },
    invoices: { rows: invoices, listComplete: false },
    prices: stripeRemotePricesFromSubscriptions(subscriptions),
  };
}

/**
 * FULL REFRESH — list every subscription, reconcile paid invoices, poll the filtered trial
 * lifecycle events. Unchanged from the pre-delta behaviour except that it now also stamps the
 * watermark, so the delta lane knows a complete import exists and when it happened.
 */
async function stripeExtractFullRefresh(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  credential: StripeCredential,
  secretKey: string,
  lane: StripeLaneDecision
): Promise<StripeSyncRow[]> {
  const telemetry = plan.requestTelemetry;
  const [invoices, subscriptions, subscriptionEvents] = await Promise.all([
    stripeReconcilePaidInvoices(db, request, plan, credential, secretKey),
    stripeList<StripeSubscriptionApi>(credential, secretKey, "/v1/subscriptions", {
      limit: "100",
      status: "all",
      "expand[]": [...STRIPE_SUBSCRIPTION_LIST_EXPANDS]
    }, telemetry)
      .then((listed) => stripeSubscriptionsWithCompleteItems(credential, secretKey, listed, telemetry))
      .then((listed) => stripeSubscriptionsWithConditionalPrices(credential, secretKey, listed, telemetry)),
    stripeReconcileSubscriptionEvents(db, request, plan, credential, secretKey),
  ]);
  const rows: StripeSyncRow[] = [];
  const invoiceRows: StripeInvoiceRow[] = [];
  for (const invoice of invoices) {
    const lines = await stripeInvoiceLines(credential, secretKey, invoice, telemetry);
    const invoiceRow = stripeInvoiceRow(invoice, lines);
    invoiceRows.push(invoiceRow);
    rows.push(invoiceRow);
  }
  const coupons = await stripeCouponsForSubscriptions(credential, secretKey, subscriptions, telemetry);
  const subscriptionRows = subscriptions.map((sub) => stripeSubscriptionRow(sub, coupons));
  rows.push(...subscriptionRows);
  // The reconciliation snapshot is assembled from the objects this run ALREADY fetched — it costs
  // zero extra Stripe reads. It is attached only when the plan owes a reconciliation, so a routine
  // full refresh carries no snapshot and CLOSE reconciles nothing.
  if (plan.stripeReconciliation) {
    plan.stripeReconciliation.remote = stripeFullRefreshRemoteState(
      subscriptionRows,
      invoiceRows,
      [
        ...subscriptions.map((sub) => sub.customer),
        ...invoices.map((invoice) => invoice.customer),
      ],
    );
    // PRE-LOAD, and it must stay here: extraction is the last point before `syncExtractedBatch`
    // starts committing the full replacement. Captured only when a prior full import exists — see
    // `localPreLoad` for why a bootstrap must not be measured as drift.
    if (lane.reason !== "no_watermark" && lane.reason !== "no_completed_full_import") {
      plan.stripeReconciliation.localPreLoad =
        await captureLocalReconciliationProjection(db, request);
    }
  }
  const trialCheckpoint = plan.stripeTrialCheckpoint;
  if (!trialCheckpoint) throw new Error("Stripe trial event checkpoint was not planned");
  rows.push(...subscriptionEvents
    .filter((event) => STRIPE_SUBSCRIPTION_EVENT_TYPES.includes(
      event.type as (typeof STRIPE_SUBSCRIPTION_EVENT_TYPES)[number],
    ))
    .map((event) => stripeSubscriptionEventRow(event, trialCheckpoint)));

  plan.stripeLaneCheckpoint = {
    lane: "full",
    fullRefreshAt: plan.cursorEnd,
    // `delta_data_as_of` has ONE meaning across both lanes: "events and current state observed
    // through". A full run cannot honestly claim the un-lagged instant, because the events that
    // will justify the NEXT delta window's start are only listable after the safety lag.
    deltaDataAsOf: new Date(
      stripeEventSecondBoundary(new Date(plan.cursorEnd).getTime() - STRIPE_EVENT_SAFETY_LAG_MS)
    ).toISOString(),
    resetContinuousCoverage: lane.coverageGapReason !== null,
    coverageGapReason: lane.coverageGapReason,
  };
  return rows;
}

/** The provider HTTP status behind a failed request, or null when the error is not one. */
function stripeErrorStatus(error: unknown): number | null {
  return error instanceof ConnectorError && typeof error.status === "number" ? error.status : null;
}

/**
 * DELTA — one unfiltered `/v1/events` poll, local filtering, changed-object re-fetch.
 *
 * The re-fetched objects go through the SAME extract-row builders and writers the full sync
 * uses, so every downstream view and CLOSE-time classifier works unchanged: the delta lane
 * produces normalized rows that are indistinguishable from full-sync rows.
 */
async function stripeExtractDelta(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  credential: StripeCredential,
  secretKey: string
): Promise<StripeSyncRow[]> {
  const telemetry = plan.requestTelemetry;
  const cursorEndMs = new Date(plan.cursorEnd).getTime();
  if (!Number.isFinite(cursorEndMs)) throw new Error("Stripe delta cursor end is invalid");

  const watermark = await readStripeSyncWatermark(db, request);
  const openSegment = await readStripeOpenEventSegment(db, request);
  const invoiceState = await db.one<StripeInvoiceSyncStateRow>(
    `select backfill_state, backfill_starting_after, latest_successful_stripe_cutoff,
            event_window_from, event_window_to, event_starting_after
       from stripe_invoice_sync_state
      where workspace_id = $1 and source_id = $2`,
    [request.workspaceId, request.sourceId]
  );
  const trialState = await db.one<StripeTrialSyncStateRow>(
    `select current_segment_from, current_segment_to_exclusive,
            current_segment_starting_after, continuous_coverage_from,
            closed_through_exclusive, retention_gap_count
       from stripe_trial_history_coverage
      where workspace_id = $1 and source_id = $2`,
    [request.workspaceId, request.sourceId]
  );

  // ONE POLL, THREE COVERAGES. The window starts at the EARLIEST durable cutoff among the delta
  // watermark, the invoice-events cutoff and the trial closed-through bound, so a single
  // unfiltered poll can honestly close all three. Containment is re-checked below before any of
  // them is advanced — a window that does not reach back far enough advances only itself.
  const invoiceCutoffMs = stripeTimestampMs(invoiceState?.latest_successful_stripe_cutoff ?? null);
  const trialClosedThroughMs = stripeTimestampMs(trialState?.closed_through_exclusive ?? null);
  const segment = planStripeDeltaSegment({
    cursorEndMs,
    fromCandidatesMs: [
      stripeTimestampMs(watermark?.delta_data_as_of ?? null),
      invoiceCutoffMs,
      trialClosedThroughMs,
    ].filter((value): value is number => value !== null),
    openSegment,
  });

  const eventParams = {
    limit: "100",
    // DELIBERATELY UNFILTERED. Stripe caps `types[]` at 20 entries and our relevant set is 33
    // (see STRIPE_DELTA_EVENT_PREFIXES), so a filtered poll would need multiple requests
    // against the very read allowance this lane exists to protect. Filter locally instead.
    "created[gte]": String(segment.segmentFromMs / 1_000),
    "created[lt]": String(segment.segmentToExclusiveMs / 1_000),
  };
  const eventPage = await stripeListBounded<StripeEventApi>(
    credential,
    secretKey,
    "/v1/events",
    eventParams,
    segment.paginationCursor,
    STRIPE_DELTA_MAX_PAGES,
    telemetry
  );

  // RESUMED-SEGMENT TOP-UP. `starting_after` walks strictly OLDER entries, so a resumed segment can
  // only ever see events indexed BEFORE its cursor. The Events list is eventually consistent (that
  // is why the window carries a safety lag at all), so an event indexed LATE — after the first run
  // paged past its position but still inside the same window bounds — would be invisible to every
  // resumed page and the segment would then close as complete, permanently. One fresh FIRST page of
  // the same bounds costs a single read and closes that hole; duplicates are free because the
  // fan-out de-dupes on event id and the evidence table is insert-only.
  let events = eventPage.items;
  if (segment.resumedSegmentId !== null && eventPage.complete) {
    const relist = await stripeListBounded<StripeEventApi>(
      credential,
      secretKey,
      "/v1/events",
      eventParams,
      null,
      1,
      telemetry
    );
    events = stripeDeltaMergeEventPages(eventPage.items, relist.items);
  }
  telemetry?.recordEventsObserved(events.length);

  const fanout = stripeDeltaFanout(events);
  const targets = await stripeDeltaResolveRefetchTargets(db, request, fanout);

  // REFETCH BUDGET. One `price.*`/`coupon.*` edit fans out through the LOCAL reverse index to every
  // subscription referencing it, so the retrieve count is unbounded by construction. Past the
  // budget a FULL refresh is strictly cheaper AND strictly more complete, so this run refuses the
  // window WHOLE: no retrieves at all (a half-applied window is the one outcome worth avoiding),
  // no watermark advance, no trial/invoice coverage claim — just the events kept as evidence and a
  // durable demand that makes the NEXT tick take the full lane.
  const refetchCount = stripeDeltaRefetchCount(targets);
  if (refetchCount > STRIPE_DELTA_MAX_REFETCH_PER_RUN) {
    plan.stripeLaneCheckpoint = {
      lane: "delta",
      segmentFrom: segment.segmentFrom,
      segmentToExclusive: segment.segmentToExclusive,
      paginationCursor: segment.paginationCursor,
      segmentComplete: false,
      eventCount: events.length,
      refetchCount: 0,
      evidence: stripeDeltaFilterProductEvidence(fanout, targets.storedProductIds),
      resetContinuousCoverage: false,
      pendingFullRefreshReason: "delta_fanout_exceeded",
    };
    return [];
  }

  // OBSERVED DELETIONS. Deleting a DRAFT invoice is a routine dashboard action, and a refetch 404
  // for an invoice named by an `invoice.deleted` event in THIS window is an observed deletion, not
  // an outage.
  //
  // REVENUE-SAFE BY STRIPE'S OWN RULE, quoted verbatim (docs.stripe.com/api/invoices/delete):
  //   "Permanently deletes a one-off invoice draft. … Attempts to delete invoices that are no
  //    longer in a draft state will fail; once an invoice has been finalized or if an invoice is
  //    for a subscription, it must be voided."
  // So a deleted invoice was never finalized, was never for a subscription, and never reached
  // `status = 'paid'` — the only status the revenue views read. `invoice.deleted` is likewise
  // documented as "Occurs whenever a draft invoice is deleted".
  //
  // A 404 WITHOUT the corresponding event stays a hard error — that is a real anomaly, and papering
  // over it would let a silent provider-side disappearance rewrite the numbers.
  const deletedInvoiceIds = new Set(
    fanout.evidence
      .filter((row) => row.objectKind === "invoice" && row.eventType === "invoice.deleted")
      .map((row) => row.objectExternalId),
  );
  const observedInvoiceDeletions: string[] = [];
  const invoiceApis = (await stripeDeltaMapBounded(
    targets.invoiceIds,
    STRIPE_DELTA_REFETCH_CONCURRENCY,
    async (invoiceId) => {
      try {
        return await stripeGet<StripeInvoiceApi>(
          credential,
          secretKey,
          `/v1/invoices/${encodeURIComponent(invoiceId)}`,
          { "expand[]": ["customer"] },
          telemetry
        );
      } catch (error) {
        if (stripeErrorStatus(error) === 404 && deletedInvoiceIds.has(invoiceId)) {
          observedInvoiceDeletions.push(invoiceId);
          return null;
        }
        throw error;
      }
    }
  )).filter((invoice): invoice is StripeInvoiceApi => invoice !== null);
  const retrievedSubscriptions = await stripeDeltaMapBounded(
    targets.subscriptionIds,
    STRIPE_DELTA_REFETCH_CONCURRENCY,
    (subscriptionId) => stripeGet<StripeSubscriptionApi>(
      credential,
      secretKey,
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { "expand[]": [...STRIPE_SUBSCRIPTION_RETRIEVE_EXPANDS] },
      telemetry
    )
  );
  const customerApis = await stripeDeltaMapBounded(
    targets.customerIds,
    STRIPE_DELTA_REFETCH_CONCURRENCY,
    (customerId) => stripeGet<Record<string, unknown> & { id?: string }>(
      credential,
      secretKey,
      `/v1/customers/${encodeURIComponent(customerId)}`,
      {},
      telemetry
    )
  );

  const subscriptions = await stripeSubscriptionsWithConditionalPrices(
    credential,
    secretKey,
    // ITEM PAGINATION: a retrieved subscription embeds only the first page of items, so
    // `has_more` must be followed or the delete-and-replace child write would drop real items.
    await stripeSubscriptionsWithCompleteItems(credential, secretKey, retrievedSubscriptions, telemetry),
    telemetry
  );

  const rows: StripeSyncRow[] = [];
  for (const invoice of invoiceApis) {
    const lines = await stripeInvoiceLines(credential, secretKey, invoice, telemetry);
    rows.push(stripeInvoiceRow(invoice, lines));
  }
  const coupons = await stripeCouponsForSubscriptions(credential, secretKey, subscriptions, telemetry);
  rows.push(...subscriptions.map((sub) => stripeSubscriptionRow(sub, coupons)));
  rows.push(...customerApis.map((customer) => stripeCustomerRow(customer)));
  telemetry?.recordObjectsRefetched(
    invoiceApis.length + subscriptions.length + customerApis.length
  );
  if (observedInvoiceDeletions.length > 0) {
    plan.stripeDeletedInvoiceIds = [...new Set(observedInvoiceDeletions)].sort();
  }

  // A BOOTSTRAP TRIAL CRAWL IS IN FLIGHT. `closed_through_exclusive` is null while the multi-run
  // backfill of trial lifecycle history is still walking (real for any account with more than
  // ~500 lifecycle events in the 28-day retention window), and `current_segment_*` carries its
  // resume cursor. The delta window is minutes wide, so stamping a COMPLETE trial checkpoint from
  // it would null that cursor and claim `closed_through_exclusive` at the delta bound — discarding
  // the crawl and permanently losing every trial older than this window, with nothing left to
  // resume from. The daily FULL lane owns that crawl; the delta lane stays out of its way.
  const trialBootstrapInProgress = trialClosedThroughMs === null
    && stripeTimestampMs(trialState?.current_segment_from ?? null) !== null;

  // The trial lifecycle lane and the invoice-events cutoff ride THIS poll rather than paying for
  // their own filtered polls — but only when the segment CLOSED (a bounded-page run has not seen
  // the whole window) and only when the window reaches back below their own durable cutoff. A
  // non-containing window advances nothing but the delta watermark, so no lane ever claims
  // coverage of an interval it did not observe. Their pagination cursors are NEVER written from
  // here: an unfiltered-stream cursor does not index a filtered result set.
  if (eventPage.complete) {
    if (
      !trialBootstrapInProgress
      && (trialClosedThroughMs === null || segment.segmentFromMs <= trialClosedThroughMs)
    ) {
      const trialCheckpoint: StripeTrialCheckpoint = {
        segmentFrom: segment.segmentFrom,
        segmentToExclusive: segment.segmentToExclusive,
        segmentComplete: true,
        segmentStartingAfter: null,
        latestClosedSegmentToExclusive: segment.segmentToExclusive,
        resetContinuousCoverage: trialClosedThroughMs === null,
        retentionGapReason: trialClosedThroughMs === null ? "delta_lane_bootstrap" : null,
      };
      plan.stripeTrialCheckpoint = trialCheckpoint;
      rows.push(...events
        .filter((event) => STRIPE_SUBSCRIPTION_EVENT_TYPES.includes(
          event.type as (typeof STRIPE_SUBSCRIPTION_EVENT_TYPES)[number],
        ))
        .map((event) => stripeSubscriptionEventRow(
          event as unknown as StripeSubscriptionEventApi,
          trialCheckpoint
        )));
    }
    if (
      invoiceState?.backfill_state === "complete"
      && invoiceCutoffMs !== null
      && segment.segmentFromMs <= invoiceCutoffMs
    ) {
      plan.stripeInvoiceCheckpoint = {
        backfillState: "complete",
        backfillStartingAfter: null,
        backfillCompletion: "preserve",
        eventWindowFrom: null,
        eventWindowTo: null,
        eventStartingAfter: null,
        latestSuccessfulStripeCutoff: segment.segmentToExclusive,
      };
    }
  }

  const deltaCheckpoint: StripeDeltaCheckpoint = {
    lane: "delta",
    segmentFrom: segment.segmentFrom,
    segmentToExclusive: segment.segmentToExclusive,
    paginationCursor: eventPage.nextStartingAfter,
    segmentComplete: eventPage.complete,
    eventCount: events.length,
    refetchCount: invoiceApis.length + subscriptions.length + customerApis.length,
    evidence: stripeDeltaFilterProductEvidence(fanout, targets.storedProductIds),
    // Always false BY CONSTRUCTION: every coverage gap forces the FULL lane at plan time, so a
    // delta run is never the one that discovers (or has to record) a broken chain.
    resetContinuousCoverage: false,
    // Cleared on every applied window: only the fan-out refusal above parks a demand.
    pendingFullRefreshReason: null,
  };
  plan.stripeLaneCheckpoint = deltaCheckpoint;
  return rows;
}

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
    } else if (metaAdsReadsViaCli(credential)) {
      // Ambient-auth CLI credential (no stored token) — only the local CLI can authenticate.
      await metaAdsCliInsights(credential, {
        fields: META_ADS_INSIGHTS_PROBE_FIELDS,
        limit: "1",
        datePreset: "today"
      });
    } else {
      // Primary direct-Graph probe. Also taken by transport=meta_ads_cli credentials that
      // store their own accessToken (see metaAdsReadsViaCli) so the test reflects CREDENTIAL
      // health, not whether this particular host has the `meta` binary.
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
    const timeOptions = metaAdsTimeOptions(request, plan);
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
    // request is byte-for-byte identical to before this change. The CLI branch is
    // AMBIENT-AUTH ONLY (metaAdsReadsViaCli): a CLI-transport credential that stores its own
    // accessToken reads via the primary direct-Graph path below — the stored token is exactly
    // what the CLI would have been handed (ACCESS_TOKEN), and the primary path works on any
    // worker instead of requiring the connect-time host's local `meta` binary.
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
    if (metaAdsReadsViaCli(credential)) {
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
  closeSuccess?: (tx: InfiniteOsDb, request: SyncRequest, plan: SyncPlan) => Promise<void>;
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
      // Claim before credential resolution, planning, connection testing, or extraction. A
      // same-source run must observe one provider snapshot at a time; claiming only when LOAD
      // opens would allow a competitor to fetch stale truth while the first run is loading.
      // Admission errors intentionally sit outside the failure recorder: a rejected competitor
      // did not own the source and must not mutate the owner's run or failure streak.
      await claimSourceSync(db, request);
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
      return syncExtractedBatch(
        db,
        request,
        plan,
        extracted,
        (tx, records, rawIds) =>
          options.writeTruth(
            tx,
            request,
            // The chunk's records (NOT the full batch) — kept index-aligned with the
            // chunk's rawIds so writeTruth's per-record `rows[i]/rawIds[i]` pairing holds.
            records.map((record) => record.payload as Row),
            rawIds
          ),
        options.closeSuccess
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
    // Windowed backfill: an explicit request window pins the plan span so a cloud orchestrator can
    // drive many bounded [since, until] runs. Unset (desktop) → today's incremental behavior:
    // cursorStart is the stored cursor (or null when ignoreCursor), cursorEnd is now.
    cursorStart: request.windowSince ?? (options.ignoreCursor ? null : cursorValue),
    cursorEnd: request.windowUntil ?? new Date().toISOString(),
    refreshWindowDays,
    mode,
    ...(backfillWindow ? { backfillWindow } : {})
  };
}

// Records per raw-load transaction. The embedded PGlite backend serves a SINGLE
// connection and withTransaction() holds that connection's mutex for the whole
// callback — so loading a large batch in ONE transaction blocks every interactive
// read behind it (the desktop fires syncs ~30s after app open, right when the user
// is browsing). Chunking releases the mutex between chunks so reads interleave.
// 500 keeps each chunk's multi-row INSERT well under Postgres' 65535 bound-param
// limit (raw_records is 11 params/row → ≤5500).
const SYNC_BATCH_CHUNK_SIZE = 500;

// A collision-proof in-memory key for the raw_records conflict target. JSON
// encoding is unambiguous (it escapes the separators), so distinct
// (object_type, external_id, source_record_hash) triples can never alias each
// other in the id map — even when an external_id contains arbitrary punctuation.
function rawRecordNaturalKey(objectType: string, externalId: string, sourceRecordHash: string): string {
  return JSON.stringify([objectType, externalId, sourceRecordHash]);
}

// Upsert one chunk of raw_records with a SINGLE multi-row INSERT and return the
// resolved id per record, IN ORDER (aligned to `chunk`). Preserves the old
// per-record semantics exactly:
//   - a genuinely-new row takes its pre-generated `raw_<uuid>` id;
//   - an existing row (re-sync of the same window) keeps its original id;
//   - an intra-chunk duplicate (same natural key) resolves to the SAME id as its
//     first occurrence (the old loop's second insert hit on-conflict → same id).
// Postgres does NOT guarantee RETURNING row order matches VALUES order, so we
// RETURN the natural key alongside the id and rebuild the mapping by key. When the
// DB returns nothing (the unit-test mock), each record falls back to its own
// proposed id — byte-identical to the old `rawRecord?.id ?? proposedRawId`.
async function upsertRawRecordsChunk(
  tx: InfiniteOsDb,
  request: SyncRequest,
  batchId: string,
  chunk: ExtractedRecord<unknown>[]
): Promise<string[]> {
  const proposed = chunk.map(() => `raw_${randomUUID()}`);
  const keyOf = (record: ExtractedRecord<unknown>) =>
    rawRecordNaturalKey(record.objectType, record.externalId, hashRecord(record.payload));

  // De-dupe the INSERT VALUES by conflict target. A multi-row `on conflict do
  // update` throws ("cannot affect row a second time") if the same target appears
  // twice — the old per-statement loop tolerated intra-batch dupes, so we insert
  // one row per distinct key (first occurrence's proposed id) while still resolving
  // EVERY record below.
  const uniqueByKey = new Map<string, { record: ExtractedRecord<unknown>; proposedId: string }>();
  chunk.forEach((record, index) => {
    const key = keyOf(record);
    if (!uniqueByKey.has(key)) {
      uniqueByKey.set(key, { record, proposedId: proposed[index] });
    }
  });
  const uniqueRows = [...uniqueByKey.values()];

  const COLUMNS_PER_ROW = 11;
  const valuesSql = uniqueRows
    .map((_, i) => {
      const b = i * COLUMNS_PER_ROW;
      // jsonb (payload) and timestamptz (source_updated_at) casts per row, matching
      // the old single-row INSERT.
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8}::jsonb,$${b + 9},$${b + 10},$${b + 11}::timestamptz)`;
    })
    .join(",");
  const params: unknown[] = [];
  for (const { record, proposedId } of uniqueRows) {
    params.push(
      proposedId,
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
    );
  }

  // `do update set payload = raw_records.payload` is a no-op write (keeps the
  // existing payload, exactly like before) whose only purpose is to make RETURNING
  // emit the conflicting row (a bare DO NOTHING returns no row for conflicts).
  const returned = await tx.query<{
    id: string;
    object_type: string;
    external_id: string;
    source_record_hash: string;
  }>(
    `
      insert into raw_records (
        id, workspace_id, source_id, sync_batch_id, provider, object_type,
        external_id, payload, payload_version, source_record_hash, source_updated_at
      )
      values ${valuesSql}
      on conflict (source_id, object_type, external_id, source_record_hash)
      do update set payload = raw_records.payload
      returning id, object_type, external_id, source_record_hash
    `,
    params
  );

  const idByKey = new Map<string, string>();
  for (const row of returned) {
    idByKey.set(rawRecordNaturalKey(row.object_type, row.external_id, row.source_record_hash), row.id);
  }
  return chunk.map((record, index) => idByKey.get(keyOf(record)) ?? proposed[index]);
}

// Insert one chunk of sync_batch_records with a SINGLE multi-row INSERT — one row
// per record (dupes included, matching the old per-record loop), all 'raw_written'.
async function insertSyncBatchRecordsChunk(
  tx: InfiniteOsDb,
  batchId: string,
  rawIds: string[]
): Promise<void> {
  if (rawIds.length === 0) {
    return;
  }
  const COLUMNS_PER_ROW = 3;
  const valuesSql = rawIds
    .map((_, i) => {
      const b = i * COLUMNS_PER_ROW;
      return `($${b + 1},$${b + 2},$${b + 3},'raw_written')`;
    })
    .join(",");
  const params: unknown[] = [];
  for (const rawId of rawIds) {
    params.push(`sbr_${randomUUID()}`, batchId, rawId);
  }
  await tx.query(
    `insert into sync_batch_records (id, sync_batch_id, raw_record_id, record_status) values ${valuesSql}`,
    params
  );
}

async function claimSourceSync(db: InfiniteOsDb, request: SyncRequest): Promise<void> {
  await db.withTransaction(async (tx) => {
    const sources = await tx.query<{ provider: string; status: string }>(
      `select provider, status
         from sources
        where id = $1 and workspace_id = $2
        for update`,
      [request.sourceId, request.workspaceId]
    );
    const source = sources[0];
    if (!source || source.provider !== request.provider) {
      throw new ConnectorError(
        "source_scope_mismatch",
        "source is outside the requested workspace or provider scope",
        false
      );
    }
    if (source.status === "syncing") {
      throw new ConnectorError("sync_in_progress", "source is already syncing", true);
    }

    // Boot recovery deliberately repairs a crashed owner's source status without replaying
    // historical run bookkeeping. Retire any such stale `running` row as part of the next
    // admitted claim so the exact running run below is the durable ownership token.
    await tx.query(
      `update sync_batches
          set status = 'failed', finished_at = now(),
              error = coalesce(error, 'superseded after stale syncing-source recovery')
        where workspace_id = $1 and source_id = $2 and status = 'running'
          and sync_run_id in (
            select id from sync_runs
             where workspace_id = $1 and source_id = $2 and status = 'running'
          )`,
      [request.workspaceId, request.sourceId]
    );
    await tx.query(
      `update sync_runs
          set status = 'failed', finished_at = now(),
              error = coalesce(error, 'superseded after stale syncing-source recovery')
        where workspace_id = $1 and source_id = $2 and status = 'running'`,
      [request.workspaceId, request.sourceId]
    );
    await tx.updateSourceStatus(request.sourceId, "syncing");
    await tx.query(
      `insert into sync_runs (id, workspace_id, source_id, status)
       values ($1, $2, $3, 'running')`,
      [request.syncRunId, request.workspaceId, request.sourceId]
    );
  });
}

async function syncExtractedBatch(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  records: ExtractedRecord<unknown>[],
  // NOTE: writeTruth now receives the CHUNK's records (aligned with the chunk's
  // rawIds), not the whole batch — every provider's writeTruth is a per-index
  // upsert loop (or an idempotent single-row write like X's profile snapshot), so
  // running it per chunk preserves exact semantics.
  writeTruth: (tx: InfiniteOsDb, records: ExtractedRecord<unknown>[], rawIds: string[]) => Promise<void>,
  closeSuccess?: (tx: InfiniteOsDb, request: SyncRequest, plan: SyncPlan) => Promise<void>
): Promise<SyncResult> {
  const batchId = `batch_${randomUUID()}`;

  try {
    // 1. OPEN — verify the pre-provider-work claim and create batch bookkeeping in its
    //    own brief transaction, so the batch row is committed before the (potentially
    //    large) record load and the mutex is NOT held across the whole batch.
    await db.withTransaction(async (tx) => {
      const admittedSources = await tx.query<{ provider: string; status: string }>(
        `select provider, status
           from sources
          where id = $1 and workspace_id = $2
          for update`,
        [request.sourceId, request.workspaceId]
      );
      const admittedSource = admittedSources[0];
      if (!admittedSource || admittedSource.provider !== request.provider) {
        throw new ConnectorError(
          "source_scope_mismatch",
          "source is outside the requested workspace or provider scope",
          false
        );
      }
      if (admittedSource.status !== "syncing") {
        throw new ConnectorError(
          "sync_claim_lost",
          "source sync claim is no longer active",
          true
        );
      }
      const owningRuns = await tx.query<{ id: string }>(
        `select id from sync_runs
          where id = $1 and workspace_id = $2 and source_id = $3 and status = 'running'`,
        [request.syncRunId, request.workspaceId, request.sourceId]
      );
      if (!owningRuns[0]) {
        throw new ConnectorError("sync_claim_lost", "source sync claim belongs to another run", true);
      }
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
    });

    // 2. LOAD — raw_records + sync_batch_records (multi-row) + writeTruth, one
    //    transaction PER CHUNK so the connection mutex is released between chunks.
    //
    //    FAILURE SEMANTICS (deliberately different from the old single all-or-nothing
    //    tx, documented here per the no-silent-fallback rule): a chunk failure rolls
    //    back ONLY that chunk; earlier chunks stay committed. The partial data is safe
    //    — every write is an idempotent upsert keyed by natural/business key, so a
    //    LATER sync of the same window re-lands it (raw_records de-dupes on its unique
    //    key; truth rows are last-write-wins). But note that later sync is NOT
    //    automatic once parked: the source's status is escalated PROPORTIONATELY below
    //    (escalateSourceOnSyncFailure) — the SAME gate as plan/extract failures
    //    (recordSyncFailure). A transient chunk failure (a PGlite/disk hiccup, not a
    //    bad credential) bumps the time-gated streak and only parks the source `error`
    //    at the threshold; a terminal failure parks immediately. A parked (`error`)
    //    source leaves scheduler rotation, but the desktop retry lane (1bu-1 #2159)
    //    self-heals it on a slow backoff, and a below-threshold transient stays
    //    `connected` and retries next tick. We do NOT swallow the error: we mark the
    //    batch/run FAILED, record it in sync_errors, and escalate the source in a
    //    separate tx (so the failure is durably observable — the old code left NOTHING
    //    on rollback), then rethrow so the caller still sees the throw. Remaining chunks
    //    are intentionally dropped (not silently skipped-as-success). A CRASH mid-load
    //    (no failure tx at all) leaves the source 'syncing'; the boot-time sweep
    //    (analytical-engine resetStuckSyncingSourcesOnBoot) repairs that case.
    for (let offset = 0; offset < records.length; offset += SYNC_BATCH_CHUNK_SIZE) {
      const chunk = records.slice(offset, offset + SYNC_BATCH_CHUNK_SIZE);
      await db.withTransaction(async (tx) => {
        const rawIds = await upsertRawRecordsChunk(tx, request, batchId, chunk);
        await insertSyncBatchRecordsChunk(tx, batchId, rawIds);
        await writeTruth(tx, chunk, rawIds);
        // Flip only THIS chunk's freshly-inserted rows (earlier chunks are already
        // 'provider_truth_written' and committed) — no cross-chunk rescan.
        await tx.query(
          "update sync_batch_records set record_status = 'provider_truth_written' where sync_batch_id = $1 and record_status = 'raw_written'",
          [batchId]
        );
      });
    }
    // 3. CLOSE — finalize bookkeeping, advance the cursor, mark the source connected.
    await db.withTransaction(async (tx) => {
      // Provider-specific durable checkpoints are intentionally part of CLOSE.
      // If this transaction fails, neither the generic cursor nor the Stripe
      // reconciliation cursor can outrun normalized truth.
      await closeSuccess?.(tx, request, plan);
      await tx.query(
        "update sync_batches set status = 'succeeded', finished_at = now(), records_written = $2 where id = $1",
        [batchId, records.length]
      );
      await tx.query(
        `
          update sync_runs
          set status = 'succeeded', finished_at = now(),
            records_extracted = $2, records_loaded = $2,
            request_telemetry = $3::jsonb
          where id = $1
        `,
        [request.syncRunId, records.length, serializedRequestTelemetry(plan)]
      );
      await tx.query(
        `
          insert into sync_cursors (id, workspace_id, source_id, cursor_key, cursor_value)
          values ($1,$2,$3,$4,$5)
          on conflict (source_id, cursor_key)
          -- MONOTONIC: cursor_value is sortable ISO-8601 text, so greatest() never regresses the
          -- cursor when bounded backfill windows land out-of-order or a window run is retried. The
          -- incremental path is unaffected (excluded is always >= the existing value there).
          do update set cursor_value = greatest(sync_cursors.cursor_value, excluded.cursor_value), updated_at = now()
        `,
        [`cursor_${randomUUID()}`, request.workspaceId, request.sourceId, plan.cursorKey, plan.cursorEnd]
      );
      await tx.updateSourceStatus(request.sourceId, "connected", plan.cursorEnd);
    });
  } catch (error) {
    // OPEN, LOAD, and CLOSE all happen after the durable claim committed. Their
    // cleanup must therefore be shared: mark only the exact still-running owner,
    // record one error, restore/park the source proportionately, and always rethrow
    // the ORIGINAL phase error even if best-effort cleanup itself fails.
    await recordClaimedBatchFailure(db, request, batchId, error);
    throw error;
  }

  return {
    provider: request.provider,
    recordsExtracted: records.length,
    recordsLoaded: records.length,
    cursorKey: plan.cursorKey,
    cursorValue: plan.cursorEnd
  };
}

/**
 * Per-run provider request accounting for `sync_runs.request_telemetry`, folded into the existing
 * CLOSE update so it adds no statement that could fail on its own. Telemetry must never be the
 * reason a customer's sync fails: a serialization problem degrades to a null column, while every
 * error from the sync itself still propagates untouched.
 */
function serializedRequestTelemetry(plan: SyncPlan): string | null {
  if (!plan.requestTelemetry) return null;
  try {
    return JSON.stringify(plan.requestTelemetry.snapshot());
  } catch {
    return null;
  }
}

async function recordClaimedBatchFailure(
  db: InfiniteOsDb,
  request: SyncRequest,
  batchId: string,
  error: unknown
): Promise<void> {
  const perr = providerError(error);
  try {
    await db.withTransaction(async (tx) => {
      const owners = await tx.query<{ id: string }>(
        `update sync_runs
            set status = 'failed', finished_at = now(), error = $4
          where id = $1 and workspace_id = $2 and source_id = $3 and status = 'running'
          returning id`,
        [request.syncRunId, request.workspaceId, request.sourceId, perr.message]
      );
      // A lost/stale caller must never record or escalate a failure against the new owner.
      if (!owners[0]) return;
      await tx.query(
        `update sync_batches set status = 'failed', finished_at = now()
          where id = $1 and sync_run_id = $2`,
        [batchId, request.syncRunId]
      );
      await tx.query(
        `insert into sync_errors (
           id, workspace_id, source_id, sync_run_id, error_code, error_message, retryable
         ) values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `err_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          request.syncRunId,
          perr.code,
          perr.message,
          perr.retryable
        ]
      );
      const parked = await escalateSourceOnSyncFailure(tx, request.sourceId, perr);
      if (!parked) {
        // Preserve the counted streak; updateSourceStatus('connected') intentionally resets it.
        await tx.query(
          "update sources set status = 'connected' where id = $1 and status = 'syncing'",
          [request.sourceId]
        );
      }
    });
  } catch (markError) {
    console.error("sync batch failure-marking failed (original phase error rethrown):", markError);
  }
}

// Test-only handle on the claimed chunked batch loader so the real-PGlite integration
// test can drive it directly with a controlled record set (fixtures can't exceed the
// chunk boundary). NOT part of the public connector surface.
export async function __testOnlySyncExtractedBatch(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  records: ExtractedRecord<unknown>[],
  writeTruth: (tx: InfiniteOsDb, records: ExtractedRecord<unknown>[], rawIds: string[]) => Promise<void>,
  closeSuccess?: (tx: InfiniteOsDb, request: SyncRequest, plan: SyncPlan) => Promise<void>
): Promise<SyncResult> {
  await claimSourceSync(db, request);
  return syncExtractedBatch(db, request, plan, records, writeTruth, closeSuccess);
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
    // PROPORTIONATE STATUS ESCALATION — every failure is already recorded in sync_runs +
    // sync_errors above; escalateSourceOnSyncFailure gates ONLY the terminal `error` transition.
    const parked = await escalateSourceOnSyncFailure(tx, request.sourceId, error);
    if (!parked) {
      // The claim moved this source to `syncing` before planning. A transient failure below
      // the parking threshold must return it to scheduler rotation while preserving the
      // newly-counted failure streak; updateSourceStatus('connected') would erase that streak.
      await tx.query(
        "update sources set status = 'connected' where id = $1 and status = 'syncing'",
        [request.sourceId]
      );
    }
  });
}

// Shared proportionate status escalation for a sync failure. Used by BOTH failure paths — the
// plan/extract failure (recordSyncFailure) AND the load-phase chunk failure (syncExtractedBatch's
// catch) — so a transient hiccup escalates identically wherever in the pipeline it lands.
//
// `status='error'` is a terminal, credential-grade state. Recovery is no longer HUMAN-only: the
// desktop retry lane (1bu-1 desktop #2159) now self-heals errored sources on a SLOW backoff (GA4/
// Meta re-attempt at 2× cadence ≈ 12h, others ≈ 48h), and the cloud sync heartbeat mirrors it — so
// `error` is a loud-but-recoverable park, NOT a dead end. Even so, flipping to `error` on the FIRST
// transient failure meant one overnight network blip (machine asleep mid-fetch → undici "fetch
// failed") surfaced as a "disconnected" on a perfectly valid credential (observed live 2026-07-19,
// meta_ads) and then sat parked until the slow lane or a human revived it. So:
//   - TERMINAL failures (auth rejection, undecryptable credential — retrying never helps) still
//     flip immediately, preserving the credential_undecryptable stop-the-doomed-loop contract.
//   - TRANSIENT failures bump `sources.consecutive_sync_failures` and only escalate to `error`
//     once TRANSIENT_SYNC_FAILURE_ESCALATION_THRESHOLD independent failures have accrued, so a
//     genuinely dead path still surfaces. Below the threshold the status is left UNTOUCHED (the
//     source stays in scheduler rotation and simply retries on the next tick).
// This is NOT a fallback hiding the failure — the caller has already recorded it durably; only the
// escalation is proportionate. Any transition back to `connected` (successful sync, manual
// reconnect) resets the counter to 0 and nulls the gate timestamp.
//
// TIME-GATED STREAK (migration 0045). Attempts cluster in bursts, and two clustering sources feed
// this: a job runner's own in-run retries (seconds apart) AND the desktop scheduler, which retries
// an OVERDUE source every 15-min tick — so counting raw ATTEMPTS lets ordinary awake-but-offline
// use, or one short outage spanning a run's automatic retries, burn the whole streak. A strike must
// mean an INDEPENDENT failure episode: the increment below only fires when the last COUNTED failure
// is at least TRANSIENT_FAILURE_STREAK_MIN_SPACING_MS in the past (or never happened), stamping
// `last_counted_sync_failure_at` when it does. A gated-out burst duplicate matches no row (returns
// null), leaving counter, timestamp, AND status untouched — while the sync_runs/sync_errors rows
// the caller wrote still record it honestly.
// Returns true if the source was PARKED (`error`), false if it was left below the threshold. The
// load-phase caller uses this to decide whether it must restore the source out of `syncing`.
async function escalateSourceOnSyncFailure(
  tx: InfiniteOsDb,
  sourceId: string,
  error: { code: string; message: string; retryable: boolean }
): Promise<boolean> {
  const counterRow = await tx.one<{ consecutive_sync_failures: number }>(
    `
      update sources
      set consecutive_sync_failures = consecutive_sync_failures + 1,
        last_counted_sync_failure_at = now()
      where id = $1
        and (
          last_counted_sync_failure_at is null
          or last_counted_sync_failure_at <= now() - ($2::bigint * interval '1 millisecond')
        )
      returning consecutive_sync_failures
    `,
    [sourceId, TRANSIENT_FAILURE_STREAK_MIN_SPACING_MS]
  );
  // null = the gate blocked the increment (burst duplicate) — the streak did not advance, so a
  // TRANSIENT failure cannot newly cross the threshold this attempt. Terminal failures park
  // regardless (they never consult the streak).
  const countedFailures = counterRow?.consecutive_sync_failures ?? null;
  const shouldPark =
    classifySyncFailure(error) === "terminal" ||
    (countedFailures !== null && countedFailures >= TRANSIENT_SYNC_FAILURE_ESCALATION_THRESHOLD);
  if (shouldPark) {
    await tx.updateSourceStatus(sourceId, "error");
  }
  return shouldPark;
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
      payload: parseCredentialPayload<T>(row.encrypted_payload, request.encryptionKey)
    };
  }
  // OAuth bridge: follow the FK to the live oauth_tokens row, refresh on demand, and merge the
  // live token over the non-secret metadata stored in encrypted_payload (e.g. propertyId).
  const metadata = parseCredentialPayload<Record<string, unknown>>(
    row.encrypted_payload,
    request.encryptionKey
  );
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
    requiredEncryptionKey(request.encryptionKey)
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
      // CRITICAL: this re-encrypt of oauth_tokens MUST use the SAME per-workspace key as the
      // decrypts above — otherwise every later read fails to decrypt (silent data corruption).
      encryptCredentialPayload(nextPayload, requiredEncryptionKey(request.encryptionKey)),
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
  return decryptCredentialPayload<Record<string, unknown>>(
    appRow.encrypted_payload,
    requiredEncryptionKey(request.encryptionKey)
  );
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

function parseCredentialPayload<T extends Record<string, unknown>>(
  payload: string,
  encryptionKey?: string
): T {
  if (payload === "fixture-encrypted" || payload === "fixture") {
    return { mode: "fixture" } as unknown as T;
  }
  if (isEncryptedCredentialPayload(payload)) {
    return decryptCredentialPayload<T>(payload, requiredEncryptionKey(encryptionKey));
  }
  throw new ConnectorError("provider_auth_failed", "credential payload must be encrypted", false);
}

// `override` is the caller-supplied per-workspace key (SyncRequest.encryptionKey). When present
// it WINS over process.env / the .growth-os file default, so a multi-tenant server never has to
// mutate process.env (a cross-tenant-decrypt race). When absent, behavior is identical to before:
// the desktop single-tenant env / project-file key is used.
function requiredEncryptionKey(override?: string): string {
  const key = override ?? process.env.GROWTH_OS_ENCRYPTION_KEY ?? projectEncryptionKey();
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
    } else if (row.kind === "event") {
      await writeGa4EventTruth(tx, request, row, rawIds[index]);
    } else {
      await writeGa4OverviewTruth(tx, request, row, rawIds[index]);
    }
  }
}

// Snapshot-replacement CLOSE step. The rolling-window re-pull is a REPLACEMENT of the window, not
// an accretion: GA4 restates attribution days after first capture (a day's conversions first land
// as "(not set)"/"Unassigned" and later come back under resolved keys), so fact rows whose keys the
// fresh snapshot no longer contains are OBSOLETE and double-count every total that sums the window
// (verified in prod: overview said 10 key_events where GA and the page fact both said 6).
//
// Membership is proven through this run's batch bookkeeping, not recomputed keys: every fact row
// this batch touched had raw_record_id set to a raw id resolved by this batch (an unchanged payload
// resolves to its EXISTING raw id, which the batch's sync_batch_records still lists), so a fact row
// inside the window whose raw_record_id is NOT in this run's batch was not in the provider
// snapshot. Runs at CLOSE — after every LOAD chunk committed — so a failed/partial sync never
// prunes (chunk failure → no CLOSE), and a report that staged ZERO rows skips its table entirely
// (an empty response for a historical window is indistinguishable from a provider fault: keep the
// facts, fail closed).
async function ga4CloseSuccess(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan
): Promise<void> {
  const replacement = plan.ga4SnapshotReplacement;
  // Fixture syncs and any pre-replacement plan carry no contract — nothing to prune or persist.
  if (!replacement) return;
  const deletedOverview = replacement.stagedOverviewRows > 0
    ? await pruneGa4FactWindow(tx, request, "ga4_report_snapshot_fact", replacement)
    : 0;
  const deletedPage = replacement.stagedPageRows > 0
    ? await pruneGa4FactWindow(tx, request, "ga4_page_report_fact", replacement)
    : 0;
  const deletedEvent = replacement.stagedEventRows > 0
    ? await pruneGa4FactWindow(tx, request, "ga4_event_report_fact", replacement)
    : 0;
  console.info(
    "[ga4] snapshot replacement " +
      JSON.stringify({
        sourceId: request.sourceId,
        window: [replacement.windowStartDate, replacement.windowEndDate],
        staged: {
          overview: replacement.stagedOverviewRows,
          page: replacement.stagedPageRows,
          event: replacement.stagedEventRows
        },
        deleted: { overview: deletedOverview, page: deletedPage, event: deletedEvent }
      })
  );
  // Provider metadata (migration 0061): the property time zone GA's dates are local to, and the
  // latest property-local date the provider returned any data for. coalesce keeps the last honest
  // value when a response omits metadata rather than nulling it.
  await tx.query(
    `update sources
        set provider_time_zone = coalesce($2, provider_time_zone),
            provider_data_through_date = coalesce($3::date, provider_data_through_date)
      where id = $1`,
    [request.sourceId, replacement.propertyTimeZone, replacement.dataThroughDate]
  );
}

// PostHog CLOSE: re-derive the day-grain rollups (migration 0063: posthog_event_daily /
// posthog_site_daily, which queryable.vw_posthog_events / vw_posthog_site now read) for THIS source
// over the window the extraction just (re)wrote. Runs inside the CLOSE transaction, after every LOAD
// chunk has committed truth, so the rollup can never outrun truth and a failed CLOSE leaves no
// half-refreshed day (the same seam GA4's snapshot replacement and Stripe's reconciliation cursor
// use). One hook covers every writer — desktop incremental runs, cloud heartbeat runs, and bounded
// backfill child windows. cursorStart is null on the first sync of a source (no stored cursor):
// roll up everything it has. Extraction is now bounded on BOTH sides (`timestamp >= cursorStart and
// timestamp < cursorEnd`) and a page-capped run narrows plan.cursorEnd to the last event it loaded,
// so [cursorStart, cursorEnd] is exactly the span this run's truth covers — the refresh can neither
// miss a day it wrote nor claim a day it never reached.
async function posthogCloseSuccess(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan
): Promise<void> {
  const from = plan.cursorStart ? plan.cursorStart.slice(0, 10) : "2000-01-01";
  const to = plan.cursorEnd.slice(0, 10);
  await tx.query(
    "select refresh_posthog_daily_rollups($1, $2, $3::date, $4::date)",
    [request.workspaceId, request.sourceId, from, to]
  );
}

async function pruneGa4FactWindow(
  tx: InfiniteOsDb,
  request: SyncRequest,
  factTable: "ga4_report_snapshot_fact" | "ga4_page_report_fact" | "ga4_event_report_fact",
  window: { windowStartDate: string; windowEndDate: string }
): Promise<number> {
  const deleted = await tx.query<{ id: string }>(
    `delete from ${factTable} f
      where f.workspace_id = $1
        and f.source_id = $2
        and f.reporting_date >= $3::date
        and f.reporting_date <= $4::date
        and not exists (
          select 1
            from sync_batch_records sbr
            join sync_batches sb on sb.id = sbr.sync_batch_id
           where sb.sync_run_id = $5
             and sbr.raw_record_id = f.raw_record_id
        )
      returning f.id`,
    [
      request.workspaceId,
      request.sourceId,
      window.windowStartDate,
      window.windowEndDate,
      request.syncRunId
    ]
  );
  return deleted.length;
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

async function writeGa4EventTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  row: Ga4EventRow,
  rawId: string
): Promise<void> {
  await tx.query(
    `
      insert into ga4_event_report_fact (
        id, workspace_id, source_id, raw_record_id, reporting_date,
        host_name, event_name, event_count, key_events
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      -- Matches migration 0061's ga4_event_report_unique.
      on conflict (source_id, reporting_date, host_name, event_name)
      do update set event_count = excluded.event_count,
        key_events = excluded.key_events, raw_record_id = excluded.raw_record_id
    `,
    [
      `ga4_event_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      row.reportingDate,
      row.hostName,
      row.eventName,
      row.eventCount,
      row.keyEvents
    ]
  );
  await writeLineage(
    tx,
    request,
    "ga4_event_report_fact",
    `${row.reportingDate}:${row.hostName}:${row.eventName}`,
    rawId
  );
}

// Rows per multi-row INSERT. The widest statement below is posthog_event_truth at 16 columns →
// 8,000 bound parameters, comfortably under Postgres' 65,535 limit. syncExtractedBatch already
// hands this writer at most SYNC_BATCH_CHUNK_SIZE records, so in practice this is one statement
// per table per chunk; the loop keeps the writer correct for any caller.
const POSTHOG_TRUTH_WRITE_CHUNK = 500;

interface PostHogTruthItem {
  row: PostHogEventRow;
  rawId: string;
}

interface PostHogLineageItem {
  providerTable: string;
  providerRowId: string;
  rawId: string;
}

/**
 * PostHog truth loader. Replaces a per-event loop that cost EIGHT round trips per event (four
 * upserts + four lineage rows) — 92k events could not clear the 900s cloud sync worker at that
 * price. Every statement is now a multi-row INSERT over a chunk.
 *
 * The rows written are byte-identical to the per-event loop's, which turns on ONE subtlety: a
 * multi-row `on conflict do update` raises "cannot affect row a second time" if a conflict target
 * repeats in the VALUES list, and PostHog events legitimately share a person / session / distinct
 * id. Every writer below therefore folds its duplicates with foldByConflictKey and reproduces the
 * loop's outcome exactly: the FIRST occurrence supplies the insert-only columns (the row that
 * would have won the INSERT) and the LAST supplies the updatable ones (the statement that would
 * have won the final DO UPDATE). Lineage is NOT folded that way — the loop wrote one row per event
 * per table, keyed by (table, business key, raw record), and so does this.
 */
async function writePostHogTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: PostHogEventRow[],
  rawIds: string[]
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += POSTHOG_TRUTH_WRITE_CHUNK) {
    const chunk: PostHogTruthItem[] = rows
      .slice(offset, offset + POSTHOG_TRUTH_WRITE_CHUNK)
      .map((row, index) => ({ row, rawId: rawIds[offset + index] }));
    if (chunk.length === 0) continue;

    await writePostHogEventTruthChunk(tx, request, chunk);
    await writePostHogPersonCurrentChunk(tx, request, chunk);
    await writePostHogDistinctIdChunk(tx, request, chunk);
    await writePostHogSessionFactChunk(tx, request, chunk);
    await writePostHogLineageChunk(
      tx,
      request,
      chunk.flatMap(({ row, rawId }) => [
        { providerTable: "posthog_event_truth", providerRowId: row.eventId, rawId },
        { providerTable: "posthog_person_current", providerRowId: row.personId, rawId },
        { providerTable: "posthog_person_distinct_ids", providerRowId: row.distinctId, rawId },
        { providerTable: "posthog_session_fact", providerRowId: row.sessionId, rawId }
      ])
    );
  }
}

/**
 * Collapse items that share an upsert conflict target, keeping the FIRST occurrence and the LAST
 * one. Order is the batch's own order, which for PostHog is the extractor's `timestamp asc` — so
 * "last" is the most recent event for that person/session, exactly as the per-event loop left it.
 */
function foldByConflictKey<T>(items: T[], keyOf: (item: T) => string): Array<{ first: T; last: T }> {
  const folded = new Map<string, { first: T; last: T }>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = folded.get(key);
    if (existing) {
      existing.last = item;
    } else {
      folded.set(key, { first: item, last: item });
    }
  }
  return [...folded.values()];
}

/** `($1,$2,$3::jsonb),($4,$5,$6::jsonb)…` — one placeholder tuple per row, casts included. */
function multiRowValues(rowCount: number, columnCasts: readonly string[]): string {
  const width = columnCasts.length;
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const base = rowIndex * width;
    return `(${columnCasts.map((cast, column) => `$${base + column + 1}${cast}`).join(",")})`;
  }).join(",");
}

const EVENT_TRUTH_CASTS = [
  "", "", "", "", "", "", "", "", "", "::timestamptz", "", "", "", "", "", "::jsonb"
] as const;

async function writePostHogEventTruthChunk(
  tx: InfiniteOsDb,
  request: SyncRequest,
  chunk: PostHogTruthItem[]
): Promise<void> {
  const folded = foldByConflictKey(chunk, (item) => item.row.eventId);
  const params: unknown[] = [];
  for (const { first, last } of folded) {
    params.push(
      `phe_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      last.rawId,
      first.row.eventId,
      first.row.eventName,
      first.row.distinctId,
      first.row.personId,
      first.row.sessionId,
      first.row.occurredAt,
      first.row.landingPage,
      first.row.referrer,
      first.row.utmSource,
      first.row.utmMedium,
      first.row.utmCampaign,
      JSON.stringify(last.row.properties)
    );
  }
  await tx.query(
    `
      insert into posthog_event_truth (
        id, workspace_id, source_id, raw_record_id, event_id, event_name,
        distinct_id, person_id, session_id, occurred_at, landing_page,
        referrer, utm_source, utm_medium, utm_campaign, properties
      )
      values ${multiRowValues(folded.length, EVENT_TRUTH_CASTS)}
      on conflict (source_id, event_id)
      do update set raw_record_id = excluded.raw_record_id, properties = excluded.properties
    `,
    params
  );
}

const PERSON_CURRENT_CASTS = ["", "", "", "", "", "", "::timestamptz", "::jsonb"] as const;

async function writePostHogPersonCurrentChunk(
  tx: InfiniteOsDb,
  request: SyncRequest,
  chunk: PostHogTruthItem[]
): Promise<void> {
  const folded = foldByConflictKey(chunk, (item) => item.row.personId);
  const params: unknown[] = [];
  for (const { first, last } of folded) {
    params.push(
      `php_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      // raw_record_id is insert-only here (the DO UPDATE never touches it), so it must come from
      // the FIRST occurrence — the statement that would have won the INSERT.
      first.rawId,
      first.row.personId,
      last.row.email,
      first.row.occurredAt,
      JSON.stringify({ email: last.row.email, distinct_id: last.row.distinctId })
    );
  }
  await tx.query(
    `
      insert into posthog_person_current (
        id, workspace_id, source_id, raw_record_id, person_id, email, created_at_source, properties
      )
      values ${multiRowValues(folded.length, PERSON_CURRENT_CASTS)}
      on conflict (source_id, person_id)
      do update set email = excluded.email, properties = excluded.properties, updated_at = now()
    `,
    params
  );
}

const DISTINCT_ID_CASTS = ["", "", "", "", ""] as const;

async function writePostHogDistinctIdChunk(
  tx: InfiniteOsDb,
  request: SyncRequest,
  chunk: PostHogTruthItem[]
): Promise<void> {
  // DO NOTHING on conflict, so the FIRST occurrence wins outright — same as the loop, where every
  // later insert for the same distinct id was a no-op.
  const folded = foldByConflictKey(chunk, (item) => item.row.distinctId);
  const params: unknown[] = [];
  for (const { first } of folded) {
    params.push(
      `phd_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      first.row.personId,
      first.row.distinctId
    );
  }
  await tx.query(
    `
      insert into posthog_person_distinct_ids (id, workspace_id, source_id, person_id, distinct_id)
      values ${multiRowValues(folded.length, DISTINCT_ID_CASTS)}
      on conflict (source_id, distinct_id) do nothing
    `,
    params
  );
}

const SESSION_FACT_CASTS = [
  "", "", "", "", "", "", "::timestamptz", "::timestamptz", "", "", "", "", ""
] as const;

async function writePostHogSessionFactChunk(
  tx: InfiniteOsDb,
  request: SyncRequest,
  chunk: PostHogTruthItem[]
): Promise<void> {
  const folded = foldByConflictKey(chunk, (item) => item.row.sessionId);
  const params: unknown[] = [];
  for (const { first, last } of folded) {
    params.push(
      `phs_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      last.rawId,
      first.row.sessionId,
      first.row.distinctId,
      // started_at is insert-only; ended_at and raw_record_id are what the DO UPDATE advances.
      first.row.occurredAt,
      last.row.occurredAt,
      first.row.landingPage,
      first.row.referrer,
      first.row.utmSource,
      first.row.utmMedium,
      first.row.utmCampaign
    );
  }
  await tx.query(
    `
      insert into posthog_session_fact (
        id, workspace_id, source_id, raw_record_id, session_id, distinct_id,
        started_at, ended_at, landing_page, referrer, utm_source, utm_medium, utm_campaign
      )
      values ${multiRowValues(folded.length, SESSION_FACT_CASTS)}
      on conflict (source_id, session_id)
      do update set ended_at = excluded.ended_at, raw_record_id = excluded.raw_record_id
    `,
    params
  );
}

const LINEAGE_CASTS = ["", "", "", "", "", "", "", "", ""] as const;

async function writePostHogLineageChunk(
  tx: InfiniteOsDb,
  request: SyncRequest,
  items: PostHogLineageItem[]
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += POSTHOG_TRUTH_WRITE_CHUNK) {
    const folded = foldByConflictKey(
      items.slice(offset, offset + POSTHOG_TRUTH_WRITE_CHUNK),
      (item) => JSON.stringify([item.providerTable, item.providerRowId, item.rawId])
    );
    const params: unknown[] = [];
    for (const { first } of folded) {
      // Column order matches writeLineage's expansion of ($1,$2,$3,$4,$5,$3,$4,$6,'live-v1'):
      // canonical_* mirror provider_*, and the normalization version is the same literal.
      params.push(
        `lineage_${randomUUID()}`,
        request.workspaceId,
        first.providerTable,
        first.providerRowId,
        request.provider,
        first.providerTable,
        first.providerRowId,
        first.rawId,
        "live-v1"
      );
    }
    await tx.query(
      `
        insert into record_lineage (
          id, workspace_id, canonical_table, canonical_id, provider,
          provider_table, provider_row_id, raw_record_id, normalization_version
        )
        values ${multiRowValues(folded.length, LINEAGE_CASTS)}
        on conflict (workspace_id, provider_table, provider_row_id, raw_record_id)
        do update set normalization_version = excluded.normalization_version
      `,
      params
    );
  }
}

// `metrics_classification` used to be a one-way trapdoor: every customer upsert coalesced the
// incoming value over the stored one, so REMOVING the `infinite_metrics_classification` tag in
// Stripe could never clear it and the customer stayed excluded from every business metric
// forever. The distinction that matters is not "is the incoming value null" but "was the
// metadata authoritatively observed" — i.e. did this row come from an EXPANDED customer object.
// The flag is carried explicitly on the row rather than inferred from value-null-ness, because
// null legitimately means two different things depending on where the row came from.
function stripeCustomerClassificationAssignment(metadataAuthoritative: boolean): string {
  return metadataAuthoritative
    // Expanded customer: Stripe's metadata is the whole truth, including its absence.
    ? "metrics_classification = excluded.metrics_classification"
    // Un-expanded customer (bare id): we could not look, so we must not overwrite.
    : `metrics_classification = coalesce(
            excluded.metrics_classification,
            stripe_customers.metrics_classification
          )`;
}

async function writeStripeTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rows: StripeSyncRow[],
  rawIds: string[]
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "subscription_event") {
      await writeStripeSubscriptionEventTruth(tx, request, row, rawIds[index]);
      continue;
    }
    if (row.kind === "subscription") {
      await writeStripeSubscriptionTruth(tx, request, row, rawIds[index]);
      continue;
    }
    if (row.kind === "customer") {
      await writeStripeCustomerTruth(tx, request, row, rawIds[index]);
      continue;
    }
    const invoice = row;
    if (invoice.customerId) {
      await tx.query(
        `
        insert into stripe_customers (
          id, workspace_id, source_id, raw_record_id, stripe_customer_id, email, name,
          metrics_classification, created_at_source
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (source_id, stripe_customer_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          email = coalesce(excluded.email, stripe_customers.email),
          name = coalesce(excluded.name, stripe_customers.name),
          ${stripeCustomerClassificationAssignment(invoice.customerMetadataAuthoritative)}
      `,
        [
          `cus_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          rawIds[index],
          invoice.customerId,
          invoice.customerEmail,
          invoice.customerName,
          invoice.customerMetricsClassification,
          invoice.createdAt
        ]
      );
      await writeLineage(tx, request, "stripe_customers", invoice.customerId, rawIds[index]);
    }
    await tx.query(
      `
        insert into stripe_invoices (
          id, workspace_id, source_id, raw_record_id, stripe_invoice_id,
          stripe_customer_id, stripe_subscription_id, subscription_origin,
          status, currency, amount_paid, amount_due, paid_at, created_at_source,
          external_order_id, post_payment_credit_notes_amount,
          pre_payment_credit_notes_amount
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        on conflict (source_id, stripe_invoice_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          stripe_customer_id = excluded.stripe_customer_id,
          stripe_subscription_id = excluded.stripe_subscription_id,
          subscription_origin = excluded.subscription_origin,
          status = excluded.status,
          currency = excluded.currency,
          amount_paid = excluded.amount_paid,
          amount_due = excluded.amount_due,
          paid_at = excluded.paid_at,
          created_at_source = excluded.created_at_source,
          external_order_id = excluded.external_order_id,
          post_payment_credit_notes_amount = excluded.post_payment_credit_notes_amount,
          pre_payment_credit_notes_amount = excluded.pre_payment_credit_notes_amount
      `,
      [
        `inv_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawIds[index],
        invoice.invoiceId,
        invoice.customerId,
        invoice.subscriptionId,
        invoice.subscriptionOrigin,
        invoice.status,
        invoice.currency,
        invoice.amountPaid,
        invoice.amountDue,
        invoice.paidAt,
        invoice.createdAt,
        invoice.externalOrderId,
        invoice.postPaymentCreditedMinor,
        invoice.prePaymentCreditedMinor
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
      // A PLACEHOLDER, not truth. An invoice payload carries no subscription status and no
      // current_period_end, so this write must never touch a row the subscription lane already
      // established: it previously force-wrote status='active' and nulled current_period_end on
      // conflict, and because LOAD is chunked into separate transactions a chunk failure could
      // COMMIT that corruption (a canceled subscription counted as paying until the next full
      // sync). `'unknown'` is inert on purpose — it is in neither the active set
      // ('active','past_due') nor the terminal set ('canceled','unpaid') that the lifecycle,
      // recurring-value and MRR-movement views read, so a phantom row (an invoice referencing a
      // subscription /v1/subscriptions never listed) contributes nothing rather than poisoning
      // the fail-closed items_sync_complete guard. writeStripeSubscriptionTruth's upsert
      // overwrites status unconditionally, so real truth still promotes the placeholder.
      await tx.query(
        `
          insert into stripe_subscriptions (
            id, workspace_id, source_id, raw_record_id, stripe_subscription_id,
            stripe_customer_id, status, current_period_start, current_period_end, created_at_source
          )
          values ($1,$2,$3,$4,$5,$6,'unknown',$7,$8,$9)
          on conflict (source_id, stripe_subscription_id) do nothing
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

async function writeStripeSubscriptionEventTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  event: StripeSubscriptionEventRow,
  rawId: string,
): Promise<void> {
  const customer = event.customerId
    ? await tx.one<{ metrics_classification: string | null }>(
      `select metrics_classification
         from stripe_customers
        where workspace_id = $1 and source_id = $2 and stripe_customer_id = $3`,
      [request.workspaceId, request.sourceId, event.customerId],
    )
    : null;
  const businessEligibleAtCapture = customer?.metrics_classification !== "internal_test";
  await tx.query(
    `insert into stripe_subscription_lifecycle_events (
       id, workspace_id, source_id, raw_record_id, stripe_event_id, event_type,
       event_created_at, api_version, livemode, stripe_subscription_id,
       stripe_customer_id, current_status, previous_status, trial_start, trial_end,
       ended_at, canceled_at, previous_trial_start, previous_trial_end,
       segment_from, segment_to_exclusive, business_eligible_at_capture, parser_version
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
     )
     on conflict (workspace_id, source_id, stripe_event_id)
     do update set raw_record_id = excluded.raw_record_id`,
    [
      `stripe_subscription_event_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      event.stripeEventId,
      event.eventType,
      event.eventCreatedAt,
      event.apiVersion,
      event.livemode,
      event.subscriptionId,
      event.customerId,
      event.currentStatus,
      event.previousStatus,
      event.trialStart,
      event.trialEnd,
      event.endedAt,
      event.canceledAt,
      event.previousTrialStart,
      event.previousTrialEnd,
      event.segmentFrom,
      event.segmentToExclusive,
      businessEligibleAtCapture,
      STRIPE_TRIAL_PARSER_VERSION,
    ],
  );
  await writeLineage(tx, request, "stripe_subscription_lifecycle_events", event.stripeEventId, rawId);
}

async function writeStripeSubscriptionTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  sub: StripeSubscriptionRow,
  rawId: string
): Promise<void> {
  if (sub.customerId) {
    await tx.query(
      `
        insert into stripe_customers (
          id, workspace_id, source_id, raw_record_id, stripe_customer_id, email,
          metrics_classification, created_at_source
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (source_id, stripe_customer_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          email = coalesce(excluded.email, stripe_customers.email),
          ${stripeCustomerClassificationAssignment(sub.customerMetadataAuthoritative)}
      `,
      [
        `cus_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawId,
        sub.customerId,
        sub.customerEmail,
        sub.customerMetricsClassification,
        sub.createdAt,
      ]
    );
    await writeLineage(tx, request, "stripe_customers", sub.customerId, rawId);
  }

  await tx.query(
    `
      insert into stripe_subscriptions (
        id, workspace_id, source_id, raw_record_id, stripe_subscription_id,
        stripe_customer_id, status, current_period_start, current_period_end,
        created_at_source, trial_start, trial_end, cancel_at, canceled_at, ended_at,
        items_sync_complete, discounts_sync_complete, livemode
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      on conflict (source_id, stripe_subscription_id)
      do update set
        raw_record_id = excluded.raw_record_id,
        stripe_customer_id = excluded.stripe_customer_id,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        created_at_source = excluded.created_at_source,
        trial_start = excluded.trial_start,
        trial_end = excluded.trial_end,
        cancel_at = excluded.cancel_at,
        canceled_at = excluded.canceled_at,
        ended_at = excluded.ended_at,
        items_sync_complete = excluded.items_sync_complete,
        discounts_sync_complete = excluded.discounts_sync_complete,
        livemode = excluded.livemode
    `,
    [
      `sub_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      sub.subscriptionId,
      sub.customerId,
      sub.status,
      sub.currentPeriodStart,
      sub.currentPeriodEnd,
      sub.createdAt,
      sub.trialStart,
      sub.trialEnd,
      sub.cancelAt,
      sub.canceledAt,
      sub.endedAt,
      sub.itemsSynced,
      sub.discountsSynced,
      sub.liveMode
    ]
  );
  await writeLineage(tx, request, "stripe_subscriptions", sub.subscriptionId, rawId);

  // Extraction reaches this transaction only after every subscription-item page has succeeded.
  // Replace the complete child sets atomically so removed Stripe objects cannot keep contributing.
  await tx.query(
    `delete from stripe_subscription_discounts
      where workspace_id = $1 and source_id = $2 and stripe_subscription_id = $3`,
    [request.workspaceId, request.sourceId, sub.subscriptionId]
  );
  await tx.query(
    `delete from stripe_subscription_items
      where workspace_id = $1 and source_id = $2 and stripe_subscription_id = $3`,
    [request.workspaceId, request.sourceId, sub.subscriptionId]
  );

  for (const discount of sub.discounts) {
    await writeStripeSubscriptionDiscount(
      tx,
      request,
      rawId,
      sub.subscriptionId,
      "subscription",
      sub.subscriptionId,
      discount
    );
  }

  for (const item of sub.items) {
    if (item.productId) {
      await tx.query(
        `
          insert into stripe_products (id, workspace_id, source_id, raw_record_id, stripe_product_id, name, active)
          values ($1,$2,$3,$4,$5,null,true)
          on conflict (source_id, stripe_product_id) do nothing
        `,
        [`prod_${randomUUID()}`, request.workspaceId, request.sourceId, rawId, item.productId]
      );
      await writeLineage(tx, request, "stripe_products", item.productId, rawId);
    }
    if (item.priceId) {
      await tx.query(
        `
          insert into stripe_prices (
            id, workspace_id, source_id, raw_record_id, stripe_price_id,
            stripe_product_id, currency, unit_amount, recurring_interval,
            recurring_interval_count, recurring_usage_type, billing_scheme,
            custom_unit_amount, pricing_state, currency_options,
            transform_quantity_divide_by, transform_quantity_round, active
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,true)
          on conflict (source_id, stripe_price_id)
          do update set
            stripe_product_id = excluded.stripe_product_id,
            currency = excluded.currency,
            unit_amount = excluded.unit_amount,
            recurring_interval = excluded.recurring_interval,
            recurring_interval_count = excluded.recurring_interval_count,
            recurring_usage_type = excluded.recurring_usage_type,
            billing_scheme = excluded.billing_scheme,
            custom_unit_amount = excluded.custom_unit_amount,
            pricing_state = excluded.pricing_state,
            currency_options = excluded.currency_options,
            transform_quantity_divide_by = excluded.transform_quantity_divide_by,
            transform_quantity_round = excluded.transform_quantity_round
        `,
        [
          `price_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          rawId,
          item.priceId,
          item.productId,
          item.defaultCurrency,
          item.defaultUnitAmount,
          item.recurringInterval,
          item.recurringIntervalCount,
          item.recurringUsageType,
          item.billingScheme,
          item.customUnitAmount,
          item.pricingState,
          JSON.stringify(item.priceCurrencyOptions),
          item.transformQuantityDivideBy,
          item.transformQuantityRound
        ]
      );
      await writeLineage(tx, request, "stripe_prices", item.priceId, rawId);
    }
    await tx.query(
      `
        insert into stripe_subscription_items (
          id, workspace_id, source_id, raw_record_id, stripe_subscription_item_id,
          stripe_subscription_id, stripe_price_id, stripe_product_id, currency,
          unit_amount, quantity, recurring_interval, recurring_interval_count,
          recurring_usage_type, billing_scheme, custom_unit_amount, pricing_state,
          default_currency, default_unit_amount, price_currency_options,
          currency_option_resolved, transform_quantity_divide_by, transform_quantity_round
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18,$19,$20::jsonb,$21,$22,$23)
        on conflict (source_id, stripe_subscription_item_id)
        do update set
          raw_record_id = excluded.raw_record_id,
          stripe_subscription_id = excluded.stripe_subscription_id,
          stripe_price_id = excluded.stripe_price_id,
          stripe_product_id = excluded.stripe_product_id,
          currency = excluded.currency,
          unit_amount = excluded.unit_amount,
          quantity = excluded.quantity,
          recurring_interval = excluded.recurring_interval,
          recurring_interval_count = excluded.recurring_interval_count,
          recurring_usage_type = excluded.recurring_usage_type,
          billing_scheme = excluded.billing_scheme,
          custom_unit_amount = excluded.custom_unit_amount,
          pricing_state = excluded.pricing_state,
          default_currency = excluded.default_currency,
          default_unit_amount = excluded.default_unit_amount,
          price_currency_options = excluded.price_currency_options,
          currency_option_resolved = excluded.currency_option_resolved,
          transform_quantity_divide_by = excluded.transform_quantity_divide_by,
          transform_quantity_round = excluded.transform_quantity_round
      `,
      [
        `si_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        rawId,
        item.itemId,
        sub.subscriptionId,
        item.priceId,
        item.productId,
        item.currency,
        item.unitAmount,
        item.quantity,
        item.recurringInterval,
        item.recurringIntervalCount,
        item.recurringUsageType,
        item.billingScheme,
        item.customUnitAmount,
        item.pricingState,
        item.defaultCurrency,
        item.defaultUnitAmount,
        JSON.stringify(item.priceCurrencyOptions),
        item.currencyOptionResolved,
        item.transformQuantityDivideBy,
        item.transformQuantityRound
      ]
    );
    await writeLineage(tx, request, "stripe_subscription_items", item.itemId, rawId);
    for (const discount of item.discounts) {
      await writeStripeSubscriptionDiscount(
        tx,
        request,
        rawId,
        sub.subscriptionId,
        "item",
        item.itemId,
        discount
      );
    }
  }
}

async function writeStripeCustomerTruth(
  tx: InfiniteOsDb,
  request: SyncRequest,
  customer: StripeCustomerRow,
  rawId: string
): Promise<void> {
  await tx.query(
    `
      insert into stripe_customers (
        id, workspace_id, source_id, raw_record_id, stripe_customer_id, email, name,
        metrics_classification, created_at_source
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (source_id, stripe_customer_id)
      do update set
        raw_record_id = excluded.raw_record_id,
        email = coalesce(excluded.email, stripe_customers.email),
        name = coalesce(excluded.name, stripe_customers.name),
        created_at_source = coalesce(
          excluded.created_at_source, stripe_customers.created_at_source
        ),
        ${stripeCustomerClassificationAssignment(customer.metadataAuthoritative)}
    `,
    [
      `cus_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      customer.customerId,
      customer.email,
      customer.name,
      customer.metricsClassification,
      customer.createdAt
    ]
  );
  await writeLineage(tx, request, "stripe_customers", customer.customerId, rawId);
}

async function writeStripeSubscriptionDiscount(
  tx: InfiniteOsDb,
  request: SyncRequest,
  rawId: string,
  subscriptionId: string,
  targetType: "subscription" | "item",
  targetId: string,
  discount: StripeDiscountRow
): Promise<void> {
  await tx.query(
    `insert into stripe_subscription_discounts (
       id, workspace_id, source_id, raw_record_id, stripe_subscription_id,
       target_type, target_id, stripe_discount_id, stripe_coupon_id, position, amount_off,
       percent_off, currency, duration, starts_at, ends_at, is_complete,
       incomplete_reason, applies_to_product_ids, amount_off_currency_options,
       currency_option_resolved
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20::jsonb,$21)`,
    [
      `sdisc_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      rawId,
      subscriptionId,
      targetType,
      targetId,
      discount.discountId,
      discount.couponId,
      discount.position,
      discount.amountOff,
      discount.percentOff,
      discount.currency,
      discount.duration,
      discount.startsAt,
      discount.endsAt,
      discount.complete,
      discount.incompleteReason,
      discount.appliesToProductIds,
      JSON.stringify(discount.amountOffCurrencyOptions),
      discount.currencyOptionResolved
    ]
  );
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
      // KNOWN (chunked loader): writeTruth now runs once per ~500-record chunk, and
      // writeLineage's conflict key includes raw_record_id — each chunk passes its
      // own rawIds[0], so a multi-chunk X sync writes one snapshot-lineage row per
      // chunk (was 1 per sync). Provenance noise only, never corruption (the
      // snapshot upsert above is idempotent on (source_id, captured_at)); left
      // as-is because X is sunset engine-side.
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

// Report E (event-name) parser. Reads dimensionValues/metricValues positionally by
// THIS request's field order:
//   dims:    [date, hostName, eventName]
//   metrics: [eventCount, keyEvents]
function ga4EventRow(row: Ga4RunReportRow): Ga4EventRow {
  const dimensions = (row.dimensionValues ?? []).map((value) => value.value ?? "");
  const metric = (index: number) => row.metricValues?.[index]?.value;
  const reportingDate = dimensions[0]?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || daysAgo(0);
  return {
    kind: "event",
    externalId: `ga4_event:${dimensions.join(":")}`,
    reportingDate,
    hostName: dimensions[1] || "(not set)",
    eventName: dimensions[2] || "(not set)",
    eventCount: integerOrZero(metric(0)),
    keyEvents: integerOrZero(metric(1))
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
  params: Record<string, string | string[]>,
  // Optional per-run request accounting. Stripe's read allowance (500/transaction rolling, with
  // a 10,000/month floor) is the scheduling gate for the whole delta design, so every read is
  // counted. Telemetry is deliberately best-effort: it never changes a code path and never
  // becomes a reason a sync fails.
  telemetry?: StripeRequestTelemetry
): Promise<T> {
  const url = new URL(`${credential.apiBaseUrl ?? "https://api.stripe.com"}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
  telemetry?.recordRequest(path);
  return fetchJson<T>(
    url.toString(),
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`
      }
    },
    telemetry
      ? (meta) => {
          if (meta.status === 429) {
            telemetry.recordRateLimited(path, meta.headers.get("Stripe-Rate-Limited-Reason"));
          }
        }
      : undefined
  );
}

async function stripeList<T>(
  credential: StripeCredential,
  secretKey: string,
  path: string,
  params: Record<string, string | string[]>,
  telemetry?: StripeRequestTelemetry
): Promise<T[]> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const response = await stripeGet<StripeListResponse<T>>(credential, secretKey, path, {
      ...params,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    }, telemetry);
    telemetry?.recordPage(path);
    items.push(...(response.data ?? []));
    if (!response.has_more || !response.data.length) {
      return items;
    }
    startingAfter = String((response.data[response.data.length - 1] as { id?: string }).id);
  }
}

const STRIPE_RECONCILIATION_MAX_PAGES = 5;
// UNIFIED WINDOW MARGINS. The invoice and trial lanes each used to carry their own
// STRIPE_{INVOICE,TRIAL}_EVENT_{SAFETY_LAG,OVERLAP}_MS pair holding the same value; the delta
// lane makes that a single contract. Rationale (eventual consistency of the Events list, why the
// overlap is safe to re-read) lives with the constants in ./stripe-delta.ts.
const STRIPE_TRIAL_PARSER_VERSION = "stripe-trial-events-v1";
const STRIPE_TRIAL_CLASSIFIER_VERSION = "stripe-trial-spells-v1";
const STRIPE_SUBSCRIPTION_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
] as const;

interface StripeBoundedList<T> {
  items: T[];
  complete: boolean;
  nextStartingAfter: string | null;
}

async function stripeListBounded<T extends { id: string }>(
  credential: StripeCredential,
  secretKey: string,
  path: string,
  params: Record<string, string | string[]>,
  initialStartingAfter: string | null,
  maxPages = STRIPE_RECONCILIATION_MAX_PAGES,
  telemetry?: StripeRequestTelemetry
): Promise<StripeBoundedList<T>> {
  const items: T[] = [];
  let startingAfter = initialStartingAfter;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await stripeGet<StripeListResponse<T>>(credential, secretKey, path, {
      ...params,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    }, telemetry);
    telemetry?.recordPage(path);
    const pageItems = response.data ?? [];
    items.push(...pageItems);
    if (!response.has_more) {
      return { items, complete: true, nextStartingAfter: null };
    }
    const lastId = pageItems.at(-1)?.id;
    if (!lastId) {
      throw new Error(`Stripe ${path} returned has_more without a pagination id`);
    }
    startingAfter = lastId;
  }
  return { items, complete: false, nextStartingAfter: startingAfter };
}

async function stripeReconcileSubscriptionEvents(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  credential: StripeCredential,
  secretKey: string,
): Promise<StripeSubscriptionEventApi[]> {
  const cursorEndMs = new Date(plan.cursorEnd).getTime();
  if (!Number.isFinite(cursorEndMs)) throw new Error("Stripe trial event cursor end is invalid");
  // Stripe Event `created` filters and event timestamps have integer-second resolution. Persist
  // exactly the same whole-second half-open interval sent to Stripe so LOAD checks and published
  // coverage can never claim subsecond bounds that the provider request did not observe.
  const segmentToExclusiveMs = stripeEventSecondBoundary(
    cursorEndMs - STRIPE_EVENT_SAFETY_LAG_MS,
  );
  const safeRetentionFloorMs = segmentToExclusiveMs
    - STRIPE_EVENT_SAFE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const hardRetentionFloorMs = segmentToExclusiveMs
    - STRIPE_EVENT_HARD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const state = await db.one<StripeTrialSyncStateRow>(
    `select current_segment_from, current_segment_to_exclusive,
            current_segment_starting_after, continuous_coverage_from,
            closed_through_exclusive, retention_gap_count
       from stripe_trial_history_coverage
      where workspace_id = $1 and source_id = $2`,
    [request.workspaceId, request.sourceId],
  );
  const currentFrom = stripeTimestampIso(state?.current_segment_from);
  const currentTo = stripeTimestampIso(state?.current_segment_to_exclusive);
  const currentFromMs = currentFrom ? new Date(currentFrom).getTime() : Number.NaN;
  const currentToMs = currentTo ? new Date(currentTo).getTime() : Number.NaN;
  const resumable = Boolean(
    currentFrom && currentTo
    && isStripeEventSecondBoundary(currentFromMs)
    && isStripeEventSecondBoundary(currentToMs)
    && currentFromMs < currentToMs
    && currentFromMs >= hardRetentionFloorMs
    && currentToMs <= segmentToExclusiveMs,
  );
  const closedThrough = stripeTimestampIso(state?.closed_through_exclusive);
  const closedThroughMs = closedThrough ? new Date(closedThrough).getTime() : Number.NaN;
  const closedThroughCanonical = isStripeEventSecondBoundary(closedThroughMs);
  const staleClosedCoverage = Boolean(
    closedThrough && (!closedThroughCanonical || closedThroughMs < safeRetentionFloorMs),
  );
  const resetContinuousCoverage = Boolean((currentFrom || closedThrough) && !resumable && staleClosedCoverage);
  const segmentFromMs = resumable
    ? currentFromMs
    : !staleClosedCoverage && closedThroughCanonical
      ? Math.max(safeRetentionFloorMs, closedThroughMs - STRIPE_EVENT_OVERLAP_MS)
      : safeRetentionFloorMs;
  const boundedSegmentToMs = resumable ? currentToMs : segmentToExclusiveMs;
  const segmentFrom = new Date(segmentFromMs).toISOString();
  const segmentToExclusive = new Date(boundedSegmentToMs).toISOString();
  const page = await stripeListBounded<StripeSubscriptionEventApi>(
    credential,
    secretKey,
    "/v1/events",
    {
      limit: "100",
      "types[]": [...STRIPE_SUBSCRIPTION_EVENT_TYPES],
      "created[gte]": String(segmentFromMs / 1_000),
      "created[lt]": String(boundedSegmentToMs / 1_000),
    },
    resumable ? state?.current_segment_starting_after ?? null : null,
    STRIPE_RECONCILIATION_MAX_PAGES,
    plan.requestTelemetry,
  );
  plan.stripeTrialCheckpoint = {
    segmentFrom,
    segmentToExclusive,
    segmentComplete: page.complete,
    segmentStartingAfter: page.nextStartingAfter,
    latestClosedSegmentToExclusive: page.complete ? segmentToExclusive : null,
    resetContinuousCoverage,
    retentionGapReason: resetContinuousCoverage ? "event_retention_gap" : null,
  };
  return page.items;
}

async function stripeReconcilePaidInvoices(
  db: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
  credential: StripeCredential,
  secretKey: string
): Promise<StripeInvoiceApi[]> {
  const state = await db.one<StripeInvoiceSyncStateRow>(
    `select backfill_state, backfill_starting_after, latest_successful_stripe_cutoff,
            event_window_from, event_window_to,
            event_starting_after
       from stripe_invoice_sync_state
      where workspace_id = $1 and source_id = $2`,
    [request.workspaceId, request.sourceId]
  );
  const cutoff = stripeTimestampIso(state?.latest_successful_stripe_cutoff);
  const backfillRequired =
    !state ||
    state.backfill_state !== "complete" ||
    !cutoff ||
    stripeCutoffIsStale(cutoff, plan.cursorEnd);

  if (backfillRequired) {
    const continuing = state?.backfill_state === "in_progress";
    const anchor = continuing
      ? stripeTimestampIso(state.event_window_from) ?? plan.cursorEnd
      : plan.cursorEnd;
    const page = await stripeListBounded<StripeInvoiceApi>(
      credential,
      secretKey,
      "/v1/invoices",
      {
        limit: "100",
        status: "paid",
        "expand[]": ["data.customer"]
      },
      continuing ? state.backfill_starting_after : null,
      STRIPE_RECONCILIATION_MAX_PAGES,
      plan.requestTelemetry
    );
    plan.stripeInvoiceCheckpoint = {
      backfillState: page.complete ? "complete" : "in_progress",
      backfillStartingAfter: page.nextStartingAfter,
      backfillCompletion: page.complete ? "stamp" : "clear",
      eventWindowFrom: page.complete ? null : anchor,
      eventWindowTo: null,
      eventStartingAfter: null,
      // The anchor, rather than completion time, is the proven cutoff. Payments
      // transitioning while a multi-run crawl is in flight are subsequently
      // recovered from invoice.paid events beginning at this instant.
      latestSuccessfulStripeCutoff: page.complete ? anchor : cutoff
    };
    return page.items;
  }

  const cursorEndMs = new Date(plan.cursorEnd).getTime();
  if (!Number.isFinite(cursorEndMs)) throw new Error("Stripe invoice event cursor end is invalid");
  const cutoffMs = new Date(cutoff).getTime();
  // Resume an interrupted window verbatim; otherwise open a fresh one that (a) reaches BACK
  // below the durable cutoff by the overlap and (b) stops SHORT of now by the safety lag.
  // Stripe's `created` filters have whole-second resolution, so both edges are second-aligned:
  // the persisted cutoff must describe exactly the interval the provider was asked for.
  const resumedFrom = stripeTimestampIso(state.event_window_from);
  const resumedTo = stripeTimestampIso(state.event_window_to);
  const windowFromMs = resumedFrom
    ? new Date(resumedFrom).getTime()
    : stripeEventSecondBoundary(cutoffMs - STRIPE_EVENT_OVERLAP_MS);
  const laggedWindowToMs = stripeEventSecondBoundary(cursorEndMs - STRIPE_EVENT_SAFETY_LAG_MS);
  // Never invert the window on a freshly-backfilled source whose cutoff is younger than the lag.
  const windowToMs = resumedTo
    ? new Date(resumedTo).getTime()
    : Math.max(laggedWindowToMs, windowFromMs);
  const windowFrom = new Date(windowFromMs).toISOString();
  const windowTo = new Date(windowToMs).toISOString();
  const eventPage = await stripeListBounded<StripeInvoicePaidEventApi>(
    credential,
    secretKey,
    "/v1/events",
    {
      limit: "100",
      type: "invoice.paid",
      // HALF-OPEN [gte, lt), matching the trial and delta lanes. This lane used to send an
      // INCLUSIVE `created[lte]`, so the boundary second belonged to two consecutive windows and
      // the durable cutoff described a bound Stripe was never asked for exclusively. Standardised
      // deliberately: a window now covers exactly [from, to) and the stored cutoff IS `to`.
      "created[gte]": String(Math.floor(windowFromMs / 1000)),
      "created[lt]": String(Math.floor(windowToMs / 1000))
    },
    state.event_starting_after,
    STRIPE_RECONCILIATION_MAX_PAGES,
    plan.requestTelemetry
  );

  // One current invoice retrieval per natural invoice key. Stripe may emit
  // duplicate/retried event deliveries; current invoice truth plus the normalized
  // source-scoped upsert makes replay deterministic.
  const invoiceIds = new Set<string>();
  for (const event of eventPage.items) {
    const invoiceId = stripePaidEventInvoiceId(event);
    if (invoiceId) invoiceIds.add(invoiceId);
  }
  const invoices: StripeInvoiceApi[] = [];
  for (const invoiceId of invoiceIds) {
    invoices.push(
      await stripeGet<StripeInvoiceApi>(
        credential,
        secretKey,
        `/v1/invoices/${encodeURIComponent(invoiceId)}`,
        { "expand[]": ["customer"] },
        plan.requestTelemetry
      )
    );
  }
  plan.requestTelemetry?.recordObjectsRefetched(invoices.length);

  plan.stripeInvoiceCheckpoint = {
    backfillState: "complete",
    backfillStartingAfter: null,
    backfillCompletion: "preserve",
    eventWindowFrom: eventPage.complete ? null : windowFrom,
    eventWindowTo: eventPage.complete ? null : windowTo,
    eventStartingAfter: eventPage.nextStartingAfter,
    latestSuccessfulStripeCutoff: eventPage.complete ? windowTo : cutoff
  };
  return invoices;
}

function stripeCutoffIsStale(cutoff: string, cursorEnd: string): boolean {
  const cutoffMs = new Date(cutoff).getTime();
  const endMs = new Date(cursorEnd).getTime();
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(endMs)) return true;
  return endMs - cutoffMs > STRIPE_EVENT_SAFE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function stripeTimestampIso(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function stripePaidEventInvoiceId(event: StripeInvoicePaidEventApi): string | null {
  const object = event.data?.object;
  if (typeof object === "string") return object.trim() || null;
  return stringOrNull(object?.id);
}

async function writeStripeInvoiceCheckpoint(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan
): Promise<void> {
  const checkpoint = plan.stripeInvoiceCheckpoint;
  if (!checkpoint) return;
  await tx.query(
    `insert into stripe_invoice_sync_state (
       id, workspace_id, source_id, backfill_state, backfill_starting_after,
       backfill_completed_at, event_window_from, event_window_to,
       event_starting_after, latest_successful_stripe_cutoff,
       last_successful_sync_at, updated_at
     )
     values ($1,$2,$3,$4,$5,case when $6 = 'stamp' then now() else null end,$7,$8,$9,$10,now(),now())
     on conflict (workspace_id, source_id)
     do update set
       backfill_state = excluded.backfill_state,
       backfill_starting_after = excluded.backfill_starting_after,
       backfill_completed_at = case
         when $6 = 'stamp' then now()
         when $6 = 'clear' then null
         else stripe_invoice_sync_state.backfill_completed_at
       end,
       event_window_from = excluded.event_window_from,
       event_window_to = excluded.event_window_to,
       event_starting_after = excluded.event_starting_after,
       latest_successful_stripe_cutoff = excluded.latest_successful_stripe_cutoff,
       last_successful_sync_at = now(),
       updated_at = now()`,
    [
      `stripe_invoice_state_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      checkpoint.backfillState,
      checkpoint.backfillStartingAfter,
      checkpoint.backfillCompletion,
      checkpoint.eventWindowFrom,
      checkpoint.eventWindowTo,
      checkpoint.eventStartingAfter,
      checkpoint.latestSuccessfulStripeCutoff
    ]
  );
}

async function writeStripeCloseSuccess(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan
): Promise<void> {
  // RECONCILIATION RUNS FIRST, inside this same transaction, so every classifier below observes
  // REPAIRED canonical state. A drifted subscription amount repaired here is the value the MRR
  // movement classifier diffs against; running it afterwards would mint one more ledger fact from
  // state the reconciler had already proven wrong.
  await stripeReconciliationAtClose(tx, request, plan);
  // Then the deletions the delta lane PROVED (event + 404), before any classifier reads the
  // invoice tables, so nothing downstream mints a fact from a row Stripe no longer has.
  await applyStripeObservedInvoiceDeletions(tx, request, plan);
  // Invoice completeness is one bootstrap predicate, so land its durable checkpoint first. Both
  // operations remain inside the same outer CLOSE transaction and roll back together.
  await writeStripeInvoiceCheckpoint(tx, request, plan);
  // The SAME CLOSE-time classifiers run for BOTH lanes. They read canonical state from our own
  // tables (not from the batch), so a delta run that touched three subscriptions still classifies
  // against the complete current subscription set — exactly as a full run does.
  await writeStripeMrrMovementsAtClose(tx, request);
  await writeStripeTrialCloseSuccess(tx, request, plan);
  // Last: the lane's own segment/evidence/watermark. If any classifier above failed, the whole
  // transaction rolls back and the watermark never outruns normalized truth.
  if (plan.stripeLaneCheckpoint) {
    await writeStripeSyncLaneAtClose(tx, request, plan.stripeLaneCheckpoint);
  }
}

/**
 * Remove the invoices the DELTA lane proved gone: an `invoice.deleted` event named them and the
 * retrieve of the same id 404'd inside the same window.
 *
 * REVENUE-SAFE BY STRIPE'S OWN RULE. Only a ONE-OFF DRAFT can be deleted — a finalized invoice, or
 * any invoice for a subscription, must be voided instead, which keeps the object
 * (docs.stripe.com/api/invoices/delete). So a deleted invoice was never paid and the revenue views
 * — which read `status = 'paid'` — never counted it. Leaving the row instead would strand a draft
 * Stripe can never update again, and every later reconciliation would report it as
 * `missing_remote` forever.
 *
 * Lines go first: they carry the invoice id, and an orphaned line is a phantom the invoice-level
 * views cannot see.
 */
async function applyStripeObservedInvoiceDeletions(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
): Promise<void> {
  const invoiceIds = plan.stripeDeletedInvoiceIds;
  if (!invoiceIds || invoiceIds.length === 0) return;
  await tx.query(
    `delete from stripe_invoice_lines
      where workspace_id = $1 and source_id = $2 and stripe_invoice_id = any($3::text[])`,
    [request.workspaceId, request.sourceId, invoiceIds],
  );
  await tx.query(
    `delete from stripe_invoices
      where workspace_id = $1 and source_id = $2 and stripe_invoice_id = any($3::text[])`,
    [request.workspaceId, request.sourceId, invoiceIds],
  );
}

/**
 * Compare the remote snapshot against local canonical state, record EVERY difference, repair the
 * repairable ones and advance `reconciled_at` — all inside the caller's CLOSE transaction.
 *
 * `StripeReconciliationClaimLostError` is deliberately NOT caught: a run that lost the source
 * claim mid-CLOSE must roll the whole transaction back rather than write repairs into a table the
 * new owner is mid-replacement of.
 */
async function stripeReconciliationAtClose(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
): Promise<void> {
  const reconciliation = plan.stripeReconciliation;
  if (!reconciliation) return;
  if (!reconciliation.remote) {
    // Fail closed rather than advance `reconciled_at`. A due reconciliation with no snapshot means
    // the run took the DELTA lane (whose partial retrievals would read as mass deletion) or the
    // extractor changed without updating this contract — either way, claiming a full-set
    // comparison that never happened is the one outcome the drift telemetry cannot survive.
    throw new Error(
      `Stripe reconciliation was due (${reconciliation.reason}) but no remote snapshot was extracted`,
    );
  }
  const scope = {
    workspaceId: request.workspaceId,
    sourceId: request.sourceId,
    runStartedAt: reconciliation.runStartedAt,
  };
  // TWO COMPARISONS, ONE REMOTE SNAPSHOT.
  //   • `livePlan`     — against POST-LOAD canonical state. This is what may still need REPAIRING.
  //   • `measuredPlan` — against the PRE-LOAD projection. This is what actually DRIFTED, and it is
  //                      the only one that can see a difference this run's own full replacement
  //                      already healed. Without it the drift ledger reports clean by construction
  //                      and the relax-daily-to-weekly gate would go green on zero evidence.
  // On a bootstrap run (no prior full import) there is no pre-load projection and the two collapse
  // into today's single live comparison.
  const livePlan = await computeReconciliationPlan(tx, scope, reconciliation.remote);
  const measuredPlan = reconciliation.localPreLoad
    ? await computeReconciliationPlan(tx, scope, reconciliation.remote, {
      local: reconciliation.localPreLoad,
    })
    : livePlan;
  const outcome = await applyReconciliation(
    tx,
    measuredPlan,
    { ...scope, syncRunId: request.syncRunId },
    reconciliation.localPreLoad ? { postLoad: livePlan } : {},
  );
  plan.requestTelemetry?.recordReconciliationOutcome({
    driftCount: outcome.driftCount,
    repairedCount: outcome.repairedCount,
    recordedOnlyCount: outcome.recordedOnlyCount,
    healedByLoadCount: outcome.healedByLoadCount,
    countsByKind: outcome.countsByKind,
    // The unevaluated-deletion honesty claim belongs to the LIVE comparison: it describes what the
    // REMOTE sets could prove, which is identical in both plans, and the live one is always present.
    unevaluatedDeletionReasons: livePlan.unevaluatedDeletions.map(
      (entry) => `${entry.entityKind}:${entry.reason}`,
    ),
  });
}

async function writeStripeTrialCloseSuccess(
  tx: InfiniteOsDb,
  request: SyncRequest,
  plan: SyncPlan,
): Promise<void> {
  const checkpoint = plan.stripeTrialCheckpoint;
  if (!checkpoint) return;

  if (!checkpoint.segmentComplete) {
    await tx.query(
      `insert into stripe_trial_history_coverage (
         id, workspace_id, source_id, current_segment_from, current_segment_to_exclusive,
         current_segment_starting_after, parser_version, last_successful_sync_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,now(),now())
       on conflict (workspace_id, source_id)
       do update set
         current_segment_from = excluded.current_segment_from,
         current_segment_to_exclusive = excluded.current_segment_to_exclusive,
         current_segment_starting_after = excluded.current_segment_starting_after,
         parser_version = excluded.parser_version,
         last_successful_sync_at = now(),
         updated_at = now()`,
      [
        `stripe_trial_coverage_${randomUUID()}`,
        request.workspaceId,
        request.sourceId,
        checkpoint.segmentFrom,
        checkpoint.segmentToExclusive,
        checkpoint.segmentStartingAfter,
        STRIPE_TRIAL_PARSER_VERSION,
      ],
    );
    return;
  }

  const prior = await tx.one<StripeTrialSyncStateRow>(
    `select current_segment_from, current_segment_to_exclusive,
            current_segment_starting_after, continuous_coverage_from,
            closed_through_exclusive, retention_gap_count
       from stripe_trial_history_coverage
      where workspace_id = $1 and source_id = $2`,
    [request.workspaceId, request.sourceId],
  );
  const priorContinuousFrom = stripeTimestampIso(prior?.continuous_coverage_from);
  const priorClosedThrough = stripeTimestampIso(prior?.closed_through_exclusive);
  const continuousFrom = checkpoint.resetContinuousCoverage || !priorContinuousFrom
    ? checkpoint.segmentFrom
    : priorContinuousFrom;
  const closedThrough = !priorClosedThrough || priorClosedThrough < checkpoint.segmentToExclusive
    ? checkpoint.segmentToExclusive
    : priorClosedThrough;

  const publishedSegments = await tx.query<{ id: string }>(
    `insert into stripe_trial_history_segments (
       id, workspace_id, source_id, segment_from, segment_to_exclusive, parser_version
     ) values ($1,$2,$3,$4,$5,$6)
     on conflict (workspace_id, source_id, segment_from, segment_to_exclusive)
     do update set parser_version = excluded.parser_version
     returning id`,
    [
      `stripe_trial_segment_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      checkpoint.segmentFrom,
      checkpoint.segmentToExclusive,
      STRIPE_TRIAL_PARSER_VERSION,
    ],
  );
  const publishedSegmentId = publishedSegments[0]?.id;
  if (!publishedSegmentId) throw new Error("Stripe lifecycle CLOSE did not publish its segment");
  await tx.query(
    `update stripe_subscription_lifecycle_events
        set segment_closed_at = coalesce(segment_closed_at, now()),
            published_segment_id = $5
      where workspace_id = $1 and source_id = $2
        and event_created_at >= $3 and event_created_at < $4`,
    [
      request.workspaceId,
      request.sourceId,
      checkpoint.segmentFrom,
      checkpoint.segmentToExclusive,
      publishedSegmentId,
    ],
  );

  const evidence = await tx.query<{
    stripe_event_id: string;
    event_type: string;
    event_created_at: string | Date;
    stripe_subscription_id: string;
    stripe_customer_id: string | null;
    livemode: boolean | null;
    current_status: string | null;
    previous_status: string | null;
    trial_end: string | Date | null;
    ended_at: string | Date | null;
    canceled_at: string | Date | null;
    business_eligible_at_capture: boolean;
  }>(
    `select stripe_event_id, event_type, event_created_at, stripe_subscription_id,
            stripe_customer_id, livemode, current_status, previous_status, trial_end,
            ended_at, canceled_at, business_eligible_at_capture
       from stripe_subscription_lifecycle_events e
       join stripe_trial_history_segments seg
         on seg.workspace_id = e.workspace_id
        and seg.source_id = e.source_id
        and seg.id = e.published_segment_id
      where e.workspace_id = $1 and e.source_id = $2
        and e.segment_closed_at is not null
        and e.event_created_at >= $3 and e.event_created_at < $4
      order by e.event_created_at, e.stripe_event_id`,
    [request.workspaceId, request.sourceId, continuousFrom, closedThrough],
  );
  const classification = classifyStripeTrialEvents({
    observedAt: closedThrough,
    events: evidence.map((event) => ({
      eventId: event.stripe_event_id,
      eventType: event.event_type,
      eventCreatedAt: stripeTimestampIso(event.event_created_at) ?? "",
      subscriptionId: event.stripe_subscription_id,
      customerId: event.stripe_customer_id,
      livemode: event.livemode,
      currentStatus: event.current_status,
      previousStatus: event.previous_status,
      trialEnd: stripeTimestampIso(event.trial_end),
      endedAt: stripeTimestampIso(event.ended_at),
      canceledAt: stripeTimestampIso(event.canceled_at),
      businessEligibleAtCapture: event.business_eligible_at_capture,
    })),
  });

  if (!classification.unavailableReason) {
    for (const spell of classification.spells) {
      await tx.query(
        `insert into stripe_trial_spells (
           id, workspace_id, source_id, stripe_subscription_id, stripe_customer_id,
           start_event_id, start_at, scheduled_trial_end, effective_trial_end,
           end_event_id, end_authority, terminal_status, livemode,
           business_eligible_at_capture, value_incomplete_reasons, classifier_version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (workspace_id, source_id, stripe_subscription_id, start_event_id)
         do update set
           stripe_customer_id = excluded.stripe_customer_id,
           scheduled_trial_end = excluded.scheduled_trial_end,
           effective_trial_end = excluded.effective_trial_end,
           end_event_id = excluded.end_event_id,
           end_authority = excluded.end_authority,
           terminal_status = excluded.terminal_status,
           livemode = excluded.livemode,
           business_eligible_at_capture = excluded.business_eligible_at_capture,
           updated_at = now()`,
        [
          `stripe_trial_spell_${randomUUID()}`,
          request.workspaceId,
          request.sourceId,
          spell.subscriptionId,
          spell.customerId,
          spell.startEventId,
          spell.startAt,
          spell.scheduledTrialEnd,
          spell.effectiveEndAt,
          spell.endEventId,
          spell.endAuthority,
          spell.terminalStatus,
          spell.livemode,
          spell.businessEligibleAtCapture,
          ["frozen_value_not_observed"],
          STRIPE_TRIAL_CLASSIFIER_VERSION,
        ],
      );
    }

    await tx.query(
      `update stripe_trial_spells sp
          set frozen_currency = lower(v.currency),
              frozen_net_monthly_amount_minor = v.net_monthly_amount_cents::numeric(38,12),
              frozen_value_observed_at = now(),
              frozen_value_evidence_hash = md5(concat(
                lower(v.currency), ':', v.net_monthly_amount_cents::numeric(38,12)::text,
                ':', v.stripe_subscription_id
              )),
              frozen_value_provenance = 'first_complete_current_observation_v1',
              value_incomplete_reasons = array[]::text[],
              updated_at = now()
         from queryable.vw_stripe_subscription_recurring_value v
         join stripe_subscriptions current_sub
           on current_sub.workspace_id = v.workspace_id
          and current_sub.source_id = v.source_id
          and current_sub.stripe_subscription_id = v.stripe_subscription_id
        where sp.workspace_id = $1 and sp.source_id = $2
          and sp.workspace_id = v.workspace_id
          and sp.source_id = v.source_id
          and sp.stripe_subscription_id = v.stripe_subscription_id
          and sp.effective_trial_end is null
          and sp.frozen_value_observed_at is null
          and sp.livemode is true and current_sub.livemode is true
          and sp.business_eligible_at_capture and v.business_eligible
          and current_sub.status = 'trialing'
          and v.value_state = 'complete'
          and v.currency is not null
          and v.net_monthly_amount_cents is not null`,
      [request.workspaceId, request.sourceId],
    );
    await tx.query(
      `update stripe_trial_spells sp
          set effective_trial_end = sp.scheduled_trial_end,
              end_authority = 'scheduled_trial_end',
              terminal_status = current_sub.status,
              updated_at = now()
         from stripe_subscriptions current_sub
        where sp.workspace_id = $1 and sp.source_id = $2
          and current_sub.workspace_id = sp.workspace_id
          and current_sub.source_id = sp.source_id
          and current_sub.stripe_subscription_id = sp.stripe_subscription_id
          and sp.effective_trial_end is null
          and sp.scheduled_trial_end is not null
          and sp.scheduled_trial_end <= $3::timestamptz
          and current_sub.status <> 'trialing'
          and sp.livemode is true and current_sub.livemode is true`,
      [request.workspaceId, request.sourceId, closedThrough],
    );
  }

  // DIAGNOSABILITY. Before this, an unclassifiable lifecycle event left nothing behind but a
  // counter — `incomplete_event_count = 1` with no way to see WHICH event or WHY, while the whole
  // trial funnel fail-closed on it. Park the offending rows in the insert-only evidence table so
  // the next sync of a stuck source carries the payload the parser choked on.
  await writeStripeUnclassifiedLifecycleEvidence(tx, request, classification.unknownEventIds);

  const incompleteReasons = [
    ...(classification.unavailableReason ? [classification.unavailableReason] : []),
    ...(classification.unknownEventIds.length > 0 ? ["unclassified_lifecycle_evidence"] : []),
  ];
  await tx.query(
    `insert into stripe_trial_history_coverage (
       id, workspace_id, source_id, current_segment_from, current_segment_to_exclusive,
       current_segment_starting_after, continuous_coverage_from, closed_through_exclusive,
       retention_gap_count, last_gap_from, last_gap_to, last_gap_reason,
       last_successful_sync_at, incomplete_event_count, incomplete_reasons,
       parser_version, updated_at
     ) values (
       $1,$2,$3,null,null,null,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,now()
     )
     on conflict (workspace_id, source_id)
     do update set
       current_segment_from = null,
       current_segment_to_exclusive = null,
       current_segment_starting_after = null,
       continuous_coverage_from = excluded.continuous_coverage_from,
       closed_through_exclusive = excluded.closed_through_exclusive,
       retention_gap_count = excluded.retention_gap_count,
       last_gap_from = excluded.last_gap_from,
       last_gap_to = excluded.last_gap_to,
       last_gap_reason = excluded.last_gap_reason,
       last_successful_sync_at = now(),
       incomplete_event_count = excluded.incomplete_event_count,
       incomplete_reasons = excluded.incomplete_reasons,
       parser_version = excluded.parser_version,
       updated_at = now()`,
    [
      `stripe_trial_coverage_${randomUUID()}`,
      request.workspaceId,
      request.sourceId,
      continuousFrom,
      closedThrough,
      (prior?.retention_gap_count ?? 0) + (checkpoint.resetContinuousCoverage ? 1 : 0),
      checkpoint.resetContinuousCoverage ? priorClosedThrough : null,
      checkpoint.resetContinuousCoverage ? checkpoint.segmentFrom : null,
      checkpoint.retentionGapReason,
      classification.unknownEventIds.length,
      incompleteReasons,
      STRIPE_TRIAL_PARSER_VERSION,
    ],
  );
}

/**
 * Sentinel `stripe_event_evidence.object_kind` for a lifecycle event the trial parser could not
 * classify. It is NOT an entity family like the delta lane's kinds — it marks a row that exists
 * purely so the failure is inspectable (`where object_kind = 'unclassified_lifecycle'`).
 */
const STRIPE_UNCLASSIFIED_LIFECYCLE_OBJECT_KIND = "unclassified_lifecycle";

/**
 * Persist the unclassifiable lifecycle events as evidence, inside the CLOSE transaction.
 *
 * INSERT-ONLY, matching the table's contract: `on conflict do nothing` means an event the DELTA
 * lane already stored (as `object_kind = 'subscription'`, with its real Stripe payload) keeps that
 * first observation — the richer row — instead of being overwritten by this marker. On the FULL
 * lane, which is where the filtered trial poll runs and where the live symptom was observed,
 * nothing has stored the event yet, so the marker lands.
 *
 * `payload` is the NORMALIZED lifecycle row, not the raw Stripe event: that is precisely what the
 * classifier consumed, so it is what explains the classifier's verdict. `previous_attributes` is
 * left NULL rather than reconstructed from `previous_status` / `previous_trial_*` — a synthesized
 * diff would be indistinguishable from a real one, and the columns are in the payload anyway.
 */
async function writeStripeUnclassifiedLifecycleEvidence(
  tx: InfiniteOsDb,
  request: SyncRequest,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map((_, index) => `$${index + 4}`).join(",");
  await tx.query(
    `insert into stripe_event_evidence (
       id, workspace_id, source_id, stripe_event_id, event_type, event_created_at,
       api_version, livemode, object_kind, object_external_id, payload,
       previous_attributes, segment_id
     )
     select
       -- DETERMINISTIC id, scoped by source so a PK collision can only ever be the same
       -- (source, event) row — which the unique key below arbitrates first. A random uuid would
       -- make a re-run of the same stuck window raise on the primary key instead.
       'stripe_unclassified_lifecycle_' || e.source_id || '_' || e.stripe_event_id,
       e.workspace_id, e.source_id, e.stripe_event_id, e.event_type, e.event_created_at,
       e.api_version, e.livemode, $3,
       -- The subscription the event described. Empty only when Stripe returned an object with no
       -- id at all — one of the shapes that makes an event unclassifiable in the first place — so
       -- the event id stands in rather than violating the NOT NULL.
       coalesce(nullif(e.stripe_subscription_id, ''), e.stripe_event_id),
       to_jsonb(e), null, null
     from stripe_subscription_lifecycle_events e
     where e.workspace_id = $1 and e.source_id = $2
       and e.stripe_event_id in (${placeholders})
     on conflict (workspace_id, source_id, stripe_event_id) do nothing`,
    [
      request.workspaceId,
      request.sourceId,
      STRIPE_UNCLASSIFIED_LIFECYCLE_OBJECT_KIND,
      ...eventIds,
    ],
  );
}

async function stripeInvoiceLines(
  credential: StripeCredential,
  secretKey: string,
  invoice: StripeInvoiceApi,
  telemetry?: StripeRequestTelemetry
): Promise<StripeInvoiceLineApi[]> {
  const inline = invoice.lines?.data ?? [];
  if (!invoice.lines?.has_more) {
    return inline;
  }
  return stripeList<StripeInvoiceLineApi>(credential, secretKey, `/v1/invoices/${invoice.id}/lines`, {
    limit: "100"
  }, telemetry);
}

// Origin classification by KEY PRESENCE, not truthiness.
//
// `'non_subscription'` used to be reachable only when `parent` was a non-null object with a
// `type`, so every standalone dashboard invoice (modern: `parent: null`; legacy API version:
// no `parent` key at all) landed on `'unknown'` — and 0054's `completeness_sufficient` counts
// `unknown` paid invoices over ALL time, so a single manual invoice permanently blocked trial
// acquisition + conversion metrics. Key presence is the only signal that distinguishes "Stripe
// told us this invoice has no subscription parent" from "this API shape cannot tell us".
//
// `'unknown'` now means only: neither `parent` nor `subscription` was present on the payload at
// all. That is genuinely exceptional (no known Stripe API version omits both), so it stays a
// blocker on completeness.
function stripeInvoiceSubscriptionOrigin(
  invoice: StripeInvoiceApi,
  subscriptionId: string | null
): StripeInvoiceRow["subscriptionOrigin"] {
  if (subscriptionId) return "subscription";
  const parent = invoice.parent;
  if (parent && (parent.subscription_details !== undefined
    || stringOrNull(parent.type) === "subscription_details")) {
    return "subscription";
  }
  // JSON responses never carry `undefined` values, so `key in object` is exactly "Stripe sent
  // this field". The `!== undefined` guard only matters for hand-built objects in tests.
  const hasParentKey = "parent" in invoice && invoice.parent !== undefined;
  const hasLegacySubscriptionKey = "subscription" in invoice && invoice.subscription !== undefined;
  if (hasParentKey || hasLegacySubscriptionKey) return "non_subscription";
  return "unknown";
}

function stripeRequiredInvoiceField<T>(invoice: StripeInvoiceApi, value: T | null, field: string): T {
  if (value === null) {
    throw new ConnectorError(
      "provider_api_error",
      `Stripe invoice ${invoice.id} returned no ${field}; refusing to invent one`,
      false
    );
  }
  return value;
}

function stripeInvoiceRow(invoice: StripeInvoiceApi, lines: StripeInvoiceLineApi[]): StripeInvoiceRow {
  // An EXPANDED customer arrives as an object; a bare id arrives as a string. Only the former
  // makes `metadata` observable, which is what makes the classification authoritative below.
  // A DELETED customer expands to a `{ id, deleted: true }` stub that carries no metadata — that
  // is not an observation of the tag's absence, so it must not clear a stored classification.
  const customerExpanded = typeof invoice.customer === "object" && invoice.customer !== null
    && (invoice.customer as { deleted?: unknown }).deleted !== true;
  const customer = objectOrString(invoice.customer);
  const customerMetadata = objectOrString(customer.metadata);
  const modernSubscription = invoice.parent?.subscription_details?.subscription;
  const legacySubscription = invoice.subscription;
  const subscriptionValue = modernSubscription ?? legacySubscription;
  const subscription = objectOrString(subscriptionValue);
  const subscriptionId = subscription.id ?? stringOrNull(subscriptionValue);
  // A paid invoice with no status would previously be defaulted to "paid" and counted as
  // revenue. A missing status is a provider-contract violation, not a datum.
  const status = stringOrNull(invoice.status);
  if (!status) {
    throw new ConnectorError(
      "provider_api_error",
      `Stripe invoice ${invoice.id} returned no status; refusing to assume it was paid`,
      false
    );
  }
  return {
    kind: "invoice",
    externalId: `stripe:${invoice.id}`,
    invoiceId: invoice.id,
    // objectOrString already normalizes a bare id string to { id }, so this covers both the
    // expanded and unexpanded shapes — and yields null, never "", when there is no customer.
    customerId: stringOrNull(customer.id),
    customerEmail: stringOrNull(customer.email),
    customerName: stringOrNull(customer.name),
    customerMetricsClassification: stringOrNull(customerMetadata.infinite_metrics_classification),
    customerMetadataAuthoritative: customerExpanded,
    subscriptionId,
    subscriptionOrigin: stripeInvoiceSubscriptionOrigin(invoice, subscriptionId),
    status,
    // Same contract-violation stance as `status`: currency and amount_paid are unconditionally
    // present on real Stripe invoices; inventing "usd"/0 would silently mislabel or zero revenue.
    currency: stripeRequiredInvoiceField(invoice, stringOrNull(invoice.currency), "currency"),
    amountPaid: stripeRequiredInvoiceField(
      invoice,
      typeof invoice.amount_paid === "number" ? invoice.amount_paid : null,
      "amount_paid"
    ),
    amountDue: Number(invoice.amount_due ?? 0),
    postPaymentCreditedMinor: stripeMinorAmountOrNull(invoice.post_payment_credit_notes_amount),
    prePaymentCreditedMinor: stripeMinorAmountOrNull(invoice.pre_payment_credit_notes_amount),
    paidAt: invoice.status_transitions?.paid_at ? unixToIso(invoice.status_transitions.paid_at) : null,
    createdAt: unixToIso(invoice.created),
    periodEnd: typeof subscription.current_period_end === "number" ? unixToIso(subscription.current_period_end) : null,
    externalOrderId: stringOrNull(invoice.metadata?.external_order_id ?? invoice.metadata?.order_id),
    lines: lines.map((line) => stripeInvoiceLineRow(line))
  };
}

// Absent/unreadable stays null (the column is nullable and consumers must be able to tell
// "no credit notes reported" from "zero credit notes"), never a defaulted 0.
function stripeMinorAmountOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripeSubscriptionRow(
  subscription: StripeSubscriptionApi,
  coupons: Map<string, Record<string, unknown>> = new Map()
): StripeSubscriptionRow {
  // Deleted-customer stubs ({ id, deleted: true }) carry no metadata; see stripeInvoiceRow.
  const customerExpanded = typeof subscription.customer === "object" && subscription.customer !== null
    && (subscription.customer as { deleted?: unknown }).deleted !== true;
  const customer = objectOrString(subscription.customer);
  const customerMetadata = objectOrString(customer.metadata);
  const items = subscription.items?.data ?? [];
  const itemCurrencies = new Set(items.flatMap((item) => {
    const currency = stringOrNull(objectOrString(item.price).currency)?.toLowerCase() ?? null;
    return currency ? [currency] : [];
  }));
  const subscriptionCurrency = stringOrNull(subscription.currency)?.toLowerCase()
    ?? (itemCurrencies.size === 1 ? [...itemCurrencies][0] ?? null : null);
  const subscriptionDiscounts = stripeDiscountRows(subscription.discounts, coupons, subscriptionCurrency);
  const itemRows = items.map((item) => stripeSubscriptionItemRow(item, coupons, subscriptionCurrency));
  return {
    kind: "subscription",
    externalId: `stripe-subscription:${subscription.id}`,
    subscriptionId: subscription.id,
    liveMode: typeof subscription.livemode === "boolean" ? subscription.livemode : null,
    customerId: customer.id ?? stringOrNull(subscription.customer),
    customerEmail: stringOrNull(customer.email),
    customerMetricsClassification: stringOrNull(customerMetadata.infinite_metrics_classification),
    customerMetadataAuthoritative: customerExpanded,
    status: String(subscription.status ?? "unknown"),
    currency: subscriptionCurrency,
    createdAt: unixToIso(subscription.created),
    currentPeriodStart: unixNumberToIso(subscription.current_period_start),
    currentPeriodEnd: unixNumberToIso(subscription.current_period_end),
    trialStart: unixNumberToIso(subscription.trial_start),
    trialEnd: unixNumberToIso(subscription.trial_end),
    cancelAt: unixNumberToIso(subscription.cancel_at),
    canceledAt: unixNumberToIso(subscription.canceled_at),
    endedAt: unixNumberToIso(subscription.ended_at),
    itemsSynced: true,
    discountsSynced:
      subscriptionDiscounts.complete &&
      itemRows.every((item) => item.discounts.every((discount) => discount.complete)),
    discounts: subscriptionDiscounts.rows,
    items: itemRows
  };
}

function stripeCustomerRow(customer: Record<string, unknown> & { id?: string }): StripeCustomerRow {
  const customerId = stringOrNull(customer.id);
  if (!customerId) {
    throw new ConnectorError(
      "provider_api_error",
      "Stripe returned a customer without an id; refusing to invent one",
      false
    );
  }
  const deleted = customer.deleted === true;
  return {
    kind: "customer",
    externalId: `stripe-customer:${customerId}`,
    customerId,
    email: stringOrNull(customer.email),
    name: stringOrNull(customer.name),
    metricsClassification: stringOrNull(
      objectOrString(customer.metadata).infinite_metrics_classification
    ),
    metadataAuthoritative: !deleted,
    createdAt: unixNumberToIso(customer.created),
    deleted
  };
}

function stripeSubscriptionEventRow(
  event: StripeSubscriptionEventApi,
  checkpoint: StripeTrialCheckpoint,
): StripeSubscriptionEventRow {
  const object = objectOrString(event.data?.object);
  const previous = objectOrString(event.data?.previous_attributes);
  return {
    kind: "subscription_event",
    externalId: `stripe-subscription-event:${event.id}`,
    stripeEventId: event.id,
    eventType: event.type,
    eventCreatedAt: unixToIso(event.created),
    apiVersion: stringOrNull(event.api_version),
    livemode: typeof event.livemode === "boolean" ? event.livemode : null,
    subscriptionId: stringOrNull(object.id) ?? "",
    customerId: stringOrNull(objectOrString(object.customer).id ?? object.customer),
    currentStatus: stringOrNull(object.status),
    previousStatus: stringOrNull(previous.status),
    trialStart: unixNumberToIso(object.trial_start),
    trialEnd: unixNumberToIso(object.trial_end),
    endedAt: unixNumberToIso(object.ended_at),
    canceledAt: unixNumberToIso(object.canceled_at),
    previousTrialStart: unixNumberToIso(previous.trial_start),
    previousTrialEnd: unixNumberToIso(previous.trial_end),
    segmentFrom: checkpoint.segmentFrom,
    segmentToExclusive: checkpoint.segmentToExclusive,
  };
}

function stripeSubscriptionItemRow(
  item: StripeSubscriptionItemApi,
  coupons: Map<string, Record<string, unknown>> = new Map(),
  targetCurrency: string | null = null
): StripeSubscriptionItemRow {
  const price = objectOrString(item.price);
  const product = objectOrString(price.product);
  const recurring = objectOrString(price.recurring);
  const intervalCount = nullableNumber(recurring.interval_count);
  const quantity = nullableNumber(item.quantity);
  const defaultCurrency = stringOrNull(price.currency)?.toLowerCase() ?? null;
  const defaultUnitAmount = nullableNumber(price.unit_amount);
  const priceCurrencyOptions = stripePriceCurrencyOptions(price.currency_options);
  const selectedOption = targetCurrency ? priceCurrencyOptions[targetCurrency] : undefined;
  const currencyOptionResolved = !targetCurrency || targetCurrency === defaultCurrency
    ? true
    : selectedOption !== undefined;
  const selectedCurrency = targetCurrency ?? defaultCurrency;
  const selectedUnitAmount = targetCurrency && targetCurrency !== defaultCurrency
    ? selectedOption?.unitAmount ?? null
    : defaultUnitAmount;
  const selectedCustomUnitAmount = targetCurrency && targetCurrency !== defaultCurrency
    ? selectedOption?.customUnitAmount ?? false
    : Object.keys(objectOrString(price.custom_unit_amount)).length > 0;
  const transform = objectOrString(price.transform_quantity);
  const transformDivideBy = nullableNumber(transform.divide_by);
  const transformRound = stringOrNull(transform.round);
  const transformValid = Object.keys(transform).length === 0 || (
    transformDivideBy !== null && Number.isInteger(transformDivideBy) && transformDivideBy > 0 &&
    (transformRound === "up" || transformRound === "down")
  );
  return {
    itemId: item.id,
    priceId: price.id ?? stringOrNull(item.price),
    productId: product.id ?? stringOrNull(price.product),
    currency: selectedCurrency,
    unitAmount: selectedUnitAmount,
    defaultCurrency,
    defaultUnitAmount,
    priceCurrencyOptions,
    currencyOptionResolved,
    quantity: quantity !== null && Number.isInteger(quantity) && quantity >= 0 ? quantity : null,
    recurringInterval: stringOrNull(recurring.interval),
    recurringIntervalCount:
      intervalCount !== null && Number.isInteger(intervalCount) && intervalCount > 0
        ? intervalCount
        : null,
    recurringUsageType: stringOrNull(recurring.usage_type),
    billingScheme: stringOrNull(price.billing_scheme),
    customUnitAmount: selectedCustomUnitAmount,
    transformQuantityDivideBy: transformDivideBy,
    transformQuantityRound: transformRound === "up" || transformRound === "down" ? transformRound : null,
    pricingState: stripePricingState(
      price,
      recurring,
      selectedUnitAmount,
      selectedCustomUnitAmount,
      currencyOptionResolved,
      transformValid
    ),
    discounts: stripeDiscountRows(item.discounts, coupons, selectedCurrency).rows
  };
}

function stripePriceCurrencyOptions(
  value: unknown
): Record<string, { unitAmount: number | null; customUnitAmount: boolean }> {
  const result: Record<string, { unitAmount: number | null; customUnitAmount: boolean }> = {};
  for (const [rawCurrency, rawOption] of Object.entries(objectOrString(value))) {
    const currency = rawCurrency.toLowerCase();
    const option = objectOrString(rawOption);
    result[currency] = {
      unitAmount: nullableNumber(option.unit_amount),
      customUnitAmount: Object.keys(objectOrString(option.custom_unit_amount)).length > 0,
    };
  }
  return result;
}

function stripePricingState(
  price: Record<string, unknown>,
  recurring: Record<string, unknown>,
  selectedUnitAmount = nullableNumber(price.unit_amount),
  selectedCustomUnitAmount = Object.keys(objectOrString(price.custom_unit_amount)).length > 0,
  currencyOptionResolved = true,
  transformQuantityValid = true
): string {
  if (!currencyOptionResolved) return "currency_option_unresolved";
  if (!transformQuantityValid) return "invalid_transform_quantity";
  if (stringOrNull(recurring.usage_type) === "metered") return "metered";
  if (stringOrNull(price.billing_scheme) === "tiered") return "tiered";
  if (selectedCustomUnitAmount) return "custom";
  if (selectedUnitAmount === null) return "unknown_price";
  if (
    stringOrNull(recurring.usage_type) === "licensed" &&
    stringOrNull(price.billing_scheme) === "per_unit" &&
    stringOrNull(recurring.interval)
  ) return "licensed_per_unit";
  return "unknown";
}

function stripeDiscountRows(
  discounts: Array<string | StripeDiscountApi> | undefined,
  coupons: Map<string, Record<string, unknown>> = new Map(),
  targetCurrency: string | null = null
): { rows: StripeDiscountRow[]; complete: boolean } {
  const rows: StripeDiscountRow[] = [];
  let complete = true;
  for (const [position, raw] of (discounts ?? []).entries()) {
    const discount = objectOrString(raw);
    const source = objectOrString(discount.source);
    const couponRef = source.coupon ?? objectOrString(source.promotion_code).coupon ?? discount.coupon;
    const inlineCoupon = objectOrString(couponRef);
    const couponId = typeof couponRef === "string" ? couponRef : stringOrNull(inlineCoupon.id);
    const coupon = couponId && coupons.has(couponId)
      ? { ...inlineCoupon, ...coupons.get(couponId) }
      : inlineCoupon;
    const discountId = discount.id ?? stringOrNull(raw);
    const duration = stringOrNull(coupon.duration);
    const primaryAmountOff = nullableNumber(coupon.amount_off);
    const primaryCurrency = stringOrNull(coupon.currency)?.toLowerCase() ?? null;
    const amountOffCurrencyOptions: Record<string, number> = {};
    for (const [rawCurrency, rawOption] of Object.entries(objectOrString(coupon.currency_options))) {
      const optionAmount = nullableNumber(objectOrString(rawOption).amount_off);
      if (optionAmount !== null && optionAmount >= 0) {
        amountOffCurrencyOptions[rawCurrency.toLowerCase()] = optionAmount;
      }
    }
    const optionAmount = targetCurrency ? amountOffCurrencyOptions[targetCurrency] : undefined;
    const currencyOptionResolved = primaryAmountOff === null || (
      targetCurrency !== null && (
        (targetCurrency === primaryCurrency && primaryAmountOff >= 0) || optionAmount !== undefined
      )
    );
    const amountOff = optionAmount ?? primaryAmountOff;
    const amountCurrency = optionAmount !== undefined ? targetCurrency : primaryCurrency;
    const percentOff = nullableNumber(coupon.percent_off);
    const appliesTo = objectOrString(coupon.applies_to);
    const appliesToProductIds = Array.isArray(appliesTo.products)
      ? appliesTo.products.filter((product): product is string => typeof product === "string")
      : [];
    const productRestrictionComplete = appliesToProductIds.length === 0;
    const startsAt = unixNumberToIso(discount.start);
    const endsAt = unixNumberToIso(discount.end);
    const definitionComplete = Boolean(
      discountId &&
      startsAt &&
      (duration === "once" || duration === "forever" || duration === "repeating") &&
      (duration !== "repeating" || endsAt) &&
      ((amountOff !== null && amountOff >= 0 && percentOff === null) ||
        (amountOff === null && percentOff !== null && percentOff >= 0 && percentOff <= 100))
    );
    const rowComplete = definitionComplete && productRestrictionComplete && currencyOptionResolved;
    if (!rowComplete) complete = false;
    rows.push({
      discountId,
      couponId,
      position,
      amountOff,
      percentOff,
      currency: amountCurrency,
      appliesToProductIds,
      amountOffCurrencyOptions,
      currencyOptionResolved,
      duration,
      startsAt,
      endsAt,
      complete: rowComplete,
      incompleteReason: rowComplete
        ? null
        : !productRestrictionComplete
          ? "product_restricted_discount_unsupported"
          : !currencyOptionResolved
            ? "discount_currency_option_unresolved"
            : "missing_or_ambiguous_discount_definition"
    });
  }
  return { rows, complete };
}

async function stripeSubscriptionsWithCompleteItems(
  credential: StripeCredential,
  secretKey: string,
  subscriptions: StripeSubscriptionApi[],
  telemetry?: StripeRequestTelemetry
): Promise<StripeSubscriptionApi[]> {
  return Promise.all(subscriptions.map(async (subscription) => {
    // EMBEDDED ITEMS TRUNCATE. A subscription retrieved (or listed) with more than the inline
    // page of items reports `items.has_more` and silently omits the rest — a delta re-fetch that
    // trusted the embedded array would replace the complete child set with a partial one.
    if (subscription.items?.has_more !== true) return subscription;
    const items = await stripeList<StripeSubscriptionItemApi>(
      credential,
      secretKey,
      "/v1/subscription_items",
      {
        subscription: subscription.id,
        limit: "100",
        "expand[]": ["data.price", "data.price.currency_options", "data.discounts"]
      },
      telemetry
    );
    return { ...subscription, items: { data: items, has_more: false } };
  }));
}

async function stripeSubscriptionsWithConditionalPrices(
  credential: StripeCredential,
  secretKey: string,
  subscriptions: StripeSubscriptionApi[],
  telemetry?: StripeRequestTelemetry
): Promise<StripeSubscriptionApi[]> {
  const priceCache = new Map<string, Promise<Record<string, unknown>>>();
  const loadPrice = (priceId: string): Promise<Record<string, unknown>> => {
    const existing = priceCache.get(priceId);
    if (existing) return existing;
    const pending = stripeGet<Record<string, unknown>>(
      credential,
      secretKey,
      `/v1/prices/${encodeURIComponent(priceId)}`,
      { "expand[]": ["currency_options"] },
      telemetry
    );
    priceCache.set(priceId, pending);
    return pending;
  };

  return Promise.all(subscriptions.map(async (subscription) => {
    const targetCurrency = stringOrNull(subscription.currency)?.toLowerCase() ?? null;
    if (!targetCurrency) return subscription;
    const items = await Promise.all((subscription.items?.data ?? []).map(async (item) => {
      const price = objectOrString(item.price);
      const defaultCurrency = stringOrNull(price.currency)?.toLowerCase() ?? null;
      const priceId = price.id ?? stringOrNull(item.price);
      if (!priceId || !defaultCurrency || defaultCurrency === targetCurrency) return item;
      if (stripePriceCurrencyOptions(price.currency_options)[targetCurrency] !== undefined) return item;
      return { ...item, price: { ...price, ...await loadPrice(priceId) } };
    }));
    return { ...subscription, items: { ...subscription.items, data: items } };
  }));
}

async function stripeCouponsForSubscriptions(
  credential: StripeCredential,
  secretKey: string,
  subscriptions: StripeSubscriptionApi[],
  telemetry?: StripeRequestTelemetry
): Promise<Map<string, Record<string, unknown>>> {
  const couponIds = new Set<string>();
  for (const subscription of subscriptions) {
    const targetCurrency = stringOrNull(subscription.currency)?.toLowerCase() ?? null;
    for (const discount of [
      ...(subscription.discounts ?? []),
      ...(subscription.items?.data ?? []).flatMap((item) => item.discounts ?? [])
    ]) {
      const row = objectOrString(discount);
      const source = objectOrString(row.source);
      const couponRef = source.coupon ?? objectOrString(source.promotion_code).coupon ?? row.coupon;
      if (typeof couponRef === "string") couponIds.add(couponRef);
      else {
        const coupon = objectOrString(couponRef);
        const couponId = stringOrNull(coupon.id);
        const primaryCurrency = stringOrNull(coupon.currency)?.toLowerCase() ?? null;
        if (
          couponId && nullableNumber(coupon.amount_off) !== null && targetCurrency &&
          targetCurrency !== primaryCurrency &&
          nullableNumber(objectOrString(objectOrString(coupon.currency_options)[targetCurrency]).amount_off) === null
        ) couponIds.add(couponId);
      }
    }
  }
  const entries = await Promise.all(
    [...couponIds].map(async (couponId) => {
      const coupon = await stripeGet<Record<string, unknown>>(
        credential,
        secretKey,
        `/v1/coupons/${encodeURIComponent(couponId)}`,
        { "expand[]": ["currency_options"] },
        telemetry
      );
      return [couponId, coupon] as const;
    })
  );
  return new Map(entries);
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

// READ routing for the CLI transport. transport=meta_ads_cli exists because Meta ad WRITES
// require the `meta` CLI (direct Graph ad writes need an app-reviewed app) — but the CLI
// binary is HOST-LOCAL: the credential stores an absolute path (e.g.
// /Users/<user>/.local/bin/meta), while syncs execute on WHICHEVER worker claims the job from
// the shared DB. A worker without that binary (e.g. the dockerized growth-os worker, which has
// no /Users mount at all) failed the read with a non-retryable "meta ... was not found" typed
// provider_auth_failed, and recordSyncFailure flipped the HEALTHY source to status='error' —
// surfaced to the user as "Connection test failed — reconnect or revoke" on a perfectly valid
// system-user token (observed live 2026-07-05). When the credential carries its own
// accessToken, the CLI adds nothing for READS — callMetaAdsCliJson injects that same token as
// ACCESS_TOKEN anyway — so reads ride the PRIMARY direct-Graph transport (same token, same
// authorization, host-independent). CLI reads remain ONLY for ambient-auth credentials (no
// stored token — the CLI authenticates itself). WRITES are untouched: they stay on the CLI.
function metaAdsReadsViaCli(credential: MetaAdsCredential): boolean {
  return isMetaAdsCliTransport(credential) && !metaAdsCliAccessToken(credential);
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

// Meta date window — TWO regimes, keyed off whether an EXPLICIT backfill window was requested
// (request.windowSince/windowUntil), NOT off the plan cursor. This is GA4's #83 fix applied to
// its un-fixed twin (2026-07-11 zero-loop incident): defaultPlan sets cursorStart = windowSince
// ?? storedCursor, so a non-null cursorStart CANNOT distinguish a windowed backfill from a
// steady-state run that simply has a stored cursor — reading the cursor directly collapses the
// steady-state window to the inter-sync gap. Worse, the harness CLOSE step ratchets the cursor
// forward on EVERY succeeded run (monotonic greatest(), records or not), so one legitimately
// empty answer (e.g. an early-UTC [today..today] window on a US-timezone account) degenerated
// every later window to a span Meta answers empty — a self-sustaining succeeded/0-record loop
// with a perpetually-fresh last_synced_at, observed live on the founder's store 07-10→07-11.
//   • Windowed backfill (request.windowSince/windowUntil set by an orchestrator): honor the
//     bounded [since, until] span verbatim so each run persists+advances the cursor.
//   • Steady-state incremental (no window — the desktop scheduler + sync_source_now): re-pull
//     the ROLLING [daysAgo(refreshWindowDays), today] reconcile window, deliberately IGNORING
//     the stored cursor. Meta restates attribution for days after first capture (7d_click lands
//     late), truth writes are idempotent upserts keyed on (account, entity, day), and the ad
//     pass already chunks any window wider than one calendar slice — so the re-pull reconciles,
//     never duplicates, and an empty answer can no longer shrink the next run's window.
function metaAdsTimeOptions(request: SyncRequest, plan: SyncPlan): {
  datePreset?: string;
  timeRange?: { since: string; until: string };
} {
  if (plan.backfillWindow === "all_time") {
    return { datePreset: "maximum" };
  }
  if (request.windowSince || request.windowUntil) {
    return {
      timeRange: {
        since: cursorStartIso(plan).slice(0, 10),
        until: plan.cursorEnd.slice(0, 10)
      }
    };
  }
  return {
    timeRange: {
      since: daysAgo(plan.refreshWindowDays),
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

// A `meta` CLI --output json WRITE body is not always the bare Graph node object the
// direct-Graph transport returns. Observed shapes: a bare object `{id,status}`, a single-
// element ARRAY `[{id,status}]` (the real CLI create shape), and a `{data:{…}}`/`{data:[…]}`
// envelope. This union lets the write helpers accept any of them; `firstMetaGraphWriteResponse`
// normalizes to the entity node before id/status extraction.
type MetaGraphWritePayload = MetaGraphWriteResponse | MetaGraphWriteResponse[];

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
  // A downloadable video URL. Used by the meta_ads_cli transport, whose standard
  // creative create --video flag needs a local video FILE. Mutually exclusive
  // with imageUrl on the CLI path; direct Graph STANDARD creatives remain image_hash-only.
  videoUrl?: string;
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

// Budget writes are restricted to the campaign (CBO) and ad-set levels — Meta has
// no ad-level budget — so this is a NARROWER entity union than MetaWriteEntity.
export type MetaBudgetEntity = "campaign" | "adset";

export interface MetaBudgetResult {
  ok: boolean;
  id: string;
  // The entity kind whose budget was changed (campaign|adset). The raw amount is
  // DELIBERATELY not echoed — a budget figure must never flow back into logs/audit.
  entity: MetaBudgetEntity;
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
// Normalize a CLI/Graph WRITE payload to the single entity node, whatever wrapper it arrived in:
//   {id,status}            → itself
//   [{id,status}, …]       → the first element (the real `meta` CLI create shape)
//   {data:{…}} / {data:[…]}→ the wrapped entity (only when the top object has no id of its own)
// Both id extraction (requireGraphId) AND the create-never-ACTIVE money-safety guard read through
// this, so an array/enveloped ACTIVE echo can no longer slip past the guard the way a bare
// `response.status` read did (it returned undefined on an array → guard saw null → no catch).
function firstMetaGraphWriteResponse(response: MetaGraphWritePayload): MetaGraphWriteResponse {
  const top = Array.isArray(response) ? response[0] : response;
  if (top === null || typeof top !== "object" || Array.isArray(top)) {
    return {};
  }
  const record = top as MetaGraphWriteResponse;
  if (typeof record.id === "string" && record.id.trim() !== "") {
    return record;
  }
  const data = record.data;
  if (Array.isArray(data)) {
    const first = data.find((item) => item !== null && typeof item === "object" && !Array.isArray(item));
    return (first as MetaGraphWriteResponse | undefined) ?? record;
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as MetaGraphWriteResponse;
  }
  return record;
}

function metaEchoedStatus(response: MetaGraphWritePayload): MetaEntityStatus | null {
  const item = firstMetaGraphWriteResponse(response);
  const raw = item.status ?? item.effective_status;
  if (typeof raw !== "string") {
    return null;
  }
  const upper = raw.toUpperCase();
  return upper === "ACTIVE" ? "ACTIVE" : upper === "PAUSED" ? "PAUSED" : null;
}

// INVARIANT 1: after any create, the entity must NOT be ACTIVE. If Graph ever
// echoes ACTIVE we throw a non-retryable money-safety error so the handler can
// audit-log a violation. Returns the (PAUSED-or-null) status to surface upward.
function assertCreateNotActive(entity: MetaWriteEntity, id: string, response: MetaGraphWritePayload): MetaEntityStatus | null {
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

function requireGraphId(entity: MetaWriteEntity, response: MetaGraphWritePayload): string {
  const id = firstMetaGraphWriteResponse(response).id;
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

// A budget UPDATE requires a strictly-POSITIVE integer-cents amount. Unlike a create
// (where an omitted budget is valid and `metaCents` tolerates 0), setting an existing
// entity's daily budget to 0 / negative / a fraction is never a valid spend
// instruction — reject it non-retryably BEFORE any Graph POST (money-safety).
function metaPositiveBudgetCents(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConnectorError(
      "provider_api_error",
      "Meta Ads budget update requires a positive integer number of cents",
      false
    );
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

// ── Create: Ad Creative (STANDARD single-media only) ──────────────────────────
// Direct Graph POST /act_{id}/adcreatives remains image_hash-backed link_data OR
// photo_data only. The meta_ads_cli transport supports standard single-image or
// single-video file upload via --image/--video. No child_attachments /
// asset_feed_spec / DCO flags here (carousel/DCO are deferred to PR #4+).
// NOTE: creatives have no go-live status; nothing to PAUSE-guard here.
export async function createMetaCreative(
  credential: MetaAdsCredential,
  input: MetaCreativeCreateInput
): Promise<MetaWriteResult> {
  if (input.imageUrl && input.videoUrl) {
    throw new ConnectorError(
      "provider_api_error",
      "Meta Ads STANDARD creative accepts either imageUrl or videoUrl, not both",
      false
    );
  }
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

// ── Budget update (scale / reduce / reallocate) ── POST /{entity_id} ──────────
// Change the daily budget of an EXISTING campaign or ad set. Like the status
// transition this is a NODE call (POST /{id}, NOT an act_ edge) on the SAME
// non-retryable write transport (INVARIANT 3: a budget write is never auto-retried).
// MONEY-SAFETY: the POST carries daily_budget ONLY — never a `status` field — so a
// budget change can never flip delivery state (an active entity keeps running at the
// new budget; a paused one stays paused). `entity` is the WIDE MetaWriteEntity so the
// campaign|adset restriction is a live runtime guard (Meta has no ad-level budget).
// Only the direct-Graph (marketing_api) transport is supported; a CLI/MCP credential
// is refused loudly + non-retryably by `metaAdsGraphWrite`, exactly like other writes.
export async function updateMetaBudget(
  credential: MetaAdsCredential,
  entityId: string,
  dailyBudget: number,
  entity: MetaWriteEntity
): Promise<MetaBudgetResult> {
  if (entity !== "campaign" && entity !== "adset") {
    // "ad"/"creative": Meta has NO ad-level (or creative-level) budget. Reject
    // BEFORE the POST so a wrong target never reaches the Graph transport.
    throw new ConnectorError(
      "provider_api_error",
      `Meta Ads budget update supports only campaign or adset (got "${entity}"); ads have no budget`,
      false
    );
  }
  const cents = metaPositiveBudgetCents(dailyBudget);
  if (isMetaAdsCliTransport(credential)) {
    // CLI transport (system-user token, no app-reviewed direct-Graph write app): route the budget
    // change through the bundled `meta` CLI, exactly like create/status/delete. Without this branch a
    // CLI-transport source falls through to metaAdsGraphWrite below and is refused provider_unsupported
    // (the shipped gap: update_meta_budget could not run on the only Meta write transport we bundle).
    return updateMetaBudgetViaCli(credential, entity, entityId, cents);
  }
  await metaAdsGraphPost(credential, entityId, { daily_budget: cents });
  // Graph returns { success: true } for a node budget POST. A non-2xx already threw a
  // non-retryable ConnectorError above; reaching here means Graph accepted the change.
  return { ok: true, id: entityId, entity };
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

// ── Live insights read (run_meta_live_insights) ───────────────────────────────
// A READ-ONLY, whole-window AGGREGATE insights fetch for the live ⌘L answer path — the engine
// action's transport. A THIN ADAPTER over the sync read machinery, reusing it verbatim (founder
// requirement, 2026-07-11): the SAME three-way transport selection as testLive/extractLive
// (MCP → ambient-auth CLI via metaAdsCliInsights → direct Graph, chosen by isMetaAdsMcpTransport
// / metaAdsReadsViaCli exactly as PR #74 shipped), the SAME request builders/pagers
// (metaAdsMcpInsights, metaAdsCliInsights, metaAdsInsightsUrl + metaAdsFetchInsightsPages), the
// SAME field lists (metaAdsInsightsFieldsForLevel) and attribution windows, and the SAME
// canonical conversion mapping (metaAdsConversionRows — ONE canonical action_type, never a sum
// of variants; headline = 7d_click + 1d_view; value purchase-only). No new Graph client, no new
// query/pagination code, no transport rules of its own.
//
// Deliberate differences from the sync extract (the adapter part):
//   * NO time_increment — one aggregate row per entity over the whole window, not per-day rows.
//     That keeps even level=ad requests light (rows ≈ entity count), so the direct-Graph branch
//     is a SINGLE paginated request, never the month/week chunk loop. If a huge account+window
//     still trips Meta's 1487534 volume error it surfaces as the normal retryable
//     provider_api_error and the caller narrows the window — honest failure over truncation.
//   * The ambient-CLI read is CAMPAIGN-level only, exactly as shipped (extractLive's CLI branch
//     carries no level flag — "campaign grain only this slice"). A finer-grain request on an
//     ambient credential fails typed instead of silently degrading; a meta_ads_cli credential
//     that STORES its token rides direct Graph (metaAdsReadsViaCli), where every level works.
export interface MetaLiveInsightsRow {
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  adId: string | null;
  adName: string | null;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  linkClicks: number | null;
  reach: number | null;
  frequency: number | null;
  cpm: number | null;
  cpc: number | null;
  ctr: number | null;
  /** Canonical result label ('lead' | 'purchase' | …) from the objective mapping; null when unmapped. */
  resultType: string | null;
  results: number | null;
  /** Purchase-only conversion value from the SAME canonical action_type; null otherwise. */
  conversionValue: number | null;
  /** conversionValue / spend when both exist and spend > 0 — matches the warehouse ROAS definition. */
  roas: number | null;
  costPerResult: number | null;
  currency: string | null;
}

export async function fetchMetaLiveInsights(
  credential: MetaAdsCredential,
  options: {
    level: "campaign" | "adset" | "ad";
    datePreset?: string;
    timeRange?: { since: string; until: string };
    /** Max rows RETURNED (after spend-desc sort); fetch itself is uncapped within the page guard. */
    limit: number;
  }
): Promise<{ rows: MetaLiveInsightsRow[]; totalRows: number; truncated: boolean }> {
  // Window options in the exact shape every transport builder already takes; no timeIncrement
  // anywhere → whole-window aggregate (see the header note).
  const windowOptions = options.timeRange
    ? { timeRange: options.timeRange }
    : { datePreset: options.datePreset ?? "last_30d" };
  const fields = metaAdsInsightsFieldsForLevel(options.level);
  const raw: MetaAdsInsightsRow[] = [];

  // The SAME three-way transport selection as testLive/extractLive — reused, not reimplemented.
  if (isMetaAdsMcpTransport(credential)) {
    const adAccountId = metaAdsAccountId(credential);
    let after: string | undefined;
    let exhausted = true;
    for (let page = 0; page < 100; page += 1) {
      const response = await metaAdsMcpInsights(credential, {
        adAccountId,
        fields,
        level: options.level,
        limit: "100",
        attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
        ...windowOptions,
        after
      });
      raw.push(...(response.data ?? []));
      const nextAfter = metaAdsPagingAfter(response);
      if (!nextAfter) {
        exhausted = false;
        break;
      }
      after = nextAfter;
    }
    if (exhausted) {
      throw new ConnectorError("provider_api_error", "Meta Ads MCP pagination exceeded the page limit", true);
    }
  } else if (metaAdsReadsViaCli(credential)) {
    // Ambient-auth CLI credential (no stored token) — only the local CLI can authenticate.
    // The shipped CLI read carries no level flag (campaign grain only this slice), so a
    // finer-grain request fails typed rather than silently answering at the wrong grain.
    if (options.level !== "campaign") {
      throw new ConnectorError(
        "provider_api_error",
        `meta_live_level_unavailable: the ambient-auth meta CLI read is campaign-level only; requested level=${options.level}. Use level=campaign, or store the marketing_api access token on the credential (reads then ride direct Graph, where every level works).`,
        false
      );
    }
    const response = await metaAdsCliInsights(credential, {
      fields,
      limit: "100",
      attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
      ...windowOptions
    });
    raw.push(...(response.data ?? []));
  } else {
    // Primary direct Graph. Also taken by transport=meta_ads_cli credentials that store their
    // own accessToken (metaAdsReadsViaCli) — PR #74's read rule, unchanged.
    const accessToken = requireCredential(credential, "accessToken");
    const adAccountId = metaAdsAccountId(credential);
    const url = metaAdsInsightsUrl(credential, {
      adAccountId,
      fields,
      level: options.level,
      limit: "500",
      attributionWindows: META_ADS_ATTRIBUTION_WINDOWS,
      ...windowOptions
    });
    await metaAdsFetchInsightsPages(accessToken, url, (row) => raw.push(row));
  }
  const context: MetaAdsInsightsContext = {
    apiVersion: metaAdsApiVersion(credential),
    attributionSetting: META_ADS_ATTRIBUTION_SETTING
  };
  const mapped = raw.map((row): MetaLiveInsightsRow => {
    const conversion = metaAdsConversionRows(row, context)[0] ?? null;
    const spend = numberOrNull(row.spend) ?? 0;
    const conversionValue = conversion?.conversionValue ?? null;
    const results = conversion?.results ?? null;
    return {
      campaignId: stringOrNull(row.campaign_id),
      campaignName: stringOrNull(row.campaign_name),
      adsetId: stringOrNull(row.adset_id),
      adsetName: stringOrNull(row.adset_name),
      adId: stringOrNull(row.ad_id),
      adName: stringOrNull(row.ad_name),
      spend,
      impressions: numberOrNull(row.impressions),
      clicks: numberOrNull(row.clicks),
      linkClicks: numberOrNull(row.inline_link_clicks),
      reach: numberOrNull(row.reach),
      frequency: numberOrNull(row.frequency),
      cpm: numberOrNull(row.cpm),
      cpc: numberOrNull(row.cpc),
      ctr: numberOrNull(row.ctr),
      resultType: conversion?.resultType ?? null,
      results,
      conversionValue,
      roas: conversionValue !== null && spend > 0 ? conversionValue / spend : null,
      costPerResult: results !== null && results > 0 ? spend / results : null,
      currency: stringOrNull(row.account_currency)
    };
  });
  mapped.sort((a, b) => b.spend - a.spend);
  const rows = mapped.slice(0, options.limit);
  return { rows, totalRows: mapped.length, truncated: mapped.length > rows.length };
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
function ensureExecutableOnPath(
  executable: string,
  label: string,
  installHint = "Install Meta's Ads CLI: pip install meta-ads"
): void {
  const message = `${label}: "${executable}" was not found. ${installHint}`;
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

// The daemon can be spawned with a cwd that is later removed (e.g. a temp build dir). Node's
// `spawn` throws if the child's cwd no longer exists, so pin the Meta CLI to a stable, existing
// directory instead of inheriting the daemon's (possibly-gone) cwd.
function stableMetaCliCwd(): string {
  const candidates = [process.env.GROWTH_OS_HOME, process.env.HOME, tmpdir()];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "/";
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
  // --no-color / --no-input are global `meta` options (they precede the subcommand). They keep the
  // CLI non-interactive (a prompt would otherwise hang until the timeout) and strip ANSI colour so
  // banners/escape codes can never contaminate the --output json body the parser reads.
  const child = spawn(executable, [...commandArgs, "--no-color", "--no-input", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    cwd: stableMetaCliCwd(),
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
          // Some `meta` CLI writes (delete, and budget/status updates) exit 0 with EMPTY stdout —
          // there is no JSON body to parse. Treat a clean empty exit as a success envelope rather
          // than throwing "invalid JSON"; those callers derive their result from the passed id, not
          // the body. (This was a shipped bug: an empty-stdout delete surfaced as provider_api_error.)
          if (stdoutBuffer.trim() === "") {
            resolve({ success: true });
            return;
          }
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
            // Jump past this whole block so its NESTED objects aren't reconsidered as later
            // (higher-`start`) candidates. Without this, pretty-printed / multi-line JSON (a CLI
            // that emits json.dumps(indent=2)) makes the innermost object (`data.user`) the last
            // valid block found — so the outer `{ok,data,…}` envelope is lost and callers see
            // `payload.ok === undefined` → "unrecognized JSON shape".
            start = i;
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
async function metaAdsCliWrite(credential: MetaAdsCredential, args: string[]): Promise<MetaGraphWritePayload> {
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
  return raw as MetaGraphWritePayload;
}

// Push an optional integer-cents flag (validated by metaCents) onto a CLI argv.
function pushCentsFlag(args: string[], flag: string, value: number | undefined): void {
  const cents = metaCents(value);
  if (cents !== undefined) {
    args.push(flag, String(cents));
  }
}

// ── CLI Budget update ── meta ads campaign|adset update <ID> --daily-budget … ──
// Mirrors updateMetaBudget's direct-Graph path for the CLI transport. Sends --daily-budget ONLY —
// never --status — so a budget change can never flip delivery state (an active entity keeps running
// at the new budget; a paused one stays paused). Rides metaAdsCliWrite, so it is non-retryable
// (INVARIANT 3) and its empty success body is accepted rather than misread as invalid JSON.
async function updateMetaBudgetViaCli(
  credential: MetaAdsCredential,
  entity: "campaign" | "adset",
  entityId: string,
  dailyBudgetCents: number
): Promise<MetaBudgetResult> {
  const args = [
    "--output",
    "json",
    "ads",
    "--ad-account-id",
    metaAdsCliAccountId(credential),
    entity,
    "update"
  ];
  pushCentsFlag(args, "--daily-budget", dailyBudgetCents);
  args.push("--", entityId);
  await metaAdsCliWrite(credential, args);
  return { ok: true, id: entityId, entity };
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
// Creatives have no go-live status; nothing to PAUSE-guard. The CLI's standard
// `--image` / `--video` flags need a local media FILE (the CLI uploads it itself),
// NOT a pre-uploaded Graph image_hash. So this builder requires exactly one URL:
// `imageUrl` downloads to `--image <tempfile>` and `videoUrl` downloads to
// `--video <tempfile>`. It never uses the DCO `--images` / `--videos` flags.
// If ONLY an imageHash is supplied (no URL), there is no file to hand the CLI and
// a hash can't become a file → fail loud, non-retryable (review BLOCKER).
async function createMetaCreativeViaCli(
  credential: MetaAdsCredential,
  input: MetaCreativeCreateInput
): Promise<MetaWriteResult> {
  if (!input.imageUrl && !input.videoUrl) {
    // A hash can't become a file. Surface a clear, non-retryable error rather than
    // passing a hash as a bogus --image/--video path (which the CLI rejects as missing file).
    throw new ConnectorError(
      "provider_unsupported",
      "Meta creative creation via the `meta` CLI requires an imageUrl or videoUrl: the CLI's standard " +
        "--image/--video flags expect a media FILE path, but only a pre-uploaded image_hash was supplied. Provide imageUrl/videoUrl, or use " +
        "the direct-Graph transport for creatives.",
      false
    );
  }
  // FIX 3 parity: normalize+validate the CTA enum BEFORE it reaches the CLI, and gate
  // it against the CLI's narrower Click choice set (review HIGH).
  const callToAction = metaEnum(input.callToAction, META_CALL_TO_ACTION_VALUES, "call to action");
  assertMetaCliEnum(callToAction, META_CLI_CALL_TO_ACTION_VALUES, "call to action");

  const mediaKind = input.videoUrl ? "video" : "image";
  const tempPath = await downloadCreativeMediaToTempFile(input.videoUrl ?? input.imageUrl!, input.name, mediaKind);
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
      mediaKind === "video" ? "--video" : "--image",
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

// Download a creative media URL to a uniquely-named temp file under os.tmpdir()
// and return the path. Used by createMetaCreativeViaCli to satisfy the CLI's
// standard `--image FILE` / `--video FILE` flags.
// Throws a NON-retryable ConnectorError on a non-2xx response or a fetch failure so
// a money-adjacent creative create never silently proceeds with a missing/bad file.
let metaCreativeTempCounter = 0;
const META_CREATIVE_MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;
const META_CREATIVE_MEDIA_MAX_BYTES = 500 * 1024 * 1024;

type MetaCreativeMediaKind = "image" | "video";

// The `meta` CLI validates --image/--video by FILE EXTENSION (_validate_media_path);
// an extensionless temp file fails immediately with "Unsupported format ''". So the
// temp file MUST carry an allowed extension. Derive it from the HTTP Content-Type,
// else the URL path, else default to an allowed extension for that media type.
const META_CLI_IMAGE_EXTS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const META_CLI_VIDEO_EXTS = new Set([".avi", ".mkv", ".mov", ".mp4", ".wmv"]);
const META_CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "application/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/x-matroska": ".mkv",
  "video/x-ms-wmv": ".wmv",
  "video/x-ms-asf": ".wmv"
};
function metaCreativeMediaExt(contentType: string | null, url: string, kind: MetaCreativeMediaKind): string {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const contentTypeExt = META_CONTENT_TYPE_EXT[ct];
  const allowedExts = kind === "video" ? META_CLI_VIDEO_EXTS : META_CLI_IMAGE_EXTS;
  if (contentTypeExt && allowedExts.has(contentTypeExt)) return contentTypeExt;
  // URL path extension fallback (strip query/fragment first).
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  if (dot !== -1) {
    const ext = path.slice(dot).toLowerCase();
    if (allowedExts.has(ext)) return ext;
  }
  // Last-resort default — an allowed extension so the CLI never rejects on format.
  return kind === "video" ? ".mp4" : ".jpg";
}

async function downloadCreativeMediaToTempFile(
  url: string,
  label: string,
  kind: MetaCreativeMediaKind
): Promise<string> {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "creative";
  let response: Response;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), META_CREATIVE_MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    response = await fetch(url, { signal: abortController.signal });
  } catch (error) {
    clearTimeout(timeout);
    throw new ConnectorError(
      "provider_api_error",
      `Meta creative ${kind} download failed: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  clearTimeout(timeout);
  if (!response.ok) {
    throw new ConnectorError(
      "provider_api_error",
      `Meta creative ${kind} download failed: ${response.status} ${safeUrlForLogs(url)}`,
      false
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > META_CREATIVE_MEDIA_MAX_BYTES) {
    throw new ConnectorError(
      "provider_api_error",
      `Meta creative ${kind} download is too large: ${Math.ceil(contentLength / 1024 / 1024)}MB`,
      false
    );
  }
  // Extension MUST be derived AFTER the fetch (Content-Type wins) — the CLI rejects an extensionless file.
  const ext = metaCreativeMediaExt(response.headers.get("content-type"), url, kind);
  const tempPath = join(tmpdir(), `meta-creative-${slug}-${Date.now()}-${metaCreativeTempCounter++}${ext}`);
  await writeResponseBodyToTempFile(response, tempPath, kind);
  return tempPath;
}

async function writeResponseBodyToTempFile(
  response: Response,
  tempPath: string,
  kind: MetaCreativeMediaKind
): Promise<void> {
  const body = response.body;
  if (!body) {
    writeFileSync(tempPath, Buffer.alloc(0), { flag: "wx" });
    return;
  }
  const writer = createWriteStream(tempPath, { flags: "wx" });
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > META_CREATIVE_MEDIA_MAX_BYTES) {
        throw new ConnectorError(
          "provider_api_error",
          `Meta creative ${kind} download exceeded ${Math.ceil(META_CREATIVE_MEDIA_MAX_BYTES / 1024 / 1024)}MB`,
          false
        );
      }
      if (!writer.write(Buffer.from(value))) {
        await once(writer, "drain");
      }
    }
    await new Promise<void>((resolve, reject) => writer.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    writer.destroy();
    unlinkSync(tempPath);
    throw error;
  } finally {
    reader.releaseLock();
  }
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

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  // Response OBSERVER for telemetry only (status + headers, e.g. Stripe-Rate-Limited-Reason).
  // It runs before the status checks so a throwing path is still counted, and it must never
  // influence the outcome — a counter bug is not a reason to fail a customer's sync.
  observe?: (meta: { status: number; headers: Headers }) => void
): Promise<T> {
  const safeUrl = safeUrlForLogs(url);
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (observe) {
    try {
      observe({ status: response.status, headers: response.headers });
    } catch {
      // Telemetry loss is acceptable; losing the provider response is not.
    }
  }
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
      true,
      undefined,
      response.status
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
    public readonly entityId?: string,
    // Optional: the provider HTTP status, so a caller can CLASSIFY a failure instead of parsing the
    // message. Today only the Stripe delta lane uses it — a 404 on an object a `*.deleted` event
    // named in the same window is an OBSERVED DELETION, not an outage.
    public readonly status?: number
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
  // Typed errors raised outside this module (e.g. stripe-mrr-movements' close-claim guard) cannot
  // extend ConnectorError without a circular import; the {code, retryable} shape IS the contract.
  if (error instanceof Error) {
    const typed = error as Error & { code?: unknown; retryable?: unknown };
    if (typeof typed.code === "string" && typeof typed.retryable === "boolean") {
      return { code: typed.code, message: typed.message, retryable: typed.retryable };
    }
  }
  return {
    code: "provider_api_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true
  };
}

// How many COUNTED transient sync failures a source absorbs before it escalates to the terminal
// `error` status. With the 45-min time gate below, 3 means three INDEPENDENT failure episodes at
// least 45 min apart — so a source parks no sooner than ~90 min into a genuinely sustained outage,
// while a truly dead network path still surfaces the same day.
const TRANSIENT_SYNC_FAILURE_ESCALATION_THRESHOLD = 3;

// Minimum spacing between COUNTED transient failures (migration 0045). Failures closer together
// than this are the SAME failure episode, not independent evidence the path is dead, and must not
// each burn a strike. Two sources cluster failures:
//   1) a job runner's own in-run retries (seconds apart within one scheduled run), and
//   2) the desktop scheduler, which retries an OVERDUE source every 15-min tick — so a machine that
//      is simply awake-but-offline for a morning fires a failure roughly every 15 min.
// At 10 min the gate covered (1) but NOT (2): ~30 min awake-and-offline = 3 ticks = 3 strikes = a
// healthy credential parked. 45 min sits above the 15-min overdue-retry cadence, so an
// awake-but-offline stretch counts at most one strike per 45 min (≥90 min sustained before a park),
// while three genuinely separate episodes across a day still escalate.
const TRANSIENT_FAILURE_STREAK_MIN_SPACING_MS = 45 * 60 * 1000;

// Error codes whose failures are credential-grade regardless of any retryable flag: retrying
// with the same stored credential can never succeed, so the source must park as `error`
// immediately (the PR #64 credential_undecryptable contract — do not regress it).
const TERMINAL_SYNC_ERROR_CODES = new Set(["provider_auth_failed", "credential_undecryptable"]);

// Meta Graph ships credential-grade OAuth rejections as HTTP **400** (not 401/403): body
// `{"error":{"type":"OAuthException","code":190|102|200,...}}` — code 190 = invalid/expired
// token, 102 = dead session, 200 = missing permission. The HTTP-status taxonomy types a 400 as
// retryable provider_api_error, so without this body sniff a revoked Meta token would take the
// full transient threshold to park. BOTH signatures must match (type AND one of the specific
// codes): Meta also labels its TRANSIENT throttles (#4/#17/#32) "OAuthException", so matching
// the bare type string would re-create exactly the blip-parks-a-healthy-source bug this
// classifier exists to fix. responseSafeDetail embeds the (redacted) raw body in the message,
// so the JSON keys appear verbatim.
const META_OAUTH_TERMINAL_BODY = /"code"\s*:\s*(190|102|200)\b/;

// Classify a sync failure for STATUS ESCALATION (not for run bookkeeping — sync_runs/sync_errors
// record every failure identically). "terminal" = retrying with the stored credential can never
// help (auth/permission rejection, undecryptable credential, any deliberately non-retryable typed
// error) → park the source as `error` immediately. "transient" = the failure is environmental
// (network/transport: undici "fetch failed", ECONNREFUSED/ETIMEDOUT/ENOTFOUND/EAI_AGAIN, socket
// hang up, aborted — all untyped, so providerError types them retryable provider_api_error — plus
// provider 5xx and 429/provider_rate_limited) → the source only escalates after
// TRANSIENT_SYNC_FAILURE_ESCALATION_THRESHOLD consecutive failures. The `retryable` flag is the
// engine's own deliberate taxonomy (fetchJson + the Meta throttle-aware fetch both type 401/403
// non-retryable auth, 429 retryable rate-limit, other non-2xx retryable api error), so it is the
// primary signal here; the Meta body sniff covers the one place Meta hides an auth rejection
// inside a retryable-shaped 400.
export function classifySyncFailure(error: {
  code: string;
  message: string;
  retryable: boolean;
}): "terminal" | "transient" {
  if (TERMINAL_SYNC_ERROR_CODES.has(error.code)) {
    return "terminal";
  }
  if (!error.retryable) {
    return "terminal";
  }
  if (error.message.includes("OAuthException") && META_OAUTH_TERMINAL_BODY.test(error.message)) {
    return "terminal";
  }
  return "transient";
}

// Classify an ARBITRARY thrown connector error (a ConnectorError, a CredentialDecryptError, or a
// raw network throw) into the same terminal/transient taxonomy the sync-failure escalation uses.
// Lets non-sync surfaces — specifically the connect/reconnect connection test — apply the SAME
// "don't park on a transient blip" rule without re-deriving providerError's mapping.
export function classifyConnectorError(error: unknown): "terminal" | "transient" {
  return classifySyncFailure(providerError(error));
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

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : numberOrNull(value);
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

function optionalNonEmptyString(value: unknown): string | undefined {
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

function unixNumberToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? unixToIso(value) : null;
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
  // GA4 returns the property's reporting metadata alongside the rows; timeZone is the calendar
  // every `date` dimension value is local to (persisted at CLOSE — see ga4CloseSuccess).
  metadata?: { timeZone?: string; currencyCode?: string };
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

// `parent` and `subscription` are `| null` on purpose: origin classification reads KEY
// PRESENCE, not truthiness. A modern standalone invoice sends `parent: null`; a
// pre-2025-03-31 API version omits `parent` entirely and sends `subscription: null`. No
// Stripe-Version header is pinned anywhere in this connector (deliberately — pinning is a
// blast-radius risk), so both shapes are live simultaneously.
interface StripeInvoiceApi {
  id: string;
  customer?: string | Record<string, unknown> | null;
  subscription?: string | Record<string, unknown> | null;
  parent?: {
    type?: string;
    subscription_details?: { subscription?: string | Record<string, unknown> };
  } | null;
  status?: string;
  currency?: string;
  amount_paid?: number;
  amount_due?: number;
  post_payment_credit_notes_amount?: number | null;
  pre_payment_credit_notes_amount?: number | null;
  created: number;
  metadata?: Record<string, string>;
  status_transitions?: { paid_at?: number };
  lines?: { data?: StripeInvoiceLineApi[]; has_more?: boolean };
}

interface StripeInvoicePaidEventApi {
  id: string;
  type: string;
  created: number;
  data?: { object?: string | { id?: string } };
}

interface StripeSubscriptionEventApi {
  id: string;
  type: string;
  created: number;
  api_version?: string | null;
  livemode?: boolean | null;
  data?: {
    object?: string | Record<string, unknown>;
    previous_attributes?: Record<string, unknown> | null;
  };
}

interface StripeSubscriptionApi {
  id: string;
  livemode?: boolean | null;
  customer?: string | Record<string, unknown>;
  status?: string;
  currency?: string;
  created: number;
  current_period_start?: number;
  current_period_end?: number;
  trial_start?: number | null;
  trial_end?: number | null;
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  discounts?: Array<string | StripeDiscountApi>;
  items?: { data?: StripeSubscriptionItemApi[]; has_more?: boolean };
}

interface StripeSubscriptionItemApi {
  id: string;
  quantity?: number;
  price?: string | Record<string, unknown>;
  discounts?: Array<string | StripeDiscountApi>;
}

interface StripeDiscountApi {
  id: string;
  start?: number | null;
  end?: number | null;
  source?: string | Record<string, unknown>;
  coupon?: string | Record<string, unknown>;
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

const GA4_EVENT_ROWS: Ga4EventRow[] = [
  {
    kind: "event",
    externalId: "ga4-event-download",
    reportingDate: "2026-06-01",
    hostName: "rtk.dev",
    eventName: "download_click",
    eventCount: 22,
    keyEvents: 12
  },
  {
    kind: "event",
    externalId: "ga4-event-purchase",
    reportingDate: "2026-06-01",
    hostName: "rtk.dev",
    eventName: "purchase",
    eventCount: 4,
    keyEvents: 4
  }
];

// Fixture mode feeds a mixed array (overview + page + event) through toExtractedRecord, which
// classifies each by its `kind` tag.
const GA4_ROWS: Ga4SyncRow[] = [...GA4_OVERVIEW_ROWS, ...GA4_PAGE_ROWS, ...GA4_EVENT_ROWS];

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
    kind: "invoice",
    externalId: "stripe-inv-1",
    invoiceId: "in_001",
    customerId: "cus_001",
    customerEmail: "founder@example.com",
    customerName: "Founder Example",
    customerMetricsClassification: null,
    // The fixture models a fully-expanded live payload, so its metadata is authoritative.
    customerMetadataAuthoritative: true,
    subscriptionId: "sub_001",
    subscriptionOrigin: "subscription",
    status: "paid",
    currency: "usd",
    amountPaid: 4900,
    amountDue: 0,
    postPaymentCreditedMinor: null,
    prePaymentCreditedMinor: null,
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
