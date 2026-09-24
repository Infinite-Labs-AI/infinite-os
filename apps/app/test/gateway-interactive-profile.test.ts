import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfiniteOsDb } from "@infinite-os/db";
import type { ModelRequest } from "@infinite-os/llm-controller";

import { createApp } from "../src/index.js";

const OPERATOR_TOKEN = "operator-token";
const READ_TOKEN = "read-token";
const HEADERS = { authorization: `Bearer ${OPERATOR_TOKEN}`, "x-growth-os-workspace": "proj_test" };
const ROUTES = ["/gateway/turn", "/gateway/turn/stream"] as const;

function workspaceProbeDb(): InfiniteOsDb {
  return {
    query: async () => [],
    one: async (sql: string) => (sql.includes("from workspaces") ? { ok: 1 } : null),
    close: async () => {}
  } as unknown as InfiniteOsDb;
}

function appTools(mode?: "union" | "exclusive") {
  return {
    serverName: "infinite_app",
    allowedTools: ["mcp__infinite_app__capability_search"],
    tools: [{ name: "capability_search", description: "Search capabilities.", inputSchema: { type: "object" } }],
    proxy: { type: "mcp-jsonrpc-http", url: "http://127.0.0.1:18181/mcp", headers: { "x-infinite-brain-mcp-token": "t" } },
    ...(mode ? { mode } : {})
  };
}

function appWithModel() {
  const requests: ModelRequest[] = [];
  const app = createApp({
    database: workspaceProbeDb(),
    modelClient: { complete: async (request) => { requests.push(request); return { message: "ok" }; } }
  });
  return { app, requests };
}

describe("gateway turns: interactive profile and turn origin", () => {
  beforeEach(() => { vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", OPERATOR_TOKEN); vi.stubEnv("GROWTH_OS_READ_TOKEN", READ_TOKEN); });
  afterEach(() => vi.unstubAllEnvs());

  it("advertises both capabilities so a desktop can fail closed on an older daemon", async () => {
    const app = createApp();
    try {
      const body = (await app.inject({ method: "GET", url: "/health" })).json();
      expect(body.capabilities).toEqual(expect.arrayContaining(["interactive_general_profile", "interactive_turn_origin"]));
    } finally { await app.close(); }
  });

  it.each(ROUTES)("runs a general, union-tool turn on the general prompt through %s", async (url) => {
    const { app, requests } = appWithModel();
    try {
      const result = await app.inject({ method: "POST", url, headers: HEADERS, payload: {
        platform: "desktop", message: "Draft a launch plan.", agentProfile: "general-marketing-v1",
        interactiveFeatures: ["workspace.app-tools.v1", "actions.confirmation.v1", "actions.continuation.v1"],
        appTools: appTools("union")
      } });
      expect(result.statusCode).toBe(200);
      expect(requests[0]?.systemPrompt.startsWith("You are Infinite's primary interactive marketing assistant")).toBe(true);
      expect(requests[0]?.systemPrompt).toContain("capability_search, then capability_describe");
    } finally { await app.close(); }
  });

  it.each(ROUTES)("marks a continuation turn as the host's report through %s", async (url) => {
    const { app, requests } = appWithModel();
    try {
      const result = await app.inject({ method: "POST", url, headers: HEADERS, payload: {
        platform: "desktop", message: "The approved change succeeded.", turnOrigin: "continuation"
      } });
      expect(result.statusCode).toBe(200);
      expect(requests[0]?.systemPrompt).toContain("This turn was started by the host, not by the user.");
    } finally { await app.close(); }
  });

  it.each(ROUTES)("keeps the legacy prompt when no interactive field is sent through %s", async (url) => {
    const { app, requests } = appWithModel();
    try {
      const result = await app.inject({ method: "POST", url, headers: HEADERS, payload: { platform: "desktop", message: "Revenue?" } });
      expect(result.statusCode).toBe(200);
      expect(requests[0]?.systemPrompt.startsWith("You are the Infinite OS LLM controller: a growth-data agent")).toBe(true);
      expect(requests[0]?.systemPrompt).not.toContain("started by the host");
    } finally { await app.close(); }
  });

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ["an unknown profile", { agentProfile: "general-marketing-v2" }, "invalid_agent_profile"],
    ["a non-string profile", { agentProfile: 1 }, "invalid_agent_profile"],
    ["an unknown feature", { interactiveFeatures: ["actions.autopilot.v1"] }, "invalid_interactive_features"],
    ["features that are not a list", { interactiveFeatures: "actions.confirmation.v1" }, "invalid_interactive_features"],
    ["app tools claimed with no app tools", { interactiveFeatures: ["workspace.app-tools.v1"] }, "interactive_features_unavailable"],
    ["app tools claimed on an exclusive turn", { interactiveFeatures: ["workspace.app-tools.v1"], appTools: appTools("exclusive") }, "interactive_features_unavailable"],
    ["an unknown origin", { turnOrigin: "user" }, "invalid_turn_origin"]
  ];
  for (const url of ROUTES) {
    it.each(refusals)(`refuses %s before any model call through ${url}`, async (_label, fields, code) => {
      const { app, requests } = appWithModel();
      try {
        const result = await app.inject({ method: "POST", url, headers: HEADERS, payload: { platform: "desktop", message: "Hi.", ...fields } });
        expect(result.statusCode).toBe(400);
        expect(result.json()).toMatchObject({ ok: false, error: { code } });
        expect(requests).toHaveLength(0);
      } finally { await app.close(); }
    });
  }
});
