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
  | "cancelled";

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
  | "assistant_message"
  | "progress"
  | "approval_requested"
  | "approval_resolved"
  | "action_dispatch"
  | "action_outcome"
  | "continuation"
  | "task_state";

export type InteractiveActionSourceKind =
  | "host_confirmation"
  | "engine_action_call"
  | "service_journal";

export type InteractiveEffect = "read" | "local_write" | "external_write";
export type InteractiveReplayPolicy =
  | "read"
  | "idempotent_key"
  | "reconcile_before_retry";

export interface InteractiveTaskRecord {
  id: string;
  workspaceId: string;
  actorId: string;
  surface: "cmdl";
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
  preparedContextRevision: string | null;
  authorizationContextRevision: string | null;
  authorizationExpiresAt: string | null;
  decisionProvenance: string | null;
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

export interface InteractiveTransitionResult extends InteractiveTaskDetail {
  event: InteractiveTaskEvent;
  replayed: boolean;
}
