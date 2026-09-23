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

const WORKSPACE_A = "ws_task_a";
const WORKSPACE_B = "ws_task_b";
const ACTOR_A = "actor_a";

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

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task_1",
    workspaceId: WORKSPACE_A,
    actorId: ACTOR_A,
    surface: "cmdl" as const,
    clientSurfaceKey: "cmdl:primary",
    providerId: "claude-cli",
    modelId: "claude-opus-4-8",
    agentProfile: "general-marketing-v1" as const,
    acceptedContextRevision: "context_boot_1",
    authorityExpiresAt: "2026-09-20T21:10:00.000Z",
    context: { activeSurfaceId: "marketing" },
    initialEvent: {
      eventId: "event_1",
      requestId: "request_create_1",
      requestHash: "a".repeat(64),
      kind: "user_message" as const,
      payload: { text: "Prepare a safe fake write." },
    },
    ...overrides,
  };
}

function turnResultTransition() {
  return {
    taskId: "task_1",
    workspaceId: WORKSPACE_A,
    actorId: ACTOR_A,
    expectedRevision: 1,
    requestId: "request_turn_result_1",
    requestHash: "b".repeat(64),
    eventId: "event_2",
    transition: {
      kind: "record_turn_result" as const,
      providerSessionId: "provider_session_1",
      assistantMessage: "I prepared the bounded change for approval.",
      actions: [
        {
          invocationId: "invocation_1",
          sourceKind: "host_confirmation" as const,
          sourceRef: "historical-confirmation-ref",
          operationId: "fake_update_budget",
          adapterVersion: "fake.v1",
          schemaVersion: "1",
          proposalRef: "P1",
          proposalRevision: 1,
          proposalHash: "c".repeat(64),
          proposal: {
            title: "Update fake campaign budget",
            target: "Alpha",
            summary: "Change the fake daily budget to USD 30.",
          } as Record<string, unknown>,
          inputHash: "d".repeat(64),
          effect: "external_write" as const,
          replayPolicy: "reconcile_before_retry" as const,
          continuationKey: "continuation:invocation_1",
        },
      ],
    },
  };
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

function approveTransition(expectedRevision: number, authorizationExpiresAt: string) {
  return {
    taskId: "task_1",
    workspaceId: WORKSPACE_A,
    actorId: ACTOR_A,
    expectedRevision,
    requestId: "request_approve",
    requestHash: "1".repeat(64),
    eventId: "event_approve",
    transition: {
      kind: "resolve_approval" as const,
      invocationId: "invocation_1",
      proposalRef: "P1",
      proposalHash: "c".repeat(64),
      inputHash: "d".repeat(64),
      decision: "approve" as const,
      preparedContextRevision: "context_boot_1",
      authorizationExpiresAt,
      decisionProvenance: "cmdl-confirm-button",
    },
  };
}

function dispatchTransition(expectedRevision: number, requestId = "request_dispatch") {
  return {
    taskId: "task_1",
    workspaceId: WORKSPACE_A,
    actorId: ACTOR_A,
    expectedRevision,
    requestId,
    requestHash: "2".repeat(64),
    eventId: `event_${requestId}`,
    transition: {
      kind: "claim_dispatch" as const,
      invocationId: "invocation_1",
      inputHash: "d".repeat(64),
      proposalHash: "c".repeat(64),
      preparedContextRevision: "context_boot_1",
      serviceResumeKey: "fake-journal:invocation_1",
    },
  };
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const item = fixtures.pop()!;
    await item.db.close();
    rmSync(item.dataDir, { recursive: true, force: true });
  }
});

describe("interactive task store", () => {
  it("persists a scoped task and replays an identical create request", async () => {
    const { db } = await fixture();
    const store = createInteractiveTaskStore(db);

    const created = await store.createTask(taskInput());
    const replayed = await store.createTask(taskInput());

    expect(created.replayed).toBe(false);
    expect(created.task).toMatchObject({
      id: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      revision: 1,
      lastEventSequence: 1,
    });
    expect(replayed).toEqual({ ...created, replayed: true });
    await expect(store.getTask({
      taskId: "task_1",
      workspaceId: WORKSPACE_B,
      actorId: ACTOR_A,
    })).resolves.toBeNull();
    await expect(store.getTask({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: "actor_b",
    })).resolves.toBeNull();
  });

  it("atomically records the final assistant event and pending action refs", async () => {
    const { db } = await fixture();
    const store = createInteractiveTaskStore(db);
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
        proposalHash: "c".repeat(64),
        inputHash: "d".repeat(64),
        serviceResumeKey: null,
        receiptRef: null,
      }),
    ]);
  });

  it("deduplicates the same transition and rejects request-id reuse or stale CAS", async () => {
    const { db } = await fixture();
    const store = createInteractiveTaskStore(db);
    await store.createTask(taskInput());

    const first = await store.transition(turnResultTransition());
    const replayed = await store.transition(turnResultTransition());
    expect(replayed).toEqual({ ...first, replayed: true });

    await expect(store.transition({
      ...turnResultTransition(),
      requestHash: "e".repeat(64),
    })).rejects.toMatchObject({ code: "transition_request_conflict" });

    await expect(store.transition({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      expectedRevision: 1,
      requestId: "request_stale",
      requestHash: "f".repeat(64),
      eventId: "event_stale",
      transition: { kind: "append_event", eventKind: "progress", payload: { text: "late" } },
    })).rejects.toBeInstanceOf(InteractiveTaskConflictError);
  });

  it("keeps input and service resume keys immutable across approval, dispatch, and outcome", async () => {
    const { db } = await fixture();
    // Inside the approval window (expires 21:09), whatever today's wall-clock date is.
    const store = createInteractiveTaskStore(db, { now: fixedClock("2026-09-20T21:05:00.000Z").now });
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    const approved = await store.transition({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      expectedRevision: 2,
      requestId: "request_approve",
      requestHash: "1".repeat(64),
      eventId: "event_approve",
      transition: {
        kind: "resolve_approval",
        invocationId: "invocation_1",
        proposalRef: "P1",
        proposalHash: "c".repeat(64),
        inputHash: "d".repeat(64),
        decision: "approve",
        preparedContextRevision: "context_boot_1",
        authorizationExpiresAt: "2026-09-20T21:09:00.000Z",
        decisionProvenance: "cmdl-confirm-button",
      },
    });
    expect(approved.actions[0]).toMatchObject({ state: "authorized" });

    const dispatching = await store.transition({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      expectedRevision: 3,
      requestId: "request_dispatch",
      requestHash: "2".repeat(64),
      eventId: "event_dispatch",
      transition: {
        kind: "claim_dispatch",
        invocationId: "invocation_1",
        inputHash: "d".repeat(64),
        proposalHash: "c".repeat(64),
        preparedContextRevision: "context_boot_1",
        serviceResumeKey: "fake-journal:invocation_1",
      },
    });
    expect(dispatching.actions[0]).toMatchObject({
      state: "dispatching",
      serviceResumeKey: "fake-journal:invocation_1",
    });

    await expect(store.transition({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      expectedRevision: 4,
      requestId: "request_changed_key",
      requestHash: "3".repeat(64),
      eventId: "event_changed_key",
      transition: {
        kind: "claim_dispatch",
        invocationId: "invocation_1",
        inputHash: "0".repeat(64),
        proposalHash: "c".repeat(64),
        preparedContextRevision: "context_boot_1",
        serviceResumeKey: "fake-journal:different",
      },
    })).rejects.toMatchObject({ code: "action_identity_mismatch" });

    const succeeded = await store.transition({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      expectedRevision: 4,
      requestId: "request_outcome",
      requestHash: "4".repeat(64),
      eventId: "event_outcome",
      transition: {
        kind: "record_outcome",
        invocationId: "invocation_1",
        state: "succeeded",
        receiptRef: "fake-receipt:1",
        outcomeSummary: "Fake budget is now USD 30.",
        verification: "passed",
      },
    });
    expect(succeeded.actions[0]).toMatchObject({
      state: "succeeded",
      receiptRef: "fake-receipt:1",
      continuationState: "pending",
    });
  });

  it("expires dispatch authority by the injected clock, not the wall clock", async () => {
    const { db } = await fixture();
    // Dates far in the wall-clock future: only the injected clock can make this grant expire.
    const clock = fixedClock("2030-01-01T00:00:00.000Z");
    const store = createInteractiveTaskStore(db, { now: clock.now });
    await store.createTask(taskInput({ authorityExpiresAt: "2030-01-01T00:15:00.000Z" }));
    await store.transition(turnResultTransition());
    await store.transition(approveTransition(2, "2030-01-01T00:10:00.000Z"));

    // The grant ends AT its expiry instant; a restored or delayed dispatch cannot use it.
    clock.set("2030-01-01T00:10:00.000Z");
    await expect(store.transition(dispatchTransition(3))).rejects.toMatchObject({
      code: "action_authority_expired",
    });
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
    const store = createInteractiveTaskStore(db);
    await store.createTask(taskInput());
    await store.transition(turnResultTransition());

    await db.query(
      "update interactive_action_refs set state = 'dispatching' where invocation_id = $1",
      ["invocation_1"],
    );
    const cancelled = await store.transition({
      taskId: "task_1",
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      expectedRevision: 2,
      requestId: "request_cancel",
      requestHash: "5".repeat(64),
      eventId: "event_cancel",
      transition: { kind: "cancel_task", reason: "user_requested" },
    });

    expect(cancelled.task.state).toBe("cancelled");
    expect(cancelled.actions[0]?.state).toBe("dispatching");
  });

  it("survives a true database and store recreation without widening actor scope", async () => {
    const item = await fixture();
    const firstStore = createInteractiveTaskStore(item.db);
    await firstStore.createTask(taskInput());
    await firstStore.transition(turnResultTransition());
    await item.db.close();

    const reopenedDb = createInfiniteOsDb(item.url);
    item.db = reopenedDb;
    const restartedStore = createInteractiveTaskStore(reopenedDb);
    const resumed = await restartedStore.listActiveTasks({
      workspaceId: WORKSPACE_A,
      actorId: ACTOR_A,
      surface: "cmdl",
    });
    const wrongActor = await restartedStore.listActiveTasks({
      workspaceId: WORKSPACE_A,
      actorId: "actor_b",
      surface: "cmdl",
    });

    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      task: { id: "task_1", state: "awaiting_approval" },
      actions: [expect.objectContaining({ invocationId: "invocation_1" })],
    });
    expect(wrongActor).toEqual([]);
  });

  it("rejects proposal display payloads containing credential-shaped keys", async () => {
    const { db } = await fixture();
    const store = createInteractiveTaskStore(db);
    await store.createTask(taskInput());
    const transition = turnResultTransition();
    transition.transition.actions[0]!.proposal = {
      title: "Unsafe",
      sessionToken: "must-not-persist",
    };

    await expect(store.transition(transition)).rejects.toMatchObject({
      code: "unsafe_proposal_payload",
    });
  });
});
