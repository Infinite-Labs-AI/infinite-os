import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";

import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import { displayWidth, stripAnsi } from "../lib/display-width.js";
import { INFINITE_R4_THEME } from "../theme.js";
import { InfiniteTurnController } from "./turn-controller.js";
import { renderLiveTurn } from "../views/layout.js";
import type { Msg } from "../types.js";
import { besideWorkingTurn, renderInfiniteTranscript, workingTurnMessages, workingTurnSteps } from "./transcript-renderer.js";
import { getTurnState, resetTurnState, type TurnState } from "./turn-store.js";

// The transcript in the r4 look (terminal-r4 `frame()`): the answer column with
// no box at any width, the Steps strip from the turn store, and a streamed
// answer that never shows a marker it has not closed. Synthetic data only.
const theme = INFINITE_R4_THEME;
const LONG = "Spend is up on the week, and two ads carry most of it. ".repeat(6).trim();

describe("the answer column (no box, the whole window)", () => {
  it.each([60, 100, 160, 200])("a turn without views has no box or gutter at %i columns and uses the width", (columns) => {
    const out = renderInfiniteTranscript(
      { messages: [{ role: "user", text: "how are the ads?" }, { role: "assistant", text: LONG }] },
      { columns, theme }
    ).split("\n");
    expect(out[0]).toBe("❯ how are the ads?");
    expect(out[1]).toBe("");
    expect(out[2]?.startsWith("∞ Spend is up")).toBe(true);
    expect(out.join("\n")).not.toMatch(/[╭╮╰╯┊]/u);
    expect(out.every((line) => displayWidth(line) <= columns - 1)).toBe(true);
    // Fluid: the answer wraps near the window's edge, not at a 100-column cap.
    expect(Math.max(...out.map(displayWidth))).toBeGreaterThan(columns - 12);
  });

  it("paints the marks cyan, the question b, the answer in the body colour", () => {
    const [question, , answer] = renderInfiniteTranscript(
      { messages: [{ role: "user", text: "how are the ads?" }, { role: "assistant", text: "Fine." }] },
      { columns: 80, theme, color: true }
    ).split("\n");
    expect(r4Segments(question!)).toEqual(seg(["❯", "cyan"], [" ", ""], ["how are the ads?", "b"]));
    expect(r4Segments(answer!)).toEqual(seg(["∞", "cyan"], [" Fine.", ""]));
  });

  it("wraps a long question under its first word and never cuts it (eval N11)", () => {
    const question = "which of my ads had the longest view length on the landing page last week";
    const out = renderInfiniteTranscript({ messages: [{ role: "user", text: question }] }, { columns: 30, theme }).split("\n");
    expect(out[0]?.startsWith("❯ which")).toBe(true);
    expect(out.slice(1).every((line) => line.startsWith("  ") && !line.startsWith("   "))).toBe(true);
    expect(out.map((line) => line.slice(2)).join(" ")).toBe(question);
    expect(out.join("")).not.toContain("…");
  });
});

describe("a streamed answer never shows an open marker (eval M4)", () => {
  it("holds a half-received bold span while streaming", () => {
    const state = { ...getTurnState(), streaming: "Try the **Cold brew car" };
    const out = renderInfiniteTranscript({ state }, { columns: 80, theme });
    expect(out).toBe("∞ Try the Cold brew car");
  });

  it("draws the span bold once it closes", () => {
    const state = { ...getTurnState(), streaming: "Try the **Cold brew carousel**" };
    const out = renderInfiniteTranscript({ state }, { columns: 80, theme, color: true });
    expect(stripAnsi(out)).toBe("∞ Try the Cold brew carousel");
    expect(out).toContain("\u001b[1mCold brew carousel\u001b[22m");
  });

  it("a stopped turn keeps its partial answer without the marker", () => {
    resetTurnState();
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent({ type: "message.start", stage: "message", message: "" });
    controller.recordProgressEvent({ type: "message.delta", stage: "message", message: "", text: "Pause **Cold brew car" });
    const partial = controller.stoppedTranscript();
    // The words are kept as written (copy and history see them whole); the open marker is held when drawn.
    expect(partial.at(-1)).toEqual({ role: "assistant", text: "Pause **Cold brew car", partial: true });
    expect(renderInfiniteTranscript({ messages: partial }, { columns: 80, theme })).toBe("∞ Pause Cold brew car");
    controller.reset();
  });

  it("a stopped answer's URL is kept whole", () => {
    resetTurnState();
    const controller = new InfiniteTurnController(() => 1_000);
    controller.recordProgressEvent({ type: "message.start", stage: "message", message: "" });
    controller.recordProgressEvent({ type: "message.delta", stage: "message", message: "", text: "See https://x.com/_foo and **bo" });
    const partial = controller.stoppedTranscript();
    expect(partial.at(-1)?.text).toBe("See https://x.com/_foo and **bo");
    expect(renderInfiniteTranscript({ messages: partial }, { columns: 80, theme })).toBe("∞ See https://x.com/_foo and bo");
    controller.reset();
  });
});

describe("the Steps strip from the turn store", () => {
  it("one row per call with friendly labels; a write waiting for an OK is ▣; a stop marks the running call", () => {
    resetTurnState();
    let now = 0;
    const controller = new InfiniteTurnController(() => now);
    const start = (toolId: string, name: string) => controller.recordProgressEvent({ type: "tool.start", stage: "tool", message: "", toolId, name, context: "{\"id\":\"x\"}" });
    const done = (toolId: string, name: string, status: string, summary: string) =>
      controller.recordProgressEvent({ type: "tool.complete", stage: "tool", message: "", toolId, name, summary, status: status as never });
    start("c1", "mcp__infinite_app__seo_queue_draft");
    now = 400;
    done("c1", "mcp__infinite_app__seo_queue_draft", "error", "rejected");
    start("c2", "mcp__infinite_app__seo_queue_draft");
    now = 800;
    done("c2", "mcp__infinite_app__seo_queue_draft", "error", "rejected again");
    start("c3", "mcp__infinite_app__propose_pause_entity");
    now = 900;
    done("c3", "mcp__infinite_app__propose_pause_entity", "requires_confirmation", "pause 1 ad");
    start("c4", "mcp__infinite_app__list_meta_entities");
    now = 1_000;
    controller.stoppedTranscript();

    const rows = renderInfiniteTranscript({ state: getTurnState() }, { columns: 100, theme, nowMs: 1_000 }).split("\n");
    expect(rows[0]).toMatch(/^─ Steps ─+$/u);
    expect(rows.slice(1).map((row) => row.replace(/\s*[━╍]+\s*/u, " | "))).toEqual([
      "  seo queue draft | ✗ rejected",
      "  seo queue draft | ✗ rejected again",
      "  proposing pause entity | ▣ pause 1 ad",
      "  listing Meta entities | ■ stopped"
    ]);
    expect(rows.join("\n")).not.toMatch(/mcp|Mcp|\{"id"/u);
    controller.reset();
    resetTurnState();
  });

  it("a call still running when the turn ends has no known outcome (?)", () => {
    resetTurnState();
    const controller = new InfiniteTurnController(() => 500);
    controller.recordProgressEvent({ type: "tool.start", stage: "tool", message: "", toolId: "c1", name: "get_report", context: "" });
    controller.reset();
    const [step] = getTurnState().steps;
    expect(step).toMatchObject({ id: "c1", label: "getting report", status: "unk", endedAt: 500 });
    resetTurnState();
  });
});

describe("a running call says how far it is (run-2 M5c)", () => {
  const images = (ready: number) => ({
    v: 1, kind: "images", tool: "generate_ad_images", title: "Making 3 creatives", state: "working", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { runId: "r1", requested: 3, ready, failed: 0, items: [], format: "png", aspectRatio: "4:5", model: "m", madeWith: "infinite" }
  });
  const job = {
    v: 1, kind: "job", tool: "write_blog_post", title: "Blog post", state: "background", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: {
      jobId: "j1", label: "Blog post", phase: "running", startedAt: null, runsWhere: "cloud", outlivesTurn: true, noCompletionSignal: false,
      steps: [{ id: "a", label: "Research", state: "done" }, { id: "b", label: "Outline", state: "done" }, { id: "c", label: "Draft", state: "now" },
        { id: "d", label: "Images", state: "todo" }, { id: "e", label: "Ready", state: "todo" }]
    }
  };
  const running = (name: string, frames: unknown[]): TurnState => {
    resetTurnState();
    const state = getTurnState();
    return {
      ...state,
      tools: [{ id: "c1", name, startedAt: 0 }],
      steps: [{ id: "c1", name, label: "making 3 creatives", status: "run", startedAt: 0, endedAt: null, result: "" }],
      views: frames.map((view, index) => ({ type: "tool.view", stage: "tool", message: "", viewId: `v${index}`, name, view })) as TurnState["views"]
    };
  };

  it("the latest view of the call gives its progress (1 of 3, step 3 of 5), never a bare \"running\"", () => {
    expect(workingTurnSteps([], running("mcp__app__generate_ad_images", [images(0), images(1)]), 1_000)[0]!.result).toBe("1 of 3");
    expect(workingTurnSteps([], running("write_blog_post", [job]), 1_000)[0]!.result).toBe("step 3 of 5");
    expect(workingTurnSteps([], running("other_tool", [images(1)]), 1_000)[0]!.result).toBe("running");
    resetTurnState();
  });
});

describe("one turn's steps", () => {
  it("a new one-shot reporter starts with an empty Steps strip", async () => {
    const { createInteractiveProgressReporter } = await import("../../formatting/live-activity.js");
    resetTurnState();
    const stream = { columns: 80, isTTY: false, write: () => true };
    const first = createInteractiveProgressReporter(stream, { animate: false, now: () => 1_000 });
    first.progress({ type: "tool.start", stage: "tool", message: "", toolId: "c1", name: "get_report", context: "" });
    first.progress({ type: "tool.complete", stage: "tool", message: "", toolId: "c1", name: "get_report", summary: "ok", status: "ok" });
    first.stop();
    expect(getTurnState().steps).toHaveLength(1);
    createInteractiveProgressReporter(stream, { animate: false, now: () => 2_000 });
    expect(getTurnState().steps).toEqual([]);
    resetTurnState();
  });
});

describe("a running turn with views is drawn in the r4 layout while it works", () => {
  const listView = () => {
    const raw = readFileSync(fileURLToPath(new URL("../views/__fixtures__/list-rows.json", import.meta.url)), "utf8");
    const view = decodeAnswerView(JSON.parse(raw));
    if (!view) throw new Error("list-rows fixture does not decode");
    return view;
  };
  const working = (): TurnState => ({
    ...getTurnState(),
    streaming: "Two are on; pausing **Cold brew car",
    steps: [
      { id: "c1", name: "list_meta_entities", label: "listing meta entities", status: "ok", startedAt: 0, endedAt: 400, result: "3 ads" },
      { id: "c2", name: "pause_entity", label: "pausing entity", status: "run", startedAt: 400, endedAt: null, result: "" }
    ],
    tools: [{ id: "c2", name: "pause_entity", startedAt: 400, latestPreview: "waiting for Meta" } as TurnState["tools"][number]]
  });

  it("puts the arriving answer left of the view at 160, held open, with the running call's progress in the Steps", () => {
    const state = working();
    const history: Msg[] = [{ role: "user", text: "pause the cold brew ad" }];
    const messages = workingTurnMessages(history, state);
    const lines = renderLiveTurn({
      messages, views: [listView()], focus: null, width: 160, color: false, theme,
      steps: workingTurnSteps(messages, state, 900), nowMs: 900
    }).lines;
    // The view head at the plain tier is R3's bracketed title chip.
    expect(lines[0]).toMatch(/^❯ pause the cold brew ad +│ \[Ads running\] ✓ Ready/u);
    expect(lines.join("\n")).toContain("∞ Two are on; pausing Cold");
    expect(lines.join("\n")).not.toContain("**");
    expect(lines.some((line) => /^ {2}pausing entity +━*╍╍ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] waiting for Meta$/u.test(line))).toBe(true);
    expect(lines.filter((line) => line.startsWith("─ Steps ")).length).toBe(1);
  });

  it("the transcript beside it keeps nothing the drawn turn already shows", () => {
    const beside = besideWorkingTurn({ ...working(), todos: [{ id: "t1", content: "Check the ad set", status: "in_progress" }] });
    const out = renderInfiniteTranscript({ messages: [], state: beside }, { columns: 160, theme, nowMs: 900 });
    expect(out).not.toContain("Cold brew");
    expect(out).not.toContain("─ Steps");
    expect(out).toContain("Check the ad set");
  });
});
