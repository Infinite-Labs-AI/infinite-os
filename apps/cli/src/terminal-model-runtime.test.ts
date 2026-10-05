import * as nativeClaude from "./claude-cli-model-client.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as db from "@infinite-os/db";
import * as llm from "@infinite-os/llm-controller";
import {
  writeInfiniteOsAuthRecord,
  writeInfiniteOsModelSelection,
  writeTerminalModelSelection,
  clearTerminalModelSelection
} from "@infinite-os/config";
import { createCliAgentRuntime } from "./index.js";

it("CLI snapshots terminal selection for each chat while memory and compaction use shared default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terminal-runtime-"));
  const env = {
    HOME: dir,
    GROWTH_OS_HOME: dir,
    GROWTH_OS_WORKSPACE_ROOT: dir,
    GROWTH_OS_WORKSPACE_ID: "test-workspace",
    DATABASE_URL: "postgres://test.invalid/test",
    GROWTH_OS_ENCRYPTION_KEY: "fixture-key"
  };
  const savedEncryption = process.env.GROWTH_OS_ENCRYPTION_KEY;
  const fakeDb = {
    query: async () => [],
    one: async (sql: string) =>
      sql.includes("workspaces")
        ? { ok: 1 }
        : sql.includes("chat_sessions")
          ? { id: "test-session", workspaceId: "test-workspace" }
          : null,
    close: async () => {}
  } as unknown as db.InfiniteOsDb;
  const dbSpy = vi.spyOn(db, "createInfiniteOsDb").mockReturnValue(fakeDb);
  const realClient = llm.createConfiguredModelClient;
  const bodies: Record<string, unknown>[] = [];
  const clientSpy = vi
    .spyOn(llm, "createConfiguredModelClient")
    .mockImplementation((options) =>
      realClient({
        ...options,
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ output: [] }));
        }
      })
    );
  const nativeComplete = vi.fn(async () => ({
    message: "Subscription answer"
  }));
  const nativeClose = vi.fn();
  const nativeSpy = vi
    .spyOn(nativeClaude, "createClaudeCliModelClient")
    .mockReturnValue({
      nativeToolExecution: true,
      complete: nativeComplete,
      close: nativeClose
    });
  const reviewerSpy = vi.spyOn(llm, "createModelBackedMemoryReviewer");
  const controllerSpy = vi.spyOn(llm, "createLlmController").mockImplementation(
    (options) =>
      ({
        chat: async () =>
          options!.modelClient!.complete({
            systemPrompt: "s",
            userMessage: "u",
            tools: [],
            toolResults: []
          })
      }) as unknown as ReturnType<typeof llm.createLlmController>
  );
  try {
    writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" }, env);
    writeInfiniteOsAuthRecord(
      {
        provider: "codex",
        source: "fixture",
        authMode: "fixture",
        token: "fixture-token"
      },
      env
    );
    writeTerminalModelSelection(
      { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
      env
    );
    const runtime = createCliAgentRuntime(env);
    await runtime.chat({ message: "fixture" });
    writeTerminalModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
    await runtime.chat({ message: "fixture" });
    expect(bodies.map((body) => body.model)).toEqual([
      "gpt-6.1-sol",
      "gpt-5.4"
    ]);
    expect(reviewerSpy.mock.calls[0][0]).toBe(clientSpy.mock.results[0].value);
    expect(clientSpy.mock.results[0].value.modelMetadata?.()).toMatchObject({
      model: "gpt-5.5"
    });
    writeTerminalModelSelection(
      { provider: "claude", model: "claude-opus-5-5", effort: "high" },
      env
    );
    await runtime.chat({ message: "fixture" });
    expect(nativeSpy).toHaveBeenCalledOnce();
    expect(nativeComplete).toHaveBeenCalledOnce();
    expect(nativeClose).toHaveBeenCalledOnce();
    await runtime.compactSession("test-session");
    expect(bodies.at(-1)?.model).toBe("gpt-5.5");
    clearTerminalModelSelection(env);
    await runtime.chat({ message: "fixture" });
    expect(nativeSpy).toHaveBeenCalledOnce();
    expect(clientSpy.mock.calls[0][0]).not.toHaveProperty("selection");
    await runtime.close?.();
  } finally {
    nativeSpy.mockRestore();
    dbSpy.mockRestore();
    clientSpy.mockRestore();
    reviewerSpy.mockRestore();
    controllerSpy.mockRestore();
    if (savedEncryption === undefined)
      delete process.env.GROWTH_OS_ENCRYPTION_KEY;
    else process.env.GROWTH_OS_ENCRYPTION_KEY = savedEncryption;
    rmSync(dir, { recursive: true, force: true });
  }
});
