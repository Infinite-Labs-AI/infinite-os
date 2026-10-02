import { describe, expect, it } from "vitest";

import { formatInteractiveProgress } from "./progress.js";

// The one-shot path's progress lines (a pipe, or a terminal without the live
// session). Synthetic data only: made-up tool names and words.
const RAW = "mcp__sample_app__list_sample_rows";
const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, stage: "tool", message: RAW, toolId: "call-1", name: RAW, ...extra }) as never;

describe("one-shot progress lines", () => {
  it("a finished call prints the app's words when the frame carries them", () => {
    expect(formatInteractiveProgress(event("tool.complete", { status: "ok", words: { label: "checking the catalog", result: "3 rows" } }), 0))
      .toBe("  checking the catalog ✓ 3 rows");
  });

  it("without words it prints generic words from the tool's name, never the raw id", () => {
    const line = formatInteractiveProgress(event("tool.complete", { status: "ok", summary: "3 rows" }), 0);
    expect(line).toBe("  listing sample rows ✓ 3 rows");
    expect(line).not.toMatch(/mcp|__/u);
  });

  it("a failed call prints ✗ and its reason", () => {
    expect(formatInteractiveProgress(event("tool.complete", { status: "error", summary: "refused" }), 0)).toBe("  listing sample rows ✗ refused");
  });

  it("a step waiting for the person's OK is pending (▣), never ✓", () => {
    const line = formatInteractiveProgress(event("tool.complete", { status: "requires_confirmation" }), 0);
    expect(line).toBe("  listing sample rows ▣ waiting for your OK");
    expect(formatInteractiveProgress(event("tool.complete", {
      status: "requires_confirmation", words: { label: "waiting for your OK", result: "pause 1 item" }
    }), 0)).toBe("  waiting for your OK ▣ pause 1 item");
    expect(formatInteractiveProgress(event("tool.complete", { status: "requires_confirmation", words: { label: "waiting for your OK" } }), 0))
      .toBe("  waiting for your OK ▣");
  });

  it("a running call prints the app's words, or generic words; never JSON arguments", () => {
    expect(formatInteractiveProgress(event("tool.start", { context: '{"level":"row"}', words: { label: "checking the catalog" } }), 1200))
      .toBe("  ⠋ checking the catalog  1.2s");
    const line = formatInteractiveProgress(event("tool.start", { context: '{"level":"row"}' }), 1200);
    expect(line).toBe("  ⠋ listing sample rows  1.2s");
    expect(formatInteractiveProgress(event("tool.progress", { preview: '{"level":"row"}' }), 1200)).toBe("  ⠋ listing sample rows  1.2s");
  });

  it("a running call keeps a context or preview that is already words", () => {
    expect(formatInteractiveProgress(event("tool.start", { context: "sample revenue by source" }), 1200)).toBe("  ⠋ sample revenue by source  1.2s");
    expect(formatInteractiveProgress(event("tool.progress", { preview: "1 of 3" }), 1200)).toBe("  ⠋ 1 of 3  1.2s");
  });

  it("a tool being prepared is named in plain words", () => {
    const line = formatInteractiveProgress(event("tool.generating"), 1200);
    expect(line).toContain("list sample rows");
    expect(line).not.toMatch(/mcp|__|_/u);
  });
});
