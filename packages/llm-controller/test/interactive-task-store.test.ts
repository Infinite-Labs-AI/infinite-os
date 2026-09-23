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
  MAX_INTERACTIVE_GRANT_MS,
  type CreateAutomaticInteractiveTaskInput,
  type CreateHumanInteractiveTaskInput,
  type InteractiveTaskStoreOptions,
  type PreparedInteractiveActionInput,
} from "../src/interactive-task-types.js";

const WORKSPACE_A = "ws_task_a";
const WORKSPACE_B = "ws_task_b";
const ACTOR_A = "actor_a";
const H = (c: string) => c.repeat(64);

// The draft's fixture window: the task was opened at 21:00 with authority until 21:10.
const T0 = "2026-09-20T21:00:00.000Z";

type Fixture = {
  dataDir: string;
  url: string;
  db: InfiniteOsDb;
};

const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "infinite-os-task-store-"));
  const url = `pglite://${dataDir}`;
  await runMigrations(url);
  const db = createInfiniteOsDb(url);
  await createProjectWithId(db, WORKSPACE_A, "Workspace A");
  await createProjectWithId(db, WORKSPACE_B, "Workspace B");
  const result = { dataDir, url, db };
  fixtures.push(result);
  return result;
}

// The store never reads the wall clock for authority. Tests pin time explicitly so an
// expiry fixture cannot turn into a time bomb once the calendar passes it.
function fixedClock(iso: string) {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    set(next: string) { current = new Date(next); },
  };
}

function storeAt(db: InfiniteOsDb, clock = fixedClock(T0), options: Omit<InteractiveTaskStoreOptions, "now"> = {}) {
  return createInteractiveTaskStore(db, { ...options, now: clock.now });
}

function taskInput(overrides: Partial<CreateHumanInteractiveTaskInput> = {}): CreateHumanInteractiveTaskInput {
  return {
    taskId: "task_1",
    workspaceId: WORKSPACE_A,
    actorId: ACTOR_A,
    origin: "human",
    surface: "cmdl",
    clientSurfaceKey: "cmdl:primary",
    providerId: "claude-cli",
    modelId: "claude-opus-4-8",
    agentProfile: "general-marketing-v1",
    acceptedContextRevision: "context_boot_1",
    authorityExpiresAt: "2026-09-20T21:10:00.000Z",
    context: { activeSurfaceId: "marketing" },
    initialEvent: {
      eventId: "event_1",
      requestId: "request_create_1",
      requestHash: H("a"),
      kind: "user_message",
      payload: { text: "Prepare a safe fake write." },
    },
    ...overrides,
  };
}

// A data-alert turn: the key mirrors the delivery row identity `trigger:{alert_id}:{event_key}`.
function triggeredInput(overrides: Partial<CreateAutomaticInteractiveTaskInput> = {}): CreateAutomaticInteractiveTaskInput {
  return {
    taskId: "task_trig_1",
    workspaceId: WORKSPACE_A,
    actorId: ACTOR_A,
    origin: "triggered",
    surface: "agent_tasks",
    clientSurfaceKey: "alerts:board",
    providerId: "claude-cli",
    modelId: "claude-opus-4-8",
    agentProfile: "legacy-growth-operator-v1",
    acceptedContextRevision: "context_trigger_1",
    authorityExpiresAt: "2026-09-20T21:10:00.000Z",
    context: {},
    provenance: {
      triggerKey: "trigger:alert_42:cpa_over_40:2026-09-20",
      ruleId: "alert_42",
      ruleVersion: 3,
      checkKey: "check:2026-09-20T21:00",
      eventKey: "cpa_over_40:2026-09-20",
      payloadHash: H("9"),
    },
    initialEvent: {
      eventId: "event_trig_1",
      requestId: "request_trig_create_1",
      requestHash: H("a"),
      kind: "trigger",
      payload: { summary: "CPA went over the rule's threshold." },
    },
    ...overrides,
  };
}

function preparedAction(overrides: Partial<PreparedInteractiveActionInput> = {}): PreparedInteractiveActionInput {
  return {
    invocationId: "invocation_1",
    sourceKind: "host_confirmation",
    sourceRef: "historical-confirmation-ref",
    operationId: "fake_update_budget",
    adapterVersion: "fake.v1",
    schemaVersion: "1",
    proposalRef: "P1",
    proposalRevision: 1,
    proposalHash: H("c"),
    proposal: {
      title: "Update fake campaign budget",
      target: "Alpha",
      summary: "Change the fake daily budget to USD 30.",
    },
    inputHash: H("d"),
    effect: "external_write",
    replayPolicy: "reconcile_before_retry",
    continuationKey: "continuation:invocation_1",
    ...overrides,
  };
}

function transitionFor(taskId: string, expectedRevision: number, requestId: string, requestHash: string,
  transition: Parameters<ReturnType<typeof createInteractiveTaskStore>["transition"]>[0]["transition"]) {
  return { taskId, workspaceId: WORKSPACE_A, actorId: ACTOR_A, expectedRevision, requestId, requestHash,
    eventId: `event_${requestId}`, transition };
}

function turnResultTransition(taskId = "task_1", actions = [preparedAction()]) {
  return {
    ...transitionFor(taskId, 1, "request_turn_result_1", H("b"), {
      kind: "record_turn_result",
      providerSessionId: "provider_session_1",
      assistantMessage: "I prepared the bounded change for approval.",
      actions,
    }),
    eventId: "event_2",
  };
}

function approveTransition(expectedRevision: number, authorizationExpiresAt: string, options: {
  taskId?: string; invocationId?: string; proposalHash?: string; inputHash?: string; context?: string; requestId?: string;
} = {}) {
  return transitionFor(options.taskId ?? "task_1", expectedRevision, options.requestId ?? "request_approve", H("1"), {
    kind: "resolve_approval",
    invocationId: options.invocationId ?? "invocation_1",
    proposalRef: "P1",
    proposalHash: options.proposalHash ?? H("c"),
    inputHash: options.inputHash ?? H("d"),
    decision: "approve",
    preparedContextRevision: options.context ?? "context_boot_1",
    authorizationExpiresAt,
    decisionProvenance: "cmdl-confirm-button",
  });
}

function dispatchTransition(expectedRevision: number, requestId = "request_dispatch", options: {
  taskId?: string; invocationId?: string; proposalHash?: string; inputHash?: string; context?: string;
} = {}) {
  return transitionFor(options.taskId ?? "task_1", expectedRevision, requestId, H("2"), {
    kind: "claim_dispatch",
    invocationId: options.invocationId ?? "invocation_1",
    inputHash: options.inputHash ?? H("d"),
    proposalHash: options.proposalHash ?? H("c"),
    preparedContextRevision: options.context ?? "context_boot_1",
    serviceResumeKey: "fake-journal:invocation_1",
  });
}

function reviseTransition(expectedRevision: number, requestId: string, options: {
  taskId?: string; from?: string; fromHash?: string; to?: string; proposalHash?: string; inputHash?: string;
  operationId?: string; context?: string;
} = {}) {
  const { proposalRef: _ref, proposalRevision: _revision, ...body } = preparedAction({
    invocationId: options.to ?? "invocation_1_r2",
    proposalHash: options.proposalHash ?? H("e"),
    inputHash: options.inputHash ?? H("f"),
    operationId: options.operationId ?? "fake_update_budget",
    continuationKey: "continuation:invocation_1",
    proposal: { title: "Update fake campaign budget", summary: "Fresh read: change the budget to USD 32." },
  });
  return transitionFor(options.taskId ?? "task_1", expectedRevision, requestId, H("7"), {
    kind: "revise_proposal",
    invocationId: options.from ?? "invocation_1",
    proposalHash: options.fromHash ?? H("c"),
    preparedContextRevision: options.context ?? "context_apply_1",
    revised: body,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    // Every failure the store reports is typed; a raw Postgres error fails this helper.
    expect(error).toBeInstanceOf(InteractiveTaskConflictError);
    return (error as InteractiveTaskConflictError).code;
  }
}

async function countRows(db: InfiniteOsDb, table: string, taskId?: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `select count(*)::text as n from ${table}${taskId ? " where task_id = $1" : ""}`, taskId ? [taskId] : []);
  return Number(rows[0]?.n ?? "0");
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const item = fixtures.pop()!;
    await item.db.close();
    rmSync(item.dataDir, { recursive: true, force: true });
  }
});

// Every test migrates a fresh temp PGlite through the whole stack (~1s alone, 5s+ when the full
// suite runs in parallel), so the 5s default timeout flakes under CI load.
describe("interactive task store", { timeout: 60_000 }, () => {
  it("persists a scoped task and replays an identical create request", async () => {
    const { db } = await fixture();
    const store = storeAt(db);

    const created = await store.createTask(taskInput());
    const replayed = await store.createTask(taskInput());

    expect(created.replayed).toBe(false);
    expect(created.task).toMatchObject({
      id: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      origin: "human",
      surface: "cmdl",
      provenance: null,
      revision: 1,
      lastEventSequence: 1,
    });
    expect(created.event.kind).toBe("user_message");
    expect(replayed).toEqual({ ...created, replayed: true });
    await expect(store.getTask({ taskId: "task_1", workspaceId: WORKSPACE_B, actorId: ACTOR_A })).resolves.toBeNull();
    await expect(store.getTask({ taskId: "task_1", workspaceId: WORKSPACE_A, actorId: "actor_b" })).resolves.toBeNull();
  });

  it("atomically records the final assistant event and pending action refs", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());

    const result = await store.transition(turnResultTransition());

    expect(result.replayed).toBe(false);
    expect(result.task).toMatchObject({
      state: "awaiting_approval",
      providerSessionId: "provider_session_1",
      revision: 2,
      lastEventSequence: 2,
    });
    expect(result.event).toMatchObject({ sequence: 2, kind: "assistant_message" });
    expect(result.actions).toEqual([
      expect.objectContaining({
        invocationId: "invocation_1",
        state: "awaiting_approval",
        proposalRef: "P1",
        proposalRevision: 1,
        supersedesInvocationId: null,
        proposalHash: H("c"),
        inputHash: H("d"),
        serviceResumeKey: null,
        receiptRef: null,
      }),
    ]);
  });

  it("deduplicates the same transition and rejects request-id reuse or stale CAS", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());

    const first = await store.transition(turnResultTransition());
    const replayed = await store.transition(turnResultTransition());
    expect(replayed).toEqual({ ...first, replayed: true });

    await expect(store.transition({ ...turnResultTransition(), requestHash: H("e") }))
      .rejects.toMatchObject({ code: "transition_request_conflict" });
    expect(await codeOf(store.transition(transitionFor("task_1", 1, "request_stale", H("f"),
      { kind: "append_event", eventKind: "progress", payload: { text: "late" } })))).toBe("task_revision_conflict");
  });

  it("keeps input and service resume keys immutable across approval, dispatch, and outcome", async () => {
    const { db } = await fixture();
    // Inside the approval window (expires 21:09), whatever today's wall-clock date is.
    const store = storeAt(db, fixedClock("2026-09-20T21:05:00.000Z"));
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    const approved = await store.transition(approveTransition(2, "2026-09-20T21:09:00.000Z"));
    expect(approved.actions[0]).toMatchObject({ state: "authorized" });

    const dispatching = await store.transition(dispatchTransition(3));
    expect(dispatching.actions[0]).toMatchObject({ state: "dispatching", serviceResumeKey: "fake-journal:invocation_1" });

    expect(await codeOf(store.transition({
      ...dispatchTransition(4, "request_changed_key", { inputHash: H("0") }),
      transition: { ...dispatchTransition(4).transition, inputHash: H("0"), serviceResumeKey: "fake-journal:different" },
    } as ReturnType<typeof dispatchTransition>))).toBe("action_identity_mismatch");

    const succeeded = await store.transition(transitionFor("task_1", 4, "request_outcome", H("4"), {
      kind: "record_outcome",
      invocationId: "invocation_1",
      state: "succeeded",
      receiptRef: "fake-receipt:1",
      outcomeSummary: "Fake budget is now USD 30.",
      verification: "passed",
    }));
    expect(succeeded.actions[0]).toMatchObject({ state: "succeeded", receiptRef: "fake-receipt:1", continuationState: "pending" });
  });

  it("expires dispatch authority by the injected clock, not the wall clock", async () => {
    const { db } = await fixture();
    // Dates far in the wall-clock future: only the injected clock can make this grant expire.
    const clock = fixedClock("2030-01-01T00:00:00.000Z");
    const store = storeAt(db, clock);
    await store.createTask(taskInput({ authorityExpiresAt: "2030-01-01T00:15:00.000Z" }));
    await store.transition(turnResultTransition());
    await store.transition(approveTransition(2, "2030-01-01T00:10:00.000Z"));

    // The grant ends AT its expiry instant; a restored or delayed dispatch cannot use it.
    clock.set("2030-01-01T00:10:00.000Z");
    expect(await codeOf(store.transition(dispatchTransition(3)))).toBe("action_authority_expired");
    const detail = await store.getTask({ taskId: "task_1", workspaceId: WORKSPACE_A, actorId: ACTOR_A });
    expect(detail?.task.revision).toBe(3);
    expect(detail?.actions[0]).toMatchObject({ state: "authorized", serviceResumeKey: null });

    // One millisecond earlier the same claim is inside the window.
    clock.set("2030-01-01T00:09:59.999Z");
    const dispatching = await store.transition(dispatchTransition(3, "request_dispatch_in_window"));
    expect(dispatching.actions[0]).toMatchObject({ state: "dispatching" });
  });

  it("cancels only undispatched actions and preserves committed or uncertain effects", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    await db.query("update interactive_action_refs set state = 'dispatching' where invocation_id = $1", ["invocation_1"]);
    const cancelled = await store.transition(transitionFor("task_1", 2, "request_cancel", H("5"),
      { kind: "cancel_task", reason: "user_requested" }));

    expect(cancelled.task.state).toBe("cancelled");
    expect(cancelled.actions[0]?.state).toBe("dispatching");
  });

  it("survives a true database and store recreation without widening actor scope", async () => {
    const item = await fixture();
    const firstStore = storeAt(item.db);
    await firstStore.createTask(taskInput());
    await firstStore.transition(turnResultTransition());
    await item.db.close();

    const reopenedDb = createInfiniteOsDb(item.url);
    item.db = reopenedDb;
    const restartedStore = storeAt(reopenedDb);
    const resumed = await restartedStore.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, surface: "cmdl" });
    const wrongActor = await restartedStore.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: "actor_b", surface: "cmdl" });

    expect(resumed.tasks).toHaveLength(1);
    expect(resumed.nextCursor).toBeNull();
    expect(resumed.tasks[0]).toMatchObject({
      task: { id: "task_1", state: "awaiting_approval" },
      actions: [expect.objectContaining({ invocationId: "invocation_1" })],
    });
    expect(wrongActor).toEqual({ tasks: [], nextCursor: null });
  });

  it("rejects proposal display payloads containing credential-shaped keys", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());

    expect(await codeOf(store.transition(turnResultTransition("task_1", [
      preparedAction({ proposal: { title: "Unsafe", sessionToken: "must-not-persist" } }),
    ])))).toBe("unsafe_proposal_payload");
  });
});

describe("trigger-keyed proposals", { timeout: 60_000 }, () => {
  it("maps a retried automatic create to the task its trigger key already opened", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const created = await store.createTask(triggeredInput());

    // The mailbox retry re-runs the turn: new task id, request id, event id and hash, same key.
    const retried = await store.createTask(triggeredInput({
      taskId: "task_trig_retry",
      initialEvent: { eventId: "event_trig_retry", requestId: "request_trig_retry", requestHash: H("b"), kind: "trigger", payload: {} },
    }));

    expect(retried.replayed).toBe(true);
    expect(retried.task.id).toBe("task_trig_1");
    expect(retried.event).toEqual(created.event);
    expect(await countRows(db, "interactive_tasks")).toBe(1);
    expect(await countRows(db, "interactive_task_events")).toBe(1);

    // The key is scoped to the actor that owns it and to its workspace.
    expect(await codeOf(store.createTask(triggeredInput({ taskId: "task_trig_other_actor", actorId: "actor_b",
      initialEvent: { ...triggeredInput().initialEvent, eventId: "event_other_actor", requestId: "request_other_actor" } }))))
      .toBe("trigger_key_conflict");
    const otherWorkspace = await store.createTask(triggeredInput({ taskId: "task_trig_ws_b", workspaceId: WORKSPACE_B,
      initialEvent: { ...triggeredInput().initialEvent, eventId: "event_ws_b", requestId: "request_ws_b" } }));
    expect(otherWorkspace.replayed).toBe(false);
  });

  it("maps every retried turn-result shape to the existing proposal, never a second live one", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(triggeredInput());
    const first = await store.transition(turnResultTransition("task_trig_1"));
    expect(first.replayed).toBe(false);

    // A retried turn re-runs the model: new request id and hash, stale expected revision, and
    // (a) the same invocation id, (b) a fresh invocation id for the same proposal, (c) a fresh
    // invocation id at the next revision, (d) a different proposal altogether.
    const shapes = [
      preparedAction(),
      preparedAction({ invocationId: "invocation_retry_b" }),
      preparedAction({ invocationId: "invocation_retry_c", proposalRevision: 2, proposalHash: H("9") }),
      preparedAction({ invocationId: "invocation_retry_d", proposalRef: "P2", continuationKey: undefined }),
    ];
    for (const [index, action] of shapes.entries()) {
      const retried = await store.transition({
        ...transitionFor("task_trig_1", 1, `request_retry_${index}`, H(String(index + 3)),
          { kind: "record_turn_result", assistantMessage: `retried output ${index}`, actions: [action] }),
      });
      expect(retried.replayed).toBe(true);
      expect(retried.event).toEqual(first.event);
      expect(retried.actions).toEqual(first.actions);
    }

    expect(await countRows(db, "interactive_action_refs", "task_trig_1")).toBe(1);
    const events = await store.listEvents({ taskId: "task_trig_1", workspaceId: WORKSPACE_A, actorId: ACTOR_A });
    expect(events.map((event) => event.kind)).toEqual(["trigger", "assistant_message"]);
    const detail = await store.getTask({ taskId: "task_trig_1", workspaceId: WORKSPACE_A, actorId: ACTOR_A });
    expect(detail?.task.revision).toBe(2);
  });

  it("types the same retry shapes on a human task instead of leaking Postgres errors", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    const retry = (index: number, action: PreparedInteractiveActionInput) => store.transition(transitionFor("task_1", 2,
      `request_human_retry_${index}`, H(String(index + 3)), { kind: "record_turn_result", assistantMessage: "again", actions: [action] }));
    expect(await codeOf(retry(0, preparedAction()))).toBe("invocation_id_conflict");
    expect(await codeOf(retry(1, preparedAction({ invocationId: "invocation_b", continuationKey: undefined })))).toBe("proposal_conflict");
    expect(await codeOf(retry(2, preparedAction({ invocationId: "invocation_c", proposalRevision: 2, continuationKey: undefined }))))
      .toBe("invalid_task_input");
    expect(await codeOf(retry(3, preparedAction({ invocationId: "invocation_d", proposalRef: "P2", continuationKey: undefined }))))
      .toBe("resolved");
    expect(await countRows(db, "interactive_action_refs", "task_1")).toBe(2);
  });
});

describe("a proposal outlives its grant", { timeout: 60_000 }, () => {
  it("caps a grant at ten minutes from the injected clock", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    const tenMinutesOneMs = new Date(Date.parse(T0) + MAX_INTERACTIVE_GRANT_MS + 1).toISOString();
    expect(await codeOf(store.transition(approveTransition(2, tenMinutesOneMs, { requestId: "request_too_long" })))).toBe("invalid_grant");
    expect(await codeOf(store.transition(approveTransition(2, T0, { requestId: "request_already_past" })))).toBe("invalid_grant");
    const exactlyTen = new Date(Date.parse(T0) + MAX_INTERACTIVE_GRANT_MS).toISOString();
    const approved = await store.transition(approveTransition(2, exactlyTen));
    expect(approved.actions[0]).toMatchObject({ state: "authorized", authorizationExpiresAt: exactlyTen });

    // A deployment may shorten the ceiling, never lengthen it.
    expect(() => createInteractiveTaskStore(db, { maxGrantMs: MAX_INTERACTIVE_GRANT_MS + 1 })).toThrow(RangeError);
    const shortStore = storeAt(db, clock, { maxGrantMs: 60_000 });
    await shortStore.createTask(taskInput({ taskId: "task_short", initialEvent: { ...taskInput().initialEvent, eventId: "event_short" } }));
    await shortStore.transition({ ...turnResultTransition("task_short",
      [preparedAction({ invocationId: "invocation_short", continuationKey: undefined })]), eventId: "event_short_turn" });
    expect(await codeOf(shortStore.transition(approveTransition(2, new Date(Date.parse(T0) + 60_001).toISOString(),
      { taskId: "task_short", invocationId: "invocation_short", requestId: "request_short" })))).toBe("invalid_grant");
  });

  it("expires a lapsed grant, then Apply re-prepares a fresh revision that supersedes it", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());
    await store.transition(approveTransition(2, "2026-09-20T21:10:00.000Z"));

    // The grant lapses; the proposal must stay durable and must not get stuck.
    expect(await codeOf(store.transition(transitionFor("task_1", 3, "request_expire_early", H("3"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "lapsed" })))).toBe("action_state_conflict");
    clock.set("2026-09-21T09:00:00.000Z");
    expect(await codeOf(store.transition(dispatchTransition(3)))).toBe("action_authority_expired");
    const expired = await store.transition(transitionFor("task_1", 3, "request_expire", H("3"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "lapsed" }));
    expect(expired.actions[0]).toMatchObject({ state: "expired" });
    expect(expired.task.state).toBe("awaiting_approval");
    expect(expired.event.kind).toBe("authorization_expired");
    // An expired grant can neither be dispatched nor approved again as-is.
    expect(await codeOf(store.transition(dispatchTransition(4, "request_dispatch_expired")))).toBe("action_state_conflict");
    expect(await codeOf(store.transition(approveTransition(4, "2026-09-21T09:05:00.000Z", { requestId: "request_reapprove" }))))
      .toBe("action_state_conflict");

    // Apply, twelve hours later: a fresh read changed the hashes. The task's original authority
    // has long lapsed; the Apply click plus the new approval is the fresh human authority.
    const revised = await store.transition(reviseTransition(4, "request_apply"));
    expect(revised.event).toMatchObject({ kind: "proposal_revised",
      payload: { invocationId: "invocation_1_r2", supersededInvocationId: "invocation_1", proposalRevision: 2 } });
    expect(revised.task.state).toBe("awaiting_approval");
    expect(revised.actions).toEqual([
      expect.objectContaining({ invocationId: "invocation_1", proposalRevision: 1, state: "superseded" }),
      expect.objectContaining({ invocationId: "invocation_1_r2", proposalRevision: 2, state: "awaiting_approval",
        supersedesInvocationId: "invocation_1", proposalHash: H("e"), inputHash: H("f"),
        preparedContextRevision: "context_apply_1", authorizationExpiresAt: null, continuationState: "pending" }),
    ]);

    // The stale revision can never dispatch or be revised again; the fresh one runs normally.
    expect(await codeOf(store.transition(reviseTransition(5, "request_apply_stale", { to: "invocation_1_r3" })))).toBe("action_state_conflict");
    await store.transition(approveTransition(5, "2026-09-21T09:08:00.000Z", {
      invocationId: "invocation_1_r2", proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1",
      requestId: "request_approve_r2" }));
    const dispatching = await store.transition(dispatchTransition(6, "request_dispatch_r2", {
      invocationId: "invocation_1_r2", proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1" }));
    expect(dispatching.actions.find((action) => action.invocationId === "invocation_1_r2")?.state).toBe("dispatching");
  });

  it("ends a live grant early on host restart or Cancel, without extending anything", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());
    await store.transition(approveTransition(2, "2026-09-20T21:09:00.000Z"));

    const discarded = await store.transition(transitionFor("task_1", 3, "request_discard", H("3"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "host_restart" }));
    expect(discarded.actions[0]).toMatchObject({ state: "expired" });
    // Only an authorized action has a grant to end.
    expect(await codeOf(store.transition(transitionFor("task_1", 4, "request_discard_again", H("4"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "discarded" })))).toBe("action_state_conflict");
  });

  it("re-prepares an unapproved or live-authorized proposal and refuses terminal or mismatched ones", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    // A revision may not swap the operation, and it must name the revision it replaces.
    expect(await codeOf(store.transition(reviseTransition(2, "request_other_op", { operationId: "fake_delete_campaign" }))))
      .toBe("action_identity_mismatch");
    expect(await codeOf(store.transition(reviseTransition(2, "request_wrong_hash", { fromHash: H("0") }))))
      .toBe("action_identity_mismatch");
    // A re-used invocation id is typed, not a raw primary-key error.
    expect(await codeOf(store.transition(reviseTransition(2, "request_reuse_id", { to: "invocation_1" }))))
      .toBe("invocation_id_conflict");

    // From awaiting_approval: supersedes directly.
    await store.transition(reviseTransition(2, "request_r2"));
    // From a live grant: the grant is discarded with its revision, never carried over.
    await store.transition(approveTransition(3, "2026-09-20T21:09:00.000Z", {
      invocationId: "invocation_1_r2", proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1" }));
    const r3 = await store.transition(reviseTransition(4, "request_r3", {
      from: "invocation_1_r2", fromHash: H("e"), to: "invocation_1_r3", proposalHash: H("8") }));
    expect(r3.actions.map((action) => [action.invocationId, action.proposalRevision, action.state, action.authorizationExpiresAt]))
      .toEqual([
        ["invocation_1", 1, "superseded", null],
        ["invocation_1_r2", 2, "superseded", "2026-09-20T21:09:00.000Z"],
        ["invocation_1_r3", 3, "awaiting_approval", null],
      ]);

    // A declined proposal is final: Apply cannot revive it.
    await store.transition({ ...approveTransition(5, T0, { invocationId: "invocation_1_r3", proposalHash: H("8"),
      inputHash: H("f"), context: "context_apply_1", requestId: "request_decline" }),
      transition: { ...approveTransition(5, T0, { invocationId: "invocation_1_r3", proposalHash: H("8"), inputHash: H("f"),
        context: "context_apply_1" }).transition, decision: "decline" } } as ReturnType<typeof approveTransition>);
    expect(await codeOf(store.transition(reviseTransition(6, "request_revive", {
      from: "invocation_1_r3", fromHash: H("8"), to: "invocation_1_r4" })))).toBe("action_state_conflict");
  });

  it("enforces task authority: no late turn result, and no task opened already expired", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    expect(await codeOf(store.createTask(taskInput({ authorityExpiresAt: T0 })))).toBe("task_authority_expired");
    await store.createTask(taskInput());

    clock.set("2026-09-20T21:10:00.000Z");
    expect(await codeOf(store.transition(turnResultTransition()))).toBe("task_authority_expired");
    expect(await countRows(db, "interactive_action_refs")).toBe(0);
  });

  it("pages every active task instead of silently capping at twenty", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    for (let index = 0; index < 23; index += 1) {
      await store.createTask(taskInput({ taskId: `task_page_${index}`,
        initialEvent: { ...taskInput().initialEvent, eventId: `event_page_${index}` } }));
    }
    await store.createTask(triggeredInput());

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, limit: 10, cursor });
      seen.push(...page.tasks.map((detail) => detail.task.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(24);
    expect(new Set(seen).size).toBe(24);

    const triggered = await store.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, origin: "triggered" });
    expect(triggered.tasks.map((detail) => detail.task.id)).toEqual(["task_trig_1"]);
    expect(await codeOf(store.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, limit: 101 }))).toBe("invalid_task_input");
    expect(await codeOf(store.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, cursor: "not-a-cursor" }))).toBe("invalid_task_input");
  });
});

describe("provenance: a triggered turn is never human intent", { timeout: 60_000 }, () => {
  it("records origin, rule, keys and payload hash, and opens with a trigger event", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const created = await store.createTask(triggeredInput());

    expect(created.task).toMatchObject({
      origin: "triggered",
      surface: "agent_tasks",
      provenance: {
        triggerKey: "trigger:alert_42:cpa_over_40:2026-09-20",
        ruleId: "alert_42",
        ruleVersion: 3,
        checkKey: "check:2026-09-20T21:00",
        eventKey: "cpa_over_40:2026-09-20",
        payloadHash: H("9"),
      },
    });
    expect(created.event.kind).toBe("trigger");
    const scheduled = await store.createTask(triggeredInput({ taskId: "task_sched_1", origin: "scheduled", surface: "imessage",
      provenance: { triggerKey: "reminder:rem_7:2026-09-20T21:00", ruleId: "rem_7", ruleVersion: null, checkKey: null,
        eventKey: null, payloadHash: H("8") },
      initialEvent: { ...triggeredInput().initialEvent, eventId: "event_sched_1" } }));
    expect(scheduled.task).toMatchObject({ origin: "scheduled", provenance: { ruleId: "rem_7", ruleVersion: null } });
  });

  it("refuses to record an automatic turn as a user message, in any position", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const asUserMessage = { ...triggeredInput(), initialEvent: { ...triggeredInput().initialEvent, kind: "user_message" } };
    expect(await codeOf(store.createTask(asUserMessage as unknown as CreateAutomaticInteractiveTaskInput))).toBe("origin_violation");
    const humanAsTrigger = { ...taskInput(), initialEvent: { ...taskInput().initialEvent, kind: "trigger" } };
    expect(await codeOf(store.createTask(humanAsTrigger as unknown as CreateHumanInteractiveTaskInput))).toBe("origin_violation");
    const humanWithProvenance = { ...taskInput(), provenance: triggeredInput().provenance };
    expect(await codeOf(store.createTask(humanWithProvenance as unknown as CreateHumanInteractiveTaskInput))).toBe("origin_violation");

    await store.createTask(triggeredInput());
    expect(await codeOf(store.transition(transitionFor("task_trig_1", 1, "request_fake_human", H("3"),
      { kind: "append_event", eventKind: "user_message", payload: { text: "yes, apply it" } })))).toBe("origin_violation");
    // No transition can forge another transition's event kind.
    const forged = transitionFor("task_trig_1", 1, "request_forged", H("4"),
      { kind: "append_event", eventKind: "progress", payload: {} });
    (forged.transition as { eventKind: string }).eventKind = "approval_resolved";
    expect(await codeOf(store.transition(forged))).toBe("invalid_task_transition");
    const progress = await store.transition(transitionFor("task_trig_1", 1, "request_progress", H("5"),
      { kind: "append_event", eventKind: "progress", payload: { text: "reading stored data" } }));
    expect(progress.event.kind).toBe("progress");
  });

  it("surfaces database-only provenance rules as typed errors, never raw Postgres codes", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const provenance = triggeredInput().provenance;

    // The key must mirror the delivery identity `trigger:{alert_id}:{event_key}` (a CHECK only).
    const mismatchedKey = await store.createTask(triggeredInput({ provenance: { ...provenance, triggerKey: "trigger:alert_42:other" } }))
      .then(() => null, (error: unknown) => error);
    expect(mismatchedKey).toBeInstanceOf(InteractiveTaskConflictError);
    expect(mismatchedKey).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_triggered_provenance_check" });

    // An automatic turn never renders in the Cmd+L pane.
    const inCmdl = await store.createTask(triggeredInput({ surface: "cmdl" as unknown as "imessage" }))
      .then(() => null, (error: unknown) => error);
    expect(inCmdl).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_origin_surface_check" });

    // A triggered task without its rule version or check key is incomplete provenance.
    const noVersion = await store.createTask(triggeredInput({ provenance: { ...provenance, ruleVersion: null } }))
      .then(() => null, (error: unknown) => error);
    expect(noVersion).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_triggered_provenance_check" });

    // The value the draft probe rejected with raw 23514 is now refused before the database.
    expect(await codeOf(store.createTask(triggeredInput({ surface: "triggered" as unknown as "imessage" })))).toBe("invalid_task_input");
    expect(await countRows(db, "interactive_tasks")).toBe(0);

    // A global event id collision is typed too.
    await store.createTask(taskInput());
    expect(await codeOf(store.createTask(taskInput({ taskId: "task_2",
      initialEvent: { ...taskInput().initialEvent, requestId: "request_create_2" } })))).toBe("event_id_conflict");
  });
});
