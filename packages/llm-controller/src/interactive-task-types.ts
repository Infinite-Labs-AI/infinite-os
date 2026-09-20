import type {
  InteractiveActionRef,
  InteractiveActionSourceKind,
  InteractiveEffect,
  InteractiveReplayPolicy,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskEventKind,
  InteractiveTaskRecord,
  InteractiveTransitionResult,
} from "@infinite-os/types";

export interface InteractiveTaskStoreDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransaction<T>(fn: (tx: InteractiveTaskStoreDb) => Promise<T>): Promise<T>;
}

export interface CreateInteractiveTaskInput {
  taskId: string;
  workspaceId: string;
  actorId: string;
  surface: "cmdl";
  clientSurfaceKey: string;
  providerId: string;
  modelId: string;
  agentProfile: string;
  acceptedContextRevision: string;
  authorityExpiresAt: string;
  context: Record<string, unknown>;
  initialEvent: {
    eventId: string;
    requestId: string;
    requestHash: string;
    kind: "user_message";
    payload: Record<string, unknown>;
  };
}

export interface PreparedInteractiveActionInput {
  invocationId: string;
  sourceKind: InteractiveActionSourceKind;
  sourceRef?: string;
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
  continuationKey?: string;
}

export type InteractiveTaskTransition =
  | {
      kind: "record_turn_result";
      providerSessionId?: string;
      assistantMessage: string;
      actions: PreparedInteractiveActionInput[];
    }
  | {
      kind: "append_event";
      eventKind: InteractiveTaskEventKind;
      payload: Record<string, unknown>;
    }
  | {
      kind: "reprepare_action";
      invocationId: string;
      proposalHash: string;
      inputHash: string;
      preparedContextRevision: string;
    }
  | {
      kind: "resolve_approval";
      invocationId: string;
      proposalRef: string;
      proposalHash: string;
      inputHash: string;
      decision: "approve" | "decline";
      preparedContextRevision: string;
      authorizationExpiresAt: string;
      decisionProvenance: string;
    }
  | {
      kind: "claim_dispatch";
      invocationId: string;
      proposalHash: string;
      inputHash: string;
      preparedContextRevision: string;
      serviceResumeKey: string;
    }
  | {
      kind: "record_outcome";
      invocationId: string;
      state: "succeeded" | "failed" | "unknown";
      receiptRef?: string;
      outcomeSummary: string;
      verification: "not_run" | "passed" | "failed" | "unavailable";
    }
  | {
      kind: "claim_continuation";
      invocationId: string;
      continuationKey: string;
    }
  | {
      kind: "finish_continuation";
      invocationId: string;
      continuationKey: string;
      state: "completed" | "failed";
    }
  | { kind: "cancel_task"; reason: string };

export interface ApplyInteractiveTaskTransitionInput {
  taskId: string;
  workspaceId: string;
  actorId: string;
  expectedRevision: number;
  requestId: string;
  requestHash: string;
  eventId: string;
  transition: InteractiveTaskTransition;
}

export interface InteractiveTaskStore {
  createTask(input: CreateInteractiveTaskInput): Promise<InteractiveTransitionResult>;
  getTask(input: { taskId: string; workspaceId: string; actorId: string }): Promise<InteractiveTaskDetail | null>;
  listActiveTasks(input: { workspaceId: string; actorId: string; surface: "cmdl" }): Promise<InteractiveTaskDetail[]>;
  listEvents(input: { taskId: string; workspaceId: string; actorId: string; after?: number; limit?: number }): Promise<InteractiveTaskEvent[]>;
  transition(input: ApplyInteractiveTaskTransitionInput): Promise<InteractiveTransitionResult>;
}

export type {
  InteractiveActionRef,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskRecord,
  InteractiveTransitionResult,
};
