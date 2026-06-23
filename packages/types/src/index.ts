//
// @infinite-os/types — the one sanctioned cross-zone contract package.
//
// This is a ZERO-DEPENDENCY LEAF: it must never import from `@infinite-os/*`
// or pull in any runtime/core code. It holds the canonical shapes that both the
// engine (runtime / llm-controller re-export these) and the desktop app consume,
// so neither side hand-mirrors the other.
//
// Where a contract field would otherwise drag in another package (e.g. the
// engine's `interpretedPlan` is a `JourneyQueryPlan`, which transitively needs
// `JourneyEntityType` from `@infinite-os/core`), the field is typed as `unknown`
// here. The engine keeps its richer local typing internally; the wire/contract
// shape stays leaf-clean. This matches the desktop hand-mirror it replaces.
//
// The action arrays below carry the LIVE engine contract — including the Meta
// Ads management actions (`list_meta_entities`/`get_meta_entity` reads and the
// `create_meta_*`/`set_meta_entity_status`/`delete_meta_entity` operator writes)
// — so the desktop's `InfiniteOsActionId` union has full Meta parity.
//

/** Who is acting: a read-only tool agent, or a write-capable operator. */
export type Authority = "tool_agent" | "operator";

/**
 * The runtime surface a session originates from. `desktop` is the native
 * Electron skin on the engine; all other surfaces are engine-internal entry
 * points. Canonical here so both engine and desktop agree on the union.
 */
export type RuntimeSurface = "cli" | "api" | "app" | "mcp" | "worker" | "desktop";

export interface SessionContext {
  workspaceId: string;
  sessionId: string;
  actorId: string;
  authority: Authority;
  surface: RuntimeSurface;
  timezone?: string;
}

export type AnswerabilityStatus =
  | "ok"
  | "resolved"
  | "unsupported"
  | "not_implemented"
  | "low_coverage"
  | "needs_clarification"
  | "too_expensive"
  | "queued"
  | "error";

export type AnswerabilityReason =
  | "missing_context"
  | "missing_journey_template"
  | "unapproved_journey_template"
  | "insufficient_source_coverage"
  | "ambiguous_entity"
  | "unsupported_intent"
  | "policy_blocked"
  | "cost_limit_exceeded"
  | "execution_error";

export interface EvidenceHandle {
  id: string;
  kind:
    | "context_item"
    | "query_result"
    | "provider_record"
    | "claim_verification";
  sourceIds: string[];
  claimIds?: string[];
  createdAt?: string;
  expiresAt?: string | null;
}

export interface CoverageSummary {
  sourceIds: string[];
  requiredSourceIds?: string[];
  coveredCount: number;
  expectedCount: number;
  coverageRatio?: number;
  missingSourceIds?: string[];
  staleSourceIds?: string[];
}

export interface PolicyRef {
  id: string;
  kind:
    | "metric_definition"
    | "journey_template"
    | "source_capability"
    | "privacy"
    | "operator_policy";
  version?: string;
  approved: boolean;
}

/**
 * The result envelope for every action.
 *
 * `interpretedPlan` is typed `unknown` to keep this package a zero-dep leaf —
 * in the engine it is a `JourneyQueryPlan` (which needs `JourneyEntityType`
 * from `@infinite-os/core`). The engine only ever WRITES a `JourneyQueryPlan`
 * into it (never reads it back typed), so the `unknown` contract shape is
 * sufficient everywhere; callers that need the rich plan narrow it locally.
 */
export interface ActionEnvelope<T = unknown> {
  ok: boolean;
  actionId: InfiniteOsActionId;
  authority: Authority;
  status: AnswerabilityStatus;
  data?: T;
  error?: { code: string; message: string; field?: string };
  answerabilityReason?: AnswerabilityReason;
  interpretedPlan?: unknown;
  resultHandle?: string;
  evidence?: EvidenceHandle[];
  coverage?: CoverageSummary;
  policyRefs?: PolicyRef[];
  provenance: string[];
  freshness?: { target: string; asOf: string | null; stale: boolean };
  caveats: string[];
  truncated: boolean;
  nextActions: InfiniteOsActionId[];
}

export type InfiniteOsActionId = (typeof FIRST_PHASE_ACTIONS)[number];

export const READ_ACTIONS = [
  "list_sources",
  "describe_source",
  "get_recent_sync_runs",
  "sync_source_now",
  "list_source_schedules",
  "list_queryable_views",
  "describe_queryable_view",
  "list_metrics",
  "describe_metric",
  "run_metric_query",
  "run_breakdown_query",
  "run_funnel_query",
  "explain_answer",
  "drilldown_result",
  "search_context",
  "describe_context_item",
  "resolve_entity",
  "validate_journey_plan",
  "run_journey_query",
  "fetch_evidence",
  "verify_claims",
  // Meta Ads management READS (no money movement): list/get keep tool_agent
  // authority and the normal retryable taxonomy. The WRITE ids below are
  // operator-only.
  "list_meta_assets",
  "list_meta_entities",
  "get_meta_entity"
] as const;

export const OPERATOR_ACTIONS = [
  "connect_source",
  "reconnect_source",
  "revoke_source",
  "start_source_sync",
  "update_source_schedule",
  "pause_source_schedule",
  "resume_source_schedule",
  "create_saved_report",
  "run_saved_report",
  "export_saved_report",
  // Meta Ads WRITE/management — every one can move money (create or go-live) or
  // destroy live spend objects, so all are operator-authority. An LLM/tool_agent
  // session can NEVER fire these (assertAuthority throws "operator authority
  // required"). Creates ALWAYS land PAUSED; set_meta_entity_status is the
  // separate, gated go-live transition; delete_meta_entity is the destructive
  // (irreversible) cleanup transition.
  "create_meta_campaign",
  "create_meta_ad_set",
  "create_meta_ad",
  "create_meta_creative",
  "set_meta_entity_status",
  "delete_meta_entity"
] as const;

export const FIRST_PHASE_ACTIONS = [
  ...READ_ACTIONS,
  ...OPERATOR_ACTIONS
] as const;

/**
 * The shape returned by the LLM controller's `chat` turn. Canonical here so the
 * desktop renderer can type the daemon response without hand-mirroring it.
 */
export interface ChatResponse {
  ok: boolean;
  sessionId: string;
  message: string;
  provenance: string[];
  actionCalls: ChatActionCall[];
  usage?: ModelUsage;
  modelProvider?: "codex" | "claude";
  modelName?: string;
  modelAuthSource?: string;
}

/**
 * A single action invocation inside a chat turn. Referenced by `ChatResponse`.
 * `envelope` is the contract `ActionEnvelope`; `status` widens the envelope's
 * status with the controller-level confirmation/error states.
 */
export interface ChatActionCall {
  id: string;
  actionId: string;
  input: unknown;
  status: ActionEnvelope["status"] | "requires_confirmation" | "error";
  requiresConfirmation: boolean;
  confirmationId?: string;
  inputHash?: string;
  envelope?: ActionEnvelope;
  error?: { code: string; message: string };
}

/**
 * Token accounting reported by a model turn. Typed structurally (zero-dep) so
 * `ChatResponse.usage` does not need to import the controller's model client.
 * Mirrors the engine's `ModelUsage` (llm-controller/src/index.ts) exactly.
 */
export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
}
