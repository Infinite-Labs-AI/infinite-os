import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import type { InfiniteOsDb } from "@infinite-os/db";
import type { ChatSessionStore } from "@infinite-os/llm-controller";
import { createApp } from "../src/index.js";

// A desktop Codex union turn no longer offers the engine's writes (authority "operator"): the model's call to one is
// refused as an unknown action inside the turn. The desktop's own Meta writes do not ride the chat: its LOCAL lane
// (1bu-1 apps/desktop/src/main/ads/engine-action.ts) calls executeOperatorAction, which POSTs /tools/call with the
// operator token (apps/desktop/src/main/daemon-http.ts executeOperatorAction). That route, and the named /meta/*
// routes, run guardedAction → registry.execute with operator authority, never the chat's per-turn tool set. This
// pins both sides in one daemon: the union turn refuses, the direct operator calls still write.

const OPERATOR_TOKEN = "operator-token";
const READ_TOKEN = "read-token";
const WORKSPACE = "proj_meta";
const ENCRYPTION_KEY = "union-operator-path-key";
const META_TOKEN = "meta-system-user-token";
const OPERATOR = { authorization: `Bearer ${OPERATOR_TOKEN}`, "x-growth-os-workspace": WORKSPACE };
const READ = { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE };

interface AuditRow {
  actorType: string;
  action: string;
  status: string;
}

interface GraphCall {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, string>;
}

/** Serves the workspace probe, one connected Meta source with an encrypted stored token, audits and dedup claims. */
function metaDb(audits: AuditRow[]): InfiniteOsDb {
  const claims = new Set<string>();
  const db = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("insert into integration_audit_log")) {
        audits.push({ actorType: String(params?.[3]), action: String(params?.[4]), status: String(params?.[5]) });
      }
      if (sql.includes("from sources") && sql.includes("provider = 'meta_ads'")) {
        return [{ id: "src_meta" }];
      }
      return [];
    },
    async one(sql: string, params?: unknown[]) {
      if (sql.includes("from workspaces")) {
        return { ok: 1 };
      }
      if (sql.includes("from sources")) {
        return { provider: "meta_ads", account_external_id: "act_999" };
      }
      if (sql.includes("from connection_credentials")) {
        return {
          credential_kind: "system_user_token",
          encrypted_payload: encryptCredentialPayload(
            { mode: "live", transport: "marketing_api", adAccountId: "act_999", accessToken: META_TOKEN, apiVersion: "v25.0" },
            ENCRYPTION_KEY
          ),
          oauth_token_id: null
        };
      }
      if (sql.includes("insert into meta_write_dedup")) {
        const token = String(params?.[3]);
        if (claims.has(token)) return null;
        claims.add(token);
        return { id: String(params?.[0]) };
      }
      return null;
    },
    async close() {},
    async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    }
  };
  return db as unknown as InfiniteOsDb;
}

function recordingSessionStore(recorded: Array<{ actionId: string; authority: string; requiresConfirmation: boolean }>): ChatSessionStore {
  return {
    async ensureSession() {},
    async appendMessage() {},
    async recordActionCall(input) {
      recorded.push({ actionId: input.actionId, authority: input.authority, requiresConfirmation: input.requiresConfirmation });
    },
    async getPendingActionCall() {
      return null;
    },
    async listSessions() {
      return [];
    },
    async getSession() {
      return null;
    },
    async searchSessions() {
      return [];
    },
    async resumeSession() {},
    async endSession() {},
    async compactSession(input) {
      return { sessionId: input.newSessionId ?? "s", parentSessionId: input.sessionId };
    }
  };
}

// The three writes the desktop's local lane sends (pause/unpause, budget, paused create), each through /tools/call and
// through its named route.
const WRITES = [
  {
    actionId: "update_meta_budget",
    route: "/meta/budget",
    input: { sourceId: "src_meta", entityId: "120000000000555", entity: "adset", dailyBudget: 8000 },
    expectPost: { url: "https://graph.facebook.com/v25.0/120000000000555", body: { daily_budget: "8000" } }
  },
  {
    actionId: "set_meta_entity_status",
    route: "/meta/status",
    input: { sourceId: "src_meta", entityId: "120000000000556", entity: "adset", status: "ACTIVE", confirmActivation: "120000000000556" },
    expectPost: { url: "https://graph.facebook.com/v25.0/120000000000556", body: { status: "ACTIVE" } }
  },
  {
    actionId: "create_meta_ad_set",
    route: "/meta/adsets",
    input: { sourceId: "src_meta", campaignId: "120000000000001", name: "Spring", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" },
    expectPost: { url: "https://graph.facebook.com/v25.0/act_999/adsets", body: { status: "PAUSED", name: "Spring" } }
  }
] as const;

describe("union withholding leaves the desktop's direct operator path intact", () => {
  let graphCalls: GraphCall[];

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    vi.stubEnv("GROWTH_OS_ENCRYPTION_KEY", ENCRYPTION_KEY);
    vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", OPERATOR_TOKEN);
    vi.stubEnv("GROWTH_OS_READ_TOKEN", READ_TOKEN);
    graphCalls = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : "").entries());
      const method = init?.method ?? "GET";
      graphCalls.push({ url, method, authorization: headers.Authorization ?? headers.authorization ?? null, body });
      // The budget write first reads the entity's budget type (a daily-budget ad set here).
      const payload = method === "GET"
        ? { id: "120000000000555", daily_budget: "4000", lifetime_budget: "0" }
        : url.endsWith("/adsets")
          ? { id: "120000000000888" }
          : { success: true };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("refuses the model's writes in a union turn, then runs the same writes through /tools/call and /meta/* as operator", async () => {
    const audits: AuditRow[] = [];
    const recorded: Array<{ actionId: string; authority: string; requiresConfirmation: boolean }> = [];
    const modelRequests: Array<{ tools: Array<{ name: string }>; toolResults: Array<{ name: string; result: unknown }> }> = [];
    const app = createApp({
      database: metaDb(audits),
      sessionStore: recordingSessionStore(recorded),
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request as (typeof modelRequests)[number]);
          if (request.toolResults.length === 0) {
            return { toolCalls: WRITES.map((write, index) => ({ id: `call_${index}`, name: write.actionId, input: write.input })) };
          }
          return { message: "I can't change that from here." };
        }
      }
    });
    try {
      // 1) The desktop Codex union turn: the engine writes are not offered, and a call to one is refused.
      const turn = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR,
        payload: {
          platform: "desktop",
          message: "raise the spring ad set's budget to $80, turn it on, and add a new ad set",
          appTools: {
            serverName: "infinite_app",
            mode: "union",
            allowedTools: ["mcp__infinite_app__propose_meta_budget"],
            tools: [{ name: "propose_meta_budget", description: "Propose a Meta budget change.", inputSchema: { type: "object" } }],
            proxy: { type: "mcp-jsonrpc-http", url: "http://127.0.0.1:18181/mcp" }
          }
        }
      });
      expect(turn.statusCode).toBe(200);
      expect(turn.json()).toMatchObject({ ok: true, message: "I can't change that from here." });
      const advertised = modelRequests[0]?.tools.map((tool) => tool.name) ?? [];
      for (const write of WRITES) {
        expect(advertised).not.toContain(write.actionId);
      }
      expect(turn.json().actionCalls).toEqual(WRITES.map((write) => expect.objectContaining({
        actionId: write.actionId,
        status: "error",
        requiresConfirmation: false,
        error: expect.objectContaining({ code: "unknown_action" })
      })));
      expect(recorded).toEqual(WRITES.map((write) => ({ actionId: write.actionId, authority: "tool_agent", requiresConfirmation: false })));
      expect(graphCalls).toEqual([]);
      expect(audits).toEqual([]);

      // 2) The desktop's local lane, same daemon, after that turn: each write executes with operator authority.
      for (const write of WRITES) {
        for (const [url, payload] of [
          ["/tools/call", { actionId: write.actionId, input: write.input }],
          [write.route, write.input]
        ] as const) {
          graphCalls = [];
          const response = await app.inject({ method: "POST", url, headers: OPERATOR, payload });
          expect(response.statusCode, `${write.actionId} via ${url}`).toBe(200);
          expect(response.json(), `${write.actionId} via ${url}`).toMatchObject({
            ok: true,
            actionId: write.actionId,
            authority: "operator",
            status: "ok"
          });
          const post = graphCalls.find((call) => call.method === "POST");
          expect(post?.url, `${write.actionId} via ${url}`).toBe(write.expectPost.url);
          expect(post?.body, `${write.actionId} via ${url}`).toMatchObject(write.expectPost.body);
          expect(post?.authorization).toBe(`Bearer ${META_TOKEN}`);
          expect(audits.at(-1), `${write.actionId} via ${url}`).toEqual({ actorType: "operator", action: write.actionId, status: "succeeded" });
        }
      }

      // 3) The read token still cannot write on either route (unchanged).
      for (const write of WRITES) {
        for (const [url, payload] of [
          ["/tools/call", { actionId: write.actionId, input: write.input }],
          [write.route, write.input]
        ] as const) {
          const denied = await app.inject({ method: "POST", url, headers: READ, payload });
          expect(denied.statusCode, `${write.actionId} via ${url}`).toBe(403);
          expect(denied.json()).toMatchObject({ error: { code: "operator_authority_required" } });
        }
      }
    } finally {
      await app.close();
    }
  });
});
