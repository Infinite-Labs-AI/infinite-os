import { createHash, randomUUID } from "node:crypto";
import { decryptCredentialPayload, encryptCredentialPayload, isEncryptedCredentialPayload } from "@infinite-os/core";
import {
  classifyConnectorError,
  connectorFor,
  createMetaAd,
  createMetaAdSet,
  createMetaCampaign,
  createMetaCreative,
  deleteMetaEntity,
  fetchMetaLiveInsights,
  getMetaEntity,
  listMetaAssets,
  listMetaEntities,
  resolveMetaAdsCredential,
  setMetaEntityStatus,
  updateMetaBudget,
  type ConnectionTestResult,
  type MetaAdsCredential,
  type MetaEntityStatus,
  type MetaWriteEntity,
  type MetaWriteResult
} from "@infinite-os/connectors";
import {
  describeContextCard,
  searchContextCards,
  seedContextCards
} from "@infinite-os/metadata";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ActionEnvelope,
  type ActionHandler,
  type Authority,
  type FirstPhaseProvider,
  FIRST_PHASE_METRICS,
  FIRST_PHASE_PROVIDERS,
  FIRST_PHASE_QUERYABLE_VIEWS,
  type InfiniteOsActionId,
  type JourneyQueryPlan,
  type PolicyRef,
  type SessionContext,
  createEnvelope,
  createInfiniteOsRegistry
} from "@infinite-os/runtime";
import { type InfiniteOsDb, createInfiniteOsDb } from "@infinite-os/db";

export const analyticalBoot = true;

const QUERYABLE_VIEW_SET = new Set<string>(FIRST_PHASE_QUERYABLE_VIEWS);
const METRIC_SET = new Set<string>(FIRST_PHASE_METRICS);

// Providers whose warehouse views are empty until the first sync runs, so connecting
// (or reconnecting) auto-queues an initial incremental sync at the shared choke point.
const AUTO_SYNC_ON_CONNECT = new Set<string>(["x"]);

type JourneyProvider = "meta_ads" | "x";

type CompiledJourneyKind = "meta_campaign" | "x_content" | "channel_comparison";

type CompiledJourney = {
  kind: CompiledJourneyKind;
  metric: string;
  entityType: string;
  provenance: string[];
  caveats: string[];
};

type JourneySourceRow = {
  id: unknown;
  provider: unknown;
  status: unknown;
  last_synced_at?: unknown;
  lastSyncedAt?: unknown;
};

type JourneyPlanEntityType = NonNullable<JourneyQueryPlan["entity"]>["type"];

export function createAnalyticalRegistry(databaseUrl: string) {
  const db = createInfiniteOsDb(databaseUrl);
  return createInfiniteOsRegistry(createActionHandlers(db));
}

// `options.encryptionKey` is the per-workspace credential-custody key (structurally the
// `CreateActionHandlersOptions` shape canonicalized in @infinite-os/types; kept inline here so
// this package need not depend on that leaf). When set, the connect/reconnect/sync/test paths
// encrypt+decrypt under it instead of the process.env default — so a multi-tenant server never
// mutates process.env per request. UNSET (all existing single-tenant callers pass one arg) →
// identical prior behavior. Backward-compatible.
export function createActionHandlers(
  db: InfiniteOsDb,
  options?: { encryptionKey?: string }
): Partial<Record<InfiniteOsActionId, ActionHandler>> {
  const encryptionKey = options?.encryptionKey;
  return {
    list_sources: (_input, context) => listSources(db, context),
    describe_source: (input, context) => describeSource(db, context, input),
    get_recent_sync_runs: (input, context) => recentSyncRuns(db, context, input),
    list_source_schedules: (_input, context) => listSourceSchedules(db, context),
    list_queryable_views: (_input, context) => listQueryableViews(db, context),
    describe_queryable_view: (input, context) => describeQueryableView(db, context, input),
    list_metrics: (_input, context) => listMetrics(db, context),
    describe_metric: (input, context) => describeMetric(db, context, input),
    connect_source: (input, context) => connectSource(db, context, input, encryptionKey),
    reconnect_source: (input, context) => reconnectSource(db, context, input, encryptionKey),
    revoke_source: (input, context) => revokeSource(db, context, input),
    start_source_sync: (input, context) => startSourceSync(db, context, input),
    sync_source_now: (input, context) => syncSourceNow(db, context, input, encryptionKey),
    update_source_schedule: (input, context) => updateSourceSchedule(db, context, input),
    pause_source_schedule: (input, context) => pauseSourceSchedule(db, context, input),
    resume_source_schedule: (input, context) => resumeSourceSchedule(db, context, input),
    run_metric_query: (input, context) => runMetricQuery(db, context, input),
    run_breakdown_query: (input, context) => runBreakdownQuery(db, context, input),
    run_funnel_query: (input, context) => runFunnelQuery(db, context, input),
    explain_answer: (input, context) => explainAnswer(db, context, input),
    drilldown_result: (input, context) => drilldownResult(db, context, input),
    search_context: (input, context) => searchContext(db, context, input),
    describe_context_item: (input, context) => describeContextItem(context, input),
    resolve_entity: (input, context) => resolveEntity(db, context, input),
    validate_journey_plan: (input, context) => validateJourneyPlan(db, context, input),
    run_journey_query: (input, context) => runJourneyQuery(db, context, input),
    fetch_evidence: (input, context) => fetchEvidence(db, context, input),
    verify_claims: (input, context) => verifyClaims(db, context, input),
    create_saved_report: (input, context) => createSavedReport(db, context, input),
    run_saved_report: (input, context) => runSavedReport(db, context, input),
    export_saved_report: (input, context) => exportSavedReport(db, context, input),
    list_meta_assets: (input, context) => listMetaAssetsHandler(db, context, input),
    list_meta_entities: (input, context) => listMetaEntitiesHandler(db, context, input),
    get_meta_entity: (input, context) => getMetaEntityHandler(db, context, input),
    run_meta_live_insights: (input, context) => runMetaLiveInsightsHandler(db, context, input),
    create_meta_campaign: (input, context) => createMetaCampaignHandler(db, context, input),
    create_meta_ad_set: (input, context) => createMetaAdSetHandler(db, context, input),
    create_meta_creative: (input, context) => createMetaCreativeHandler(db, context, input),
    create_meta_ad: (input, context) => createMetaAdHandler(db, context, input),
    set_meta_entity_status: (input, context) => setMetaEntityStatusHandler(db, context, input),
    update_meta_budget: (input, context) => updateMetaBudgetHandler(db, context, input),
    delete_meta_entity: (input, context) => deleteMetaEntityHandler(db, context, input)
  };
}

export interface ConnectedSourceActionData {
  source: Record<string, unknown>;
  sourceId: string;
  connectionTest?: ConnectionTestResult;
  initialSync?: Record<string, unknown>;
}

export interface QueuedSourceSyncActionData {
  job: Record<string, unknown>;
  jobId?: string;
}

export type QueryabilityStatus = "pending" | "verified" | "failed";

export function connectedSourceFromEnvelope(envelope: ActionEnvelope): ConnectedSourceActionData {
  if (!envelope.ok || !isRecord(envelope.data) || !isRecord(envelope.data.source)) {
    throw new Error("connect_source did not return a source payload");
  }
  const sourceId = requiredEnvelopeString(envelope.data.source, "id", "connect_source");
  return {
    source: envelope.data.source,
    sourceId,
    connectionTest: isRecord(envelope.data.connectionTest)
      ? (envelope.data.connectionTest as unknown as ConnectionTestResult)
      : undefined,
    initialSync: isRecord(envelope.data.initialSync)
      ? envelope.data.initialSync
      : undefined
  };
}

export function queuedSourceSyncFromEnvelope(envelope: ActionEnvelope): QueuedSourceSyncActionData {
  if (!envelope.ok || !isRecord(envelope.data) || !isRecord(envelope.data.job)) {
    throw new Error("start_source_sync did not return a job payload");
  }
  const jobId = typeof envelope.data.job.id === "string" && envelope.data.job.id.trim() !== ""
    ? envelope.data.job.id
    : undefined;
  return {
    job: envelope.data.job,
    jobId
  };
}

export function queryabilityStatusFromSourceVerification(input: {
  connectionTest?: Pick<ConnectionTestResult, "ok"> | null;
  syncStatus?: "succeeded" | "failed" | null;
}): QueryabilityStatus {
  if (input.connectionTest?.ok === true || input.syncStatus === "succeeded") {
    return "verified";
  }
  if (input.connectionTest?.ok === false || input.syncStatus === "failed") {
    return "failed";
  }
  return "pending";
}

async function listSources(db: InfiniteOsDb, context: SessionContext): Promise<ActionEnvelope> {
  const sources = await db.query(
    `
      select s.id, s.provider, d.key as dataset_key, s.connection_name,
        s.account_external_id, s.status, s.sync_mode, s.connected_at, s.last_synced_at,
        -- Transient-failure streak observability (migrations 0044/0045): how many independent
        -- transient sync failures have accrued toward the error escalation, and when the last one
        -- counted. Additive -- lets callers surface degrading before the source actually parks.
        s.consecutive_sync_failures, s.last_counted_sync_failure_at,
        (
          select cc.credential_kind
          from connection_credentials cc
          where cc.source_id = s.id and cc.revoked_at is null
          order by cc.created_at desc
          limit 1
        ) as credential_kind
      from sources s
      join datasets d on d.id = s.dataset_id
      where s.workspace_id = $1
      order by s.provider, s.connection_name
    `,
    [context.workspaceId]
  );
  return envelope("list_sources", context.authority, { sources }, ["sources", "datasets"]);
}

async function describeSource(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const source = await db.one(
    `
      select s.id, s.provider, d.key as dataset_key, s.connection_name,
        s.account_external_id, s.status, s.sync_mode, s.connected_at, s.last_synced_at
      from sources s
      join datasets d on d.id = s.dataset_id
      where s.workspace_id = $1 and s.id = $2
    `,
    [context.workspaceId, sourceId]
  );
  return envelope("describe_source", context.authority, { source }, ["sources", "datasets"]);
}

async function recentSyncRuns(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const limit = boundedLimit(input, 20);
  const rows = await db.query(
    `
      select id, source_id, status, started_at, finished_at,
        records_extracted, records_loaded, error
      from sync_runs
      where workspace_id = $1
      order by started_at desc
      limit $2
    `,
    [context.workspaceId, limit]
  );
  return envelope("get_recent_sync_runs", context.authority, { syncRuns: rows }, ["sync_runs"]);
}

async function listSourceSchedules(db: InfiniteOsDb, context: SessionContext): Promise<ActionEnvelope> {
  const schedules = await db.query(
    `
      select ss.source_id as "sourceId", s.provider, d.key as "datasetKey",
        ss.schedule_kind as "scheduleKind", ss.interval_minutes as "intervalMinutes",
        ss.sync_mode as "syncMode", ss.refresh_window_days as "refreshWindowDays",
        ss.stale_after_minutes as "staleAfterMinutes", ss.status,
        ss.next_run_at as "nextRunAt", ss.last_enqueued_at as "lastEnqueuedAt",
        ss.last_completed_at as "lastCompletedAt", ss.paused_at as "pausedAt",
        ss.pause_reason as "pauseReason"
      from sync_schedules ss
      join sources s on s.id = ss.source_id
      join datasets d on d.id = s.dataset_id
      where ss.workspace_id = $1
      order by s.provider
    `,
    [context.workspaceId]
  );
  return envelope("list_source_schedules", context.authority, { schedules }, ["sync_schedules"]);
}

async function listQueryableViews(db: InfiniteOsDb, context: SessionContext): Promise<ActionEnvelope> {
  const views = await db.query(
    `
      select id, view_name, description, row_grain, default_time_column,
        allowed_dimensions, allowed_measures, source_tables, freshness_target, caveats, drilldown_action
      from queryable_views
      order by id
    `
  );
  return envelope("list_queryable_views", context.authority, { views: views.map(hydrateQueryableViewMetadata) }, ["queryable_views"]);
}

async function describeQueryableView(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const viewId = requiredString(input, "viewId");
  rejectUnsafeView(viewId);
  const view = await db.one("select * from queryable_views where id = $1", [viewId]);
  return envelope("describe_queryable_view", context.authority, { view: hydrateQueryableViewMetadata(view) }, ["queryable_views"]);
}

async function listMetrics(db: InfiniteOsDb, context: SessionContext): Promise<ActionEnvelope> {
  const metrics = await db.query(
    `
      select id, name, description, aliases, source_view, expression, metric_type,
        unit, aggregation, default_time_column, allowed_dimensions, caveats, examples
      from metric_definitions
      order by id
    `
  );
  return envelope("list_metrics", context.authority, { metrics: metrics.map(hydrateMetricMetadata) }, ["metric_definitions"]);
}

async function describeMetric(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const metricId = requiredString(input, "metricId");
  if (!METRIC_SET.has(metricId)) {
    return unsupported("describe_metric", context.authority, "unsupported_metric");
  }
  const metric = await db.one("select * from metric_definitions where id = $1", [metricId]);
  return envelope("describe_metric", context.authority, { metric: hydrateMetricMetadata(metric) }, ["metric_definitions"]);
}

async function searchContext(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const query = requiredString(input, "query");
  const kinds = new Set(stringArray(input, "kinds"));
  const limit = boundedLimit(input, 10, 50);
  const include = (kind: string) => kinds.size === 0 || kinds.has(kind);
  const like = `%${query}%`;
  const items: Array<Record<string, unknown>> = [];

  if (include("journey_template") || include("policy") || include("entity") || include("source")) {
    items.push(
      ...searchContextCards(seedContextCards(), query)
        .filter((card) => {
          if (card.cardType === "journey_template") return include("journey_template");
          if (card.cardType === "policy_definition") return include("policy");
          if (card.cardType === "entity_definition") return include("entity");
          if (card.cardType === "source_capability") return include("source");
          return kinds.size === 0;
        })
        .slice(0, limit)
        .map((card) => ({
          id: card.id,
          kind: card.cardType,
          title: card.title,
          summary: card.summary,
          relevanceScore: card.relevanceScore
        }))
    );
  }

  if (include("metric")) {
    const metrics = await db.query<Record<string, unknown>>(
      `
        select id, name, description, source_view
        from metric_definitions
        where id ilike $1 or name ilike $1 or description ilike $1
        order by id
        limit $2
      `,
      [like, limit]
    );
    items.unshift(
      ...metrics.map((metric) => ({
        id: `metric:${metric.id}`,
        kind: "metric",
        title: metric.name ?? metric.id,
        summary: metric.description,
        sourceView: metric.source_view
      }))
    );
  }

  if (include("source")) {
    const sources = await db.query<Record<string, unknown>>(
      `
        select id, provider, connection_name, status, last_synced_at
        from sources
        where workspace_id = $1
          and (provider ilike $2 or connection_name ilike $2)
        order by provider, connection_name
        limit $3
      `,
      [context.workspaceId, like, limit]
    );
    items.push(
      ...sources.map((source) => ({
        id: `source:${source.id}`,
        kind: "source",
        title: source.connection_name ?? source.provider,
        summary: `${source.provider} source is ${source.status}`,
        provider: source.provider,
        status: source.status,
        lastSyncedAt: source.last_synced_at
      }))
    );
  }

  return envelope(
    "search_context",
    context.authority,
    { query, items: items.slice(0, limit), truncated: items.length > limit },
    ["metadata.seed_context_cards", "metric_definitions", "sources"],
    "ok",
    [],
    ["describe_context_item", "resolve_entity", "validate_journey_plan"]
  );
}

async function describeContextItem(
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const itemId = requiredString(input, "itemId");
  const card = describeContextCard(seedContextCards(), itemId);
  if (!card) {
    return createEnvelope({
      actionId: "describe_context_item",
      authority: context.authority,
      status: "needs_clarification",
      answerabilityReason: "missing_context",
      data: { itemId, found: false },
      provenance: ["metadata.seed_context_cards"],
      caveats: ["context_item_not_found"],
      nextActions: ["search_context"]
    });
  }
  return envelope(
    "describe_context_item",
    context.authority,
    { item: card },
    ["metadata.seed_context_cards"],
    "ok",
    [],
    ["resolve_entity", "validate_journey_plan"]
  );
}

async function resolveEntity(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const entityType = requiredString(input, "entityType");
  const query = requiredString(input, "query");
  const limit = boundedLimit(input, 10, 50);
  const candidates =
    entityType === "campaign"
      ? await resolveCampaignEntities(db, context.workspaceId, query, limit)
      : entityType === "adset"
        ? await resolveAdsetEntities(db, context.workspaceId, query, limit)
        : entityType === "ad"
          ? await resolveAdEntities(db, context.workspaceId, query, limit)
          : ["content_item", "event_item"].includes(entityType)
            ? await resolveXContentEntities(db, context.workspaceId, query, limit)
            : [];
  const provenance = entityType === "campaign"
    ? ["queryable.vw_meta_ads_campaign_daily"]
    : entityType === "adset"
      ? ["queryable.vw_meta_ads_adset_daily"]
      : entityType === "ad"
        ? ["queryable.vw_meta_ads_ad_daily"]
        : ["queryable.vw_x_post_public_metrics"];
  return createEnvelope({
    actionId: "resolve_entity",
    authority: context.authority,
    status: candidates.length ? "resolved" : "needs_clarification",
    answerabilityReason: candidates.length ? undefined : "ambiguous_entity",
    data: { entityType, query, candidates },
    provenance,
    freshness: await freshnessForViews(db, context.workspaceId, provenance),
    caveats: candidates.length ? [] : ["no_matching_entity"],
    nextActions: ["validate_journey_plan", "run_journey_query"]
  });
}

async function validateJourneyPlan(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const plan = requiredPlan(input);
  const requiredProviders = requiredProvidersForPlan(plan);
  const sources = await connectedSources(db, context.workspaceId, requiredProviders);
  const coveredProviders = new Set(sources.map((source) => String(source.provider)));
  const missingSourceIds = requiredProviders.filter((provider) => !coveredProviders.has(provider));
  const validationId = `validation:${stablePlanKey(plan)}`;
  const status = missingSourceIds.length ? "low_coverage" : "ok";
  const caveats = journeyCaveats(plan);

  return createEnvelope({
    actionId: "validate_journey_plan",
    authority: context.authority,
    status,
    answerabilityReason: missingSourceIds.length ? "insufficient_source_coverage" : undefined,
    interpretedPlan: plan,
    data: {
      validationId,
      valid: missingSourceIds.length === 0,
      requiredProviders,
      coveredProviders: [...coveredProviders],
      caveats
    },
    evidence: sources.map((source) => ({
      id: `evidence:source:${source.id}`,
      kind: "context_item" as const,
      sourceIds: [String(source.id)]
    })),
    coverage: {
      sourceIds: sources.map((source) => String(source.id)),
      requiredSourceIds: requiredProviders,
      coveredCount: coveredProviders.size,
      expectedCount: requiredProviders.length,
      coverageRatio: requiredProviders.length ? coveredProviders.size / requiredProviders.length : 1,
      missingSourceIds
    },
    policyRefs: policyRefsForPlan(plan),
    provenance: ["sources", "metadata.seed_context_cards"],
    // The plan names its providers directly — freshness over that set (the
    // journey answer can only be as fresh as its stalest required provider).
    freshness: await freshnessForProviders(db, context.workspaceId, requiredProviders),
    caveats,
    nextActions: missingSourceIds.length ? ["search_context"] : ["run_journey_query"]
  });
}

async function runJourneyQuery(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const validationId = requiredString(input, "validationId");
  const plan = requiredPlan(input);
  const limit = boundedLimit(input, numberOrNull(plan, "limit") ?? 10, 50);
  const compiled = compileJourneyPlan(plan);
  if (!compiled) {
    return createEnvelope({
      actionId: "run_journey_query",
      authority: context.authority,
      status: "unsupported",
      answerabilityReason: "unsupported_intent",
      interpretedPlan: plan,
      data: {
        validationId,
        answer: "I cannot run that journey yet. Current local handlers cover X public content, Meta campaign metrics, and simple X-vs-Meta channel comparison.",
        rows: []
      },
      provenance: [],
      caveats: ["journey_template_not_supported"],
      nextActions: ["search_context", "validate_journey_plan"]
    });
  }

  const rows = await rowsForCompiledJourney(db, context.workspaceId, compiled, plan, limit);
  const evidenceHandleId = evidenceHandleFor(compiled.metric, compiled.entityType);
  await logTool(
    db,
    context,
    "run_journey_query",
    input,
    compiled.provenance,
    [compiled.metric],
    { validationId, compiled },
    rows.length
  );
  return createEnvelope({
    actionId: "run_journey_query",
    authority: context.authority,
    status: rows.length ? "resolved" : "low_coverage",
    answerabilityReason: rows.length ? undefined : "insufficient_source_coverage",
    interpretedPlan: plan,
    resultHandle: `result:${compiled.metric}:${compiled.entityType}:${stablePlanKey(plan)}`,
    data: {
      validationId,
      answer: answerForJourney(compiled, rows, plan),
      rows,
      metric: compiled.metric,
      entityType: compiled.entityType,
      evidenceHandleId
    },
    evidence: [
      {
        id: evidenceHandleId,
        kind: "query_result",
        sourceIds: sourceIdsFromRows(rows)
      }
    ],
    coverage: {
      sourceIds: sourceIdsFromRows(rows),
      coveredCount: rows.length,
      expectedCount: Math.max(rows.length, 1),
      coverageRatio: rows.length ? 1 : 0
    },
    policyRefs: policyRefsForPlan(plan),
    provenance: compiled.provenance,
    freshness: await freshnessForViews(db, context.workspaceId, compiled.provenance),
    caveats: [...new Set([...compiled.caveats, ...journeyCaveats(plan)])],
    nextActions: ["fetch_evidence", "verify_claims", "explain_answer"]
  });
}

async function fetchEvidence(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const evidenceHandleId = requiredString(input, "evidenceHandleId");
  const compiled = compiledJourneyFromEvidenceHandle(evidenceHandleId);
  if (!compiled) {
    return createEnvelope({
      actionId: "fetch_evidence",
      authority: context.authority,
      status: "needs_clarification",
      answerabilityReason: "missing_context",
      data: { evidenceHandleId, rows: [] },
      provenance: [],
      caveats: ["unknown_evidence_handle"],
      nextActions: ["run_journey_query"]
    });
  }
  const rows = await rowsForCompiledJourney(db, context.workspaceId, compiled, undefined, boundedLimit(input, 20, 100));
  return envelope(
    "fetch_evidence",
    context.authority,
    { evidenceHandleId, rows, rowCount: rows.length },
    compiled.provenance,
    "ok",
    compiled.caveats,
    ["verify_claims"],
    await freshnessForViews(db, context.workspaceId, compiled.provenance)
  );
}

async function verifyClaims(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const claims = stringArray(input, "claims");
  const evidenceHandleIds = stringArray(input, "evidenceHandleIds");
  const evidenceCounts: Record<string, number> = {};
  const evidenceViews = new Set<string>();
  for (const handle of evidenceHandleIds) {
    const compiled = compiledJourneyFromEvidenceHandle(handle);
    if (compiled) {
      for (const view of compiled.provenance) {
        evidenceViews.add(view);
      }
    }
    evidenceCounts[handle] = compiled
      ? (await rowsForCompiledJourney(db, context.workspaceId, compiled, undefined, 5)).length
      : 0;
  }
  const hasEvidence = Object.values(evidenceCounts).some((count) => count > 0);
  return createEnvelope({
    actionId: "verify_claims",
    authority: context.authority,
    status: hasEvidence ? "resolved" : "low_coverage",
    answerabilityReason: hasEvidence ? undefined : "insufficient_source_coverage",
    data: {
      claims: claims.map((claim) => ({
        claim,
        status: hasEvidence ? "verified" : "insufficient_evidence",
        evidenceHandleIds
      })),
      evidenceCounts
    },
    provenance: evidenceHandleIds,
    freshness: await freshnessForViews(db, context.workspaceId, [...evidenceViews]),
    caveats: hasEvidence ? [] : ["no_evidence_rows"],
    nextActions: hasEvidence ? ["explain_answer"] : ["fetch_evidence"]
  });
}

// Stop-words stripped before the relaxed near-candidate pass: generic campaign/entity filler that
// would otherwise drag in every campaign (e.g. "sales campaign" must search for "sales", not "campaign").
const CAMPAIGN_QUERY_STOP_WORDS = new Set([
  "campaign", "campaigns", "the", "a", "an", "my", "our", "ad", "ads", "on", "for", "of", "in", "and", "meta", "facebook", "instagram"
]);

function significantCampaignTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/i)) {
    const token = raw.trim();
    if (token.length < 2 || CAMPAIGN_QUERY_STOP_WORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

async function resolveCampaignEntities(
  db: InfiniteOsDb,
  workspaceId: string,
  query: string,
  limit: number
): Promise<Record<string, unknown>[]> {
  const toEvidence = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((row) => sanitizeEvidenceRow({
      entityType: "campaign",
      entityKey: row.campaign_id,
      label: row.campaign_name ?? row.campaign_id,
      sourceId: row.source_id,
      lastSeenOn: row.last_seen_on,
      metrics: {
        meta_ads_clicks: row.meta_ads_clicks,
        meta_ads_spend: row.meta_ads_spend,
        impressions: row.impressions
      }
    }));

  const like = `%${query}%`;
  const rows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, campaign_name,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        max(occurred_on) as last_seen_on
      from queryable.vw_meta_ads_campaign_daily
      where workspace_id = $1
        and (campaign_id ilike $2 or campaign_name ilike $2)
      group by source_id, campaign_id, campaign_name
      order by sum(meta_ads_clicks) desc nulls last, max(occurred_on) desc nulls last
      limit $3
    `,
    [workspaceId, like, limit]
  );
  if (rows.length > 0) {
    return toEvidence(rows);
  }

  // Relaxed near-candidate pass: the exact `%query%` substring matched nothing, so tokenize the
  // query, drop generic stop-words, and OR the significant tokens (e.g. "sales campaign" -> "sales")
  // so "sales campaign" still surfaces "Sales — Summer Sale". Returned as candidates the controller
  // can pick from or present to the user instead of bailing with no leads. READ-ONLY — same view,
  // same grouping; nothing here writes or relaxes a partition.
  const tokens = significantCampaignTokens(query);
  if (tokens.length === 0) {
    return [];
  }
  const tokenParams = tokens.map((token) => `%${token}%`);
  const tokenClauses = tokens
    .map((_token, index) => `(campaign_id ilike $${index + 2} or campaign_name ilike $${index + 2})`)
    .join(" or ");
  const nearRows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, campaign_name,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        max(occurred_on) as last_seen_on
      from queryable.vw_meta_ads_campaign_daily
      where workspace_id = $1
        and (${tokenClauses})
      group by source_id, campaign_id, campaign_name
      order by sum(meta_ads_clicks) desc nulls last, max(occurred_on) desc nulls last
      limit $${tokens.length + 2}
    `,
    [workspaceId, ...tokenParams, limit]
  );
  return toEvidence(nearRows);
}

// Adset-grain entity resolution — the exact mirror of resolveCampaignEntities over the
// vw_meta_ads_adset_daily view (adset_id/adset_name dims, campaign_id carried). Same
// exact-substring-then-tokenized-near-candidate shape; READ-ONLY (same view, same grouping).
async function resolveAdsetEntities(
  db: InfiniteOsDb,
  workspaceId: string,
  query: string,
  limit: number
): Promise<Record<string, unknown>[]> {
  const toEvidence = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((row) => sanitizeEvidenceRow({
      entityType: "adset",
      entityKey: row.adset_id,
      label: row.adset_name ?? row.adset_id,
      sourceId: row.source_id,
      campaignId: row.campaign_id,
      lastSeenOn: row.last_seen_on,
      metrics: {
        meta_ads_clicks: row.meta_ads_clicks,
        meta_ads_spend: row.meta_ads_spend,
        impressions: row.impressions
      }
    }));

  const like = `%${query}%`;
  const rows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, adset_id, adset_name,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        max(occurred_on) as last_seen_on
      from queryable.vw_meta_ads_adset_daily
      where workspace_id = $1
        and (adset_id ilike $2 or adset_name ilike $2)
      group by source_id, campaign_id, adset_id, adset_name
      order by sum(meta_ads_clicks) desc nulls last, max(occurred_on) desc nulls last
      limit $3
    `,
    [workspaceId, like, limit]
  );
  if (rows.length > 0) {
    return toEvidence(rows);
  }

  const tokens = significantCampaignTokens(query);
  if (tokens.length === 0) {
    return [];
  }
  const tokenParams = tokens.map((token) => `%${token}%`);
  const tokenClauses = tokens
    .map((_token, index) => `(adset_id ilike $${index + 2} or adset_name ilike $${index + 2})`)
    .join(" or ");
  const nearRows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, adset_id, adset_name,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        max(occurred_on) as last_seen_on
      from queryable.vw_meta_ads_adset_daily
      where workspace_id = $1
        and (${tokenClauses})
      group by source_id, campaign_id, adset_id, adset_name
      order by sum(meta_ads_clicks) desc nulls last, max(occurred_on) desc nulls last
      limit $${tokens.length + 2}
    `,
    [workspaceId, ...tokenParams, limit]
  );
  return toEvidence(nearRows);
}

// Ad-grain entity resolution — mirror over vw_meta_ads_ad_daily (ad_id/ad_name dims; adset_id
// + campaign_id carried). adset_id is ORPHAN-TOLERANT: an ad with no adset surfaces a null
// adset_id carry without failing (§7a). NO optimization_goal (adset property; not on the ad
// view). READ-ONLY; same exact-then-tokenized shape as the campaign/adset resolvers.
async function resolveAdEntities(
  db: InfiniteOsDb,
  workspaceId: string,
  query: string,
  limit: number
): Promise<Record<string, unknown>[]> {
  const toEvidence = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((row) => sanitizeEvidenceRow({
      entityType: "ad",
      entityKey: row.ad_id,
      label: row.ad_name ?? row.ad_id,
      sourceId: row.source_id,
      adsetId: row.adset_id ?? null,
      campaignId: row.campaign_id,
      lastSeenOn: row.last_seen_on,
      metrics: {
        meta_ads_clicks: row.meta_ads_clicks,
        meta_ads_spend: row.meta_ads_spend,
        impressions: row.impressions
      }
    }));

  const like = `%${query}%`;
  const rows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, adset_id, ad_id, ad_name,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        max(occurred_on) as last_seen_on
      from queryable.vw_meta_ads_ad_daily
      where workspace_id = $1
        and (ad_id ilike $2 or ad_name ilike $2)
      group by source_id, campaign_id, adset_id, ad_id, ad_name
      order by sum(meta_ads_clicks) desc nulls last, max(occurred_on) desc nulls last
      limit $3
    `,
    [workspaceId, like, limit]
  );
  if (rows.length > 0) {
    return toEvidence(rows);
  }

  const tokens = significantCampaignTokens(query);
  if (tokens.length === 0) {
    return [];
  }
  const tokenParams = tokens.map((token) => `%${token}%`);
  const tokenClauses = tokens
    .map((_token, index) => `(ad_id ilike $${index + 2} or ad_name ilike $${index + 2})`)
    .join(" or ");
  const nearRows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, adset_id, ad_id, ad_name,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        max(occurred_on) as last_seen_on
      from queryable.vw_meta_ads_ad_daily
      where workspace_id = $1
        and (${tokenClauses})
      group by source_id, campaign_id, adset_id, ad_id, ad_name
      order by sum(meta_ads_clicks) desc nulls last, max(occurred_on) desc nulls last
      limit $${tokens.length + 2}
    `,
    [workspaceId, ...tokenParams, limit]
  );
  return toEvidence(nearRows);
}

async function resolveXContentEntities(
  db: InfiniteOsDb,
  workspaceId: string,
  query: string,
  limit: number
): Promise<Record<string, unknown>[]> {
  const like = `%${query}%`;
  const rows = await db.query<Record<string, unknown>>(
    `
      select source_id, x_post_id, post_url, body_text, published_at,
        x_public_engagement, like_count, reply_count
      from queryable.vw_x_post_public_metrics
      where workspace_id = $1
        and (x_post_id ilike $2 or post_url ilike $2 or body_text ilike $2)
      order by x_public_engagement desc nulls last, published_at desc nulls last
      limit $3
    `,
    [workspaceId, like, limit]
  );
  return rows.map((row) => sanitizeEvidenceRow({
    entityType: "content_item",
    entityKey: row.x_post_id,
    label: conciseLabel(row.body_text ?? row.post_url ?? row.x_post_id),
    sourceId: row.source_id,
    publishedAt: row.published_at,
    metrics: {
      x_public_engagement: row.x_public_engagement,
      like_count: row.like_count,
      reply_count: row.reply_count
    }
  }));
}

function requiredPlan(input: unknown): JourneyQueryPlan {
  const plan = objectField(input, "plan");
  if (!isRecord(plan)) {
    throw new Error("plan is required");
  }
  const timeRange = objectField(plan, "timeRange");
  if (!isRecord(timeRange)) {
    throw new Error("plan.timeRange is required");
  }
  const start = optionalString(timeRange, "start");
  const end = optionalString(timeRange, "end");
  if (!start || !end) {
    throw new Error("plan.timeRange.start and plan.timeRange.end are required");
  }
  return plan as unknown as JourneyQueryPlan;
}

async function connectedSources(
  db: InfiniteOsDb,
  workspaceId: string,
  providers: string[]
): Promise<JourneySourceRow[]> {
  if (providers.length === 0) {
    return [];
  }
  return db.query<JourneySourceRow>(
    `
      select id, provider, status, last_synced_at
      from sources
      where workspace_id = $1
        and provider = any($2::text[])
        and status in ('connected', 'degraded')
      order by provider, connected_at desc
    `,
    [workspaceId, providers]
  );
}

function requiredProvidersForPlan(plan: JourneyQueryPlan): JourneyProvider[] {
  const metric = metricFromPlan(plan);
  const entityType = plan.entity?.type;
  const providers = new Set<JourneyProvider>();

  if (metric.startsWith("meta_ads_") || entityType === "campaign") {
    providers.add("meta_ads");
  }
  if (
    metric.startsWith("x_") ||
    entityType === "content_item" ||
    entityType === "event_item"
  ) {
    providers.add("x");
  }
  if (plan.intent === "compare_cohorts" || entityType === "channel") {
    providers.add("meta_ads");
    providers.add("x");
  }

  return [...providers];
}

function stablePlanKey(plan: JourneyQueryPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(sortForStableHash(plan)))
    .digest("base64url")
    .slice(0, 24);
}

function sortForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableHash);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortForStableHash(value[key]);
      return acc;
    }, {});
}

function journeyCaveats(plan: JourneyQueryPlan): string[] {
  const metric = metricFromPlan(plan);
  const caveats = new Set<string>();
  if (metric.startsWith("meta_ads_")) {
    caveats.add("read_only_marketing_api_reporting");
  }
  if (metric.startsWith("x_")) {
    caveats.add("public_metrics_only");
    caveats.add("no_paid_or_private_metrics");
  }
  if (requiresDownstreamAttribution(plan)) {
    caveats.add("cross_source_customer_attribution_not_implemented");
  }
  caveats.add("deterministic_template_query");
  caveats.add("bounded_redacted_evidence_rows");
  return [...caveats];
}

function policyRefsForPlan(plan: JourneyQueryPlan): PolicyRef[] {
  const refs: PolicyRef[] = [
    {
      id: `metric:${metricFromPlan(plan)}`,
      kind: "metric_definition" as const,
      approved: true
    }
  ];
  if (plan.journeyTemplateId) {
    refs.push({
      id: plan.journeyTemplateId,
      kind: "journey_template" as const,
      approved: true
    });
  }
  if (plan.outcome?.policyId) {
    refs.push({
      id: plan.outcome.policyId,
      kind: "operator_policy" as const,
      approved: true
    });
  }
  return refs;
}

function compileJourneyPlan(plan: JourneyQueryPlan): CompiledJourney | null {
  const metric = metricFromPlan(plan);
  const entityType = plan.entity?.type ?? entityTypeFromMetric(metric);
  const commonCaveats = journeyCaveats(plan);

  if (
    plan.intent === "compare_cohorts" ||
    entityType === "channel" ||
    metric === "channel_response"
  ) {
    return {
      kind: "channel_comparison",
      metric: "channel_response",
      entityType: "channel",
      provenance: [
        "queryable.vw_meta_ads_campaign_daily",
        "queryable.vw_x_post_public_metrics"
      ],
      caveats: commonCaveats
    };
  }

  if (
    entityType === "campaign" ||
    metric === "meta_ads_clicks" ||
    metric === "meta_ads_spend"
  ) {
    return {
      kind: "meta_campaign",
      metric: metric === "meta_ads_spend" ? "meta_ads_spend" : "meta_ads_clicks",
      entityType: "campaign",
      provenance: ["queryable.vw_meta_ads_campaign_daily"],
      caveats: commonCaveats
    };
  }

  if (
    entityType === "content_item" ||
    entityType === "event_item" ||
    metric === "x_public_engagement"
  ) {
    return {
      kind: "x_content",
      metric: "x_public_engagement",
      entityType: "content_item",
      provenance: ["queryable.vw_x_post_public_metrics"],
      caveats: commonCaveats
    };
  }

  return null;
}

async function rowsForCompiledJourney(
  db: InfiniteOsDb,
  workspaceId: string,
  compiled: CompiledJourney,
  plan: JourneyQueryPlan | undefined,
  limit: number
): Promise<Record<string, unknown>[]> {
  if (compiled.kind === "meta_campaign") {
    return metaCampaignJourneyRows(db, workspaceId, compiled, plan, limit);
  }
  if (compiled.kind === "x_content") {
    return xContentJourneyRows(db, workspaceId, plan, limit);
  }
  return channelComparisonRows(db, workspaceId, plan, limit);
}

async function metaCampaignJourneyRows(
  db: InfiniteOsDb,
  workspaceId: string,
  compiled: CompiledJourney,
  plan: JourneyQueryPlan | undefined,
  limit: number
): Promise<Record<string, unknown>[]> {
  const order = journeyOrderDirection(plan);
  const orderExpression = metaJourneyOrderExpression(compiled.metric);
  const { start, end } = timeRangeParams(plan);
  const rows = await db.query<Record<string, unknown>>(
    `
      select source_id, campaign_id, campaign_name,
        min(occurred_on) as first_seen_on,
        max(occurred_on) as last_seen_on,
        sum(meta_ads_clicks) as meta_ads_clicks,
        sum(meta_ads_spend) as meta_ads_spend,
        sum(impressions) as impressions,
        sum(reach) as reach,
        sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000 as cpm,
        sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0) as cpc,
        sum(meta_ads_clicks) / nullif(sum(impressions), 0) as ctr
      from queryable.vw_meta_ads_campaign_daily
      where workspace_id = $1
        and ($2::date is null or occurred_on >= $2::date)
        and ($3::date is null or occurred_on <= $3::date)
      group by source_id, campaign_id, campaign_name
      order by ${orderExpression} ${order} nulls last, max(occurred_on) desc nulls last
      limit $4
    `,
    [workspaceId, start, end, limit]
  );
  return sanitizeRows(rows);
}

async function xContentJourneyRows(
  db: InfiniteOsDb,
  workspaceId: string,
  plan: JourneyQueryPlan | undefined,
  limit: number
): Promise<Record<string, unknown>[]> {
  const order = journeyOrderDirection(plan);
  const { start, end } = timeRangeParams(plan);
  const rows = await db.query<Record<string, unknown>>(
    `
      select source_id, x_post_id, post_url, body_text, published_at, captured_at,
        x_public_engagement, like_count, reply_count, retweet_count, quote_count,
        bookmark_count, impression_count
      from queryable.vw_x_post_public_metrics
      where workspace_id = $1
        and ($2::date is null or occurred_on >= $2::date)
        and ($3::date is null or occurred_on <= $3::date)
      order by x_public_engagement ${order} nulls last, published_at desc nulls last
      limit $4
    `,
    [workspaceId, start, end, limit]
  );
  return sanitizeRows(rows);
}

async function channelComparisonRows(
  db: InfiniteOsDb,
  workspaceId: string,
  plan: JourneyQueryPlan | undefined,
  _limit: number
): Promise<Record<string, unknown>[]> {
  const { start, end } = timeRangeParams(plan);
  const metaRows = await db.query<Record<string, unknown>>(
    `
      select 'meta_ads' as channel,
        array_agg(distinct source_id) as source_ids,
        count(distinct campaign_id) as campaign_count,
        sum(impressions) as awareness_events,
        sum(meta_ads_clicks) as response_events,
        sum(meta_ads_spend) as spend
      from queryable.vw_meta_ads_campaign_daily
      where workspace_id = $1
        and ($2::date is null or occurred_on >= $2::date)
        and ($3::date is null or occurred_on <= $3::date)
    `,
    [workspaceId, start, end]
  );
  const xRows = await db.query<Record<string, unknown>>(
    `
      select 'x' as channel,
        array_agg(distinct source_id) as source_ids,
        count(distinct x_post_id) as content_count,
        sum(impression_count) as awareness_events,
        sum(x_public_engagement) as response_events,
        null::numeric as spend
      from queryable.vw_x_post_public_metrics
      where workspace_id = $1
        and ($2::date is null or occurred_on >= $2::date)
        and ($3::date is null or occurred_on <= $3::date)
    `,
    [workspaceId, start, end]
  );
  return sanitizeRows([...metaRows, ...xRows]);
}

function metricFromPlan(plan: JourneyQueryPlan): string {
  const rankingMetric = plan.ranking?.metric;
  if (rankingMetric) {
    return rankingMetric;
  }
  const outcomeId = plan.outcome?.id ?? "";
  if (outcomeId.startsWith("meta_ads_") || outcomeId.startsWith("x_")) {
    return outcomeId;
  }
  if (plan.intent === "compare_cohorts" || plan.entity?.type === "channel") {
    return "channel_response";
  }
  if (plan.entity?.type === "campaign") {
    return "meta_ads_clicks";
  }
  if (plan.entity?.type === "content_item" || plan.entity?.type === "event_item") {
    return "x_public_engagement";
  }
  return outcomeId || "channel_response";
}

function entityTypeFromMetric(metric: string): string {
  if (metric.startsWith("meta_ads_")) {
    return "campaign";
  }
  if (metric.startsWith("x_")) {
    return "content_item";
  }
  return "channel";
}

function metaJourneyOrderExpression(metric: string): string {
  if (metric === "meta_ads_spend") {
    return "sum(meta_ads_spend)";
  }
  if (metric === "impressions") {
    return "sum(impressions)";
  }
  if (metric === "reach") {
    return "sum(reach)";
  }
  if (metric === "ctr") {
    // Rank by the volume-weighted CTR recomputed from summed bases (matching
    // aggregateExpression()/metaCampaignJourneyRows()), NOT avg(ctr) per-row.
    // avg(ctr) would weight every campaign×day equally regardless of impression
    // volume, so "top campaigns by CTR" would surface low-volume noise.
    return "sum(meta_ads_clicks) / nullif(sum(impressions), 0)";
  }
  return "sum(meta_ads_clicks)";
}

function journeyOrderDirection(plan: JourneyQueryPlan | undefined): "asc" | "desc" {
  return plan?.ranking?.direction === "asc" ? "asc" : "desc";
}

function timeRangeParams(plan: JourneyQueryPlan | undefined): { start: string | null; end: string | null } {
  if (!plan) {
    return { start: null, end: null };
  }
  return {
    start: validDateString(plan.timeRange?.start) ? plan.timeRange.start : null,
    end: validDateString(plan.timeRange?.end) ? plan.timeRange.end : null
  };
}

function validDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);
}

function evidenceHandleFor(metric: string, entityType: string): string {
  return `evidence:journey:${metric}:${entityType}`;
}

function compiledJourneyFromEvidenceHandle(evidenceHandleId: string): CompiledJourney | null {
  const [prefix, scope, metric, entityType] = evidenceHandleId.split(":");
  if (prefix !== "evidence" || scope !== "journey" || !metric || !entityType) {
    return null;
  }
  return compileJourneyPlan({
    intent: entityType === "channel" ? "compare_cohorts" : "rank_entities_by_outcome",
    actor: { grain: "person" },
    entity: { type: entityType as JourneyPlanEntityType },
    outcome: { id: metric },
    ranking: { metric, direction: "desc" },
    timeRange: { start: "1970-01-01", end: "2999-12-31" }
  });
}

function sourceIdsFromRows(rows: Record<string, unknown>[]): string[] {
  return [
    ...new Set(
      rows
        .flatMap((row) => {
          const sourceIds = row.source_ids ?? row.sourceIds;
          if (Array.isArray(sourceIds)) {
            return sourceIds;
          }
          return [row.source_id ?? row.sourceId];
        })
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    )
  ];
}

function answerForJourney(
  compiled: CompiledJourney,
  rows: Record<string, unknown>[],
  plan: JourneyQueryPlan
): string {
  if (rows.length === 0) {
    return "I did not find matching rows for that journey plan in the selected workspace and date range.";
  }
  const top = rows[0] ?? {};
  if (compiled.kind === "meta_campaign") {
    const label = String(top.campaign_name ?? top.campaign_id ?? "the top campaign");
    const value = top[compiled.metric] ?? top.meta_ads_clicks ?? "unknown";
    return `Meta Ads campaign ranking by ${compiled.metric}: ${label} is currently first with ${String(value)}. This is based on synced campaign/day insight rows for ${dateRangeSummary(plan)}.`;
  }
  if (compiled.kind === "x_content") {
    const label = conciseLabel(top.body_text ?? top.post_url ?? top.x_post_id ?? "the top post");
    const value = top.x_public_engagement ?? "unknown";
    return `X content ranking by public engagement: ${label} is currently first with ${String(value)} public engagements. This is based on synced public post metric rows for ${dateRangeSummary(plan)}.`;
  }
  const ordered = [...rows].sort((a, b) => numericValue(b.response_events) - numericValue(a.response_events));
  const label = String(ordered[0]?.channel ?? "the top channel");
  return `Channel comparison by response events: ${label} is currently ahead for ${dateRangeSummary(plan)}. Meta Ads uses clicks and X uses public engagement, so treat this as channel role comparison rather than true revenue attribution.`;
}

function dateRangeSummary(plan: JourneyQueryPlan): string {
  return `${plan.timeRange.start} to ${plan.timeRange.end}`;
}

function requiresDownstreamAttribution(plan: JourneyQueryPlan): boolean {
  const text = JSON.stringify(plan).toLowerCase();
  return [
    "customer",
    "paid",
    "purchase",
    "pipeline",
    "demo",
    "signup",
    "conversion",
    "ltv",
    "revenue",
    "churn"
  ].some((needle) => text.includes(needle));
}

function sanitizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(sanitizeEvidenceRow);
}

function sanitizeEvidenceRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(row).reduce<Record<string, unknown>>((acc, [key, value]) => {
    acc[key] = sanitizeEvidenceValue(key, value);
    return acc;
  }, {});
}

function sanitizeEvidenceValue(key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (/email|token|secret|credential|password|api[_-]?key|payload/i.test(key)) {
      return "[redacted]";
    }
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return "[redacted]";
    }
    return truncateString(value, key === "body_text" ? 500 : 240);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvidenceValue(key, entry));
  }
  if (isRecord(value)) {
    return sanitizeEvidenceRow(value);
  }
  return String(value);
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function conciseLabel(value: unknown): string {
  if (typeof value !== "string") {
    return String(value ?? "unknown");
  }
  return truncateString(value.replace(/\s+/g, " ").trim(), 90);
}

function numericValue(value: unknown): number {
  const parsed = numberValue(value);
  return parsed ?? 0;
}

async function connectSource(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown,
  encryptionKey?: string
): Promise<ActionEnvelope> {
  const provider = requiredProvider(input);
  const credentialKind = optionalString(input, "credentialKind") ?? defaultCredentialKind(provider);
  const oauthTokenId = optionalString(input, "oauthTokenId");
  const source = await db.connectSource({
    workspaceId: context.workspaceId,
    provider,
    connectionName: optionalString(input, "connectionName") ?? provider,
    accountExternalId: optionalString(input, "accountExternalId") ?? accountExternalIdFromPayload(provider, input),
    credentialKind,
    encryptedPayload: credentialPayloadForStorage(input, credentialKind, oauthTokenId, encryptionKey),
    oauthTokenId,
    // P1-2: the Meta account/pixel picker passes the chosen pixel here so CAPI dispatch has a target.
    // db.connectSource COALESCEs it on re-connect, so rotating the token never nulls a prior pixel.
    ...(optionalString(input, "selectedPixelId") ? { selectedPixelId: optionalString(input, "selectedPixelId") } : {}),
    actorType: context.authority
  });
  const connectionTest = await testConnectionForSource(db, context, provider, String(source.id), encryptionKey);
  const initialSync = await queueInitialSyncOnConnect(db, context, provider, String(source.id));
  return envelope("connect_source", context.authority, { source, connectionTest, initialSync }, ["sources"], "queued");
}

async function reconnectSource(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown,
  encryptionKey?: string
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const provider = await sourceProvider(db, context.workspaceId, sourceId);
  const credentialKind = optionalString(input, "credentialKind");
  const oauthTokenId = optionalString(input, "oauthTokenId");
  if (credentialKind || objectField(input, "credentialPayload") || optionalString(input, "encryptedPayload")) {
    const resolvedKind = credentialKind ?? defaultCredentialKind(provider);
    // Carry the Meta CAPI pixel forward across a token rotation: reconnect REVOKES the old row and
    // INSERTs a fresh one, so without this the prior selected_pixel_id would be silently wiped and
    // CAPI dispatch would lose its target. An explicit selectedPixelId in the input overrides.
    const priorPixel = await db.query(
      `select selected_pixel_id from connection_credentials
         where workspace_id = $1 and source_id = $2 and revoked_at is null
         order by created_at desc limit 1`,
      [context.workspaceId, sourceId]
    );
    const priorPixelVal = (priorPixel[0] as Record<string, unknown> | undefined)?.selected_pixel_id;
    const carriedPixelId =
      optionalString(input, "selectedPixelId") ??
      (typeof priorPixelVal === "string" && priorPixelVal !== "" ? priorPixelVal : undefined);
    await db.query(
      "update connection_credentials set revoked_at = now() where workspace_id = $1 and source_id = $2 and revoked_at is null",
      [context.workspaceId, sourceId]
    );
    await db.query(
      `
        insert into connection_credentials (
          id, workspace_id, source_id, credential_kind, encrypted_payload, oauth_token_id, selected_pixel_id
        )
        values ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        `cred_${randomUUID()}`,
        context.workspaceId,
        sourceId,
        resolvedKind,
        credentialPayloadForStorage(input, resolvedKind, oauthTokenId, encryptionKey),
        oauthTokenId ?? null,
        carriedPixelId ?? null
      ]
    );
  }
  await db.query(
    `
      update sources
      set status = 'connected', connected_at = now(),
        -- Reconnect restores health, so the transient-sync-failure streak (the counter that
        -- escalates a repeatedly-failing source to 'error' — migration 0044) starts over,
        -- including its time gate (migration 0045) so the next genuine failure episode
        -- counts its first strike instead of being swallowed by a stale timestamp.
        consecutive_sync_failures = 0,
        last_counted_sync_failure_at = null
      where workspace_id = $1 and id = $2
    `,
    [context.workspaceId, sourceId]
  );
  const connectionTest = await testConnectionForSource(db, context, provider, sourceId, encryptionKey);
  // RE-ASSERT `connected` AFTER a successful test. testConnectionForSource only returns on success
  // (it throws on any failure), so reaching here means the credential is good. The pre-test update
  // above already set `connected`, but a sync that was ALREADY in flight for this source when the
  // reconnect began could have finished and written a terminal `error` in the window between that
  // update and this test completing — leaving a genuinely-successful reconnect parked. This
  // idempotent re-assert lets the successful reconnect win that race (and re-clears the streak the
  // concurrent failure may have bumped). connected_at is intentionally NOT bumped again.
  await db.query(
    `
      update sources
      set status = 'connected',
        consecutive_sync_failures = 0,
        last_counted_sync_failure_at = null
      where workspace_id = $1 and id = $2
    `,
    [context.workspaceId, sourceId]
  );
  const initialSync = await queueInitialSyncOnConnect(db, context, provider, sourceId);
  return envelope(
    "reconnect_source",
    context.authority,
    { sourceId, status: "connected", connectionTest, initialSync },
    ["sources"]
  );
}

async function revokeSource(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  await db.query("update sources set status = 'revoked' where workspace_id = $1 and id = $2", [
    context.workspaceId,
    sourceId
  ]);
  await db.query(
    "update connection_credentials set revoked_at = now() where workspace_id = $1 and source_id = $2",
    [context.workspaceId, sourceId]
  );
  await db.query(
    `
      update sync_schedules
      set status = 'paused', paused_at = now(), paused_by_actor_type = $3, pause_reason = 'source revoked'
      where workspace_id = $1 and source_id = $2
    `,
    [context.workspaceId, sourceId, context.authority]
  );
  return envelope("revoke_source", context.authority, { sourceId, status: "revoked" }, ["sources"]);
}

async function startSourceSync(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const mode = optionalString(input, "mode") ?? optionalString(input, "syncMode") ?? "incremental";
  const refreshWindowDays = numberOrNull(input, "refreshWindowDays");
  const backfillWindow = optionalString(input, "backfillWindow");
  const payload = {
    sourceId,
    mode,
    ...(refreshWindowDays === null ? {} : { refreshWindowDays }),
    ...(backfillWindow ? { backfillWindow } : {})
  };
  const job = await db.createJob({
    workspaceId: context.workspaceId,
    jobType: mode === "backfill" ? "source_backfill" : "source_sync",
    payload
  });
  return envelope("start_source_sync", context.authority, { job }, ["job_runs"], "queued");
}

async function syncSourceNow(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown,
  encryptionKey?: string
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const provider = await sourceProvider(db, context.workspaceId, sourceId);
  const refreshWindowDays = boundedRefreshWindowDays(input, 1);
  const syncRunId = `sync_${randomUUID()}`;
  const result = await connectorFor(provider).sync(db, {
    workspaceId: context.workspaceId,
    sourceId,
    provider,
    syncRunId,
    refreshWindowDays,
    // Cloud 'Sync now': decrypt the stored credential under the per-workspace custody key.
    ...(encryptionKey ? { encryptionKey } : {})
  });
  await db.query(
    "update sync_schedules set last_completed_at = now() where workspace_id = $1 and source_id = $2",
    [context.workspaceId, sourceId]
  );
  await logTool(
    db,
    context,
    "sync_source_now",
    {
      sourceId,
      refreshWindowDays,
      reason: optionalString(input, "reason") ?? null
    },
    ["sync_runs", "sync_batches", "sync_cursors", "raw_records"],
    [],
    { provider, syncRunId, cursorKey: result.cursorKey },
    result.recordsLoaded
  );
  return envelope(
    "sync_source_now",
    context.authority,
    {
      sourceId,
      provider,
      syncRunId,
      refreshWindowDays,
      recordsExtracted: result.recordsExtracted,
      recordsLoaded: result.recordsLoaded,
      cursorKey: result.cursorKey,
      cursorValue: result.cursorValue
    },
    ["sources", "sync_runs", "sync_batches", "sync_cursors", "raw_records"],
    "ok",
    [],
    ["run_metric_query", "run_breakdown_query", "get_recent_sync_runs"]
  );
}

// ── Meta Ads management handlers (operator-only) ──────────────────────────────
// Every WRITE handler runs the connector write fn INLINE (the syncSourceNow
// pattern — NEVER db.createJob, so a money write never touches the worker's
// retry machinery), writes an integration_audit_log row with the token + raw
// budget/bid REDACTED, and (for creates) does a check-before-create dedup keyed
// by (workspace_id, source_id, client_token). The connector layer already
// enforces create-always-PAUSED + non-retryable writes; here we resolve the
// live credential, audit, and dedup.

// ATOMIC dedup against the dedicated meta_write_dedup table (migration 0028),
// keyed by (workspace_id, source_id, client_token) with a UNIQUE index. The old
// approach scanned integration_audit_log non-atomically (check-then-POST with no
// backing constraint), so two concurrent same-token creates could both POST and
// double-spend. Now we CLAIM the key BEFORE the Graph POST: the DB rejects a
// second concurrent claim, so exactly one create can POST.
//
// clientToken is OPTIONAL (opt-out): a tokenless create writes NO dedup row and
// is intentionally NOT deduped — the caller accepts that a retried tokenless
// create may POST twice. Only tokenful creates are atomic + idempotent.
interface MetaDedupClaim {
  // We won the claim (no prior row) → safe to POST. claimId backfilled on success.
  won: boolean;
  claimId: string | null;
  // The existing entity id when another claim already holds the key (deduped).
  existingId: string | null;
}

// Attempt to claim the dedup key. `insert ... on conflict do nothing returning`
// is atomic: at most one concurrent caller gets a row back. On conflict we read
// the existing row's entity_id (may be null if the winner is still mid-flight,
// in which case we still dedup to avoid a double-POST).
async function claimMetaDedup(
  db: InfiniteOsDb,
  workspaceId: string,
  sourceId: string,
  entity: MetaWriteEntity,
  clientToken: string | undefined
): Promise<MetaDedupClaim | undefined> {
  if (!clientToken) {
    // Opt-out: no token → no dedup row, no idempotency guarantee.
    return undefined;
  }
  const claimId = `mwd_${randomUUID()}`;
  const claimed = await db.one<{ id: string }>(
    `
      insert into meta_write_dedup (id, workspace_id, source_id, client_token, entity)
      values ($1, $2, $3, $4, $5)
      on conflict (workspace_id, source_id, client_token) do nothing
      returning id
    `,
    [claimId, workspaceId, sourceId, clientToken, entity]
  );
  if (claimed) {
    return { won: true, claimId: claimed.id, existingId: null };
  }
  // Lost the race (or a prior create already holds this token): return the
  // existing entity id (deduped). A null entity_id means the winner is still
  // mid-flight — we still dedup rather than risk a second POST.
  const existing = await db.one<{ entity_id: string | null }>(
    `
      select entity_id
      from meta_write_dedup
      where workspace_id = $1 and source_id = $2 and client_token = $3
      limit 1
    `,
    [workspaceId, sourceId, clientToken]
  );
  const existingId =
    typeof existing?.entity_id === "string" && existing.entity_id.trim() !== ""
      ? existing.entity_id
      : null;
  return { won: false, claimId: null, existingId };
}

// Backfill the claim row with the created entity id once the POST succeeds, so a
// later dedup hit can return the concrete id (not just "claimed").
async function resolveMetaDedup(
  db: InfiniteOsDb,
  claimId: string | null,
  entityId: string
): Promise<void> {
  if (!claimId) {
    return;
  }
  await db.query(
    `update meta_write_dedup set entity_id = $2, resolved_at = now() where id = $1`,
    [claimId, entityId]
  );
}

// Release an unresolved claim when the POST fails, so a transient failure does
// not permanently poison the token (a later retry with the same token can claim
// again). Only deletes rows still un-resolved (entity_id is null) to never drop a
// successful create's dedup record.
async function releaseMetaDedup(db: InfiniteOsDb, claimId: string | null): Promise<void> {
  if (!claimId) {
    return;
  }
  await db.query(`delete from meta_write_dedup where id = $1 and entity_id is null`, [claimId]);
}

// Write the operator audit row. details NEVER carries the access token and NEVER
// the raw budget/bid amounts — only budget_present:true (INV-6). The token only
// ever lives inside the resolved credential object passed to the connector.
async function metaAuditLog(
  db: InfiniteOsDb,
  context: SessionContext,
  sourceId: string,
  action: InfiniteOsActionId,
  status: "succeeded" | "failed",
  details: Record<string, unknown>
): Promise<void> {
  await db.query(
    `
      insert into integration_audit_log (id, workspace_id, source_id, actor_type, action, status, details)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      `audit_${randomUUID()}`,
      context.workspaceId,
      sourceId,
      context.authority,
      action,
      status,
      JSON.stringify(redactMetaAuditDetails(details))
    ]
  );
}

// Defence-in-depth redaction for the audit details blob: drop any secret-ish or
// raw-spend key (the handlers already build a redacted blob, but this guarantees
// a stray amount/token can never reach the durable row).
function redactMetaAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  // Drop access/secret tokens and raw spend, but DELIBERATELY keep client_token
  // (the dedup key the spec requires the audit row to record). The token-ish
  // patterns below intentionally exclude the literal "client_token".
  const SECRET_OR_SPEND =
    /access[_-]?token|secret|password|api[_-]?key|^daily_budget$|^lifetime_budget$|^bid_amount$|^dailyBudget$|^lifetimeBudget$|^bidAmount$/i;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key !== "client_token" && SECRET_OR_SPEND.test(key)) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

// Bucket budget/bid presence WITHOUT recording the amount (INV-6). The handler
// records budget_present / bid_present booleans only.
function metaBudgetPresence(input: unknown): {
  budget_present: boolean;
  bid_present: boolean;
} {
  // Presence reflects EITHER the minor-units key (dailyBudget/lifetimeBudget, cents) OR
  // the major-units key (dailyBudgetMajor/lifetimeBudgetMajor, dollars) so the audit's
  // budget_present flag stays honest regardless of which unit the caller used. Amount
  // is never recorded (INV-6) — only presence.
  const daily = numberOrNull(input, "dailyBudget") ?? numberOrNull(input, "dailyBudgetMajor");
  const lifetime = numberOrNull(input, "lifetimeBudget") ?? numberOrNull(input, "lifetimeBudgetMajor");
  const bid = numberOrNull(input, "bidAmount");
  return {
    budget_present: daily !== null || lifetime !== null,
    bid_present: bid !== null
  };
}

// ── Currency-aware budget conversion ────────────────────────────────────────────
// Meta ad budgets are integer MINOR units of the ad-account currency. The minor-unit
// exponent is NOT always 2: zero-decimal currencies (JPY, KRW, …) are ×1 and a few are
// ×1000 (KWD, BHD, …). Converting a MAJOR-unit budget (e.g. dollars) with a hard-coded
// ×100 would be a 100× budget error on a JPY account, so we use the per-currency ISO-4217
// minor-unit exponent; anything unlisted defaults to 2 (USD/EUR/GBP/…). Keys are lowercase
// ISO codes to match the warehouse dimension (currency is stored lowercased).
const CURRENCY_MINOR_UNIT_EXPONENT: Record<string, number> = {
  // zero-decimal (×1)
  bif: 0, clp: 0, djf: 0, gnf: 0, isk: 0, jpy: 0, kmf: 0, krw: 0, pyg: 0,
  rwf: 0, ugx: 0, vnd: 0, vuv: 0, xaf: 0, xof: 0, xpf: 0,
  // three-decimal (×1000)
  bhd: 3, iqd: 3, jod: 3, kwd: 3, lyd: 3, omr: 3, tnd: 3
};

function currencyMinorUnitExponent(currencyCode: string): number {
  return CURRENCY_MINOR_UNIT_EXPONENT[currencyCode.trim().toLowerCase()] ?? 2;
}

// Convert a MAJOR-unit budget (e.g. 500 dollars) to integer MINOR units (e.g. 50000
// cents) using the ad-account currency. Rejects a non-finite/negative amount and any
// result that is not a safe non-negative integer, so a bad conversion is a HARD ERROR,
// never a silent 100× spend instruction. (Creates always land PAUSED, but we still
// refuse to emit a wrong number.)
function majorBudgetToMinorUnits(major: number, currencyCode: string): number {
  if (!Number.isFinite(major) || major < 0) {
    throw new Error(`invalid_budget_major:${major}`);
  }
  const exponent = currencyMinorUnitExponent(currencyCode);
  const minor = Math.round(major * 10 ** exponent);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new Error(`invalid_budget_major:${major}`);
  }
  return minor;
}

// Resolve the ad-account currency (ISO code, lowercased) for a connected Meta source so
// a MAJOR-unit budget can be converted to the account's minor units. Source of truth =
// the synced warehouse dimension (meta_ads_campaigns.currency, populated from Meta's own
// `account_currency` insights field). Returns null when unknown — a fresh/unsynced account
// or a pathological multi-currency result — so the caller REFUSES the major-unit path
// rather than guessing a currency (guessing risks a 100× error). Reading Meta's own
// value keeps this byte-clear of the write transport / CLI.
async function resolveMetaAccountCurrency(
  db: InfiniteOsDb,
  context: SessionContext,
  sourceId: string
): Promise<string | null> {
  const rows = await db.query<{ currency: string | null }>(
    "select distinct currency from meta_ads_campaigns where workspace_id = $1 and source_id = $2 and currency is not null",
    [context.workspaceId, sourceId]
  );
  const distinct = Array.from(
    new Set(
      rows
        .map((row) => (typeof row.currency === "string" ? row.currency.trim().toLowerCase() : ""))
        .filter((code) => code.length > 0)
    )
  );
  // Exactly one known currency → use it. Zero (unsynced) or >1 (pathological) → unknown.
  return distinct.length === 1 ? distinct[0] : null;
}

// Resolve the Meta source for a WRITE. An explicit sourceId (back-compat / programmatic
// callers like the Ads Intelligence console) always wins; otherwise auto-resolve the
// workspace's SOLE connected Meta source so ⌘L never plumbs a source id. Zero → typed
// not-connected error; >1 → typed ambiguity error (we never silently pick between two
// real accounts). resolveSoleConnectedMetaSourceId already enforces both.
async function resolveMetaWriteSourceId(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<string> {
  return optionalString(input, "sourceId") ?? (await resolveSoleConnectedMetaSourceId(db, context));
}

interface ResolvedMetaBudgets {
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  // Uppercased ISO currency the *Major amounts were converted with — surfaced back to the
  // caller (⌘L confirm) so "$500/day" can be confirmed. null when no major amount was used.
  budgetCurrency: string | null;
}

// Resolve a create's daily/lifetime budgets to integer MINOR units, accepting EITHER the
// existing minor-units key (dailyBudget/lifetimeBudget, cents — back-compat) OR the new
// major-units key (dailyBudgetMajor/lifetimeBudgetMajor, dollars — the ⌘L path). The two
// keys for a given budget are MUTUALLY EXCLUSIVE: passing both is a hard error so an
// existing cents caller can never be silently double-converted (the 100× guard). The major
// path converts with the ACCOUNT currency; an unknown currency is refused (no guessing).
async function resolveMetaCreateBudgets(
  db: InfiniteOsDb,
  context: SessionContext,
  sourceId: string,
  input: unknown
): Promise<ResolvedMetaBudgets> {
  const dailyMinor = numberOrNull(input, "dailyBudget");
  const lifetimeMinor = numberOrNull(input, "lifetimeBudget");
  const dailyMajor = numberOrNull(input, "dailyBudgetMajor");
  const lifetimeMajor = numberOrNull(input, "lifetimeBudgetMajor");

  // No dollar amount at all → pure back-compat minor-units path; currency not needed.
  if (dailyMajor === null && lifetimeMajor === null) {
    return { dailyBudget: dailyMinor, lifetimeBudget: lifetimeMinor, budgetCurrency: null };
  }

  if (dailyMinor !== null && dailyMajor !== null) {
    throw new Error("budget_units_ambiguous: pass EITHER dailyBudget (cents) OR dailyBudgetMajor (dollars), not both");
  }
  if (lifetimeMinor !== null && lifetimeMajor !== null) {
    throw new Error("budget_units_ambiguous: pass EITHER lifetimeBudget (cents) OR lifetimeBudgetMajor (dollars), not both");
  }

  const currency = await resolveMetaAccountCurrency(db, context, sourceId);
  if (!currency) {
    throw new Error(
      "meta_account_currency_unknown: cannot convert a dollar budget without the ad-account currency; sync the account first or pass the budget in minor units (cents)"
    );
  }
  return {
    dailyBudget: dailyMajor === null ? dailyMinor : majorBudgetToMinorUnits(dailyMajor, currency),
    lifetimeBudget: lifetimeMajor === null ? lifetimeMinor : majorBudgetToMinorUnits(lifetimeMajor, currency),
    budgetCurrency: currency.toUpperCase()
  };
}

async function resolveMetaCredentialForWrite(
  db: InfiniteOsDb,
  context: SessionContext,
  sourceId: string
): Promise<MetaAdsCredential> {
  // Pin the source to meta_ads before touching the Graph API (a non-Meta source
  // id must never reach the write transport).
  const provider = await sourceProvider(db, context.workspaceId, sourceId);
  if (provider !== "meta_ads") {
    throw new Error(`source_provider_mismatch:expected meta_ads got ${provider}`);
  }
  // DEFENSE-IN-DEPTH (P0-A, redundant no-op): the real confused-deputy control lives in
  // the confirm path (chat_action_calls.workspace_id + workspace-scoped getPending/confirm
  // + fail-closed `confirmation_workspace_mismatch` on both the HTTP and CLI surfaces).
  // A project-pin assertion HERE is structurally tautological: `sourceProvider` above
  // already does `select provider from sources where workspace_id = $1 and id = $2` with
  // $1 = context.workspaceId, so any source it resolves is — by construction — in
  // context.workspaceId; a sourceId belonging to another workspace throws
  // `source_not_found` before this point and never reaches the Graph transport. There is
  // no reachable state in which the resolved credential's workspace differs from
  // context.workspaceId, so this is left as a documented invariant rather than a tested
  // violation path (its acceptance test would be structurally unreachable). The pinning
  // that actually closes the hole is enforced upstream at confirmation time.
  return resolveMetaAdsCredential(db, {
    workspaceId: context.workspaceId,
    sourceId
  });
}

// Shared create flow: dedup-check → INLINE connector POST → audit. The connector
// fn already hard-codes status:PAUSED and is non-retryable; we add the
// durable dedup + audit-log around it. On dedup hit we short-circuit (no POST).
async function runMetaCreate(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown,
  // Resolved by the caller (explicit sourceId, else the workspace's sole connected Meta
  // source) so ⌘L never needs to plumb a source id. runMetaCreate no longer reads it from input.
  sourceId: string,
  action: InfiniteOsActionId,
  entity: MetaWriteEntity,
  write: (credential: MetaAdsCredential) => Promise<MetaWriteResult>,
  // Optional extra fields merged into the SUCCESS envelope data (never the audit) — e.g.
  // { budgetCurrency } so the caller can confirm "$500/day (USD)" back to the user.
  extra?: Record<string, unknown>
): Promise<ActionEnvelope> {
  const clientToken = optionalString(input, "clientToken");
  const presence = metaBudgetPresence(input);

  // INVARIANT 4: ATOMIC claim-before-create. Claiming the dedup key first means a
  // concurrent same-token create gets a unique violation and never POSTs. On a
  // dedup hit we return the existing id with deduped:true and never POST again.
  const claim = await claimMetaDedup(db, context.workspaceId, sourceId, entity, clientToken);
  if (claim && !claim.won) {
    const existingId = claim.existingId;
    await metaAuditLog(db, context, sourceId, action, "succeeded", {
      action,
      entity,
      entity_id: existingId,
      client_token: clientToken ?? null,
      status: entity === "creative" ? null : "PAUSED",
      deduped: true,
      ...presence
    });
    return envelope(
      action,
      context.authority,
      { entity, id: existingId, status: entity === "creative" ? null : "PAUSED", deduped: true, clientToken: clientToken ?? null, ...(extra ?? {}) },
      ["integration_audit_log"],
      "ok"
    );
  }

  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  let result: MetaWriteResult;
  try {
    result = await write(credential);
  } catch (error) {
    // Release the un-resolved claim so a transient failure does not poison the
    // token (a later retry with the same token can claim again).
    await releaseMetaDedup(db, claim?.claimId ?? null);
    // INVARIANT 1/6 REMEDIATION: a money_safety_violation means the create unexpectedly landed
    // ACTIVE — the entity is ALREADY live and spending, and throwing only stops OUR flow, not
    // Meta's spend. The connector stamps the violating entity id onto the error; attempt a
    // best-effort PAUSE (pausing only REDUCES spend, so it needs no confirm gate) and swallow any
    // pause error so it never masks the original violation. Record the entity id + outcome in the
    // audit so an operator can verify. A normal (non-violation) failure skips all of this.
    const violatedId =
      metaErrorCode(error) === "money_safety_violation" && error && typeof error === "object"
        ? (typeof (error as { entityId?: unknown }).entityId === "string"
            ? ((error as { entityId?: string }).entityId as string)
            : undefined)
        : undefined;
    let remediationPaused: boolean | undefined;
    if (violatedId) {
      try {
        await setMetaEntityStatus(credential, violatedId, "PAUSED", entity);
        remediationPaused = true;
      } catch {
        remediationPaused = false; // best-effort only — the audit row flags it for manual follow-up
      }
    }
    // INVARIANT 1/6: audit a failure (incl. a money_safety_violation when Graph
    // echoed ACTIVE) WITHOUT the token or raw spend, then surface the error.
    await metaAuditLog(db, context, sourceId, action, "failed", {
      action,
      entity,
      client_token: clientToken ?? null,
      error_code: metaErrorCode(error),
      deduped: false,
      ...(violatedId
        ? { entity_id: violatedId, money_safety_violation: true, remediation_paused: remediationPaused }
        : {}),
      ...presence
    });
    throw error;
  }

  // POST succeeded — backfill the claim row with the concrete entity id so a
  // later dedup hit returns the id (not just "claimed").
  await resolveMetaDedup(db, claim?.claimId ?? null, result.id);

  await metaAuditLog(db, context, sourceId, action, "succeeded", {
    action,
    entity,
    entity_id: result.id,
    client_token: clientToken ?? null,
    status: result.status,
    deduped: false,
    ...presence
  });

  return envelope(
    action,
    context.authority,
    { entity, id: result.id, status: result.status, deduped: false, clientToken: clientToken ?? null, ...(extra ?? {}) },
    ["integration_audit_log"],
    "ok"
  );
}

function metaErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return "write_failed";
}

async function createMetaCampaignHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const name = requiredString(input, "name");
  const objective = requiredString(input, "objective");
  const sourceId = await resolveMetaWriteSourceId(db, context, input);
  const budgets = await resolveMetaCreateBudgets(db, context, sourceId, input);
  return runMetaCreate(
    db,
    context,
    input,
    sourceId,
    "create_meta_campaign",
    "campaign",
    (credential) =>
      createMetaCampaign(credential, {
        name,
        objective,
        ...(budgets.dailyBudget === null ? {} : { dailyBudget: budgets.dailyBudget }),
        ...(budgets.lifetimeBudget === null ? {} : { lifetimeBudget: budgets.lifetimeBudget })
      }),
    budgets.budgetCurrency ? { budgetCurrency: budgets.budgetCurrency } : undefined
  );
}

async function createMetaAdSetHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const campaignId = requiredString(input, "campaignId");
  const name = requiredString(input, "name");
  const optimizationGoal = requiredString(input, "optimizationGoal");
  const billingEvent = requiredString(input, "billingEvent");
  const sourceId = await resolveMetaWriteSourceId(db, context, input);
  const budgets = await resolveMetaCreateBudgets(db, context, sourceId, input);
  const bidAmount = numberOrNull(input, "bidAmount");
  const targetingCountries = stringArray(input, "targetingCountries");
  return runMetaCreate(
    db,
    context,
    input,
    sourceId,
    "create_meta_ad_set",
    "adset",
    (credential) =>
      createMetaAdSet(credential, {
        campaignId,
        name,
        optimizationGoal,
        billingEvent,
        ...(budgets.dailyBudget === null ? {} : { dailyBudget: budgets.dailyBudget }),
        ...(budgets.lifetimeBudget === null ? {} : { lifetimeBudget: budgets.lifetimeBudget }),
        ...(bidAmount === null ? {} : { bidAmount }),
        ...(optionalString(input, "startTime") ? { startTime: optionalString(input, "startTime") } : {}),
        ...(optionalString(input, "endTime") ? { endTime: optionalString(input, "endTime") } : {}),
        ...(targetingCountries.length > 0 ? { targetingCountries } : {}),
        ...(optionalString(input, "pixelId") ? { pixelId: optionalString(input, "pixelId") } : {}),
        ...(optionalString(input, "customEventType") ? { customEventType: optionalString(input, "customEventType") } : {})
      }),
    budgets.budgetCurrency ? { budgetCurrency: budgets.budgetCurrency } : undefined
  );
}

async function createMetaCreativeHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const name = requiredString(input, "name");
  const pageId = requiredString(input, "pageId");
  const sourceId = await resolveMetaWriteSourceId(db, context, input);
  return runMetaCreate(db, context, input, sourceId, "create_meta_creative", "creative", (credential) =>
    createMetaCreative(credential, {
      name,
      pageId,
      ...(optionalString(input, "imageHash") ? { imageHash: optionalString(input, "imageHash") } : {}),
      ...(optionalString(input, "imageUrl") ? { imageUrl: optionalString(input, "imageUrl") } : {}),
      ...(optionalString(input, "videoUrl") ? { videoUrl: optionalString(input, "videoUrl") } : {}),
      ...(optionalString(input, "instagramUserId") ? { instagramUserId: optionalString(input, "instagramUserId") } : {}),
      ...(optionalString(input, "linkUrl") ? { linkUrl: optionalString(input, "linkUrl") } : {}),
      ...(optionalString(input, "body") ? { body: optionalString(input, "body") } : {}),
      ...(optionalString(input, "title") ? { title: optionalString(input, "title") } : {}),
      ...(optionalString(input, "description") ? { description: optionalString(input, "description") } : {}),
      ...(optionalString(input, "callToAction") ? { callToAction: optionalString(input, "callToAction") } : {})
    })
  );
}

async function createMetaAdHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const adsetId = requiredString(input, "adsetId");
  const name = requiredString(input, "name");
  const creativeId = requiredString(input, "creativeId");
  const sourceId = await resolveMetaWriteSourceId(db, context, input);
  return runMetaCreate(db, context, input, sourceId, "create_meta_ad", "ad", (credential) =>
    createMetaAd(credential, { adsetId, name, creativeId })
  );
}

// Status transition (activate/pause). The CLI/operator confirm gates (incl. the
// stricter typed-confirm for activate) live above this layer; here we perform
// the transition INLINE and audit it. activate/pause are naturally idempotent at
// Meta but still operator-gated + audited.
// Read + validate the optional entity-kind hint from an action input. Returns the
// narrowed MetaWriteEntity (campaign|adset|ad) or undefined. Used both for audit
// rows and to select the CLI update/delete subcommand. Throws on an unknown value
// so a typo surfaces here rather than as an opaque CLI failure.
function metaWriteEntityFromInput(input: unknown): MetaWriteEntity | undefined {
  const raw = optionalString(input, "entity");
  if (!raw) {
    return undefined;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "campaign" || normalized === "adset" || normalized === "ad") {
    return normalized;
  }
  throw new Error(`unsupported_meta_entity:${raw}`);
}

// REQUIRED-entity variant (review): set_meta_entity_status and delete_meta_entity now
// require `entity` so the failure is uniform + EARLY regardless of transport (the CLI
// path needs it to select the subcommand; the Graph path tolerates its absence but we
// reject it uniformly). Throws if missing or unrecognized.
function requiredMetaWriteEntity(input: unknown): MetaWriteEntity {
  const raw = requiredString(input, "entity").toLowerCase();
  if (raw === "campaign" || raw === "adset" || raw === "ad") {
    return raw;
  }
  throw new Error(`unsupported_meta_entity:${raw}`);
}

// Budget writes are campaign|adset ONLY — Meta has no ad-level (or creative-level)
// budget. Require + narrow so "ad"/"creative"/anything-else fails EARLY here (before
// the credential resolve and Graph POST) with a clear, transport-agnostic message.
// The connector re-checks this as defense-in-depth.
function requiredMetaBudgetEntity(input: unknown): "campaign" | "adset" {
  const raw = requiredString(input, "entity").toLowerCase();
  if (raw === "campaign" || raw === "adset") {
    return raw;
  }
  throw new Error(`unsupported_meta_budget_entity:${raw}`);
}

// A budget update requires a POSITIVE integer amount in the ad-account minor units
// (cents). Read + validate BEFORE resolving the credential so 0 / negative /
// non-integer / missing fails early and uniformly. The connector re-validates this
// (defense-in-depth) as the authoritative money-safety gate.
function requiredPositiveBudgetCents(input: unknown): number {
  const value = numberOrNull(input, "dailyBudget");
  if (value === null) {
    throw new Error("dailyBudget is required");
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_daily_budget:${value}`);
  }
  return value;
}

async function setMetaEntityStatusHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const entityId = requiredString(input, "entityId");
  const status = requiredString(input, "status").toUpperCase();
  if (status !== "ACTIVE" && status !== "PAUSED") {
    throw new Error(`unsupported_meta_status:${status}`);
  }
  // REQUIRED (review): the entity token (campaign|adset|ad) selects the CLI update
  // subcommand. Required uniformly so the failure is early + transport-agnostic.
  const entity = requiredMetaWriteEntity(input);
  // ACTIVATION GATE (money-safety, transport-agnostic): going ACTIVE is the only money-SPENDING
  // transition. Require an explicit confirmation that NAMES this entity (confirmActivation ===
  // entityId), so a bare/accidental request on ANY surface (HTTP /meta/status, /tools/call, CLI)
  // cannot take an entity live and start spending. PAUSED (spend-reducing) needs none. The desktop
  // sets confirmActivation after a deliberate gesture (press-and-hold); the CLI after its typed-
  // confirm. Reject BEFORE resolving the credential or POSTing — no spend on an unconfirmed activate.
  if (status === "ACTIVE" && optionalString(input, "confirmActivation") !== entityId) {
    throw new Error(`activation_requires_confirmation:${entityId}`);
  }
  const action: InfiniteOsActionId = "set_meta_entity_status";
  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  let result;
  try {
    result = await setMetaEntityStatus(credential, entityId, status as MetaEntityStatus, entity);
  } catch (error) {
    await metaAuditLog(db, context, sourceId, action, "failed", {
      action,
      entity_id: entityId,
      requested_status: status,
      error_code: metaErrorCode(error),
      // Flag the spend-bearing transition for auditors even on failure.
      activation: status === "ACTIVE"
    });
    throw error;
  }
  await metaAuditLog(db, context, sourceId, action, "succeeded", {
    action,
    entity_id: entityId,
    requested_status: status,
    status: result.status,
    activation: status === "ACTIVE"
  });
  return envelope(
    action,
    context.authority,
    { id: result.id, status: result.status, activation: status === "ACTIVE" },
    ["integration_audit_log"],
    "ok"
  );
}

// Budget update (scale / reduce / reallocate). Operator-only. Changes the daily
// budget of an EXISTING campaign or ad set INLINE (never db.createJob — a money
// write never touches the worker's retry machinery) and audits it. MONEY-SAFETY:
// this NEVER changes delivery status — the connector POSTs daily_budget only, so an
// active entity keeps spending at the new budget and a paused one stays paused;
// there is no activation gate/bookkeeping because a budget change is not a go-live.
// The audit records budget_present (a boolean) ONLY — never the raw amount (INV-6).
async function updateMetaBudgetHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const entityId = requiredString(input, "entityId");
  // campaign|adset ONLY (Meta has no ad-level budget) — rejects "ad"/"creative" early.
  const entity = requiredMetaBudgetEntity(input);
  // POSITIVE integer cents, validated before any credential resolve or POST.
  const dailyBudget = requiredPositiveBudgetCents(input);
  const action: InfiniteOsActionId = "update_meta_budget";
  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  let result;
  try {
    result = await updateMetaBudget(credential, entityId, dailyBudget, entity);
  } catch (error) {
    await metaAuditLog(db, context, sourceId, action, "failed", {
      action,
      entity,
      entity_id: entityId,
      // Presence only — the amount is NEVER recorded (INV-6). Belt-and-suspenders:
      // redactMetaAuditDetails also drops any daily_budget/dailyBudget key.
      budget_present: true,
      error_code: metaErrorCode(error)
    });
    throw error;
  }
  await metaAuditLog(db, context, sourceId, action, "succeeded", {
    action,
    entity,
    entity_id: entityId,
    budget_present: true
  });
  return envelope(
    action,
    context.authority,
    { id: result.id, entity: result.entity, updated: true },
    ["integration_audit_log"],
    "ok"
  );
}

// Destructive cleanup (DELETE /{id}). Operator-only + irreversible. Runs the
// connector delete INLINE (the syncSourceNow pattern — NEVER db.createJob, so a
// destructive write never touches the worker's retry machinery), and writes an
// integration_audit_log row with the token redacted. The connector layer makes
// the DELETE non-retryable; the CLI's destructive confirm gate lives above this
// layer. Does NOT spend, so there is no dedup/activation bookkeeping.
async function deleteMetaEntityHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const entityId = requiredString(input, "entityId");
  // REQUIRED (review): the entity-kind is used for the audit row AND (for the CLI
  // transport) to select the `meta ads <entity> delete` subcommand. Required uniformly
  // so the failure is early + transport-agnostic.
  const entity = requiredMetaWriteEntity(input);
  const action: InfiniteOsActionId = "delete_meta_entity";
  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  let result;
  try {
    result = await deleteMetaEntity(credential, entityId, entity);
  } catch (error) {
    await metaAuditLog(db, context, sourceId, action, "failed", {
      action,
      entity,
      entity_id: entityId,
      error_code: metaErrorCode(error)
    });
    throw error;
  }
  await metaAuditLog(db, context, sourceId, action, "succeeded", {
    action,
    entity,
    entity_id: entityId,
    deleted: result.deleted
  });
  return envelope(
    action,
    context.authority,
    { id: result.id, deleted: result.deleted, entity },
    ["integration_audit_log"],
    "ok"
  );
}

// Reads — no money movement, no audit row, normal retryable taxonomy.
// list_meta_assets — enumerate the ad accounts + pixels a RAW (system-user) token can see, so the
// desktop connect flow can populate the account/pixel picker AND validate the token BEFORE binding.
// READ authority (no money movement, no source mutation): the token arrives in the input over
// loopback, exactly as connect_source receives it. A token that resolves zero accounts/businesses
// surfaces a clear error so the desktop never binds an asset-less credential.
async function listMetaAssetsHandler(
  _db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const accessToken = requiredString(input, "accessToken");
  const businessId = optionalString(input, "businessId");
  const apiVersion = optionalString(input, "apiVersion");
  const assets = await listMetaAssets(accessToken, {
    ...(businessId ? { businessId } : {}),
    ...(apiVersion ? { apiVersion } : {})
  });
  if (assets.adAccounts.length === 0) {
    throw new Error(
      "no_meta_ad_accounts: the token sees no ad accounts. For a system-user token, confirm it has " +
        "the ads_management + business_management scopes and is assigned the ad account in Business Settings."
    );
  }
  return envelope(
    "list_meta_assets",
    context.authority,
    {
      tokenKind: assets.tokenKind,
      adAccounts: assets.adAccounts,
      pixels: assets.pixels,
      businesses: assets.businesses,
      pixelsByAccount: assets.pixelsByAccount
    },
    ["provider_truth"],
    "ok"
  );
}

async function listMetaEntitiesHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const entity = requiredString(input, "entity") as MetaWriteEntity;
  if (!["campaign", "adset", "ad", "creative"].includes(entity)) {
    throw new Error(`unsupported_meta_entity:${entity}`);
  }
  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  const limit = numberOrNull(input, "limit") ?? undefined;
  const fields = optionalString(input, "fields");
  const entities = await listMetaEntities(credential, entity, {
    ...(limit === undefined ? {} : { limit }),
    ...(fields ? { fields } : {})
  });
  return envelope(
    "list_meta_entities",
    context.authority,
    { entity, entities, count: entities.length },
    ["provider_truth"],
    "ok"
  );
}

async function getMetaEntityHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const entityId = requiredString(input, "entityId");
  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  const fields = optionalString(input, "fields");
  // FIX 1: thread the entity-kind hint so `get` requests the SAME full field set
  // as `list` for the object type (campaign/adset/ad/creative) instead of
  // degrading to Graph's id-only node. An explicit `fields` still overrides.
  const entityKind = optionalString(input, "entity") as MetaWriteEntity | undefined;
  const entity = await getMetaEntity(credential, entityId, {
    ...(fields ? { fields } : {}),
    ...(entityKind ? { entity: entityKind } : {})
  });
  return envelope(
    "get_meta_entity",
    context.authority,
    { id: entityId, entity },
    ["provider_truth"],
    "ok"
  );
}

// ── run_meta_live_insights — LIVE Meta insights read (tool_agent authority) ─────────────────
// The ⌘L answer path for Meta performance questions ("my best ad?", spend/ROAS by campaign).
// Meta is a PERMANENTLY-LOCAL connector: its rows are never synced into the warehouse tables, so the
// governed metric/breakdown reads honestly return nothing for meta_* on cloud workspaces. This
// action reads Meta insights LIVE through the connector's SHIPPED read machinery instead
// (fetchMetaLiveInsights — the same three-way transport selection as the sync path: MCP,
// ambient-auth meta CLI, direct Graph with a stored token, per PR #74) — provider truth,
// aggregated over the requested window, canonical conversion semantics identical to the synced
// warehouse. READ-ONLY by construction: only insights READS are reachable from here (a Graph
// GET or the CLI's `insights get` subcommand); no write/status/budget surface exists on this
// path, and the CLI write lanes are untouched.

// Bounded vocabularies — enums, not free-form strings, so the action can never be steered to an
// arbitrary Graph edge or preset.
const META_LIVE_INSIGHTS_LEVELS = new Set(["campaign", "adset", "ad"]);
const META_LIVE_INSIGHTS_DATE_PRESETS = new Set([
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_30d",
  "this_month",
  "last_month",
  "maximum"
]);
const META_LIVE_INSIGHTS_ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const META_LIVE_INSIGHTS_DEFAULT_LIMIT = 100;
const META_LIVE_INSIGHTS_MAX_LIMIT = 200;

// Resolve the workspace's single connected meta_ads source when the caller omits sourceId —
// the ⌘L tool never knows source ids. Zero sources → typed not-connected error; more than one →
// typed ambiguity error naming the candidates (the caller retries with an explicit sourceId).
async function resolveSoleConnectedMetaSourceId(
  db: InfiniteOsDb,
  context: SessionContext
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "select id from sources where workspace_id = $1 and provider = 'meta_ads' and status = 'connected' order by connected_at desc",
    [context.workspaceId]
  );
  if (rows.length === 0) {
    throw new Error("meta_ads_not_connected: no connected Meta Ads source in this workspace");
  }
  if (rows.length > 1) {
    throw new Error(
      `meta_ads_source_ambiguous: multiple connected Meta Ads sources (${rows
        .map((row) => row.id)
        .join(", ")}); pass sourceId`
    );
  }
  return rows[0].id;
}

async function runMetaLiveInsightsHandler(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId =
    optionalString(input, "sourceId") ?? (await resolveSoleConnectedMetaSourceId(db, context));
  const level = optionalString(input, "level") ?? "ad";
  if (!META_LIVE_INSIGHTS_LEVELS.has(level)) {
    throw new Error(`unsupported_meta_level:${level}`);
  }
  const since = optionalString(input, "since");
  const until = optionalString(input, "until");
  if ((since === undefined) !== (until === undefined)) {
    throw new Error("invalid_date_range: since and until must be provided together");
  }
  let timeRange: { since: string; until: string } | undefined;
  let datePreset: string | undefined;
  if (since !== undefined && until !== undefined) {
    if (!META_LIVE_INSIGHTS_ISO_DAY.test(since) || !META_LIVE_INSIGHTS_ISO_DAY.test(until)) {
      throw new Error("invalid_date_range: since/until must be YYYY-MM-DD");
    }
    if (since > until) {
      throw new Error(`invalid_date_range: since ${since} is after until ${until}`);
    }
    timeRange = { since, until };
  } else {
    datePreset = optionalString(input, "datePreset") ?? "last_30d";
    if (!META_LIVE_INSIGHTS_DATE_PRESETS.has(datePreset)) {
      throw new Error(`unsupported_meta_date_preset:${datePreset}`);
    }
  }
  const requestedLimit = numberOrNull(input, "limit");
  const limit = Math.min(
    Math.max(Math.trunc(requestedLimit ?? META_LIVE_INSIGHTS_DEFAULT_LIMIT), 1),
    META_LIVE_INSIGHTS_MAX_LIMIT
  );
  // Same resolver as every meta read/write: pins provider === meta_ads inside the workspace,
  // then decrypts the stored credential. (Despite the name it is the READ resolver too.)
  const credential = await resolveMetaCredentialForWrite(db, context, sourceId);
  const { rows, totalRows, truncated } = await fetchMetaLiveInsights(credential, {
    level: level as "campaign" | "adset" | "ad",
    ...(timeRange ? { timeRange } : { datePreset }),
    limit
  });
  // A read: no integration_audit_log row, normal retryable taxonomy (same stance as list/get).
  return envelope(
    "run_meta_live_insights",
    context.authority,
    {
      level,
      window: timeRange ?? { datePreset },
      rows,
      count: rows.length,
      totalRows
    },
    ["provider_truth"],
    "ok",
    [
      "Live Graph API read (provider truth, not the synced warehouse); rows are whole-window aggregates sorted by spend desc.",
      ...(truncated
        ? [`Truncated to the top ${rows.length} of ${totalRows} rows by spend; raise limit or narrow the window for the rest.`]
        : [])
    ]
  );
}

async function updateSourceSchedule(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const scheduleKind = optionalString(input, "scheduleKind") ?? "manual_only";
  const interval = intervalFor(scheduleKind);
  const row = await db.one(
    `
      update sync_schedules
      set schedule_kind = $3, interval_minutes = $4, sync_mode = $5,
        refresh_window_days = $6, stale_after_minutes = $7,
        status = 'active', updated_at = now(),
        next_run_at = case when $3 = 'manual_only' then null else now() end
      where workspace_id = $1 and source_id = $2
      returning *
    `,
    [
      context.workspaceId,
      sourceId,
      scheduleKind,
      interval,
      optionalString(input, "syncMode") ?? "incremental",
      numberOrNull(input, "refreshWindowDays"),
      numberOrNull(input, "staleAfterMinutes") ?? 1440
    ]
  );
  return envelope("update_source_schedule", context.authority, { schedule: row }, ["sync_schedules"]);
}

async function pauseSourceSchedule(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const row = await db.one(
    `
      update sync_schedules
      set status = 'paused', paused_at = now(), paused_by_actor_type = $3,
        pause_reason = $4, updated_at = now()
      where workspace_id = $1 and source_id = $2
      returning *
    `,
    [context.workspaceId, sourceId, context.authority, optionalString(input, "reason") ?? null]
  );
  return envelope("pause_source_schedule", context.authority, { schedule: row }, ["sync_schedules"]);
}

async function resumeSourceSchedule(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const sourceId = requiredString(input, "sourceId");
  const row = await db.one(
    `
      update sync_schedules
      set status = 'active', paused_at = null, paused_by_actor_type = null,
        pause_reason = null, updated_at = now()
      where workspace_id = $1 and source_id = $2
      returning *
    `,
    [context.workspaceId, sourceId]
  );
  return envelope("resume_source_schedule", context.authority, { schedule: row }, ["sync_schedules"]);
}

async function runMetricQuery(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const metric = requiredString(input, "metric");
  // §5a — grain-aware default. run_metric_query has NO group-by, but a filter MAY carry an
  // adset dim (e.g. "CPL for adset X" with no breakdown), so we still pass the filters through
  // the resolver. With no adset dim present this returns metricView(metric) — the campaign
  // default — so non-adset metric queries are unchanged.
  // The METRIC_SET gate runs BEFORE view resolution: a typo'd metric keeps the `unsupported_metric:`
  // contract, and metricView's `unknown_metric:` is reserved for a METRIC_SET member with no branch.
  rejectUnsupportedMetric(metric);
  const view = optionalString(input, "view") ?? metricViewForGrain(metric, [], filtersFrom(input));
  rejectUnsafeView(view);
  rejectMetricViewMismatch(metric, view);
  if (metric === "x_follower_count") {
    await backfillXFollowerSnapshotIfNeeded(db, context);
  }
  // PR3 Step 14 — per-site isolation: resolve {site} -> source_id filter before aggregating.
  const resolvedSourceId = await applySiteFilter(db, context.workspaceId, input);
  const rows = await runAggregate(db, context.workspaceId, view, metric, input, []);
  const noData = await classifyGa4NoData(db, context.workspaceId, view, metric, rows, input, resolvedSourceId);
  // CONFIRMED-ZERO WINDOW (2026-08-24) — freshness is hoisted so the coalesce decision and
  // the envelope's freshness claim share ONE signal (never two reads that could diverge).
  // When a sum-type metric's window is empty AND its source is connected + fresh, the
  // value IS a confirmed 0: rows are coalesced to [{metric: 0}] and the envelope carries
  // noData.reason = "zero_confirmed_fresh". Stale/disconnected stays null (honest).
  const freshness = await freshnessForViews(db, context.workspaceId, [view]);
  const confirmedZero = await classifyConfirmedZeroWindow(
    db,
    context.workspaceId,
    view,
    metric,
    rows,
    input,
    freshness
  );
  const effectiveRows = confirmedZero.rows ?? rows;
  await logTool(db, context, "run_metric_query", input, [view], [metric], { metric, view }, rows.length);
  // COMPARISON — opt-in compareTo re-runs the SAME aggregate over the adjacent prior
  // date range and attaches an additive `comparison` block to envelope.data. Runs AFTER
  // applySiteFilter so the prior query inherits the identical source_id/site scope. No
  // connector/DB-schema change; the second query is the only extra cost. classifyGa4NoData
  // and logTool run only on the primary query above (no duplicate no-data/audit noise).
  // Comparison reads the coalesced rows: a confirmed-zero current window against a real
  // prior value is a true "down to 0", not an unknowable delta.
  const comparison = await computeComparison(db, context.workspaceId, view, metric, input, effectiveRows);
  return envelope(
    "run_metric_query",
    context.authority,
    {
      rows: effectiveRows,
      metric,
      view,
      ...(comparison.block ? { comparison: comparison.block } : {}),
      // Disjoint by construction: classifyGa4NoData sets noData only for GA4 views,
      // classifyConfirmedZeroWindow only for non-GA4 views — the spreads never collide.
      ...noDataEnvelopeData(noData),
      ...(confirmedZero.noData ? { noData: confirmedZero.noData } : {})
    },
    [view, "metric_definitions"],
    "ok",
    [
      // unbounded_date_range leads the array BY CONTRACT: the llm-controller digest
      // (toolResultDigest) slices caveats to the first 2, and the Meta ratio family
      // carries up to 8 base caveats — appended last, the signal would never reach the
      // curated digest line the model reads. Envelope consumers treat caveats as a set
      // (tests use arrayContaining), so the order change is safe.
      ...unboundedDateRangeCaveats(view, metric, filtersFrom(input)),
      // zero_confirmed_fresh rides next for the same digest-slice reason: the confirmed
      // zero must reach the curated line even on multi-caveat metrics.
      ...confirmedZero.caveats,
      ...caveatsForMetric(metric),
      ...noData.caveats,
      ...comparison.caveats
    ],
    ["explain_answer", "drilldown_result"],
    freshness
  );
}

// UNBOUNDED-WINDOW GUARD (2026-08-24) — a metric query with no filter on the view's date
// dimension aggregates ALL-TIME, and nothing in the single-row result says so. Real
// incident: asked "total revenue over the last 7 days", the caller omitted the occurred_on
// filters and the ALL-TIME recognized_revenue total was presented as the 7-day number.
// Stamp `unbounded_date_range` on the envelope so an all-time total can never masquerade
// as a windowed answer. Purely additive: rows/values are untouched and NO default window
// is injected (that would silently change every existing answer). Detection mirrors
// computeComparison's date-bound lookup: normalizeDimensionAlias resolves the date/day
// aliases (occurred_on for non-X views, published_at for X views), and a filter on the
// always-admitted occurred_on column counts as a bound on every view too. Any gte/lte/
// equals filter on those counts as a bound — equals pins a single day, which is a
// window, not all-time.
//
// Snapshot-grain metrics are exempt: a point-in-time count (current followers, current
// paid/trialing subscribers) is not an over-time sum — an unbounded read IS the current
// value, not an all-time total, so "unbounded" is meaningless there and the caveat would
// only bait the caller into windowing a number that has no window. (This rests on grain,
// NOT on a missing date dimension: vw_x_profile_public_metrics does carry occurred_on/
// captured_at (0014) — it is only the X `published_at` date alias that runAggregate
// rejects there as unsupported_dimension.)
const SNAPSHOT_GRAIN_METRICS = new Set([
  "stripe_current_paid_subscribers", // caveatsForMetric declares current_snapshot
  "stripe_paid_subscribers", // deprecated alias — current_paid_is_snapshot
  "stripe_trialing_subscribers", // 0055 lifecycle lane holds only CURRENTLY-trialing rows — unbounded sum = current trialing count
  "x_follower_count" // current-profile snapshot
]);

function unboundedDateRangeCaveats(
  view: string,
  metric: string,
  filters: Array<{ field: string; operator: "equals" | "matches" | "gte" | "lte"; value: string }>
): string[] {
  if (SNAPSHOT_GRAIN_METRICS.has(metric)) {
    return [];
  }
  const dateField = normalizeDimensionAlias(view, "date"); // occurred_on | published_at
  // occurred_on is ALSO a date bound everywhere: runAggregate's filter gate always admits
  // occurred_on on every view, and the X views expose it directly (published_at::date,
  // migrations 0011/0014) — so an X query windowed via occurred_on is bounded even though
  // the resolved date alias for X views is published_at. On non-X views dateField already
  // IS occurred_on, so the extra check is a no-op there.
  const hasDateBound = filters.some((filter) => {
    const normalized = normalizeDimensionAlias(view, filter.field);
    return (
      (normalized === dateField || normalized === "occurred_on") &&
      (filter.operator === "gte" || filter.operator === "lte" || filter.operator === "equals")
    );
  });
  return hasDateBound ? [] : ["unbounded_date_range"];
}

// CONFIRMED-ZERO WINDOW (2026-08-24) — a sum-type metric over an empty window returns
// SUM(no rows) = SQL null, and the honesty layer reads any null as "not available".
// Real incident: "total revenue over the last 7 days" with Stripe connected + synced
// today but no invoices in the window — the agent hedged instead of answering the
// confirmed $0. The engine decides the TRUTH here: when the window is empty AND the
// backing source is connected AND fresh, the value IS 0 (coalesced) and the envelope
// stamps noData.reason = "zero_confirmed_fresh" so the agent knows it is a confirmed
// zero, not an unknown. When the source is stale, disconnected, or never synced, the
// null passes through untouched — a false "$0" is worse than a hedge, so every
// uncertain branch below declines to coalesce.
//
// Scope — ONLY metrics whose view semantics make "empty window = genuine zero":
// over-time SUMS of money/events/counts (never snapshots, ratios, averages, or the
// typed-conversions family). GA4 metrics are excluded wholesale: that lane keeps its
// own classifier (classifyNoData) with the 24-48h mutation-window semantics, where an
// empty recent window may mean "still arriving", never a confirmed zero.
const ZERO_COALESCE_SUM_METRICS = new Set([
  "recognized_revenue", // Stripe invoice sums (the incident metric) — no invoices = $0
  "shopify_gross_sales", // order sums — no orders in window = genuinely 0
  "shopify_order_count",
  "meta_ads_spend", // delivery-fact sums — fresh sync + no delivery rows = nothing spent/served
  "meta_ads_clicks",
  "impressions",
  "link_clicks",
  "landing_page_views",
  "posthog_event_count", // event counts — no events captured in window = 0
  "posthog_page_views",
  "signup_count"
]);

interface ConfirmedZeroClassification {
  caveats: string[];
  noData?: { reason: "zero_confirmed_fresh" };
  /** Present only when coalescing: the single-row result with the metric pinned to 0. */
  rows?: Record<string, unknown>[];
}

const NO_CONFIRMED_ZERO: ConfirmedZeroClassification = { caveats: [] };

async function classifyConfirmedZeroWindow(
  db: InfiniteOsDb,
  workspaceId: string,
  view: string,
  metric: string,
  rows: Record<string, unknown>[],
  input: unknown,
  freshness: EnvelopeFreshness | undefined
): Promise<ConfirmedZeroClassification> {
  if (!ZERO_COALESCE_SUM_METRICS.has(metric) || SNAPSHOT_GRAIN_METRICS.has(metric)) {
    return NO_CONFIRMED_ZERO;
  }
  // GA4 views keep their own no-data classifier + mutation-lag semantics (defense in
  // depth — no ZERO_COALESCE metric routes to a GA4 view today).
  if (ga4FactTableForView(view)) {
    return NO_CONFIRMED_ZERO;
  }
  // Empty detection mirrors classifyNoData: no rows, or the single scalar row whose only
  // key is the metric and whose value is SQL null.
  const emptyResult =
    rows.length === 0 ||
    (rows.length === 1 && Object.keys(rows[0]).length === 1 && rows[0][metric] === null);
  if (!emptyResult) {
    return NO_CONFIRMED_ZERO;
  }
  // Only pure date-windowed queries coalesce. A dimension slice (campaign_name, provider,
  // source_id, …) that matches nothing may mean "no such entity", not "zero over the
  // window" — that ambiguity stays an honest null.
  const dateField = normalizeDimensionAlias(view, "date"); // occurred_on | published_at
  const onlyDateFilters = filtersFrom(input).every((filter) => {
    const normalized = normalizeDimensionAlias(view, filter.field);
    return (
      (normalized === dateField || normalized === "occurred_on") &&
      (filter.operator === "gte" || filter.operator === "lte" || filter.operator === "equals")
    );
  });
  if (!onlyDateFilters) {
    return NO_CONFIRMED_ZERO;
  }
  // FRESHNESS GATE — the signal runMetricQuery already computes (freshnessForViews):
  // asOf non-null proves every required provider has at least one successful sync, and
  // stale === false proves the newest one is within the view's freshness target. An
  // omitted/degraded freshness claim (undefined) means "unknown" → do NOT coalesce.
  if (!freshness || freshness.asOf === null || freshness.stale) {
    return NO_CONFIRMED_ZERO;
  }
  // CONNECTEDNESS GATE — freshnessForProviders reads last_synced_at regardless of source
  // status, so a source that synced this morning and then flipped to error (e.g.
  // credential_undecryptable) still reads "fresh". Require a live connected/degraded
  // source row for EVERY provider feeding the view. Any lookup failure → no coalesce.
  try {
    const registryRows = await db.query<{ source_tables: unknown }>(
      `
        select source_tables
        from queryable_views
        where id = $1
      `,
      [view]
    );
    const providers = new Set<string>();
    for (const row of registryRows) {
      for (const provider of providersForSourceTables(parseJsonArray(row.source_tables))) {
        providers.add(provider);
      }
    }
    if (providers.size === 0) {
      return NO_CONFIRMED_ZERO;
    }
    const sources = await connectedSources(db, workspaceId, [...providers]);
    const connectedProviders = new Set(sources.map((source) => source.provider));
    for (const provider of providers) {
      if (!connectedProviders.has(provider)) {
        return NO_CONFIRMED_ZERO;
      }
    }
  } catch {
    return NO_CONFIRMED_ZERO;
  }
  return {
    caveats: ["zero_confirmed_fresh"],
    noData: { reason: "zero_confirmed_fresh" },
    rows: [{ [metric]: 0 }]
  };
}

// COMPARISON — derive the adjacent prior date range from an inclusive [gte, lte] pair.
//   prior_period: the immediately preceding range of equal inclusive length.
//                 length = (lte - gte) + 1 day; priorEnd = gte - 1 day;
//                 priorStart = priorEnd - (length - 1 day). Contiguous, no overlap, no gap.
//   prior_year:   shift BOTH bounds back one calendar year at the string level (YYYY-1) so
//                 leap-day day-count drift never moves the window (2026-02-28 -> 2025-02-28).
//                 Feb-29 is clamped to Feb-28 in a non-leap target year (2024-02-29 ->
//                 2023-02-28) so the shifted bound is always a real SQL date.
// Pure (no DB). Dates are YYYY-MM-DD strings; returns the same format.
export function derivePriorRange(
  gte: string,
  lte: string,
  mode: "prior_period" | "prior_year"
): { gte: string; lte: string } | null {
  if (mode === "prior_year") {
    const shifted = { gte: shiftYear(gte, -1), lte: shiftYear(lte, -1) };
    if (!shifted.gte || !shifted.lte) return null;
    return shifted as { gte: string; lte: string };
  }
  const startMs = Date.parse(`${gte}T00:00:00Z`);
  const endMs = Date.parse(`${lte}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  const dayMs = 86_400_000;
  const lengthDays = Math.round((endMs - startMs) / dayMs) + 1; // inclusive length
  const priorEndMs = startMs - dayMs;
  const priorStartMs = priorEndMs - (lengthDays - 1) * dayMs;
  return { gte: toDateString(priorStartMs), lte: toDateString(priorEndMs) };
}

function shiftYear(date: string, delta: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]) + delta;
  if (!Number.isFinite(year) || year < 0) return null;
  let month = match[2];
  let day = match[3];
  // Leap-day clamp: 2024-02-29 -> 2023-02-28. A pure string YYYY-1 would emit the literal
  // "2023-02-29", which is NOT a real calendar date — Postgres rejects it ("date/time field
  // value out of range") and the whole prior re-run throws. Clamp Feb-29 to Feb-28 in any
  // non-leap target year so the shifted bound is always a valid SQL date.
  if (month === "02" && day === "29" && !isLeapYear(year)) {
    day = "28";
  }
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function toDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// COMPARISON — coerce a single ungrouped aggregate row [{ <metric>: value }] to a number.
// pg returns sums as strings ("12000") and rate metrics can be legitimately null. Treat
// null/""/missing/NaN as null (never zero a real null rate metric).
function coerceMetricValue(rows: Record<string, unknown>[], metric: string): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const raw = rows[0]?.[metric];
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

interface ComparisonBlock {
  mode: "prior_period" | "prior_year";
  current: number | null;
  previous: number | null;
  absoluteDelta: number | null;
  percentDelta: number | null;
  direction: "up" | "down" | "flat" | "new" | null;
  range: {
    current: { gte: string; lte: string };
    previous: { gte: string; lte: string };
  };
}

// COMPARISON — builds the additive comparison block (or returns a caveat-only result).
// CLONES the input + filters (applySiteFilter already mutated input.filters; we must NOT
// mutate the shared array) and replaces ONLY the date-bound filter values with the prior
// range — the source_id equals-filter and every other filter are preserved so current and
// prior are scoped to the same site. Re-runs the identical runAggregate SQL builder (so
// rate-metric session-weighted math is byte-identical), then computes a guarded delta.
async function computeComparison(
  db: InfiniteOsDb,
  workspaceId: string,
  view: string,
  metric: string,
  input: unknown,
  currentRows: Record<string, unknown>[]
): Promise<{ block?: ComparisonBlock; caveats: string[] }> {
  const mode = optionalString(input, "compareTo");
  if (mode !== "prior_period" && mode !== "prior_year") {
    return { caveats: [] };
  }
  // Date bounds live as filters on the view's date dimension (occurred_on for non-X,
  // published_at for X). Normalize each filter field so date/day aliases resolve.
  const filters = filtersFrom(input);
  const dateField = normalizeDimensionAlias(view, "date"); // occurred_on | published_at
  const gte = filters.find(
    (f) => normalizeDimensionAlias(view, f.field) === dateField && f.operator === "gte"
  )?.value;
  const lte = filters.find(
    (f) => normalizeDimensionAlias(view, f.field) === dateField && f.operator === "lte"
  )?.value;
  if (!gte || !lte) {
    return { caveats: ["comparison_requires_date_range"] };
  }
  const priorRange = derivePriorRange(gte, lte, mode);
  if (!priorRange) {
    return { caveats: ["comparison_requires_date_range"] };
  }
  // Deep-clone the input so the prior-range re-run never mutates the shared filters array.
  const priorInput: Record<string, unknown> = isRecord(input) ? { ...input } : {};
  priorInput.filters = filters.map((f) => {
    const normalized = normalizeDimensionAlias(view, f.field);
    if (normalized === dateField && f.operator === "gte") {
      return { field: f.field, operator: f.operator, value: priorRange.gte };
    }
    if (normalized === dateField && f.operator === "lte") {
      return { field: f.field, operator: f.operator, value: priorRange.lte };
    }
    return { field: f.field, operator: f.operator, value: f.value };
  });
  // Error isolation: the comparison is additive/opt-in, so a failure in the prior re-run
  // (a transient DB error, an unsupported_dimension on a malformed prior filter, an invalid
  // SQL date, etc.) must NOT discard the already-successful primary aggregate. Degrade to a
  // comparison_failed caveat and let run_metric_query return the primary rows.
  let priorRows: Record<string, unknown>[];
  try {
    priorRows = await runAggregate(db, workspaceId, view, metric, priorInput, []);
  } catch {
    return { caveats: ["comparison_failed"] };
  }

  const current = coerceMetricValue(currentRows, metric);
  const previous = coerceMetricValue(priorRows, metric);
  return {
    block: buildComparisonBlock(mode, current, previous, gte, lte, priorRange),
    // Only flag a missing baseline when there is a real current value rising against a
    // null/zero prior — a genuinely flat-at-zero result (current===0) is not "no baseline".
    caveats: (previous === null || previous === 0) && current !== null && current !== 0 ? ["no_prior_baseline"] : []
  };
}

// COMPARISON — guarded delta math. previous null/0 -> percentDelta null (never Infinity/NaN);
// direction "new" when there is a current value against a null/zero baseline.
function buildComparisonBlock(
  mode: "prior_period" | "prior_year",
  current: number | null,
  previous: number | null,
  currentGte: string,
  currentLte: string,
  priorRange: { gte: string; lte: string }
): ComparisonBlock {
  let absoluteDelta: number | null = null;
  let percentDelta: number | null = null;
  let direction: ComparisonBlock["direction"] = null;
  if (current !== null && previous !== null) {
    absoluteDelta = current - previous;
    if (previous === 0) {
      // No baseline to divide by: report the rise as "new", leave pct null.
      percentDelta = null;
      direction = current === 0 ? "flat" : "new";
    } else {
      percentDelta = ((current - previous) / previous) * 100;
      direction = absoluteDelta > 0 ? "up" : absoluteDelta < 0 ? "down" : "flat";
    }
  } else if (current !== null && previous === null) {
    direction = "new";
  }
  return {
    mode,
    current,
    previous,
    absoluteDelta,
    percentDelta,
    direction,
    range: {
      current: { gte: currentGte, lte: currentLte },
      previous: priorRange
    }
  };
}

// PR3 Step 13/14 — shared envelope-layer post-processing for the GA4 query handlers.
// Resolves the effective source filter (set by an explicit source_id filter OR by site
// resolution), detects an un-scoped multi-GA4-source aggregate, and runs the no-data
// classifier. Returns no caveats for non-GA4 views.
async function classifyGa4NoData(
  db: InfiniteOsDb,
  workspaceId: string,
  view: string,
  metric: string,
  rows: Record<string, unknown>[],
  input: unknown,
  resolvedSourceId: string | null
): Promise<NoDataClassification> {
  if (!ga4FactTableForView(view)) {
    return { caveats: [] };
  }
  const filters = filtersFrom(input);
  const sourceIdFilter =
    resolvedSourceId ??
    filters.find((filter) => filter.field === "source_id" && filter.operator === "equals")?.value ??
    null;
  const multiSite = sourceIdFilter === null && (await countConnectedGa4Sources(db, workspaceId)) > 1;
  return classifyNoData(db, workspaceId, view, metric, rows, input, sourceIdFilter, multiSite);
}

// Spreads no-data classification onto the envelope `data` object without a contract
// schema change (ActionEnvelope.data is generic; noData/freshness are additive).
function noDataEnvelopeData(
  classification: NoDataClassification
): { noData?: NoDataClassification["noData"]; freshness?: NoDataClassification["freshness"] } {
  const out: { noData?: NoDataClassification["noData"]; freshness?: NoDataClassification["freshness"] } = {};
  if (classification.noData) {
    out.noData = classification.noData;
  }
  if (classification.freshness) {
    out.freshness = classification.freshness;
  }
  return out;
}

async function backfillXFollowerSnapshotIfNeeded(
  db: InfiniteOsDb,
  context: SessionContext
): Promise<void> {
  const existing = await db.one<{ x_follower_count: number | null }>(
    `
      select x_follower_count
      from queryable.vw_x_profile_public_metrics
      where workspace_id = $1
      limit 1
    `,
    [context.workspaceId]
  );
  if (existing && existing.x_follower_count !== null) {
    return;
  }

  const source = await db.one<{ id: string; connection_name: string; account_external_id: string | null }>(
    `
      select id, connection_name, account_external_id
      from sources
      where workspace_id = $1 and provider = 'x' and status in ('connected', 'degraded')
      order by connected_at desc
      limit 1
    `,
    [context.workspaceId]
  );
  if (!source) {
    return;
  }
  const requestedUsername = typeof source.account_external_id === "string"
    ? source.account_external_id.replace(/^@/, "")
    : undefined;
  let resolvedUserId: string | undefined;
  let resolvedUsername: string | undefined;
  let followersCount = 0;
  let followingCount = 0;
  let tweetCount = 0;
  let listedCount = 0;
  let likeCount = 0;
  if (requestedUsername) {
    try {
      const publicProfile = await fetch(`https://x.com/${encodeURIComponent(requestedUsername)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });
      if (publicProfile.ok) {
        const html = await publicProfile.text();
        const profile = parsePublicXProfileHtml(html);
        if (profile) {
          resolvedUserId = profile.userId ?? resolvedUserId;
          resolvedUsername = requestedUsername;
          followersCount = profile.followersCount ?? followersCount;
          followingCount = profile.followingCount ?? followingCount;
          tweetCount = profile.tweetCount ?? tweetCount;
          listedCount = profile.listedCount ?? listedCount;
          likeCount = profile.likeCount ?? likeCount;
        }
      }
    } catch {
      return;
    }
  }

  if (!resolvedUserId) {
    return;
  }

  const capturedAt = new Date().toISOString();
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
        context.workspaceId,
        source.id,
        capturedAt,
        resolvedUserId,
        resolvedUsername ?? null,
        followersCount,
        followingCount,
        tweetCount,
        listedCount,
        likeCount,
        JSON.stringify({
        followersCount,
        followingCount,
        tweetCount,
        listedCount,
        likeCount
        })
      ]
    );
}

async function runBreakdownQuery(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const metric = requiredString(input, "metric");
  const groupBy = stringArray(input, "groupBy");
  const orderBy = objectOrderBy(input);
  // §5a — THE primary grain seam. An adset_id/adset_name group-by (or filter — §5e) routes view
  // selection to the adset sibling; everything else stays campaign-grain (metricView default),
  // so all existing campaign-grain breakdowns resolve byte-for-byte as they do today.
  // METRIC_SET gate first (see run_metric_query): `unsupported_metric:` for typos, `unknown_metric:`
  // only for a listed metric with no routing branch.
  rejectUnsupportedMetric(metric);
  const view = optionalString(input, "view") ?? metricViewForGrain(metric, groupBy, filtersFrom(input));
  rejectUnsafeView(view);
  rejectMetricViewMismatch(metric, view);
  // PR3 Step 14 — per-site isolation: resolve {site} -> source_id filter before aggregating.
  const resolvedSourceId = await applySiteFilter(db, context.workspaceId, input);
  const rows = await runAggregate(db, context.workspaceId, view, metric, input, groupBy, orderBy);
  // PR3 Step 13 — no-data honesty MUST cover breakdown queries (the Tier-1 questions:
  // "top pages", "by channel", "mobile vs desktop") via the SAME shared classifier.
  const noData = await classifyGa4NoData(db, context.workspaceId, view, metric, rows, input, resolvedSourceId);
  await logTool(db, context, "run_breakdown_query", input, [view], [metric], { metric, view, groupBy, orderBy }, rows.length);
  return envelope(
    "run_breakdown_query",
    context.authority,
    { rows, metric, view, groupBy, orderBy, ...noDataEnvelopeData(noData) },
    [view, "metric_definitions"],
    "ok",
    [...caveatsForMetric(metric), ...noData.caveats],
    ["explain_answer", "drilldown_result"],
    await freshnessForViews(db, context.workspaceId, [view])
  );
}

function parsePublicXProfileHtml(html: string): {
  userId?: string;
  followersCount?: number;
  followingCount?: number;
  tweetCount?: number;
  listedCount?: number;
  likeCount?: number;
} | null {
  const userId = matchStringValue(html, /"id_str":"([^"]+)"/);
  const followersCount = matchNumberLike(html, /"followers_count":(\d+)/);
  const followingCount = matchNumberLike(html, /"friends_count":(\d+)/);
  const tweetCount = matchNumberLike(html, /"statuses_count":(\d+)/);
  const listedCount = matchNumberLike(html, /"listed_count":(\d+)/);
  const likeCount = matchNumberLike(html, /"favourites_count":(\d+)/);
  if (
    userId === undefined &&
    followersCount === undefined &&
    followingCount === undefined &&
    tweetCount === undefined &&
    listedCount === undefined &&
    likeCount === undefined
  ) {
    return null;
  }
  return {
    userId,
    followersCount: typeof followersCount === "number" ? followersCount : undefined,
    followingCount: typeof followingCount === "number" ? followingCount : undefined,
    tweetCount: typeof tweetCount === "number" ? tweetCount : undefined,
    listedCount: typeof listedCount === "number" ? listedCount : undefined,
    likeCount: typeof likeCount === "number" ? likeCount : undefined
  };
}

function matchNumberLike(html: string, pattern: RegExp): string | number | undefined {
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  return /^\d+$/.test(match[1]) ? Number(match[1]) : match[1];
}

function matchStringValue(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern);
  return match?.[1] ? String(match[1]) : undefined;
}

async function runFunnelQuery(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const metricRows = await runAggregate(
    db,
    context.workspaceId,
    "queryable.vw_site_conversion_rate",
    "site_conversion_rate",
    input,
    []
  );
  return envelope(
    "run_funnel_query",
    context.authority,
    // Same-lane rule (0062): the funnel rate is GA4 key_events ÷ GA4 visitors — visit → key event,
    // no longer visit → (PostHog) signup blended across providers.
    { rows: metricRows, caveat: "first_phase_funnel_is_visit_to_key_event_only" },
    ["queryable.vw_site_conversion_rate"],
    "ok",
    ["source_native_attribution_only", "attribution_model_not_implemented", "key_events_may_be_unconfigured"],
    ["explain_answer", "drilldown_result"],
    await freshnessForViews(db, context.workspaceId, ["queryable.vw_site_conversion_rate"])
  );
}

async function explainAnswer(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const metric = optionalString(input, "metric") ?? optionalString(input, "priorResultMetric") ?? "recognized_revenue";
  const drilldownAction = drilldownForMetric(metric);
  await logTool(db, context, "explain_answer", input, [metricView(metric)], [metric], { drilldownAction });
  return envelope(
    "explain_answer",
    context.authority,
    {
      metric,
      sourceAuthority: sourceAuthorityForMetric(metric),
      drilldownAction,
      rawPayloadJsonExposed: false,
      genericSqlAllowed: false
    },
    [metricView(metric), "record_lineage"],
    "ok",
    caveatsForMetric(metric),
    ["drilldown_result"]
  );
}

async function drilldownResult(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const metric = optionalString(input, "metric") ?? optionalString(input, "priorResultMetric") ?? "recognized_revenue";
  const limit = boundedLimit(input, 100, 500);
  const rows = await providerTruthRows(db, context.workspaceId, metric, limit, input);
  await logTool(db, context, "drilldown_result", input, [metricView(metric)], [metric], { metric }, rows.length);
  return envelope(
    "drilldown_result",
    context.authority,
    {
      metric,
      rows,
      rawPayloadJsonExposed: false,
      genericSqlAllowed: false
    },
    [drilldownForMetric(metric), "record_lineage"],
    "ok",
    caveatsForMetric(metric),
    [],
    await freshnessForViews(db, context.workspaceId, [metricView(metric)])
  );
}

async function createSavedReport(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const report = await db.one(
    `
      insert into saved_reports (id, workspace_id, name, tool_plan)
      values ($1, $2, $3, $4::jsonb)
      returning id, name, tool_plan, created_at, updated_at
    `,
    [
      `report_${randomUUID()}`,
      context.workspaceId,
      optionalString(input, "name") ?? "Saved Infinite OS report",
      JSON.stringify(objectField(input, "toolPlan") ?? {})
    ]
  );
  return envelope("create_saved_report", context.authority, { report }, ["saved_reports"]);
}

async function runSavedReport(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const reportId = requiredString(input, "reportId");
  const job = await db.createJob({
    workspaceId: context.workspaceId,
    jobType: "saved_report_run",
    payload: { reportId }
  });
  return envelope("run_saved_report", context.authority, { job }, ["job_runs"], "queued");
}

async function exportSavedReport(
  db: InfiniteOsDb,
  context: SessionContext,
  input: unknown
): Promise<ActionEnvelope> {
  const reportId = requiredString(input, "reportId");
  const format = optionalString(input, "format") ?? "json";
  const job = await db.createJob({
    workspaceId: context.workspaceId,
    jobType: "saved_report_export",
    payload: { reportId, format }
  });
  const artifactPath = `${process.env.GROWTH_OS_WORKSPACE_ROOT ?? process.cwd()}/.growth-os/exports/${context.workspaceId}/${String(job.id)}.json`;
  return envelope(
    "export_saved_report",
    context.authority,
    {
      job,
      artifact: {
        status: "queued",
        format,
        artifactPath,
        credentialsIncluded: false,
        rawPayloadJsonIncluded: false
      }
    },
    ["job_runs", "saved_report_exports"],
    "queued"
  );
}

async function runAggregate(
  db: InfiniteOsDb,
  workspaceId: string,
  view: string,
  metric: string,
  input: unknown,
  groupBy: string[],
  orderBy?: { field: string; direction: "asc" | "desc" }
): Promise<Record<string, unknown>[]> {
  const column = metricColumn(metric);
  const allowedDimensions = allowedDimensionsForView(view);
  const normalizedGroupBy = groupBy.map((group) => normalizeDimensionAlias(view, group));
  const groupedExpressions = normalizedGroupBy.map((group) => ({
    alias: group,
    expression: dimensionExpression(view, group)
  }));
  for (const group of normalizedGroupBy) {
    if (!allowedDimensions.includes(group)) {
      throw new Error(`unsupported_dimension:${group}`);
    }
  }
  const filters = filtersFrom(input);
  // Phase-1 §6 — result_type is a REQUIRED partition for the conversion-family metrics. The
  // engine MUST refuse to aggregate results/cost_per_result/conversion_value/roas across mixed
  // result_types: a single number blending CPL (leads) and CPA (purchases) is meaningless, and
  // worse, silently averages two populations. This is the ONLY place that decides GROUP BY, so
  // it is the load-bearing enforcement point (metric_definitions.required_filters records the
  // contract but nothing reads it). A query is allowed ONLY if it either groups BY result_type
  // (so each type is its own row) OR pins result_type to a single value via an equals filter.
  if (requiresResultTypePartition(metric)) {
    const groupsByResultType = normalizedGroupBy.includes("result_type");
    const pinsResultType = filters.some(
      (filter) => normalizeDimensionAlias(view, filter.field) === "result_type" && filter.operator === "equals"
    );
    if (!groupsByResultType && !pinsResultType) {
      // The engine THROWS here — it does not return an envelope. The unsupported_partition:*
      // error propagates out of run_metric_query / run_breakdown_query (the action handlers
      // re-throw it); a higher layer (the LLM controller / CLI) is what wraps it into a
      // needs_clarification response asking the caller to group by / filter to a result_type.
      // The hard refusal at this layer is the load-bearing guarantee that CPL+CPA never blend.
      throw new Error(`unsupported_partition:result_type_required:${metric}`);
    }
  }
  const where = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  for (const filter of filters) {
    const field = normalizeDimensionAlias(view, filter.field);
    if (!allowedDimensions.includes(field) && field !== "provider" && field !== "occurred_on" && field !== "source_id") {
      throw new Error(`unsupported_dimension:${filter.field}`);
    }
    params.push(filter.value);
    where.push(`${dimensionExpression(view, field)} ${filterOperatorSql(filter.operator)} $${params.length}`);
  }
  const limit = boundedLimit(input, 500);
  const groupColumns = groupedExpressions.length
    ? `${groupedExpressions.map((group) => `${group.expression} as ${group.alias}`).join(", ")}, `
    : "";
  const groupClause = groupedExpressions.length
    ? `group by ${groupedExpressions.map((group) => group.expression).join(", ")}`
    : "";
  const normalizedOrderBy = normalizeOrderBy(view, metric, orderBy, normalizedGroupBy, allowedDimensions);
  const orderClause = normalizedOrderBy
    ? `order by ${normalizedOrderBy.field} ${normalizedOrderBy.direction}`
    : normalizedGroupBy.length
      ? `order by ${metric} desc`
      : "";
  params.push(limit);
  const sql = `
    select ${groupColumns}${aggregateExpression(metric, column)} as ${metric}
    from ${view}
    where ${where.join(" and ")}
    ${groupClause}
    ${orderClause}
    limit $${params.length}
  `;
  return db.query(sql, params);
}

// PR3 Step 13/14 — GA4 fact table behind each queryable view, used by the no-data
// existence probe and the per-site `key_events` historical probe. Returns null for
// non-GA4 views so classifyNoData stays a no-op for every other provider.
function ga4FactTableForView(view: string): string | null {
  if (view === "queryable.vw_site_traffic") return "ga4_report_snapshot_fact";
  if (view === "queryable.vw_site_pages") return "ga4_page_report_fact";
  if (view === "queryable.vw_site_events") return "ga4_event_report_fact";
  return null;
}

// PR3 Step 14 — resolve a {site} input (url OR workspace_sites.id) to the GA4
// source_id that backs it. Resolution order (first hit wins):
//   1. workspace_sites matched by url or id -> its ga4_source_id (if set)
//   2. the workspace's primary site -> its ga4_source_id (if set)
//   3. the workspace's lone connected/degraded GA4 source
//   4. throw `site_ambiguous` (caller surfaces "which site?" to the agent)
async function resolveGa4SourceForSite(
  db: InfiniteOsDb,
  workspaceId: string,
  siteUrlOrId: string
): Promise<string> {
  const matched = await db.one<{ ga4_source_id: string | null }>(
    `
      select ga4_source_id
      from workspace_sites
      where workspace_id = $1 and (url = $2 or id = $2)
      order by is_primary desc
      limit 1
    `,
    [workspaceId, siteUrlOrId]
  );
  if (matched?.ga4_source_id) {
    return matched.ga4_source_id;
  }

  const primary = await db.one<{ ga4_source_id: string | null }>(
    `
      select ga4_source_id
      from workspace_sites
      where workspace_id = $1 and is_primary
      limit 1
    `,
    [workspaceId]
  );
  if (primary?.ga4_source_id) {
    return primary.ga4_source_id;
  }

  const ga4Sources = await db.query<{ id: string }>(
    `
      select id
      from sources
      where workspace_id = $1
        and provider = 'google_analytics_4'
        and status in ('connected', 'degraded')
      order by id
    `,
    [workspaceId]
  );
  if (ga4Sources.length === 1) {
    return ga4Sources[0].id;
  }

  throw new Error("site_ambiguous");
}

// PR3 Step 14 — count the workspace's connected/degraded GA4 sources. Used to decide
// whether an un-scoped GA4 query is silently summing across sites (multi_site_aggregate).
async function countConnectedGa4Sources(
  db: InfiniteOsDb,
  workspaceId: string
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `
      select id
      from sources
      where workspace_id = $1
        and provider = 'google_analytics_4'
        and status in ('connected', 'degraded')
    `,
    [workspaceId]
  );
  return rows.length;
}

// PR3 Step 14 — if the input names a {site}, resolve it to a source_id and push a
// `source_id = $N` equals-filter (exempt from the dimension gate, runAggregate:1797)
// onto the input so the aggregate is scoped to that one GA4 property. Returns the
// resolved source id (or null when no `site` was provided). Throws `site_ambiguous`
// when a site is requested but cannot be resolved.
async function applySiteFilter(
  db: InfiniteOsDb,
  workspaceId: string,
  input: unknown
): Promise<string | null> {
  if (!isRecord(input)) {
    return null;
  }
  const site = optionalString(input, "site");
  if (!site) {
    return null;
  }
  const resolved = await resolveGa4SourceForSite(db, workspaceId, site);
  const existing = Array.isArray((input as Record<string, unknown>).filters)
    ? ((input as Record<string, unknown>).filters as unknown[])
    : [];
  (input as Record<string, unknown>).filters = [
    ...existing,
    { field: "source_id", operator: "equals", value: resolved }
  ];
  return resolved;
}

interface NoDataClassification {
  caveats: string[];
  // "zero_confirmed_fresh" (2026-08-24) — additive: a sum-type metric over an empty window
  // whose backing source is connected AND fresh. The engine coalesces the value to 0 and
  // this marker tells the agent it is a CONFIRMED zero, not an unknown. Stamped only by
  // classifyConfirmedZeroWindow (never by the GA4 classifier below).
  noData?: { reason: "not_synced" | "no_data_for_range" | "zero_confirmed_fresh" };
  freshness?: { ga4FreshnessLag: true };
}

// PR3 Step 13 — honest no-data classification, called by BOTH run_metric_query and
// run_breakdown_query at the envelope layer (runAggregate stays pure). GA4-only:
// returns no caveats for any other provider/view so existing handlers are unchanged.
async function classifyNoData(
  db: InfiniteOsDb,
  workspaceId: string,
  view: string,
  metric: string,
  rows: Record<string, unknown>[],
  input: unknown,
  sourceIdFilter: string | null,
  multiSite: boolean
): Promise<NoDataClassification> {
  const factTable = ga4FactTableForView(view);
  if (!factTable) {
    return { caveats: [] };
  }

  const caveats: string[] = [];
  if (multiSite) {
    // Never silently sum across GA4 properties — flag the cross-site total honestly.
    caveats.push("multi_site_aggregate");
  }

  const emptyResult =
    rows.length === 0 ||
    (rows.length === 1 && Object.keys(rows[0]).length === 1 && rows[0][metric] === null);

  // key_events specifically: a returned 0 (not null) with a populated fact table likely
  // means no key event is configured for the property, not a genuine zero.
  if (
    metric === "key_events" &&
    !emptyResult &&
    rows.length === 1 &&
    Number(rows[0][metric] ?? 0) === 0
  ) {
    const everConfigured = await db.query(
      `
        select 1 from ${factTable}
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
          and key_events > 0
        limit 1
      `,
      [workspaceId, sourceIdFilter ?? null]
    );
    if (everConfigured.length === 0) {
      caveats.push("key_events_unconfigured");
    }
  }

  if (!emptyResult) {
    return caveats.length ? { caveats } : { caveats: [] };
  }

  const probe = await db.query(
    `
      select 1 from ${factTable}
      where workspace_id = $1
        and ($2::text is null or source_id = $2)
      limit 1
    `,
    [workspaceId, sourceIdFilter ?? null]
  );

  if (probe.length === 0) {
    caveats.push("no_data_synced");
    return { caveats, noData: { reason: "not_synced" } };
  }

  // Fact has rows for this scope but the requested range is empty.
  caveats.push("no_data_for_range");
  const result: NoDataClassification = { caveats, noData: { reason: "no_data_for_range" } };
  if (rangeEndWithinFreshnessLag(input)) {
    caveats.push("ga4_freshness_lag");
    result.freshness = { ga4FreshnessLag: true };
  }
  return result;
}

// True when the query's range end (an `occurred_on`/`date` <= filter) is within ~48h of
// now — GA4's documented 24-48h mutation window, so "no data" likely means "still arriving".
function rangeEndWithinFreshnessLag(input: unknown): boolean {
  const filters = filtersFrom(input);
  const rangeEnd = filters.find(
    (filter) =>
      filter.operator === "lte" &&
      (filter.field === "occurred_on" || filter.field === "date" || filter.field === "day")
  )?.value;
  if (!rangeEnd) {
    // No explicit range end → treat as "up to now", which is within the lag window.
    return true;
  }
  const parsed = Date.parse(rangeEnd);
  if (Number.isNaN(parsed)) {
    return false;
  }
  const lagMs = 48 * 60 * 60 * 1000;
  return Date.now() - parsed <= lagMs;
}

function filterOperatorSql(operator: "equals" | "matches" | "gte" | "lte"): string {
  if (operator === "matches") return "ilike";
  if (operator === "gte") return ">=";
  if (operator === "lte") return "<=";
  return "=";
}

function normalizeDimensionAlias(view: string, field: string): string {
  if (field === "date" || field === "day") {
    return view.startsWith("queryable.vw_x_") ? "published_at" : "occurred_on";
  }
  if (view === "queryable.vw_posthog_events") {
    if (field === "event_date" || field === "event_day" || field === "event_time") return "occurred_on";
    if (field === "event" || field === "event_type" || field === "event_key") return "event_name";
    if (field === "channel" || field === "traffic_source") return "utm_source";
    if (field === "page" || field === "path") return "landing_page";
  }
  // GA4 event-name grain (migration 0061) — same event synonyms as vw_posthog_events, plus
  // host/site → host_name (the dim callers use against vw_site_traffic/vw_site_pages).
  if (view === "queryable.vw_site_events") {
    if (field === "event" || field === "event_type" || field === "event_key") return "event_name";
    if (field === "host" || field === "site" || field === "hostname") return "host_name";
  }
  // PostHog audience view (slice 1 / migration 0043) — accept the common audience-dim
  // synonyms. `device_category` maps to this view's `device_type` so a caller can send the
  // SAME dim name it uses for GA4's vw_site_traffic and get the PostHog cut. `os`/`platform`
  // -> operating_system mirrors the plan's requested aliases. date/day already normalize to
  // occurred_on at the top of this function (the view is not a vw_x_ view).
  if (view === "queryable.vw_posthog_site") {
    if (field === "os" || field === "platform") return "operating_system";
    if (field === "device" || field === "device_category") return "device_type";
    if (field === "region_name" || field === "subdivision") return "region";
    if (field === "city_name") return "city";
    if (field === "channel" || field === "traffic_source") return "utm_source";
    if (field === "page" || field === "path") return "landing_page";
  }
  if (view === "queryable.vw_meta_ads_campaign_daily") {
    if (field === "campaign" || field === "ad_campaign") return "campaign_name";
    if (field === "campaign_key" || field === "campaign_external_id") return "campaign_id";
  }
  // Phase-2 slice-1a §5/§3 — the adset-grain views (delivery + conversions). They carry
  // campaign_id, so the campaign aliases still resolve; they ADD the adset identity aliases
  // (adset/ad_set → adset_name, adset_key/adset_external_id → adset_id) and the on/off status
  // aliases (status/effective → effective_status; configured → configured_status). This is
  // also the table metricViewForGrain consults to detect an adset dim, so "adset"/"ad_set"
  // group-bys flip view selection to the adset sibling.
  if (view === "queryable.vw_meta_ads_adset_daily" || view === "queryable.vw_meta_ads_adset_conversions_daily") {
    if (field === "campaign" || field === "ad_campaign") return "campaign_name";
    if (field === "campaign_key" || field === "campaign_external_id") return "campaign_id";
    if (field === "adset" || field === "ad_set" || field === "ad_set_name") return "adset_name";
    if (field === "adset_key" || field === "adset_external_id" || field === "ad_set_id") return "adset_id";
    if (field === "status" || field === "effective" || field === "delivery_status") return "effective_status";
    if (field === "configured") return "configured_status";
  }
  // Phase-2 slice-1b §5/§3 — the ad-grain views (delivery + conversions). They carry campaign_id
  // AND adset_id, so the campaign + adset aliases still resolve at ad grain; they ADD the ad
  // identity aliases (ad/creative_name → ad_name, ad_key/ad_external_id → ad_id) and the same
  // on/off status aliases. This is ALSO the table metricViewForGrain consults to detect an ad
  // dim (isAdDimension runs on the alias-normalized field), so "ad"/"creative_name" group-bys
  // flip view selection to the ad sibling — so this arm must exist for the §5 picker, not just
  // the §3 view work. The ad-set aliases here are carries (a coarse "adset" filter at ad grain
  // still resolves), but they do NOT re-flip the picker: the ad branch returns first (§5e).
  if (view === "queryable.vw_meta_ads_ad_daily" || view === "queryable.vw_meta_ads_ad_conversions_daily") {
    if (field === "campaign" || field === "ad_campaign") return "campaign_name";
    if (field === "campaign_key" || field === "campaign_external_id") return "campaign_id";
    if (field === "adset" || field === "ad_set" || field === "ad_set_name") return "adset_name";
    if (field === "adset_key" || field === "adset_external_id" || field === "ad_set_id") return "adset_id";
    if (field === "ad" || field === "creative" || field === "creative_name") return "ad_name";
    if (field === "ad_key" || field === "ad_external_id") return "ad_id";
    if (field === "status" || field === "effective" || field === "delivery_status") return "effective_status";
    if (field === "configured") return "configured_status";
  }
  if (view.startsWith("queryable.vw_x_")) {
    if (field === "post_id" || field === "tweet_id") return "x_post_id";
    if (field === "user_id") return view === "queryable.vw_x_profile_public_metrics" ? "x_user_id" : "author_id";
    if (field === "text" || field === "post_text" || field === "tweet_text" || field === "content") return "body_text";
    if (field === "created_at" || field === "posted_at" || field === "post_created_at" || field === "tweet_created_at") return "published_at";
    if (field === "post_type" || field === "content_type" || field === "content_kind" || field === "content_format" || field === "format") {
      return "content_type";
    }
    if (field === "person" || field === "people" || field === "handle" || field === "mentioned_user" || field === "engaged_with") {
      return "mentioned_handle";
    }
    if (field === "hour" || field === "hour_of_day" || field === "posting_hour" || field === "tweet_hour") {
      return "published_hour_utc";
    }
    if (field === "day_of_week" || field === "weekday" || field === "posting_weekday" || field === "tweet_weekday") {
      return "published_weekday_utc";
    }
  }
  return field;
}

function dimensionExpression(view: string, field: string): string {
  if (view.startsWith("queryable.vw_x_")) {
    if (field === "published_hour_utc") {
      return "extract(hour from published_at at time zone 'utc')::int";
    }
    if (field === "published_weekday_utc") {
      return "extract(dow from published_at at time zone 'utc')::int";
    }
    if (field === "mentioned_handle") {
      return "lower((regexp_match(coalesce(body_text, ''), '@([A-Za-z0-9_]{1,15})'))[1])";
    }
    if (field === "content_type") {
      return `
        case
          when conversation_id is not null and conversation_id <> x_post_id then 'reply'
          when coalesce(body_text, '') ~* '(https?://|t\\.co/)' then 'link'
          when position('?' in coalesce(body_text, '')) > 0 then 'question'
          when length(coalesce(body_text, '')) <= 80 then 'short_text'
          else 'text'
        end
      `;
    }
  }
  return field;
}

function objectOrderBy(input: unknown): { field: string; direction: "asc" | "desc" } | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const rawOrderBy = objectField(input, "orderBy");
  if (!isRecord(rawOrderBy)) {
    return undefined;
  }
  const field = optionalString(rawOrderBy, "field");
  if (!field) {
    return undefined;
  }
  const direction = optionalString(rawOrderBy, "direction")?.toLowerCase() === "asc" ? "asc" : "desc";
  return { field, direction };
}

function normalizeOrderBy(
  view: string,
  metric: string,
  orderBy: { field: string; direction: "asc" | "desc" } | undefined,
  normalizedGroupBy: string[],
  allowedDimensions: string[]
): { field: string; direction: "asc" | "desc" } | undefined {
  if (!orderBy) {
    return undefined;
  }
  const field = normalizeDimensionAlias(view, orderBy.field);
  if (field === metric) {
    return { field: metric, direction: orderBy.direction };
  }
  if (!allowedDimensions.includes(field)) {
    throw new Error(`unsupported_dimension:${orderBy.field}`);
  }
  if (normalizedGroupBy.length > 0 && !normalizedGroupBy.includes(field)) {
    throw new Error(`unsupported_order_by:${orderBy.field}`);
  }
  return { field, direction: orderBy.direction };
}

async function providerTruthRows(
  db: InfiniteOsDb,
  workspaceId: string,
  metric: string,
  limit: number,
  input?: unknown
): Promise<Record<string, unknown>[]> {
  const filters = filtersFrom(input);
  const sourceIdFilter = filters.find((filter) => filter.field === "source_id" && filter.operator === "equals")?.value;
  if (metric === "recognized_revenue") {
    return db.query(
      `
        select i.id as invoice_row_id, i.stripe_invoice_id, i.status, i.currency,
          i.amount_paid, i.paid_at, l.id as line_row_id, l.stripe_line_id,
          l.amount_cents, l.external_order_id
        from stripe_invoices i
        left join stripe_invoice_lines l on l.source_id = i.source_id and l.stripe_invoice_id = i.stripe_invoice_id
        where i.workspace_id = $1
        order by coalesce(i.paid_at, i.created_at) desc
        limit $2
      `,
      [workspaceId, limit]
    );
  }
  if (isStripeSubscriberMetric(metric)) {
    return db.query(
      `
        select id, source_id, stripe_subscription_id, stripe_customer_id, status,
          current_period_start, current_period_end, created_at_source,
          trial_start, trial_end, cancel_at, canceled_at, ended_at
        from stripe_subscriptions
        where workspace_id = $1
          and ($4::text not in ('stripe_current_paid_subscribers', 'stripe_paid_subscribers') or status in ('active', 'past_due'))
          and ($4::text <> 'stripe_new_paid_subscribers' or status in ('active', 'past_due'))
          and ($4::text <> 'stripe_trialing_subscribers' or status = 'trialing')
          and ($4::text <> 'stripe_churned_subscribers' or status in ('canceled', 'unpaid'))
          and ($2::text is null or source_id = $2)
        order by coalesce(created_at_source, created_at) desc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit, metric]
    );
  }
  if (metric === "shopify_gross_sales" || metric === "shopify_order_count") {
    return db.query(
      `
        select id, source_id, shopify_order_id, shopify_order_name, customer_id, customer_email,
          currency, financial_status, fulfillment_status, subtotal_price_amount, total_tax_amount,
          total_discount_amount, total_price_amount, occurred_on, processed_at
        from shopify_orders
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by occurred_on desc, processed_at desc nulls last
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (
    metric === "meta_ads_spend" ||
    metric === "meta_ads_clicks" ||
    metric === "impressions" ||
    metric === "reach" ||
    metric === "cpm" ||
    metric === "cpc" ||
    metric === "ctr" ||
    // Phase-1 §6: link_clicks/landing_page_views/frequency are delivery-fact columns
    // (or a recomputed ratio over the delivery grain). They share the delivery view
    // (see metricView/drilldownForMetric) and so MUST drill down to meta_ads_campaign_daily,
    // not the posthog default fallthrough below. The select is widened to the Phase-1
    // delivery columns (inline_link_clicks, landing_page_views, frequency, currency).
    metric === "link_clicks" ||
    metric === "landing_page_views" ||
    metric === "frequency"
  ) {
    return db.query(
      `
        select id, source_id, ad_account_id, campaign_id, campaign_name, occurred_on,
          spend, clicks, inline_link_clicks, landing_page_views, impressions, reach,
          cpm, cpc, ctr,
          -- frequency is a RECOMPUTED ratio (impressions/reach), NOT a stored column on
          -- meta_ads_campaign_daily (see migration 0032 -- frequency is never added). Compute
          -- it inline at the per-row drilldown grain, mirroring the metric_definitions seed
          -- (0034): impressions/nullif(reach,0), reach-APPROXIMATE caveat inherited. Selecting
          -- a bare frequency column here threw the runtime error column frequency does not exist.
          impressions::numeric / nullif(reach, 0) as frequency,
          currency
        from meta_ads_campaign_daily
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by occurred_on desc, campaign_id asc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  // Phase-1 §6 — typed conversions drilldown. results/cost_per_result/conversion_value/roas
  // read the child conversions fact (campaign × day × result_type), LEFT JOINing the delivery
  // fact's spend exactly like the queryable view (cost_per_result = spend/results,
  // roas = conversion_value/spend). Previously these fell through to the posthog_event_truth
  // default branch and returned UNRELATED event rows while the envelope advertised
  // drilldown.meta_ads_campaign_conversion_rows — a provenance/data mismatch. result_type /
  // is_primary / results_source travel so the drilldown is honestly typed.
  if (
    metric === "results" ||
    metric === "cost_per_result" ||
    metric === "conversion_value" ||
    metric === "roas"
  ) {
    return db.query(
      `
        select c.id, c.source_id, c.ad_account_id, c.campaign_id, d.campaign_name,
          c.occurred_on, c.result_type, c.results, c.conversion_value,
          d.spend as meta_ads_spend, c.is_primary, c.results_source
        from meta_ads_campaign_conversions_daily c
        left join meta_ads_campaign_daily d
          on d.source_id = c.source_id
          and d.ad_account_id = c.ad_account_id
          and d.campaign_id = c.campaign_id
          and d.occurred_on = c.occurred_on
        where c.workspace_id = $1
          and ($2::text is null or c.source_id = $2)
        order by c.occurred_on desc, c.campaign_id asc, c.result_type asc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  // Phase-1 §5 — Stripe-attributed ROAS drilldown reads the Meta↔Stripe join view (the same
  // view metricView/aggregateExpression use), carrying matched/unmatched spend + revenue and
  // the match_confidence signal. Falling through to posthog_event_truth here would serve event
  // rows behind a drilldown.meta_stripe_campaign_value_rows envelope.
  if (metric === "roas_from_stripe") {
    return db.query(
      `
        select source_id, ad_account_id, campaign_id, campaign_name, occurred_on,
          currency, match_confidence, matched_spend_major, matched_revenue_major,
          unmatched_spend_major, unmatched_revenue_major
        from queryable.vw_meta_stripe_campaign_value_daily
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by occurred_on desc, campaign_id asc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (
    metric === "site_visitors" ||
    metric === "page_views" ||
    metric === "sessions" ||
    metric === "new_users" ||
    metric === "engaged_sessions" ||
    metric === "key_events" ||
    metric === "engagement_rate" ||
    metric === "average_session_duration" ||
    // Same-lane rule (0062): the rate's numerator AND denominator are ga4_report_snapshot_fact
    // rows, so its drilldown (drilldown.ga4_traffic_provider_rows) shares this GA4 branch.
    metric === "site_conversion_rate"
  ) {
    // PR3 Step 12 — source-isolation FIX (Critical): this branch previously filtered
    // on workspace_id ONLY, leaking cross-site GA4 rows at drilldown. It now honors
    // sourceIdFilter ($2) like the shopify/posthog/meta branches, and widens the
    // select to the GA4 v1 columns for richer drilldown.
    // PR3 review FIX: all 7 GA4 daily-traffic metric ids route to
    // drilldown.ga4_traffic_provider_rows (see drilldownForMetric), so they must share
    // this source-isolated ga4_report_snapshot_fact query. Previously only site_visitors
    // matched here and the other 6 fell through to the wrong (posthog default) branch.
    // page_views_by_page is intentionally excluded — it has its own ga4_page_report_fact
    // branch and drilldown.ga4_page_provider_rows.
    return db.query(
      `
        select id, source_id, reporting_date, country, landing_page, utm_source,
          utm_medium, utm_campaign, sessions, active_users, total_users,
          session_default_channel_group, host_name, device_category,
          new_users, screen_page_views, engaged_sessions, engagement_rate,
          average_session_duration, key_events
        from ga4_report_snapshot_fact
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by reporting_date desc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (metric === "page_views_by_page") {
    // Modeled on the shopify/posthog source-isolated pattern (NOT the site_visitors
    // branch, which lacks the source filter — fixed separately in PR3).
    return db.query(
      `
        select id, source_id, reporting_date, host_name, page_path, page_title,
          screen_page_views, sessions, engaged_sessions, average_session_duration, key_events
        from ga4_page_report_fact
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by reporting_date desc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (metric === "site_event_count" || metric === "site_key_events") {
    // GA4 event-name grain (migration 0061) — its own fact table + drilldown
    // (drilldown.ga4_event_provider_rows), source-isolated like the page branch.
    return db.query(
      `
        select id, source_id, reporting_date, host_name, event_name, event_count, key_events
        from ga4_event_report_fact
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by reporting_date desc, event_name asc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (metric === "posthog_event_count") {
    return db.query(
      `
        select id, source_id, event_id, event_name, distinct_id, person_id,
          session_id, occurred_at, landing_page, referrer, utm_source, utm_medium, utm_campaign
        from posthog_event_truth
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by occurred_at desc, event_name asc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (metric === "x_public_engagement") {
    return db.query(
      `
        with latest_snapshot as (
          select distinct on (workspace_id, source_id, x_post_id)
            workspace_id, source_id, raw_record_id, x_post_id, captured_at,
            retweet_count, reply_count, like_count, quote_count,
            bookmark_count, impression_count
          from x_post_metric_snapshot
          where workspace_id = $1
          order by workspace_id, source_id, x_post_id, captured_at desc
        )
        select p.id as post_row_id, p.x_post_id, p.author_id, p.post_url,
          p.body_text, p.published_at, s.raw_record_id, s.captured_at,
          s.retweet_count, s.reply_count, s.like_count, s.quote_count,
          s.bookmark_count, s.impression_count,
          (
            s.retweet_count + s.reply_count + s.like_count +
            s.quote_count + s.bookmark_count
          ) as x_public_engagement
        from x_post p
        join latest_snapshot s
          on s.workspace_id = p.workspace_id
          and s.source_id = p.source_id
          and s.x_post_id = p.x_post_id
        where p.workspace_id = $1
        order by x_public_engagement desc, s.captured_at desc
        limit $2
      `,
      [workspaceId, limit]
    );
  }
  if (metric === "x_post_count" || metric === "x_comment_count") {
    const authoredRepliesOnly = metric === "x_comment_count" ? "and conversation_id is not null and conversation_id <> x_post_id" : "";
    return db.query(
      `
        select id as post_row_id, source_id, x_post_id, author_id, conversation_id,
          post_url, body_text, published_at,
          1 as x_post_count,
          case
            when conversation_id is not null and conversation_id <> x_post_id then 1
            else 0
          end as x_comment_count
        from x_post
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
          ${authoredRepliesOnly}
        order by published_at desc nulls last
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  if (metric === "x_follower_count") {
    return db.query(
      `
        select
          source_id,
          captured_at,
          x_user_id,
          username,
          followers_count as x_follower_count,
          following_count as x_following_count,
          tweet_count as x_post_count_profile,
          listed_count as x_listed_count,
          like_count as x_like_count
        from x_profile_snapshot
        where workspace_id = $1
          and ($2::text is null or source_id = $2)
        order by captured_at desc
        limit $3
      `,
      [workspaceId, sourceIdFilter ?? null, limit]
    );
  }
  return db.query(
    `
      select id, source_id, event_id, event_name, distinct_id, person_id,
        session_id, occurred_at, landing_page, utm_source, utm_medium, utm_campaign
      from posthog_event_truth
      where workspace_id = $1
      order by occurred_at desc
      limit $2
    `,
    [workspaceId, limit]
  );
}

async function logTool(
  db: InfiniteOsDb,
  context: SessionContext,
  toolName: InfiniteOsActionId,
  input: unknown,
  referencedViews: string[],
  referencedMetrics: string[],
  internalPlan: unknown,
  rowCount = 0
): Promise<void> {
  await db.query(
    `
      insert into tool_execution_log (
        id, workspace_id, actor_type, surface, tool_name, input_payload,
        referenced_views, referenced_metrics, internal_plan, row_count, truncated, execution_ms
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, false, 0)
    `,
    [
      `tool_${randomUUID()}`,
      context.workspaceId,
      context.authority,
      context.surface,
      toolName,
      JSON.stringify(input ?? {}),
      JSON.stringify(referencedViews),
      JSON.stringify(referencedMetrics),
      JSON.stringify(internalPlan ?? {})
    , rowCount]
  );
}

// ---------------------------------------------------------------------------
// REAL FRESHNESS CONTRACT (replaces the historical hardcoded
// `{ target: "24 hours", asOf: null, stale: false }` that made every "not
// stale" claim meaningless — staleness-review G04).
//
// Envelope shape is UNCHANGED and backward-compatible:
//   freshness?: { target: string; asOf: string | null; stale: boolean }
// Semantics now:
//   - target: the per-view sync-cadence target from queryable_views
//     .freshness_target (strictest wins across multiple views; default
//     "24 hours" when metadata is missing/unparseable).
//   - asOf:   the data-recency bound of the STALEST provider feeding the
//     queried view(s): per provider, MAX over its sources of
//     coalesce(sources.last_synced_at /* = plan cursorEnd, the data-window
//     end */, latest succeeded sync_runs.finished_at); across providers the
//     MIN is reported — a joined answer is only as fresh as its stalest
//     input. null when any required provider has never successfully synced.
//   - stale:  true when asOf is null (freshness was never established) or
//     when now - asOf exceeds the target.
// Metadata/inventory envelopes now OMIT freshness entirely (it described
// nothing for them); consumers already treat the field as optional.
// Computation is failure-safe: any lookup error degrades to an OMITTED
// freshness field, never a broken action.
// ---------------------------------------------------------------------------

type EnvelopeFreshness = NonNullable<ActionEnvelope["freshness"]>;

const PROVIDER_TABLE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["ga4_", "google_analytics_4"],
  ["posthog_", "posthog"],
  ["stripe_", "stripe"],
  ["x_", "x"],
  ["shopify_", "shopify"],
  ["meta_", "meta_ads"]
];

function providersForSourceTables(tables: unknown): string[] {
  const providers = new Set<string>();
  if (Array.isArray(tables)) {
    for (const table of tables) {
      if (typeof table !== "string") continue;
      for (const [prefix, provider] of PROVIDER_TABLE_PREFIXES) {
        if (table.startsWith(prefix)) {
          providers.add(provider);
          break;
        }
      }
    }
  }
  return [...providers];
}

export function parseFreshnessTargetMs(target: string): number | undefined {
  const match = /^\s*(\d+)\s*(minute|hour|day)s?\s*$/i.exec(target);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unitMs =
    match[2].toLowerCase() === "minute" ? 60_000 : match[2].toLowerCase() === "hour" ? 3_600_000 : 86_400_000;
  return value * unitMs;
}

const DEFAULT_FRESHNESS_TARGET = "24 hours";

/**
 * Core freshness computation over an explicit provider set. Exported for the
 * freshness contract tests; production callers go through freshnessForViews
 * (view-metadata-driven) or pass providers they already resolved (e.g.
 * validate_journey_plan's requiredProviders).
 */
export async function freshnessForProviders(
  db: InfiniteOsDb,
  workspaceId: string,
  providers: string[],
  target: string = DEFAULT_FRESHNESS_TARGET,
  now: Date = new Date()
): Promise<EnvelopeFreshness | undefined> {
  if (providers.length === 0) {
    return undefined;
  }
  try {
    const rows = await db.query<{ provider: string; as_of: string | Date | null }>(
      `
        select s.provider as provider,
               max(coalesce(s.last_synced_at, sr.last_finished)) as as_of
        from sources s
        left join lateral (
          select max(finished_at) as last_finished
          from sync_runs
          where source_id = s.id and status = 'succeeded'
        ) sr on true
        where s.workspace_id = $1
          and s.provider = any($2::text[])
        group by s.provider
      `,
      [workspaceId, providers]
    );
    const byProvider = new Map<string, Date | null>();
    for (const row of rows) {
      byProvider.set(row.provider, toDateOrNull(row.as_of));
    }
    // A joined answer is only as fresh as its stalest input: report the MIN
    // across required providers, and null (never-established) when any
    // required provider has no successful sync at all.
    let neverSynced = false;
    let asOf: Date | undefined;
    for (const provider of providers) {
      const providerAsOf = byProvider.get(provider) ?? null;
      if (providerAsOf === null) {
        neverSynced = true;
        break;
      }
      if (asOf === undefined || providerAsOf < asOf) {
        asOf = providerAsOf;
      }
    }
    const resolvedAsOf = neverSynced ? null : asOf ?? null;
    const targetMs = parseFreshnessTargetMs(target) ?? parseFreshnessTargetMs(DEFAULT_FRESHNESS_TARGET)!;
    return {
      target,
      asOf: resolvedAsOf ? resolvedAsOf.toISOString() : null,
      stale: resolvedAsOf === null ? true : now.getTime() - resolvedAsOf.getTime() > targetMs
    };
  } catch {
    // Freshness must never break a query — omit the claim instead.
    return undefined;
  }
}

/**
 * View-metadata-driven freshness: resolves each queryable view's
 * freshness_target + source_tables from the seeded queryable_views registry,
 * derives the provider set from the provider-prefixed fact-table names, and
 * reports freshness over that set (strictest target wins across views).
 */
export async function freshnessForViews(
  db: InfiniteOsDb,
  workspaceId: string,
  viewIds: string[],
  now: Date = new Date()
): Promise<EnvelopeFreshness | undefined> {
  const queryableViewIds = [...new Set(viewIds.filter((id) => id.startsWith("queryable.")))];
  if (queryableViewIds.length === 0) {
    return undefined;
  }
  try {
    const rows = await db.query<{ id: string; freshness_target: string | null; source_tables: unknown }>(
      `
        select id, freshness_target, source_tables
        from queryable_views
        where id = any($1::text[])
      `,
      [queryableViewIds]
    );
    const providers = new Set<string>();
    let targetMs: number | undefined;
    let target = DEFAULT_FRESHNESS_TARGET;
    for (const row of rows) {
      for (const provider of providersForSourceTables(parseJsonArray(row.source_tables))) {
        providers.add(provider);
      }
      const rowTarget = row.freshness_target ?? undefined;
      const rowTargetMs = rowTarget ? parseFreshnessTargetMs(rowTarget) : undefined;
      if (rowTarget && rowTargetMs !== undefined && (targetMs === undefined || rowTargetMs < targetMs)) {
        targetMs = rowTargetMs;
        target = rowTarget;
      }
    }
    return freshnessForProviders(db, workspaceId, [...providers], target, now);
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return value;
}

function toDateOrNull(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function envelope<T>(
  actionId: InfiniteOsActionId,
  authority: Authority,
  data: T,
  provenance: string[],
  status: ActionEnvelope<T>["status"] = "ok",
  caveats: string[] = [],
  nextActions: InfiniteOsActionId[] = [],
  freshness?: EnvelopeFreshness
): ActionEnvelope<T> {
  return createEnvelope({
    actionId,
    authority,
    status,
    data,
    provenance,
    // Freshness is a REAL claim now: value-returning local-store readers pass
    // a computed EnvelopeFreshness; metadata/inventory envelopes omit it.
    freshness,
    caveats,
    nextActions
  });
}

function unsupported(
  actionId: InfiniteOsActionId,
  authority: Authority,
  code: string,
  data: Record<string, unknown> = {}
): ActionEnvelope {
  return createEnvelope({
    actionId,
    authority,
    status: "unsupported",
    data,
    error: { code, message: code },
    caveats: [code],
    truncated: false
  });
}

function uniqueActions(actions: InfiniteOsActionId[]): InfiniteOsActionId[] {
  return [...new Set(actions)];
}

function rejectUnsafeView(view: string): void {
  if (!QUERYABLE_VIEW_SET.has(view)) {
    throw new Error(`unsupported_view:${view}`);
  }
}

function rejectUnsupportedMetric(metric: string): void {
  if (!METRIC_SET.has(metric)) {
    throw new Error(`unsupported_metric:${metric}`);
  }
}

// Phase-2 slice-1a §5b — the metric→view guard loosens from a single expected view to the
// metric's GRAIN FAMILY. A metric may legitimately resolve to its campaign view OR its adset
// sibling (the §5a resolver swaps the view NAME by grain; the column aliases stay identical).
// So an exact `view !== metricView(metric)` check would wrongly reject the adset sibling the
// resolver itself selected. We instead accept any view in metricGrainFamily(metric).
function rejectMetricViewMismatch(metric: string, view: string): void {
  const family = metricGrainFamily(metric);
  if (!family.includes(view)) {
    throw new Error(`unsupported_view_for_metric:${metric}:${view}`);
  }
}

// Phase-2 slice-1a §5 — the campaign↔adset sibling map. The campaign view is the family BASE
// (what metricView returns, the worker's no-group-by default — §5d); the adset view is the
// finer-grain sibling the resolver swaps to when an adset dim is present (§5a). Only the Meta
// delivery + Meta-native conversion families have an adset sibling this slice. CRITICAL (§5e):
// roas_from_stripe is DELIBERATELY ABSENT — its view (vw_meta_stripe_campaign_value_daily) has
// no adset sibling, so it stays campaign-grain at every grain (mapping it here would 404 a
// non-existent view). Everything not in this map is single-grain (its family is just its one
// metricView), so non-Meta metrics keep their exact-match guard behavior automatically.
const META_ADSET_VIEW_BY_CAMPAIGN_VIEW: Record<string, string> = {
  "queryable.vw_meta_ads_campaign_daily": "queryable.vw_meta_ads_adset_daily",
  "queryable.vw_meta_ads_campaign_conversions_daily": "queryable.vw_meta_ads_adset_conversions_daily"
};

// Phase-2 slice-1b §5 — the campaign→ad sibling map (the THIRD, finest grain). Parallel to
// META_ADSET_VIEW_BY_CAMPAIGN_VIEW: the campaign view is still the family base, and the ad view
// is the FINEST-grain sibling the resolver swaps to when an ad_id/ad_name dim is present (§5),
// taking precedence over the adset view (finest-grain-wins). roas_from_stripe is again
// DELIBERATELY ABSENT (campaign-only at every grain — its Stripe-join view has no ad sibling).
// ZERO-REGRESSION DEFAULT: until the ad views exist on disk (this slice's migration), the picker
// guards every ad branch on `adView && …`, so a metric whose campaign view is absent here (or any
// caller before the migration lands) collapses to exactly today's adset-or-campaign binary.
const META_AD_VIEW_BY_CAMPAIGN_VIEW: Record<string, string> = {
  "queryable.vw_meta_ads_campaign_daily": "queryable.vw_meta_ads_ad_daily",
  "queryable.vw_meta_ads_campaign_conversions_daily": "queryable.vw_meta_ads_ad_conversions_daily"
};

// The metric's grain family = the set of views it may legitimately resolve to (§5b loosening,
// extended one notch for ad grain). For a Meta metric with siblings that is
// [campaignView, adsetView, adView]; for everything else (incl. roas_from_stripe) it is just
// [metricView(metric)]. Absent siblings are filtered out so the family is never padded with a
// view that does not exist for the metric. Used by rejectMetricViewMismatch (§5b).
function metricGrainFamily(metric: string): string[] {
  const base = metricView(metric);
  const adsetSibling = META_ADSET_VIEW_BY_CAMPAIGN_VIEW[base];
  const adSibling = META_AD_VIEW_BY_CAMPAIGN_VIEW[base];
  return [base, adsetSibling, adSibling].filter((view): view is string => Boolean(view));
}

// Exported (DEDUP single-source-of-truth): consumed by apps/worker runSavedReport.
export function metricView(metric: string): string {
  if (metric === "site_visitors") return "queryable.vw_site_traffic";
  if (
    metric === "page_views" ||
    metric === "sessions" ||
    metric === "new_users" ||
    metric === "engaged_sessions" ||
    metric === "key_events" ||
    metric === "engagement_rate" ||
    metric === "average_session_duration"
  ) {
    return "queryable.vw_site_traffic";
  }
  if (metric === "page_views_by_page") return "queryable.vw_site_pages";
  if (metric === "site_event_count" || metric === "site_key_events") return "queryable.vw_site_events";
  if (metric === "posthog_event_count") return "queryable.vw_posthog_events";
  if (metric === "posthog_page_views") return "queryable.vw_posthog_site";
  if (metric === "recognized_revenue") return "queryable.vw_revenue_by_source";
  if (isStripeLifecycleMetric(metric)) return "queryable.vw_stripe_subscription_lifecycle";
  if (metric === "stripe_paid_subscribers") return "queryable.vw_stripe_paid_subscribers";
  if (metric === "shopify_gross_sales" || metric === "shopify_order_count") return "queryable.vw_shopify_orders";
  if (
    metric === "meta_ads_spend" ||
    metric === "meta_ads_clicks" ||
    metric === "impressions" ||
    metric === "reach" ||
    metric === "cpm" ||
    metric === "cpc" ||
    metric === "ctr" ||
    // Phase-1 §6: link_clicks/landing_page_views are delivery-fact columns; frequency is a
    // recomputed ratio (impressions/reach) over the SAME delivery grain. All three read the
    // delivery view, not the typed conversions view.
    metric === "link_clicks" ||
    metric === "landing_page_views" ||
    metric === "frequency"
  ) {
    return "queryable.vw_meta_ads_campaign_daily";
  }
  // Phase-1 §6: typed conversions (results/cost_per_result/conversion_value/roas) live on the
  // child fact partitioned by result_type. result_type is a REQUIRED partition for these —
  // see requiresResultTypePartition() + runAggregate's refusal guard.
  if (
    metric === "results" ||
    metric === "cost_per_result" ||
    metric === "conversion_value" ||
    metric === "roas"
  ) {
    return "queryable.vw_meta_ads_campaign_conversions_daily";
  }
  // Phase-1 §5: Stripe-sourced ROAS reads the Meta↔Stripe true-value join view.
  if (metric === "roas_from_stripe") return "queryable.vw_meta_stripe_campaign_value_daily";
  if (metric === "x_public_engagement") return "queryable.vw_x_post_public_metrics";
  if (metric === "x_post_count" || metric === "x_comment_count") return "queryable.vw_x_authored_activity";
  if (metric === "x_follower_count") return "queryable.vw_x_profile_public_metrics";
  // Same-lane rule (0062): signup_count reads the PURE PostHog lane — its authority/drilldown always
  // claimed PostHog, and the blended conversion view it used to ride no longer carries signups.
  if (metric === "signup_count") return "queryable.vw_posthog_events";
  // site_conversion_rate — since 0062 a SAME-LANE GA4 view (key_events ÷ visitors, both
  // ga4_report_snapshot_fact), no longer a cross-provider blend. An EXPLICIT branch: it used to be
  // the function's silent fall-through, which served this view's numbers for ANY unrecognized name.
  if (metric === "site_conversion_rate") return "queryable.vw_site_conversion_rate";
  // No default view. An unknown metric is a caller bug (a typo, a stale saved report, a registry
  // seed with no routing entry) and must surface as one — a crash beats a silent wrong chart.
  throw new Error(`unknown_metric:${metric}`);
}

// Phase-2 slice-1a §5a / slice-1b §5 — the GRAIN-AWARE view resolver (the keystone). It picks
// the FINEST grain present in the query, with finest-grain-wins precedence ad > adset > campaign:
//   • an ad_id/ad_name dim in the group-by OR a filter selects the metric's ad sibling view;
//   • else an adset_id/adset_name dim selects the metric's adset sibling view;
//   • else it returns metricView(metric), today's campaign default.
// Detection runs on the FINEST grain first and returns early, so when an ad dim co-occurs with an
// adset_id (or a campaign_id filter), adset_id/campaign_id become CARRIES at ad grain — the ad
// branch already returned and the coarser checks never re-flip the picker (§5e precedence).
// metricView stays the campaign-only shim (the family base + the worker's no-group-by entry
// point — §5d), so EVERY existing call site that passes no finer dim resolves byte-for-byte to
// the campaign view it does today (the no-regression contract). roas_from_stripe is forced
// campaign-only (§5e + §10): its view has no adset/ad sibling, so it never swaps.
//
// ZERO-REGRESSION DEFAULT is structural, not just tested: each finer branch is guarded on the
// sibling existing (`if (adSibling && …)`), so when the ad views are not on disk yet (the ad
// lookup returns undefined) the ad branch is skipped and the function collapses to EXACTLY the
// slice-1a adset-or-campaign binary. campaign + adset resolve byte-for-byte until the ad views
// exist; the ad routing turns on only once META_AD_VIEW_BY_CAMPAIGN_VIEW resolves a real view.
//
// Exported alongside metricView so callers that need grain-aware routing (the interactive
// run_metric_query / run_breakdown_query handlers) share one source of truth.
export function metricViewForGrain(metric: string, groupBy: string[], filters: { field: string }[]): string {
  const campaignView = metricView(metric);
  // roas_from_stripe has no adset/ad sibling — always campaign-grain (§5e/§10). Special-case it
  // BEFORE any dim detection so an incidental adset_id/ad_id elsewhere can't 404 its view.
  if (metric === "roas_from_stripe") {
    return campaignView;
  }
  // FINEST FIRST: detect an ad dimension in the group-by OR the filters. We normalize each
  // candidate field against the ad sibling view's alias table (so ad/ad_name/ad_key/… all
  // resolve to the canonical ad_id|ad_name) — mirroring how runAggregate normalizes against the
  // RESOLVED view. Guarded on adSibling so absence (no ad view yet) is the no-op default.
  const adSibling = META_AD_VIEW_BY_CAMPAIGN_VIEW[campaignView];
  if (adSibling) {
    const hasAdDim =
      groupBy.some((field) => isAdDimension(normalizeDimensionAlias(adSibling, field))) ||
      filters.some((filter) => isAdDimension(normalizeDimensionAlias(adSibling, filter.field)));
    if (hasAdDim) {
      return adSibling;
    }
  }
  const adsetSibling = META_ADSET_VIEW_BY_CAMPAIGN_VIEW[campaignView];
  // No adset sibling (non-Meta metric, or a Meta metric whose view has none) → campaign.
  if (!adsetSibling) {
    return campaignView;
  }
  // Detect an adset dimension in the group-by OR the filters (§5e: a coarser campaign filter +
  // a finer adset group-by, or vice-versa, still flips to adset). Normalize against the adset
  // sibling view's alias table, as runAggregate does against the resolved view.
  const hasAdsetDim =
    groupBy.some((field) => isAdsetDimension(normalizeDimensionAlias(adsetSibling, field))) ||
    filters.some((filter) => isAdsetDimension(normalizeDimensionAlias(adsetSibling, filter.field)));
  return hasAdsetDim ? adsetSibling : campaignView;
}

// True when a (already alias-normalized) dimension is an adset-grain identity dim — the signal
// that flips view selection from campaign to the adset sibling. campaign_id is NOT here: it is
// a CARRY column present on both grains (filtering campaign_id while grouping adset_id is the
// §5e coarser-filter + finer-group case, which must resolve to ADSET, driven by the group-by).
function isAdsetDimension(field: string): boolean {
  return field === "adset_id" || field === "adset_name";
}

// Phase-2 slice-1b §5 — true when a (already alias-normalized) dimension is an AD-grain identity
// dim, the signal that flips view selection to the ad sibling (the finest grain). Mirrors
// isAdsetDimension. adset_id and campaign_id are NOT here: at ad grain they are CARRY columns
// (present on the ad views' allowlists), so an adset_id that co-occurs with an ad dim never
// re-flips the picker — the ad branch in metricViewForGrain returns before the adset check runs.
function isAdDimension(field: string): boolean {
  return field === "ad_id" || field === "ad_name";
}

// Exported (DEDUP single-source-of-truth): consumed by apps/worker runSavedReport.
export function metricColumn(metric: string): string {
  // Identity for every metric whose id == its view column (the aliasing convention).
  // page_views_by_page is the ONE exception: it reads vw_site_pages' `page_views`
  // column (a distinct metric bound to the page view; the view aliases
  // screen_page_views -> page_views, NOT -> page_views_by_page). The engine's
  // aggregateExpression uses this column for the default sum(); the worker NEVER
  // builds SQL for page_views_by_page (it is breakdown-only and excluded from saved
  // reports — see apps/worker/src/index.ts), so this branch is engine-only by design.
  if (metric === "page_views_by_page") return "page_views";
  return metric;
}

function isStripeLifecycleMetric(metric: string): boolean {
  return (
    metric === "stripe_current_paid_subscribers" ||
    metric === "stripe_new_paid_subscribers" ||
    metric === "stripe_trialing_subscribers" ||
    metric === "stripe_churned_subscribers"
  );
}

function isStripeSubscriberMetric(metric: string): boolean {
  return metric === "stripe_paid_subscribers" || isStripeLifecycleMetric(metric);
}

// Exported (DEDUP single-source-of-truth): consumed by apps/worker runSavedReport.
export function aggregateExpression(metric: string, column: string): string {
  if (metric === "site_conversion_rate") {
    return "avg(site_conversion_rate)";
  }
  // Same-lane rule (0062): signup_count sums the PostHog event lane's per-grain counts, filtered to
  // the signup event. COALESCE keeps the old blended view's measured-zero shape: that view emitted a
  // 0 (not NULL) for grains with traffic but no signups, and breakdowns rank `order by metric desc`
  // where a NULL-sum group would misleadingly sort above every real count.
  if (metric === "signup_count") {
    return "coalesce(sum(posthog_event_count) filter (where event_name = 'signup'), 0)";
  }
  // Rate metrics are non-additive: session-weighted average across the daily grain
  // (sessions co-resides in vw_site_traffic). MUST NOT be sum()/avg() alone.
  if (metric === "engagement_rate") {
    return "case when sum(sessions) = 0 then null else sum(engagement_rate * sessions) / sum(sessions) end";
  }
  if (metric === "average_session_duration") {
    return "case when sum(sessions) = 0 then null else sum(average_session_duration * sessions) / sum(sessions) end";
  }
  // Meta Ads ratio metrics are NON-ADDITIVE: they MUST be recomputed from the summed
  // numerator/denominator over the campaign×day grain, never averaged per-row (avg(cpm)
  // would weight every campaign-day equally regardless of spend/impression volume, which
  // is arithmetically wrong). nullif(...,0) guards divide-by-zero -> NULL.
  if (metric === "cpm") {
    return "sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000";
  }
  if (metric === "cpc") {
    return "sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0)";
  }
  if (metric === "ctr") {
    return "sum(meta_ads_clicks) / nullif(sum(impressions), 0)";
  }
  // Phase-1 §6 Meta conversions/value ratio metrics — same recompute-from-summed-bases rule
  // as cpm/cpc/ctr. cost_per_result and roas are NON-ADDITIVE: avg(per-row cost_per_result)
  // or avg(per-row roas) would weight every campaign-day equally regardless of spend volume,
  // which is arithmetically wrong. They MUST divide the summed numerator by the summed
  // denominator. CRITICAL (§6): for cost_per_result/roas this summation is only ever valid
  // WITHIN a single result_type — result_type is a REQUIRED partition (requiresResultTypePartition
  // + runAggregate's refusal guard force a per-type group-by) so CPL and CPA never blend.
  if (metric === "cost_per_result") {
    return "sum(meta_ads_spend) / nullif(sum(results), 0)";
  }
  if (metric === "roas") {
    return "sum(conversion_value) / nullif(sum(meta_ads_spend), 0)";
  }
  // frequency = impressions / reach, recomputed from summed bases (inherits reach's
  // APPROXIMATE caveat — see caveatsForMetric). Never avg(per-row frequency).
  if (metric === "frequency") {
    return "sum(impressions) / nullif(sum(reach), 0)";
  }
  // Phase-1 §5 Stripe-sourced ROAS — recomputed from the summed, currency-reconciled bases
  // the join view exposes (revenue already converted to major units in the matched account
  // currency; spend in major units). Mapping-dependent: only matched rows contribute (the
  // view drops unmatched spend/revenue from the numerator/denominator and surfaces them
  // separately). avg(per-row roas) would be wrong here too.
  if (metric === "roas_from_stripe") {
    return "sum(matched_revenue_major) / nullif(sum(matched_spend_major), 0)";
  }
  // results/conversion_value/link_clicks/landing_page_views are additive -> sum(column).
  return `sum(${column})`;
}

// Phase-1 §6 — the conversion-family metrics for which result_type is a REQUIRED partition,
// not merely an allowed dimension. A query over these MUST group by result_type (or filter to
// a single result_type) so CPL and CPA are NEVER silently blended/averaged across types. This
// is the imperative guard the spec demands — metric_definitions.required_filters records the
// contract but nothing reads it; the enforcement lives here + in runAggregate.
//
// Exported so the worker saved-report path (which cannot group-by) can EXCLUDE these metrics
// the same way it excludes page_views_by_page, rather than emit a silently-blended number.
const RESULT_TYPE_PARTITIONED_METRICS = new Set<string>([
  "results",
  "cost_per_result",
  "conversion_value",
  "roas"
]);

export function requiresResultTypePartition(metric: string): boolean {
  return RESULT_TYPE_PARTITIONED_METRICS.has(metric);
}

function allowedDimensionsForView(view: string): string[] {
  if (view === "queryable.vw_site_traffic") {
    // occurred_on (= reporting_date, the daily grain of ga4_report_snapshot_fact) is a plain column —
    // no date_trunc / time-grain wrapping — so grouping by it yields a per-day page_views / site_visitors
    // series (parity with vw_posthog_events and the *_daily ad views that already list occurred_on).
    return [
      "country",
      "landing_page",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "session_default_channel_group",
      "host_name",
      "device_category",
      "occurred_on"
    ];
  }
  if (view === "queryable.vw_site_pages") {
    return ["host_name", "page_path", "page_title"];
  }
  // GA4 event-name grain (migration 0061). occurred_on is the daily grain; source_id enables
  // per-property isolation (the vw_posthog_events precedent).
  if (view === "queryable.vw_site_events") {
    return ["source_id", "event_name", "host_name", "occurred_on"];
  }
  if (view === "queryable.vw_posthog_events") {
    return ["source_id", "event_name", "occurred_on", "landing_page", "referrer", "utm_source", "utm_medium", "utm_campaign"];
  }
  // PostHog audience view (slice 1) — device/OS/geo/browser audience dims extracted from
  // posthog_event_truth.properties in the migration 0043 view (aliased into real columns, so
  // dimensionExpression stays identity). Mirrors the vw_site_traffic audience allow-list shape
  // (device_category/country) for the PostHog source. occurred_on is the daily grain.
  if (view === "queryable.vw_posthog_site") {
    return [
      "device_type",
      "operating_system",
      "browser",
      "country",
      "region",
      "city",
      "landing_page",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "occurred_on"
    ];
  }
  if (view === "queryable.vw_revenue_by_source") {
    return ["provider", "currency", "external_order_id", "customer_external_id"];
  }
  if (view === "queryable.vw_stripe_paid_subscribers") {
    return ["provider", "status", "currency", "occurred_on"];
  }
  if (view === "queryable.vw_stripe_subscription_lifecycle") {
    return ["provider", "metric_kind", "status", "currency", "occurred_on"];
  }
  if (view === "queryable.vw_shopify_orders") {
    return ["shopify_order_id", "shopify_order_name", "customer_id", "customer_email", "currency"];
  }
  if (view === "queryable.vw_shopify_products") {
    return ["shopify_product_id", "title", "vendor", "product_type", "status"];
  }
  if (view === "queryable.vw_meta_ads_campaign_daily") {
    return ["ad_account_id", "campaign_id", "campaign_name", "currency", "occurred_on"];
  }
  // Phase-2 slice-1a §3 — the adset-grain delivery view. Mirrors the campaign delivery view's
  // dims and ADDS the adset identity dims (adset_id/adset_name) + the on/off status dims
  // (effective_status/configured_status). campaign_id is CARRIED so the §5e coarser-filter +
  // finer-group case (filter campaign_id, group adset_id) passes runAggregate's filter gate.
  // Without effective_status/configured_status here, a "CPL for my ACTIVE adsets" group/filter
  // (spec §6/§7) would be rejected as unsupported_dimension by runAggregate.
  if (view === "queryable.vw_meta_ads_adset_daily") {
    return [
      "ad_account_id",
      "campaign_id",
      "adset_id",
      "adset_name",
      "effective_status",
      "configured_status",
      "currency",
      "occurred_on"
    ];
  }
  // Phase-2 slice-1b §3/§5 — the ad-grain delivery view. Mirrors the adset delivery view's dims
  // and ADDS the ad identity dims (ad_id/ad_name). campaign_id AND adset_id are CARRIED so the
  // §5e finer-group + coarser-filter case (filter adset_id/campaign_id while grouping ad_id)
  // passes runAggregate's filter gate — without adset_id here, a "spend per ad within adset X"
  // query routes correctly to the ad view but then throws unsupported_dimension on the filter.
  // optimization_goal is DELIBERATELY ABSENT — it is an ADSET property the connector carries
  // in-memory from the adset-dim map, never a queryable ad dim (§2.3/§5).
  if (view === "queryable.vw_meta_ads_ad_daily") {
    return [
      "ad_account_id",
      "campaign_id",
      "adset_id",
      "ad_id",
      "ad_name",
      "effective_status",
      "configured_status",
      "currency",
      "occurred_on"
    ];
  }
  // Phase-1 §6 — the typed conversions view. result_type is the REQUIRED partition for the
  // conversion-family metrics (results/cost_per_result/conversion_value/roas); it is in the
  // allowlist so callers CAN group/filter by it, and requiresResultTypePartition() forces
  // them to. is_primary/results_source let callers isolate the canonical headline result.
  if (view === "queryable.vw_meta_ads_campaign_conversions_daily") {
    return ["ad_account_id", "campaign_id", "result_type", "is_primary", "results_source", "occurred_on"];
  }
  // Phase-2 slice-1a §3 — the adset-grain typed-conversions view. Same conversion-family dims
  // as the campaign conversions view (result_type stays the REQUIRED partition, unchanged) PLUS
  // the adset identity + on/off status dims. carry campaign_id (§5e).
  if (view === "queryable.vw_meta_ads_adset_conversions_daily") {
    return [
      "ad_account_id",
      "campaign_id",
      "adset_id",
      "adset_name",
      "effective_status",
      "configured_status",
      "result_type",
      "is_primary",
      "results_source",
      "occurred_on"
    ];
  }
  // Phase-2 slice-1b §3/§5 — the ad-grain typed-conversions view. Same conversion-family dims as
  // the adset conversions view (result_type stays the REQUIRED partition — requiresResultType-
  // Partition is metric-keyed, so it already fires at ad grain) PLUS the ad identity dim. carry
  // campaign_id + adset_id (§5e). optimization_goal is DROPPED from the ad conversions SELECT
  // (adset property) so it is NOT in this allowlist.
  if (view === "queryable.vw_meta_ads_ad_conversions_daily") {
    return [
      "ad_account_id",
      "campaign_id",
      "adset_id",
      "ad_id",
      "ad_name",
      "effective_status",
      "configured_status",
      "result_type",
      "is_primary",
      "results_source",
      "occurred_on"
    ];
  }
  // Phase-1 §5 — the Meta↔Stripe true-value join view. match_confidence is the join-quality
  // signal (exact|normalized|fuzzy|unmatched); currency is the reconciled account currency.
  if (view === "queryable.vw_meta_stripe_campaign_value_daily") {
    return ["ad_account_id", "campaign_id", "campaign_name", "match_confidence", "currency", "occurred_on"];
  }
  if (view === "queryable.vw_x_post_public_metrics") {
    return [
      "x_post_id",
      "author_id",
      "post_url",
      "body_text",
      "published_at",
      "content_type",
      "mentioned_handle",
      "published_hour_utc",
      "published_weekday_utc"
    ];
  }
  if (view === "queryable.vw_x_authored_activity") {
    return [
      "x_post_id",
      "author_id",
      "conversation_id",
      "post_url",
      "body_text",
      "published_at",
      "content_type",
      "mentioned_handle",
      "published_hour_utc",
      "published_weekday_utc"
    ];
  }
  if (view === "queryable.vw_x_profile_public_metrics") {
    return ["x_user_id", "username"];
  }
  return ["landing_page", "referrer", "utm_source", "utm_medium", "utm_campaign"];
}

function hydrateQueryableViewMetadata(view: Record<string, unknown> | null): Record<string, unknown> {
  if (!view) {
    return {};
  }
  const id = optionalString(view, "id");
  if (!id || (id !== "queryable.vw_x_post_public_metrics" && id !== "queryable.vw_x_authored_activity")) {
    return view;
  }
  return {
    ...view,
    allowed_dimensions: appendAllowedDimensions(view.allowed_dimensions, [
      "published_at",
      "content_type",
      "mentioned_handle",
      "published_hour_utc",
      "published_weekday_utc"
    ])
  };
}

function hydrateMetricMetadata(metric: Record<string, unknown> | null): Record<string, unknown> {
  if (!metric) {
    return {};
  }
  const id = optionalString(metric, "id");
  if (!id || (id !== "x_public_engagement" && id !== "x_post_count" && id !== "x_comment_count")) {
    return metric;
  }
  return {
    ...metric,
    allowed_dimensions: appendAllowedDimensions(metric.allowed_dimensions, [
      "published_at",
      "content_type",
      "mentioned_handle",
      "published_hour_utc",
      "published_weekday_utc"
    ])
  };
}

function appendAllowedDimensions(value: unknown, dimensions: string[]): unknown {
  const dims = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const merged = [...dims];
  for (const dimension of dimensions) {
    if (!merged.includes(dimension)) {
      merged.push(dimension);
    }
  }
  return merged;
}

// Exported (DEDUP single-source-of-truth): consumed by apps/worker runSavedReport.
export function caveatsForMetric(metric: string): string[] {
  if (metric === "recognized_revenue") return ["content_linkage_not_implemented"];
  if (metric === "stripe_current_paid_subscribers") {
    return ["current_snapshot", "positive_recurring_value_only", "trialing_excluded"];
  }
  if (metric === "stripe_new_paid_subscribers") {
    return ["positive_recurring_value_only", "uses_trial_end_or_subscription_created_at_as_first_paid_date"];
  }
  if (metric === "stripe_trialing_subscribers") {
    return ["trialing_is_not_paid", "stripe_dashboard_new_trials_are_subscription_grained"];
  }
  if (metric === "stripe_churned_subscribers") {
    return ["customer_churn_requires_all_paid_subscriptions_zero", "v1_uses_subscription_status_rows"];
  }
  if (metric === "stripe_paid_subscribers") {
    return ["deprecated_metric_id", "current_paid_is_snapshot", "use_stripe_current_paid_subscribers_for_new_work"];
  }
  if (metric === "posthog_event_count") return ["source_native_event_counts"];
  // posthog_page_views is scoped to client-side $pageview events (migration 0043): the count
  // is pageview-only, and the audience props ($os/$device_type/$geoip_*/$browser) ride
  // client-side capture, so server-side events carry none of them. Both facts are surfaced
  // so a consumer never over-claims coverage.
  if (metric === "posthog_page_views") {
    return ["source_native_event_counts", "pageview_events_only", "audience_props_client_side_only"];
  }
  if (metric === "shopify_gross_sales" || metric === "shopify_order_count") return ["order_level_shopify_commerce_authority"];
  if (metric === "meta_ads_spend" || metric === "meta_ads_clicks") return ["read_only_marketing_api_reporting"];
  if (metric === "impressions") return ["read_only_marketing_api_reporting"];
  // reach is APPROXIMATE at campaign×day grain: summing daily reach overcounts unique
  // people (someone reached on two days is counted twice). We surface the daily-reach
  // sum but flag it so it is never claimed as exact de-duplicated unique reach.
  if (metric === "reach") {
    return ["read_only_marketing_api_reporting", "reach_is_approximate_summed_daily_reach_overcounts_unique_people"];
  }
  // Ratio metrics are recomputed from summed bases (see aggregateExpression). The caveat
  // records that these are derived/recomputed ratios, not stored per-row averages.
  if (metric === "cpm" || metric === "cpc" || metric === "ctr") {
    return ["read_only_marketing_api_reporting", "ratio_recomputed_from_summed_bases"];
  }
  // Phase-1 §6 — Meta conversions/value metrics. result_type is a REQUIRED partition: the
  // engine refuses to aggregate these across mixed result_types (see runAggregate's guard),
  // and the caveat documents the contract so an envelope consumer never blends CPL+CPA.
  if (metric === "results") {
    return ["read_only_marketing_api_reporting", "result_type_is_a_required_partition"];
  }
  if (metric === "cost_per_result") {
    return [
      "read_only_marketing_api_reporting",
      "ratio_recomputed_from_summed_bases",
      "cost_per_result_must_not_blend_across_result_types",
      "value_in_account_currency"
    ];
  }
  // conversion_value is purchase-only (a configured lead value is NOT revenue) and in the
  // ad-account currency — same channel as the count spine (offsite_conversion.fb_pixel_purchase).
  if (metric === "conversion_value") {
    return [
      "read_only_marketing_api_reporting",
      "result_type_is_a_required_partition",
      "conversion_value_purchase_only",
      "value_in_account_currency"
    ];
  }
  // roas is NULL for lead-gen (no Meta revenue); a browser/pixel-attributed floor in the
  // account currency; recomputed from summed bases, never blended across result_types.
  if (metric === "roas") {
    return [
      "read_only_marketing_api_reporting",
      "ratio_recomputed_from_summed_bases",
      "cost_per_result_must_not_blend_across_result_types",
      "value_in_account_currency",
      "roas_null_for_lead_gen_browser_attributed_floor"
    ];
  }
  if (metric === "link_clicks") {
    return ["read_only_marketing_api_reporting"];
  }
  // landing_page_views is the non-omni action (the omni_landing_page_view superset is excluded).
  if (metric === "landing_page_views") {
    return ["read_only_marketing_api_reporting", "landing_page_views_non_omni"];
  }
  // frequency = impressions/reach (recomputed from summed bases) inherits reach's APPROXIMATE
  // caveat: summing daily reach overcounts unique people, so the denominator is approximate.
  if (metric === "frequency") {
    return [
      "read_only_marketing_api_reporting",
      "ratio_recomputed_from_summed_bases",
      "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
    ];
  }
  // Phase-1 §5 — Stripe-sourced ROAS is mapping-dependent: it divides matched Stripe revenue
  // (currency-reconciled to the Meta account currency) by matched Meta spend, so it is only as
  // good as the campaign↔revenue match. Unmatched spend/revenue are excluded and surfaced
  // separately by the view; there is an inherent Meta-vs-Stripe attribution-date offset.
  if (metric === "roas_from_stripe") {
    return [
      "stripe_attributed_roas_is_mapping_dependent",
      "ratio_recomputed_from_summed_bases",
      "excludes_unmatched_spend_and_unmatched_revenue",
      // Unmapped Stripe-source revenue surfaces on campaign-NULL rows of the view (the §5
      // join-quality signal) — without it unmatched_revenue is structurally 0.
      "unmatched_revenue_surfaced_on_campaign_null_rows",
      // The map is SOURCE-LEVEL: matched_revenue sums the whole Stripe-source-day revenue and can
      // over-credit unrelated invoices billed through the same account. Upper bound, not per-order
      // attribution (per-order/UTM attribution is out of Phase-1 scope).
      "stripe_revenue_is_source_level_may_over_attribute",
      "currency_reconciled_to_account_currency_before_dividing",
      "meta_vs_stripe_attribution_date_offset"
    ];
  }
  if (metric === "site_visitors") return ["source_native_attribution_only"];
  if (metric === "page_views_by_page") return ["source_native_attribution_only"];
  // Same-lane GA4 rate since 0062 — key_events may simply not be configured on a property.
  if (metric === "site_conversion_rate") {
    return ["source_native_attribution_only", "key_events_may_be_unconfigured", "channel_campaign_landing_page_grain_only"];
  }
  if (metric === "site_event_count") return ["source_native_attribution_only"];
  if (metric === "site_key_events") {
    return ["source_native_attribution_only", "key_events_may_be_unconfigured"];
  }
  if (
    metric === "page_views" ||
    metric === "sessions" ||
    metric === "new_users" ||
    metric === "engaged_sessions"
  ) {
    return ["source_native_attribution_only"];
  }
  if (metric === "key_events") {
    return ["source_native_attribution_only", "key_events_may_be_unconfigured"];
  }
  if (metric === "engagement_rate" || metric === "average_session_duration") {
    return ["source_native_attribution_only", "weighted_average_across_grain"];
  }
  if (metric === "x_public_engagement") {
    return ["public_metrics_only", "no_posting", "no_paid_or_private_metrics", "no_content_attribution"];
  }
  if (metric === "x_post_count") {
    return ["public_posts_only"];
  }
  if (metric === "x_comment_count") {
    return ["reply_count_is_authored_replies_only_when_present_in_source_timeline"];
  }
  if (metric === "x_follower_count") {
    return ["public_profile_metrics_only"];
  }
  return [
    "source_native_attribution_only",
    "content_linkage_not_implemented",
    "channel_campaign_landing_page_grain_only"
  ];
}

function sourceAuthorityForMetric(metric: string): string {
  if (metric === "recognized_revenue") return "Stripe is the first-phase revenue authority";
  if (isStripeSubscriberMetric(metric)) return "Stripe is the first-phase subscription lifecycle authority";
  if (metric === "posthog_event_count") return "PostHog event records are the first-phase event authority";
  if (metric === "shopify_gross_sales" || metric === "shopify_order_count") return "Shopify order records are the first-phase commerce authority";
  if (
    metric === "meta_ads_spend" ||
    metric === "meta_ads_clicks" ||
    metric === "impressions" ||
    metric === "reach" ||
    metric === "cpm" ||
    metric === "cpc" ||
    metric === "ctr" ||
    metric === "results" ||
    metric === "cost_per_result" ||
    metric === "conversion_value" ||
    metric === "roas" ||
    metric === "link_clicks" ||
    metric === "landing_page_views" ||
    metric === "frequency"
  ) {
    return "Meta Ads campaign insights are the first-phase paid media authority";
  }
  // Phase-1 §5 — Stripe is the revenue authority; Meta is the spend authority; the join view
  // derives ROAS from both. Surfaced as a derived cross-source authority.
  if (metric === "roas_from_stripe") {
    return "Stripe revenue joined to Meta Ads spend is the first-phase Stripe-attributed ROAS authority";
  }
  if (metric === "site_visitors") return "GA4 is the first-phase traffic authority";
  // Same-lane rule (0062): the rate divides GA4 by GA4, so GA4 is its whole authority (the old
  // default claimed PostHog signups — true only of the retired blended numerator).
  if (metric === "site_conversion_rate") return "GA4 is the first-phase traffic authority";
  if (
    metric === "page_views_by_page" ||
    metric === "site_event_count" ||
    metric === "site_key_events" ||
    metric === "page_views" ||
    metric === "sessions" ||
    metric === "new_users" ||
    metric === "engaged_sessions" ||
    metric === "key_events" ||
    metric === "engagement_rate" ||
    metric === "average_session_duration"
  ) {
    return "GA4 is the first-phase traffic authority";
  }
  if (metric === "x_public_engagement") return "X public metrics are the first-phase post engagement authority";
  if (metric === "x_post_count") return "X authored posts in the synced timeline are the first-phase posting authority";
  if (metric === "x_comment_count") return "X authored replies in the synced timeline are the first-phase comment authority";
  if (metric === "x_follower_count") return "X public profile metrics are the first-phase follower authority";
  return "PostHog signup events are the first-phase signup authority";
}

function drilldownForMetric(metric: string): string {
  if (metric === "recognized_revenue") return "drilldown.stripe_revenue_provider_rows";
  if (isStripeSubscriberMetric(metric)) return "drilldown.stripe_subscription_rows";
  if (metric === "posthog_event_count") return "drilldown.posthog_event_provider_rows";
  if (metric === "shopify_gross_sales" || metric === "shopify_order_count") return "drilldown.shopify_order_rows";
  if (
    metric === "meta_ads_spend" ||
    metric === "meta_ads_clicks" ||
    metric === "impressions" ||
    metric === "reach" ||
    metric === "cpm" ||
    metric === "cpc" ||
    metric === "ctr" ||
    metric === "link_clicks" ||
    metric === "landing_page_views" ||
    metric === "frequency"
  ) {
    return "drilldown.meta_ads_campaign_rows";
  }
  // Phase-1 §6 — typed conversions drill down to the per-result_type conversion rows.
  if (
    metric === "results" ||
    metric === "cost_per_result" ||
    metric === "conversion_value" ||
    metric === "roas"
  ) {
    return "drilldown.meta_ads_campaign_conversion_rows";
  }
  // Phase-1 §5 — Stripe-attributed ROAS drills down to the matched campaign↔revenue rows.
  if (metric === "roas_from_stripe") return "drilldown.meta_stripe_campaign_value_rows";
  if (metric === "site_visitors") return "drilldown.ga4_traffic_provider_rows";
  if (metric === "page_views_by_page") return "drilldown.ga4_page_provider_rows";
  if (metric === "site_event_count" || metric === "site_key_events") {
    return "drilldown.ga4_event_provider_rows";
  }
  // Same-lane rule (0062): both sides of the rate live in ga4_report_snapshot_fact rows.
  if (metric === "site_conversion_rate") return "drilldown.ga4_traffic_provider_rows";
  if (
    metric === "page_views" ||
    metric === "sessions" ||
    metric === "new_users" ||
    metric === "engaged_sessions" ||
    metric === "key_events" ||
    metric === "engagement_rate" ||
    metric === "average_session_duration"
  ) {
    return "drilldown.ga4_traffic_provider_rows";
  }
  if (metric === "x_public_engagement") return "drilldown.x_post_public_metric_rows";
  if (metric === "x_post_count" || metric === "x_comment_count") return "drilldown.x_authored_post_rows";
  if (metric === "x_follower_count") return "drilldown.x_profile_public_metric_rows";
  return "drilldown.posthog_signup_provider_rows";
}

export function unsupportedReason(question: string): string {
  const q = question.toLowerCase();
  if (
    q.includes("clarity") ||
    q.includes("linkedin") ||
    q.includes("mrr") ||
    q.includes("churn") ||
    q.includes("customer segment")
  ) {
    return "provider_not_in_first_phase";
  }
  if (
    q.includes("meta capi") ||
    q.includes("paid campaign") ||
    (q.includes("campaign") && q.includes("billing"))
  ) {
    return "attribution_model_not_implemented";
  }
  if (q.includes("trial") || q.includes("retention") || q.includes("drop")) {
    return "attribution_model_not_implemented";
  }
  if (q.includes("recurring")) {
    return "recurring_delivery_not_implemented";
  }
  return "content_linkage_not_implemented";
}

function filtersFrom(input: unknown): Array<{ field: string; operator: "equals" | "matches" | "gte" | "lte"; value: string }> {
  const raw = objectField(input, "filters");
  if (!Array.isArray(raw)) return [];
  return raw.map((filter) => ({
    field: requiredString(filter, "field"),
    operator: normalizeFilterOperator(optionalString(filter, "operator")),
    value: requiredString(filter, "value")
  }));
}

function normalizeFilterOperator(value: string | undefined): "equals" | "matches" | "gte" | "lte" {
  if (value === "matches" || value === "gte" || value === "lte") {
    return value;
  }
  return "equals";
}

function requiredProvider(input: unknown): FirstPhaseProvider {
  const provider = requiredString(input, "provider");
  if (!(FIRST_PHASE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`provider_not_in_first_phase:${provider}`);
  }
  return provider as FirstPhaseProvider;
}

async function sourceProvider(
  db: InfiniteOsDb,
  workspaceId: string,
  sourceId: string
): Promise<FirstPhaseProvider> {
  const source = await db.one<{ provider: string }>(
    "select provider from sources where workspace_id = $1 and id = $2",
    [workspaceId, sourceId]
  );
  if (!source) {
    throw new Error(`source_not_found:${sourceId}`);
  }
  if (!(FIRST_PHASE_PROVIDERS as readonly string[]).includes(source.provider)) {
    throw new Error(`provider_not_in_first_phase:${source.provider}`);
  }
  return source.provider as FirstPhaseProvider;
}

async function testConnectionForSource(
  db: InfiniteOsDb,
  context: SessionContext,
  provider: FirstPhaseProvider,
  sourceId: string,
  encryptionKey?: string
) {
  try {
    return await connectorFor(provider).testConnection(db, {
      workspaceId: context.workspaceId,
      sourceId,
      provider,
      syncRunId: `test_${randomUUID()}`,
      // Connect-time test decrypts the just-stored credential; use the same per-workspace key.
      ...(encryptionKey ? { encryptionKey } : {})
    });
  } catch (error) {
    // Park ONLY on a terminal failure (a genuine auth/credential rejection — the stored credential
    // is bad, retrying never helps). A TRANSIENT failure (a wifi blip mid-connect/reconnect) must
    // NOT flip a fresh, valid credential to `error`: leave the status untouched and surface the
    // error to the caller (connect_source/reconnect_source already return it in the error
    // envelope, so the failure stays loud without a bogus park).
    if (classifyConnectorError(error) === "terminal") {
      await db.updateSourceStatus(sourceId, "error");
    }
    throw error;
  }
}

// Best-effort initial sync enqueue shared by connect_source and reconnect_source so every
// connect surface (CLI, app HTTP route, in-chat agent) primes the warehouse for empty-until-synced
// providers. Idempotency is not required: the X connector upserts on conflict, so a duplicate
// incremental sync is harmless. An enqueue failure must not abort the (already successful) connect.
async function queueInitialSyncOnConnect(
  db: InfiniteOsDb,
  context: SessionContext,
  provider: string,
  sourceId: string
): Promise<Record<string, unknown> | undefined> {
  if (!AUTO_SYNC_ON_CONNECT.has(provider)) {
    return undefined;
  }
  try {
    await db.createJob({
      workspaceId: context.workspaceId,
      jobType: "source_sync",
      payload: { sourceId, mode: "incremental" }
    });
    return { queued: true, sourceId, mode: "incremental" };
  } catch {
    return { queued: false, reason: "enqueue_failed" };
  }
}

// Boot-time sweep for sources wedged at status='syncing' by a daemon killed mid-load.
//
// The chunked batch loader (connectors syncExtractedBatch) durably commits
// status='syncing' in its OPEN transaction before loading records; only its success
// path resets it to 'connected' and only its failure path marks it 'error'. A daemon
// killed between the two (the desktop fires syncs ~30s after app open — exactly when
// a user might quit) leaves the source 'syncing' FOREVER: the desktop scheduler only
// auto-syncs 'connected' sources and nothing else ever resets a stale 'syncing', so
// the source silently leaves rotation behind a healthy-looking status.
//
// At LOCAL daemon boot nothing can legitimately be mid-sync — the embedded engine is
// this single process and syncs only run through its own actions after boot — so any
// 'syncing' source here is by definition a stale wedge. Reset it to 'connected': a
// killed-mid-load source holds only idempotent-upsert partial data that the next
// scheduled sync re-lands, which matches the OLD single-transaction behavior where a
// crash rolled the status back to 'connected'. A load that FAILED (rather than
// crashed) was already marked 'error' by the loader itself and is deliberately NOT
// touched — 'error' means human recovery (Sync-now / reconnect), not auto-rotation.
// last_synced_at is left untouched (the sweep is a status repair, not a sync).
export async function resetStuckSyncingSourcesOnBoot(
  db: InfiniteOsDb
): Promise<{ reset: number }> {
  const rows = await db.query<{ id: string }>(
    "update sources set status = 'connected' where status = 'syncing' returning id"
  );
  return { reset: rows.length };
}

// Token-state fields that must NOT be copied into connection_credentials when the source is
// linked to a live oauth_tokens row: the access/refresh tokens are secrets and expiresAt would
// go stale on rotation. The connector reads all three from oauth_tokens instead.
const OAUTH_SECRET_PAYLOAD_KEYS = ["accessToken", "refreshToken", "expiresAt"] as const;

function credentialPayloadForStorage(
  input: unknown,
  credentialKind: string,
  oauthTokenId?: string,
  encryptionKey?: string
): string {
  if (credentialKind === "fixture") {
    return "fixture-encrypted";
  }
  // OAuth-bridged sources store only non-secret metadata; the token lives in oauth_tokens.
  if (oauthTokenId) {
    const credentialPayload = objectField(input, "credentialPayload");
    if (!credentialPayload || typeof credentialPayload !== "object") {
      throw new Error("credentialPayload is required for live provider credentials");
    }
    return encryptCredentialPayload(
      stripOAuthSecrets(credentialPayload as Record<string, unknown>),
      requiredEncryptionKey(encryptionKey)
    );
  }
  const encryptedPayload = optionalString(input, "encryptedPayload");
  if (encryptedPayload) {
    if (!isEncryptedCredentialPayload(encryptedPayload)) {
      throw new Error("encryptedPayload must be a Infinite OS encrypted credential envelope");
    }
    return encryptedPayload;
  }
  const credentialPayload = objectField(input, "credentialPayload");
  if (!credentialPayload || typeof credentialPayload !== "object") {
    throw new Error("credentialPayload is required for live provider credentials");
  }
  return encryptCredentialPayload(credentialPayload, requiredEncryptionKey(encryptionKey));
}

function stripOAuthSecrets(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if ((OAUTH_SECRET_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    metadata[key] = value;
  }
  return metadata;
}

function defaultCredentialKind(provider: FirstPhaseProvider): string {
  if (provider === "google_analytics_4") return "oauth_access_token";
  if (provider === "posthog") return "personal_api_key";
  if (provider === "x") return "bearer_token";
  if (provider === "shopify") return "admin_api_access_token";
  if (provider === "meta_ads") return "marketing_api_access_token";
  return "api_key";
}

function accountExternalIdFromPayload(provider: FirstPhaseProvider, input: unknown): string | undefined {
  const credentialPayload = objectField(input, "credentialPayload");
  if (!credentialPayload || typeof credentialPayload !== "object") {
    return undefined;
  }
  const payload = credentialPayload as Record<string, unknown>;
  if (provider === "google_analytics_4" && typeof payload.propertyId === "string") {
    return payload.propertyId;
  }
  if (provider === "posthog" && (typeof payload.projectId === "string" || typeof payload.projectId === "number")) {
    return String(payload.projectId);
  }
  if (provider === "stripe" && typeof payload.accountId === "string") {
    return payload.accountId;
  }
  if (provider === "shopify") {
    return shopifyAccountExternalId(payload.storeDomain);
  }
  if (provider === "meta_ads") {
    return metaAdsAccountExternalId(payload.adAccountId);
  }
  if (provider === "x" && typeof payload.userId === "string") {
    return payload.userId;
  }
  if (provider === "x" && typeof payload.username === "string") {
    return payload.username.replace(/^@/, "").toLowerCase();
  }
  return undefined;
}

function shopifyAccountExternalId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = value.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const hostname = parsed.hostname.toLowerCase();
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(hostname)) {
      return hostname;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function metaAdsAccountExternalId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const raw = String(value).trim();
  if (!raw) {
    return undefined;
  }
  return `act_${raw.replace(/^act_/i, "")}`;
}

// `override` is the caller-supplied per-workspace custody key (createActionHandlers options →
// connect/reconnect). When present it WINS over process.env / the .growth-os file default, so a
// multi-tenant server never mutates process.env. When absent, behavior is identical to before.
function requiredEncryptionKey(override?: string): string {
  const key = override ?? process.env.GROWTH_OS_ENCRYPTION_KEY ?? projectEncryptionKey();
  if (!key) {
    throw new Error("GROWTH_OS_ENCRYPTION_KEY is required for live provider credentials");
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

function requiredString(input: unknown, key: string): string {
  const value = objectField(input, key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function optionalString(input: unknown, key: string): string | undefined {
  const value = objectField(input, key);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringArray(input: unknown, key: string): string[] {
  const value = objectField(input, key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectField(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function requiredEnvelopeString(
  input: Record<string, unknown>,
  key: string,
  actionId: string
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${actionId} did not return ${key}`);
  }
  return value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function numberOrNull(input: unknown, key: string): number | null {
  const value = objectField(input, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedLimit(input: unknown, fallback: number, max = 500): number {
  const value = numberOrNull(input, "limit") ?? fallback;
  return Math.max(1, Math.min(max, value));
}

function boundedRefreshWindowDays(input: unknown, fallback: number, max = 3650): number {
  const value = numberOrNull(input, "refreshWindowDays") ?? fallback;
  return Math.max(1, Math.min(max, Math.ceil(value)));
}

function intervalFor(scheduleKind: string): number | null {
  if (scheduleKind === "every_15_minutes") return 15;
  if (scheduleKind === "hourly") return 60;
  if (scheduleKind === "daily") return 1440;
  if (scheduleKind === "weekly") return 10080;
  if (scheduleKind === "manual_only") return null;
  throw new Error(`invalid_schedule_policy:${scheduleKind}`);
}
