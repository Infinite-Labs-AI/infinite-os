import type {
  InteractiveActionPage,
  InteractiveActionRef,
  InteractiveActionSourceKind,
  InteractiveDecisionSource,
  InteractiveEffect,
  InteractiveReplayPolicy,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskOrigin,
  InteractiveProposalPage,
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

/**
 * The grant ceiling. A confirmation lives at most 10 minutes, and a prepared revision can be
 * approved only within the same window after it was prepared.
 */
export const MAX_INTERACTIVE_GRANT_MS = 10 * 60_000;

export interface InteractiveTaskStoreOptions {
  /**
   * Clock for every authority check (task authority, grant ceiling, grant expiry). Defaults to
   * the system clock; inject a fixed clock in tests so expiry fixtures never depend on today's date.
   */
  now?: () => Date;
  /** A shorter grant ceiling (also the approval freshness window). Values above MAX_INTERACTIVE_GRANT_MS are rejected. */
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

/**
 * A turn a person started. Its opening event is their message. On the terminal surface that text
 * is not proof of who typed it, so approvals there must be typed approvals.
 */
export interface CreateHumanInteractiveTaskInput extends CreateInteractiveTaskBase {
  origin: "human";
  surface: Extract<InteractiveTaskSurface, "cmdl" | "terminal" | "imessage">;
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
      /**
       * The model turn this result belongs to. A result whose turn key was already recorded is a
       * retry and returns that recorded outcome. On an automatic task the opening turn's key is the
       * task's trigger key; later turns (continuations) use their own keys.
       */
      turnKey: string;
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
       * Any grant on the predecessor is discarded, never carried over. A proposal of an automatic
       * turn can only be approved after this re-prepare.
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
      /** Must equal the revision's own prepared context; approval never rebinds it. */
      preparedContextRevision: string;
      /** Must be after now and at most the grant ceiling from now. Ignored for a decline. */
      authorizationExpiresAt: string;
      decisionProvenance: string;
      decisionSource: InteractiveDecisionSource;
    }
  | {
      /**
       * Cancel: rejects a proposal that is awaiting approval, authorized or expired. The row
       * becomes `declined`, any grant ends, and no re-prepare can revive it.
       */
      kind: "reject_proposal";
      invocationId: string;
      proposalHash: string;
      decisionProvenance: string;
      decisionSource: InteractiveDecisionSource;
    }
  | {
      /**
       * Ends a grant without dispatch. `lapsed` requires the grant's expiry to have passed;
       * `host_restart` ends it early because the in-memory confirmation is gone. The proposal
       * stays durable as `expired`; Apply may re-prepare it. Cancel is `reject_proposal`.
       */
      kind: "expire_authorization";
      invocationId: string;
      reason: "lapsed" | "host_restart";
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

export interface ListLiveProposalsInput {
  workspaceId: string;
  actorId: string;
  origin?: InteractiveTaskOrigin;
  /** Page size, 1..100 (default 50). */
  limit?: number;
  cursor?: string;
}

export interface ListRecoverableActionsInput {
  workspaceId: string;
  /** Default: all three. */
  states?: Array<"authorized" | "dispatching" | "unknown">;
  /** Page size, 1..100 (default 50). */
  limit?: number;
  cursor?: string;
}

export interface InteractiveTaskStore {
  createTask(input: CreateInteractiveTaskInput): Promise<InteractiveTransitionResult>;
  getTask(input: { taskId: string; workspaceId: string; actorId: string }): Promise<InteractiveTaskDetail | null>;
  /** Newest-first keyset pages over non-terminal tasks; nothing is silently dropped. */
  listActiveTasks(input: ListActiveInteractiveTasksInput): Promise<InteractiveTaskPage>;
  /** Newest-first live proposals across the actor's tasks: the board's read. */
  listLiveProposals(input: ListLiveProposalsInput): Promise<InteractiveProposalPage>;
  /**
   * Oldest-first actions a restarted host must settle, across every actor in the workspace:
   * `authorized` grants to end with `host_restart`, `dispatching`/`unknown` to reconcile.
   */
  listRecoverableActions(input: ListRecoverableActionsInput): Promise<InteractiveActionPage>;
  listEvents(input: { taskId: string; workspaceId: string; actorId: string; after?: number; limit?: number }): Promise<InteractiveTaskEvent[]>;
  transition(input: ApplyInteractiveTaskTransitionInput): Promise<InteractiveTransitionResult>;
}

export type {
  InteractiveActionPage,
  InteractiveActionRef,
  InteractiveProposalPage,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskPage,
  InteractiveTaskRecord,
  InteractiveTransitionResult,
};
