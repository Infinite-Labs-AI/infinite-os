import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInfiniteOsDb,
  createProjectWithId,
  runMigrations,
  type InfiniteOsDb,
} from "@infinite-os/db";

import {
  InteractiveTaskConflictError,
  createInteractiveTaskStore,
} from "../src/interactive-task-store.js";
import {
  HOST_RESTART_UNKNOWN_SUMMARY,
  recoverInteractiveTasksAfterHostRestart,
} from "../src/interactive-task-recovery.js";
import type {
  ApplyInteractiveTaskTransitionInput,
  CreateHumanInteractiveTaskInput,
  InteractiveTaskStore,
  InteractiveTaskTransition,
  PreparedInteractiveActionInput,
} from "../src/interactive-task-types.js";

const WORKSPACE_A = "ws_recover_a";
const WORKSPACE_B = "ws_recover_b";
const ACTOR_A = "actor_a";
const ACTOR_B = "actor_b";
const H = (c: string) => c.repeat(64);
const T0 = "2026-09-20T21:00:00.000Z";
const at = (plusMs: number) => new Date(Date.parse(T0) + plusMs).toISOString();

type Fixture = { dataDir: string; db: InfiniteOsDb; store: InteractiveTaskStore };
const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.db.close();
    rmSync(item.dataDir, { recursive: true, force: true });
  }
});

async function fixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "infinite-os-task-recovery-"));
  const url = `pglite://${dataDir}`;
  await runMigrations(url);
  const db = createInfiniteOsDb(url);
  await createProjectWithId(db, WORKSPACE_A, "Workspace A");
  await createProjectWithId(db, WORKSPACE_B, "Workspace B");
  // The store never reads the wall clock for authority; pin it inside every grant window below.
  const store = createInteractiveTaskStore(db, { now: () => new Date(at(60_000)) });
  const result = { dataDir, db, store };
  fixtures.push(result);
  return result;
}

function action(invocationId: string, overrides: Partial<PreparedInteractiveActionInput> = {}): PreparedInteractiveActionInput {
  return {
    invocationId,
    sourceKind: "host_confirmation",
    operationId: "fake_update_budget",
    adapterVersion: "fake.v1",
    schemaVersion: "1",
    proposalRef: `P_${invocationId}`,
    proposalRevision: 1,
    proposalHash: H("c"),
    proposal: { title: `Change budget ${invocationId}`, summary: "Change the fake daily budget." },
    inputHash: H("d"),
    effect: "external_write",
    replayPolicy: "reconcile_before_retry",
    continuationKey: `continuation:${invocationId}`,
    ...overrides,
  };
}

let requestSeq = 0;
async function apply(store: InteractiveTaskStore, scope: { taskId: string; workspaceId: string; actorId: string },
  transition: InteractiveTaskTransition): Promise<void> {
  const detail = await store.getTask(scope);
  if (!detail) throw new Error(`no task ${scope.taskId}`);
  requestSeq += 1;
  const input: ApplyInteractiveTaskTransitionInput = { ...scope, expectedRevision: detail.task.revision,
    requestId: `setup_${requestSeq}`, requestHash: H("1"), eventId: `setup_event_${requestSeq}`, transition };
  await store.transition(input);
}

type Stage = "awaiting" | "authorized" | "dispatching" | "unknown" | "pending_follow_up" | "running_follow_up" | "succeeded_done";

/** Drives one human task with one action to `stage`, through the store's own transitions only. */
async function taskAt(f: Fixture, taskId: string, stage: Stage, options: { workspaceId?: string; actorId?: string } = {}) {
  const scope = { taskId, workspaceId: options.workspaceId ?? WORKSPACE_A, actorId: options.actorId ?? ACTOR_A };
  const invocationId = `inv_${taskId}`;
  const create: CreateHumanInteractiveTaskInput = {
    ...scope, origin: "human", surface: "cmdl", clientSurfaceKey: "cmdl:primary",
    providerId: "claude-cli", modelId: "claude-opus-4-8", agentProfile: "general-marketing-v1",
    acceptedContextRevision: "context_1", authorityExpiresAt: at(10 * 60_000), context: {},
    initialEvent: { eventId: `open_${taskId}`, requestId: `open_${taskId}`, requestHash: H("a"), kind: "user_message",
      payload: { text: "Change the budget." } },
  };
  await f.store.createTask(create);
  await apply(f.store, scope, { kind: "record_turn_result", turnKey: `turn_${taskId}`, assistantMessage: "Prepared.",
    actions: [action(invocationId, stage === "succeeded_done" ? { continuationKey: undefined } : {})] });
  if (stage === "awaiting") return { scope, invocationId };
  await apply(f.store, scope, { kind: "resolve_approval", invocationId, proposalRef: `P_${invocationId}`,
    proposalHash: H("c"), inputHash: H("d"), decision: "approve", preparedContextRevision: "context_1",
    authorizationExpiresAt: at(5 * 60_000), decisionProvenance: "cmdl-confirm-button", decisionSource: "host_confirmation" });
  if (stage === "authorized") return { scope, invocationId };
  await apply(f.store, scope, { kind: "claim_dispatch", invocationId, proposalHash: H("c"), inputHash: H("d"),
    preparedContextRevision: "context_1", serviceResumeKey: `journal:${invocationId}` });
  if (stage === "dispatching") return { scope, invocationId };
  if (stage === "unknown") {
    await apply(f.store, scope, { kind: "record_outcome", invocationId, state: "unknown", outcomeSummary: "Timed out.", verification: "not_run" });
    return { scope, invocationId };
  }
  await apply(f.store, scope, { kind: "record_outcome", invocationId, state: "succeeded", receiptRef: `receipt:${invocationId}`,
    outcomeSummary: "Budget changed.", verification: "passed" });
  if (stage === "running_follow_up") {
    await apply(f.store, scope, { kind: "claim_continuation", invocationId, continuationKey: `continuation:${invocationId}` });
  }
  return { scope, invocationId };
}

async function actionOf(f: Fixture, scope: { taskId: string; workspaceId: string; actorId: string }) {
  const detail = await f.store.getTask(scope);
  const head = detail?.actions.find((row) => row.state !== "superseded");
  if (!detail || !head) throw new Error("missing");
  return { task: detail.task, action: head };
}

async function eventCount(f: Fixture): Promise<number> {
  const rows = await f.db.query<{ n: string }>("select count(*)::text as n from interactive_task_events");
  return Number(rows[0]?.n ?? "0");
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; }
  catch (error) {
    expect(error).toBeInstanceOf(InteractiveTaskConflictError);
    return (error as InteractiveTaskConflictError).code;
  }
}

async function claimAgain(f: Fixture, scope: { taskId: string; workspaceId: string; actorId: string }, invocationId: string) {
  return codeOf(apply(f.store, scope, { kind: "claim_dispatch", invocationId, proposalHash: H("c"), inputHash: H("d"),
    preparedContextRevision: "context_1", serviceResumeKey: `journal:${invocationId}` }));
}

describe("host restart recovery", { timeout: 60_000 }, () => {
  it("ends a live grant with host_restart, before its expiry, and nothing can dispatch on it", async () => {
    const f = await fixture();
    const { scope, invocationId } = await taskAt(f, "t_auth", "authorized");

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.failures).toEqual([]);
    expect(report.settled).toEqual([{ kind: "grant_ended", taskId: "t_auth", actorId: ACTOR_A, invocationId,
      operationId: "fake_update_budget", title: `Change budget ${invocationId}`, changed: true }]);
    const { task, action: row } = await actionOf(f, scope);
    expect(row.state).toBe("expired");
    expect(task.state).toBe("awaiting_approval");
    const events = await f.store.listEvents(scope);
    expect(events.at(-1)).toMatchObject({ kind: "authorization_expired", payload: { invocationId, reason: "host_restart" } });
    expect(await claimAgain(f, scope, invocationId)).toBe("action_state_conflict");
  });

  it("records an in-flight send as unknown, never re-dispatchable, and still reconcilable", async () => {
    const f = await fixture();
    const { scope, invocationId } = await taskAt(f, "t_disp", "dispatching");

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.settled).toMatchObject([{ kind: "outcome_unknown", invocationId, changed: true }]);
    const { task, action: row } = await actionOf(f, scope);
    expect(row).toMatchObject({ state: "unknown", outcomeSummary: HOST_RESTART_UNKNOWN_SUMMARY, verification: "not_run" });
    expect(task.state).toBe("recovering");
    // Not re-sent: neither a claim nor a re-prepare (Apply) can start it again.
    expect(await claimAgain(f, scope, invocationId)).toBe("action_state_conflict");
    const revise = codeOf(apply(f.store, scope, { kind: "revise_proposal", invocationId, proposalHash: H("c"),
      preparedContextRevision: "context_2", revised: { ...action("inv_t_disp_r2"), proposalRef: undefined, proposalRevision: undefined } as never }));
    expect(await revise).toBe("action_state_conflict");
    // A later read-back can still settle it.
    await apply(f.store, scope, { kind: "record_outcome", invocationId, state: "succeeded", receiptRef: "receipt:late",
      outcomeSummary: "Provider confirmed the change.", verification: "passed" });
    expect((await actionOf(f, scope)).action.state).toBe("succeeded");
  });

  it("leaves an already-unknown send alone and still reports it", async () => {
    const f = await fixture();
    const { scope, invocationId } = await taskAt(f, "t_unk", "unknown");
    const before = await eventCount(f);

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.settled).toMatchObject([{ kind: "outcome_unknown", invocationId, changed: false }]);
    expect(await eventCount(f)).toBe(before);
    expect((await actionOf(f, scope)).action.outcomeSummary).toBe("Timed out.");
  });

  it("stops a pending or running follow-up turn so the task does not stay active", async () => {
    const f = await fixture();
    const pending = await taskAt(f, "t_pend", "pending_follow_up");
    const running = await taskAt(f, "t_run", "running_follow_up");
    expect((await actionOf(f, pending.scope)).task.state).toBe("active");
    expect((await actionOf(f, running.scope)).task.state).toBe("active");

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.failures).toEqual([]);
    expect(report.settled.map((item) => [item.kind, item.taskId]).sort()).toEqual([
      ["follow_up_stopped", "t_pend"], ["follow_up_stopped", "t_run"]]);
    for (const { scope } of [pending, running]) {
      const { task, action: row } = await actionOf(f, scope);
      expect(row).toMatchObject({ state: "succeeded", continuationState: "failed" });
      expect(task.state).not.toBe("active");
      const events = await f.store.listEvents(scope);
      expect(events.some((event) => event.kind === "progress" &&
        event.payload.kind === "host_restart_recovery" && event.payload.stopped === "follow_up")).toBe(true);
    }
  });

  it("leaves proposals awaiting approval and finished actions untouched", async () => {
    const f = await fixture();
    await taskAt(f, "t_wait", "awaiting");
    await taskAt(f, "t_done", "succeeded_done");
    const before = await eventCount(f);

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report).toEqual({ bootId: "boot_1", settled: [], failures: [] });
    expect(await eventCount(f)).toBe(before);
  });

  it("settles every actor in the workspace and never touches another workspace", async () => {
    const f = await fixture();
    const a = await taskAt(f, "t_a", "authorized", { actorId: ACTOR_A });
    const b = await taskAt(f, "t_b", "dispatching", { actorId: ACTOR_B });
    const other = await taskAt(f, "t_other", "authorized", { workspaceId: WORKSPACE_B });
    const otherFollowUp = await taskAt(f, "t_other_run", "running_follow_up", { workspaceId: WORKSPACE_B });

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    // Another workspace's rows are never even read, so they cannot surface as failures here.
    expect(report.failures).toEqual([]);
    expect(report.settled.map((item) => [item.actorId, item.kind]).sort()).toEqual([
      [ACTOR_A, "grant_ended"], [ACTOR_B, "outcome_unknown"]]);
    expect((await actionOf(f, a.scope)).action.state).toBe("expired");
    expect((await actionOf(f, b.scope)).action.state).toBe("unknown");
    expect((await actionOf(f, other.scope)).action.state).toBe("authorized");
    expect((await actionOf(f, otherFollowUp.scope)).action.continuationState).toBe("running");
  });

  it("pages past the first 50 recoverable actions and the first 50 follow-ups", async () => {
    const f = await fixture();
    for (let i = 0; i < 52; i += 1) await taskAt(f, `t_g${i}`, "authorized");
    for (let i = 0; i < 51; i += 1) await taskAt(f, `t_c${i}`, "running_follow_up");

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.failures).toEqual([]);
    expect(report.settled.filter((item) => item.kind === "grant_ended")).toHaveLength(52);
    expect(report.settled.filter((item) => item.kind === "follow_up_stopped")).toHaveLength(51);
    const left = await f.db.query<{ n: string }>(`select count(*)::text as n from interactive_action_refs
      where state = 'authorized' or (state = 'succeeded' and continuation_state in ('pending','running'))`);
    expect(left[0]?.n).toBe("0");
  });

  it("is idempotent: a retried boot and a later boot write nothing more", async () => {
    const f = await fixture();
    await taskAt(f, "t_auth", "authorized");
    await taskAt(f, "t_disp", "dispatching");
    await taskAt(f, "t_run", "running_follow_up");
    await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });
    const after = await eventCount(f);

    const retried = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });
    const next = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_2" });

    expect(await eventCount(f)).toBe(after);
    // Only the unknown send stays reported, so the person keeps seeing it until it is reconciled.
    for (const report of [retried, next]) {
      expect(report.failures).toEqual([]);
      expect(report.settled).toMatchObject([{ kind: "outcome_unknown", taskId: "t_disp", changed: false }]);
    }
  });

  it("replays a step the same boot already wrote instead of writing it twice", async () => {
    const f = await fixture();
    const { scope } = await taskAt(f, "t_pend", "pending_follow_up");
    // A first attempt of this boot wrote its note and claim, then the host died before finishing.
    const flaky: InteractiveTaskStore = { ...f.store, transition: async (input) => {
      if (input.transition.kind === "finish_continuation") throw new Error("host died");
      return f.store.transition(input);
    } };
    const first = await recoverInteractiveTasksAfterHostRestart({ db: f.db, store: flaky }, { workspaceId: WORKSPACE_A, bootId: "boot_1" });
    expect(first.failures).toMatchObject([{ taskId: "t_pend", code: "recovery_failed" }]);
    expect((await actionOf(f, scope)).action.continuationState).toBe("running");

    const second = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(second.failures).toEqual([]);
    expect((await actionOf(f, scope)).action.continuationState).toBe("failed");
    const notes = (await f.store.listEvents(scope)).filter((event) => event.kind === "progress");
    expect(notes).toHaveLength(1);
  });

  it("retries a task another writer changed between the read and the write", async () => {
    const f = await fixture();
    const { scope } = await taskAt(f, "t_auth", "authorized");
    let raced = false;
    const racing: InteractiveTaskStore = { ...f.store, transition: async (input) => {
      if (!raced && input.transition.kind === "expire_authorization") {
        raced = true;
        await apply(f.store, scope, { kind: "append_event", eventKind: "progress", payload: { note: "concurrent" } });
      }
      return f.store.transition(input);
    } };

    const report = await recoverInteractiveTasksAfterHostRestart({ db: f.db, store: racing }, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(raced).toBe(true);
    expect(report.failures).toEqual([]);
    expect((await actionOf(f, scope)).action.state).toBe("expired");
  });

  it("reports, and does not force, a row it cannot settle", async () => {
    const f = await fixture();
    const { scope } = await taskAt(f, "t_auth", "authorized");
    const refusing: InteractiveTaskStore = { ...f.store, transition: async () => {
      throw new InteractiveTaskConflictError("task_revision_conflict", "always racing");
    } };

    const report = await recoverInteractiveTasksAfterHostRestart({ db: f.db, store: refusing }, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.settled).toEqual([]);
    expect(report.failures).toEqual([{ taskId: "t_auth", actorId: ACTOR_A, invocationId: "inv_t_auth", code: "task_revision_conflict" }]);
    expect((await actionOf(f, scope)).action.state).toBe("authorized");
  });

  it("records an in-flight send on a cancelled task too", async () => {
    const f = await fixture();
    const { scope, invocationId } = await taskAt(f, "t_cancel", "dispatching");
    await apply(f.store, scope, { kind: "cancel_task", reason: "user pressed Cancel" });

    const report = await recoverInteractiveTasksAfterHostRestart(f, { workspaceId: WORKSPACE_A, bootId: "boot_1" });

    expect(report.settled).toMatchObject([{ kind: "outcome_unknown", invocationId, changed: true }]);
    const { task, action: row } = await actionOf(f, scope);
    expect(row.state).toBe("unknown");
    expect(task.state).toBe("cancelled");
  });

  it("rejects a malformed boot id or workspace before reading anything", async () => {
    const f = await fixture();
    for (const input of [{ workspaceId: WORKSPACE_A, bootId: "" }, { workspaceId: WORKSPACE_A, bootId: "boot 1" },
      { workspaceId: "ws/a", bootId: "boot_1" }]) {
      expect(await codeOf(recoverInteractiveTasksAfterHostRestart(f, input))).toBe("invalid_task_input");
    }
  });
});
