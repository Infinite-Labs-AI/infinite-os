import { createHash } from "node:crypto";

import type { InteractiveActionRef } from "@infinite-os/types";

import { InteractiveTaskConflictError } from "./interactive-task-store.js";
import type {
  ApplyInteractiveTaskTransitionInput,
  InteractiveTaskStore,
  InteractiveTaskStoreDb,
  InteractiveTaskTransition,
} from "./interactive-task-types.js";

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PAGE = 50;
// A task another writer keeps changing is retried a few times, then reported, never forced.
const MAX_REVISION_RETRIES = 3;

export const HOST_RESTART_UNKNOWN_SUMMARY =
  "Infinite restarted while this was being sent, so it may or may not have happened. Check it before trying again.";

/** What a restarted host did to one action, in terms a person can be told. */
export type HostRestartSettlementKind =
  /** The grant is gone with the old process. Nothing was sent; the proposal can be approved again. */
  | "grant_ended"
  /** A send was in flight. It is now `unknown`: never dispatched again, still reconcilable. */
  | "outcome_unknown"
  /** The action went through, but the follow-up turn that would have checked it was stopped. */
  | "follow_up_stopped";

export interface HostRestartSettlement {
  kind: HostRestartSettlementKind;
  taskId: string;
  actorId: string;
  invocationId: string;
  operationId: string;
  /** The host-rendered proposal title, when the proposal carries one. */
  title: string | null;
  /** False when an earlier boot already left the action in this state (no new write). */
  changed: boolean;
}

export interface HostRestartRecoveryFailure {
  taskId: string;
  actorId: string;
  invocationId: string;
  code: string;
}

export interface HostRestartRecoveryReport {
  bootId: string;
  settled: HostRestartSettlement[];
  /** Rows left as they were because they could not be settled; each needs attention, not silence. */
  failures: HostRestartRecoveryFailure[];
}

export interface HostRestartRecoveryInput {
  workspaceId: string;
  /** Unique per host process boot. Retrying the same boot's recovery replays instead of writing twice. */
  bootId: string;
}

type ContinuationRow = {
  invocationId: string; taskId: string; workspaceId: string; actorId: string;
  operationId: string; proposal: Record<string, unknown>; continuationKey: string | null;
  continuationState: "pending" | "running"; cursorCreatedAt: string;
};

/**
 * Settles what a host restart left behind in one workspace, across every actor. Run it once per
 * host boot, before that host claims any dispatch or records any approval:
 * - an `authorized` grant ends (`expire_authorization`, `host_restart`); nothing was sent;
 * - a `dispatching` send becomes `unknown`; the store never lets an `unknown` row be claimed again;
 * - a succeeded action whose follow-up turn was pending or running has that follow-up stopped.
 * Every write goes through the store's own transitions, so its rules and CAS still apply.
 */
export async function recoverInteractiveTasksAfterHostRestart(
  deps: { db: InteractiveTaskStoreDb; store: InteractiveTaskStore },
  input: HostRestartRecoveryInput,
): Promise<HostRestartRecoveryReport> {
  if (typeof input.workspaceId !== "string" || !ID_RE.test(input.workspaceId)) {
    throw new InteractiveTaskConflictError("invalid_task_input", "workspaceId is invalid.");
  }
  if (typeof input.bootId !== "string" || !ID_RE.test(input.bootId)) {
    throw new InteractiveTaskConflictError("invalid_task_input", "bootId is invalid.");
  }
  const failures: HostRestartRecoveryFailure[] = [];
  // Unknown sends an earlier boot left: reported (unchanged) so they stay visible until reconciled.
  const leftUnknown: HostRestartSettlement[] = [];

  let cursor: string | undefined;
  do {
    const page = await deps.store.listRecoverableActions({ workspaceId: input.workspaceId, limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const action of page.actions) {
      if (action.state === "unknown") {
        leftUnknown.push(settlement("outcome_unknown", action, false));
        continue;
      }
      const steps: Step[] = action.state === "authorized"
        ? [{ name: "expire", transition: { kind: "expire_authorization", invocationId: action.invocationId, reason: "host_restart" } }]
        : [{ name: "unknown", transition: { kind: "record_outcome", invocationId: action.invocationId, state: "unknown",
            outcomeSummary: HOST_RESTART_UNKNOWN_SUMMARY, verification: "not_run" } }];
      const failure = await applySteps(deps.store, input, action, steps);
      if (failure) failures.push(failure);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  let after: [string, string] | null = null;
  for (;;) {
    const rows: ContinuationRow[] = await deps.db.query<ContinuationRow>(`select invocation_id as "invocationId",
        task_id as "taskId", workspace_id as "workspaceId", actor_id as "actorId", operation_id as "operationId",
        proposal_json as "proposal", continuation_key as "continuationKey", continuation_state as "continuationState",
        created_at::text as "cursorCreatedAt"
      from interactive_action_refs a
      where workspace_id = $1 and state = 'succeeded' and continuation_state in ('pending','running')
        -- A cancelled task's pending follow-up can never start (the store refuses the claim): the
        -- cancellation already settled it. One that was already running is still stopped below.
        and not (continuation_state = 'pending' and exists (select 1 from interactive_tasks t
          where t.id = a.task_id and t.workspace_id = a.workspace_id and t.state = 'cancelled'))
        and ($2::timestamptz is null or (created_at, invocation_id) > ($2::timestamptz, $3::text))
      order by created_at, invocation_id limit $4`,
      [input.workspaceId, after?.[0] ?? null, after?.[1] ?? null, PAGE]);
    for (const row of rows) {
      const continuationKey = row.continuationKey;
      if (!continuationKey) {
        failures.push({ taskId: row.taskId, actorId: row.actorId, invocationId: row.invocationId, code: "continuation_key_missing" });
        continue;
      }
      const steps: Step[] = [
        ...(row.continuationState === "pending"
          ? [{ name: "claim", transition: { kind: "claim_continuation", invocationId: row.invocationId, continuationKey } } satisfies Step]
          : []),
        { name: "finish", transition: { kind: "finish_continuation", invocationId: row.invocationId, continuationKey, state: "failed" } },
      ];
      const failure = await applySteps(deps.store, input, row, steps);
      if (failure) {
        failures.push(failure);
        continue;
      }
      // Written only once the follow-up really was stopped. It is history, not a settlement: if it
      // cannot be written the follow-up is still stopped, so its failure is not reported as one.
      await applySteps(deps.store, input, row, [{ name: "note", transition: { kind: "append_event", eventKind: "progress",
        // Stable across retries of this boot: the same request id must carry the same payload.
        payload: { kind: "host_restart_recovery", bootId: input.bootId, invocationId: row.invocationId, stopped: "follow_up" } } }]);
    }
    const last = rows.at(-1);
    if (!last || rows.length < PAGE) break;
    after = [last.cursorCreatedAt, last.invocationId];
  }

  // The report is rebuilt from what this boot wrote, not from what this call happened to do, so a
  // retried call (say, after the caller timed out) still returns everything the boot settled.
  const settled = await settledByBoot(deps.db, input);
  const changedIds = new Set(settled.map((item) => item.invocationId));
  return {
    bootId: input.bootId,
    settled: [...settled, ...leftUnknown.filter((item) => !changedIds.has(item.invocationId))],
    failures,
  };
}

type SettledEventRow = {
  kind: string; payload: Record<string, unknown>; taskId: string; actorId: string;
  invocationId: string; operationId: string; proposal: Record<string, unknown>;
};

async function settledByBoot(db: InteractiveTaskStoreDb, input: HostRestartRecoveryInput): Promise<HostRestartSettlement[]> {
  const rows = await db.query<SettledEventRow>(`select e.kind, e.payload_json as "payload", e.task_id as "taskId",
      e.actor_id as "actorId", a.invocation_id as "invocationId", a.operation_id as "operationId",
      a.proposal_json as "proposal"
    from interactive_task_events e
    join interactive_action_refs a on a.task_id = e.task_id and a.invocation_id = e.payload_json->>'invocationId'
    where e.workspace_id = $1 and e.transition_request_id like $2
    order by e.created_at, e.task_id, e.sequence`,
    [input.workspaceId, `${bootRequestPrefix(input.bootId)}%`]);
  const settled: HostRestartSettlement[] = [];
  for (const row of rows) {
    const kind: HostRestartSettlementKind | null =
      row.kind === "authorization_expired" ? "grant_ended"
        : row.kind === "action_outcome" && row.payload.state === "unknown" ? "outcome_unknown"
          : row.kind === "continuation" && row.payload.state === "failed" ? "follow_up_stopped"
            : null;
    if (kind) settled.push(settlement(kind, row, true));
  }
  return settled;
}

/** Every request id a boot writes starts with this, so the boot's own writes can be found again. */
function bootRequestPrefix(bootId: string): string {
  return `host-restart:${createHash("sha256").update(bootId).digest("hex").slice(0, 16)}:`;
}

type Step = { name: string; transition: InteractiveTaskTransition };
type ActionScope = { taskId: string; actorId: string; invocationId: string };

/** Applies one action's steps in order. Each step is keyed by (boot, action, step), so a retry replays. */
async function applySteps(
  store: InteractiveTaskStore,
  input: HostRestartRecoveryInput,
  action: ActionScope,
  steps: Step[],
): Promise<HostRestartRecoveryFailure | null> {
  const failed = (code: string): HostRestartRecoveryFailure =>
    ({ taskId: action.taskId, actorId: action.actorId, invocationId: action.invocationId, code });
  for (const step of steps) {
    const key = createHash("sha256").update(JSON.stringify([input.bootId, action.taskId, action.invocationId, step.name])).digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify(step.transition)).digest("hex");
    for (let attempt = 0; ; attempt += 1) {
      const detail = await store.getTask({ taskId: action.taskId, workspaceId: input.workspaceId, actorId: action.actorId });
      if (!detail) return failed("task_not_found");
      const request: ApplyInteractiveTaskTransitionInput = {
        taskId: action.taskId, workspaceId: input.workspaceId, actorId: action.actorId,
        expectedRevision: detail.task.revision,
        requestId: `${bootRequestPrefix(input.bootId)}${key.slice(0, 48)}`,
        requestHash,
        eventId: `host-restart-event:${key.slice(0, 48)}`,
        transition: step.transition,
      };
      try {
        await store.transition(request);
        break;
      } catch (error) {
        const code = error instanceof InteractiveTaskConflictError ? error.code : "recovery_failed";
        if (code === "task_revision_conflict" && attempt < MAX_REVISION_RETRIES) continue;
        return failed(code);
      }
    }
  }
  return null;
}

function settlement(
  kind: HostRestartSettlementKind,
  action: Pick<InteractiveActionRef, "taskId" | "actorId" | "invocationId" | "operationId" | "proposal">,
  changed: boolean,
): HostRestartSettlement {
  const title = action.proposal && typeof action.proposal.title === "string" ? action.proposal.title : null;
  return { kind, taskId: action.taskId, actorId: action.actorId, invocationId: action.invocationId,
    operationId: action.operationId, title, changed };
}
