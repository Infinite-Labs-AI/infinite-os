import { describe, expect, it } from "vitest";

import { createInfiniteOsRegistry } from "@infinite-os/runtime";

import {
  ScopedAppToolResultWithImages,
  createLlmController,
  type ModelRequest,
  type ScopedAppTools
} from "../src/index.js";
import type { ChatSessionStore } from "../src/session-store.js";

// A scoped app tool that returns pictures beside its result (apps/app parseScopedAppToolResult): the pictures reach the
// model on that call's ModelToolResult, while the recorded and returned envelope holds the result alone.

const PICTURE = { mimeType: "image/jpeg", data: "UElDVFVSRS1CQVNFNjQ=" };

function recordingStore(): ChatSessionStore & { recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    recorded,
    async ensureSession() {},
    async appendMessage() {},
    async recordActionCall(input) {
      recorded.push(input.outputEnvelope);
    },
    async recordTokenUsage() {},
    async listSessions() {
      return [];
    },
    async getSession() {
      return null;
    },
    async searchSessions() {
      return [];
    },
    async endSession() {},
    async compactSession() {
      return { sessionId: "child", parentSessionId: "parent" };
    },
    async resumeSession() {}
  };
}

async function runTurn(callTool: ScopedAppTools["callTool"]) {
  const requests: ModelRequest[] = [];
  const store = recordingStore();
  const controller = createLlmController({
    registry: createInfiniteOsRegistry(),
    sessionStore: store,
    modelClient: {
      complete: async (request) => {
        // The controller passes its live toolResults array; copy what this round saw.
        requests.push({ ...request, toolResults: [...request.toolResults] });
        if (request.toolResults.length === 0) {
          return { toolCalls: [{ id: "call_look", name: "mcp__infinite_app__wait_for_ad_creative", input: { runId: "r1" } }] };
        }
        return { message: "The headline says Spring Sale." };
      }
    }
  });
  const result = await controller.chat({
    message: "what does the headline say?",
    sessionId: "session-pictures",
    workspaceId: "ws_test",
    actorId: "operator-1",
    surface: "desktop",
    scopedAppTools: {
      serverName: "infinite_app",
      mode: "union",
      allowedTools: ["mcp__infinite_app__wait_for_ad_creative"],
      tools: [{ name: "wait_for_ad_creative", description: "Wait for a drawn ad.", inputSchema: { type: "object" } }],
      callTool
    }
  });
  return { requests, store, result };
}

describe("scoped app tool pictures", () => {
  it("puts the pictures on the call's model result and keeps them out of the recorded and returned envelope", async () => {
    const { requests, store, result } = await runTurn(async () =>
      new ScopedAppToolResultWithImages({ ok: true, imagesShown: ["Draft 1"] }, [PICTURE])
    );

    expect(requests[1]?.toolResults).toEqual([
      expect.objectContaining({
        id: "call_look",
        name: "mcp__infinite_app__wait_for_ad_creative",
        result: expect.objectContaining({ status: "ok", data: { ok: true, imagesShown: ["Draft 1"] } }),
        images: [PICTURE]
      })
    ]);
    expect(store.recorded).toHaveLength(1);
    expect(JSON.stringify(store.recorded)).not.toContain(PICTURE.data);
    expect(JSON.stringify(result)).not.toContain(PICTURE.data);
    expect(result.actionCalls[0]?.envelope?.data).toEqual({ ok: true, imagesShown: ["Draft 1"] });
  });

  it("a result without pictures carries no images field, as before", async () => {
    const { requests } = await runTurn(async () => ({ ok: true }));
    expect(requests[1]?.toolResults[0]).not.toHaveProperty("images");
    expect(Object.keys(requests[1]!.toolResults[0]!)).toEqual(["id", "name", "result"]);
  });

  it("an error result with pictures is the error alone", async () => {
    const { requests } = await runTurn(async () =>
      new ScopedAppToolResultWithImages({ ok: false, error: { code: "not_found", message: "No run." } }, [PICTURE])
    );
    expect(requests[1]?.toolResults[0]).toMatchObject({ result: { status: "error", error: { code: "not_found" } } });
    expect(requests[1]?.toolResults[0]).not.toHaveProperty("images");
  });
});
