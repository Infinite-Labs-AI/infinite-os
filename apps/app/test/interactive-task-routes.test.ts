import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { APP_CAPABILITIES, createApp } from "../src/index.js";

// Operator-only persistence routes for the local interactive task ledger (migration 0072). Real
// PGlite through the real migrations; every assertion goes through app.inject, so auth, workspace
// scoping, body bounds and the HTTP error mapping are all exercised the way the desktop calls them.

const OPERATOR = "Bearer route-operator";
const READ = "Bearer route-read";
const WS_A = "proj_ledger_a";
const WS_B = "proj_ledger_b";
const OWNER_A = "5d0b4a52-1c0e-4c7e-9f37-2a6b1c9d0e11";
const H = (c: string) => c.repeat(64);
const headersFor = (workspaceId: string, authorization = OPERATOR) => ({ authorization, "x-growth-os-workspace": workspaceId });

// Far-future dates: the routes use the daemon's real clock, so the fixtures must stay valid.
const AUTHORITY = "2099-01-01T00:00:00.000Z";

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task_route_1",
    origin: "human",
    surface: "cmdl",
    clientSurfaceKey: "cmdl:primary",
    providerId: "claude-cli",
    modelId: "claude-opus-4-8",
    agentProfile: "legacy-growth-operator-v1",
    acceptedContextRevision: "ctx_1",
    authorityExpiresAt: AUTHORITY,
    context: {},
    initialEvent: { eventId: "ev_route_1", requestId: "rq_route_1", requestHash: H("a"), kind: "user_message", payload: { text: "hi" } },
    ...overrides,
  };
}

function turnResult(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision: 1,
    requestId: "rq_turn_1",
    requestHash: H("b"),
    eventId: "ev_turn_1",
    transition: {
      kind: "record_turn_result",
      turnKey: "turn_1",
      assistantMessage: "Prepared.",
      actions: [{
        invocationId: "inv_route_1",
        sourceKind: "host_confirmation",
        operationId: "propose_meta_budget",
        adapterVersion: "desktop.v1",
        schemaVersion: "1",
        proposalRef: "P1",
        proposalRevision: 1,
        proposalHash: H("c"),
        proposal: { title: "Change daily budget" },
        inputHash: H("d"),
        effect: "external_write",
        replayPolicy: "reconcile_before_retry",
      }],
    },
    ...overrides,
  };
}

describe("interactive task routes (0072 ledger over HTTP)", () => {
  // A task of another actor in the same workspace, shaped as the store writes one (revision 1 and its
  // opening event). The routes derive one actor per workspace, so it cannot be created through them.
  async function insertOtherActorTask() {
    await db.query(`insert into interactive_tasks (id, workspace_id, actor_id, surface, origin, client_surface_key, provider_id,
      model_id, agent_profile, accepted_context_revision, authority_expires_at, revision, last_event_sequence)
      values ('task_other', $1, 'local', 'cmdl', 'human', 'k', 'p', 'm', 'a', 'ctx', $2, 1, 1)`, [WS_A, AUTHORITY]);
    await db.query(`insert into interactive_task_events (event_id, task_id, workspace_id, actor_id, origin, surface, sequence, kind,
      transition_request_id, transition_request_hash) values ('ev_other_1', 'task_other', $1, 'local', 'human', 'cmdl', 1,
      'user_message', 'rq_other_1', $2)`, [WS_A, H("a")]);
  }

  let directory: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "ledger-routes-"));
    url = `pglite://${directory}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
    await db.query("insert into workspaces(id, name, owner_id) values ($1, 'A', $2), ($3, 'B', null)", [WS_A, OWNER_A, WS_B]);
  }, 60_000);
  beforeEach(async () => {
    vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", "route-operator");
    vi.stubEnv("GROWTH_OS_READ_TOKEN", "route-read");
    await db.query("delete from interactive_action_refs");
    await db.query("delete from interactive_task_events");
    await db.query("delete from interactive_tasks");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("advertises the ledger capability so a desktop can gate on it", async () => {
    expect(APP_CAPABILITIES).toContain("interactive_tasks_v1");
    const app = createApp({ database: db });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json().capabilities).toContain("interactive_tasks_v1");
    } finally { await app.close(); }
  });

  it("is operator-only and workspace-scoped", async () => {
    const app = createApp({ database: db });
    try {
      expect((await app.inject({ method: "POST", url: "/interactive/tasks", payload: createBody() })).statusCode).toBe(401);
      const asTool = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A, READ), payload: createBody() });
      expect(asTool.statusCode).toBe(403);
      expect(asTool.json().error.code).toBe("operator_authority_required");
      expect((await app.inject({ method: "GET", url: "/interactive/proposals", headers: headersFor(WS_A, READ) })).statusCode).toBe(403);
      const noWorkspace = await app.inject({ method: "POST", url: "/interactive/tasks", headers: { authorization: OPERATOR }, payload: createBody() });
      expect(noWorkspace.statusCode).toBe(400);
      expect(noWorkspace.json().error.code).toBe("unknown_workspace");
      // Workspace and actor come from auth and the workspace row, never from the body.
      const created = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A),
        payload: createBody({ workspaceId: WS_B, actorId: "attacker" }) });
      expect(created.statusCode).toBe(201);
      expect(created.json().data.task).toMatchObject({ workspaceId: WS_A, actorId: `owner:${OWNER_A}` });
      // Another workspace cannot see it.
      expect((await app.inject({ method: "GET", url: "/interactive/tasks/task_route_1", headers: headersFor(WS_B) })).statusCode).toBe(404);
      const local = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_B),
        payload: createBody({ taskId: "task_route_b", initialEvent: { ...createBody().initialEvent, eventId: "ev_route_b" } }) });
      expect(local.json().data.task.actorId).toBe("local");
    } finally { await app.close(); }
  });

  it("records a turn, replays by request id, and reads task, events and live proposals", async () => {
    const app = createApp({ database: db });
    try {
      const created = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload: createBody() });
      expect(created.statusCode).toBe(201);
      const again = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload: createBody() });
      expect(again.statusCode).toBe(200);
      expect(again.json().data.replayed).toBe(true);

      const recorded = await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A), payload: turnResult() });
      expect(recorded.statusCode).toBe(200);
      expect(recorded.json().data).toMatchObject({ replayed: false, task: { state: "awaiting_approval", revision: 2 } });
      const replay = await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A), payload: turnResult() });
      expect(replay.json().data.replayed).toBe(true);

      const detail = await app.inject({ method: "GET", url: "/interactive/tasks/task_route_1", headers: headersFor(WS_A) });
      expect(detail.json().data.actions.map((action: { invocationId: string }) => action.invocationId)).toEqual(["inv_route_1"]);
      const events = await app.inject({ method: "GET", url: "/interactive/tasks/task_route_1/events?after=1", headers: headersFor(WS_A) });
      expect(events.json().data.map((event: { kind: string }) => event.kind)).toEqual(["assistant_message"]);
      const proposals = await app.inject({ method: "GET", url: "/interactive/proposals", headers: headersFor(WS_A) });
      expect(proposals.json().data.proposals.map((proposal: { action: { invocationId: string } }) => proposal.action.invocationId)).toEqual(["inv_route_1"]);
      const tasks = await app.inject({ method: "GET", url: "/interactive/tasks?limit=5", headers: headersFor(WS_A) });
      expect(tasks.json().data.tasks).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("maps typed ledger errors to HTTP: 404, 409, 410 and 422, never a raw 500", async () => {
    const app = createApp({ database: db });
    try {
      await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload: createBody() });
      await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A), payload: turnResult() });
      const missing = await app.inject({ method: "POST", url: "/interactive/tasks/nope/transitions", headers: headersFor(WS_A), payload: turnResult() });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("task_not_found");
      // Stale CAS.
      const stale = await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A),
        payload: { ...turnResult(), requestId: "rq_stale", eventId: "ev_stale", transition: { kind: "append_event", eventKind: "progress", payload: {} } } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("task_revision_conflict");
      // Expired authority is gone (410).
      const expired = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A),
        payload: createBody({ taskId: "task_expired", authorityExpiresAt: "2001-01-01T00:00:00.000Z" }) });
      expect(expired.statusCode).toBe(410);
      expect(expired.json().error.code).toBe("task_authority_expired");
      // Bad input is 422, including shapes the store would otherwise trip over.
      for (const payload of [
        createBody({ taskId: "bad id!" }),
        createBody({ initialEvent: null }),
        createBody({ context: "nope" }),
        { ...createBody(), origin: "triggered", initialEvent: { ...createBody().initialEvent, kind: "trigger" } },
      ]) {
        const response = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload });
        expect(response.statusCode, JSON.stringify(response.json())).toBe(422);
      }
      const badTransition = await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A),
        payload: { expectedRevision: 2, requestId: "rq_x", requestHash: H("e"), eventId: "ev_x", transition: "approve" } });
      expect(badTransition.statusCode).toBe(422);
      const badCursor = await app.inject({ method: "GET", url: "/interactive/proposals?cursor=zzz", headers: headersFor(WS_A) });
      expect(badCursor.statusCode).toBe(422);
      const badLimit = await app.inject({ method: "GET", url: "/interactive/tasks?limit=1000", headers: headersFor(WS_A) });
      expect(badLimit.statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it("refuses oversized bodies before parsing them", async () => {
    const app = createApp({ database: db });
    try {
      const huge = createBody({ initialEvent: { ...createBody().initialEvent, payload: { text: "x".repeat(300 * 1024) } } });
      const response = await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload: huge });
      expect(response.statusCode).toBe(413);
    } finally { await app.close(); }
  });

  it("settles a restarted host's leftovers across actors in one operator route", async () => {
    const app = createApp({ database: db });
    try {
      await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload: createBody() });
      await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A), payload: turnResult() });
      // Another actor's authorized grant and a send left in flight, in the same workspace.
      await insertOtherActorTask();
      await db.query(`insert into interactive_action_refs (invocation_id, task_id, workspace_id, actor_id, origin, surface, source_kind,
        operation_id, adapter_version, schema_version, proposal_ref, proposal_revision, proposal_hash, input_hash, effect, replay_policy,
        state, prepared_at, decision_source) values ('inv_granted', 'task_other', $1, 'local', 'human', 'cmdl', 'host_confirmation', 'op',
        'v', '1', 'P1', 1, $2, $2, 'external_write', 'reconcile_before_retry', 'authorized', now(), 'host_confirmation'),
        ('inv_sending', 'task_other', $1, 'local', 'human', 'cmdl', 'host_confirmation', 'op', 'v', '1', 'P2', 1, $2, $2, 'external_write',
        'reconcile_before_retry', 'dispatching', now(), 'host_confirmation')`, [WS_A, H("c")]);

      expect((await app.inject({ method: "POST", url: "/interactive/recovery/host-restart", headers: headersFor(WS_A, READ),
        payload: { bootId: "boot-1" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/interactive/recovery/host-restart", headers: headersFor(WS_A),
        payload: { bootId: "bad boot id!" } })).statusCode).toBe(422);

      const recovered = await app.inject({ method: "POST", url: "/interactive/recovery/host-restart", headers: headersFor(WS_A),
        payload: { bootId: "boot-1" } });
      expect(recovered.statusCode).toBe(200);
      const report = recovered.json().data;
      expect(report.bootId).toBe("boot-1");
      expect(report.failures).toEqual([]);
      expect(report.settled.map((item: { invocationId: string; kind: string }) => [item.invocationId, item.kind]).sort()).toEqual([
        ["inv_granted", "grant_ended"], ["inv_sending", "outcome_unknown"]]);
      const states = await db.query<{ invocation_id: string; state: string }>(
        "select invocation_id, state from interactive_action_refs where task_id = 'task_other' order by invocation_id");
      expect(states).toEqual([{ invocation_id: "inv_granted", state: "expired" }, { invocation_id: "inv_sending", state: "unknown" }]);
      // Another workspace is untouched. A replay of the same boot (a lost reply) reports everything
      // that boot settled again, and writes nothing new.
      expect((await app.inject({ method: "POST", url: "/interactive/recovery/host-restart", headers: headersFor(WS_B),
        payload: { bootId: "boot-1" } })).json().data.settled).toEqual([]);
      const eventCount = async () => (await db.query<{ n: number }>(
        "select count(*)::int as n from interactive_task_events where task_id = 'task_other'"))[0]!.n;
      const before = await eventCount();
      const replay = await app.inject({ method: "POST", url: "/interactive/recovery/host-restart", headers: headersFor(WS_A),
        payload: { bootId: "boot-1" } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data.settled.map((item: { invocationId: string; kind: string }) => [item.invocationId, item.kind]).sort()).toEqual([
        ["inv_granted", "grant_ended"], ["inv_sending", "outcome_unknown"]]);
      expect(await eventCount()).toBe(before);
    } finally { await app.close(); }
  });

  it("lists actions a restarted host must settle across actors, scoped to the workspace", async () => {
    const app = createApp({ database: db });
    try {
      await app.inject({ method: "POST", url: "/interactive/tasks", headers: headersFor(WS_A), payload: createBody() });
      await app.inject({ method: "POST", url: "/interactive/tasks/task_route_1/transitions", headers: headersFor(WS_A), payload: turnResult() });
      // A second actor's authorized grant in the same workspace (written directly: routes derive the actor).
      await insertOtherActorTask();
      await db.query(`insert into interactive_action_refs (invocation_id, task_id, workspace_id, actor_id, origin, surface, source_kind,
        operation_id, adapter_version, schema_version, proposal_ref, proposal_revision, proposal_hash, input_hash, effect, replay_policy,
        state, prepared_at, decision_source) values ('inv_other', 'task_other', $1, 'local', 'human', 'cmdl', 'host_confirmation', 'op',
        'v', '1', 'P1', 1, $2, $2, 'external_write', 'reconcile_before_retry', 'authorized', now(), 'host_confirmation')`, [WS_A, H("c")]);
      const recovery = await app.inject({ method: "GET", url: "/interactive/recovery?states=authorized", headers: headersFor(WS_A) });
      expect(recovery.statusCode).toBe(200);
      expect(recovery.json().data.actions.map((action: { invocationId: string }) => action.invocationId)).toEqual(["inv_other"]);
      expect((await app.inject({ method: "GET", url: "/interactive/recovery", headers: headersFor(WS_B) })).json().data.actions).toEqual([]);
      const badState = await app.inject({ method: "GET", url: "/interactive/recovery?states=succeeded", headers: headersFor(WS_A) });
      expect(badState.statusCode).toBe(422);
    } finally { await app.close(); }
  });
});
