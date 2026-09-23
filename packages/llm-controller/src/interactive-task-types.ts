import type {
  InteractiveActionRef,
  InteractiveActionSourceKind,
  InteractiveEffect,
  InteractiveReplayPolicy,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskOrigin,
  InteractiveTaskPage,
  InteractiveTaskProvenance,
  InteractiveTaskRecord,
  InteractiveTaskSurface,
  InteractiveTransitionResult,
} from "@infinite-os/types";

/**
 * The narrow database surface the daemon injects. Row types are constrained to records so the
 * engine's own `InfiniteOsDb` (pg or PGlite) satisfies it directly, without a cast adapter.
 */
export interface InteractiveTaskStoreDb {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransaction<T>(fn: (tx: InteractiveTaskStoreDb) => Promise<T>): Promise<T>;
}

/** The grant ceiling: a confirmation lives at most 10 minutes (alerts contract §5). */
export const MAX_INTERACTIVE_GRANT_MS = 10 * 60_000;

export interface InteractiveTaskStoreOptions {
  /**
   * Clock for every authority check (task authority, grant ceiling, grant expiry). Defaults to
   * the system clock; inject a fixed clock in tests so expiry fixtures never depend on today's date.
   */
  now?: () => Date;
  /** A shorter grant ceiling. Values above MAX_INTERACTIVE_GRANT_MS are rejected. */
  maxGrantMs?: number;
}

interface CreateInteractiveTaskBase {
  taskId: string;
  workspaceId: string;
  actorId: string;
  clientSurfaceKey: string;
  providerId: string;
  modelId: string;
  agentProfile: string;
  acceptedContextRevision: string;
  authorityExpiresAt: string;
  context: Record<string, unknown>;
}

/** A turn a human typed. Its opening event is the human's message. */
export interface CreateHumanInteractiveTaskInput extends CreateInteractiveTaskBase {
  origin: "human";
  surface: Extract<InteractiveTaskSurface, "cmdl" | "imessage">;
  provenance?: null;
  initialEvent: {
    eventId: string;
    requestId: string;
    requestHash: string;
    kind: "user_message";
    payload: Record<string, unknown>;
  };
}

/**
 * A turn no human typed. Its opening event is a `trigger`, never a `user_message`, and its
 * provenance is host-authored. A retry with the same trigger key returns the existing task.
 */
export interface CreateAutomaticInteractiveTaskInput extends CreateInteractiveTaskBase {
  origin: Exclude<InteractiveTaskOrigin, "human">;
  surface: Extract<InteractiveTaskSurface, "imessage" | "agent_tasks">;
  provenance: InteractiveTaskProvenance;
  initialEvent: {
    eventId: string;
    requestId: string;
    requestHash: string;
    kind: "trigger";
    payload: Record<string, unknown>;
  };
}

export type CreateInteractiveTaskInput = CreateHumanInteractiveTaskInput | CreateAutomaticInteractiveTaskInput;

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

/** A fresh prepare of an existing proposal. Ref and revision are derived from the predecessor. */
export type RevisedInteractiveActionInput = Omit<PreparedInteractiveActionInput, "proposalRef" | "proposalRevision">;

export type InteractiveTaskTransition =
  | {
      kind: "record_turn_result";
      providerSessionId?: string;
      assistantMessage: string;
      actions: PreparedInteractiveActionInput[];
    }
  | {
      /** Only `progress`, or a `user_message` on a human task. Other kinds belong to their transitions. */
      kind: "append_event";
      eventKind: "progress" | "user_message";
      payload: Record<string, unknown>;
    }
  | {
      /**
       * "Apply" re-prepares: a fresh read produces a new revision (new hashes allowed) that
       * supersedes the predecessor. Allowed from awaiting_approval, authorized or expired.
       * Any grant on the predecessor is discarded, never carried over.
       */
      kind: "revise_proposal";
      invocationId: string;
      proposalHash: string;
      preparedContextRevision: string;
      revised: RevisedInteractiveActionInput;
    }
  | {
      kind: "resolve_approval";
      invocationId: string;
      proposalRef: string;
      proposalHash: string;
      inputHash: string;
      decision: "approve" | "decline";
      preparedContextRevision: string;
      /** Must be after now and at most the grant ceiling from now. Ignored for a decline. */
      authorizationExpiresAt: string;
      decisionProvenance: string;
    }
  | {
      /**
       * Ends a grant without dispatch. `lapsed` requires the grant's expiry to have passed;
       * `host_restart` and `discarded` end it early (the in-memory confirmation is gone, or the
       * user pressed Cancel). The proposal stays durable as `expired`.
       */
      kind: "expire_authorization";
      invocationId: string;
      reason: "lapsed" | "host_restart" | "discarded";
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

export interface ListActiveInteractiveTasksInput {
  workspaceId: string;
  actorId: string;
  surface?: InteractiveTaskSurface;
  origin?: InteractiveTaskOrigin;
  /** Page size, 1..100 (default 50). */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

export interface InteractiveTaskStore {
  createTask(input: CreateInteractiveTaskInput): Promise<InteractiveTransitionResult>;
  getTask(input: { taskId: string; workspaceId: string; actorId: string }): Promise<InteractiveTaskDetail | null>;
  /** Newest-first keyset pages over non-terminal tasks; nothing is silently dropped. */
  listActiveTasks(input: ListActiveInteractiveTasksInput): Promise<InteractiveTaskPage>;
  listEvents(input: { taskId: string; workspaceId: string; actorId: string; after?: number; limit?: number }): Promise<InteractiveTaskEvent[]>;
  transition(input: ApplyInteractiveTaskTransitionInput): Promise<InteractiveTransitionResult>;
}

export type {
  InteractiveActionRef,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskPage,
  InteractiveTaskRecord,
  InteractiveTransitionResult,
};
