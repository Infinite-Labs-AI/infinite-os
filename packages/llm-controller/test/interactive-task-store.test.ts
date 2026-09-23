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
  interactiveTriggerKey,
} from "../src/interactive-task-store.js";
import {
  MAX_INTERACTIVE_GRANT_MS,
  type ApplyInteractiveTaskTransitionInput,
  type CreateAutomaticInteractiveTaskInput,
  type CreateHumanInteractiveTaskInput,
  type InteractiveTaskStoreOptions,
  type InteractiveTaskTransition,
  type PreparedInteractiveActionInput,
} from "../src/interactive-task-types.js";

const WORKSPACE_A = "ws_task_a";
const WORKSPACE_B = "ws_task_b";
const ACTOR_A = "actor_a";
const H = (c: string) => c.repeat(64);
// A real alert id shape: the cloud keys triggered turns by the alert's UUID.
const ALERT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const EVENT_KEY = "meta:cpa_over:act_1234567890:2026-09-20";
const TRIGGER_KEY = `trigger:${ALERT_ID}:${EVENT_KEY}`;

// The draft's fixture window: the task was opened at 21:00 with authority until 21:10.
const T0 = "2026-09-20T21:00:00.000Z";
const at = (iso: string, plusMs: number) => new Date(Date.parse(iso) + plusMs).toISOString();

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

// A data-alert turn. The key is the cloud delivery identity of (alert id, event key).
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
      triggerKey: TRIGGER_KEY,
      ruleId: ALERT_ID,
      ruleVersion: 3,
      checkKey: null,
      eventKey: EVENT_KEY,
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
  transition: InteractiveTaskTransition, actorId = ACTOR_A): ApplyInteractiveTaskTransitionInput {
  return { taskId, workspaceId: WORKSPACE_A, actorId, expectedRevision, requestId, requestHash,
    eventId: `event_${requestId}`, transition };
}

function turnResultTransition(taskId = "task_1", actions = [preparedAction()], turnKey = "turn_1"): ApplyInteractiveTaskTransitionInput {
  return {
    ...transitionFor(taskId, 1, "request_turn_result_1", H("b"), {
      kind: "record_turn_result",
      turnKey,
      providerSessionId: "provider_session_1",
      assistantMessage: "I prepared the bounded change for approval.",
      actions,
    }),
    eventId: "event_2",
  };
}

type ApproveOptions = {
  taskId?: string; invocationId?: string; proposalHash?: string; inputHash?: string; context?: string;
  requestId?: string; decision?: "approve" | "decline"; source?: "host_confirmation" | "typed_approval";
  proposalRef?: string;
};
function approveTransition(expectedRevision: number, authorizationExpiresAt: string, options: ApproveOptions = {}) {
  return transitionFor(options.taskId ?? "task_1", expectedRevision, options.requestId ?? "request_approve", H("1"), {
    kind: "resolve_approval",
    invocationId: options.invocationId ?? "invocation_1",
    proposalRef: options.proposalRef ?? "P1",
    proposalHash: options.proposalHash ?? H("c"),
    inputHash: options.inputHash ?? H("d"),
    decision: options.decision ?? "approve",
    preparedContextRevision: options.context ?? "context_boot_1",
    authorizationExpiresAt,
    decisionProvenance: "cmdl-confirm-button",
    decisionSource: options.source ?? "host_confirmation",
  });
}

function dispatchTransition(expectedRevision: number, requestId = "request_dispatch", options: {
  taskId?: string; invocationId?: string; proposalHash?: string; inputHash?: string; context?: string; serviceResumeKey?: string;
} = {}) {
  return transitionFor(options.taskId ?? "task_1", expectedRevision, requestId, H("2"), {
    kind: "claim_dispatch",
    invocationId: options.invocationId ?? "invocation_1",
    inputHash: options.inputHash ?? H("d"),
    proposalHash: options.proposalHash ?? H("c"),
    preparedContextRevision: options.context ?? "context_boot_1",
    serviceResumeKey: options.serviceResumeKey ?? "fake-journal:invocation_1",
  });
}

function reviseTransition(expectedRevision: number, requestId: string, options: {
  taskId?: string; from?: string; fromHash?: string; to?: string; proposalHash?: string; inputHash?: string;
  operationId?: string; effect?: "read" | "local_write" | "external_write"; context?: string;
} = {}) {
  const { proposalRef: _ref, proposalRevision: _revision, ...body } = preparedAction({
    invocationId: options.to ?? "invocation_1_r2",
    proposalHash: options.proposalHash ?? H("e"),
    inputHash: options.inputHash ?? H("f"),
    operationId: options.operationId ?? "fake_update_budget",
    effect: options.effect ?? "external_write",
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

function outcomeTransition(taskId: string, expectedRevision: number, requestId: string, invocationId: string,
  state: "succeeded" | "failed" | "unknown" = "succeeded") {
  return transitionFor(taskId, expectedRevision, requestId, H("4"), {
    kind: "record_outcome", invocationId, state, receiptRef: `fake-receipt:${invocationId}`,
    outcomeSummary: "Fake budget is now USD 32.", verification: "passed",
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

async function revisionOf(store: ReturnType<typeof storeAt>, taskId: string, actorId = ACTOR_A): Promise<number> {
  const detail = await store.getTask({ taskId, workspaceId: WORKSPACE_A, actorId });
  return detail?.task.revision ?? -1;
}

/** Opens a triggered task and applies its proposal: record turn, re-prepare (Apply), approve. */
async function appliedTriggeredTask(store: ReturnType<typeof storeAt>, grantUntil = at(T0, 5 * 60_000)) {
  await store.createTask(triggeredInput());
  await store.transition(turnResultTransition("task_trig_1", [preparedAction()], TRIGGER_KEY));
  await store.transition(reviseTransition(2, "request_apply", { taskId: "task_trig_1" }));
  await store.transition(approveTransition(3, grantUntil, { taskId: "task_trig_1", invocationId: "invocation_1_r2",
    proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1" }));
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
      id: "task_1", workspaceId: WORKSPACE_A, actorId: ACTOR_A, origin: "human", surface: "cmdl",
      provenance: null, revision: 1, lastEventSequence: 1,
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
      state: "awaiting_approval", providerSessionId: "provider_session_1", revision: 2, lastEventSequence: 2,
    });
    expect(result.event).toMatchObject({ sequence: 2, kind: "assistant_message", turnKey: "turn_1" });
    expect(result.actions).toEqual([
      expect.objectContaining({
        invocationId: "invocation_1", state: "awaiting_approval", proposalRef: "P1", proposalRevision: 1,
        supersedesInvocationId: null, preparedAt: T0, preparedContextRevision: "context_boot_1",
        proposalHash: H("c"), inputHash: H("d"), serviceResumeKey: null, receiptRef: null, decisionSource: null,
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
    expect(approved.actions[0]).toMatchObject({ state: "authorized", decisionSource: "host_confirmation",
      authorizationContextRevision: "context_boot_1" });
    expect(approved.task.state).toBe("active");

    const dispatching = await store.transition(dispatchTransition(3));
    expect(dispatching.actions[0]).toMatchObject({ state: "dispatching", serviceResumeKey: "fake-journal:invocation_1" });

    expect(await codeOf(store.transition(dispatchTransition(4, "request_changed_key",
      { inputHash: H("0"), serviceResumeKey: "fake-journal:different" })))).toBe("action_identity_mismatch");

    const succeeded = await store.transition(outcomeTransition("task_1", 4, "request_outcome", "invocation_1"));
    expect(succeeded.actions[0]).toMatchObject({ state: "succeeded", receiptRef: "fake-receipt:invocation_1", continuationState: "pending" });
    expect(succeeded.task.state).toBe("active");
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

describe("trigger keys match the cloud delivery identity", { timeout: 60_000 }, () => {
  // Vectors computed by running the cloud claim's own key expression (trigger key, else a sha256 of
  // the UTF-8 event key once the raw key passes 200 characters) against ALERT_ID on Postgres.
  const eventKey = (length: number) => {
    let key = "meta:cpa_over:act_1234567890:2026-09-20:";
    while (key.length < length) key += "abcdefghijklmnopqrstuvwxyz0123456789";
    return key.slice(0, length);
  };
  const VECTORS: Array<{ name: string; eventKey: string; key: string }> = [
    { name: "155 chars (raw key, exactly 200)", eventKey: eventKey(155), key: `trigger:${ALERT_ID}:${eventKey(155)}` },
    { name: "156 chars (hashed)", eventKey: eventKey(156),
      key: `trigger:${ALERT_ID}:sha256:e8ac9fd8b62e6d9283d5e1809d679e827c4544140e621a6df4ec403d73cfa9cc` },
    { name: "200 chars", eventKey: eventKey(200),
      key: `trigger:${ALERT_ID}:sha256:79c9edeaadf1aca6e4aeb23b761309251aacbbbc4773db0cd9ec3b9f462b4955` },
    { name: "201 chars", eventKey: eventKey(201),
      key: `trigger:${ALERT_ID}:sha256:a2c461b8a55f6d3de24bac06c172cb73429cea0b4809354919f4a1d9599f3255` },
    { name: "480 chars", eventKey: eventKey(480),
      key: `trigger:${ALERT_ID}:sha256:da4c2409c581c5885c828fdc75edadfe76b77ea10aa6edfb7aad8819af3485e0` },
    { name: "500 chars (the cloud maximum)", eventKey: eventKey(500),
      key: `trigger:${ALERT_ID}:sha256:c478e0fa0c1e237ee14c1c963ab0fa30fc548f96fb88a37e6e18f8921058437e` },
    // Lengths are characters, hashes are over UTF-8 bytes.
    { name: "156 two-byte chars", eventKey: "é".repeat(156),
      key: `trigger:${ALERT_ID}:sha256:cd0393eefc2389b6c1205897aadaed3f6a6bcb0406fdf6d30b7eb3913f8d67a8` },
    { name: "155 astral chars (raw: 200 characters, 355 UTF-16 units)", eventKey: "🙂".repeat(155),
      key: `trigger:${ALERT_ID}:${"🙂".repeat(155)}` },
    { name: "156 astral chars (hashed)", eventKey: "🙂".repeat(156),
      key: `trigger:${ALERT_ID}:sha256:e4efc1bf1e38618ebcbb364838ba63c02d08b5ad52915d9c7450762bcc067337` },
  ];
  // The cloud claim's expression, verbatim apart from binding its two inputs.
  const CLOUD_KEY_SQL = `select case when char_length('trigger:' || $1::uuid::text || ':' || $2::text) > 200
    then 'trigger:' || $1::uuid::text || ':sha256:' || encode(sha256(convert_to($2::text, 'UTF8')), 'hex')
    else 'trigger:' || $1::uuid::text || ':' || $2::text end as key`;

  it("computes the same key as the cloud for every vector, and the ledger accepts only that key", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    for (const [index, vector] of VECTORS.entries()) {
      const cloud = await db.query<{ key: string }>(CLOUD_KEY_SQL, [ALERT_ID, vector.eventKey]);
      expect(cloud[0]?.key, vector.name).toBe(vector.key);
      expect(interactiveTriggerKey(ALERT_ID, vector.eventKey), vector.name).toBe(vector.key);

      const input = (taskId: string, triggerKey: string) => triggeredInput({ taskId,
        provenance: { ...triggeredInput().provenance, triggerKey, eventKey: vector.eventKey },
        initialEvent: { ...triggeredInput().initialEvent, eventId: `event_${taskId}`, requestId: `request_${taskId}` } });
      // The other form of the same pair is refused: one trigger, one identity.
      const other = vector.key.includes(":sha256:")
        ? `trigger:${ALERT_ID}:${vector.eventKey}`
        : `trigger:${ALERT_ID}:sha256:${"0".repeat(64)}`;
      const refused = await store.createTask(input(`task_vec_bad_${index}`, other)).then(() => null, (error: unknown) => error);
      expect(refused, vector.name).toMatchObject({ code: "invalid_task_input" });
      const created = await store.createTask(input(`task_vec_${index}`, vector.key));
      expect(created.task.provenance?.triggerKey, vector.name).toBe(vector.key);
    }
  });

  it("refuses a triggered key built from a non-canonical alert id", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const upper = ALERT_ID.toUpperCase();
    const refused = await store.createTask(triggeredInput({ provenance: { ...triggeredInput().provenance,
      ruleId: upper, triggerKey: `trigger:${upper}:${EVENT_KEY}` } })).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_triggered_provenance_check" });
  });

  it("accepts any cloud event key text: spaces, punctuation and non-ASCII", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const spaced = "CPA over $40 — ad set “Spring sale”";
    const created = await store.createTask(triggeredInput({ provenance: { ...triggeredInput().provenance,
      eventKey: spaced, triggerKey: interactiveTriggerKey(ALERT_ID, spaced) } }));
    expect(created.task.provenance).toMatchObject({ eventKey: spaced, checkKey: null });
  });
});

describe("trigger-keyed proposals", { timeout: 60_000 }, () => {
  it("maps a retried automatic create to the task its trigger key already opened", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const created = await store.createTask(triggeredInput());

    // A redelivered turn runs again: new task id, request id, event id and hash, same key.
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

  it("refuses a same-key create whose provenance differs instead of silently replaying", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(triggeredInput());
    const retry = (suffix: string, change: Partial<CreateAutomaticInteractiveTaskInput>) => store.createTask(triggeredInput({
      taskId: `task_trig_${suffix}`, ...change,
      initialEvent: { ...triggeredInput().initialEvent, eventId: `event_${suffix}`, requestId: `request_${suffix}` } }));
    const provenance = triggeredInput().provenance;
    expect(await codeOf(retry("hash", { provenance: { ...provenance, payloadHash: H("8") } }))).toBe("trigger_key_conflict");
    expect(await codeOf(retry("version", { provenance: { ...provenance, ruleVersion: 4 } }))).toBe("trigger_key_conflict");
    expect(await codeOf(retry("origin", { origin: "scheduled" }))).toBe("trigger_key_conflict");
    expect(await codeOf(retry("surface", { surface: "imessage" }))).toBe("trigger_key_conflict");
    expect(await countRows(db, "interactive_tasks")).toBe(1);
  });

  it("maps every retried opening-turn shape to the existing proposal, never a second live one", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(triggeredInput());
    // A progress event first, so a replay that picks "any later event" would return the wrong one.
    await store.transition(transitionFor("task_trig_1", 1, "request_progress", H("6"),
      { kind: "append_event", eventKind: "progress", payload: { text: "reading stored data" } }));
    const first = await store.transition({ ...turnResultTransition("task_trig_1", [preparedAction()], TRIGGER_KEY),
      expectedRevision: 2 });
    expect(first.replayed).toBe(false);
    expect(first.event).toMatchObject({ kind: "assistant_message", turnKey: TRIGGER_KEY });

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
      const retried = await store.transition(transitionFor("task_trig_1", 1, `request_retry_${index}`, H(String(index + 3)),
        { kind: "record_turn_result", turnKey: TRIGGER_KEY, assistantMessage: `retried output ${index}`, actions: [action] }));
      expect(retried.replayed).toBe(true);
      expect(retried.event).toEqual(first.event);
      expect(retried.actions).toEqual(first.actions);
    }

    expect(await countRows(db, "interactive_action_refs", "task_trig_1")).toBe(1);
    const events = await store.listEvents({ taskId: "task_trig_1", workspaceId: WORKSPACE_A, actorId: ACTOR_A });
    expect(events.map((event) => event.kind)).toEqual(["trigger", "progress", "assistant_message"]);
    expect(await revisionOf(store, "task_trig_1")).toBe(3);

    // The opening turn of an automatic task must use the trigger key, so no retry can dodge it.
    const { db: db2 } = await fixture();
    const store2 = storeAt(db2);
    await store2.createTask(triggeredInput());
    expect(await codeOf(store2.transition(turnResultTransition("task_trig_1", [preparedAction()], "turn_random_1"))))
      .toBe("invalid_task_input");
  });

  it("records a later turn (the continuation reply) instead of swallowing it as a replay", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    await appliedTriggeredTask(store);
    await store.transition(dispatchTransition(4, "request_dispatch_r2", { taskId: "task_trig_1", invocationId: "invocation_1_r2",
      proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1" }));
    await store.transition(outcomeTransition("task_trig_1", 5, "request_outcome_r2", "invocation_1_r2"));
    await store.transition(transitionFor("task_trig_1", 6, "request_claim_cont", H("5"),
      { kind: "claim_continuation", invocationId: "invocation_1_r2", continuationKey: "continuation:invocation_1" }));

    // Long after the task's own authority: the reply carries no actions, so it is recorded.
    clock.set("2026-09-27T09:00:00.000Z");
    const reply = await store.transition(transitionFor("task_trig_1", 7, "request_cont_reply", H("6"), {
      kind: "record_turn_result", turnKey: "continuation:invocation_1", assistantMessage: "Budget updated and verified.", actions: [] }));
    expect(reply.replayed).toBe(false);
    expect(reply.event).toMatchObject({ kind: "assistant_message", turnKey: "continuation:invocation_1",
      payload: { text: "Budget updated and verified." } });
    expect(reply.task.state).toBe("active");

    // A retry of that continuation turn maps to its own recorded reply.
    const retried = await store.transition(transitionFor("task_trig_1", 7, "request_cont_reply_retry", H("7"), {
      kind: "record_turn_result", turnKey: "continuation:invocation_1", assistantMessage: "Different text.", actions: [] }));
    expect(retried).toMatchObject({ replayed: true, event: { eventId: reply.event.eventId } });

    const done = await store.transition(transitionFor("task_trig_1", 8, "request_finish_cont", H("8"),
      { kind: "finish_continuation", invocationId: "invocation_1_r2", continuationKey: "continuation:invocation_1", state: "completed" }));
    expect(done.task.state).toBe("completed");
  });

  it("types the same retry shapes on a human task instead of leaking Postgres errors", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    const retry = (index: number, action: PreparedInteractiveActionInput) => store.transition(transitionFor("task_1", 2,
      `request_human_retry_${index}`, H(String(index + 3)), { kind: "record_turn_result", turnKey: `turn_${index + 2}`,
        assistantMessage: "again", actions: [action] }));
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

    expect(await codeOf(store.transition(approveTransition(2, at(T0, MAX_INTERACTIVE_GRANT_MS + 1), { requestId: "request_too_long" })))).toBe("invalid_grant");
    expect(await codeOf(store.transition(approveTransition(2, T0, { requestId: "request_already_past" })))).toBe("invalid_grant");
    const exactlyTen = at(T0, MAX_INTERACTIVE_GRANT_MS);
    const approved = await store.transition(approveTransition(2, exactlyTen));
    expect(approved.actions[0]).toMatchObject({ state: "authorized", authorizationExpiresAt: exactlyTen });

    // A deployment may shorten the ceiling, never lengthen it.
    expect(() => createInteractiveTaskStore(db, { maxGrantMs: MAX_INTERACTIVE_GRANT_MS + 1 })).toThrow(RangeError);
    const shortStore = storeAt(db, clock, { maxGrantMs: 60_000 });
    await shortStore.createTask(taskInput({ taskId: "task_short", initialEvent: { ...taskInput().initialEvent, eventId: "event_short" } }));
    await shortStore.transition({ ...turnResultTransition("task_short",
      [preparedAction({ invocationId: "invocation_short", continuationKey: undefined })]), eventId: "event_short_turn" });
    expect(await codeOf(shortStore.transition(approveTransition(2, at(T0, 60_001),
      { taskId: "task_short", invocationId: "invocation_short", requestId: "request_short" })))).toBe("invalid_grant");
  });

  it("requires a re-prepare before approving a stale or never-re-prepared proposal", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    // Approval binds to the prepared context; a different one is refused and nothing is rebound.
    expect(await codeOf(store.transition(approveTransition(2, at(T0, 60_000), { context: "any_context_i_like",
      requestId: "request_other_context" })))).toBe("action_identity_mismatch");

    // A human proposal is approvable only while its preparation is fresh (the grant window).
    clock.set(at(T0, MAX_INTERACTIVE_GRANT_MS + 1));
    expect(await codeOf(store.transition(approveTransition(2, at(T0, MAX_INTERACTIVE_GRANT_MS + 60_000),
      { requestId: "request_stale" })))).toBe("reprepare_required");
    clock.set(at(T0, MAX_INTERACTIVE_GRANT_MS));
    const fresh = await store.transition(approveTransition(2, at(T0, MAX_INTERACTIVE_GRANT_MS + 60_000), { requestId: "request_fresh" }));
    expect(fresh.actions[0]).toMatchObject({ state: "authorized", preparedContextRevision: "context_boot_1" });

    // An automatic turn's own proposal is never authority, even a second after it was prepared.
    const { db: db2 } = await fixture();
    const store2 = storeAt(db2, fixedClock(T0));
    await store2.createTask(triggeredInput());
    await store2.transition(turnResultTransition("task_trig_1", [preparedAction()], TRIGGER_KEY));
    expect(await codeOf(store2.transition(approveTransition(2, at(T0, 60_000), { taskId: "task_trig_1",
      context: "context_trigger_1" })))).toBe("reprepare_required");

    // Seven days later, Apply re-prepares and the fresh revision can be approved and dispatched.
    const later = fixedClock("2026-09-27T21:00:00.000Z");
    const store3 = storeAt(db2, later);
    await store3.transition(reviseTransition(2, "request_apply_late", { taskId: "task_trig_1" }));
    await store3.transition(approveTransition(3, "2026-09-27T21:05:00.000Z", { taskId: "task_trig_1", requestId: "request_approve_late",
      invocationId: "invocation_1_r2", proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1" }));
    const dispatched = await store3.transition(dispatchTransition(4, "request_dispatch_late", { taskId: "task_trig_1",
      invocationId: "invocation_1_r2", proposalHash: H("e"), inputHash: H("f"), context: "context_apply_1" }));
    expect(dispatched.actions.find((action) => action.invocationId === "invocation_1_r2")?.state).toBe("dispatching");
  });

  it("expires a lapsed grant, then Apply re-prepares a fresh revision that supersedes it", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());
    await store.transition(approveTransition(2, "2026-09-20T21:10:00.000Z"));

    // The grant lapses at its expiry instant, not one millisecond before.
    clock.set(at("2026-09-20T21:10:00.000Z", -1));
    expect(await codeOf(store.transition(transitionFor("task_1", 3, "request_expire_early", H("3"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "lapsed" })))).toBe("action_state_conflict");
    clock.set("2026-09-20T21:10:00.000Z");
    expect(await codeOf(store.transition(dispatchTransition(3)))).toBe("action_authority_expired");
    const expired = await store.transition(transitionFor("task_1", 3, "request_expire", H("3"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "lapsed" }));
    expect(expired.actions[0]).toMatchObject({ state: "expired" });
    expect(expired.task.state).toBe("awaiting_approval");
    expect(expired.event.kind).toBe("authorization_expired");
    // An expired grant can neither be dispatched nor approved again as-is.
    clock.set("2026-09-21T09:00:00.000Z");
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
        supersedesInvocationId: "invocation_1", proposalHash: H("e"), inputHash: H("f"), preparedAt: "2026-09-21T09:00:00.000Z",
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

  it("ends a live grant early on host restart and lists what a restarted host must settle", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    // Two actors in one workspace, each with an authorized grant, plus one dispatch in flight.
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());
    await store.transition(approveTransition(2, at(T0, 9 * 60_000)));
    await store.createTask(taskInput({ taskId: "task_b", actorId: "actor_b",
      initialEvent: { ...taskInput().initialEvent, eventId: "event_b1" } }));
    await store.transition({ ...turnResultTransition("task_b", [preparedAction({ invocationId: "invocation_b", continuationKey: undefined })]),
      actorId: "actor_b", eventId: "event_b2" });
    const approveB = { ...approveTransition(2, at(T0, 9 * 60_000), { taskId: "task_b", invocationId: "invocation_b", requestId: "request_approve_b" }), actorId: "actor_b" };
    await store.transition(approveB);
    await store.createTask(taskInput({ taskId: "task_c", initialEvent: { ...taskInput().initialEvent, eventId: "event_c1" } }));
    await store.transition({ ...turnResultTransition("task_c", [preparedAction({ invocationId: "invocation_c", continuationKey: undefined })]), eventId: "event_c2" });
    await store.transition(approveTransition(2, at(T0, 9 * 60_000), { taskId: "task_c", invocationId: "invocation_c", requestId: "request_approve_c" }));
    await store.transition(dispatchTransition(3, "request_dispatch_c", { taskId: "task_c", invocationId: "invocation_c" }));

    const authorized = await store.listRecoverableActions({ workspaceId: WORKSPACE_A, states: ["authorized"] });
    expect(authorized.actions.map((action) => [action.actorId, action.invocationId]).sort()).toEqual([
      ["actor_a", "invocation_1"], ["actor_b", "invocation_b"]]);
    const paged = await store.listRecoverableActions({ workspaceId: WORKSPACE_A, limit: 2 });
    const rest = await store.listRecoverableActions({ workspaceId: WORKSPACE_A, limit: 2, cursor: paged.nextCursor ?? undefined });
    expect([...paged.actions, ...rest.actions].map((action) => action.invocationId).sort())
      .toEqual(["invocation_1", "invocation_b", "invocation_c"]);
    expect(rest.nextCursor).toBeNull();
    expect((await store.listRecoverableActions({ workspaceId: WORKSPACE_B })).actions).toEqual([]);

    for (const action of authorized.actions) {
      const expired = await store.transition(transitionFor(action.taskId, await revisionOf(store, action.taskId, action.actorId),
        `request_restart_${action.invocationId}`, H("3"), { kind: "expire_authorization", invocationId: action.invocationId,
          reason: "host_restart" }, action.actorId));
      expect(expired.actions.find((row) => row.invocationId === action.invocationId)?.state).toBe("expired");
    }
    expect((await store.listRecoverableActions({ workspaceId: WORKSPACE_A, states: ["authorized"] })).actions).toEqual([]);
    // Only an authorized action has a grant to end.
    expect(await codeOf(store.transition(transitionFor("task_1", 4, "request_restart_again", H("4"),
      { kind: "expire_authorization", invocationId: "invocation_1", reason: "host_restart" })))).toBe("action_state_conflict");
    expect(await codeOf(store.listRecoverableActions({ workspaceId: WORKSPACE_A, states: ["succeeded" as "authorized"] })))
      .toBe("invalid_task_input");
  });

  it("re-prepares an unapproved or live-authorized proposal and refuses terminal or mismatched ones", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    // A revision may not swap the operation or its effect, and it must name the revision it replaces.
    expect(await codeOf(store.transition(reviseTransition(2, "request_other_op", { operationId: "fake_delete_campaign" }))))
      .toBe("action_identity_mismatch");
    expect(await codeOf(store.transition(reviseTransition(2, "request_other_effect", { effect: "local_write" }))))
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
    await store.transition(approveTransition(5, T0, { invocationId: "invocation_1_r3", proposalHash: H("8"),
      inputHash: H("f"), context: "context_apply_1", requestId: "request_decline", decision: "decline" }));
    expect(await codeOf(store.transition(reviseTransition(6, "request_revive", {
      from: "invocation_1_r3", fromHash: H("8"), to: "invocation_1_r4" })))).toBe("action_state_conflict");
  });

  it("lets Cancel reject an authorized or an expired proposal on its own, for good", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition("task_1", [preparedAction(),
      preparedAction({ invocationId: "invocation_2", proposalRef: "P2", proposalHash: H("5"), continuationKey: undefined })]));
    await store.transition(approveTransition(2, at(T0, 5 * 60_000)));

    const reject = (revision: number, requestId: string, invocationId: string, proposalHash: string) =>
      store.transition(transitionFor("task_1", revision, requestId, H("3"), { kind: "reject_proposal", invocationId, proposalHash,
        decisionProvenance: "board-cancel", decisionSource: "host_confirmation" }));
    expect(await codeOf(reject(3, "request_reject_wrong", "invocation_1", H("0")))).toBe("action_identity_mismatch");
    const rejected = await reject(3, "request_reject_authorized", "invocation_1", H("c"));
    expect(rejected.actions.find((action) => action.invocationId === "invocation_1")).toMatchObject({ state: "declined",
      decisionSource: "host_confirmation" });
    expect(rejected.event.kind).toBe("proposal_rejected");
    // P2 is still live, so the task is not complete.
    expect(rejected.task.state).toBe("awaiting_approval");
    expect(await codeOf(store.transition(dispatchTransition(4, "request_dispatch_rejected")))).toBe("action_state_conflict");
    expect(await codeOf(store.transition(reviseTransition(4, "request_revive_rejected")))).toBe("action_state_conflict");

    // An expired grant can be rejected too.
    await store.transition(approveTransition(4, at(T0, 60_000), { invocationId: "invocation_2", proposalRef: "P2",
      proposalHash: H("5"), requestId: "request_approve_p2" }));
    await store.transition(transitionFor("task_1", 5, "request_restart_p2", H("4"),
      { kind: "expire_authorization", invocationId: "invocation_2", reason: "host_restart" }));
    const rejectedExpired = await reject(6, "request_reject_expired", "invocation_2", H("5"));
    expect(rejectedExpired.actions.find((action) => action.invocationId === "invocation_2")?.state).toBe("declined");
    expect(rejectedExpired.task.state).toBe("completed");
  });

  it("keeps a task open while any proposal is live, and lists live proposals across tasks", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition("task_1", [preparedAction(),
      preparedAction({ invocationId: "invocation_2", proposalRef: "P2", proposalHash: H("5"), continuationKey: undefined })]));
    await store.createTask(triggeredInput());
    await store.transition({ ...turnResultTransition("task_trig_1", [preparedAction({ invocationId: "invocation_t1", continuationKey: undefined })],
      TRIGGER_KEY), eventId: "event_trig_turn" });

    // Declining P1 must not complete a task whose P2 still waits.
    const declined = await store.transition(approveTransition(2, T0, { decision: "decline", requestId: "request_decline_p1" }));
    expect(declined.task.state).toBe("awaiting_approval");
    expect((await store.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A })).tasks.map((detail) => detail.task.id).sort())
      .toEqual(["task_1", "task_trig_1"]);

    const live = await store.listLiveProposals({ workspaceId: WORKSPACE_A, actorId: ACTOR_A });
    expect(live.proposals.map((proposal) => [proposal.task.id, proposal.action.invocationId]).sort()).toEqual([
      ["task_1", "invocation_2"], ["task_trig_1", "invocation_t1"]]);
    const triggered = await store.listLiveProposals({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, origin: "triggered" });
    expect(triggered.proposals.map((proposal) => proposal.task.provenance?.triggerKey)).toEqual([TRIGGER_KEY]);
    const first = await store.listLiveProposals({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, limit: 1 });
    const second = await store.listLiveProposals({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, limit: 1, cursor: first.nextCursor ?? undefined });
    expect([...first.proposals, ...second.proposals].map((proposal) => proposal.action.invocationId).sort())
      .toEqual(["invocation_2", "invocation_t1"]);
    expect(second.nextCursor).toBeNull();
    expect((await store.listLiveProposals({ workspaceId: WORKSPACE_A, actorId: "actor_b" })).proposals).toEqual([]);
  });

  it("records a slow human turn's reply but not new proposals after its authority", async () => {
    const { db } = await fixture();
    const clock = fixedClock(T0);
    const store = storeAt(db, clock);
    expect(await codeOf(store.createTask(taskInput({ authorityExpiresAt: T0 })))).toBe("task_authority_expired");
    await store.createTask(taskInput());

    clock.set("2026-09-20T21:10:30.000Z");
    expect(await codeOf(store.transition(turnResultTransition()))).toBe("task_authority_expired");
    expect(await countRows(db, "interactive_action_refs")).toBe(0);
    const reply = await store.transition({ ...turnResultTransition("task_1", []), requestId: "request_slow_reply" });
    expect(reply.event).toMatchObject({ kind: "assistant_message", payload: { text: "I prepared the bounded change for approval." } });
    expect(reply.task.state).toBe("completed");
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

describe("cancellation stops remaining work", { timeout: 60_000 }, () => {
  it("never reopens a cancelled task, but still records an effect already in flight", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition("task_1", [preparedAction(),
      preparedAction({ invocationId: "invocation_2", proposalRef: "P2", proposalHash: H("5"), continuationKey: undefined })]));
    await store.transition(approveTransition(2, at(T0, 5 * 60_000)));
    await store.transition(dispatchTransition(3));
    // P2's grant lapsed before cancel: cancel must retire it as well, so Apply cannot revive it.
    await store.transition(approveTransition(4, at(T0, 60_000), { invocationId: "invocation_2", proposalRef: "P2",
      proposalHash: H("5"), requestId: "request_approve_p2" }));
    await store.transition(transitionFor("task_1", 5, "request_restart_p2", H("4"),
      { kind: "expire_authorization", invocationId: "invocation_2", reason: "host_restart" }));
    const cancelled = await store.transition(transitionFor("task_1", 6, "request_cancel", H("5"), { kind: "cancel_task", reason: "user_requested" }));
    expect(cancelled.actions.map((action) => [action.invocationId, action.state])).toEqual([
      ["invocation_1", "dispatching"], ["invocation_2", "cancelled"]]);

    // A late turn result, a revise, an approval or a continuation cannot reopen it.
    expect(await codeOf(store.transition(transitionFor("task_1", 7, "request_late_turn", H("6"), { kind: "record_turn_result",
      turnKey: "turn_late", assistantMessage: "late", actions: [preparedAction({ invocationId: "invocation_3", proposalRef: "P3",
        continuationKey: undefined })] })))).toBe("task_closed");
    expect(await codeOf(store.transition(reviseTransition(7, "request_revise_cancelled", { from: "invocation_2", fromHash: H("5") }))))
      .toBe("task_closed");
    expect(await codeOf(store.transition(transitionFor("task_1", 7, "request_msg_cancelled", H("7"),
      { kind: "append_event", eventKind: "user_message", payload: { text: "also do this" } })))).toBe("task_closed");

    // The dispatched effect is still recorded, the task stays cancelled, and no continuation is due.
    const outcome = await store.transition(outcomeTransition("task_1", 7, "request_outcome_after_cancel", "invocation_1"));
    expect(outcome.task.state).toBe("cancelled");
    expect(outcome.actions[0]).toMatchObject({ state: "succeeded", continuationState: "not_required" });
    expect(await codeOf(store.transition(transitionFor("task_1", 8, "request_claim_after_cancel", H("8"),
      { kind: "claim_continuation", invocationId: "invocation_1", continuationKey: "continuation:invocation_1" })))).toBe("task_closed");
  });
});

describe("provenance: an automatic turn is never human intent", { timeout: 60_000 }, () => {
  it("records origin, rule, keys and payload hash, and opens with a trigger event", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const created = await store.createTask(triggeredInput({ provenance: { ...triggeredInput().provenance, checkKey: "check:2026-09-20T21:00" } }));

    expect(created.task).toMatchObject({
      origin: "triggered", surface: "agent_tasks",
      provenance: { triggerKey: TRIGGER_KEY, ruleId: ALERT_ID, ruleVersion: 3, checkKey: "check:2026-09-20T21:00",
        eventKey: EVENT_KEY, payloadHash: H("9") },
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
    const forged = transitionFor("task_trig_1", 1, "request_forged", H("4"), { kind: "append_event", eventKind: "progress", payload: {} });
    (forged.transition as { eventKind: string }).eventKind = "approval_resolved";
    expect(await codeOf(store.transition(forged))).toBe("invalid_task_transition");
    const progress = await store.transition(transitionFor("task_trig_1", 1, "request_progress", H("5"),
      { kind: "append_event", eventKind: "progress", payload: { text: "reading stored data" } }));
    expect(progress.event.kind).toBe("progress");
  });

  it("approves a terminal task only through a typed approval", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const created = await store.createTask(taskInput({ surface: "terminal", clientSurfaceKey: "cli:tty1" }));
    expect(created.task).toMatchObject({ origin: "human", surface: "terminal" });
    await store.transition(turnResultTransition());

    expect(await codeOf(store.transition(approveTransition(2, at(T0, 60_000), { requestId: "request_button" }))))
      .toBe("typed_approval_required");
    const typed = await store.transition(approveTransition(2, at(T0, 60_000), { source: "typed_approval" }));
    expect(typed.actions[0]).toMatchObject({ state: "authorized", decisionSource: "typed_approval" });
    // Automatic turns never render on the terminal.
    expect(await codeOf(store.createTask(triggeredInput({ surface: "terminal" as unknown as "imessage" })))).toBe("invalid_task_input");
  });

  it("surfaces database-only rules and data errors as typed errors, never raw Postgres codes", async () => {
    const { db } = await fixture();
    const store = storeAt(db);
    const provenance = triggeredInput().provenance;

    // The key must be the cloud identity of (alert id, event key) (a CHECK only).
    const mismatchedKey = await store.createTask(triggeredInput({ provenance: { ...provenance, triggerKey: `trigger:${ALERT_ID}:other` } }))
      .then(() => null, (error: unknown) => error);
    expect(mismatchedKey).toBeInstanceOf(InteractiveTaskConflictError);
    expect(mismatchedKey).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_triggered_provenance_check" });
    // An automatic turn never renders in Cmd+L.
    const inCmdl = await store.createTask(triggeredInput({ surface: "cmdl" as unknown as "imessage" })).then(() => null, (error: unknown) => error);
    expect(inCmdl).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_origin_surface_check" });
    // A triggered task without its rule version is incomplete provenance.
    const noVersion = await store.createTask(triggeredInput({ provenance: { ...provenance, ruleVersion: null } })).then(() => null, (error: unknown) => error);
    expect(noVersion).toMatchObject({ code: "invalid_task_input", constraint: "interactive_tasks_triggered_provenance_check" });
    // An integer the database cannot hold is a data exception (class 22), typed too.
    expect(await codeOf(store.createTask(triggeredInput({ provenance: { ...provenance, ruleVersion: 2 ** 40 } })))).toBe("invalid_task_input");
    // Values rejected before the database.
    expect(await codeOf(store.createTask(triggeredInput({ surface: "triggered" as unknown as "imessage" })))).toBe("invalid_task_input");
    // NUL is refused by the store itself, before any SQL runs (the class-22 mapping is only a backstop).
    await expect(store.createTask(taskInput({ providerId: "claude\u0000cli" })))
      .rejects.toMatchObject({ code: "invalid_task_input", message: "text is invalid.", constraint: undefined });
    await expect(store.createTask(taskInput({ initialEvent: { ...taskInput().initialEvent, payload: { text: "a\u0000b" } } })))
      .rejects.toMatchObject({ code: "invalid_task_input", message: "text is invalid." });
    expect(await countRows(db, "interactive_tasks")).toBe(0);

    // A date Date.parse accepts but Postgres would not is normalised before binding.
    const created = await store.createTask(taskInput({ authorityExpiresAt: "Sun Sep 20 2026 22:10:00 GMT+0100 (British Summer Time)" }));
    expect(created.task.authorityExpiresAt).toBe("2026-09-20T21:10:00.000Z");
    await expect(store.transition(transitionFor("task_1", 1, "request_nul_reply", H("3"), { kind: "record_turn_result",
      turnKey: "turn_nul", assistantMessage: "bad\u0000reply", actions: [] })))
      .rejects.toMatchObject({ code: "invalid_task_input", message: "text is invalid." });
    // A cursor carries only Postgres timestamp text; anything else is refused before SQL.
    const forgedCursor = Buffer.from(JSON.stringify(["Tue Sep 30 2030 10:00:00 GMT+0100 (British Summer Time)", "task_1"])).toString("base64url");
    await expect(store.listActiveTasks({ workspaceId: WORKSPACE_A, actorId: ACTOR_A, cursor: forgedCursor }))
      .rejects.toMatchObject({ code: "invalid_task_input", message: "cursor is invalid." });

    // A global event id collision is typed too.
    expect(await codeOf(store.createTask(taskInput({ taskId: "task_2",
      initialEvent: { ...taskInput().initialEvent, requestId: "request_create_2" } })))).toBe("event_id_conflict");
  });
});
