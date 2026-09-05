import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";
import type { InfiniteOsModelClient, ModelRequest, ModelResponse, ChatSessionStore } from "@infinite-os/llm-controller";
import { createApp } from "../src/index.js";
import { completeAuxiliaryModel, listAuxiliaryBrainUsage, recordAuxiliaryBrainUsage } from "../src/brain-usage-outbox.js";

const HEADERS = { authorization: "Bearer test-operator", "x-growth-os-workspace": "proj_usage_a" };
const REQUEST: ModelRequest = { systemPrompt: "private prompt", userMessage: "private message", tools: [], toolResults: [] };
const metadata = () => ({ provider: "codex" as const, model: "gpt-5.5" });

describe("durable auxiliary brain usage", () => {
  let directory: string;
  let url: string;
  let db: InfiniteOsDb;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "aux-usage-"));
    url = `pglite://${directory}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
    await db.query("insert into workspaces(id, name) values ('proj_usage_a','A'), ('proj_usage_b','B')");
  }, 60_000);
  beforeEach(async () => {
    vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", "test-operator");
    vi.stubEnv("GROWTH_OS_READ_TOKEN", "test-read");
    await db.query("delete from auxiliary_brain_usage_outbox");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("durably preserves outcomes, unknown counters and zero across a reopen, without content", async () => {
    const model: InfiniteOsModelClient = { modelMetadata: metadata, complete: async () => ({ message: "private output", usage: { promptTokens: 12, cacheReadTokens: 0 } }) };
    await completeAuxiliaryModel(db, model, "memory_review", "proj_usage_a", REQUEST);
    await expect(completeAuxiliaryModel(db, { modelMetadata: metadata, complete: async () => { throw new Error("secret provider error text"); } }, "compaction", "proj_usage_b", REQUEST)).rejects.toThrow();
    const original = await listAuxiliaryBrainUsage(db);
    expect(original).toHaveLength(2);
    expect(original[0]).toMatchObject({ status: "succeeded", usage: { promptTokens: 12, cacheReadTokens: 0 }, effort: null });
    expect(original[1]).toMatchObject({ status: "failed", usage: null });
    expect(JSON.stringify(original)).not.toMatch(/private|secret/);
    await recordAuxiliaryBrainUsage(db, original[0]); // stable ID retries never create duplicates
    await db.close();
    db = createInfiniteOsDb(url);
    expect(await listAuxiliaryBrainUsage(db)).toEqual(original);
  });

  it("requires operator authority and prevents cross-project ACK while allowing idempotent retries", async () => {
    await completeAuxiliaryModel(db, { modelMetadata: metadata, complete: async () => ({}) }, "memory_review", "proj_usage_a", REQUEST);
    const app = createApp({ database: db });
    try {
      const forbidden = await app.inject({ method: "GET", url: "/brain/usage/pending", headers: { authorization: "Bearer test-read" } });
      expect(forbidden.statusCode).toBe(403);
      const missingAuth = await app.inject({ method: "GET", url: "/brain/usage/pending" });
      expect(missingAuth.statusCode).toBe(401);
      const pending = await app.inject({ method: "GET", url: "/brain/usage/pending", headers: { authorization: HEADERS.authorization } });
      const ids = pending.json().receipts.map((receipt: { id: string }) => receipt.id);
      expect(ids).toHaveLength(1);
      const wrong = await app.inject({ method: "POST", url: "/brain/usage/ack", headers: { ...HEADERS, "x-growth-os-workspace": "proj_usage_b" }, payload: { receiptIds: ids } });
      expect(wrong.statusCode).toBe(200);
      expect(await listAuxiliaryBrainUsage(db)).toHaveLength(1);
      const invalid = await app.inject({ method: "POST", url: "/brain/usage/ack", headers: HEADERS, payload: { receiptIds: ["invalid"] } });
      expect(invalid.statusCode).toBe(400);
      for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: "/brain/usage/ack", headers: HEADERS, payload: { receiptIds: ids } })).statusCode).toBe(200);
      expect(await listAuxiliaryBrainUsage(db)).toEqual([]);
    } finally { await app.close(); }
  });

  it("records background memory after the chat response closes with its explicit model and stable project cache key", async () => {
    let finishMemory!: (response: ModelResponse) => void;
    const memory = new Promise<ModelResponse>(resolve => { finishMemory = resolve; });
    const requests: ModelRequest[] = [];
    const app = createApp({ database: db, modelClient: { modelMetadata: metadata, complete: async request => {
      requests.push(request);
      return request.systemPrompt.startsWith("Review this") ? memory : { message: "hello", usage: { promptTokens: 20, completionTokens: 4 } };
    } } });
    try {
      const response = await app.inject({ method: "POST", url: "/gateway/turn/stream", headers: HEADERS, payload: { message: "hello", memoryModel: { modelId: "gpt-5.6-luna", effort: "low" } } });
      expect(response.body).toContain("event: done");
      expect(await listAuxiliaryBrainUsage(db)).toEqual([]);
      finishMemory({ message: '{"memories":[]}', usage: { promptTokens: 6, cacheReadTokens: 0, completionTokens: 1 } });
      await vi.waitFor(async () => expect(await listAuxiliaryBrainUsage(db)).toHaveLength(1));
      const [receipt] = await listAuxiliaryBrainUsage(db);
      expect(receipt).toMatchObject({ feature: "memory_review", engineProjectId: "proj_usage_a", model: "gpt-5.6-luna", effort: "low", usage: { promptTokens: 6, completionTokens: 1 } });
      expect(requests.find(request => request.systemPrompt.startsWith("Review this"))).toMatchObject({ model: { modelId: "gpt-5.6-luna", effort: "low" }, promptCacheKey: "memory:proj_usage_a" });
    } finally { finishMemory({ message: '{"memories":[]}' }); await app.close(); }
  });

  it("meters compaction, skips caller-supplied summaries, and rejects a foreign project before inference", async () => {
    const complete = vi.fn(async () => ({ message: "compact summary", usage: { promptTokens: 15, completionTokens: 3 } }));
    const sessionStore = { getSession: async () => ({ id: "test", workspaceId: "proj_usage_a", messages: [], actionCalls: [] }), compactSession: async () => ({ sessionId: "next", parentSessionId: "test" }) } as unknown as ChatSessionStore;
    const app = createApp({ database: db, sessionStore, modelClient: { modelMetadata: metadata, complete } });
    try {
      const wrong = await app.inject({ method: "POST", url: "/chat/sessions/test/compact", headers: { ...HEADERS, "x-growth-os-workspace": "proj_usage_b" }, payload: {} });
      expect(wrong.statusCode).toBe(404);
      expect(complete).not.toHaveBeenCalled();
      expect((await app.inject({ method: "POST", url: "/chat/sessions/test/compact", headers: HEADERS, payload: { summaryText: "already summarized" } })).statusCode).toBe(200);
      expect(await listAuxiliaryBrainUsage(db)).toEqual([]);
      expect((await app.inject({ method: "POST", url: "/chat/sessions/test/compact", headers: HEADERS, payload: {} })).statusCode).toBe(200);
      expect(await listAuxiliaryBrainUsage(db)).toEqual([expect.objectContaining({ feature: "compaction", engineProjectId: "proj_usage_a", usage: { promptTokens: 15, completionTokens: 3 } })]);
    } finally { await app.close(); }
  });
});
