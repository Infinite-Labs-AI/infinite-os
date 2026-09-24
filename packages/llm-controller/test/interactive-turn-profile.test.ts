import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInfiniteOsDb, createProjectWithId, runMigrations, type InfiniteOsDb } from "@infinite-os/db";
import { createInfiniteOsRegistry } from "@infinite-os/runtime";

import {
  HOST_OUTCOME_PREFIX,
  assembleInfiniteOsPrompt,
  createLlmController,
  createSessionStore,
  type InfiniteOsMemoryManager,
  type InfiniteOsQueryAdvisor,
  type ModelRequest
} from "../src/index.js";

const WORKSPACE = "ws_profile";
const base = {
  actions: createInfiniteOsRegistry({}).list(),
  workspaceId: WORKSPACE,
  surface: "desktop" as const,
  currentDate: "2026-09-24",
  modelProvider: "codex" as const
};
const ALL_FEATURES = ["workspace.app-tools.v1", "actions.confirmation.v1", "actions.continuation.v1"] as const;

describe("engine prompt: interactive profile", () => {
  it("keeps the legacy prompt unchanged when no profile, the legacy profile, or a human origin is named", () => {
    const legacy = assembleInfiniteOsPrompt(base);
    expect(legacy.startsWith("You are the Infinite OS LLM controller: a growth-data agent, not a general agent OS.")).toBe(true);
    expect(assembleInfiniteOsPrompt({ ...base, agentProfile: "legacy-growth-operator-v1" })).toBe(legacy);
    expect(assembleInfiniteOsPrompt({ ...base, agentProfile: "legacy-growth-operator-v1", turnOrigin: "human",
      interactiveFeatures: [...ALL_FEATURES] })).toBe(legacy);
  });

  it("gives the general profile the general role instead of the growth-data refusal", () => {
    const general = assembleInfiniteOsPrompt({ ...base, agentProfile: "general-marketing-v1", interactiveFeatures: [...ALL_FEATURES] });
    expect(general.startsWith("You are Infinite's primary interactive marketing assistant for this user's business.")).toBe(true);
    expect(general).not.toContain("not a general agent OS");
    expect(general).not.toContain("arbitrary shell, filesystem");
    expect(general).toContain(`Workspace: ${WORKSPACE}. Surface: desktop.`);
    expect(general).toContain("Current date: 2026-09-24.");
    expect(general).toContain("Never fabricate or estimate a business fact");
    // The shared data contract stays: typed actions, their manifest and the answer rules.
    expect(general).toContain("Typed Infinite OS action manifest:");
    expect(general).toContain("Answer requirements:");
    expect(general).toContain("capability_search, then capability_describe and capability_call");
    expect(general).toContain("do not invent another approval step");
    expect(general).toContain("a host-authored outcome may resume this session");
  });

  it("describes only the features the turn really has", () => {
    const bare = assembleInfiniteOsPrompt({ ...base, agentProfile: "general-marketing-v1" });
    expect(bare).not.toContain("mcp__infinite_app__");
    expect(bare).not.toContain("do not invent another approval step");
    expect(bare).not.toContain("a host-authored outcome may resume this session");
    const confirmOnly = assembleInfiniteOsPrompt({ ...base, agentProfile: "general-marketing-v1", interactiveFeatures: ["actions.confirmation.v1"] });
    expect(confirmOnly).toContain("do not invent another approval step");
    expect(confirmOnly).not.toContain("capability_search");
  });

  it("tells the model a continuation turn is the host's report, on either profile", () => {
    for (const agentProfile of ["legacy-growth-operator-v1", "general-marketing-v1"] as const) {
      const prompt = assembleInfiniteOsPrompt({ ...base, agentProfile, turnOrigin: "continuation" });
      expect(prompt).toContain("This turn was started by the host, not by the user.");
      expect(prompt).toContain("not as a new request or new approval");
    }
    expect(assembleInfiniteOsPrompt({ ...base, turnOrigin: "human" })).not.toContain("started by the host");
  });

  it("shows stored host outcomes in session context as host outcomes, and other system rows not at all", () => {
    const prompt = assembleInfiniteOsPrompt({ ...base, recentMessages: [
      { role: "user", content: "Raise the budget to 30." },
      { role: "system", content: `${HOST_OUTCOME_PREFIX}Budget is now USD 30.` },
      { role: "system", content: "Type a message to run a turn." }
    ] });
    expect(prompt).toContain('{"role":"host_outcome","content":"Budget is now USD 30."}');
    expect(prompt).not.toContain("Type a message to run a turn.");
    expect(prompt).not.toContain('"role":"system"');
  });
});

const fixtures: Array<{ dataDir: string; db: InfiniteOsDb }> = [];
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.db.close();
    rmSync(item.dataDir, { recursive: true, force: true });
  }
});

describe("engine chat: continuation turns", { timeout: 60_000 }, () => {
  it("records a host outcome as the host's, never as the user's words, memory or advisor input", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "infinite-os-turn-origin-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    const db = createInfiniteOsDb(url);
    fixtures.push({ dataDir, db });
    await createProjectWithId(db, WORKSPACE, "Workspace");
    // The same narrow adapter the daemon builds over its database (apps/app sessionStoreDb).
    const sessionStore = createSessionStore({
      query: async <T,>(sql: string, params?: unknown[]) => (await db.query(sql, params)) as T[],
      one: async <T,>(sql: string, params?: unknown[]) => (await db.one(sql, params)) as T | null
    });
    const reviewed: string[] = [];
    const memoryManager: InfiniteOsMemoryManager = { async reviewTurn(input) { reviewed.push(input.userMessage); } };
    const advised: string[] = [];
    const queryAdvisor: InfiniteOsQueryAdvisor = { advise(input) { advised.push(input.message); return undefined; } };
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore,
      memoryManager,
      queryAdvisor,
      memoryReview: "blocking",
      modelClient: { complete: async (request) => { requests.push(request); return { message: `reply ${requests.length}` }; } }
    });
    const turn = { workspaceId: WORKSPACE, actorId: "desktop:operator", surface: "desktop" as const, sessionId: "desktop:s1",
      agentProfile: "general-marketing-v1" as const };

    await controller.chat({ ...turn, message: "Raise the fake budget to 30.", turnOrigin: "human" });
    await controller.chat({ ...turn, message: "The approved budget change succeeded: budget is now USD 30.", turnOrigin: "continuation" });
    await controller.chat({ ...turn, message: "What changed?" });

    const session = await sessionStore.getSession("desktop:s1");
    expect(session?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Raise the fake budget to 30."],
      ["assistant", "reply 1"],
      ["system", `${HOST_OUTCOME_PREFIX}The approved budget change succeeded: budget is now USD 30.`],
      ["assistant", "reply 2"],
      ["user", "What changed?"],
      ["assistant", "reply 3"]
    ]);
    expect(reviewed).toEqual(["Raise the fake budget to 30.", "What changed?"]);
    expect(advised).toEqual(["Raise the fake budget to 30.", "What changed?"]);
    expect(requests[1]?.systemPrompt).toContain("This turn was started by the host, not by the user.");
    expect(requests[2]?.systemPrompt).not.toContain("This turn was started by the host");
    expect(requests[2]?.systemPrompt).toContain('{"role":"host_outcome","content":"The approved budget change succeeded: budget is now USD 30."}');
    expect(requests[2]?.systemPrompt).toContain("You are Infinite's primary interactive marketing assistant");
  });
});
