import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { createActionHandlers } from "@infinite-os/analytical-engine";
import { loadInfiniteOsConfig } from "@infinite-os/config";
import {
  buildDaemonDescriptor,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
  type BoundAddress
} from "./daemon-descriptor.js";
import { acquireDaemonSpawnLock } from "./daemon-spawn-lock.js";
import { decryptCredentialPayload, encryptCredentialPayload } from "@infinite-os/core";
import {
  createInfiniteOsDb,
  createProject,
  deleteProject,
  listProjects,
  readLatestSetupPublicArtifacts,
  runMigrations,
  upsertWorkspaceSite,
  type InfiniteOsDb
} from "@infinite-os/db";
import {
  createDbBackedConnectedXIdentityLookup,
  createConfiguredModelClient,
  createCuratedMemoryManager,
  createLlmController,
  createModelBackedMemoryReviewer,
  createSourceAwareQueryAdvisor,
  createSessionStore,
  filterCuratedMemoryCandidates,
  type InfiniteOsModelClient,
  type ChatSessionStore
} from "@infinite-os/llm-controller";
import {
  FIRST_PHASE_METRICS,
  FIRST_PHASE_QUERYABLE_VIEWS,
  createSessionContext,
  createInfiniteOsRegistry,
  listRecipes,
  loadSetupModule as loadRuntimeSetupModule,
  type Authority,
  type RuntimeSurface
} from "@infinite-os/runtime";

declare module "fastify" {
  interface FastifyRequest {
    auth: { authority: Authority; workspaceId: string | undefined };
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Map the gateway request's `platform` to the controller RuntimeSurface.
// ChatInput.surface accepts "api" | "app" | "cli" | "desktop"; the desktop
// sends platform "desktop". Unknown/missing platforms fall back to "api"
// (the historical hardcode) so legacy gateway callers are unchanged.
type GatewayControllerSurface = Extract<RuntimeSurface, "api" | "app" | "cli" | "desktop">;
function platformToSurface(platform: string): GatewayControllerSurface {
  switch (platform) {
    case "desktop":
      return "desktop";
    case "app":
      return "app";
    case "cli":
      return "cli";
    default:
      return "api";
  }
}

// The controller keys sessions by the workspace-qualified id (`<conversationId>:<ws>`), but the
// API must hand the CLIENT back the UNqualified conversation id. The next turn round-trips this
// value as its `sessionId`, and we re-qualify it (`:<ws>`) idempotently — so returning the
// qualified key would make turn 2 send `<conversationId>:<ws>`, which we'd re-qualify to
// `<conversationId>:<ws>:<ws>`: a brand-new orphaned session that silently breaks multi-turn
// continuity. Mirrors the CLI's stripWorkspaceSuffix (apps/cli/src/index.ts).
function stripWorkspaceSuffix(id: string, workspaceId: string): string {
  const suffix = `:${workspaceId}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

export interface CompactSessionRequestBody {
  newSessionId?: string;
  summaryText?: string;
  summaryJson?: Record<string, unknown>;
}

export interface MemoryFactRequestBody {
  scope?: string;
  fact?: string;
}

export interface GatewayTurnRequestBody {
  platform?: string;
  actorId?: string;
  channelId?: string;
  message?: string;
  sessionId?: string;
}

export interface ConnectorOAuthSessionRequestBody {
  provider?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  authorizationBaseUrl?: string;
  tokenUrl?: string;
  scope?: string | string[];
  extraParams?: Record<string, string>;
}

export interface ConnectorOAuthExchangeRequestBody {
  propertyId?: string;
  connectionName?: string;
  clientSecret?: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
}

export interface SetupSiteMetadataRequestBody {
  url?: string;
  repoPath?: string;
  appDir?: string;
  framework?: string;
  businessType?: string;
}

interface ConnectorOAuthSession {
  sessionId: string;
  provider: string;
  clientId: string;
  workspaceId?: string;
  oauthAppId?: string | null;
  oauthAppPayload?: Record<string, unknown> | null;
  authorizationBaseUrl: string;
  scope: string;
  state: string;
  status: "pending" | "completed" | "failed";
  authorizationUrl: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  code?: string;
  codeVerifier?: string;
  error?: string;
  completedAt?: string;
}

interface ResumeSetupRunResult {
  ok: boolean;
  resumed: boolean;
  onboarding?: {
    selectedProviders?: unknown;
    recommendedProviders?: unknown;
    completed?: unknown;
    paused?: unknown;
    failed?: unknown;
    activeRuns?: unknown;
    resolvedPublicArtifacts?: unknown;
    installCommand?: unknown;
    installArtifactsPath?: unknown;
  };
  notes?: unknown;
}

export function createApp(options: {
  databaseUrl?: string;
  database?: InfiniteOsDb;
  modelClient?: InfiniteOsModelClient;
  sessionStore?: ChatSessionStore;
  resumeSetupRun?: (input: {
    db: InfiniteOsDb;
    workspaceId: string;
    runId: string;
    registry: ReturnType<typeof createInfiniteOsRegistry>;
  }) => Promise<ResumeSetupRunResult>;
} = {}) {
  const app = Fastify({ logger: false });
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const createdDatabase = !options.database && databaseUrl ? createInfiniteOsDb(databaseUrl) : undefined;
  const database = options.database ?? createdDatabase;
  const registry = database ? createInfiniteOsRegistry(createActionHandlers(database)) : createInfiniteOsRegistry();
  const resumeSetupRun = options.resumeSetupRun ?? defaultResumeSetupRun;
  const dbAdapter = database ? sessionStoreDb(database) : undefined;
  const sessionStore = options.sessionStore ?? (dbAdapter ? createSessionStore(dbAdapter) : undefined);
  const modelClient = options.modelClient ?? createConfiguredModelClient();
  const queryAdvisor = dbAdapter
    ? createSourceAwareQueryAdvisor({
        listConnectedXIdentities: createDbBackedConnectedXIdentityLookup(dbAdapter)
      })
    : undefined;
  // Mirror the CLI in-process runtime (apps/cli/src/index.ts:9545) so the
  // gateway turn gets curated memory load/review. dbAdapter is optional here
  // (no DATABASE_URL -> undefined) unlike the CLI, so only build the manager
  // when the db-backed adapter exists; createLlmController accepts an
  // optional memoryManager.
  const memoryManager = dbAdapter
    ? createCuratedMemoryManager({
        db: dbAdapter,
        reviewer: createModelBackedMemoryReviewer(modelClient)
      })
    : undefined;
  const llmController = createLlmController({
    registry,
    sessionStore,
    modelClient,
    memoryManager,
    queryAdvisor
  });
  const oauthSessions = new Map<string, ConnectorOAuthSession>();
  if (createdDatabase) {
    app.addHook("onClose", async () => {
      await createdDatabase.close();
    });
  }

  const PUBLIC_ROUTES = new Set(["/health", "/oauth/callback/:provider"]);
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url; // Fastify v5; NOT request.routerPath
    if (route && PUBLIC_ROUTES.has(route)) {
      return;
    }
    // loadInfiniteOsConfig() throws when DATABASE_URL / encryption key are absent.
    // Auth should still honor explicitly provided operator/read tokens when only
    // unrelated config like the encryption key is missing, while preserving a 401
    // when no usable token config exists at all. (C3)
    let cfg: ReturnType<typeof loadInfiniteOsConfig> | undefined;
    try {
      cfg = loadInfiniteOsConfig();
    } catch {
      cfg = undefined;
    }
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const operatorToken = cfg?.operatorToken ?? process.env.GROWTH_OS_OPERATOR_TOKEN;
    const readToken = cfg?.readToken ?? process.env.GROWTH_OS_READ_TOKEN;
    let authority: Authority | undefined;
    if (token && operatorToken && timingSafeEqualStr(token, operatorToken)) {
      authority = "operator";
    } else if (token && readToken && timingSafeEqualStr(token, readToken)) {
      authority = "tool_agent";
    }
    if (!authority) {
      reply.code(401);
      return reply.send({ ok: false, error: { code: "unauthorized" } });
    }
    const header = requestedWorkspaceId(request.headers["x-growth-os-workspace"]);
    let workspaceId: string | undefined;
    if (header) {
      if (!database) {
        reply.code(503);
        return reply.send({ ok: false, error: { code: "database_unavailable" } });
      }
      const exists = await database.one("select 1 as ok from workspaces where id = $1", [header]);
      if (!exists) {
        reply.code(400);
        return reply.send({ ok: false, error: { code: "unknown_workspace" } });
      }
      workspaceId = header;
    }
    request.auth = { authority, workspaceId };
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "growth-os-app",
    runtime: "app-api-mcp"
  }));

  app.get("/schema", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("list_queryable_views", {}, "api", "tool_agent", undefined, ws);
  });
  app.get("/queryable/views", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("list_queryable_views", {}, "api", "tool_agent", undefined, ws);
  });
  app.get("/metrics", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("list_metrics", {}, "api", "tool_agent", undefined, ws);
  });
  app.get("/sources", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("list_sources", {}, "api", "tool_agent", undefined, ws);
  });
  app.get("/integrations", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("list_sources", {}, "app", "tool_agent", undefined, ws);
  });
  app.get("/source-schedules", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("list_source_schedules", {}, "api", "tool_agent", undefined, ws);
  });
  app.get("/sync/runs", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("get_recent_sync_runs", request.query ?? {}, "api", "tool_agent", undefined, ws);
  });
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    if (!database) {
      reply.code(503);
      return { ok: false, error: { code: "database_unavailable" } };
    }
    const requestedWorkspace = request.auth.workspaceId;
    if (!requestedWorkspace) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    const job = await database.one<Record<string, unknown>>(
      `
        select id, workspace_id, job_type, payload, status, attempt_count,
               created_at, started_at, finished_at, error
        from job_runs
        where id = $1 and workspace_id = $2
      `,
      [request.params.id, requestedWorkspace]
    );
    if (!job) {
      reply.code(404);
      return { ok: false, error: { code: "job_not_found" } };
    }
    const sourceId = sourceIdFromJobPayload(job.payload);
    const syncRuns = sourceId
      ? await database.query<Record<string, unknown>>(
        `
          select id, workspace_id, source_id, status, started_at, finished_at,
                 records_extracted, records_loaded, error
          from sync_runs
          where workspace_id = $1
            and source_id = $2
            and ($3::timestamptz is null or started_at >= $3::timestamptz - interval '5 seconds')
          order by started_at desc nulls last, finished_at desc nulls last
          limit 1
        `,
        [requestedWorkspace, sourceId, job.created_at ?? null]
      )
      : [];
    return {
      ok: true,
      data: {
        job,
        syncRun: syncRuns[0] ?? null
      }
    };
  });
  app.get("/source-health", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("describe_queryable_view", { viewId: "queryable.vw_recent_sync_status" }, "app", "tool_agent", undefined, ws);
  });

  app.post<{ Body: GatewayTurnRequestBody }>("/gateway/turn", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    if (!message) {
      reply.code(400);
      return { ok: false, error: { code: "gateway_message_required" } };
    }
    const platform = typeof request.body?.platform === "string" && request.body.platform.trim()
      ? request.body.platform.trim()
      : "gateway";
    const actorId = typeof request.body?.actorId === "string" && request.body.actorId.trim()
      ? request.body.actorId.trim()
      : `${platform}:unknown`;
    const channelId = typeof request.body?.channelId === "string" && request.body.channelId.trim()
      ? request.body.channelId.trim()
      : "default";
    const conversationId = typeof request.body?.sessionId === "string" && request.body.sessionId.trim()
      ? request.body.sessionId.trim()
      : `${platform}:${channelId}:${actorId}`;
    // Qualify the conversation id with the workspace, mirroring the CLI's
    // deriveControllerSessionId (apps/cli/src/index.ts:9597). chat_sessions
    // keys rows on (workspace_id, session_key) but inserts id = session_key =
    // sessionId, so two workspaces sharing one conversation id would re-insert
    // the same PK and collide. The `:${ws}` suffix keeps the row per-workspace.
    const sessionId = `${conversationId}:${ws}`;
    const response = await llmController.chat({
      message,
      sessionId,
      workspaceId: ws,
      actorId,
      surface: platformToSurface(platform)
    });
    return {
      ok: true,
      platform,
      channelId,
      actorId,
      // Hand back the UNqualified conversation id so the next turn round-trips to a value we
      // re-qualify idempotently. response.sessionId is the workspace-qualified controller key
      // (it may also have rotated via compaction); strip the `:<ws>` suffix either way.
      sessionId: stripWorkspaceSuffix(response.sessionId, ws),
      message: response.message,
      provenance: response.provenance,
      actionCalls: response.actionCalls
    };
  });

  app.get<{ Params: { id: string } }>("/sources/:id", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return actionRequest("describe_source", { sourceId: request.params.id }, "app", "tool_agent", undefined, ws);
  });
  app.get<{ Params: { id: string } }>("/sources/:id/credential-status", async (request) => ({
    ok: true,
    data: {
      sourceId: request.params.id,
      credentialState: "managed_by_growth_os",
      credentialPayloadExposed: false,
      reconnectRoute: `/sources/${request.params.id}/reconnect`,
      revokeRoute: `/sources/${request.params.id}/revoke`
    }
  }));

  app.post<{ Body: Record<string, unknown> }>("/sources/connect", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return guardedAction(reply, request.auth.authority, "connect_source", request.body ?? {}, "api", ws);
  });
  app.post<{ Body: Record<string, unknown>; Params: { id: string } }>(
    "/sources/:id/sync",
    async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, "start_source_sync", {
        ...request.body,
        sourceId: request.params.id
      }, "api", ws);
    }
  );
  app.post<{ Body: Record<string, unknown>; Params: { id: string } }>(
    "/sources/:id/reconnect",
    async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, "reconnect_source", {
        ...request.body,
        sourceId: request.params.id
      }, "api", ws);
    }
  );
  app.post<{ Body: Record<string, unknown>; Params: { id: string } }>(
    "/sources/:id/revoke",
    async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, "revoke_source", {
        ...request.body,
        sourceId: request.params.id
      }, "api", ws);
    }
  );
  app.patch<{ Body: Record<string, unknown>; Params: { id: string } }>(
    "/sources/:id/schedule",
    async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, "update_source_schedule", {
        ...request.body,
        sourceId: request.params.id
      }, "api", ws);
    }
  );
  app.post<{ Body: Record<string, unknown>; Params: { id: string } }>(
    "/sources/:id/schedule/pause",
    async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, "pause_source_schedule", {
        ...request.body,
        sourceId: request.params.id
      }, "api", ws);
    }
  );
  app.post<{ Body: Record<string, unknown>; Params: { id: string } }>(
    "/sources/:id/schedule/resume",
    async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, "resume_source_schedule", {
        ...request.body,
        sourceId: request.params.id
      }, "api", ws);
    }
  );

  // Meta Ads WRITE/management — operator-only money mutations. Each route mirrors
  // `/sources/:id/sync`: it goes through `guardedAction`, which denies non-operator
  // authority with 403 (a tool_agent/LLM session can NEVER fire a Meta write). The
  // create actions ALWAYS land PAUSED in the handler; `set_meta_entity_status` is
  // the separate, gated go-live transition. The `/tools/call` route already exposes
  // these same action ids; these named routes are the explicit, mirrored surface.
  const META_WRITE_ROUTES: Array<{ path: string; actionId: string }> = [
    { path: "/meta/campaigns", actionId: "create_meta_campaign" },
    { path: "/meta/adsets", actionId: "create_meta_ad_set" },
    { path: "/meta/creatives", actionId: "create_meta_creative" },
    { path: "/meta/ads", actionId: "create_meta_ad" },
    { path: "/meta/status", actionId: "set_meta_entity_status" }
  ];
  for (const { path, actionId } of META_WRITE_ROUTES) {
    app.post<{ Body: Record<string, unknown> }>(path, async (request, reply) => {
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      return guardedAction(reply, request.auth.authority, actionId, request.body ?? {}, "api", ws);
    });
  }

  app.get("/chat/sessions", async (request, reply) => {
    if (!sessionStore) {
      return { ok: true, sessions: [] };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return {
      ok: true,
      sessions: await sessionStore.listSessions(ws)
    };
  });

  app.get<{ Querystring: { q?: string; excludeSessionId?: string } }>("/chat/sessions/search", async (request, reply) => {
    if (!sessionStore) {
      return { ok: true, sessions: [] };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    const excludeSessionId =
      typeof request.query.excludeSessionId === "string" && request.query.excludeSessionId.trim()
        ? request.query.excludeSessionId.trim()
        : undefined;
    if (!query) {
      return { ok: true, sessions: [] };
    }
    return {
      ok: true,
      sessions: await sessionStore.searchSessions(ws, query, { excludeSessionId })
    };
  });

  app.get<{ Params: { id: string } }>("/chat/sessions/:id", async (request, reply) => {
    if (!sessionStore) {
      reply.code(404);
      return { ok: false, error: { code: "session_store_unavailable" } };
    }
    const session = await sessionStore.getSession(request.params.id);
    if (!session) {
      reply.code(404);
      return { ok: false, error: { code: "session_not_found" } };
    }
    return { ok: true, session };
  });

  app.get<{ Params: { id: string } }>("/chat/sessions/:id/memory", async (request, reply) => {
    if (!dbAdapter) {
      reply.code(404);
      return { ok: false, error: { code: "memory_store_unavailable" } };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    const memories = await dbAdapter.query(
      `
        select id, scope, fact, source_session_id as "sourceSessionId",
          source_message_id as "sourceMessageId", created_at as "createdAt",
          updated_at as "updatedAt", expires_at as "expiresAt", blocked_reason as "blockedReason"
        from chat_memory_facts
        where workspace_id = $1
          and blocked_reason is null
          and (source_session_id = $2 or source_session_id is null)
        order by updated_at desc
        limit 100
      `,
      [ws, request.params.id]
    );
    return { ok: true, sessionId: request.params.id, memories };
  });

  app.post<{ Body: MemoryFactRequestBody; Params: { id: string } }>(
    "/chat/sessions/:id/memory",
    async (request, reply) => {
      if (request.auth.authority !== "operator") {
        reply.code(403);
        return { ok: false, error: { code: "operator_authority_required" } };
      }
      if (!dbAdapter) {
        reply.code(404);
        return { ok: false, error: { code: "memory_store_unavailable" } };
      }
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      const [candidate] = filterCuratedMemoryCandidates([
        {
          scope: request.body?.scope ?? "",
          fact: request.body?.fact ?? ""
        }
      ]);
      if (!candidate) {
        reply.code(400);
        return {
          ok: false,
          error: { code: "memory_fact_rejected", message: "Memory fact is outside the curated Infinite OS policy." }
        };
      }
      const memoryId = `mem_${randomUUID()}`;
      await dbAdapter.query(
        `
          insert into chat_memory_facts (
            id, workspace_id, actor_id, scope, fact, source_session_id
          )
          select $1, $2, $3, $4, $5, $6
          where not exists (
            select 1 from chat_memory_facts
            where workspace_id = $2 and scope = $4 and lower(fact) = lower($5)
              and blocked_reason is null
          )
        `,
        [memoryId, ws, "operator", candidate.scope, candidate.fact, request.params.id]
      );
      return { ok: true, memory: { id: memoryId, scope: candidate.scope, fact: candidate.fact } };
    }
  );

  app.delete<{ Params: { id: string; memoryId: string } }>(
    "/chat/sessions/:id/memory/:memoryId",
    async (request, reply) => {
      if (request.auth.authority !== "operator") {
        reply.code(403);
        return { ok: false, error: { code: "operator_authority_required" } };
      }
      if (!dbAdapter) {
        reply.code(404);
        return { ok: false, error: { code: "memory_store_unavailable" } };
      }
      const ws = request.auth.workspaceId;
      if (!ws) {
        reply.code(400);
        return { ok: false, error: { code: "unknown_workspace" } };
      }
      await dbAdapter.query(
        `
          update chat_memory_facts
          set blocked_reason = 'operator_deleted', updated_at = now()
          where id = $1 and workspace_id = $2
            and (source_session_id = $3 or source_session_id is null)
        `,
        [request.params.memoryId, ws, request.params.id]
      );
      return { ok: true, sessionId: request.params.id, memoryId: request.params.memoryId };
    }
  );

  app.post<{ Params: { id: string } }>("/chat/sessions/:id/resume", async (request) => {
    await sessionStore?.resumeSession(request.params.id);
    return { ok: true, sessionId: request.params.id };
  });

  app.post<{ Body: { reason?: string }; Params: { id: string } }>("/chat/sessions/:id/end", async (request) => {
    await sessionStore?.endSession(request.params.id, request.body?.reason ?? "operator_request");
    return { ok: true, sessionId: request.params.id };
  });

  app.post<{ Body: CompactSessionRequestBody; Params: { id: string } }>(
    "/chat/sessions/:id/compact",
    async (request, reply) => {
      const suppliedSummary = typeof request.body?.summaryText === "string" ? request.body.summaryText.trim() : "";
      const summaryText = suppliedSummary || (await generateCompactSummary(sessionStore, modelClient, request.params.id));
      if (!summaryText) {
        reply.code(400);
        return {
          ok: false,
          error: { code: "summary_required", message: "compact requires summaryText" }
        };
      }
      const compacted = await sessionStore?.compactSession({
        sessionId: request.params.id,
        newSessionId: request.body?.newSessionId,
        summaryText,
        summaryJson: request.body?.summaryJson
      });
      return {
        ok: true,
        sessionId: compacted?.sessionId ?? request.body?.newSessionId ?? request.params.id,
        parentSessionId: compacted?.parentSessionId ?? request.params.id
      };
    }
  );

  app.post<{ Params: { confirmationId: string } }>("/chat/actions/:confirmationId/confirm", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    if (!sessionStore?.getPendingActionCall || !sessionStore.confirmActionCall) {
      reply.code(404);
      return { ok: false, error: { code: "confirmation_store_unavailable" } };
    }
    const pending = await sessionStore.getPendingActionCall(request.params.confirmationId);
    if (!pending) {
      reply.code(404);
      return { ok: false, error: { code: "confirmation_not_found" } };
    }
    try {
      const envelope = await actionRequest(pending.actionId, pending.input, "api", "operator", pending.sessionId, ws);
      await sessionStore.confirmActionCall({
        confirmationId: request.params.confirmationId,
        outputEnvelope: envelope,
        status: envelope.status
      });
      return {
        ok: true,
        confirmationId: request.params.confirmationId,
        sessionId: pending.sessionId,
        actionId: pending.actionId,
        inputHash: pending.inputHash ?? null,
        envelope
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return {
        ok: false,
        error: { code: "confirmation_execution_failed", message }
      };
    }
  });

  app.post<{ Body: ToolCallBody }>("/tools/call", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return guardedAction(
      reply,
      request.auth.authority,
      toolCallActionId(request.body),
      toolCallInput(request.body),
      "api",
      ws
    );
  });

  app.get("/mcp/resources", async () => ({
    resources: [
      "growth-os://schema",
      "growth-os://metrics",
      "growth-os://queryable-views",
      "growth-os://sync-status",
      "growth-os://capabilities"
    ]
  }));

  app.get("/mcp/tools", async () => ({
    tools: (registry?.list() ?? []).map((action) => ({
      name: action.id,
      title: action.title,
      summary: action.summary,
      category: action.category,
      authority: action.authority,
      provenancePolicy: action.provenancePolicy,
      recommendedNextActions: action.recommendedNextActions,
      recipeIds: action.recipeIds,
      inputSchema: action.inputSchema,
      outputSchema: action.outputSchema
    }))
  }));

  app.get("/recipes", async () => ({
    ok: true,
    recipes: listRecipes()
  }));

  app.post<{ Body: ToolCallBody }>("/mcp/tools/call", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return guardedAction(
      reply,
      request.auth.authority,
      toolCallActionId(request.body),
      toolCallInput(request.body),
      "mcp",
      ws
    );
  });

  app.get("/capabilities", async () => ({
      ok: true,
      data: {
      providers: ["google_analytics_4", "posthog", "stripe", "x", "shopify", "meta_ads"],
      metrics: FIRST_PHASE_METRICS,
      queryableViews: FIRST_PHASE_QUERYABLE_VIEWS,
      actions: registry?.list().map((action) => ({
        id: action.id,
        title: action.title,
        summary: action.summary,
        category: action.category,
        authority: action.authority,
        provenancePolicy: action.provenancePolicy,
        recommendedNextActions: action.recommendedNextActions,
        recipeIds: action.recipeIds
      })) ?? []
    }
  }));

  app.get("/settings/project", async (request, reply) => {
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    return {
      ok: true,
      data: {
        workspaceId: ws,
        providers: ["google_analytics_4", "posthog", "stripe", "x", "shopify", "meta_ads"],
        phase: "ga4-posthog-stripe-x-shopify-meta-ads",
        deferred: ["content_items", "conversion_events", "attribution_models", "recurring_delivery"]
      }
    };
  });

  app.post<{ Body: { name?: string } }>("/projects", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    if (!database) {
      reply.code(503);
      return { ok: false, error: { code: "database_unavailable" } };
    }
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name) {
      reply.code(400);
      return { ok: false, error: { code: "project_name_required" } };
    }
    const project = await createProject(database, name);
    return { ok: true, project };
  });

  app.get("/projects", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    if (!database) {
      reply.code(503);
      return { ok: false, error: { code: "database_unavailable" } };
    }
    return { ok: true, projects: await listProjects(database) };
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    if (!database) {
      reply.code(503);
      return { ok: false, error: { code: "database_unavailable" } };
    }
    const { deleted } = await deleteProject(database, request.params.id);
    if (!deleted) {
      reply.code(404);
      return { ok: false, error: { code: "project_not_found" } };
    }
    return { ok: true, deleted: true };
  });

  app.get("/external-connections", async () => ({
    ok: true,
    data: {
      apiBaseUrl: process.env.GROWTH_OS_PUBLIC_API_URL ?? "http://localhost:3000",
      mcpToolsUrl: "/mcp/tools",
      mcpResourcesUrl: "/mcp/resources",
      safeDataSurface: "queryable schema and shared Infinite OS actions",
      genericSqlTool: false,
      rawPayloadJsonByDefault: false
    }
  }));

  app.post<{ Body: ConnectorOAuthSessionRequestBody }>("/oauth/sessions", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    const provider = normalizeConnectorOAuthProvider(request.body?.provider);
    if (!provider) {
      reply.code(400);
      return { ok: false, error: { code: "oauth_provider_required" } };
    }
    const clientId = stringBodyValue(request.body?.clientId);
    if (!clientId) {
      reply.code(400);
      return { ok: false, error: { code: "oauth_client_id_required" } };
    }
    const session = createConnectorOAuthSession(provider, clientId, request.body ?? {});
    session.workspaceId = request.auth.workspaceId;
    if (database && request.auth.workspaceId) {
      const binding = await bindConnectorOAuthSession(
        database,
        request.auth.workspaceId,
        session,
        request.body ?? {}
      );
      session.oauthAppId = binding.oauthAppId;
      session.oauthAppPayload = binding.payload;
    } else {
      session.oauthAppId = null;
      session.oauthAppPayload = buildSessionConnectorOAuthAppPayload(session, request.body ?? {}, null);
    }
    oauthSessions.set(session.sessionId, session);
    return {
      ok: true,
      sessionId: session.sessionId,
      provider: session.provider,
      state: session.state,
      status: session.status,
      authorizationUrl: session.authorizationUrl,
      redirectUri: session.redirectUri,
      expiresAt: session.expiresAt
    };
  });

  app.get<{ Params: { sessionId: string } }>("/oauth/sessions/:sessionId", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    const session = oauthSessions.get(request.params.sessionId);
    if (!session) {
      reply.code(404);
      return { ok: false, error: { code: "oauth_session_not_found" } };
    }
    if (session.status === "pending" && Date.parse(session.expiresAt) <= Date.now()) {
      session.status = "failed";
      session.error = "expired";
    }
    if (session.workspaceId !== ws) {
      reply.code(400);
      return { ok: false, error: { code: "oauth_workspace_mismatch" } };
    }
    return redactConnectorOAuthSession(session);
  });

  app.post<{
    Params: { sessionId: string };
    Body: ConnectorOAuthExchangeRequestBody;
  }>("/oauth/sessions/:sessionId/exchange", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      reply.code(403);
      return { ok: false, error: { code: "operator_authority_required" } };
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      reply.code(400);
      return { ok: false, error: { code: "unknown_workspace" } };
    }
    const session = oauthSessions.get(request.params.sessionId);
    if (!session) {
      reply.code(404);
      return { ok: false, error: { code: "oauth_session_not_found" } };
    }
    if (session.status === "pending" && Date.parse(session.expiresAt) <= Date.now()) {
      session.status = "failed";
      session.error = "expired";
    }
    if (session.status !== "completed" || !session.code) {
      reply.code(400);
      return { ok: false, error: { code: "oauth_session_not_completed" } };
    }
    if (session.provider !== "google_analytics_4") {
      reply.code(400);
      return { ok: false, error: { code: "oauth_provider_not_supported" } };
    }
    if (session.workspaceId !== ws) {
      reply.code(400);
      return { ok: false, error: { code: "oauth_workspace_mismatch" } };
    }
    try {
      const exchangeBody = mergeConnectorOAuthExchangeBodyWithStoredApp(
        request.body ?? {},
        session.oauthAppPayload ?? null
      );
      const token = await exchangeConnectorOAuthCode(session, exchangeBody);
      const propertyId = stringBodyValue(request.body?.propertyId);
      const persistedOauth =
        database && (!propertyId || process.env.GROWTH_OS_ENCRYPTION_KEY)
          ? await persistConnectorOAuthState(database, ws, session, exchangeBody, token)
          : null;
      if (!propertyId) {
        session.error = undefined;
        return {
          ok: true,
          sessionId: session.sessionId,
          provider: session.provider,
          status: "authorized",
          oauthAppId: persistedOauth?.oauthAppId ?? null,
          oauthTokenId: persistedOauth?.oauthTokenId ?? null
        };
      }
      const envelope = await actionRequest(
        "connect_source",
        {
          provider: session.provider,
          connectionName: stringBodyValue(request.body?.connectionName) ?? "Google Analytics 4",
          credentialKind: "oauth_access_token",
          credentialPayload: {
            mode: "live",
            propertyId,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            apiBaseUrl: stringBodyValue(request.body?.apiBaseUrl)
          }
        },
        "api",
        "operator",
        undefined,
        ws
      );
      session.error = undefined;
      return {
        ok: true,
        sessionId: session.sessionId,
        provider: session.provider,
        status: "connected",
        oauthAppId: persistedOauth?.oauthAppId ?? null,
        oauthTokenId: persistedOauth?.oauthTokenId ?? null,
        envelope
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "oauth_token_exchange_failed",
          message
        }
      };
    }
  });

  app.get<{
    Params: { provider: string };
    Querystring: { sessionId?: string; state?: string; code?: string; error?: string };
  }>("/oauth/callback/:provider", async (request, reply) => {
    // Real OAuth providers redirect a *browser* here. Serve a styled page so the
    // founder sees a friendly "you're done" screen, but keep the JSON contract for
    // programmatic/non-browser callers (the CLI poll path + tests rely on it).
    const wantsHtml = request.headers.accept?.includes("text/html") === true;
    // OAuth providers only round-trip `state` (not arbitrary auth-request params
    // like sessionId), so locate the session by its unguessable `state` token —
    // which also preserves CSRF protection (an unknown state finds no session).
    const callbackState = typeof request.query.state === "string" ? request.query.state : "";
    const session = callbackState
      ? [...oauthSessions.values()].find(
          (candidate) =>
            candidate.state === callbackState && candidate.provider === request.params.provider
        )
      : undefined;
    if (!session) {
      reply.code(404);
      if (wantsHtml) {
        return reply
          .type("text/html")
          .send(oauthCallbackErrorPage("We couldn't find this authorization session."));
      }
      return { ok: false, error: { code: "oauth_session_not_found" } };
    }
    if (request.query.error) {
      session.status = "failed";
      session.error = request.query.error;
      session.completedAt = new Date().toISOString();
      if (wantsHtml) {
        return reply
          .type("text/html")
          .send(oauthCallbackErrorPage("Google reported an authorization error."));
      }
      return { ok: false, status: session.status, provider: session.provider, error: { code: "oauth_provider_error" } };
    }
    if (!request.query.code) {
      reply.code(400);
      if (wantsHtml) {
        return reply
          .type("text/html")
          .send(oauthCallbackErrorPage("This authorization response was missing its code."));
      }
      return { ok: false, error: { code: "oauth_code_required" } };
    }
    session.status = "completed";
    session.code = request.query.code;
    session.completedAt = new Date().toISOString();
    if (wantsHtml) {
      return reply.type("text/html").send(oauthCallbackSuccessPage());
    }
    return {
      ok: true,
      status: session.status,
      provider: session.provider,
      message: "OAuth connection received. You can close this tab and return to Infinite setup."
    };
  });

  async function actionRequest(
    actionId: string,
    input: unknown,
    surface: "api" | "app" | "mcp",
    authority: Authority,
    sessionId = `${surface}-http`,
    workspaceId: string
  ) {
    const context = createSessionContext({
      workspaceId,
      sessionId,
      actorId: authority,
      authority,
      surface
    });
    return registry.execute(actionId, input, context);
  }

  async function guardedAction(
    reply: { code: (statusCode: number) => unknown },
    authority: Authority,
    actionId: string,
    input: unknown,
    surface: "api" | "app" | "mcp",
    workspaceId: string
  ) {
    try {
      return await actionRequest(actionId, input, surface, authority, undefined, workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.includes("operator authority") ? 403 : 400);
      return {
        ok: false,
        error: {
          code: message.includes("operator authority")
            ? "operator_authority_required"
            : "invalid_tool_input",
          message
        }
      };
    }
  }

  function requestedWorkspaceId(value: string | string[] | undefined): string | undefined {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (!candidate) {
      return undefined;
    }
    const trimmed = candidate.trim();
    return trimmed ? trimmed : undefined;
  }

  app.get("/setup/resolved-ids", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      return reply.code(403).send({ ok: false, error: { code: "operator_authority_required" } });
    }
    if (!isLocalHost(request.headers.host)) {
      return reply.code(403).send({ ok: false, error: { code: "invalid_host" } });
    }
    if (!database) {
      // `database` is `InfiniteOsDb | undefined`; strict mode requires this guard.
      return reply.code(503).send({ ok: false, error: { code: "database_unavailable" } });
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      return reply.code(400).send({ ok: false, error: { code: "unknown_workspace" } });
    }
    const artifacts = await readLatestSetupPublicArtifacts(database, ws);
    return {
      ok: true,
      data: artifacts
    };
  });

  app.get("/setup/runs/active", async (request, reply) => {
    if (!database) {
      return reply.code(503).send({ ok: false, error: { code: "database_unavailable" } });
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      return reply.code(400).send({ ok: false, error: { code: "unknown_workspace" } });
    }
    const run = await readSetupRunSummary(database, ws);
    return { ok: true, run };
  });

  app.get<{ Params: { runId: string } }>("/setup/runs/:runId", async (request, reply) => {
    if (!database) {
      return reply.code(503).send({ ok: false, error: { code: "database_unavailable" } });
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      return reply.code(400).send({ ok: false, error: { code: "unknown_workspace" } });
    }
    const run = await readSetupRunSummary(database, ws, request.params.runId);
    if (!run) {
      return reply.code(404).send({ ok: false, error: { code: "setup_run_not_found" } });
    }
    return { ok: true, run };
  });

  app.post<{ Params: { runId: string } }>("/setup/runs/:runId/resume", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      return reply.code(403).send({ ok: false, error: { code: "operator_authority_required" } });
    }
    if (!database) {
      return reply.code(503).send({ ok: false, error: { code: "database_unavailable" } });
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      return reply.code(400).send({ ok: false, error: { code: "unknown_workspace" } });
    }
    const existing = await readSetupRunSummary(database, ws, request.params.runId);
    if (!existing) {
      return reply.code(404).send({ ok: false, error: { code: "setup_run_not_found" } });
    }
    if (existing.status !== "running" && existing.status !== "paused_handoff") {
      return reply.code(409).send({ ok: false, error: { code: "setup_run_not_resumable" } });
    }
    try {
      const resumed = await resumeSetupRun({
        db: database,
        workspaceId: ws,
        runId: request.params.runId,
        registry
      });
      return {
        ...sanitizeResumeSetupRunResult(resumed),
        run: await readSetupRunSummary(database, ws, request.params.runId)
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "setup_run_resume_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  });

  app.post<{ Body: SetupSiteMetadataRequestBody }>("/setup/site-metadata", async (request, reply) => {
    if (request.auth.authority !== "operator") {
      return reply.code(403).send({ ok: false, error: { code: "operator_authority_required" } });
    }
    if (!database) {
      return reply.code(503).send({ ok: false, error: { code: "database_unavailable" } });
    }
    const ws = request.auth.workspaceId;
    if (!ws) {
      return reply.code(400).send({ ok: false, error: { code: "unknown_workspace" } });
    }
    const site = await upsertWorkspaceSite(database, {
      workspaceId: ws,
      url: stringBodyValue(request.body?.url),
      repoPath: stringBodyValue(request.body?.repoPath),
      appDir: stringBodyValue(request.body?.appDir),
      framework: stringBodyValue(request.body?.framework),
      businessType: stringBodyValue(request.body?.businessType)
    });
    return {
      ok: true,
      site: site
        ? {
            id: site.id,
            url: stringBodyValue(request.body?.url) ?? null,
            repoPath: stringBodyValue(request.body?.repoPath) ?? null,
            appDir: stringBodyValue(request.body?.appDir) ?? null,
            framework: stringBodyValue(request.body?.framework) ?? null,
            businessType: stringBodyValue(request.body?.businessType) ?? null
          }
        : null
    };
  });

  return app;
}

function oauthCallbackPage(input: {
  title: string;
  icon: string;
  iconColor: string;
  heading: string;
  body: string;
  autoClose: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: #0b0b0f;
        color: #f4f4f5;
      }
      .card {
        max-width: 420px;
        padding: 40px 32px;
        text-align: center;
        background: #17171c;
        border: 1px solid #26262d;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
      }
      .icon {
        font-size: 48px;
        line-height: 1;
        color: ${input.iconColor};
      }
      h1 { font-size: 20px; margin: 20px 0 8px; }
      p { font-size: 15px; line-height: 1.5; color: #a1a1aa; margin: 0; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="icon">${input.icon}</div>
      <h1>${input.heading}</h1>
      <p>${input.body}</p>
    </main>
    ${input.autoClose ? "<script>setTimeout(() => window.close(), 3000)</script>" : ""}
  </body>
</html>`;
}

function oauthCallbackSuccessPage(): string {
  return oauthCallbackPage({
    title: "Connected to Google Analytics",
    icon: "✓",
    iconColor: "#22c55e",
    heading: "Connected to Google Analytics",
    body: "You can close this tab and return to your terminal.",
    autoClose: true
  });
}

function oauthCallbackErrorPage(message: string): string {
  return oauthCallbackPage({
    title: "Authorization problem",
    icon: "!",
    iconColor: "#ef4444",
    heading: "Authorization didn't complete",
    body: `${message} You can close this tab and return to your terminal.`,
    autoClose: false
  });
}

/** base64url = standard base64 with +→-, /→_, and `=` padding stripped (RFC 4648 §5). */
function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createConnectorOAuthSession(
  provider: string,
  clientId: string,
  body: ConnectorOAuthSessionRequestBody
): ConnectorOAuthSession {
  const sessionId = `oauth_${randomUUID()}`;
  const state = `state_${randomUUID()}`;
  const redirectUri = stringBodyValue(body.redirectUri) ?? defaultConnectorOAuthRedirectUri(provider);
  const authorizationBaseUrl =
    stringBodyValue(body.authorizationBaseUrl) ?? defaultConnectorOAuthAuthorizationBaseUrl(provider);
  const scope = Array.isArray(body.scope) ? body.scope.join(" ") : stringBodyValue(body.scope) ?? defaultConnectorOAuthScope(provider);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    ...(body.extraParams ?? {})
  });
  // PKCE (defense-in-depth) + offline access are GA4-specific so the generic
  // connector-OAuth path is unchanged for any future provider. We still send the
  // client_secret at exchange (Google requires it for installed apps); PKCE is additive.
  let codeVerifier: string | undefined;
  if (provider === "google_analytics_4") {
    // 32 random bytes → 43-char base64url verifier (within RFC 7636's 43-128 range).
    codeVerifier = toBase64Url(randomBytes(32));
    const codeChallenge = toBase64Url(createHash("sha256").update(codeVerifier).digest());
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  const now = Date.now();
  return {
    sessionId,
    provider,
    clientId,
    authorizationBaseUrl,
    scope,
    state,
    status: "pending",
    authorizationUrl: `${authorizationBaseUrl}?${params.toString()}`,
    redirectUri,
    codeVerifier,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString()
  };
}

async function exchangeConnectorOAuthCode(
  session: ConnectorOAuthSession,
  body: ConnectorOAuthExchangeRequestBody
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const tokenUrl = stringBodyValue(body.tokenUrl) ?? defaultConnectorOAuthTokenUrl(session.provider);
  if (!tokenUrl) {
    throw new Error(`No OAuth token URL is configured for ${session.provider}`);
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: session.code ?? "",
    client_id: session.clientId,
    redirect_uri: session.redirectUri
  });
  // PKCE proof — present only for providers where createConnectorOAuthSession set it (GA4).
  if (session.codeVerifier) {
    params.set("code_verifier", session.codeVerifier);
  }
  // Google requires client_secret at exchange even for "Desktop app" clients, so KEEP it.
  const clientSecret = stringBodyValue(body.clientSecret);
  if (clientSecret) {
    params.set("client_secret", clientSecret);
  }
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(stringBodyValue(payload.error_description) ?? stringBodyValue(payload.error) ?? response.statusText);
  }
  const accessToken = stringBodyValue(payload.access_token);
  if (!accessToken) {
    throw new Error("OAuth token response did not include access_token");
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  return {
    accessToken,
    refreshToken: stringBodyValue(payload.refresh_token),
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
  };
}

async function readConnectorOAuthAppState(
  database: InfiniteOsDb,
  workspaceId: string,
  provider: string
): Promise<{ oauthAppId: string; payload: Record<string, unknown> } | null> {
  const row = await database.one<{ id: string; encrypted_payload: string }>(
    `
      select id, encrypted_payload
      from oauth_apps
      where workspace_id = $1
        and provider = $2
        and revoked_at is null
      limit 1
    `,
    [workspaceId, provider]
  );
  if (!row?.id || !row.encrypted_payload) {
    return null;
  }
  return {
    oauthAppId: row.id,
    payload: decryptStoredConnectorOAuthPayload(row.encrypted_payload)
  };
}

function buildSessionConnectorOAuthAppPayload(
  session: ConnectorOAuthSession,
  body: Pick<ConnectorOAuthSessionRequestBody, "clientSecret" | "tokenUrl">,
  storedAppPayload: Record<string, unknown> | null
): Record<string, unknown> | null {
  const merged = mergeConnectorOAuthExchangeBodyWithStoredApp(body, storedAppPayload);
  const payload = buildConnectorOAuthAppPayload(session, merged);
  return stringBodyValue(payload.clientSecret) || stringBodyValue(payload.tokenUrl) ? payload : null;
}

async function bindConnectorOAuthSession(
  database: InfiniteOsDb,
  workspaceId: string,
  session: ConnectorOAuthSession,
  body: ConnectorOAuthSessionRequestBody
): Promise<{ oauthAppId: string | null; payload: Record<string, unknown> | null }> {
  const storedApp = await readConnectorOAuthAppState(database, workspaceId, session.provider);
  const payload = buildSessionConnectorOAuthAppPayload(session, body, storedApp?.payload ?? null);
  const clientSecret = stringBodyValue(body.clientSecret);
  if (!clientSecret || !payload) {
    return {
      oauthAppId: storedApp?.oauthAppId ?? null,
      payload
    };
  }
  return {
    oauthAppId: await upsertConnectorOAuthAppState(database, workspaceId, session, payload),
    payload
  };
}

function mergeConnectorOAuthExchangeBodyWithStoredApp(
  body: ConnectorOAuthExchangeRequestBody,
  storedAppPayload: Record<string, unknown> | null
): ConnectorOAuthExchangeRequestBody {
  return {
    ...body,
    clientSecret: stringBodyValue(body.clientSecret) ?? stringBodyValue(storedAppPayload?.clientSecret),
    tokenUrl: stringBodyValue(body.tokenUrl) ?? stringBodyValue(storedAppPayload?.tokenUrl)
  };
}

async function persistConnectorOAuthState(
  database: InfiniteOsDb,
  workspaceId: string,
  session: ConnectorOAuthSession,
  body: ConnectorOAuthExchangeRequestBody,
  token: { accessToken: string; refreshToken?: string; expiresAt?: string }
): Promise<{ oauthAppId: string; oauthTokenId: string }> {
  const encryptionKey = requiredEncryptionKey();
  const oauthAppId = `oauth_app_${randomUUID()}`;
  const oauthTokenId = `oauth_token_${randomUUID()}`;
  const tokenUrl = stringBodyValue(body.tokenUrl) ?? defaultConnectorOAuthTokenUrl(session.provider);
  const appPayload = buildConnectorOAuthAppPayload(session, body);
  const tokenPayload = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    oauthApp: appPayload
  };

  await upsertConnectorOAuthAppState(database, workspaceId, session, appPayload, oauthAppId);
  await database.query(
    "update oauth_tokens set revoked_at = now() where workspace_id = $1 and provider = $2 and revoked_at is null",
    [workspaceId, session.provider]
  );
  await database.query(
    `
      insert into oauth_tokens (
        id, workspace_id, provider, source_id, encrypted_payload, expires_at, last_rotated_at
      )
      values ($1, $2, $3, null, $4, $5, now())
    `,
    [
      oauthTokenId,
      workspaceId,
      session.provider,
      encryptCredentialPayload(tokenPayload, encryptionKey),
      token.expiresAt ?? null
    ]
  );

  return { oauthAppId, oauthTokenId };
}

function buildConnectorOAuthAppPayload(
  session: ConnectorOAuthSession,
  body: Pick<ConnectorOAuthSessionRequestBody & ConnectorOAuthExchangeRequestBody, "clientSecret" | "tokenUrl">
): Record<string, unknown> {
  const tokenUrl = stringBodyValue(body.tokenUrl) ?? defaultConnectorOAuthTokenUrl(session.provider);
  return {
    clientId: session.clientId,
    clientSecret: stringBodyValue(body.clientSecret),
    redirectUri: session.redirectUri,
    authorizationBaseUrl: session.authorizationBaseUrl,
    tokenUrl: tokenUrl || undefined,
    scope: session.scope
  };
}

async function upsertConnectorOAuthAppState(
  database: InfiniteOsDb,
  workspaceId: string,
  session: ConnectorOAuthSession,
  appPayload: Record<string, unknown>,
  oauthAppId = `oauth_app_${randomUUID()}`
): Promise<string> {
  await database.query(
    `
      insert into oauth_apps (id, workspace_id, provider, encrypted_payload, revoked_at)
      values ($1, $2, $3, $4, null)
      on conflict (workspace_id, provider) do update
      set
        id = excluded.id,
        encrypted_payload = excluded.encrypted_payload,
        revoked_at = null
    `,
    [
      oauthAppId,
      workspaceId,
      session.provider,
      encryptCredentialPayload(appPayload, requiredEncryptionKey())
    ]
  );
  return oauthAppId;
}

function decryptStoredConnectorOAuthPayload(encryptedPayload: string): Record<string, unknown> {
  return decryptCredentialPayload<Record<string, unknown>>(encryptedPayload, requiredEncryptionKey());
}

function redactConnectorOAuthSession(session: ConnectorOAuthSession) {
  return {
    ok: true,
    sessionId: session.sessionId,
    provider: session.provider,
    status: session.status,
    authorizationUrl: session.authorizationUrl,
    redirectUri: session.redirectUri,
    expiresAt: session.expiresAt,
    hasAuthorizationCode: Boolean(session.code),
    error: session.error ?? null
  };
}

function normalizeConnectorOAuthProvider(value: unknown): string | null {
  if (value === "google_analytics_4") {
    return value;
  }
  return null;
}

function sourceIdFromJobPayload(payload: unknown): string | undefined {
  const parsed = typeof payload === "string" ? parseJsonRecord(payload) : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = (parsed as Record<string, unknown>).sourceId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultConnectorOAuthRedirectUri(provider: string): string {
  const apiBaseUrl = process.env.GROWTH_OS_PUBLIC_API_URL ?? process.env.GROWTH_OS_API_URL ?? "http://127.0.0.1:3000";
  return `${apiBaseUrl.replace(/\/$/, "")}/oauth/callback/${provider}`;
}

function defaultConnectorOAuthAuthorizationBaseUrl(provider: string): string {
  if (provider === "google_analytics_4") {
    return "https://accounts.google.com/o/oauth2/v2/auth";
  }
  return "";
}

function defaultConnectorOAuthTokenUrl(provider: string): string {
  if (provider === "google_analytics_4") {
    return "https://oauth2.googleapis.com/token";
  }
  return "";
}

function defaultConnectorOAuthScope(provider: string): string {
  if (provider === "google_analytics_4") {
    return [
      "https://www.googleapis.com/auth/analytics.edit",
      "https://www.googleapis.com/auth/analytics.readonly"
    ].join(" ");
  }
  return "";
}

function requiredEncryptionKey(): string {
  const key = process.env.GROWTH_OS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("GROWTH_OS_ENCRYPTION_KEY is required to store OAuth credentials");
  }
  return key;
}

function stringBodyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function generateCompactSummary(
  sessionStore: ChatSessionStore | undefined,
  modelClient: InfiniteOsModelClient,
  sessionId: string
): Promise<string> {
  const session = await sessionStore?.getSession(sessionId);
  if (!session) {
    return "";
  }
  const response = await modelClient.complete({
    systemPrompt: [
      "Create a compact Infinite OS session summary for continuation.",
      "Preserve user intent, selected sources, metrics/views, action IDs, bounded result summaries, caveats, unresolved questions, and next actions.",
      "Do not preserve credentials, raw provider payloads, unbounded rows, or arbitrary SQL."
    ].join("\n"),
    userMessage: JSON.stringify({
      messages: session.messages,
      actionCalls: session.actionCalls
    }),
    tools: [],
    toolResults: []
  });
  return (response.message ?? "").trim();
}

function sessionStoreDb(database: InfiniteOsDb) {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return database.query(sql, params) as Promise<T[]>;
    },
    async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
      return database.one(sql, params) as Promise<T | null>;
    }
  };
}

interface SetupModuleApi {
  resumeLiveSetupOnboarding(input: {
    db: InfiniteOsDb;
    workspaceId: string;
    runId: string;
    actions: {
      execute(id: string, input: unknown, ctx: ReturnType<typeof createSessionContext>): Promise<unknown>;
    };
    prompt: {
      ask(question: string, choices?: string[]): Promise<string>;
      note(message: string): void;
    };
  }): Promise<{
    selectedProviders: string[];
    recommendedProviders: string[];
    completed: string[];
    paused: string[];
    failed: string[];
    activeRuns: Array<{ id: string; provider?: string; status?: string; pendingHandoff?: { url?: string; instructions?: string } | null }>;
    resolvedPublicArtifacts: Record<string, unknown>;
    installCommand: string | null;
    installArtifactsPath: string | null;
  }>;
}

async function loadSetupModule(): Promise<SetupModuleApi> {
  return loadRuntimeSetupModule(import.meta.url) as Promise<SetupModuleApi>;
}

async function defaultResumeSetupRun(input: {
  db: InfiniteOsDb;
  workspaceId: string;
  runId: string;
  registry: ReturnType<typeof createInfiniteOsRegistry>;
}): Promise<ResumeSetupRunResult> {
  const setup = await loadSetupModule();
  const notes: string[] = [];
  const result = await setup.resumeLiveSetupOnboarding({
    db: input.db,
    workspaceId: input.workspaceId,
    runId: input.runId,
    actions: {
      execute(id, payload, ctx) {
        return input.registry.execute(id, payload, ctx);
      }
    },
    prompt: {
      async ask() {
        return "";
      },
      note(message) {
        notes.push(message);
      }
    }
  });

  return {
    ok: result.failed.length === 0 && result.paused.length === 0,
    resumed: true,
    onboarding: {
      selectedProviders: result.selectedProviders,
      recommendedProviders: result.recommendedProviders,
      completed: result.completed,
      paused: result.paused,
      failed: result.failed,
      activeRuns: result.activeRuns,
      resolvedPublicArtifacts: result.resolvedPublicArtifacts,
      installCommand: result.installCommand ?? null,
      installArtifactsPath: result.installArtifactsPath ?? null
    },
    notes
  };
}

function sanitizeResumeSetupRunResult(result: ResumeSetupRunResult): Record<string, unknown> {
  return {
    ok: result.ok === true,
    resumed: result.resumed === true,
    onboarding: sanitizeResumedOnboarding(result.onboarding),
    notes: stringArray(result.notes)
  };
}

function sanitizeResumedOnboarding(value: ResumeSetupRunResult["onboarding"]): Record<string, unknown> {
  const onboarding = isPlainRecord(value) ? value : {};
  return {
    selectedProviders: stringArray(onboarding.selectedProviders),
    recommendedProviders: stringArray(onboarding.recommendedProviders),
    completed: stringArray(onboarding.completed),
    paused: stringArray(onboarding.paused),
    failed: stringArray(onboarding.failed),
    activeRuns: sanitizeResumedActiveRuns(onboarding.activeRuns),
    resolvedPublicArtifacts: sanitizeResolvedPublicArtifacts(onboarding.resolvedPublicArtifacts),
    // Built from public artifacts only; pass through as a plain string.
    installCommand: typeof onboarding.installCommand === "string" ? onboarding.installCommand : null,
    // Local path of the saved public-keys handoff file; a plain string, never an object.
    installArtifactsPath:
      typeof onboarding.installArtifactsPath === "string" ? onboarding.installArtifactsPath : null
  };
}

function sanitizeResumedActiveRuns(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isPlainRecord)
    .map((entry) => ({
      id: stringOrNull(entry.id),
      provider: stringOrNull(entry.provider),
      status: stringOrNull(entry.status),
      pendingHandoff: sanitizeSetupHandoff(entry.pendingHandoff),
      browserProfile: stringOrNull(entry.browserProfile)
    }));
}

function sanitizeResolvedPublicArtifacts(value: unknown): Record<string, unknown> {
  const artifacts = isPlainRecord(value) ? value : {};
  const ga4 = isPlainRecord(artifacts.ga4) ? artifacts.ga4 : {};
  const posthog = isPlainRecord(artifacts.posthog) ? artifacts.posthog : {};
  const x = isPlainRecord(artifacts.x) ? artifacts.x : {};
  return {
    ga4: {
      measurementId: stringOrNull(ga4.measurementId),
      propertyId: stringOrNull(ga4.propertyId)
    },
    posthog: {
      projectId: stringOrNull(posthog.projectId),
      projectKey: stringOrNull(posthog.projectKey),
      apiHost: stringOrNull(posthog.apiHost)
    },
    x: {
      pixelId: stringOrNull(x.pixelId),
      eventTagIds: stringRecordOrNull(x.eventTagIds)
    }
  };
}

interface ToolCallBody {
  actionId?: string;
  input?: unknown;
  name?: string;
  arguments?: unknown;
}

function toolCallActionId(body: ToolCallBody): string {
  return body.actionId ?? body.name ?? "";
}

function toolCallInput(body: ToolCallBody): unknown {
  return body.input ?? body.arguments ?? {};
}

interface SetupRunSummaryRow {
  id: string;
  workspace_id?: string | null;
  tool?: string | null;
  provider?: string | null;
  status?: string | null;
  phase_state?: Record<string, unknown> | null;
  pending_handoff?: Record<string, unknown> | null;
  browser_profile?: string | null;
  site_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
  site_url?: string | null;
  site_repo_path?: string | null;
  site_app_dir?: string | null;
  site_framework?: string | null;
  site_business_type?: string | null;
}

const SETUP_RUN_SUMMARY_SELECT = `
  select
    r.id,
    r.workspace_id,
    r.tool,
    r.provider,
    r.status,
    r.phase_state,
    r.pending_handoff,
    r.browser_profile,
    r.site_id,
    r.created_at,
    r.updated_at,
    r.finished_at,
    s.url as site_url,
    s.repo_path as site_repo_path,
    s.app_dir as site_app_dir,
    s.framework as site_framework,
    s.business_type as site_business_type
  from setup_runs r
  left join workspace_sites s on s.id = r.site_id
`;

async function readSetupRunSummary(
  database: InfiniteOsDb,
  workspaceId: string,
  runId?: string
): Promise<Record<string, unknown> | null> {
  const row = runId
    ? await database.one<SetupRunSummaryRow>(
      `
        ${SETUP_RUN_SUMMARY_SELECT}
        where r.workspace_id = $1 and r.id = $2
      `,
      [workspaceId, runId]
    )
    : await database.one<SetupRunSummaryRow>(
      `
        ${SETUP_RUN_SUMMARY_SELECT}
        where r.workspace_id = $1 and r.status in ('running', 'paused_handoff')
        order by r.updated_at desc, r.created_at desc
        limit 1
      `,
      [workspaceId]
    );
  return sanitizeSetupRunSummary(row);
}

function sanitizeSetupRunSummary(row: SetupRunSummaryRow | null): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  const phaseState = isPlainRecord(row.phase_state) ? row.phase_state : {};
  const providerEntries = isPlainRecord(phaseState.providers) ? Object.entries(phaseState.providers) : [];
  const providers = Object.fromEntries(
    providerEntries
      .map(([provider, value]) => [provider, sanitizeSetupProviderRunSummary(value)])
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]))
  );
  return {
    id: row.id,
    workspaceId: stringOrNull(row.workspace_id),
    tool: stringOrNull(row.tool),
    provider: stringOrNull(row.provider),
    status: stringOrNull(row.status),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
    finishedAt: stringOrNull(row.finished_at),
    interview: sanitizeSetupInterview(phaseState.interview),
    selectedProviders: stringArray(phaseState.selectedProviders),
    recommendedProviders: stringArray(phaseState.recommendedProviders),
    providers,
    pendingHandoff: sanitizeSetupHandoff(row.pending_handoff),
    browserProfile: stringOrNull(row.browser_profile),
    site: sanitizeSetupSite(row)
  };
}

function sanitizeSetupInterview(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const providerInventory = Array.isArray(value.providerInventory)
    ? value.providerInventory
      .filter(isPlainRecord)
      .map((row) => ({
        provider: stringOrNull(row.provider),
        hasAccount: typeof row.hasAccount === "boolean" ? row.hasAccount : undefined,
        installState: stringOrNull(row.installState),
        selected: typeof row.selected === "boolean" ? row.selected : undefined,
        recommended: typeof row.recommended === "boolean" ? row.recommended : undefined
      }))
    : [];
  return {
    projectName: stringOrNull(value.projectName),
    websiteUrl: stringOrNull(value.websiteUrl),
    productSurface: stringOrNull(value.productSurface),
    providerInventory
  };
}

function sanitizeSetupProviderRunSummary(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const phases = isPlainRecord(value.phases)
    ? Object.fromEntries(
      Object.entries(value.phases)
        .filter(([, phase]) => isPlainRecord(phase))
        .map(([phase, result]) => [phase, {
          status: stringOrNull((result as Record<string, unknown>).status),
          detail: stringOrNull((result as Record<string, unknown>).detail)
        }])
    )
    : {};
  const verification = isPlainRecord(value.verification)
    ? {
        installStatus: stringOrNull(value.verification.installStatus),
        queryabilityStatus: stringOrNull(value.verification.queryabilityStatus),
        lastCheckedAt: stringOrNull(value.verification.lastCheckedAt)
      }
    : null;
  return {
    inventory: isPlainRecord(value.inventory)
      ? {
          provider: stringOrNull(value.inventory.provider),
          hasAccount: typeof value.inventory.hasAccount === "boolean" ? value.inventory.hasAccount : undefined,
          installState: stringOrNull(value.inventory.installState),
          selected: typeof value.inventory.selected === "boolean" ? value.inventory.selected : undefined,
          recommended: typeof value.inventory.recommended === "boolean" ? value.inventory.recommended : undefined
        }
      : null,
    phases,
    verification
  };
}

function sanitizeSetupHandoff(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  return {
    kind: stringOrNull(value.kind),
    url: sanitizePublicSetupUrl(value.url),
    instructions: stringOrNull(value.instructions)
  };
}

function sanitizePublicSetupUrl(value: unknown): string | null {
  const candidate = stringOrNull(value);
  if (!candidate) {
    return candidate;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return candidate;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return candidate;
  }
}

function sanitizeSetupSite(row: SetupRunSummaryRow): Record<string, unknown> | null {
  if (!row.site_id && !row.site_url && !row.site_repo_path && !row.site_app_dir && !row.site_framework && !row.site_business_type) {
    return null;
  }
  return {
    id: stringOrNull(row.site_id),
    url: stringOrNull(row.site_url),
    repoPath: stringOrNull(row.site_repo_path),
    appDir: stringOrNull(row.site_app_dir),
    framework: stringOrNull(row.site_framework),
    businessType: stringOrNull(row.site_business_type)
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringRecordOrNull(value: unknown): Record<string, string> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  // Handle bracketed IPv6 ("[::1]:3000") as well as "host:port".
  const h = host.replace(/^\[/, "").split(/[\]:]/)[0].toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

// Is THIS module the process entrypoint (run directly, e.g. `node daemon.mjs` or `tsx index.ts`)?
// A raw `import.meta.url === file://${process.argv[1]}` string compare is fragile: it breaks on
// symlinked paths (macOS /tmp → /private/var/folders, app-bundle symlinks), on path encoding
// (spaces → %20 in the URL but not in argv), and on the esbuild bundle run via node — any of which
// silently skips the listen block. Compare symlink-resolved REAL paths instead.
function isProcessEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isProcessEntrypoint()) {
  const config = loadInfiniteOsConfig();
  const app = createApp({ databaseUrl: config.databaseUrl });

  // C — Cross-process spawn lock: prevent two cold-starts (CLI + desktop) from
  // both running migrations / binding the same port concurrently. Acquire BEFORE
  // runMigrations; release AFTER writeDaemonDescriptor so a concurrent starter
  // can re-check the descriptor and find a healthy daemon.
  //
  // If another live process holds the lock, poll for a healthy descriptor for up
  // to 15 s and exit 0 to defer (the other starter will finish). If it never
  // appears (the other start died without writing a descriptor), exit 0 anyway —
  // a supervisor / desktop will retry and we'll reclaim the stale lock via TTL.
  const spawnLock = acquireDaemonSpawnLock();
  if (spawnLock === null) {
    // Another process is mid-spawn. Poll for a healthy daemon descriptor.
    const POLL_INTERVAL_MS = 500;
    const POLL_TIMEOUT_MS = 15_000;
    const pollStart = Date.now();
    let healthy = false;
    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      const desc = (await import("./daemon-descriptor.js")).readDaemonDescriptor();
      if (desc) {
        try {
          const res = await fetch(`${desc.url}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
          // not up yet — keep polling
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (healthy) {
      console.log("another daemon is already starting on this home; deferring");
    } else {
      // The other starter seems to have died without finishing. Exit 0 — a
      // supervisor / desktop will re-resolve and we'll reclaim the stale lock.
      console.log("spawn lock held but no healthy daemon appeared; deferring (supervisor will retry)");
    }
    process.exit(0);
  }

  // Register lock release on SIGTERM/SIGINT/onClose so a crash before descriptor-
  // write still frees the lock. The TTL is the ultimate backstop, but belt-and-
  // suspenders keeps the average-case wait near zero.
  const releaseLockOnShutdown = () => spawnLock.release();
  app.addHook("onClose", async () => {
    releaseLockOnShutdown();
  });

  // A LOCAL daemon owns its schema. The desktop spawns this entrypoint against a freshly-created
  // embedded PGlite data dir (DATABASE_URL=pglite://…) that has NO tables, so EVERY DB request would
  // 500 with "relation … does not exist" until something migrates it. Bring the schema up to date on
  // boot BEFORE we listen/announce. runMigrations is idempotent (re-applies 0 when current), so a
  // CLI that already ran `infinite setup` just no-ops. NETWORK (prod) mode is intentionally NOT
  // auto-migrated — there migrations stay a controlled deploy step against the shared Postgres.
  if (config.runtimeMode === "local") {
    // local mode covers BOTH embedded PGlite AND a local/dev real-Postgres DATABASE_URL — both are
    // self-contained and idempotently re-migrated here; only NETWORK/prod is left to a deploy step.
    try {
      const applied = await runMigrations(config.databaseUrl);
      if (applied.length > 0) {
        app.log.info?.({ count: applied.length }, "applied pending migrations on boot (local mode)");
      }
      // Migrations create SCHEMA, not rows. A fresh self-contained DB has an EMPTY workspaces table,
      // so the auth hook (select 1 from workspaces where id=$1) rejects every workspace-scoped
      // request with unknown_workspace. Seed a default "Local" workspace (idempotent upsert) so a
      // freshly-spawned daemon can serve immediately; a client discovers its id via GET /projects.
      // The id is overridable via GROWTH_OS_WORKSPACE_ID. This opens a short-lived db just for the
      // seed (a separate, SEQUENTIAL PGlite open after runMigrations closed its own, before the app's
      // lazy db opens on the first request — PGlite handles sequential opens of one data dir fine,
      // live-verified). We deliberately do NOT share createApp's db: createApp only closes the db it
      // creates itself (not a passed-in one), so sharing would force us to own that close lifecycle —
      // more risk than the one-time first-boot cost of an extra open.
      const localWorkspaceId = process.env.GROWTH_OS_WORKSPACE_ID?.trim() || "ws_local";
      const seedDb = createInfiniteOsDb(config.databaseUrl);
      try {
        await seedDb.ensureWorkspace(localWorkspaceId, "Local");
      } finally {
        await seedDb.close();
      }
    } catch (err) {
      // A daemon with a broken/half-applied schema (or an unseedable DB) must NOT serve. Fail loud
      // with a clear cause (not an opaque unhandled rejection) and exit so the desktop/supervisor
      // surfaces it. Safe to exit here: this runs before listen + before the keystone descriptor.
      // console.error too — app.log may be a no-op (default Fastify logger), and a FATAL that exits
      // the process MUST be visible (an `app.log.error?.` alone silently swallowed it in the bundle).
      console.error("FATAL: boot migration/seed failed; refusing to start:", err);
      app.log.error?.({ err }, "FATAL: boot migration/seed failed; refusing to start");
      process.exit(1);
    }
  }

  // C2 keystone: announce the live daemon so the desktop can discover it instead of
  // guessing the port. Register the cleanup hook BEFORE listen — Fastify v5 forbids
  // addHook once the instance is listening — so app.close() (SIGTERM/SIGINT/graceful
  // shutdown) removes the descriptor and never leaves a stale file pointing at a dead
  // port. Removal is scoped to this standalone entrypoint, the only place a descriptor
  // is written, so in-process app.inject() callers (tests) never touch the file.
  app.addHook("onClose", async () => {
    removeDaemonDescriptor();
  });

  // SIGTERM/SIGINT must run app.close() so the onClose hook fires. Fastify does NOT
  // close itself on signals — a bare SIGTERM would terminate the process abruptly and
  // leave a stale descriptor pointing at a now-dead port. Wire the handlers BEFORE
  // listen so a signal during early startup is still handled. Guard against double
  // invocation (SIGINT then SIGTERM) so close runs exactly once.
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    void app
      .close()
      .catch(() => {
        // app.close() already ran the onClose descriptor cleanup; swallow so a
        // teardown error never blocks exit.
      })
      .finally(() => {
        // Belt-and-suspenders: if app.close() rejected BEFORE the onClose hook ran
        // (e.g. it threw mid-teardown), the descriptor would survive. Remove it
        // directly here too — removeDaemonDescriptor is idempotent (force + swallow),
        // so a normal shutdown that already cleaned up just no-ops.
        removeDaemonDescriptor();
        // Belt-and-suspenders for the spawn lock too: the onClose hook already
        // called release(); calling again is idempotent (released flag guards it).
        releaseLockOnShutdown();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await app.listen({ host: config.appHost, port: config.appPort });

  // config.appPort may be 0 (ephemeral) — the OS-assigned port is only knowable
  // AFTER listen resolves, via the bound socket address. The descriptor is
  // discovery-only: NO tokens.
  const bound = app.server.address();
  // FIX B3: pass advertisedUrl through the descriptor input so the option is
  // actually threaded (not just read from env inside buildDaemonDescriptor).
  // The env var GROWTH_OS_ADVERTISED_URL still takes precedence (docker-compose
  // sets it); the input.advertisedUrl acts as a programmatic fallback for callers
  // that construct the URL without touching env (e.g. integration tests).
  const advertisedUrl = process.env.GROWTH_OS_ADVERTISED_URL?.trim() || undefined;
  const descriptor = buildDaemonDescriptor({
    address: bound as BoundAddress | string | null,
    advertisedUrl
  });
  const { path: descriptorPath } = writeDaemonDescriptor(descriptor);
  app.log.info?.({ url: descriptor.url, descriptor: descriptorPath }, "daemon descriptor written");
  // Release the spawn lock NOW — the descriptor is written, so a concurrent
  // starter that was polling will find a healthy daemon and exit gracefully
  // rather than waiting for the full TTL.
  spawnLock.release();
}
