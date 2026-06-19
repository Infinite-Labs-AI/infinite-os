import { NoActiveProjectError } from "@infinite-os/config";
import {
  JOURNEY_ENTITY_TYPES,
  infiniteOsVersion,
  type JourneyEntityType
} from "@infinite-os/core";
import {
  FIRST_PHASE_ACTIONS,
  OPERATOR_ACTIONS,
  READ_ACTIONS,
  type ActionEnvelope,
  type AnswerabilityReason,
  type AnswerabilityStatus,
  type Authority,
  type CoverageSummary,
  type EvidenceHandle,
  type InfiniteOsActionId,
  type PolicyRef,
  type RuntimeSurface,
  type SessionContext
} from "@infinite-os/types";
import type { RecipeId } from "./recipes.js";
export * from "./setup-module-loader.js";

// Re-export the canonical contract types/consts so the rest of the engine keeps
// importing them from `@infinite-os/runtime` unchanged. `@infinite-os/types` is
// the single source of truth; this barrel forwards them. Note the contract
// `ActionEnvelope.interpretedPlan` is `unknown` — the engine only ever WRITES a
// `JourneyQueryPlan` into it (never reads it back typed), so the contract shape
// is sufficient everywhere in the engine and no runtime-local override is needed.
export {
  FIRST_PHASE_ACTIONS,
  OPERATOR_ACTIONS,
  READ_ACTIONS,
  type ActionEnvelope,
  type AnswerabilityReason,
  type AnswerabilityStatus,
  type Authority,
  type CoverageSummary,
  type EvidenceHandle,
  type InfiniteOsActionId,
  type PolicyRef,
  type RuntimeSurface,
  type SessionContext
};

/**
 * Thrown when a session context is built without a resolved workspace id. It
 * extends {@link NoActiveProjectError} so the existing `instanceof
 * NoActiveProjectError` guards on the CLI path keep catching it — an
 * unresolved/empty pin must never silently coerce to a workspace named
 * `"default"`.
 */
export class MissingWorkspaceError extends NoActiveProjectError {
  constructor(message = "No workspace bound for this session. A project must be pinned before a turn.") {
    super(message);
    this.name = "MissingWorkspaceError";
  }
}

export interface ActionDefinition<Input = unknown, Output = unknown> {
  id: InfiniteOsActionId;
  title: string;
  summary: string;
  category: ActionCategory;
  authority: Authority;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  provenancePolicy:
    | "metadata"
    | "queryable_view"
    | "bounded_provider_truth"
    | "operator_audit";
  recommendedNextActions: InfiniteOsActionId[];
  recipeIds: RecipeId[];
  handler: (input: Input, context: SessionContext) => Promise<Output> | Output;
}

export type JourneyQueryIntent =
  | "rank_entities_by_outcome"
  | "compare_cohorts"
  | "trace_paths"
  | "find_behavior_signals"
  | "summarize_lifecycle"
  | "explain_change"
  | "drilldown_evidence";

export interface JourneyQueryPlan {
  intent: JourneyQueryIntent;
  actor: {
    grain: "person" | "account";
  };
  journeyTemplateId?: string;
  entity?: {
    type: JourneyEntityType;
    filters?: Record<string, unknown>;
  };
  outcome?: {
    id: string;
    window?: string;
    policyId?: string;
  };
  timeRange: {
    start: string;
    end: string;
  };
  groupBy?: string[];
  ranking?: {
    metric: string;
    direction: "asc" | "desc";
  };
  limit?: number;
}

export type ActionHandler = (
  input: unknown,
  context: SessionContext
) => Promise<ActionEnvelope> | ActionEnvelope;

export type ActionCategory =
  | "sources"
  | "schedules"
  | "schema"
  | "context"
  | "journey"
  | "evidence"
  | "questions"
  | "reports"
  | "operator";

export class ActionRegistry {
  private readonly actions = new Map<InfiniteOsActionId, ActionDefinition>();

  register(action: ActionDefinition): void {
    if (this.actions.has(action.id)) {
      throw new Error(`Duplicate action registered: ${action.id}`);
    }
    this.actions.set(action.id, action);
  }

  list(): ActionDefinition[] {
    return [...this.actions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): ActionDefinition | undefined {
    return this.actions.get(id as InfiniteOsActionId);
  }

  async execute(
    id: string,
    input: unknown,
    context: SessionContext
  ): Promise<ActionEnvelope> {
    const action = this.actions.get(id as InfiniteOsActionId);
    if (!action) {
      throw new Error(`Unknown Infinite OS action: ${id}`);
    }
    assertAuthority(context.authority, action.authority);
    return action.handler(input, context) as Promise<ActionEnvelope>;
  }
}

export const FIRST_PHASE_PROVIDERS = [
  "google_analytics_4",
  "posthog",
  "stripe",
  "x",
  "shopify",
  "meta_ads"
] as const;

export type FirstPhaseProvider = (typeof FIRST_PHASE_PROVIDERS)[number];

export const FIRST_PHASE_QUERYABLE_VIEWS = [
  "queryable.vw_site_traffic",
  "queryable.vw_site_conversion_rate",
  "queryable.vw_posthog_events",
  "queryable.vw_revenue_by_source",
  "queryable.vw_recent_sync_status",
  "queryable.vw_x_post_public_metrics",
  "queryable.vw_x_authored_activity",
  "queryable.vw_x_profile_public_metrics",
  "queryable.vw_shopify_orders",
  "queryable.vw_shopify_products",
  "queryable.vw_meta_ads_campaign_daily",
  // Phase-1 §3.3 — the typed conversions view (campaign × day × result_type). A view is
  // invisible to the tool agent until it is in this allowlist AND has parallel entries in
  // the analytical-engine switch-functions; the SQL seed in migration 0033 is otherwise inert.
  "queryable.vw_meta_ads_campaign_conversions_daily",
  // Phase-1 §5 — the Meta↔Stripe true-value (ROAS) join view (migration 0034).
  "queryable.vw_meta_stripe_campaign_value_daily",
  "queryable.vw_site_pages"
] as const;

export const FIRST_PHASE_METRICS = [
  "site_visitors",
  "signup_count",
  "site_conversion_rate",
  "posthog_event_count",
  "recognized_revenue",
  "x_public_engagement",
  "x_post_count",
  "x_comment_count",
  "x_follower_count",
  "shopify_gross_sales",
  "shopify_order_count",
  "meta_ads_spend",
  "meta_ads_clicks",
  "impressions",
  "reach",
  "cpm",
  "cpc",
  "ctr",
  // Phase-1 §6 — Meta conversions/value metrics. results/cost_per_result/conversion_value/
  // roas read the typed conversions view (result_type is a REQUIRED partition — the engine
  // refuses to blend CPL+CPA across distinct result_types). link_clicks/landing_page_views
  // read the delivery view. frequency is a recomputed ratio (impressions/reach) on the
  // delivery view. roas_from_stripe reads the §5 Meta↔Stripe value-join view.
  "results",
  "cost_per_result",
  "conversion_value",
  "roas",
  "link_clicks",
  "landing_page_views",
  "frequency",
  "roas_from_stripe",
  "page_views",
  "new_users",
  "engaged_sessions",
  "key_events",
  "engagement_rate",
  "average_session_duration",
  "page_views_by_page"
] as const;

// Compact {metric id -> common aliases} hint, mirrored by hand from the `aliases` column of the
// metric_definitions seeds (migrations 0005/0011/0014/0016/0022/0024/0025/0029/0033/0034). The
// authoritative source is still the DB (list_metrics/describe_metric hydrate the live aliases);
// this map is only a prompt-time hint so common phrasings like "cost per lead" or "cpl" resolve
// to cost_per_result WITHOUT a discovery round-trip. Keep it in sync with the seeds when aliases
// change — drift only costs a discovery call, it never produces wrong numbers.
export const FIRST_PHASE_METRIC_ALIASES: Record<string, readonly string[]> = {
  site_visitors: ["visitors", "users"],
  signup_count: ["signups"],
  site_conversion_rate: ["conversion percentage", "conversion rate"],
  posthog_event_count: ["events", "event count", "event counts", "posthog events"],
  recognized_revenue: ["revenue"],
  x_public_engagement: ["best tweet", "best post", "most popular tweet", "tweet engagement", "post engagement"],
  x_post_count: ["tweets made", "tweet count", "posts made", "how many tweets have i made"],
  x_comment_count: ["comments made", "replies made", "comments authored"],
  x_follower_count: ["followers", "follower count"],
  shopify_gross_sales: ["shopify revenue", "shop sales", "gross merchandise value", "gmv"],
  shopify_order_count: ["orders", "shopify orders"],
  meta_ads_spend: ["facebook ads spend", "instagram ads spend", "meta spend"],
  meta_ads_clicks: ["facebook ads clicks", "instagram ads clicks", "meta clicks"],
  impressions: ["facebook ads impressions", "instagram ads impressions", "meta impressions", "ad impressions"],
  reach: ["facebook ads reach", "instagram ads reach", "meta reach", "unique reach"],
  cpm: ["cost per mille", "cost per thousand impressions", "meta cpm", "facebook cpm"],
  cpc: ["cost per click", "meta cpc", "facebook cpc", "instagram cpc"],
  ctr: ["click through rate", "click-through rate", "meta ctr", "facebook ctr"],
  results: ["conversions", "meta results", "conversion count", "leads", "purchases"],
  cost_per_result: ["cpl", "cpa", "cost per lead", "cost per acquisition", "cost per conversion", "cost per result"],
  conversion_value: ["purchase value", "conversion value", "meta revenue", "pixel purchase value"],
  roas: ["roas", "return on ad spend", "meta roas", "purchase roas"],
  link_clicks: ["link clicks", "inline link clicks", "meta link clicks", "facebook link clicks"],
  landing_page_views: ["landing page views", "lpv", "meta landing page views"],
  frequency: ["frequency", "impressions per person", "avg frequency"],
  roas_from_stripe: ["stripe roas", "true roas", "real roas", "stripe attributed roas", "roas from stripe", "return on ad spend from revenue"],
  page_views: ["page views", "pageviews", "screen page views", "views"],
  new_users: ["new users", "first-time users", "new visitors"],
  engaged_sessions: ["engaged sessions", "engaged visits"],
  key_events: ["key events", "conversions", "key event count"],
  engagement_rate: ["engagement rate", "engaged rate"],
  average_session_duration: ["average session duration", "avg session duration", "session length"],
  page_views_by_page: ["top pages", "page views by page", "most viewed pages", "popular pages"]
} as const;

export const ACTION_CATALOG: Omit<ActionDefinition, "handler">[] =
  FIRST_PHASE_ACTIONS.map((id) => {
    const metadata = metadataFor(id);
    return {
      id,
      title: metadata.title,
      summary: metadata.summary,
      category: metadata.category,
      authority: isOperatorAction(id) ? "operator" : "tool_agent",
      inputSchema: inputSchemaFor(id),
      outputSchema: actionOutputSchema(),
      provenancePolicy: provenancePolicyFor(id),
      recommendedNextActions: metadata.recommendedNextActions,
      recipeIds: metadata.recipeIds
    };
  });

export function createInfiniteOsRegistry(
  handlers: Partial<Record<InfiniteOsActionId, ActionHandler>> = {}
): ActionRegistry {
  const registry = new ActionRegistry();
  for (const action of ACTION_CATALOG) {
    registry.register({
      ...action,
      handler:
        handlers[action.id] ??
        (() => notImplemented(action.id, action.authority))
    });
  }
  return registry;
}

export const runtimeBoot = true;
export const runtimeVersion = infiniteOsVersion;

export function assertAuthority(actual: Authority, required: Authority): void {
  if (required === "operator" && actual !== "operator") {
    throw new Error("operator authority required");
  }
}

export function createSessionContext(input: {
  workspaceId?: string;
  sessionId?: string;
  actorId?: string;
  authority: Authority;
  surface: RuntimeSurface;
  timezone?: string;
}): SessionContext {
  // Fail closed: an unresolved/empty pin must never silently become a workspace
  // named "default" (which would scope queries to the wrong/nonexistent row).
  // Throwing a NoActiveProjectError subclass keeps the existing CLI guards working.
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) {
    throw new MissingWorkspaceError();
  }
  return {
    workspaceId,
    sessionId: input.sessionId ?? "local-session",
    actorId: input.actorId ?? input.surface,
    authority: input.authority,
    surface: input.surface,
    timezone: input.timezone ?? "UTC"
  };
}

export function createEnvelope<T>(input: {
  actionId: InfiniteOsActionId;
  authority: Authority;
  status?: ActionEnvelope<T>["status"];
  data?: T;
  error?: ActionEnvelope<T>["error"];
  answerabilityReason?: ActionEnvelope<T>["answerabilityReason"];
  interpretedPlan?: ActionEnvelope<T>["interpretedPlan"];
  resultHandle?: ActionEnvelope<T>["resultHandle"];
  evidence?: ActionEnvelope<T>["evidence"];
  coverage?: ActionEnvelope<T>["coverage"];
  policyRefs?: ActionEnvelope<T>["policyRefs"];
  provenance?: string[];
  freshness?: ActionEnvelope<T>["freshness"];
  caveats?: string[];
  truncated?: boolean;
  nextActions?: InfiniteOsActionId[];
}): ActionEnvelope<T> {
  const status = input.error ? "error" : (input.status ?? "ok");
  return {
    ok: !input.error && !NON_OK_STATUSES.has(status),
    actionId: input.actionId,
    authority: input.authority,
    status,
    data: input.data,
    error: input.error,
    answerabilityReason: input.answerabilityReason,
    interpretedPlan: input.interpretedPlan,
    resultHandle: input.resultHandle,
    evidence: input.evidence,
    coverage: input.coverage,
    policyRefs: input.policyRefs,
    provenance: input.provenance ?? [],
    freshness: input.freshness,
    caveats: input.caveats ?? [],
    truncated: input.truncated ?? false,
    nextActions: input.nextActions ?? []
  };
}

const NON_OK_STATUSES = new Set<AnswerabilityStatus>([
  "unsupported",
  "not_implemented",
  "low_coverage",
  "needs_clarification",
  "too_expensive",
  "error"
]);

function notImplemented(
  id: InfiniteOsActionId,
  authority: Authority
): ActionEnvelope {
  return createEnvelope({
    actionId: id,
    authority,
    status: "not_implemented",
    data: {
      firstPhaseProviders: FIRST_PHASE_PROVIDERS,
      queryableViews: FIRST_PHASE_QUERYABLE_VIEWS,
      metrics: FIRST_PHASE_METRICS
    },
    caveats: ["runtime_handler_not_wired"],
    freshness: { target: "24 hours", asOf: null, stale: false }
  });
}

function isOperatorAction(id: string): boolean {
  return (OPERATOR_ACTIONS as readonly string[]).includes(id);
}

function provenancePolicyFor(
  id: InfiniteOsActionId
): ActionDefinition["provenancePolicy"] {
  if (id === "fetch_evidence" || id === "verify_claims") {
    return "bounded_provider_truth";
  }
  if (id === "sync_source_now") {
    return "operator_audit";
  }
  if (id === "run_journey_query") {
    return "queryable_view";
  }
  if (id.includes("drilldown")) {
    return "bounded_provider_truth";
  }
  if (isOperatorAction(id)) {
    return "operator_audit";
  }
  if (id.includes("metric") || id.includes("query")) {
    return "queryable_view";
  }
  return "metadata";
}

function metadataFor(id: InfiniteOsActionId): {
  title: string;
  summary: string;
  category: ActionCategory;
  recommendedNextActions: InfiniteOsActionId[];
  recipeIds: RecipeId[];
} {
  const metadata: Record<
    InfiniteOsActionId,
    {
      title: string;
      summary: string;
      category: ActionCategory;
      recommendedNextActions: InfiniteOsActionId[];
      recipeIds: RecipeId[];
    }
  > = {
    list_sources: {
      title: "List sources",
      summary:
        "Show connected GA4, PostHog, Stripe, X, Shopify, and Meta Ads sources without exposing credentials.",
      category: "sources",
      recommendedNextActions: ["describe_source", "start_source_sync"],
      recipeIds: ["inspect_schema", "sync_source"]
    },
    describe_source: {
      title: "Describe source",
      summary: "Inspect one source, its provider, status, and sync metadata.",
      category: "sources",
      recommendedNextActions: ["start_source_sync", "list_source_schedules"],
      recipeIds: ["verify_credentials", "sync_source"]
    },
    get_recent_sync_runs: {
      title: "Recent sync runs",
      summary:
        "Review recent extraction and load outcomes across first-phase sources.",
      category: "sources",
      recommendedNextActions: ["list_sources", "list_source_schedules"],
      recipeIds: ["sync_source"]
    },
    sync_source_now: {
      title: "Sync source now",
      summary:
        "Run one bounded connector sync immediately so same-day/current/latest questions can use fresh provider data before ranking or comparing results.",
      category: "sources",
      recommendedNextActions: ["run_metric_query", "run_breakdown_query", "get_recent_sync_runs"],
      recipeIds: ["sync_source"]
    },
    list_source_schedules: {
      title: "List source schedules",
      summary:
        "Show worker-owned source sync policies, pause state, and freshness windows.",
      category: "schedules",
      recommendedNextActions: [
        "update_source_schedule",
        "pause_source_schedule",
        "resume_source_schedule"
      ],
      recipeIds: ["sync_source"]
    },
    list_queryable_views: {
      title: "List queryable views",
      summary:
        "Show the safe queryable views available to CLI, API, and MCP clients.",
      category: "schema",
      recommendedNextActions: ["describe_queryable_view", "list_metrics"],
      recipeIds: ["inspect_schema"]
    },
    describe_queryable_view: {
      title: "Describe queryable view",
      summary:
        "Inspect one queryable view, its grain, dimensions, measures, and caveats.",
      category: "schema",
      recommendedNextActions: ["list_metrics", "run_metric_query"],
      recipeIds: ["inspect_schema"]
    },
    list_metrics: {
      title: "List metrics",
      summary:
        "Show first-phase metric definitions, source authority, units, and examples.",
      category: "schema",
      recommendedNextActions: ["describe_metric", "run_metric_query"],
      recipeIds: ["inspect_schema"]
    },
    describe_metric: {
      title: "Describe metric",
      summary:
        "Inspect one metric definition, source view, allowed dimensions, and caveats before retrying uncertain metric/view pairs.",
      category: "schema",
      recommendedNextActions: ["run_metric_query", "run_breakdown_query"],
      recipeIds: ["explain_answer"]
    },
    run_metric_query: {
      title: "Run metric query",
      summary:
        "Execute a read-only metric query against the queryable schema. For trend questions (week-over-week, month-over-month, year-over-year), set compareTo='prior_period' (immediately preceding equal-length range) or 'prior_year' (same range one year earlier) together with occurred_on gte/lte date filters; the response then carries a `comparison` block (current/previous/absoluteDelta/percentDelta/direction) — phrase the answer as 'up/down X% vs prior period'. X compatibility: x_public_engagement -> queryable.vw_x_post_public_metrics; x_post_count and x_comment_count -> queryable.vw_x_authored_activity; x_follower_count -> queryable.vw_x_profile_public_metrics.",
      category: "questions",
      recommendedNextActions: [
        "explain_answer",
        "drilldown_result",
        "create_saved_report"
      ],
      recipeIds: ["save_report", "save_export_report"]
    },
    run_breakdown_query: {
      title: "Run breakdown query",
      summary:
        "Execute a read-only grouped metric query against allowed dimensions, with optional bounded ordering. X compatibility: x_public_engagement -> queryable.vw_x_post_public_metrics; x_post_count and x_comment_count -> queryable.vw_x_authored_activity; x_follower_count -> queryable.vw_x_profile_public_metrics.",
      category: "questions",
      recommendedNextActions: [
        "explain_answer",
        "drilldown_result",
        "create_saved_report"
      ],
      recipeIds: ["save_report", "save_export_report"]
    },
    run_funnel_query: {
      title: "Run funnel query",
      summary: "Execute the first-phase visit-to-signup funnel surface.",
      category: "questions",
      recommendedNextActions: ["explain_answer", "drilldown_result"],
      recipeIds: ["explain_answer"]
    },
    explain_answer: {
      title: "Explain answer",
      summary:
        "Explain source authority, provenance, and caveats for a prior or supplied metric.",
      category: "questions",
      recommendedNextActions: ["drilldown_result"],
      recipeIds: ["explain_answer"]
    },
    drilldown_result: {
      title: "Drill down result",
      summary:
        "Return bounded provider-truth rows without raw payload JSON or generic SQL.",
      category: "questions",
      recommendedNextActions: ["create_saved_report"],
      recipeIds: ["explain_answer"]
    },
    search_context: {
      title: "Search context",
      summary:
        "Find approved metric, source, policy, journey, and entity context cards relevant to a question.",
      category: "context",
      recommendedNextActions: [
        "describe_context_item",
        "resolve_entity",
        "validate_journey_plan"
      ],
      recipeIds: ["inspect_schema", "explain_answer"]
    },
    describe_context_item: {
      title: "Describe context item",
      summary:
        "Return one approved context card with provenance, policy references, and caveats.",
      category: "context",
      recommendedNextActions: ["resolve_entity", "validate_journey_plan"],
      recipeIds: ["inspect_schema", "explain_answer"]
    },
    resolve_entity: {
      title: "Resolve entity",
      summary:
        "Resolve a business entity mention to governed identifiers before analytical execution.",
      category: "context",
      recommendedNextActions: ["validate_journey_plan", "run_journey_query"],
      recipeIds: ["explain_answer"]
    },
    validate_journey_plan: {
      title: "Validate journey plan",
      summary:
        "Validate a journey query plan against approved templates, source coverage, policies, and cost limits.",
      category: "journey",
      recommendedNextActions: ["run_journey_query", "search_context"],
      recipeIds: ["inspect_schema", "explain_answer"]
    },
    run_journey_query: {
      title: "Run journey query",
      summary:
        "Execute a validated journey query plan through deterministic, read-only analytical templates.",
      category: "journey",
      recommendedNextActions: [
        "fetch_evidence",
        "verify_claims",
        "create_saved_report"
      ],
      recipeIds: ["explain_answer", "save_report"]
    },
    fetch_evidence: {
      title: "Fetch evidence",
      summary:
        "Fetch bounded evidence rows or context snippets behind a result handle without exposing raw provider payloads.",
      category: "evidence",
      recommendedNextActions: ["verify_claims", "explain_answer"],
      recipeIds: ["explain_answer"]
    },
    verify_claims: {
      title: "Verify claims",
      summary:
        "Check generated claims against evidence handles, policy references, and freshness constraints.",
      category: "evidence",
      recommendedNextActions: ["fetch_evidence", "explain_answer"],
      recipeIds: ["explain_answer"]
    },
    connect_source: {
      title: "Connect source",
      summary:
        "Create a provider source and store live credentials only as encrypted credential envelopes.",
      category: "operator",
      recommendedNextActions: ["start_source_sync", "list_sources"],
      recipeIds: ["connect_source"]
    },
    reconnect_source: {
      title: "Reconnect source",
      summary: "Rotate or verify credentials for an existing source.",
      category: "operator",
      recommendedNextActions: ["describe_source", "start_source_sync"],
      recipeIds: ["verify_credentials"]
    },
    revoke_source: {
      title: "Revoke source",
      summary: "Revoke a source, credential rows, and its sync schedule.",
      category: "operator",
      recommendedNextActions: ["list_sources"],
      recipeIds: ["verify_credentials"]
    },
    start_source_sync: {
      title: "Start source sync",
      summary: "Queue a worker-owned sync job for one source.",
      category: "operator",
      recommendedNextActions: ["get_recent_sync_runs", "list_source_schedules"],
      recipeIds: ["sync_source"]
    },
    update_source_schedule: {
      title: "Update source schedule",
      summary:
        "Change a source sync policy without adding recurring report delivery.",
      category: "schedules",
      recommendedNextActions: ["list_source_schedules"],
      recipeIds: ["sync_source"]
    },
    pause_source_schedule: {
      title: "Pause source schedule",
      summary: "Pause worker-owned source sync scheduling for one source.",
      category: "schedules",
      recommendedNextActions: [
        "list_source_schedules",
        "resume_source_schedule"
      ],
      recipeIds: ["sync_source"]
    },
    resume_source_schedule: {
      title: "Resume source schedule",
      summary: "Resume worker-owned source sync scheduling for one source.",
      category: "schedules",
      recommendedNextActions: ["list_source_schedules"],
      recipeIds: ["sync_source"]
    },
    create_saved_report: {
      title: "Create saved report",
      summary:
        "Persist an operator-owned report plan over existing analytical actions.",
      category: "reports",
      recommendedNextActions: ["run_saved_report", "export_saved_report"],
      recipeIds: ["save_report", "save_export_report"]
    },
    run_saved_report: {
      title: "Run saved report",
      summary: "Queue a worker job to execute a saved report plan.",
      category: "reports",
      recommendedNextActions: ["export_saved_report"],
      recipeIds: ["save_report", "save_export_report"]
    },
    export_saved_report: {
      title: "Export saved report",
      summary: "Queue durable JSON artifact export for a saved report.",
      category: "reports",
      recommendedNextActions: ["get_recent_sync_runs"],
      recipeIds: ["export_report", "save_export_report"]
    },
    list_meta_entities: {
      title: "List Meta Ads entities",
      summary:
        "Read Meta Ads campaigns, ad sets, ads, or creatives for one source (no money movement).",
      category: "sources",
      recommendedNextActions: ["get_meta_entity", "set_meta_entity_status"],
      recipeIds: []
    },
    get_meta_entity: {
      title: "Get Meta Ads entity",
      summary: "Read a single Meta Ads entity node by id (no money movement).",
      category: "sources",
      recommendedNextActions: ["set_meta_entity_status", "list_meta_entities"],
      recipeIds: []
    },
    create_meta_campaign: {
      title: "Create Meta Ads campaign",
      summary:
        "Operator-only. Create a Meta Ads campaign that ALWAYS lands PAUSED; going live is a separate, gated set_meta_entity_status step.",
      category: "operator",
      recommendedNextActions: ["create_meta_ad_set", "set_meta_entity_status"],
      recipeIds: []
    },
    create_meta_ad_set: {
      title: "Create Meta Ads ad set",
      summary:
        "Operator-only. Create a Meta Ads ad set under a campaign; ALWAYS lands PAUSED. Budgets/bids are integer cents in the ad-account currency.",
      category: "operator",
      recommendedNextActions: ["create_meta_creative", "create_meta_ad"],
      recipeIds: []
    },
    create_meta_creative: {
      title: "Create Meta Ads creative",
      summary:
        "Operator-only. Create a STANDARD single-image/video Meta Ads creative. Creatives have no go-live status.",
      category: "operator",
      recommendedNextActions: ["create_meta_ad"],
      recipeIds: []
    },
    create_meta_ad: {
      title: "Create Meta Ads ad",
      summary:
        "Operator-only. Create a Meta Ads ad wiring an ad set to a creative; ALWAYS lands PAUSED.",
      category: "operator",
      recommendedNextActions: ["set_meta_entity_status", "get_meta_entity"],
      recipeIds: []
    },
    set_meta_entity_status: {
      title: "Set Meta Ads entity status",
      summary:
        "Operator-only. Activate or pause a Meta Ads campaign/ad set/ad. Activating is the ONLY money-spending transition; it is per-level and never cascades.",
      category: "operator",
      recommendedNextActions: ["get_meta_entity", "list_meta_entities"],
      recipeIds: []
    },
    delete_meta_entity: {
      title: "Delete Meta Ads entity",
      summary:
        "Operator-only. Permanently DELETE a Meta Ads campaign/ad set/ad node (irreversible cleanup). Does not spend; the CLI applies a destructive confirm gate before reaching this handler.",
      category: "operator",
      recommendedNextActions: ["list_meta_entities"],
      recipeIds: []
    }
  };
  return metadata[id];
}

function inputSchemaFor(id: InfiniteOsActionId): Record<string, unknown> {
  const schemas: Partial<Record<InfiniteOsActionId, Record<string, unknown>>> = {
    describe_source: requiredObject({ sourceId: { type: "string" } }),
    connect_source: requiredObject(
      {
        provider: { enum: FIRST_PHASE_PROVIDERS },
        connectionName: { type: "string" },
        credentialKind: { type: "string" },
        credentialPayload: { type: "object", additionalProperties: true },
        encryptedPayload: { type: "string" }
      },
      ["provider"]
    ),
    reconnect_source: requiredObject(
      {
        sourceId: { type: "string" },
        // FIX 3: reconnect accepts a FRESH credential so the handler replaces the
        // stored (possibly dead) token and tests with the NEW one — it never
        // re-authenticates with the old token. When omitted, the handler falls
        // back to re-testing the stored credential (legacy refresh-only path).
        connectionName: { type: "string" },
        credentialKind: { type: "string" },
        credentialPayload: { type: "object", additionalProperties: true },
        encryptedPayload: { type: "string" },
        oauthTokenId: { type: "string" }
      },
      ["sourceId"]
    ),
    revoke_source: requiredObject({ sourceId: { type: "string" } }),
    start_source_sync: requiredObject(
      {
        sourceId: { type: "string" },
        mode: { type: "string" },
        syncMode: { type: "string" },
        backfillWindow: { type: "string" },
        refreshWindowDays: { type: "number" }
      },
      ["sourceId"]
    ),
    sync_source_now: requiredObject(
      {
        sourceId: { type: "string" },
        refreshWindowDays: {
          type: "number",
          minimum: 1,
          maximum: 3650,
          description:
            "Optional bounded refresh window in days. Use 1 for latest/today/current checks; use up to 3650 when expanding X coverage for earliest/first-post questions."
        },
        reason: { type: "string" }
      },
      ["sourceId"]
    ),
    update_source_schedule: requiredObject(
      {
        sourceId: { type: "string" },
        scheduleKind: {
          enum: ["manual_only", "every_15_minutes", "hourly", "daily", "weekly"]
        },
        syncMode: { enum: ["incremental", "backfill"] },
        refreshWindowDays: { type: "number" },
        staleAfterMinutes: { type: "number" }
      },
      ["sourceId"]
    ),
    pause_source_schedule: requiredObject(
      { sourceId: { type: "string" }, reason: { type: "string" } },
      ["sourceId"]
    ),
    resume_source_schedule: requiredObject({ sourceId: { type: "string" } }, [
      "sourceId"
    ]),
    describe_queryable_view: requiredObject(
      { viewId: { enum: FIRST_PHASE_QUERYABLE_VIEWS } },
      ["viewId"]
    ),
    describe_metric: requiredObject(
      { metricId: { enum: FIRST_PHASE_METRICS } },
      ["metricId"]
    ),
    run_metric_query: analyticalQuerySchema(),
    run_breakdown_query: analyticalQuerySchema({ groupByRequired: true }),
    run_funnel_query: analyticalQuerySchema(),
    explain_answer: requiredObject({
      metric: {
        enum: FIRST_PHASE_METRICS,
        description:
          "Metric to explain. For X, use the metric's compatible source view when running follow-up queries: x_public_engagement -> queryable.vw_x_post_public_metrics; x_post_count/x_comment_count -> queryable.vw_x_authored_activity; x_follower_count -> queryable.vw_x_profile_public_metrics."
      },
      priorResultMetric: { enum: FIRST_PHASE_METRICS }
    }),
    drilldown_result: requiredObject({
      metric: { enum: FIRST_PHASE_METRICS },
      priorResultMetric: { enum: FIRST_PHASE_METRICS },
      limit: { type: "number", maximum: 500 }
    }),
    search_context: requiredObject(
      {
        query: { type: "string" },
        kinds: {
          type: "array",
          items: {
            enum: [
              "metric",
              "source",
              "policy",
              "journey_template",
              "entity",
              "evidence"
            ]
          }
        },
        limit: { type: "number", maximum: 50 }
      },
      ["query"]
    ),
    describe_context_item: requiredObject(
      {
        itemId: { type: "string" },
        includeEvidence: { type: "boolean" }
      },
      ["itemId"]
    ),
    resolve_entity: requiredObject(
      {
        entityType: {
          enum: [...JOURNEY_ENTITY_TYPES]
        },
        query: { type: "string" },
        filters: { type: "object", additionalProperties: true }
      },
      ["entityType", "query"]
    ),
    validate_journey_plan: requiredObject(
      {
        plan: journeyQueryPlanSchema(),
        maxCost: { type: "number" }
      },
      ["plan"]
    ),
    run_journey_query: requiredObject(
      {
        plan: journeyQueryPlanSchema(),
        validationId: { type: "string" },
        limit: { type: "number", maximum: 500 }
      },
      ["plan", "validationId"]
    ),
    fetch_evidence: requiredObject(
      {
        evidenceHandleId: { type: "string" },
        claimIds: { type: "array", items: { type: "string" } },
        limit: { type: "number", maximum: 500 }
      },
      ["evidenceHandleId"]
    ),
    verify_claims: requiredObject(
      {
        claims: {
          type: "array",
          items: { type: "string" }
        },
        evidenceHandleIds: {
          type: "array",
          items: { type: "string" }
        },
        policyRefIds: {
          type: "array",
          items: { type: "string" }
        }
      },
      ["claims", "evidenceHandleIds"]
    ),
    create_saved_report: requiredObject({
      name: { type: "string" },
      toolPlan: { type: "object", additionalProperties: true }
    }),
    run_saved_report: requiredObject({ reportId: { type: "string" } }, [
      "reportId"
    ]),
    export_saved_report: requiredObject(
      {
        reportId: { type: "string" },
        format: { enum: ["json"] }
      },
      ["reportId"]
    ),
    list_meta_entities: requiredObject(
      {
        sourceId: { type: "string" },
        entity: { enum: ["campaign", "adset", "ad", "creative"] },
        limit: { type: "number", minimum: 1, maximum: 500 },
        fields: { type: "string" }
      },
      ["sourceId", "entity"]
    ),
    get_meta_entity: requiredObject(
      {
        sourceId: { type: "string" },
        entityId: { type: "string" },
        // Optional entity-kind hint. Selects the canonical default field set so a
        // `get` mirrors `list` (campaign/adset/ad/creative) instead of degrading
        // to Graph's id-only response. An explicit `fields` still overrides.
        entity: { enum: ["campaign", "adset", "ad", "creative"] },
        fields: { type: "string" }
      },
      ["sourceId", "entityId"]
    ),
    create_meta_campaign: requiredObject(
      {
        sourceId: { type: "string" },
        name: { type: "string" },
        objective: {
          type: "string",
          description: "Meta outcome objective, e.g. OUTCOME_TRAFFIC, OUTCOME_SALES (uppercase)."
        },
        // Budgets are integer minor units (cents) in the ad-account currency.
        dailyBudget: { type: "number", minimum: 0 },
        lifetimeBudget: { type: "number", minimum: 0 },
        clientToken: {
          type: "string",
          description: "Optional idempotency token; a repeat with the same token returns the existing id (deduped)."
        }
      },
      ["sourceId", "name", "objective"]
    ),
    create_meta_ad_set: requiredObject(
      {
        sourceId: { type: "string" },
        campaignId: { type: "string" },
        name: { type: "string" },
        optimizationGoal: { type: "string" },
        billingEvent: { type: "string" },
        dailyBudget: { type: "number", minimum: 0 },
        lifetimeBudget: { type: "number", minimum: 0 },
        bidAmount: { type: "number", minimum: 0 },
        startTime: { type: "string" },
        endTime: { type: "string" },
        targetingCountries: { type: "array", items: { type: "string" } },
        pixelId: { type: "string" },
        customEventType: { type: "string" },
        clientToken: { type: "string" }
      },
      ["sourceId", "campaignId", "name", "optimizationGoal", "billingEvent"]
    ),
    create_meta_creative: requiredObject(
      {
        sourceId: { type: "string" },
        name: { type: "string" },
        pageId: { type: "string" },
        imageHash: { type: "string" },
        instagramUserId: { type: "string" },
        linkUrl: { type: "string" },
        body: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        callToAction: { type: "string" },
        clientToken: { type: "string" }
      },
      ["sourceId", "name", "pageId"]
    ),
    create_meta_ad: requiredObject(
      {
        sourceId: { type: "string" },
        adsetId: { type: "string" },
        name: { type: "string" },
        creativeId: { type: "string" },
        clientToken: { type: "string" }
      },
      ["sourceId", "adsetId", "name", "creativeId"]
    ),
    set_meta_entity_status: requiredObject(
      {
        sourceId: { type: "string" },
        entityId: { type: "string" },
        // ACTIVE is the only money-spending transition; the CLI/operator confirm
        // gates live above this layer.
        status: { enum: ["ACTIVE", "PAUSED"] }
      },
      ["sourceId", "entityId", "status"]
    ),
    delete_meta_entity: requiredObject(
      {
        sourceId: { type: "string" },
        entityId: { type: "string" },
        // Optional entity-kind hint recorded in the audit row. Delete is a NODE
        // call (DELETE /{id}); creatives are not deletable via this verb. The
        // CLI's destructive confirm gate lives above this layer.
        entity: { enum: ["campaign", "adset", "ad"] }
      },
      ["sourceId", "entityId"]
    )
  };
  return schemas[id] ?? requiredObject({});
}

function requiredObject(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function analyticalQuerySchema(
  options: { groupByRequired?: boolean } = {}
): Record<string, unknown> {
  return requiredObject(
    {
      metric: {
        enum: FIRST_PHASE_METRICS,
        description:
          "Metric to query. For X, choose a compatible view: x_public_engagement -> queryable.vw_x_post_public_metrics; x_post_count/x_comment_count -> queryable.vw_x_authored_activity; x_follower_count -> queryable.vw_x_profile_public_metrics."
      },
      view: {
        enum: FIRST_PHASE_QUERYABLE_VIEWS,
        description:
          "Use a view compatible with the metric. For X: x_public_engagement uses queryable.vw_x_post_public_metrics; x_post_count and x_comment_count use queryable.vw_x_authored_activity; x_follower_count uses queryable.vw_x_profile_public_metrics."
      },
      site: {
        type: "string",
        description:
          "Optional GA4 site scope: a site URL (e.g. 'rtk.dev') or workspace_sites id. Resolves to the GA4 source that backs that site so the answer is isolated to one property. Omit only when a single GA4 source exists or a deliberate cross-site total is intended."
      },
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            operator: { enum: ["equals", "matches", "gte", "lte"] },
            value: { type: "string" }
          },
          required: ["field", "value"],
          additionalProperties: false
        }
      },
      groupBy: { type: "array", items: { type: "string" } },
      orderBy: {
        type: "object",
        properties: {
          field: { type: "string" },
          direction: { enum: ["asc", "desc"] }
        },
        required: ["field"],
        additionalProperties: false
      },
      limit: { type: "number", maximum: 500 },
      compareTo: {
        enum: ["prior_period", "prior_year"],
        description:
          "Optional comparison for trend answers (week-over-week, month-over-month, year-over-year). Set 'prior_period' to compare the result against the immediately preceding equal-length date range (e.g. the prior 7 days for a 7-day query — WoW/MoM), or 'prior_year' for the same range one calendar year earlier (YoY). REQUIRES occurred_on (or published_at for X) gte/lte date filters; without a bounded date range the comparison is skipped and a 'comparison_requires_date_range' caveat is added. The response gains a `comparison` block { mode, current, previous, absoluteDelta, percentDelta, direction, range } — phrase results as 'up/down X% vs prior period'. Comparison applies to run_metric_query only (it is ignored by run_breakdown_query)."
      }
    },
    options.groupByRequired ? ["metric", "groupBy"] : ["metric"]
  );
}

function actionOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: [
      "ok",
      "actionId",
      "status",
      "provenance",
      "caveats",
      "nextActions"
    ],
    properties: {
      ok: { type: "boolean" },
      actionId: { enum: FIRST_PHASE_ACTIONS },
      authority: { enum: ["tool_agent", "operator"] },
      status: {
        enum: [
          "ok",
          "resolved",
          "unsupported",
          "not_implemented",
          "low_coverage",
          "needs_clarification",
          "too_expensive",
          "queued",
          "error"
        ]
      },
      answerabilityReason: {
        enum: [
          "missing_context",
          "missing_journey_template",
          "unapproved_journey_template",
          "insufficient_source_coverage",
          "ambiguous_entity",
          "unsupported_intent",
          "policy_blocked",
          "cost_limit_exceeded",
          "execution_error"
        ]
      },
      interpretedPlan: journeyQueryPlanSchema(),
      resultHandle: { type: "string" },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: {
              enum: [
                "context_item",
                "query_result",
                "provider_record",
                "claim_verification"
              ]
            },
            sourceIds: { type: "array", items: { type: "string" } },
            claimIds: { type: "array", items: { type: "string" } },
            createdAt: { type: "string" },
            expiresAt: { type: ["string", "null"] }
          },
          required: ["id", "kind", "sourceIds"],
          additionalProperties: false
        }
      },
      coverage: {
        type: "object",
        properties: {
          sourceIds: { type: "array", items: { type: "string" } },
          requiredSourceIds: { type: "array", items: { type: "string" } },
          coveredCount: { type: "number" },
          expectedCount: { type: "number" },
          coverageRatio: { type: "number" },
          missingSourceIds: { type: "array", items: { type: "string" } },
          staleSourceIds: { type: "array", items: { type: "string" } }
        },
        required: ["sourceIds", "coveredCount", "expectedCount"],
        additionalProperties: false
      },
      policyRefs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: {
              enum: [
                "metric_definition",
                "journey_template",
                "source_capability",
                "privacy",
                "operator_policy"
              ]
            },
            version: { type: "string" },
            approved: { type: "boolean" }
          },
          required: ["id", "kind", "approved"],
          additionalProperties: false
        }
      },
      provenance: { type: "array", items: { type: "string" } },
      caveats: { type: "array", items: { type: "string" } },
      nextActions: { type: "array", items: { enum: FIRST_PHASE_ACTIONS } }
    },
    additionalProperties: true
  };
}

function journeyQueryPlanSchema(): Record<string, unknown> {
  return requiredObject(
    {
      intent: {
        enum: [
          "rank_entities_by_outcome",
          "compare_cohorts",
          "trace_paths",
          "find_behavior_signals",
          "summarize_lifecycle",
          "explain_change",
          "drilldown_evidence"
        ]
      },
      actor: requiredObject(
        {
          grain: { enum: ["person", "account"] }
        },
        ["grain"]
      ),
      journeyTemplateId: { type: "string" },
      entity: requiredObject(
        {
          type: {
            enum: [...JOURNEY_ENTITY_TYPES]
          },
          filters: { type: "object", additionalProperties: true }
        },
        ["type"]
      ),
      outcome: requiredObject(
        {
          id: { type: "string" },
          window: { type: "string" },
          policyId: { type: "string" }
        },
        ["id"]
      ),
      timeRange: requiredObject(
        {
          start: { type: "string" },
          end: { type: "string" }
        },
        ["start", "end"]
      ),
      groupBy: { type: "array", items: { type: "string" } },
      ranking: requiredObject(
        {
          metric: { type: "string" },
          direction: { enum: ["asc", "desc"] }
        },
        ["metric", "direction"]
      ),
      limit: { type: "number", maximum: 500 }
    },
    ["intent", "actor", "timeRange"]
  );
}

export * from "./session-memory.js";
export * from "./recipes.js";
export * from "./notifications.js";
