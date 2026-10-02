import { afterEach, describe, expect, it } from "vitest";

import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import { stripAnsi } from "../lib/display-width.js";
import { INFINITE_R4_THEME } from "../theme.js";
import { stepStripLines, stepsFromTrail } from "../views/steps.js";
import { renderInfiniteTranscript } from "./transcript-renderer.js";
import { InfiniteTurnController, getTurnState, resetTurnState } from "./turn-controller.js";

// The Steps strip fed by live bridge frames (tool.start / tool.complete), with
// and without the app's words (step.words.v1). Synthetic data only: made-up
// tool names and words, as infinite-os is public.
const RAW = "mcp__sample_app__list_sample_rows";
const start = (toolId: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool.start", stage: "tool", message: name, toolId, name, context: '{"level":"row","limit":25}', ...extra }) as never;
const complete = (toolId: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool.complete", stage: "tool", message: name, toolId, name, status: "ok", ...extra }) as never;
const rows = () => getTurnState().steps.map(({ label, status, result }) => ({ label, status, result }));
const stripText = (width = 100) =>
  stepStripLines(getTurnState().steps, { width, color: false, theme: INFINITE_R4_THEME, nowMs: 2_000 }).join("\n");

describe("the Steps strip from live frames", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("uses the app's label and result when the frames carry words", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", RAW, { words: { label: "checking the catalog" } }));
    expect(rows()).toEqual([{ label: "checking the catalog", status: "run", result: "" }]);

    controller.recordProgressEvent(complete("call-1", RAW, { words: { label: "checking the catalog", result: "3 rows" } }));
    expect(rows()).toEqual([{ label: "checking the catalog", status: "ok", result: "3 rows" }]);
    expect(stripText()).toMatch(/^ {2}checking the catalog +━+ +✓ 3 rows$/mu);
  });

  it("words that arrive only on the complete frame rename the row", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", RAW));
    controller.recordProgressEvent(complete("call-1", RAW, { words: { label: "checking the catalog", result: "3 rows" } }));
    expect(rows()).toEqual([{ label: "checking the catalog", status: "ok", result: "3 rows" }]);
  });

  it("with words and no result the row has no result: a raw summary is never printed in its place", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(complete("call-1", RAW, { words: { label: "checking the catalog" }, summary: '{"rows":[1,2,3]}' }));
    expect(rows()).toEqual([{ label: "checking the catalog", status: "ok", result: "" }]);
  });

  it("without words the label is generic words from the tool's name: no namespace, no id, no arguments", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", RAW));
    controller.recordProgressEvent(complete("call-1", RAW, { summary: "3 rows" }));
    expect(rows()).toEqual([{ label: "listing sample rows", status: "ok", result: "3 rows" }]);
    const text = stripText();
    expect(text).not.toMatch(/mcp|__|_|\{|\(|"/u);
  });

  it("without words a JSON summary is never printed as the result", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(complete("call-1", RAW, { summary: '{"rows":[{"id":"r1"}]}' }));
    controller.recordProgressEvent(complete("call-2", RAW, { summary: '[{"id":"r1"}]' }));
    expect(rows().map((row) => row.result)).toEqual(["", ""]);
  });

  it("a running call never shows its JSON arguments or a JSON progress preview", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", RAW));
    controller.recordProgressEvent({ type: "tool.progress", stage: "tool", message: RAW, toolId: "call-1", name: RAW, preview: '{"level":"row"}' } as never);
    const out = renderInfiniteTranscript({ messages: [{ role: "user", text: "q" }], state: getTurnState() }, { columns: 100, theme: INFINITE_R4_THEME, nowMs: 1_500 });
    expect(out).toContain("listing sample rows");
    expect(out).toMatch(/⠋|[⠀-⣿]/u);
    expect(out).toContain("running");
    expect(out).not.toMatch(/level|\{|mcp|__/u);
  });

  it("a running call shows a progress preview that is words", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", RAW));
    controller.recordProgressEvent({ type: "tool.progress", stage: "tool", message: RAW, toolId: "call-1", name: RAW, preview: "1 of 3" } as never);
    const out = renderInfiniteTranscript({ messages: [{ role: "user", text: "q" }], state: getTurnState() }, { columns: 100, theme: INFINITE_R4_THEME, nowMs: 1_500 });
    expect(out).toContain("1 of 3");
  });
});

describe("one row per call, never merged by tool name", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("two calls to one tool are two rows, and the failed one keeps its own row", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", "queue_sample_draft"));
    controller.recordProgressEvent(complete("call-1", "queue_sample_draft", { summary: "queued" }));
    controller.recordProgressEvent(start("call-2", "queue_sample_draft"));
    controller.recordProgressEvent(complete("call-2", "queue_sample_draft", { status: "error", summary: "refused" }));
    expect(rows()).toEqual([
      { label: "queue sample draft", status: "ok", result: "queued" },
      { label: "queue sample draft", status: "fail", result: "refused" }
    ]);
  });

  it("frames with no call id (an older desktop's completes) each get their own row", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(complete("", "mcp__sample_app__list_sample_rows"));
    controller.recordProgressEvent(complete("", "mcp__sample_app__get_sample_report"));
    controller.recordProgressEvent(complete("", "mcp__sample_app__list_sample_rows", { status: "error" }));
    expect(rows()).toEqual([
      { label: "listing sample rows", status: "ok", result: "" },
      { label: "getting sample report", status: "ok", result: "" },
      { label: "listing sample rows", status: "fail", result: "" }
    ]);
    expect(new Set(getTurnState().steps.map((step) => step.id)).size).toBe(3);
  });

  it("a start and its complete with no call id are one row; two overlapping ones are two", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("", "list_sample_rows"));
    controller.recordProgressEvent(start("", "list_sample_rows"));
    expect(rows().map((row) => row.status)).toEqual(["run", "run"]);
    expect(getTurnState().tools).toHaveLength(2);

    controller.recordProgressEvent(complete("", "list_sample_rows", { summary: "first" }));
    expect(rows()).toEqual([
      { label: "listing sample rows", status: "ok", result: "first" },
      { label: "listing sample rows", status: "run", result: "" }
    ]);
    controller.recordProgressEvent(complete("", "list_sample_rows", { summary: "second" }));
    expect(rows().map((row) => row.result)).toEqual(["first", "second"]);
    expect(getTurnState().tools).toHaveLength(0);
  });
});

describe("a step that waits for the person's OK is pending, not finished", () => {
  afterEach(() => {
    resetTurnState();
  });

  const PROPOSE = "mcp__sample_app__propose_pause_sample_item";

  it("draws requires_confirmation as r4's needs-you glyph in amber, never ✓", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", PROPOSE, { words: { label: "waiting for your OK" } }));
    controller.recordProgressEvent(complete("call-1", PROPOSE, { status: "requires_confirmation", words: { label: "waiting for your OK", result: "pause 1 item" } }));
    expect(rows()).toEqual([{ label: "waiting for your OK", status: "wait", result: "pause 1 item" }]);

    const [, row] = stepStripLines(getTurnState().steps, { width: 100, color: true, theme: INFINITE_R4_THEME, nowMs: 1_000 });
    const segments = r4Segments(row!);
    expect(segments).toContainEqual(seg(["▣", "amber"])[0]);
    expect(stripAnsi(row!)).not.toContain("✓");
    // The bar of a step that is not finished stays cyan (r4 `region-steps` wait row).
    expect(segments.some((segment) => segment.style === "cyan" && segment.text.includes("━"))).toBe(true);
  });

  it("without words it still says it is waiting, in neutral words", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(complete("call-1", PROPOSE, { status: "requires_confirmation" }));
    expect(rows()).toEqual([{ label: "proposing pause sample item", status: "wait", result: "" }]);
    expect(stripText()).toMatch(/▣ waiting for your OK$/mu);
    expect(stripText()).not.toContain("✓");
  });

  it("a call that waits for an answer says so, not that it waits for an OK", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(complete("call-1", PROPOSE, { status: "needs_clarification" }));
    expect(rows()).toEqual([{ label: "proposing pause sample item", status: "wait", result: "waiting for an answer" }]);
    expect(stripText()).toMatch(/▣ waiting for an answer$/mu);
    expect(stripText()).not.toContain("waiting for your OK");
  });

  it("its trail line carries the pending mark, and reads back as waiting", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(complete("call-1", PROPOSE, { status: "requires_confirmation" }));
    controller.recordProgressEvent(complete("call-2", "list_sample_rows", { summary: "3 rows" }));
    const done = controller.recordMessageComplete({ text: "Ready for your OK." });
    const tools = done.finalMessages.flatMap((msg) => msg.tools ?? []);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.endsWith(" ▣")).toBe(true);
    expect(tools[0]!.endsWith(" ✓")).toBe(false);
    expect(stepsFromTrail(done.finalMessages).map(({ label, status }) => ({ label, status }))).toEqual([
      { label: "proposing pause sample item", status: "wait" },
      { label: "listing sample rows", status: "ok" }
    ]);
  });

  it("a trail line made from the app's words reads back as those words", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent(start("call-1", RAW, { words: { label: "checking the catalog" } }));
    controller.recordProgressEvent(complete("call-1", RAW, { words: { label: "checking the catalog", result: "3 rows" } }));
    const done = controller.recordMessageComplete({ text: "Done." });
    const tools = done.finalMessages.flatMap((msg) => msg.tools ?? []);
    expect(tools.join("\n")).not.toMatch(/level|\{|mcp|__/u);
    expect(stepsFromTrail(done.finalMessages).map(({ label, status, result }) => ({ label, status, result }))).toEqual([
      { label: "checking the catalog", status: "ok", result: "3 rows" }
    ]);
  });
});

describe("what a turn says while a tool is being prepared", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("never names the raw tool", () => {
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent({ type: "tool.generating", stage: "tool", message: RAW, name: RAW } as never);
    const state = getTurnState();
    const said = [...state.activity.map((item) => item.text), ...state.turnTrail].join("\n");
    expect(said).toContain("list sample rows");
    expect(said).not.toMatch(/mcp|Mcp|__|_/u);
  });
});
