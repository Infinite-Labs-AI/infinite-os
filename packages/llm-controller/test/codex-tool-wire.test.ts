import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeInfiniteOsAuthRecord, writeInfiniteOsModelSelection } from "@infinite-os/config";
import type { InfiniteOsToolSchema, ModelToolResult } from "../src/index.js";
import { createConfiguredModelClient } from "../src/model-client.js";

// Hermetic wire-shape tests for how tool schemas are sent to each provider.
// No network (fetch is injected), no real credentials: GROWTH_OS_HOME and HOME
// both point at fresh temp dirs so neither a stored engine auth record nor a
// ~/.codex / ~/.claude credential from the machine can be picked up.

const OPTIONAL_TARGET_SCHEMA = {
  type: "object",
  properties: { targetWorkspaceId: { type: "string" } },
  required: []
} as const;

const REQUIRED_METRIC_SCHEMA = {
  type: "object",
  properties: {
    metric: { type: "string", enum: ["signups", "sessions"] },
    days: { type: "integer" }
  },
  required: ["metric"]
} as const;

function tools(): InfiniteOsToolSchema[] {
  return [
    {
      name: "read_signups",
      title: "Read signups",
      summary: "Read signups for the current workspace",
      authority: "tool_agent",
      inputSchema: structuredClone(OPTIONAL_TARGET_SCHEMA)
    },
    {
      name: "read_metric",
      title: "Read metric",
      summary: "Read one metric",
      authority: "tool_agent",
      inputSchema: structuredClone(REQUIRED_METRIC_SCHEMA)
    }
  ];
}

type CapturedRequest = { url: string; body: Record<string, unknown> };

function capturingFetch(requests: CapturedRequest[], responseBody: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
}

const CODEX_RESPONSE = { usage: { input_tokens: 1, output_tokens: 1 }, output: [] };
const CLAUDE_RESPONSE = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };

describe("model tool wire shape", () => {
  let growthHome: string;
  let emptyHome: string;

  beforeEach(() => {
    growthHome = mkdtempSync(join(tmpdir(), "growth-os-tool-wire-"));
    emptyHome = mkdtempSync(join(tmpdir(), "growth-os-tool-wire-home-"));
  });

  afterEach(() => {
    rmSync(growthHome, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  function codexEnv(): NodeJS.ProcessEnv {
    const env = { GROWTH_OS_HOME: growthHome, HOME: emptyHome };
    writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-test" }, env);
    writeInfiniteOsAuthRecord(
      { provider: "codex", source: "codex-cli", authMode: "device-code", token: "codex-test-token" },
      env
    );
    return env;
  }

  it("sends strict:false on every Codex function tool and leaves the input schema untouched", async () => {
    const requests: CapturedRequest[] = [];
    const client = createConfiguredModelClient({ env: codexEnv(), fetch: capturingFetch(requests, CODEX_RESPONSE) });

    await client.complete({ systemPrompt: "s", userMessage: "u", tools: tools(), toolResults: [] });

    expect(requests).toHaveLength(1);
    const wireTools = requests[0].body.tools as Array<Record<string, unknown>>;
    expect(wireTools).toHaveLength(2);
    for (const tool of wireTools) {
      expect(tool.type).toBe("function");
      // An omitted `strict` lets the Responses API normalize the schema into
      // strict mode, which forces the model to fill every optional property.
      expect(Object.prototype.hasOwnProperty.call(tool, "strict")).toBe(true);
      expect(tool.strict).toBe(false);
    }
    // Byte-identical to the declared schemas: no injected `required` entries and
    // no `additionalProperties`.
    expect(JSON.stringify(wireTools[0].parameters)).toBe(JSON.stringify(OPTIONAL_TARGET_SCHEMA));
    expect(JSON.stringify(wireTools[1].parameters)).toBe(JSON.stringify(REQUIRED_METRIC_SCHEMA));
    expect(wireTools[0].parameters).toEqual(OPTIONAL_TARGET_SCHEMA);
    expect(wireTools[0].parameters).not.toHaveProperty("additionalProperties");
    expect((wireTools[0].parameters as { required: unknown[] }).required).toEqual([]);
    expect(wireTools.map((tool) => tool.name)).toEqual(["read_signups", "read_metric"]);
  });

  it("sends an empty tools array to Codex when the request has no tools", async () => {
    const requests: CapturedRequest[] = [];
    const client = createConfiguredModelClient({ env: codexEnv(), fetch: capturingFetch(requests, CODEX_RESPONSE) });

    await client.complete({ systemPrompt: "s", userMessage: "u", tools: [], toolResults: [] });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.tools).toEqual([]);
  });

  it("keeps the tools but forbids calling them when a request sets toolChoice none (Codex)", async () => {
    const requests: CapturedRequest[] = [];
    const client = createConfiguredModelClient({ env: codexEnv(), fetch: capturingFetch(requests, CODEX_RESPONSE) });

    await client.complete({ systemPrompt: "s", userMessage: "u", tools: tools(), toolResults: [], toolChoice: "none" });
    await client.complete({ systemPrompt: "s", userMessage: "u", tools: tools(), toolResults: [] });

    expect(requests[0].body.tool_choice).toBe("none");
    expect(requests[0].body.tools).toHaveLength(2);
    expect(requests[1].body).not.toHaveProperty("tool_choice");
  });

  it("keeps the tools but forbids calling them when a request sets toolChoice none (Claude)", async () => {
    const env = { GROWTH_OS_HOME: growthHome, HOME: emptyHome, ANTHROPIC_API_KEY: "test-anthropic-key" };
    writeInfiniteOsModelSelection({ provider: "claude", model: "claude-test" }, env);
    const requests: CapturedRequest[] = [];
    const client = createConfiguredModelClient({ env, fetch: capturingFetch(requests, CLAUDE_RESPONSE) });

    await client.complete({ systemPrompt: "s", userMessage: "u", tools: tools(), toolResults: [], toolChoice: "none" });
    await client.complete({ systemPrompt: "s", userMessage: "u", tools: tools(), toolResults: [] });

    // Tool-use blocks in the history need the tools declared, so the final answer keeps them and sets none.
    expect(requests[0].body.tool_choice).toEqual({ type: "none" });
    expect(requests[0].body.tools).toHaveLength(2);
    expect(requests[1].body).not.toHaveProperty("tool_choice");
  });

  it("leaves the Claude tool wire unchanged: no strict key, input_schema byte-identical", async () => {
    const env = { GROWTH_OS_HOME: growthHome, HOME: emptyHome, ANTHROPIC_API_KEY: "test-anthropic-key" };
    writeInfiniteOsModelSelection({ provider: "claude", model: "claude-test" }, env);
    const requests: CapturedRequest[] = [];
    const client = createConfiguredModelClient({ env, fetch: capturingFetch(requests, CLAUDE_RESPONSE) });

    await client.complete({ systemPrompt: "s", userMessage: "u", tools: tools(), toolResults: [] });

    expect(requests).toHaveLength(1);
    const wireTools = requests[0].body.tools as Array<Record<string, unknown>>;
    expect(wireTools).toHaveLength(2);
    for (const tool of wireTools) {
      expect(Object.keys(tool).sort()).toEqual(["description", "input_schema", "name"]);
    }
    expect(JSON.stringify(wireTools[0].input_schema)).toBe(JSON.stringify(OPTIONAL_TARGET_SCHEMA));
    expect(JSON.stringify(wireTools[1].input_schema)).toBe(JSON.stringify(REQUIRED_METRIC_SCHEMA));
  });

  it("digests the app's list_sources twin like the native: its source rows and its caveats", async () => {
    const requests: CapturedRequest[] = [];
    const client = createConfiguredModelClient({ env: codexEnv(), fetch: capturingFetch(requests, CODEX_RESPONSE) });
    // A union turn's twin result: the bridge's envelope carries the app's list_sources envelope as its data.
    const twin = {
      ok: true,
      actionId: "mcp__infinite_app__list_sources",
      authority: "tool_agent",
      status: "ok",
      data: {
        ok: true,
        actionId: "list_sources",
        authority: "tool_agent",
        status: "ok",
        data: {
          sources: [
            { id: "src_ga4", provider: "ga4", status: "connected", connection_name: "Main site", last_synced_at: "2026-09-28T06:00:00.000Z" }
          ]
        },
        provenance: ["sources"],
        caveats: ["cloud_sources_unavailable"],
        truncated: false,
        nextActions: []
      },
      provenance: [],
      caveats: [],
      truncated: false,
      nextActions: []
    } as unknown as ModelToolResult["result"];

    await client.complete({
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolResults: [{ id: "call_sources", name: "mcp__infinite_app__list_sources", result: twin }]
    });

    const body = JSON.stringify(requests[0].body);
    expect(body).toContain(
      "1. mcp__infinite_app__list_sources: connected sources: ga4 (Main site) status=connected last_synced_at=2026-09-28T06:00:00.000Z. Do not say never synced when last_synced_at or sync runs are present. Caveats: cloud_sources_unavailable."
    );
  });
});
