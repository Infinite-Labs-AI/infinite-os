// Operator-only HTTP routes over the local interactive task ledger (migration 0072).
//
// The daemon owns the database; the desktop host writes task transitions and reads events through
// these routes with its operator token. They are an internal protocol, never a model capability:
// the model only ever sees scoped inspection tools, and raw transitions stay here.
//
// Scope comes from auth, never from the body: the workspace is the validated
// `x-growth-os-workspace` header, and the actor is derived from that workspace row (its opaque
// owner id when claimed, else "local"). A body that names another workspace or actor is ignored.
import type { FastifyInstance, FastifyReply } from "fastify";

import type { InfiniteOsDb } from "@infinite-os/db";
import {
  InteractiveTaskConflictError,
  createInteractiveTaskStore,
  type ApplyInteractiveTaskTransitionInput,
  type CreateInteractiveTaskInput,
  type InteractiveTaskStore,
} from "@infinite-os/llm-controller";

/** Published on /health (APP_CAPABILITIES) once these routes exist. The desktop gates on it. */
export const INTERACTIVE_TASKS_CAPABILITY = "interactive_tasks_v1";

// A create carries one opening event (bounded to 128 KiB by the store). A transition can carry a
// turn result of up to 32 proposals of 16 KiB each plus a 128 KiB message, so it gets the default
// 1 MiB. Bodies above the bound are refused (413) before they are parsed.
const CREATE_BODY_LIMIT = 256 * 1024;
const TRANSITION_BODY_LIMIT = 1024 * 1024;
const ACTOR_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

type ErrorBody = { ok: false; error: { code: string; message?: string } };

function httpStatusFor(code: string): number {
  switch (code) {
    case "task_not_found":
    case "action_not_found":
      return 404;
    case "task_authority_expired":
    case "action_authority_expired":
      return 410;
    case "invalid_task_input":
    case "invalid_task_transition":
    case "origin_violation":
    case "typed_approval_required":
    case "unsafe_proposal_payload":
    case "invalid_grant":
      return 422;
    default:
      return 409;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(reply: FastifyReply, message: string): ErrorBody {
  reply.code(422);
  return { ok: false, error: { code: "invalid_task_input", message } };
}

/**
 * Sends a typed ledger failure. Anything that is not an InteractiveTaskConflictError is an engine
 * fault: it is logged by Fastify and answered with a generic 500 that carries no internals.
 */
function sendFailure(reply: FastifyReply, error: unknown): ErrorBody {
  if (error instanceof InteractiveTaskConflictError) {
    reply.code(httpStatusFor(error.code));
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  reply.log.error({ err: error }, "interactive task ledger fault");
  reply.code(500);
  return { ok: false, error: { code: "interactive_ledger_failed" } };
}

function optionalInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

export function registerInteractiveTaskRoutes(
  app: FastifyInstance,
  options: { database: InfiniteOsDb | undefined; store?: InteractiveTaskStore },
): void {
  const database = options.database;
  const store = options.store ?? (database ? createInteractiveTaskStore(database) : undefined);

  // Resolves the operator + workspace scope every route needs, or sends the refusal.
  async function scope(
    request: { auth: { authority: string; workspaceId: string | undefined } },
    reply: FastifyReply,
  ): Promise<{ workspaceId: string; actorId: string; store: InteractiveTaskStore } | ErrorBody> {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    const workspaceId = request.auth.workspaceId;
    if (!workspaceId) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    if (!database || !store) {
      reply.code(503);
      return { ok: false, error: { code: "database_unavailable" } };
    }
    const row = await database.one<{ ownerId: string | null }>(
      `select owner_id as "ownerId" from workspaces where id = $1`,
      [workspaceId],
    );
    // An owner id that cannot be a ledger actor id would be refused by every write; treat it as
    // unowned rather than half-scoping the request.
    const owner = row?.ownerId && ACTOR_ID_RE.test(`owner:${row.ownerId}`) ? `owner:${row.ownerId}` : "local";
    return { workspaceId, actorId: owner, store };
  }
  const refused = (value: unknown): value is ErrorBody => isRecord(value) && value.ok === false;

  app.post<{ Body: unknown }>("/interactive/tasks", { bodyLimit: CREATE_BODY_LIMIT }, async (request, reply) => {
    const scoped = await scope(request, reply);
    if (refused(scoped)) return scoped;
    const body = request.body;
    if (!isRecord(body) || !isRecord(body.initialEvent) || !isRecord(body.context)) {
      return invalid(reply, "A task needs an opening event and a context object.");
    }
    if (body.provenance !== undefined && body.provenance !== null && !isRecord(body.provenance)) {
      return invalid(reply, "Provenance must be an object.");
    }
    const input = {
      ...body,
      workspaceId: scoped.workspaceId,
      actorId: scoped.actorId,
    } as unknown as CreateInteractiveTaskInput;
    try {
      const result = await scoped.store.createTask(input);
      reply.code(result.replayed ? 200 : 201);
      return { ok: true, data: result };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/interactive/tasks", async (request, reply) => {
    const scoped = await scope(request, reply);
    if (refused(scoped)) return scoped;
    const query = request.query ?? {};
    const limit = optionalInteger(query.limit);
    if (limit === null) return invalid(reply, "limit is invalid.");
    try {
      const page = await scoped.store.listActiveTasks({
        workspaceId: scoped.workspaceId,
        actorId: scoped.actorId,
        ...(typeof query.surface === "string" ? { surface: query.surface as never } : {}),
        ...(typeof query.origin === "string" ? { origin: query.origin as never } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
      });
      return { ok: true, data: page };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/interactive/tasks/:id", async (request, reply) => {
    const scoped = await scope(request, reply);
    if (refused(scoped)) return scoped;
    try {
      const detail = await scoped.store.getTask({ taskId: request.params.id, workspaceId: scoped.workspaceId, actorId: scoped.actorId });
      if (!detail) {
        reply.code(404);
        return { ok: false, error: { code: "task_not_found" } };
      }
      return { ok: true, data: detail };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/interactive/tasks/:id/events",
    async (request, reply) => {
      const scoped = await scope(request, reply);
      if (refused(scoped)) return scoped;
      const after = optionalInteger(request.query?.after);
      const limit = optionalInteger(request.query?.limit);
      if (after === null || limit === null) return invalid(reply, "after and limit must be non-negative integers.");
      try {
        const task = await scoped.store.getTask({ taskId: request.params.id, workspaceId: scoped.workspaceId, actorId: scoped.actorId });
        if (!task) {
          reply.code(404);
          return { ok: false, error: { code: "task_not_found" } };
        }
        const events = await scoped.store.listEvents({
          taskId: request.params.id,
          workspaceId: scoped.workspaceId,
          actorId: scoped.actorId,
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return { ok: true, data: events };
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/interactive/tasks/:id/transitions",
    { bodyLimit: TRANSITION_BODY_LIMIT },
    async (request, reply) => {
      const scoped = await scope(request, reply);
      if (refused(scoped)) return scoped;
      const body = request.body;
      if (!isRecord(body) || !isRecord(body.transition) || typeof body.transition.kind !== "string") {
        return invalid(reply, "A transition needs a transition object with a kind.");
      }
      const input = {
        ...body,
        taskId: request.params.id,
        workspaceId: scoped.workspaceId,
        actorId: scoped.actorId,
      } as unknown as ApplyInteractiveTaskTransitionInput;
      try {
        return { ok: true, data: await scoped.store.transition(input) };
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>("/interactive/proposals", async (request, reply) => {
    const scoped = await scope(request, reply);
    if (refused(scoped)) return scoped;
    const query = request.query ?? {};
    const limit = optionalInteger(query.limit);
    if (limit === null) return invalid(reply, "limit is invalid.");
    try {
      const page = await scoped.store.listLiveProposals({
        workspaceId: scoped.workspaceId,
        actorId: scoped.actorId,
        ...(typeof query.origin === "string" ? { origin: query.origin as never } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
      });
      return { ok: true, data: page };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  // Across actors on purpose: a restarted host must end every in-memory grant and reconcile every
  // in-flight dispatch in the workspace, whoever proposed it. Still workspace-scoped.
  app.get<{ Querystring: Record<string, unknown> }>("/interactive/recovery", async (request, reply) => {
    const scoped = await scope(request, reply);
    if (refused(scoped)) return scoped;
    const query = request.query ?? {};
    const limit = optionalInteger(query.limit);
    if (limit === null) return invalid(reply, "limit is invalid.");
    const states = typeof query.states === "string" && query.states.length > 0 ? query.states.split(",") : undefined;
    try {
      const page = await scoped.store.listRecoverableActions({
        workspaceId: scoped.workspaceId,
        ...(states ? { states: states as never } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
      });
      return { ok: true, data: page };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });
}
