import { describe, expect, it } from "vitest";
import { createInfiniteOsRegistry } from "@infinite-os/runtime";
import { assembleInfiniteOsPrompt } from "../src/prompt-assembler.js";

describe("action manifest description deduplication", () => {
  const actions = createInfiniteOsRegistry({}).list();
  function manifest(modelProvider: "codex" | "claude", toolSchemas = actions.map((a) => ({ name: a.id, summary: a.summary }))) {
    const prompt = assembleInfiniteOsPrompt({ actions, toolSchemas, workspaceId: "synthetic", surface: "desktop", modelProvider });
    return JSON.parse(prompt.split("Typed Infinite OS action manifest:\n")[1]!.split("\n")[0]!);
  }

  it("omits Codex's duplicate prose but retains every action and authority/provenance field", () => {
    const before = actions.map((a) => ({ ...a }));
    expect(manifest("codex")).toEqual(actions.map((a) => ({
      id: a.id, authority: a.authority, category: a.category,
      provenancePolicy: a.provenancePolicy, recommendedNextActions: a.recommendedNextActions,
    })));
    // These same definitions feed real tool schemas; the assembler must not mutate them.
    expect(actions).toEqual(before);
    for (let i = 0; i < actions.length; i++) {
      expect(actions[i]!.summary).toBe(before[i]!.summary);
      expect(actions[i]!.inputSchema).toBe(before[i]!.inputSchema);
    }
  });

  it("retains descriptions for the non-Codex manifest", () => {
    expect(manifest("claude").map((a: { summary: string }) => a.summary)).toEqual(actions.map((a) => a.summary));
  });

  it("keeps unique prose when no matching actual schema description is supplied", () => {
    expect(manifest("codex", []).map((a: { summary: string }) => a.summary)).toEqual(actions.map((a) => a.summary));
    const different = actions.map((a) => ({ name: a.id, summary: "A different schema description" }));
    expect(manifest("codex", different).map((a: { summary: string }) => a.summary)).toEqual(actions.map((a) => a.summary));
  });
});
