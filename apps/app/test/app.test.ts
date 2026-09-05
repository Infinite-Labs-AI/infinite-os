import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { decryptCredentialPayload } from "@infinite-os/core";
import { EMBEDDED_ONLY_READ_ACTIONS } from "@infinite-os/types";
import { createApp } from "../src/index.js";
import type { ChatSessionStore } from "@infinite-os/llm-controller";
import type { InfiniteOsDb } from "@infinite-os/db";

// The deny-by-default onRequest hook authenticates the install token and validates
// the requested workspace against the `workspaces` table. Tests set these tokens so
// guarded routes return real behavior (not 401), send a Bearer header, and — for
// workspace-scoped routes — an `x-growth-os-workspace` header backed by a fake
// db.one that answers the `select 1 ... from workspaces` probe truthily.
const OPERATOR_TOKEN = "operator-token";
const READ_TOKEN = "read-token";
const WORKSPACE = "proj_test";
const OTHER_WORKSPACE = "proj_other";
const OPERATOR_HEADERS = {
  authorization: `Bearer ${OPERATOR_TOKEN}`,
  "x-growth-os-workspace": WORKSPACE
};

function operatorHeadersFor(workspaceId: string) {
  return {
    authorization: `Bearer ${OPERATOR_TOKEN}`,
    "x-growth-os-workspace": workspaceId
  };
}

describe("Infinite OS app-hosted API/MCP skeleton", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.DATABASE_URL = "postgres://test";
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    process.env.GROWTH_OS_OPERATOR_TOKEN = OPERATOR_TOKEN;
    process.env.GROWTH_OS_READ_TOKEN = READ_TOKEN;
  });

  afterEach(() => {
    process.env = savedEnv;
  });
  it("serves health and MCP tool manifests", async () => {
    const app = createApp();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({
      status: "ok",
      service: "growth-os-app"
    });

    const tools = await app.inject({
      method: "GET",
      url: "/mcp/tools",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    expect(tools.json().tools.map((tool: { name: string }) => tool.name)).not.toContain(
      "resolve_question"
    );

    const recipes = await app.inject({
      method: "GET",
      url: "/recipes",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    expect(recipes.json().recipes.map((recipe: { id: string }) => recipe.id)).toContain(
      "save_export_report"
    );
  });

  it("publishes explicit /health capabilities so external-daemon gating is by-feature, not version-guessing", async () => {
    const app = createApp();
    // /health is unauthenticated (public discovery surface) — no Bearer needed.
    const health = await app.inject({ method: "GET", url: "/health" });
    const body = health.json();
    // Backward-compatible: the pre-existing liveness fields are unchanged.
    expect(body).toMatchObject({ status: "ok", service: "growth-os-app" });
    // ADD-ONLY capabilities array the desktop can gate on. Both the scoped-app-tools
    // flag (PR #76) and the Meta budget-write capability (general + exact action id)
    // must be present so the desktop never has to guess from the version string.
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        "scoped_app_tools",
        "scoped_app_tools_union",
        "meta_budget_writes",
        "update_meta_budget",
        // Phase-2 native-analytics removal: the new daemon generation announces that
        // its registry no longer carries the local-store analytics family.
        "native_analytics_removed",
        // Live Meta insights read — the desktop fails CLOSED on this flag before
        // dispatching run_meta_live_insights to a daemon.
        "meta_live_insights"
      ])
    );
  });

  it("permanently removes the local-store analytics family from the daemon surface (Phase-2)", async () => {
    // The deletion gate for this behavior is the Phase-1 verification artifact
    // (docs/verification/2026-07-10-phase1-cloud-reads-verification.md in the
    // cloud repo): cloud reads were verified live before the natives died here.
    const app = createApp({ database: workspaceProbeDb() });

    // 1) No retired id is ADVERTISED — /mcp/tools and /capabilities both ride
    //    registry.list(), which createDaemonActionRegistry filters.
    const tools = await app.inject({
      method: "GET",
      url: "/mcp/tools",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    const toolEntries = tools.json().tools as Array<{ name: string; recommendedNextActions?: string[] }>;
    const toolNames = toolEntries.map((tool) => tool.name);
    for (const retired of EMBEDDED_ONLY_READ_ACTIONS) {
      expect(toolNames).not.toContain(retired);
    }
    // The surviving natives stay advertised — including the Meta live-Graph reads
    // (never local-store liars) and the sync/inventory family.
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "list_sources",
        "describe_source",
        "get_recent_sync_runs",
        "sync_source_now",
        "search_context",
        "validate_journey_plan",
        "list_meta_assets",
        "list_meta_entities",
        "get_meta_entity",
        "run_meta_live_insights"
      ])
    );
    // No surviving card nudges the model toward a retired id.
    const retiredSet = new Set<string>(EMBEDDED_ONLY_READ_ACTIONS);
    for (const tool of toolEntries) {
      for (const next of tool.recommendedNextActions ?? []) {
        expect(retiredSet.has(next)).toBe(false);
      }
    }
    // Catalog budget (Phase-2 acceptance): every advertised native summary fits
    // the 500-char description budget the desktop union catalog enforces.
    for (const tool of tools.json().tools as Array<{ name: string; summary?: string }>) {
      expect((tool.summary ?? "").length).toBeLessThanOrEqual(500);
    }

    const capabilities = await app.inject({
      method: "GET",
      url: "/capabilities",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    const capabilityActionIds = (capabilities.json().data.actions as Array<{ id: string }>).map(
      (action) => action.id
    );
    for (const retired of EMBEDDED_ONLY_READ_ACTIONS) {
      expect(capabilityActionIds).not.toContain(retired);
    }

    // 2) No retired id is EXECUTABLE — /tools/call answers a typed error, never
    //    a data envelope that could carry silent empty-store zeros.
    const call = await app.inject({
      method: "POST",
      url: "/tools/call",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE },
      payload: { actionId: "run_metric_query", input: { metric: "recognized_revenue" } }
    });
    expect(call.statusCode).toBe(400);
    expect(call.json()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Unknown Infinite OS action") }
    });
  });

  it("keeps the retired-metadata HTTP data routes serving via the direct handler map", async () => {
    // /schema, /queryable/views, /metrics and /source-health are the daemon's
    // plain data API (non-model callers). They survive the registry removal by
    // dialing the handler map directly.
    const app = createApp({ database: workspaceProbeDb() });
    const authed = { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE };
    const metrics = await app.inject({ method: "GET", url: "/metrics", headers: authed });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({ actionId: "list_metrics", authority: "tool_agent" });
    const schema = await app.inject({ method: "GET", url: "/schema", headers: authed });
    expect(schema.statusCode).toBe(200);
    expect(schema.json()).toMatchObject({ actionId: "list_queryable_views" });
    const views = await app.inject({ method: "GET", url: "/queryable/views", headers: authed });
    expect(views.statusCode).toBe(200);
    expect(views.json()).toMatchObject({ actionId: "list_queryable_views" });
    const sourceHealth = await app.inject({ method: "GET", url: "/source-health", headers: authed });
    expect(sourceHealth.statusCode).toBe(200);
    expect(sourceHealth.json()).toMatchObject({ actionId: "describe_queryable_view" });
  });

  it("enforces operator authority for operator MCP tool calls", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const response = await app.inject({
      method: "POST",
      url: "/mcp/tools/call",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE },
      payload: { actionId: "start_source_sync", input: { sourceId: "source-1" } }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "operator_authority_required" }
    });
  });

  it("preserves typed connector errors from guarded source routes", async () => {
    // A typed connector error (string code + boolean retryable) thrown by an action handler
    // must surface as-is through guardedAction instead of collapsing to invalid_tool_input.
    const app = createApp({
      database: workspaceProbeDb({
        sourceLookupError: Object.assign(new Error("X bearer token was rejected. Reconnect the X source."), {
          code: "provider_auth_failed",
          retryable: false
        })
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/sources/src_x/reconnect",
      headers: OPERATOR_HEADERS,
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "provider_auth_failed",
        message: expect.stringContaining("rejected"),
        retryable: false
      }
    });
  });

  it("does not surface arbitrary system error codes through guarded source routes", async () => {
    const app = createApp({ database: workspaceProbeDb({ sourceLookupErrorCode: "ECONNRESET" }) });

    const response = await app.inject({
      method: "POST",
      url: "/sources/src_x/reconnect",
      headers: OPERATOR_HEADERS,
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "invalid_tool_input",
        message: "source lookup failed"
      }
    });
  });

  it("denies a tool_agent (read token) Meta write route with 403", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    // Each Meta write route is operator-only; a read token resolves to tool_agent.
    const routes = ["/meta/campaigns", "/meta/adsets", "/meta/creatives", "/meta/ads", "/meta/status", "/meta/budget"];
    for (const url of routes) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE },
        payload: { sourceId: "src_meta", name: "X", objective: "OUTCOME_SALES" }
      });
      expect(response.statusCode, `${url} should 403 for tool_agent`).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "operator_authority_required" }
      });
    }
  });

  it("denies a tool_agent delete_meta_entity via /tools/call with 403 (operator-only)", async () => {
    // FIX 2: the CLI fires delete via the generic /tools/call route (dispatch by
    // actionId), which goes through guardedAction → assertAuthority. Because
    // delete_meta_entity is an OPERATOR action, a tool_agent (read token) can
    // NEVER delete — it 403s before any DELETE reaches the connector.
    const app = createApp({ database: workspaceProbeDb() });
    for (const url of ["/tools/call", "/mcp/tools/call"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE },
        payload: { actionId: "delete_meta_entity", input: { sourceId: "src_meta", entityId: "120000000000000001" } }
      });
      expect(response.statusCode, `${url} delete_meta_entity should 403 for tool_agent`).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "operator_authority_required" }
      });
    }
  });

  it("does not register the public deterministic resolve-question route", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const response = await app.inject({
      method: "POST",
      url: "/tools/resolve-question",
      headers: OPERATOR_HEADERS,
      payload: { question: "What changed?" }
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not register a generic POST /chat route", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: OPERATOR_HEADERS,
      payload: { message: "How much revenue this month?", sessionId: "session-1" }
    });

    expect(response.statusCode).toBe(404);
  });

  it("accepts operator-authenticated gateway turns without exposing generic chat", async () => {
    const modelRequests: unknown[] = [];
    const sessionEvents: unknown[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession(input) {
        sessionEvents.push(["ensureSession", input.sessionId, input.actorId, input.surface, input.workspaceId]);
      },
      async appendMessage(input) {
        sessionEvents.push(["appendMessage", input.sessionId, input.role, input.content]);
      },
      async recordActionCall() {},
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
        return { sessionId: input.newSessionId ?? input.sessionId, parentSessionId: input.sessionId };
      }
    };
    const app = createApp({
      database: workspaceProbeDb(),
      sessionStore,
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request);
          return { message: "Stripe revenue is up this month." };
        }
      }
    });

    try {
      const denied = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: { "x-growth-os-workspace": WORKSPACE },
        payload: { platform: "slack", actorId: "user-1", channelId: "channel-1", message: "Revenue?" }
      });
      const missingMessage = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: { platform: "slack" }
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: { platform: "slack", actorId: "user-1", channelId: "channel-1", message: "Revenue?" }
      });

      expect(denied.statusCode).toBe(401);
      expect(missingMessage.statusCode).toBe(400);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        ok: true,
        platform: "slack",
        channelId: "channel-1",
        actorId: "user-1",
        // The RESPONSE sessionId is UNqualified (no `:<ws>`) so the client can round-trip it
        // safely — re-qualification on the next turn is idempotent. (The INTERNAL controller key
        // is still workspace-qualified; see the ensureSession assertion below.)
        sessionId: `slack:channel-1:user-1`,
        message: "Stripe revenue is up this month."
      });
      expect((modelRequests[0] as { userMessage: string }).userMessage).toBe("Revenue?");
      // The controller sees the workspace-qualified session key; an unknown
      // platform ("slack") maps to the "api" surface default.
      expect(sessionEvents[0]).toEqual([
        "ensureSession",
        `slack:channel-1:user-1:${WORKSPACE}`,
        "user-1",
        "api",
        WORKSPACE
      ]);

      // A "desktop" platform maps to the "desktop" RuntimeSurface (B2.5). The RESPONSE sessionId
      // is UNqualified for round-trip safety; the internal ensureSession key stays qualified.
      const desktopTurn = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: { platform: "desktop", actorId: "user-1", channelId: "channel-1", message: "Revenue?" }
      });
      expect(desktopTurn.statusCode).toBe(200);
      expect(desktopTurn.json()).toMatchObject({
        platform: "desktop",
        sessionId: `desktop:channel-1:user-1`
      });
      const desktopEnsure = (sessionEvents as Array<[string, string, string, string, string]>).find(
        (event) => event[0] === "ensureSession" && event[1] === `desktop:channel-1:user-1:${WORKSPACE}`
      );
      expect(desktopEnsure).toEqual([
        "ensureSession",
        `desktop:channel-1:user-1:${WORKSPACE}`,
        "user-1",
        "desktop",
        WORKSPACE
      ]);
    } finally {
      // env restored by afterEach
    }
  });

  it("rejects scoped app-tool gateway turns with non-loopback proxy URLs before model execution", async () => {
    const modelClient = { complete: vi.fn(async () => ({ message: "should not run" })) };
    const app = createApp({ database: workspaceProbeDb(), modelClient });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/turn",
      headers: OPERATOR_HEADERS,
      payload: {
        platform: "desktop",
        message: "Use scoped tools.",
        appTools: {
          serverName: "infinite_app",
          allowedTools: ["mcp__infinite_app__ads_*"],
          tools: [
            {
              name: "ads_call_tool",
              description: "Call Ads tool.",
              inputSchema: { type: "object", additionalProperties: true }
            }
          ],
          proxy: {
            type: "mcp-jsonrpc-http",
            url: "https://example.com/mcp"
          }
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_scoped_app_tools" }
    });
    expect(modelClient.complete).not.toHaveBeenCalled();
  });

  it("rejects scoped app-tool gateway turns with an unknown mode before model execution", async () => {
    const modelClient = { complete: vi.fn(async () => ({ message: "should not run" })) };
    const app = createApp({ database: workspaceProbeDb(), modelClient });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/turn",
      headers: OPERATOR_HEADERS,
      payload: {
        platform: "desktop",
        message: "Use scoped tools.",
        appTools: {
          serverName: "infinite_app",
          mode: "everything",
          allowedTools: ["mcp__infinite_app__ads_*"],
          tools: [
            {
              name: "ads_call_tool",
              description: "Call Ads tool.",
              inputSchema: { type: "object", additionalProperties: true }
            }
          ],
          proxy: {
            type: "mcp-jsonrpc-http",
            url: "http://127.0.0.1:18181/mcp"
          }
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_scoped_app_tools" }
    });
    expect(modelClient.complete).not.toHaveBeenCalled();
  });

  it("union mode exposes the native registry alongside the scoped app tools to the model", async () => {
    const modelRequests: Array<{ tools: Array<{ name: string }> }> = [];
    const app = createApp({
      database: workspaceProbeDb(),
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request as { tools: Array<{ name: string }> });
          return { message: "Union tools available." };
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/turn",
      headers: OPERATOR_HEADERS,
      payload: {
        platform: "desktop",
        message: "best reddit leads?",
        appTools: {
          serverName: "infinite_app",
          mode: "union",
          allowedTools: ["mcp__infinite_app__ads_*"],
          tools: [
            {
              name: "ads_call_tool",
              description: "Call Ads tool.",
              inputSchema: { type: "object", additionalProperties: true }
            }
          ],
          proxy: {
            type: "mcp-jsonrpc-http",
            url: "http://127.0.0.1:18181/mcp"
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, message: "Union tools available." });
    const advertised = modelRequests[0]?.tools.map((tool) => tool.name) ?? [];
    // Union = native registry ∪ app tools: the model sees BOTH a surviving native action
    // AND the injected app tool (exclusive would advertise only the app tool). Since the
    // Phase-2 native-analytics removal the daemon registry no longer carries the
    // local-store analytics family — list_sources is the pinned surviving native.
    expect(advertised).toContain("mcp__infinite_app__ads_call_tool");
    expect(advertised).toContain("list_sources");
    expect(advertised.length).toBeGreaterThan(1);
  });

  it("accepts the DESKTOP chat-union descriptor shape verbatim (wire contract with buildChatUnionAppToolsDescriptor)", async () => {
    // Mirrors the EXACT object apps/desktop buildChatUnionAppToolsDescriptor emits: the whole
    // `mcp__infinite_app__*` floor as a one-element ARRAY (not a bare string), a non-ads catalog tool,
    // mode:"union", loopback proxy + token header. The desktop shipped a STRING here once and every
    // Codex chat turn 400'd; this pins that the two sides agree so the bug class can't return.
    const modelRequests: Array<{ tools: Array<{ name: string }> }> = [];
    const app = createApp({
      database: workspaceProbeDb(),
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request as { tools: Array<{ name: string }> });
          return { message: "ok" };
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/turn",
      headers: OPERATOR_HEADERS,
      payload: {
        platform: "desktop",
        message: "best reddit leads?",
        appTools: {
          serverName: "infinite_app",
          // Exact per-tool model-names — the shape buildChatUnionAppToolsDescriptor now emits (a
          // bare-server `mcp__infinite_app__*` wildcard would be rejected by the entry pattern).
          allowedTools: ["mcp__infinite_app__list_reddit_leads"],
          tools: [
            {
              name: "list_reddit_leads",
              description: "List saved reddit leads.",
              inputSchema: { type: "object", additionalProperties: false }
            }
          ],
          proxy: {
            type: "mcp-jsonrpc-http",
            url: "http://127.0.0.1:4321/mcp",
            headers: { "x-infinite-brain-mcp-token": "tok" }
          },
          mode: "union"
        }
      }
    });

    // NOT a 400 — the descriptor parses — and union advertises native ∪ app tool.
    expect(response.statusCode).toBe(200);
    const advertised = modelRequests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(advertised).toContain("mcp__infinite_app__list_reddit_leads");
    expect(advertised).toContain("list_sources");
  });

  it("passes validated scoped app tools to gateway turns and proxies matching calls over loopback JSON-RPC", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: Object.fromEntries(new Headers(init?.headers).entries())
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "scoped-tool-call",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, rows: [{ campaign: "Launch", spend: 123 }] })
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const modelRequests: unknown[] = [];
    const app = createApp({
      database: workspaceProbeDb(),
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_ads",
                  name: "mcp__infinite_app__ads_call_tool",
                  input: { toolName: "ads_query_ad_metrics" }
                }
              ]
            };
          }
          return { message: "Scoped Ads data is available." };
        }
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: {
          platform: "desktop",
          message: "Use scoped tools.",
          appTools: {
            serverName: "infinite_app",
            allowedTools: ["mcp__infinite_app__ads_*"],
            tools: [
              {
                name: "ads_call_tool",
                description: "Call Ads tool.",
                inputSchema: { type: "object", additionalProperties: true }
              },
              {
                name: "list_sources",
                description: "Non-Ads app tool.",
                inputSchema: { type: "object", additionalProperties: true }
              }
            ],
            proxy: {
              type: "mcp-jsonrpc-http",
              url: "http://127.0.0.1:18181/mcp",
              headers: { "x-infinite-brain-mcp-token": "test-token" }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        message: "Scoped Ads data is available."
      });
      expect((modelRequests[0] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
        "mcp__infinite_app__ads_call_tool"
      ]);
      expect(fetchCalls).toEqual([
        {
          url: "http://127.0.0.1:18181/mcp",
          headers: expect.objectContaining({
            "content-type": "application/json",
            "x-infinite-brain-mcp-token": "test-token"
          }),
          body: {
            jsonrpc: "2.0",
            id: "call_ads",
            method: "tools/call",
            params: {
              name: "ads_call_tool",
              arguments: { toolName: "ads_query_ad_metrics" }
            }
          }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects malformed scoped app-tool JSON-RPC proxy responses as tool failures", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "wrong-call-id",
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;
    const modelRequests: unknown[] = [];
    const app = createApp({
      database: workspaceProbeDb(),
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_ads",
                  name: "mcp__infinite_app__ads_call_tool",
                  input: { toolName: "ads_query_ad_metrics" }
                }
              ]
            };
          }
          return { message: "Denied malformed proxy response." };
        }
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: {
          platform: "desktop",
          message: "Use scoped tools.",
          appTools: {
            serverName: "infinite_app",
            allowedTools: ["mcp__infinite_app__ads_*"],
            tools: [
              {
                name: "ads_call_tool",
                description: "Call Ads tool.",
                inputSchema: { type: "object", additionalProperties: true }
              }
            ],
            proxy: {
              type: "mcp-jsonrpc-http",
              url: "http://127.0.0.1:18181/mcp"
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        message: "Denied malformed proxy response."
      });
      expect(modelRequests[1]).toMatchObject({
        toolResults: [
          {
            id: "call_ads",
            name: "mcp__infinite_app__ads_call_tool",
            result: {
              status: "error",
              error: { code: "scoped_app_tool_failed", message: "scoped_app_tool_proxy_invalid_jsonrpc" }
            }
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns an UNqualified sessionId that round-trips to the SAME session (no double-qualify)", async () => {
    // Regression guard for the gateway double-qualification bug: if the response carried the
    // workspace-qualified key, a client round-tripping it would make turn 2 re-qualify to
    // `<conv>:<ws>:<ws>` — a new orphaned session that silently breaks multi-turn memory.
    const ensured: string[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession(input) { ensured.push(input.sessionId); },
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() { return []; },
      async getSession() { return null; },
      async searchSessions() { return []; },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) { return { sessionId: input.newSessionId ?? input.sessionId, parentSessionId: input.sessionId }; }
    };
    const app = createApp({
      database: workspaceProbeDb(),
      sessionStore,
      modelClient: { complete: async () => ({ message: "ok" }) }
    });
    try {
      const turn1 = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: { platform: "desktop", actorId: "user-1", channelId: "channel-1", message: "first" }
      });
      const sid1 = (turn1.json() as { sessionId: string }).sessionId;
      expect(sid1).toBe("desktop:channel-1:user-1");
      expect(sid1.endsWith(`:${WORKSPACE}`)).toBe(false); // unqualified — safe to round-trip

      // Feed the returned id back as the next turn's sessionId, exactly as a real client does.
      const turn2 = await app.inject({
        method: "POST",
        url: "/gateway/turn",
        headers: OPERATOR_HEADERS,
        payload: { sessionId: sid1, platform: "desktop", actorId: "user-1", channelId: "channel-1", message: "second" }
      });
      const sid2 = (turn2.json() as { sessionId: string }).sessionId;
      expect(sid2).toBe(sid1); // stable identifier across turns

      // The crux: BOTH turns resolve to the SAME workspace-qualified controller key, not a
      // `:<ws>:<ws>` orphan on turn 2.
      expect(ensured).toEqual([
        `desktop:channel-1:user-1:${WORKSPACE}`,
        `desktop:channel-1:user-1:${WORKSPACE}`
      ]);
    } finally {
      // env restored by afterEach
    }
  });

  it("runs an app-hosted connector OAuth callback session", async () => {
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const app = createApp({ database: workspaceProbeDb() });

    try {
      const denied = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as {
        sessionId: string;
        state: string;
        authorizationUrl: string;
        redirectUri: string;
      };
      // Real OAuth callbacks carry only `state` (+ code) — providers do not echo
      // back a sessionId — so an unknown state must yield session-not-found...
      const unknownState = await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=wrong&code=auth-code`
      });
      // ...and the matching state must locate the session with no sessionId present.
      const callback = await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const status = await app.inject({
        method: "GET",
        url: `/oauth/sessions/${createdJson.sessionId}`,
        headers: OPERATOR_HEADERS
      });

      expect(denied.statusCode).toBe(401);
      expect(created.statusCode).toBe(200);
      expect(createdJson.authorizationUrl).toContain("https://accounts.google.com/o/oauth2/v2/auth");
      expect(createdJson.authorizationUrl).toContain("client_id=ga-client-id");
      expect(createdJson.authorizationUrl).toContain("https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fanalytics.edit");
      expect(createdJson.authorizationUrl).toContain("https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fanalytics.readonly");
      // PKCE (defense-in-depth) + offline/consent params for GA4.
      const authParams = new URL(createdJson.authorizationUrl).searchParams;
      expect(authParams.get("code_challenge_method")).toBe("S256");
      expect(authParams.get("access_type")).toBe("offline");
      expect(authParams.get("prompt")).toBe("consent");
      const challenge = authParams.get("code_challenge");
      // base64url challenge: 43 chars (sha256 → 32 bytes), no padding/url-unsafe chars.
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(createdJson.redirectUri).toBe("http://growth-os.test/oauth/callback/google_analytics_4");
      expect(unknownState.statusCode).toBe(404);
      expect(unknownState.json()).toMatchObject({ error: { code: "oauth_session_not_found" } });
      expect(callback.statusCode).toBe(200);
      expect(callback.json()).toMatchObject({
        ok: true,
        status: "completed",
        provider: "google_analytics_4"
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        ok: true,
        provider: "google_analytics_4",
        status: "completed",
        hasAuthorizationCode: true
      });
      expect(JSON.stringify(status.json())).not.toContain("auth-code");
    } finally {
      // env restored by afterEach
    }
  });

  it("serves a styled HTML callback page to browsers but keeps the JSON contract otherwise", async () => {
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const app = createApp({ database: workspaceProbeDb() });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as { state: string };

      // A browser (Accept: text/html) gets the friendly page.
      const htmlCallback = await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`,
        headers: { accept: "text/html,application/xhtml+xml" }
      });
      expect(htmlCallback.statusCode).toBe(200);
      expect(htmlCallback.headers["content-type"]).toContain("text/html");
      expect(htmlCallback.body).toContain("return to your terminal");
      expect(htmlCallback.body).not.toContain("auth-code");

      // A non-browser caller (no Accept: text/html) still gets the JSON contract.
      const jsonCallback = await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      expect(jsonCallback.statusCode).toBe(200);
      expect(jsonCallback.json()).toMatchObject({
        ok: true,
        status: "completed",
        provider: "google_analytics_4"
      });
    } finally {
      // env restored by afterEach
    }
  });

  it("exchanges completed GA4 OAuth sessions into encrypted live connector credentials", async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.DATABASE_URL = "postgres://test";
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    process.env.GROWTH_OS_OPERATOR_TOKEN = "operator-token";
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const storedCredentials: Array<{ credential_kind: string; encrypted_payload: string }> = [];
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from connection_credentials")) {
          return storedCredentials.at(-1) ?? null;
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async (input: { credentialKind?: string; encryptedPayload?: string }) => {
        storedCredentials.push({
          credential_kind: input.credentialKind ?? "fixture",
          encrypted_payload: input.encryptedPayload ?? "fixture-encrypted"
        });
        return {
          id: "src_ga4",
          workspace_id: "default",
          provider: "google_analytics_4",
          connection_name: "GA4 Website",
          account_external_id: "properties/123",
          status: "connected"
        };
      },
      updateSourceStatus: async () => {},
      createJob: async () => ({}),
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const fetches: string[] = [];
    let tokenBody: URLSearchParams | null = null;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetches.push(String(url));
      if (String(url) === "https://oauth2.test/token") {
        tokenBody = new URLSearchParams(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            access_token: "ga4-access-token",
            refresh_token: "ga4-refresh-token",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      if (String(url).includes("analyticsdata.googleapis.com")) {
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as { sessionId: string; state: string; authorizationUrl: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const exchange = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${createdJson.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: {
          propertyId: "properties/123",
          connectionName: "GA4 Website",
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token"
        }
      });

      expect(exchange.statusCode).toBe(200);
      expect(exchange.json()).toMatchObject({
        ok: true,
        provider: "google_analytics_4",
        status: "connected",
        envelope: {
          actionId: "connect_source",
          authority: "operator",
          status: "queued",
          data: {
            source: { id: "src_ga4", provider: "google_analytics_4" },
            connectionTest: {
              ok: true,
              mode: "live",
              accountExternalId: "properties/123"
            }
          }
        }
      });
      expect(fetches).toEqual([
        "https://oauth2.test/token",
        "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport"
      ]);
      // The token exchange must carry the PKCE verifier AND keep client_secret
      // (Google requires the secret for installed "Desktop app" clients).
      expect(tokenBody).not.toBeNull();
      const body = tokenBody as unknown as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_secret")).toBe("ga-client-secret");
      const verifier = body.get("code_verifier");
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      // PKCE round-trip: the exchanged verifier hashes to the challenge sent at authorize time.
      const expectedChallenge = createHash("sha256")
        .update(verifier!)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(new URL(createdJson.authorizationUrl).searchParams.get("code_challenge")).toBe(
        expectedChallenge
      );
      expect(storedCredentials[0].credential_kind).toBe("oauth_access_token");
      expect(storedCredentials[0].encrypted_payload).not.toContain("ga4-access-token");
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-access-token");
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-refresh-token");
      expect(JSON.stringify(exchange.json())).not.toContain("auth-code");
    } finally {
      globalThis.fetch = originalFetch;
      // env restored by afterEach
    }
  });

  it("lists GA4 properties server-side for a completed session, never returning the token", async () => {
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const originalFetch = globalThis.fetch;
    const fetches: string[] = [];
    let adminAuth: string | null = null;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      fetches.push(u);
      if (u.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "ga4-access-token", refresh_token: "ga4-refresh-token", expires_in: 3600 }),
          { status: 200 }
        );
      }
      if (u.includes("analyticsadmin.googleapis.com") && u.includes("accountSummaries")) {
        adminAuth = new Headers(init?.headers).get("authorization");
        return new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/9",
                displayName: "Acme Inc",
                propertySummaries: [
                  { property: "properties/123", displayName: "Acme Web" },
                  { property: "properties/456", displayName: "Acme App" }
                ]
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }) as typeof fetch;
    const app = createApp({ database: workspaceProbeDb() });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const props = await app.inject({
        method: "GET",
        url: `/oauth/sessions/${createdJson.sessionId}/ga4-properties`,
        headers: OPERATOR_HEADERS
      });

      expect(props.statusCode).toBe(200);
      expect(props.json()).toMatchObject({
        ok: true,
        provider: "google_analytics_4",
        properties: [
          { property: "properties/123", displayName: "Acme Web", account: "accounts/9", accountDisplayName: "Acme Inc" },
          { property: "properties/456", displayName: "Acme App", account: "accounts/9", accountDisplayName: "Acme Inc" }
        ]
      });
      // The Admin API call was made SERVER-SIDE carrying the bearer token...
      expect(adminAuth).toBe("Bearer ga4-access-token");
      // ...and the token NEVER crosses back to the caller.
      expect(JSON.stringify(props.json())).not.toContain("ga4-access-token");
      expect(JSON.stringify(props.json())).not.toContain("ga4-refresh-token");
    } finally {
      globalThis.fetch = originalFetch;
      // env restored by afterEach
    }
  });

  it("reuses the held token: listing then connecting GA4 exchanges the single-use code only once", async () => {
    process.env.DATABASE_URL = "postgres://test";
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    process.env.GROWTH_OS_OPERATOR_TOKEN = "operator-token";
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const originalFetch = globalThis.fetch;
    const storedCredentials: Array<{ credential_kind: string; encrypted_payload: string }> = [];
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from connection_credentials")) {
          return storedCredentials.at(-1) ?? null;
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async (input: { credentialKind?: string; encryptedPayload?: string }) => {
        storedCredentials.push({
          credential_kind: input.credentialKind ?? "fixture",
          encrypted_payload: input.encryptedPayload ?? "fixture-encrypted"
        });
        return {
          id: "src_ga4",
          workspace_id: "default",
          provider: "google_analytics_4",
          connection_name: "GA4 Website",
          account_external_id: "properties/123",
          status: "connected"
        };
      },
      updateSourceStatus: async () => {},
      createJob: async () => ({}),
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const fetches: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const u = String(url);
      fetches.push(u);
      if (u.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "ga4-access-token", refresh_token: "ga4-refresh-token", expires_in: 3600 }),
          { status: 200 }
        );
      }
      if (u.includes("analyticsadmin.googleapis.com")) {
        return new Response(
          JSON.stringify({
            accountSummaries: [
              { account: "accounts/9", displayName: "Acme Inc", propertySummaries: [{ property: "properties/123", displayName: "Acme Web" }] }
            ]
          }),
          { status: 200 }
        );
      }
      // connect_source's GA4 live connection test hits the Data API.
      if (u.includes("analyticsdata.googleapis.com")) {
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      // 1) list — exchanges the code -> token, held on the session.
      const props = await app.inject({
        method: "GET",
        url: `/oauth/sessions/${createdJson.sessionId}/ga4-properties`,
        headers: OPERATOR_HEADERS
      });
      // 2) connect the chosen property — must REUSE the held token, NOT re-exchange the spent code.
      const exchange = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${createdJson.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: { propertyId: "properties/123", connectionName: "GA4 Website" }
      });

      expect(props.statusCode).toBe(200);
      expect(exchange.statusCode).toBe(200);
      expect(exchange.json()).toMatchObject({ ok: true, status: "connected" });
      // The single-use auth code was exchanged EXACTLY ONCE across both calls.
      expect(fetches.filter((u) => u.includes("/token"))).toHaveLength(1);
      expect(storedCredentials[0].credential_kind).toBe("oauth_access_token");
    } finally {
      globalThis.fetch = originalFetch;
      // env restored by afterEach
    }
  });

  it("rejects GA4 OAuth exchange when the workspace header does not match the bound session workspace", async () => {
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const fetchSpy = vi.fn();
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchSpy(String(url), init);
      return new Response(
        JSON.stringify({
          access_token: "ga4-access-token",
          refresh_token: "ga4-refresh-token",
          expires_in: 3600
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          provider: "google_analytics_4",
          clientId: "ga-client-id",
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token"
        }
      });
      const createdJson = created.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const exchange = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${createdJson.sessionId}/exchange`,
        headers: operatorHeadersFor(OTHER_WORKSPACE),
        payload: {
          propertyId: "properties/123",
          connectionName: "GA4 Website"
        }
      });

      expect(exchange.statusCode).toBe(400);
      expect(exchange.json()).toMatchObject({
        ok: false,
        error: { code: "oauth_workspace_mismatch" }
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(exchange.json())).not.toContain("ga-client-secret");
      expect(JSON.stringify(exchange.json())).not.toContain("auth-code");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects OAuth session status reads when the workspace header does not match the bound session workspace", async () => {
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const app = createApp({ database: workspaceProbeDb() });

    const created = await app.inject({
      method: "POST",
      url: "/oauth/sessions",
      headers: OPERATOR_HEADERS,
      payload: {
        provider: "google_analytics_4",
        clientId: "ga-client-id"
      }
    });
    const createdJson = created.json() as { sessionId: string };

    const missingWorkspace = await app.inject({
      method: "GET",
      url: `/oauth/sessions/${createdJson.sessionId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });
    const mismatchedWorkspace = await app.inject({
      method: "GET",
      url: `/oauth/sessions/${createdJson.sessionId}`,
      headers: operatorHeadersFor(OTHER_WORKSPACE)
    });

    expect(missingWorkspace.statusCode).toBe(400);
    expect(missingWorkspace.json()).toMatchObject({
      ok: false,
      error: { code: "unknown_workspace" }
    });
    expect(JSON.stringify(missingWorkspace.json())).not.toContain("accounts.google.com");

    expect(mismatchedWorkspace.statusCode).toBe(400);
    expect(mismatchedWorkspace.json()).toMatchObject({
      ok: false,
      error: { code: "oauth_workspace_mismatch" }
    });
    expect(JSON.stringify(mismatchedWorkspace.json())).not.toContain("accounts.google.com");
  });

  it("still connects a GA4 source when propertyId is supplied but reusable OAuth persistence is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-app-test-"));
    mkdirSync(join(workspaceRoot, ".growth-os"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".growth-os", ".env"),
      "GROWTH_OS_ENCRYPTION_KEY=test-encryption-key\n",
      "utf8"
    );
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    process.env.GROWTH_OS_WORKSPACE_ROOT = workspaceRoot;
    delete process.env.GROWTH_OS_ENCRYPTION_KEY;
    const storedCredentials: Array<{ credential_kind: string; encrypted_payload: string }> = [];
    const oauthAppWrites: string[] = [];
    const oauthTokenWrites: string[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("insert into oauth_apps")) {
          oauthAppWrites.push(sql);
        }
        if (sql.includes("insert into oauth_tokens")) {
          oauthTokenWrites.push(sql);
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from connection_credentials")) {
          return storedCredentials.at(-1) ?? null;
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async (input: { credentialKind?: string; encryptedPayload?: string }) => {
        storedCredentials.push({
          credential_kind: input.credentialKind ?? "fixture",
          encrypted_payload: input.encryptedPayload ?? "fixture-encrypted"
        });
        return {
          id: "src_ga4",
          workspace_id: "default",
          provider: "google_analytics_4",
          connection_name: "GA4 Website",
          account_external_id: "properties/123",
          status: "connected"
        };
      },
      updateSourceStatus: async () => {},
      createJob: async () => ({}),
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url) === "https://oauth2.test/token") {
        return new Response(
          JSON.stringify({
            access_token: "ga4-access-token",
            refresh_token: "ga4-refresh-token",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      if (String(url).includes("analyticsdata.googleapis.com")) {
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const exchange = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${createdJson.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: {
          propertyId: "properties/123",
          connectionName: "GA4 Website",
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token"
        }
      });

      expect(exchange.statusCode).toBe(200);
      expect(exchange.json()).toMatchObject({
        ok: true,
        provider: "google_analytics_4",
        status: "connected",
        oauthAppId: null,
        oauthTokenId: null,
        envelope: {
          actionId: "connect_source",
          authority: "operator",
          status: "queued",
          data: {
            source: { id: "src_ga4", provider: "google_analytics_4" },
            connectionTest: {
              ok: true,
              mode: "live",
              accountExternalId: "properties/123"
            }
          }
        }
      });
      expect(storedCredentials[0]?.credential_kind).toBe("oauth_access_token");
      expect(oauthAppWrites).toHaveLength(0);
      expect(oauthTokenWrites).toHaveLength(0);
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-access-token");
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-refresh-token");
      expect(JSON.stringify(exchange.json())).not.toContain("auth-code");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("persists reusable GA4 OAuth app/token state before a property is known", async () => {
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const oauthAppRows: Array<{ id: string; encrypted_payload: string }> = [];
    const oauthTokenRows: Array<{ id: string; encrypted_payload: string; expires_at: string | null }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("insert into oauth_apps")) {
          oauthAppRows.push({
            id: String(params[0]),
            encrypted_payload: String(params[3])
          });
        }
        if (sql.includes("insert into oauth_tokens")) {
          oauthTokenRows.push({
            id: String(params[0]),
            encrypted_payload: String(params[3]),
            expires_at: params[4] ? String(params[4]) : null
          });
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from oauth_apps")) {
          const latest = oauthAppRows.at(-1);
          return latest ? { encrypted_payload: latest.encrypted_payload } : null;
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url) === "https://oauth2.test/token") {
        return new Response(
          JSON.stringify({
            access_token: "ga4-access-token",
            refresh_token: "ga4-refresh-token",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: { provider: "google_analytics_4", clientId: "ga-client-id" }
      });
      const createdJson = created.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const exchange = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${createdJson.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: {
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token"
        }
      });

      expect(exchange.statusCode).toBe(200);
      expect(exchange.json()).toMatchObject({
        ok: true,
        provider: "google_analytics_4",
        status: "authorized"
      });
      expect(oauthAppRows).toHaveLength(1);
      expect(oauthTokenRows).toHaveLength(1);
      expect(oauthAppRows[0]?.encrypted_payload).not.toContain("ga-client-secret");
      expect(oauthTokenRows[0]?.encrypted_payload).not.toContain("ga4-access-token");
      expect(oauthTokenRows[0]?.encrypted_payload).not.toContain("ga4-refresh-token");

      expect(
        decryptCredentialPayload<Record<string, unknown>>(
          oauthAppRows[0]?.encrypted_payload ?? "",
          "test-encryption-key"
        )
      ).toMatchObject({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://growth-os.test/oauth/callback/google_analytics_4",
        authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.test/token"
      });
      expect(
        decryptCredentialPayload<Record<string, unknown>>(
          oauthTokenRows[0]?.encrypted_payload ?? "",
          "test-encryption-key"
        )
      ).toMatchObject({
        accessToken: "ga4-access-token",
        refreshToken: "ga4-refresh-token"
      });
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-access-token");
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-refresh-token");
      expect(JSON.stringify(exchange.json())).not.toContain("ga-client-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reuses the stored encrypted GA4 OAuth app when property-less exchange omits the client secret", async () => {
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const oauthAppRows: Array<{ id: string; encrypted_payload: string }> = [];
    const oauthTokenRows: Array<{ id: string; encrypted_payload: string; expires_at: string | null }> = [];
    const tokenRequests: Array<Record<string, string>> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("insert into oauth_apps")) {
          oauthAppRows.push({
            id: String(params[0]),
            encrypted_payload: String(params[3])
          });
        }
        if (sql.includes("insert into oauth_tokens")) {
          oauthTokenRows.push({
            id: String(params[0]),
            encrypted_payload: String(params[3]),
            expires_at: params[4] ? String(params[4]) : null
          });
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from oauth_apps")) {
          const latest = oauthAppRows.at(-1);
          return latest ? { encrypted_payload: latest.encrypted_payload } : null;
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      tokenRequests.push(
        Object.fromEntries(new URLSearchParams(String(init?.body ?? "")).entries())
      );
      return new Response(
        JSON.stringify({
          access_token: "ga4-access-token",
          refresh_token: "ga4-refresh-token",
          expires_in: 3600
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          provider: "google_analytics_4",
          clientId: "ga-client-id",
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token"
        }
      });
      const createdJson = created.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${createdJson.state}&code=auth-code`
      });
      const exchange = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${createdJson.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: {}
      });

      expect(exchange.statusCode).toBe(200);
      expect(exchange.json()).toMatchObject({
        ok: true,
        provider: "google_analytics_4",
        status: "authorized"
      });
      expect(tokenRequests).toEqual([
        expect.objectContaining({
          grant_type: "authorization_code",
          code: "auth-code",
          client_id: "ga-client-id",
          client_secret: "ga-client-secret",
          redirect_uri: "http://growth-os.test/oauth/callback/google_analytics_4"
        })
      ]);
      expect(oauthAppRows).toHaveLength(2);
      expect(oauthTokenRows).toHaveLength(1);
      expect(JSON.stringify(exchange.json())).not.toContain("ga-client-secret");
      expect(JSON.stringify(exchange.json())).not.toContain("ga4-access-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps concurrent same-workspace GA4 OAuth sessions bound to their own token URL and secret", async () => {
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_PUBLIC_API_URL = "http://growth-os.test";
    const oauthAppRows: Array<{ id: string; encrypted_payload: string }> = [];
    const tokenRequests: Array<{ url: string; params: Record<string, string> }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("insert into oauth_apps")) {
          oauthAppRows.push({
            id: String(params[0]),
            encrypted_payload: String(params[3])
          });
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from oauth_apps")) {
          const latest = oauthAppRows.at(-1);
          return latest ? { id: latest.id, encrypted_payload: latest.encrypted_payload } : null;
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      tokenRequests.push({
        url: String(url),
        params: Object.fromEntries(new URLSearchParams(String(init?.body ?? "")).entries())
      });
      return new Response(
        JSON.stringify({
          access_token: "ga4-access-token",
          refresh_token: "ga4-refresh-token",
          expires_in: 3600
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const app = createApp({ database: db });

    try {
      const createdA = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          provider: "google_analytics_4",
          clientId: "ga-client-id",
          clientSecret: "secret-a",
          tokenUrl: "https://oauth2.test/token-a"
        }
      });
      const createdB = await app.inject({
        method: "POST",
        url: "/oauth/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          provider: "google_analytics_4",
          clientId: "ga-client-id",
          clientSecret: "secret-b",
          tokenUrl: "https://oauth2.test/token-b"
        }
      });
      const sessionA = createdA.json() as { sessionId: string; state: string };
      const sessionB = createdB.json() as { sessionId: string; state: string };
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${sessionA.state}&code=code-a`
      });
      await app.inject({
        method: "GET",
        url: `/oauth/callback/google_analytics_4?state=${sessionB.state}&code=code-b`
      });

      const exchangeA = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${sessionA.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: {}
      });
      const exchangeB = await app.inject({
        method: "POST",
        url: `/oauth/sessions/${sessionB.sessionId}/exchange`,
        headers: OPERATOR_HEADERS,
        payload: {}
      });

      expect(exchangeA.statusCode).toBe(200);
      expect(exchangeB.statusCode).toBe(200);
      expect(tokenRequests).toEqual([
        {
          url: "https://oauth2.test/token-a",
          params: expect.objectContaining({
            grant_type: "authorization_code",
            code: "code-a",
            client_id: "ga-client-id",
            client_secret: "secret-a",
            redirect_uri: "http://growth-os.test/oauth/callback/google_analytics_4"
          })
        },
        {
          url: "https://oauth2.test/token-b",
          params: expect.objectContaining({
            grant_type: "authorization_code",
            code: "code-b",
            client_id: "ga-client-id",
            client_secret: "secret-b",
            redirect_uri: "http://growth-os.test/oauth/callback/google_analytics_4"
          })
        }
      ]);
      expect(JSON.stringify(exchangeA.json())).not.toContain("secret-a");
      expect(JSON.stringify(exchangeB.json())).not.toContain("secret-b");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the requested workspace header for source routes", async () => {
    const events: unknown[] = [];
    let storedWorkspaceId = "";
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("from sources")) {
          events.push(["listSources", params?.[0]]);
          return [];
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from connection_credentials")) {
          return {
            credential_kind: "fixture",
            encrypted_payload: "fixture-encrypted"
          };
        }
        if (sql.includes("select provider from sources")) {
          return storedWorkspaceId ? { provider: "x" } : null;
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async (input: { workspaceId: string; provider: string; connectionName: string }) => {
        events.push(["connectSource", input.workspaceId, input.provider, input.connectionName]);
        storedWorkspaceId = input.workspaceId;
        return {
          id: "src_x",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: "yourhandle",
          status: "connected"
        };
      },
      updateSourceStatus: async () => {},
      createJob: async () => ({}),
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "" });

    const list = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { Authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": "ws_cli_test" }
    });
    const connect = await app.inject({
      method: "POST",
      url: "/sources/connect",
      headers: {
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
        "x-growth-os-workspace": "ws_cli_test"
      },
      payload: {
        provider: "x",
        connectionName: "YourHandle Account",
        credentialKind: "fixture",
        credentialPayload: { mode: "fixture" }
      }
    });

    expect(list.statusCode).toBe(200);
    expect(connect.statusCode).toBe(200);
    expect(events).toEqual([
      ["listSources", "ws_cli_test"],
      ["connectSource", "ws_cli_test", "x", "YourHandle Account"]
    ]);
  });

  it("serves job status with the matching sync run for CLI progress polling", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("from sync_runs")) {
          return [
            {
              id: "sync_1",
              workspace_id: "ws_cli_test",
              source_id: "src_123",
              status: "succeeded",
              records_extracted: 4,
              records_loaded: 4
            }
          ];
        }
        return [];
      },
      one: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        queries.push({ sql, params });
        if (sql.includes("from job_runs")) {
          return {
            id: "job_sync_1",
            workspace_id: "ws_cli_test",
            job_type: "source_sync",
            status: "succeeded",
            payload: { sourceId: "src_123", mode: "incremental" },
            created_at: "2026-06-06T15:34:30.604Z",
            started_at: "2026-06-06T15:34:32.357Z",
            finished_at: "2026-06-06T15:34:33.105Z",
            error: null
          };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "" });

    const response = await app.inject({
      method: "GET",
      url: "/jobs/job_sync_1",
      headers: { Authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": "ws_cli_test" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        job: {
          id: "job_sync_1",
          status: "succeeded",
          payload: { sourceId: "src_123" }
        },
        syncRun: {
          id: "sync_1",
          status: "succeeded",
          records_loaded: 4
        }
      }
    });
    expect(queries.map((query) => query.params)).toEqual([
      ["job_sync_1", "ws_cli_test"],
      ["ws_cli_test", "src_123", "2026-06-06T15:34:30.604Z"]
    ]);
    const syncRunQuery = queries.find((query) => query.sql.includes("from sync_runs"))?.sql ?? "";
    expect(syncRunQuery).not.toMatch(/\bmode\b/);
  });

  it("serves curated session memory routes through the DB-backed memory store", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("from chat_memory_facts") && sql.includes("select id")) {
          return [
            {
              id: "mem_1",
              scope: "workspace_preference",
              fact: "Use UTC for weekly reports.",
              sourceSessionId: "session-1"
            }
          ];
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db });

    try {
      const list = await app.inject({
        method: "GET",
        url: "/chat/sessions/session-1/memory",
        headers: { Authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE }
      });
      const denied = await app.inject({
        method: "POST",
        url: "/chat/sessions/session-1/memory",
        payload: { scope: "workspace_preference", fact: "Use UTC for weekly reports." }
      });
      const rejected = await app.inject({
        method: "POST",
        url: "/chat/sessions/session-1/memory",
        headers: OPERATOR_HEADERS,
        payload: { scope: "workspace_preference", fact: "API key is sk-live-secret." }
      });
      const added = await app.inject({
        method: "POST",
        url: "/chat/sessions/session-1/memory",
        headers: OPERATOR_HEADERS,
        payload: { scope: "workspace_preference", fact: "Use UTC for weekly reports." }
      });
      const deleted = await app.inject({
        method: "DELETE",
        url: "/chat/sessions/session-1/memory/mem_1",
        headers: OPERATOR_HEADERS
      });

      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        ok: true,
        sessionId: "session-1",
        memories: [{ id: "mem_1", fact: "Use UTC for weekly reports." }]
      });
      expect(denied.statusCode).toBe(401);
      expect(rejected.statusCode).toBe(400);
      expect(added.statusCode).toBe(200);
      expect(added.json()).toMatchObject({
        ok: true,
        memory: { scope: "workspace_preference", fact: "Use UTC for weekly reports." }
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ ok: true, sessionId: "session-1", memoryId: "mem_1" });
      const sql = queries.map((query) => query.sql).join("\n");
      expect(sql).toContain("chat_memory_facts");
      expect(sql).toContain("where not exists");
      expect(sql).toContain("blocked_reason = 'operator_deleted'");
      expect(JSON.stringify(queries)).not.toContain("sk-live-secret");
    } finally {
      // env restored by afterEach
    }
  });

  it("serves chat session list, detail, and resume routes through the session store", async () => {
    const workspaceId = WORKSPACE;
    const events: string[][] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions(workspaceId) {
        events.push(["listSessions", workspaceId]);
        return [{ id: "session-1", title: "Revenue", status: "active" }];
      },
      async getSession(sessionId) {
        events.push(["getSession", sessionId]);
        return {
          id: sessionId,
          workspaceId: WORKSPACE,
          messages: [{ role: "user", content: "Revenue?" }],
          actionCalls: [{ actionId: "list_metrics", status: "ok" }]
        };
      },
      async searchSessions(workspaceId, query, options) {
        events.push(["searchSessions", workspaceId, query, options?.excludeSessionId ?? ""]);
        return [{ id: "session-search", title: "Revenue search", status: "active" }];
      },
      async endSession(sessionId, reason) {
        events.push(["endSession", sessionId, reason ?? ""]);
      },
      async compactSession(input) {
        events.push(["compactSession", input.sessionId, input.newSessionId ?? ""]);
        return {
          sessionId: input.newSessionId ?? "session-compact-child",
          parentSessionId: input.sessionId
        };
      },
      async resumeSession(sessionId) {
        events.push(["resumeSession", sessionId]);
      }
    };
    const app = createApp({ sessionStore, database: workspaceProbeDb(), databaseUrl: "" });

    const list = await app.inject({ method: "GET", url: "/chat/sessions", headers: OPERATOR_HEADERS });
    const search = await app.inject({
      method: "GET",
      url: "/chat/sessions/search?q=revenue&excludeSessionId=session-1",
      headers: OPERATOR_HEADERS
    });
    const detail = await app.inject({ method: "GET", url: "/chat/sessions/session-1", headers: OPERATOR_HEADERS });
    const resume = await app.inject({ method: "POST", url: "/chat/sessions/session-1/resume", headers: OPERATOR_HEADERS });
    const end = await app.inject({
      method: "POST",
      url: "/chat/sessions/session-1/end",
      headers: OPERATOR_HEADERS,
      payload: { reason: "operator_request" }
    });
    const compact = await app.inject({
      method: "POST",
      url: "/chat/sessions/session-1/compact",
      headers: OPERATOR_HEADERS,
      payload: {
        newSessionId: "session-2",
        summaryText: "Revenue source context",
        summaryJson: { selectedMetric: "recognized_revenue" }
      }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ ok: true, sessions: [{ id: "session-1" }] });
    expect(search.json()).toMatchObject({ ok: true, sessions: [{ id: "session-search" }] });
    expect(detail.json()).toMatchObject({
      ok: true,
      session: { id: "session-1", messages: [{ role: "user" }] }
    });
    expect(resume.json()).toMatchObject({ ok: true, sessionId: "session-1" });
    expect(end.json()).toMatchObject({ ok: true, sessionId: "session-1" });
    expect(compact.json()).toMatchObject({
      ok: true,
      sessionId: "session-2",
      parentSessionId: "session-1"
    });
    expect(events).toEqual([
      ["listSessions", workspaceId],
      ["searchSessions", workspaceId, "revenue", "session-1"],
      ["getSession", "session-1"],
      ["resumeSession", "session-1"],
      ["endSession", "session-1", "operator_request"],
      ["getSession", "session-1"],
      ["compactSession", "session-1", "session-2"]
    ]);
  });

  it("generates a compact summary with the model when compact omits summaryText", async () => {
    const events: string[][] = [];
    const modelRequests: unknown[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        events.push(["getSession", sessionId]);
        return {
          id: sessionId,
          workspaceId: WORKSPACE,
          messages: [
            { role: "user", content: "Which source drove revenue?" },
            { role: "assistant", content: "Stripe drove recognized revenue." }
          ],
          actionCalls: [{ actionId: "run_metric_query", status: "ok" }]
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        events.push(["compactSession", input.summaryText]);
        return {
          sessionId: input.newSessionId ?? "session-compact-generated",
          parentSessionId: input.sessionId
        };
      }
    };
    const app = createApp({
      database: workspaceProbeDb(),
      sessionStore,
      modelClient: {
        complete: async (request) => {
          modelRequests.push(request);
          return { message: "Revenue source question answered with Stripe context." };
        }
      }
    });

    const compact = await app.inject({
      method: "POST",
      url: "/chat/sessions/session-1/compact",
      headers: OPERATOR_HEADERS,
      payload: { newSessionId: "session-2" }
    });

    expect(compact.statusCode).toBe(200);
    expect(compact.json()).toMatchObject({
      ok: true,
      sessionId: "session-2",
      parentSessionId: "session-1"
    });
    expect(events).toEqual([
      ["getSession", "session-1"],
      ["compactSession", "Revenue source question answered with Stripe context."]
    ]);
    expect((modelRequests[0] as { systemPrompt: string }).systemPrompt).toContain("compact");
    expect((modelRequests[0] as { userMessage: string }).userMessage).toContain("Which source drove revenue?");
  });

  it("confirms persisted operator action proposals through the typed action registry", async () => {
    const events: unknown[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
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
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      },
      async getPendingActionCall(confirmationId, workspaceId) {
        events.push(["getPendingActionCall", confirmationId, workspaceId]);
        return {
          id: "call_1",
          sessionId: "session-1",
          actionId: "start_source_sync",
          input: { sourceId: "src_1" },
          inputHash: "hash_abc",
          workspaceId: WORKSPACE
        };
      },
      async confirmActionCall(input) {
        events.push(["confirmActionCall", input.confirmationId, input.status, input.outputEnvelope]);
      }
    };
    // A workspace-scoped confirm now executes against the typed registry; supply a
    // fake db that satisfies the workspaces probe AND the start_source_sync handler
    // so the action resolves to a real `queued` envelope (no DB = no handlers used to
    // yield `not_implemented`, but the deny-by-default hook requires a real db now).
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from sources")) {
          return [{ id: "src_1", provider: "x", status: "connected", sync_mode: "incremental" }];
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from sources")) {
          return { id: "src_1", provider: "x", status: "connected", sync_mode: "incremental" };
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async () => ({}),
      updateSourceStatus: async () => {},
      createJob: async () => ({ id: "job_1", status: "queued" }),
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const app = createApp({ sessionStore, database: db, databaseUrl: "" });

    try {
      const denied = await app.inject({
        method: "POST",
        url: "/chat/actions/confirm_abc/confirm"
      });
      const confirmed = await app.inject({
        method: "POST",
        url: "/chat/actions/confirm_abc/confirm",
        headers: OPERATOR_HEADERS
      });

      expect(denied.statusCode).toBe(401);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({
        ok: true,
        confirmationId: "confirm_abc",
        sessionId: "session-1",
        actionId: "start_source_sync",
        inputHash: "hash_abc",
        envelope: {
          actionId: "start_source_sync",
          authority: "operator"
        }
      });
      expect(events[0]).toEqual(["getPendingActionCall", "confirm_abc", WORKSPACE]);
      expect(events[1]).toEqual([
        "confirmActionCall",
        "confirm_abc",
        expect.any(String),
        expect.objectContaining({ actionId: "start_source_sync", authority: "operator" })
      ]);
    } finally {
      // env restored by afterEach
    }
  });

  it("fails closed (404 confirmation_not_found) when a confirmation is confirmed from a DIFFERENT workspace — the scoped lookup makes it invisible, with zero action execution (P0-A)", async () => {
    // The pending confirmation was authored under WORKSPACE; the confirming request
    // carries the OTHER_WORKSPACE header (the desktop's currently-active project). This
    // is the confused-deputy: without the pin, the action would execute under the wrong
    // brand's resolution context (a cross-workspace Graph write).
    const events: unknown[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
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
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      },
      // The store is scoped by (confirmationId, workspaceId): the pending row was authored
      // under WORKSPACE, so a lookup scoped to any OTHER workspace returns null — exactly
      // like the real `where workspace_id = $2` SQL. That IS the cross-workspace control.
      async getPendingActionCall(confirmationId, workspaceId) {
        events.push(["getPendingActionCall", confirmationId, workspaceId]);
        if (workspaceId !== WORKSPACE) return null;
        return {
          id: "call_1",
          sessionId: "session-1",
          actionId: "create_meta_campaign",
          input: { sourceId: "src_1" },
          inputHash: "hash_abc",
          workspaceId: WORKSPACE
        };
      },
      async confirmActionCall(input) {
        events.push(["confirmActionCall", input.confirmationId, input.workspaceId]);
      }
    };
    const auditRows: Array<{ sql: string; params: unknown[] }> = [];
    const executions: string[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/insert\s+into\s+integration_audit_log/i.test(sql)) {
          auditRows.push({ sql, params });
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async () => ({}),
      updateSourceStatus: async () => {},
      createJob: async () => {
        executions.push("createJob");
        return { id: "job_1", status: "queued" };
      },
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const app = createApp({ sessionStore, database: db, databaseUrl: "" });

    const denied = await app.inject({
      method: "POST",
      url: "/chat/actions/confirm_abc/confirm",
      headers: operatorHeadersFor(OTHER_WORKSPACE)
    });

    // The scoped lookup returns null for the foreign workspace → 404, indistinguishable from
    // a genuinely-missing confirmation (no info leak about another brand's pending writes).
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({
      ok: false,
      error: { code: "confirmation_not_found" }
    });
    // The lookup was scoped by the CONFIRMING workspace ($2).
    expect(events[0]).toEqual(["getPendingActionCall", "confirm_abc", OTHER_WORKSPACE]);
    // The action NEVER executed and the confirmation was NEVER marked confirmed.
    expect(executions).toEqual([]);
    expect(events.some((e) => Array.isArray(e) && e[0] === "confirmActionCall")).toBe(false);
    // No audit row: the scoped SELECT is the sole control; a foreign confirm is simply not found.
    expect(auditRows).toHaveLength(0);
  });

  it("executes a confirmation against the PENDING row's workspace (not the request header) when they match (P0-A)", async () => {
    const events: unknown[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
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
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      },
      async getPendingActionCall(confirmationId, workspaceId) {
        events.push(["getPendingActionCall", confirmationId, workspaceId]);
        return {
          id: "call_1",
          sessionId: "session-1",
          actionId: "start_source_sync",
          input: { sourceId: "src_1" },
          inputHash: "hash_abc",
          workspaceId: WORKSPACE
        };
      },
      async confirmActionCall(input) {
        events.push(["confirmActionCall", input.confirmationId, input.status, input.workspaceId]);
      }
    };
    // Capture the workspace_id that reaches the action handler (start_source_sync calls
    // db.createJob with context.workspaceId) so we can prove the action executed under
    // the PENDING workspace and NOT the request header.
    const executionWorkspaces: unknown[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from sources")) {
          return [{ id: "src_1", provider: "x", status: "connected", sync_mode: "incremental" }];
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from sources")) {
          return { id: "src_1", provider: "x", status: "connected", sync_mode: "incremental" };
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async () => ({}),
      updateSourceStatus: async () => {},
      createJob: async (input: { workspaceId: string }) => {
        executionWorkspaces.push(input.workspaceId);
        return { id: "job_1", status: "queued" };
      },
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const app = createApp({ sessionStore, database: db, databaseUrl: "" });

    const confirmed = await app.inject({
      method: "POST",
      url: "/chat/actions/confirm_abc/confirm",
      headers: operatorHeadersFor(WORKSPACE)
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ ok: true, actionId: "start_source_sync" });
    // The lookup AND the confirmation update were scoped by the workspace.
    expect(events[0]).toEqual(["getPendingActionCall", "confirm_abc", WORKSPACE]);
    expect(events.at(-1)).toEqual([
      "confirmActionCall",
      "confirm_abc",
      expect.any(String),
      WORKSPACE
    ]);
    // The action executed under the PENDING workspace (WORKSPACE), never a foreign id.
    expect(executionWorkspaces.length).toBeGreaterThan(0);
    expect(executionWorkspaces.every((ws) => ws === WORKSPACE)).toBe(true);
  });

  it("serves a pending confirmation's ROUTING IDENTITY to operators only, workspace-scoped, identity-only, with zero execution", async () => {
    // GET /chat/actions/:confirmationId/pending backs the DESKTOP's cloud-mode confirm gate
    // (1bu-1 confirmAction carve-out): the desktop holds only an opaque confirmationId and must
    // learn WHICH action a confirm would run from the engine that recorded it — never from a
    // client-supplied name. Because this response AUTHORIZES a cloud-mode Meta confirmation, it
    // must: (1) demand operator authority, (2) be invisible across workspaces, (3) return ONLY
    // the routing identity (no stored input/credentials/output), and (4) execute nothing.
    const events: unknown[] = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
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
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      },
      // Scoped exactly like the real store: the pending row exists only under WORKSPACE and only
      // for confirm_meta; every other (confirmationId, workspaceId) pair is invisible (null).
      async getPendingActionCall(confirmationId, workspaceId) {
        events.push(["getPendingActionCall", confirmationId, workspaceId]);
        if (workspaceId !== WORKSPACE || confirmationId !== "confirm_meta") return null;
        return {
          id: "call_1",
          sessionId: "session-1",
          actionId: "create_meta_campaign",
          input: { name: "pizza test", dailyBudgetCents: 5000 },
          inputHash: "hash_abc",
          workspaceId: WORKSPACE
        };
      },
      async confirmActionCall(input) {
        events.push(["confirmActionCall", input.confirmationId]);
      }
    };
    const executions: string[] = [];
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        return null;
      },
      close: async () => {},
      ensureWorkspace: async () => {},
      ensureFirstPhaseDatasets: async () => {},
      connectSource: async () => ({}),
      updateSourceStatus: async () => {},
      createJob: async () => {
        executions.push("createJob");
        return { id: "job_1", status: "queued" };
      },
      claimNextJob: async () => null,
      completeJob: async () => {},
      withTransaction: async <T,>(fn: (tx: InfiniteOsDb) => Promise<T>) => fn(db as unknown as InfiniteOsDb)
    } as unknown as InfiniteOsDb;
    const app = createApp({ sessionStore, database: db, databaseUrl: "" });

    // 401: no token at all (global auth hook).
    const unauthed = await app.inject({ method: "GET", url: "/chat/actions/confirm_meta/pending" });
    expect(unauthed.statusCode).toBe(401);

    // 403: a read/tool_agent token is NOT enough — the identity authorizes an operator write flow.
    const readDenied = await app.inject({
      method: "GET",
      url: "/chat/actions/confirm_meta/pending",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE }
    });
    expect(readDenied.statusCode).toBe(403);
    expect(readDenied.json()).toMatchObject({ ok: false, error: { code: "operator_authority_required" } });

    // 400: operator with no workspace scope.
    const noWorkspace = await app.inject({
      method: "GET",
      url: "/chat/actions/confirm_meta/pending",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });
    expect(noWorkspace.statusCode).toBe(400);
    expect(noWorkspace.json()).toMatchObject({ ok: false, error: { code: "unknown_workspace" } });

    // 200 same-workspace: EXACT identity-only body — toEqual (not toMatchObject) pins that the
    // stored input ("pizza test", the budget) can never leak through this surface.
    const identified = await app.inject({
      method: "GET",
      url: "/chat/actions/confirm_meta/pending",
      headers: operatorHeadersFor(WORKSPACE)
    });
    expect(identified.statusCode).toBe(200);
    expect(identified.json()).toEqual({
      ok: true,
      confirmationId: "confirm_meta",
      actionId: "create_meta_campaign"
    });

    // 404 cross-workspace: the scoped lookup makes a foreign brand's confirmation invisible,
    // indistinguishable from a genuinely-missing one (P0-A, same stance as the confirm route).
    const foreign = await app.inject({
      method: "GET",
      url: "/chat/actions/confirm_meta/pending",
      headers: operatorHeadersFor(OTHER_WORKSPACE)
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ ok: false, error: { code: "confirmation_not_found" } });

    // 404 missing / already-confirmed (the store's confirmed_at-is-null predicate returns null).
    const missing = await app.inject({
      method: "GET",
      url: "/chat/actions/confirm_gone/pending",
      headers: operatorHeadersFor(WORKSPACE)
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "confirmation_not_found" } });

    // ZERO execution across ALL of the above: the store saw only identity lookups — nothing was
    // confirmed, no action ran, no job was created.
    expect(events.some((e) => Array.isArray(e) && e[0] === "confirmActionCall")).toBe(false);
    expect(executions).toHaveLength(0);
  });

  it("fails closed (404 confirmation_not_found) on the pending-identity route when the default store holds no such row", async () => {
    // The realistic bundled-daemon configuration: a database exists, createApp builds the default
    // createSessionStore, and the requested confirmation simply isn't pending (missing, expired,
    // or already confirmed). Inspection must refuse — no configuration makes it fail open. (The
    // route's confirmation_store_unavailable guard mirrors the confirm route's defensive stance
    // for a store built without getPendingActionCall; a bare storeless app is not reachable
    // through the authed hook chain, which requires a database.)
    const app = createApp({ database: workspaceProbeDb() });
    const res = await app.inject({
      method: "GET",
      url: "/chat/actions/confirm_meta/pending",
      headers: OPERATOR_HEADERS
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "confirmation_not_found" } });
  });

  it("keeps API and MCP tool-call envelopes aligned", async () => {
    // list_sources (not list_metrics): the Phase-2 native-analytics removal retired the
    // metadata family from the daemon execute surface, so the alignment pin rides a
    // surviving read action.
    const app = createApp({ database: workspaceProbeDb() });
    const api = await app.inject({
      method: "POST",
      url: "/tools/call",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE },
      payload: { actionId: "list_sources", input: {} }
    });
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp/tools/call",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE },
      payload: { name: "list_sources", arguments: {} }
    });

    expect(api.statusCode).toBe(200);
    expect(mcp.statusCode).toBe(200);
    const apiJson = api.json() as { actionId: string; authority: string; status: string };
    const mcpJson = mcp.json() as { actionId: string; authority: string; status: string };
    expect(apiJson).toMatchObject({ actionId: "list_sources", authority: "tool_agent" });
    expect(mcpJson).toMatchObject({ actionId: "list_sources", authority: "tool_agent" });
    // API and MCP surfaces must produce the same envelope shape for the same action.
    expect(apiJson.status).toBe(mcpJson.status);
  });

  it("serves first-phase app route aliases without exposing raw payload defaults", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const settings = await app.inject({ method: "GET", url: "/settings/project", headers: OPERATOR_HEADERS });
    const external = await app.inject({
      method: "GET",
      url: "/external-connections",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    const credential = await app.inject({
      method: "GET",
      url: "/sources/src_123/credential-status",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });

    expect(settings.json()).toMatchObject({
      data: { providers: ["google_analytics_4", "posthog", "stripe", "x", "shopify", "meta_ads"] }
    });
    expect(external.json()).toMatchObject({
      data: { genericSqlTool: false, rawPayloadJsonByDefault: false }
    });
    expect(credential.json()).toMatchObject({
      data: { sourceId: "src_123", credentialPayloadExposed: false }
    });
  });

  it("serves resolved setup ids only to localhost operators", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from setup_runs")) {
          return [
            {
              phase_state: {
                providers: {
                  ga4: {
                    publicArtifacts: {
                      measurementId: "G-ACME123",
                      propertyId: "123456789",
                      apiSecret: "do-not-leak"
                    },
                    secretRefs: { oauthTokenId: "tok_1" }
                  }
                }
              }
            },
            {
              phase_state: {
                providers: {
                  posthog: {
                    publicArtifacts: {
                      projectId: "12345",
                      projectKey: "phc_abc",
                      apiHost: "https://us.i.posthog.com",
                      personalApiKey: "do-not-leak"
                    }
                  },
                  x: {
                    publicArtifacts: {
                      pixelId: "o1234",
                      eventTagIds: { purchase: "tw-1234-5678" },
                      consumerSecret: "do-not-leak"
                    }
                  }
                }
              }
            }
          ];
        }
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "" });

    try {
      const denied = await app.inject({
        method: "GET",
        url: "/setup/resolved-ids",
        headers: { "x-growth-os-workspace": "ws1" }
      });
      const badHost = await app.inject({
        method: "GET",
        url: "/setup/resolved-ids",
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, host: "evil.example.com", "x-growth-os-workspace": "ws1" }
      });
      const ok = await app.inject({
        method: "GET",
        url: "/setup/resolved-ids",
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, host: "127.0.0.1", "x-growth-os-workspace": "ws1" }
      });

      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toMatchObject({ error: { code: "unauthorized" } });
      expect(badHost.statusCode).toBe(403);
      expect(badHost.json()).toMatchObject({ error: { code: "invalid_host" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({
        ok: true,
        data: {
          ga4: {
            measurementId: "G-ACME123",
            propertyId: "123456789"
          },
          posthog: {
            projectId: "12345",
            projectKey: "phc_abc",
            apiHost: "https://us.i.posthog.com"
          },
          x: {
            pixelId: "o1234",
            eventTagIds: { purchase: "tw-1234-5678" }
          }
        }
      });
      expect(ok.body).not.toContain("do-not-leak");
      expect(ok.body).not.toContain("tok_1");
    } finally {
      // env restored by afterEach
    }
  });

  it("serves workspace-scoped setup run summaries without leaking secret state", async () => {
    const runRow = {
      id: "setuprun_active",
      workspace_id: WORKSPACE,
      tool: "ga4",
      provider: "ga4",
      status: "paused_handoff",
      phase_state: {
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            {
              provider: "ga4",
              hasAccount: true,
              installState: "installed",
              selected: true,
              recommended: true
            }
          ]
        },
        selectedProviders: ["ga4"],
        recommendedProviders: ["ga4", "posthog"],
        providers: {
          ga4: {
            inventory: {
              provider: "ga4",
              hasAccount: true,
              installState: "installed",
              selected: true,
              recommended: true
            },
            phases: {
              detect: { status: "ok", detail: "detected" },
              connect: {
                status: "needs_human",
                detail: "Finish Google sign-in",
                handoff: {
                  kind: "open_url",
                  url: "https://accounts.google.com/o/oauth2/auth?client_id=ga-client-id&state=oauth-state-1#consent",
                  instructions: "Finish Google sign-in"
                }
              }
            },
            verification: {
              installStatus: "verified",
              queryabilityStatus: "pending",
              lastCheckedAt: "2026-06-08T12:00:00.000Z"
            },
            publicArtifacts: {
              measurementId: "G-ACME123",
              propertyId: "123456789",
              apiSecret: "must-not-leak"
            },
            secretRefs: { oauthTokenId: "tok_1" }
          }
        }
      },
      pending_handoff: {
        kind: "open_url",
        url: "https://accounts.google.com/o/oauth2/auth?client_id=ga-client-id&state=oauth-state-1#consent",
        instructions: "Finish Google sign-in"
      },
      browser_profile: "ga4",
      site_id: "site_1",
      created_at: "2026-06-08T11:00:00.000Z",
      updated_at: "2026-06-08T12:00:00.000Z",
      finished_at: null,
      site_url: "https://acme.test",
      site_repo_path: "/workspace/acme",
      site_app_dir: "apps/web",
      site_framework: "next",
      site_business_type: "saas"
    };
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from setup_runs")) {
          return runRow;
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "" });

    const active = await app.inject({
      method: "GET",
      url: "/setup/runs/active",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE }
    });
    const detail = await app.inject({
      method: "GET",
      url: "/setup/runs/setuprun_active",
      headers: OPERATOR_HEADERS
    });

    expect(active.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      ok: true,
      run: {
        id: "setuprun_active",
        status: "paused_handoff",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web"
        },
        selectedProviders: ["ga4"],
        recommendedProviders: ["ga4", "posthog"],
        providers: {
          ga4: {
            phases: {
              detect: { status: "ok", detail: "detected" },
              connect: { status: "needs_human", detail: "Finish Google sign-in" }
            },
            verification: {
              installStatus: "verified",
              queryabilityStatus: "pending",
              lastCheckedAt: "2026-06-08T12:00:00.000Z"
            }
          }
        },
        pendingHandoff: {
          kind: "open_url",
          instructions: "Finish Google sign-in",
          url: "https://accounts.google.com/o/oauth2/auth"
        },
        browserProfile: "ga4",
        site: {
          id: "site_1",
          url: "https://acme.test",
          repoPath: "/workspace/acme",
          appDir: "apps/web",
          framework: "next",
          businessType: "saas"
        }
      }
    });
    expect(detail.json()).toMatchObject({
      ok: true,
      run: {
        id: "setuprun_active",
        status: "paused_handoff"
      }
    });
    expect(active.body).not.toContain("must-not-leak");
    expect(active.body).not.toContain("tok_1");
    expect(active.body).not.toContain("oauth-state-1");
    expect(active.body).not.toContain("#consent");
  });

  it("resumes paused setup runs for operators and keeps the run scoped to the workspace", async () => {
    const events: Array<[string, string[]]> = [];
    const resumeSetupRun = vi.fn(async () => ({
      ok: false,
      resumed: true,
      onboarding: {
        selectedProviders: ["ga4"],
        recommendedProviders: ["ga4", "posthog"],
        paused: ["ga4"],
        failed: [],
        completed: [],
        activeRuns: [
          {
            id: "setuprun_resume",
            provider: "ga4",
            status: "paused_handoff",
            pendingHandoff: {
              kind: "open_url",
              url: "https://accounts.google.com/o/oauth2/auth?client_id=ga-client-id&state=oauth-state-1#consent",
              instructions: "Finish Google sign-in",
              state: "must-not-leak"
            },
            browserProfile: "ga4",
            accessToken: "tok_1"
          }
        ],
        resolvedPublicArtifacts: {
          ga4: { measurementId: "G-ACME123", propertyId: "123456789", apiSecret: "must-not-leak" },
          posthog: { projectId: null, projectKey: null, apiHost: null },
          x: { pixelId: null, eventTagIds: null }
        }
      },
      notes: ["GA4: finish the browser handoff, then resume setup."],
      internalToken: "must-not-leak"
    }));
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        events.push([sql, params.map(String)]);
        return [];
      },
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from setup_runs")) {
          return {
            id: "setuprun_resume",
            workspace_id: WORKSPACE,
            tool: "ga4",
            provider: "ga4",
            status: "paused_handoff",
            phase_state: { providers: { ga4: { phases: {} } } },
            pending_handoff: null,
            browser_profile: null,
            site_id: null,
            created_at: "2026-06-08T11:00:00.000Z",
            updated_at: "2026-06-08T12:00:00.000Z",
            finished_at: null,
            site_url: null,
            site_repo_path: null,
            site_app_dir: null,
            site_framework: null,
            site_business_type: null
          };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "", resumeSetupRun });

    const denied = await app.inject({
      method: "POST",
      url: "/setup/runs/setuprun_resume/resume",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE }
    });
    const resumed = await app.inject({
      method: "POST",
      url: "/setup/runs/setuprun_resume/resume",
      headers: OPERATOR_HEADERS
    });

    expect(denied.statusCode).toBe(403);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      ok: false,
      resumed: true,
      onboarding: {
        paused: ["ga4"],
        activeRuns: [
          {
            id: "setuprun_resume",
            provider: "ga4",
            status: "paused_handoff",
            pendingHandoff: {
              kind: "open_url",
              url: "https://accounts.google.com/o/oauth2/auth",
              instructions: "Finish Google sign-in"
            }
          }
        ],
        resolvedPublicArtifacts: {
          ga4: { measurementId: "G-ACME123", propertyId: "123456789" }
        },
        installCommand: null
      },
      run: {
        id: "setuprun_resume",
        status: "paused_handoff"
      }
    });
    expect(resumed.body).not.toContain("must-not-leak");
    expect(resumed.body).not.toContain("tok_1");
    expect(resumed.body).not.toContain("oauth-state-1");
    expect(resumed.body).not.toContain("#consent");
    expect(resumeSetupRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        runId: "setuprun_resume"
      })
    );
    expect(events.some(([sql]) => sql.includes("update setup_runs set status = 'running'"))).toBe(false);
  });

  it("surfaces completed setup resumes with the refreshed run summary", async () => {
    let setupRunReads = 0;
    const resumeSetupRun = vi.fn(async () => ({
      ok: true,
      resumed: true,
      onboarding: {
        selectedProviders: ["ga4"],
        recommendedProviders: ["ga4"],
        paused: [],
        failed: [],
        completed: ["ga4"],
        activeRuns: [],
        resolvedPublicArtifacts: {
          ga4: { measurementId: "G-ACME123", propertyId: "123456789" },
          posthog: { projectId: null, projectKey: null, apiHost: null },
          x: { pixelId: null, eventTagIds: null }
        },
        installCommand: "npx infinite-tag install --workspace ws_test --ga4-measurement-id G-ACME123 --yes",
        installArtifactsPath: "/founder-home/.infinite/artifacts/ws_test.json"
      },
      notes: []
    }));
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from setup_runs")) {
          setupRunReads += 1;
          return {
            id: "setuprun_resume",
            workspace_id: WORKSPACE,
            tool: "ga4",
            provider: "ga4",
            status: setupRunReads > 1 ? "completed" : "paused_handoff",
            phase_state: { providers: { ga4: { phases: {} } } },
            pending_handoff: null,
            browser_profile: null,
            site_id: null,
            created_at: "2026-06-08T11:00:00.000Z",
            updated_at: "2026-06-08T12:00:00.000Z",
            finished_at: setupRunReads > 1 ? "2026-06-08T12:30:00.000Z" : null,
            site_url: null,
            site_repo_path: null,
            site_app_dir: null,
            site_framework: null,
            site_business_type: null
          };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "", resumeSetupRun });

    const resumed = await app.inject({
      method: "POST",
      url: "/setup/runs/setuprun_resume/resume",
      headers: OPERATOR_HEADERS
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      ok: true,
      resumed: true,
      onboarding: {
        completed: ["ga4"],
        paused: [],
        failed: [],
        installCommand: "npx infinite-tag install --workspace ws_test --ga4-measurement-id G-ACME123 --yes",
        installArtifactsPath: "/founder-home/.infinite/artifacts/ws_test.json"
      },
      run: {
        id: "setuprun_resume",
        status: "completed",
        finishedAt: "2026-06-08T12:30:00.000Z"
      }
    });
  });

  it("surfaces failed setup resumes with the refreshed run summary", async () => {
    let setupRunReads = 0;
    const resumeSetupRun = vi.fn(async () => ({
      ok: false,
      resumed: true,
      onboarding: {
        selectedProviders: ["ga4"],
        recommendedProviders: ["ga4"],
        paused: [],
        failed: ["ga4"],
        completed: [],
        activeRuns: [],
        resolvedPublicArtifacts: {
          ga4: { measurementId: null, propertyId: null },
          posthog: { projectId: null, projectKey: null, apiHost: null },
          x: { pixelId: null, eventTagIds: null }
        }
      },
      notes: ["GA4 provisioning failed after resume."]
    }));
    const db = {
      query: async () => [],
      one: async (sql: string) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from setup_runs")) {
          setupRunReads += 1;
          return {
            id: "setuprun_resume",
            workspace_id: WORKSPACE,
            tool: "ga4",
            provider: "ga4",
            status: setupRunReads > 1 ? "failed" : "paused_handoff",
            phase_state: { providers: { ga4: { phases: {} } } },
            pending_handoff: null,
            browser_profile: null,
            site_id: null,
            created_at: "2026-06-08T11:00:00.000Z",
            updated_at: "2026-06-08T12:00:00.000Z",
            finished_at: setupRunReads > 1 ? "2026-06-08T12:30:00.000Z" : null,
            site_url: null,
            site_repo_path: null,
            site_app_dir: null,
            site_framework: null,
            site_business_type: null
          };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "", resumeSetupRun });

    const resumed = await app.inject({
      method: "POST",
      url: "/setup/runs/setuprun_resume/resume",
      headers: OPERATOR_HEADERS
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      ok: false,
      resumed: true,
      onboarding: {
        completed: [],
        paused: [],
        failed: ["ga4"]
      },
      run: {
        id: "setuprun_resume",
        status: "failed",
        finishedAt: "2026-06-08T12:30:00.000Z"
      }
    });
  });

  it("updates workspace-scoped setup site metadata for operators", async () => {
    let siteRow = {
      id: "site_1",
      url: "https://acme.test",
      repo_path: "/workspace/acme",
      app_dir: "apps/web",
      framework: "next",
      business_type: "saas"
    };
    const db = {
      query: async () => [],
      one: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (sql.includes("from workspace_sites")) {
          return { id: "site_1" };
        }
        if (sql.includes("update workspace_sites")) {
          siteRow = {
            ...siteRow,
            url: String(params[1] ?? siteRow.url),
            repo_path: String(params[2] ?? siteRow.repo_path),
            app_dir: String(params[3] ?? siteRow.app_dir),
            framework: String(params[4] ?? siteRow.framework),
            business_type: String(params[5] ?? siteRow.business_type)
          };
          return { id: "site_1" };
        }
        return null;
      },
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "" });

    const response = await app.inject({
      method: "POST",
      url: "/setup/site-metadata",
      headers: OPERATOR_HEADERS,
      payload: {
        url: "https://acme-updated.test",
        repoPath: "/workspace/acme",
        appDir: "apps/web",
        framework: "next",
        businessType: "marketplace"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      site: {
        id: "site_1",
        url: "https://acme-updated.test",
        repoPath: "/workspace/acme",
        appDir: "apps/web",
        framework: "next",
        businessType: "marketplace"
      }
    });
  });

  it("creates and lists projects (operator only)", async () => {
    const rows: Array<{ id: string; name: string }> = [];
    const database = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("insert into workspaces")) {
          const id = String(params?.[0]);
          // Mirror the real PK semantics: the caller-supplied-id path inserts with
          // `on conflict (id) do nothing`, which returns NO row for a taken id.
          if (sql.includes("on conflict (id) do nothing") && rows.some((r) => r.id === id)) {
            return null;
          }
          const row = { id, name: String(params?.[1]), createdAt: "t" };
          rows.push(row);
          return row;
        }
        return null;
      },
      async query(sql: string) {
        if (sql.includes("from workspaces")) return rows.map((r) => ({ ...r, createdAt: "t" }));
        return [];
      },
      async close() {}
    };
    try {
      const app = createApp({ database: database as never });
      // Workspace-agnostic: /projects only requires operator authority, no workspace header.
      const denied = await app.inject({ method: "POST", url: "/projects", payload: { name: "Acme" } });
      expect(denied.statusCode).toBe(401);
      const tokenedNonOperator = await app.inject({
        method: "POST",
        url: "/projects",
        headers: { authorization: `Bearer ${READ_TOKEN}` },
        payload: { name: "Acme" }
      });
      expect(tokenedNonOperator.statusCode).toBe(403);
      const created = await app.inject({
        method: "POST", url: "/projects",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload: { name: "Acme" }
      });
      expect(created.json().project.id).toMatch(/^proj_/);
      const listed = await app.inject({ method: "GET", url: "/projects", headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
      expect(listed.json().projects).toHaveLength(1);

      // Caller-supplied id: created under EXACTLY that id (callers feature-detect support by
      // comparing it — an older engine would ignore the field and mint proj_*).
      const supplied = await app.inject({
        method: "POST", url: "/projects",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload: { name: "Brand", id: "2f1a4c8e-9b3d-4f6a-8c1e-5d7b9a0c2e4f" }
      });
      expect(supplied.statusCode).toBe(200);
      expect(supplied.json().project.id).toBe("2f1a4c8e-9b3d-4f6a-8c1e-5d7b9a0c2e4f");

      // A taken id is refused atomically — never renamed, never reclaimed.
      const conflict = await app.inject({
        method: "POST", url: "/projects",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload: { name: "Other Brand", id: "2f1a4c8e-9b3d-4f6a-8c1e-5d7b9a0c2e4f" }
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("project_id_conflict");

      // Shape gate: opaque token chars only, must not start with a separator, 64 max.
      for (const bad of ["-leading-dash", "has space", "a".repeat(65), "semi;colon"]) {
        const invalid = await app.inject({
          method: "POST", url: "/projects",
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: { name: "Bad", id: bad }
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error.code).toBe("invalid_project_id");
      }
    } finally {
      // env restored by afterEach
    }
  });

  it("POST /projects/:id/claim binds a workspace to a cloud account (operator-only, anti-theft)", async () => {
    // Stateful fake `workspaces` modeling owner_id. claimWorkspace runs UPDATE…returning then a SELECT.
    const store: Record<string, { id: string; name: string; ownerId: string | null }> = {
      proj_a: { id: "proj_a", name: "Acme", ownerId: null },
      proj_b: { id: "proj_b", name: "Beta", ownerId: "user-2" }
    };
    const database = {
      async one(sql: string, params?: unknown[]) {
        const id = String(params?.[0]);
        if (sql.includes("update workspaces set owner_id")) {
          const w = store[id];
          const userId = String(params?.[1]);
          if (w && (w.ownerId === null || w.ownerId === userId)) {
            w.ownerId = userId;
            return { id: w.id, name: w.name, createdAt: "t", ownerId: w.ownerId };
          }
          return null;
        }
        if (sql.includes("from workspaces where id")) {
          const w = store[id];
          return w ? { id: w.id, name: w.name, createdAt: "t", ownerId: w.ownerId } : null;
        }
        return null;
      },
      async query() { return []; },
      async close() {}
    };
    const app = createApp({ database: database as never });
    const op = { authorization: `Bearer ${OPERATOR_TOKEN}` };

    // No token → 401; non-operator token → 403; missing userId → 400.
    expect((await app.inject({ method: "POST", url: "/projects/proj_a/claim", payload: { userId: "u1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/projects/proj_a/claim", headers: { authorization: `Bearer ${READ_TOKEN}` }, payload: { userId: "u1" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/projects/proj_a/claim", headers: op, payload: {} })).statusCode).toBe(400);

    // Claim an unowned workspace → 200, owner stamped.
    const claimed = await app.inject({ method: "POST", url: "/projects/proj_a/claim", headers: op, payload: { userId: "u1" } });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().project.ownerId).toBe("u1");

    // Idempotent re-claim by the SAME account → 200.
    expect((await app.inject({ method: "POST", url: "/projects/proj_a/claim", headers: op, payload: { userId: "u1" } })).statusCode).toBe(200);
    // Anti-theft: claiming a workspace owned by ANOTHER account → 409.
    expect((await app.inject({ method: "POST", url: "/projects/proj_b/claim", headers: op, payload: { userId: "u1" } })).statusCode).toBe(409);
    // Unknown workspace → 404.
    expect((await app.inject({ method: "POST", url: "/projects/proj_missing/claim", headers: op, payload: { userId: "u1" } })).statusCode).toBe(404);
  });

  it("rejects requests with no token on a non-public route (401)", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const response = await app.inject({ method: "GET", url: "/capabilities" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("reaches the public OAuth callback route without a token", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const response = await app.inject({
      method: "GET",
      url: "/oauth/callback/google_analytics_4?state=missing&code=auth-code"
    });
    // No token, yet the route is reached (public): returns the route's own 404, not 401.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "oauth_session_not_found" } });
  });

  it("returns 400 when the requested workspace is present but unknown", async () => {
    const db = {
      query: async () => [],
      one: async () => null, // workspaces probe returns null → unknown workspace
      close: async () => {}
    } as unknown as InfiniteOsDb;
    const app = createApp({ database: db, databaseUrl: "" });
    const response = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": "proj_missing" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "unknown_workspace" } });
  });

  it("returns 400 on a workspace-scoped route with no workspace header", async () => {
    const app = createApp({ database: workspaceProbeDb() });
    const response = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "unknown_workspace" } });
  });

  it("serves /capabilities and /chat/sessions/:id without a workspace header", async () => {
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() { return []; },
      async getSession(sessionId) {
        return { id: sessionId, messages: [], actionCalls: [] };
      },
      async searchSessions() { return []; },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? input.sessionId, parentSessionId: input.sessionId };
      }
    };
    const app = createApp({ sessionStore, database: workspaceProbeDb(), databaseUrl: "" });
    const capabilities = await app.inject({
      method: "GET",
      url: "/capabilities",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    const detail = await app.inject({
      method: "GET",
      url: "/chat/sessions/session-1",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    expect(capabilities.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ ok: true, session: { id: "session-1" } });
  });

  it("rejects a read-token (tool_agent) caller on operator-only routes", async () => {
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() { return []; },
      async getSession() { return null; },
      async searchSessions() { return []; },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? input.sessionId, parentSessionId: input.sessionId };
      },
      async getPendingActionCall() {
        return { id: "call_1", sessionId: "session-1", actionId: "start_source_sync", input: {}, inputHash: "h", workspaceId: WORKSPACE };
      },
      async confirmActionCall() {}
    };
    const app = createApp({ sessionStore, database: workspaceProbeDb(), databaseUrl: "" });
    const readHeaders = { authorization: `Bearer ${READ_TOKEN}`, "x-growth-os-workspace": WORKSPACE };
    const gatewayTurn = await app.inject({
      method: "POST",
      url: "/gateway/turn",
      headers: readHeaders,
      payload: { platform: "slack", message: "Revenue?" }
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/chat/actions/confirm_abc/confirm",
      headers: readHeaders
    });
    const project = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      payload: { name: "Acme" }
    });
    expect(gatewayTurn.statusCode).toBe(403);
    expect(confirm.statusCode).toBe(403);
    expect(project.statusCode).toBe(403);
  });
});

// Shared fake DB whose `one` answers the deny-by-default hook's
// `select 1 ... from workspaces` probe truthily (and returns null otherwise).
function workspaceProbeDb(
  options: { sourceLookupErrorCode?: string; sourceLookupError?: Error } = {}
): InfiniteOsDb {
  return {
    query: async () => [],
    one: async (sql: string) => {
      if (sql.includes("from workspaces")) {
        return { ok: 1 };
      }
      if (options.sourceLookupError && sql.includes("from sources")) {
        throw options.sourceLookupError;
      }
      if (options.sourceLookupErrorCode && sql.includes("from sources")) {
        throw Object.assign(new Error("source lookup failed"), { code: options.sourceLookupErrorCode });
      }
      return null;
    },
    close: async () => {}
  } as unknown as InfiniteOsDb;
}


describe("gateway usage delivery", () => {
  beforeEach(() => { vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", OPERATOR_TOKEN); vi.stubEnv("GROWTH_OS_READ_TOKEN", READ_TOKEN); });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["/gateway/turn", "/gateway/turn/stream"])("delivers usage and the captured model through %s", async (url) => {
    const complete = vi.fn(async () => ({ message: "ok", usage: { promptTokens: 12, completionTokens: 3, cacheReadTokens: 0, reasoningTokens: 1 } }));
    const app = createApp({ database: workspaceProbeDb(), modelClient: { complete } });
    try {
      const result = await app.inject({ method: "POST", url, headers: OPERATOR_HEADERS, payload: { message: "hello", model: { modelId: "gpt-5.5", effort: "medium" } } });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('"cacheReadTokens":0');
      expect(result.body).toContain('"reasoningTokens":1');
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: { modelId: "gpt-5.5", effort: "medium" } }));
      if (url.endsWith("stream")) expect(result.body).toContain('"type":"usage.update"');
    } finally { await app.close(); }
  });
  it.each(["/gateway/turn", "/gateway/turn/stream"])("delivers measured usage on failures through %s", async (url) => {
    const app = createApp({ database: workspaceProbeDb(), modelClient: { complete: async () => { throw Object.assign(new Error("failed"), { usage: { promptTokens: 12, cacheReadTokens: 4 } }); } } });
    try {
      const result = await app.inject({ method: "POST", url, headers: OPERATOR_HEADERS, payload: { message: "hello" } });
      expect(result.body).toContain('"code":"turn_failed"');
      expect(result.body).toContain('"usage":{"promptTokens":12,"cacheReadTokens":4}');
    } finally { await app.close(); }
  });
});
