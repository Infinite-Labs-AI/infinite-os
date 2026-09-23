export const INTERACTIVE_TASK_EVENTS_CAPABILITY = "task.events.v1" as const;

export type InteractiveTaskState =
  | "active"
  | "awaiting_approval"
  | "recovering"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type InteractiveActionState =
  | "prepared"
  | "awaiting_approval"
  | "authorized"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "unknown"
  | "declined"
  | "cancelled"
  /** An earlier revision of a proposal that "Apply" re-prepared. Never executable. */
  | "superseded"
  /** A proposal whose grant lapsed or whose host restarted. Only a re-prepare can revive it. */
  | "expired";

export type InteractiveVerificationState =
  | "not_run"
  | "passed"
  | "failed"
  | "unavailable";

export type InteractiveContinuationState =
  | "not_required"
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type InteractiveTaskEventKind =
  | "user_message"
  /** The opening event of an automatic turn. Never human intent. */
  | "trigger"
  | "assistant_message"
  | "progress"
  | "approval_requested"
  | "approval_resolved"
  | "proposal_revised"
  | "proposal_rejected"
  | "authorization_expired"
  | "action_dispatch"
  | "action_outcome"
  | "continuation"
  | "task_state";

export type InteractiveActionSourceKind =
  | "host_confirmation"
  | "engine_action_call"
  | "service_journal";

/** Where the turn is shown. Automatic turns never render in Cmd+L or the terminal. */
export type InteractiveTaskSurface = "cmdl" | "terminal" | "imessage" | "agent_tasks";

/**
 * Who started the turn. `triggered` (data alert) and `scheduled` (time reminder) turns are
 * written by the server from rule data and are never human intent. A `human` task is a turn a
 * person started on its surface; terminal text alone is not proof of who typed it, so terminal
 * approvals must be typed approvals.
 */
export type InteractiveTaskOrigin = "human" | "triggered" | "scheduled";

/** Host-authored provenance of an automatic turn. Null for a human task. */
export interface InteractiveTaskProvenance {
  /**
   * The cloud delivery identity. For a triggered turn: `trigger:{alert_id}:{event_key}`, or
   * `trigger:{alert_id}:sha256:{hex}` when that exceeds 200 characters. The scheduled turn key otherwise.
   */
  triggerKey: string;
  ruleId: string;
  ruleVersion: number | null;
  checkKey: string | null;
  eventKey: string | null;
  /** sha256 hex of the untrusted event payload the turn was built from. */
  payloadHash: string;
}

/** How an approval reached the host. Terminal tasks accept only `typed_approval`. */
export type InteractiveDecisionSource = "host_confirmation" | "typed_approval";

export type InteractiveEffect = "read" | "local_write" | "external_write";
export type InteractiveReplayPolicy =
  | "read"
  | "idempotent_key"
  | "reconcile_before_retry";

export interface InteractiveTaskRecord {
  id: string;
  workspaceId: string;
  actorId: string;
  surface: InteractiveTaskSurface;
  origin: InteractiveTaskOrigin;
  provenance: InteractiveTaskProvenance | null;
  clientSurfaceKey: string;
  providerId: string;
  modelId: string;
  agentProfile: string;
  providerSessionId: string | null;
  acceptedContextRevision: string;
  authorityExpiresAt: string;
  context: Record<string, unknown>;
  state: InteractiveTaskState;
  revision: number;
  lastEventSequence: number;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InteractiveTaskEvent {
  eventId: string;
  taskId: string;
  workspaceId: string;
  actorId: string;
  sequence: number;
  kind: InteractiveTaskEventKind;
  /** The model turn an `assistant_message` belongs to; null for every other kind. */
  turnKey: string | null;
  payload: Record<string, unknown>;
  transitionRequestId: string;
  transitionRequestHash: string;
  createdAt: string;
}

export interface InteractiveActionRef {
  invocationId: string;
  taskId: string;
  workspaceId: string;
  actorId: string;
  sourceKind: InteractiveActionSourceKind;
  sourceRef: string | null;
  operationId: string;
  adapterVersion: string;
  schemaVersion: string;
  proposalRef: string;
  proposalRevision: number;
  proposalHash: string;
  proposal: Record<string, unknown>;
  inputHash: string;
  effect: InteractiveEffect;
  replayPolicy: InteractiveReplayPolicy;
  state: InteractiveActionState;
  supersedesInvocationId: string | null;
  /** When this revision was prepared. Approval is valid only while the preparation is fresh. */
  preparedAt: string;
  preparedContextRevision: string | null;
  authorizationContextRevision: string | null;
  authorizationExpiresAt: string | null;
  decisionProvenance: string | null;
  decisionSource: InteractiveDecisionSource | null;
  serviceResumeKey: string | null;
  receiptRef: string | null;
  outcomeSummary: string | null;
  verification: InteractiveVerificationState;
  continuationKey: string | null;
  continuationState: InteractiveContinuationState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface InteractiveTaskDetail {
  task: InteractiveTaskRecord;
  actions: InteractiveActionRef[];
}

export interface InteractiveTaskPage {
  tasks: InteractiveTaskDetail[];
  /** Opaque keyset cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

/** A live proposal (prepared, awaiting approval, authorized or expired) with its task. */
export interface InteractiveProposal {
  task: InteractiveTaskRecord;
  action: InteractiveActionRef;
}

export interface InteractiveProposalPage {
  proposals: InteractiveProposal[];
  nextCursor: string | null;
}

/** Actions a restarted host must settle: grants to end, dispatches to reconcile. */
export interface InteractiveActionPage {
  actions: InteractiveActionRef[];
  nextCursor: string | null;
}

export interface InteractiveTransitionResult extends InteractiveTaskDetail {
  event: InteractiveTaskEvent;
  replayed: boolean;
}
