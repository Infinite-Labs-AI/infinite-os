import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScopedAppToolResultWithImages, type ModelRequest } from "@infinite-os/llm-controller";
import type { InfiniteOsDb } from "@infinite-os/db";

import { APP_CAPABILITIES, createApp, parseScopedAppToolResult } from "../src/index.js";

// The scoped app-tool proxy's pictures: an MCP result of one text block followed by image blocks parses the text as
// before and carries the pictures beside it, to the model only. Every other shape is unchanged.

const OPERATOR_TOKEN = "operator-token";
const OPERATOR_HEADERS = { authorization: `Bearer ${OPERATOR_TOKEN}`, "x-growth-os-workspace": "proj_test" };
const BASE64 = "UElDVFVSRS1CQVNFNjQ=";
const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });
const image = (mimeType = "image/jpeg", data = BASE64) => ({ type: "image", data, mimeType });

describe("parseScopedAppToolResult", () => {
  it("one text block parses as before", () => {
    expect(parseScopedAppToolResult({ content: [text({ ok: true })] })).toEqual({ ok: true });
    expect(parseScopedAppToolResult({ content: [{ type: "text", text: "plain" }] })).toBe("plain");
  });

  it("one text block followed by image blocks parses the text and keeps the pictures beside it, in order", () => {
    const parsed = parseScopedAppToolResult({ content: [text({ ok: true, imagesShown: ["a", "b"] }), image(), image("image/png", "QkJC")] });
    expect(parsed).toBeInstanceOf(ScopedAppToolResultWithImages);
    expect(parsed).toEqual(new ScopedAppToolResultWithImages({ ok: true, imagesShown: ["a", "b"] }, [
      { mimeType: "image/jpeg", data: BASE64 },
      { mimeType: "image/png", data: "QkJC" }
    ]));
  });

  it("any other shape is returned as it came", () => {
    const shapes = [
      { content: [] },
      { content: [image()] },
      { content: [text({ ok: true }), text({ ok: false })] },
      { content: [text({ ok: true }), image(), text({ ok: false })] },
      { content: [text({ ok: true }), { type: "image", data: BASE64 }] },
      { content: [text({ ok: true }), { type: "image", data: "", mimeType: "image/jpeg" }] },
      { content: [text({ ok: true }), image("text/html")] },
      { content: [text({ ok: true }), { type: "audio", data: BASE64, mimeType: "audio/wav" }] }
    ];
    for (const shape of shapes) expect(parseScopedAppToolResult(shape)).toBe(shape);
  });
});

describe("/health", () => {
  it("publishes scoped_app_tools_images", async () => {
    expect(APP_CAPABILITIES).toContain("scoped_app_tools_images");
    const app = createApp();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json().capabilities).toContain("scoped_app_tools_images");
    } finally {
      await app.close();
    }
  });
});

describe("a gateway turn whose app tool answers with pictures", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", OPERATOR_TOKEN);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("hands the pictures to the model beside the parsed result, and returns no base64 with the turn", async () => {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [text({ ok: true, imagesShown: ["Draft 1"] }), image()] } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const requests: ModelRequest[] = [];
    const app = createApp({
      database: {
        query: async () => [],
        one: async (sql: string) => (sql.includes("from workspaces") ? { ok: 1 } : null),
        close: async () => {}
      } as unknown as InfiniteOsDb,
      modelClient: {
        complete: async (request) => {
          requests.push({ ...request, toolResults: [...request.toolResults] });
          if (request.toolResults.length === 0) {
            return { toolCalls: [{ id: "call_look", name: "mcp__infinite_app__wait_for_ad_creative", input: { runId: "r1" } }] };
          }
          return { message: "Spring Sale." };
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
          message: "What does the headline say?",
          appTools: {
            serverName: "infinite_app",
            allowedTools: ["mcp__infinite_app__wait_for_ad_creative"],
            tools: [{ name: "wait_for_ad_creative", description: "Wait for a drawn ad.", inputSchema: { type: "object" } }],
            proxy: {
              type: "mcp-jsonrpc-http",
              url: "http://127.0.0.1:18181/mcp",
              headers: { "x-infinite-brain-mcp-token": "t", "x-infinite-mcp-image-blocks": "1" }
            }
          }
        }
      });
      expect(response.statusCode).toBe(200);
      expect(requests[1]?.toolResults).toEqual([
        expect.objectContaining({
          id: "call_look",
          result: expect.objectContaining({ status: "ok", data: { ok: true, imagesShown: ["Draft 1"] } }),
          images: [{ mimeType: "image/jpeg", data: BASE64 }]
        })
      ]);
      expect(response.body).not.toContain(BASE64);
    } finally {
      await app.close();
    }
  });
});
