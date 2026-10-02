import { afterEach, describe, expect, it } from "vitest";

import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import { displayWidth, stripAnsi } from "../lib/display-width.js";
import { inkTranscriptRowCount, renderInkTranscriptToString } from "../ink/transcript-app.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { besideWorkingTurn, renderInfiniteTranscript } from "./transcript-renderer.js";
import { InfiniteTurnController, getTurnState, resetTurnState } from "./turn-controller.js";

// The working line (terminal-r4: a braille spinner and `Working…` in cyan),
// drawn where the answer will be while a turn runs and has not answered yet.
// Synthetic data only.
const theme = INFINITE_R4_THEME;
const QUESTION: Msg[] = [{ role: "user", text: "how are the sample rows?" }];
const render = (options: { busy?: boolean; color?: boolean; columns?: number } = {}, messages: Msg[] = QUESTION) =>
  renderInfiniteTranscript({ messages, state: getTurnState() }, { columns: options.columns ?? 100, theme, nowMs: 0, ...options }).split("\n");
const SPINNER = /^[⠀-⣿] Working…/u;

describe("the working line (terminal-r4)", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("a turn that just started says it is working, under the question", () => {
    expect(render({ busy: true })).toEqual(["❯ how are the sample rows?", "", "⠋ Working…"]);
  });

  it("is the spinner and the words in cyan (the palette's running tone)", () => {
    const line = render({ busy: true, color: true })[2]!;
    expect(r4Segments(line)).toEqual(seg(["⠋ Working…", "cyan"]));
  });

  it("spins: any braille frame, by the clock", () => {
    const frames = new Set(
      [0, 80, 160, 240, 320].map((nowMs) =>
        renderInfiniteTranscript({ messages: QUESTION, state: getTurnState() }, { columns: 100, theme, nowMs, busy: true }).split("\n")[2]!
      )
    );
    expect(frames.size).toBeGreaterThan(1);
    for (const frame of frames) expect(frame).toMatch(SPINNER);
  });

  it("says what the turn reports it is doing, dim, after the words", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent({ stage: "resolve", message: "Checking sample coverage." });
    expect(render({ busy: true })[2]).toBe("⠋ Working…  · Checking sample coverage.");
    expect(r4Segments(render({ busy: true, color: true })[2]!)).toEqual(seg(["⠋ Working…", "cyan"], ["  ", ""], ["· Checking sample coverage.", "dim"]));
    // The turn's own progress shows it is working, with or without the session's busy flag.
    expect(render()[2]).toBe("⠋ Working…  · Checking sample coverage.");
  });

  it("never draws a face or any wide character: every cell is one column", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent({ stage: "resolve", message: "Checking sample coverage." });
    controller.recordProgressEvent({ type: "tool.generating", stage: "tool", message: "x", name: "mcp__sample_app__list_sample_rows" } as never);
    for (const line of [...render({ busy: true }), ...render({ busy: true, columns: 40 })]) {
      expect(displayWidth(line)).toBe(Array.from(stripAnsi(line)).length);
      // No kaomoji: no half-width katakana, no CJK punctuation, no combining marks, no emoji.
      expect(line).not.toMatch(/[＀-￯　-〿︰-﹏̀-ͯ\u{1f300}-\u{1faff}]/u);
      expect(line).not.toMatch(/pondering|contemplating|musing/u);
    }
  });

  it("stays while its first call runs, above the Steps", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent({ type: "tool.start", stage: "tool", message: "x", toolId: "c1", name: "list_sample_rows", context: "" });
    const lines = render({ busy: true });
    expect(lines[2]).toMatch(SPINNER);
    expect(lines.some((line) => line.startsWith("─ Steps "))).toBe(true);
    expect(lines.indexOf(lines.find((line) => line.startsWith("─ Steps "))!)).toBeGreaterThan(2);
  });

  it("gives way to the answer as soon as it arrives", () => {
    const state = { ...getTurnState(), streaming: "Three rows changed." };
    const out = renderInfiniteTranscript({ messages: QUESTION, state }, { columns: 100, theme, nowMs: 0, busy: true });
    expect(out).toContain("∞ Three rows changed.");
    expect(out).not.toContain("Working…");
  });

  it("is not drawn once the turn has answered, or when nothing runs", () => {
    const answered: Msg[] = [...QUESTION, { role: "assistant", text: "Three rows changed." }];
    expect(render({ busy: true }, answered).join("\n")).not.toContain("Working…");
    expect(render({ busy: false }).join("\n")).not.toContain("Working…");
  });

  it("a warning the turn reports keeps its own line and tone under the working line", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordStatus("The source is slow, still trying.", "warn");
    const lines = render({ busy: true, color: true });
    expect(r4Segments(lines[2]!)).toEqual(seg(["⠋ Working…", "cyan"]));
    expect(lines.slice(3).map(r4Segments)).toContainEqual(seg(["  ", ""], ["• The source is slow, still trying.", "amber"]));
  });

  it("is not repeated under a turn drawn with its views (that turn's heads say it)", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent({ stage: "resolve", message: "Checking sample coverage." });
    const beside = renderInfiniteTranscript({ messages: [], state: besideWorkingTurn(getTurnState()) }, { columns: 100, theme, nowMs: 0, busy: true });
    expect(beside).not.toContain("Working…");
    expect(beside).toContain("Checking sample coverage.");
  });

  it("is cut to a narrow window, never wrapped", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent({ stage: "resolve", message: "Checking sample coverage across every connected source." });
    const lines = render({ busy: true, columns: 30 });
    expect(lines[2]).toMatch(SPINNER);
    expect(lines.every((line) => displayWidth(line) <= 30)).toBe(true);
    expect(lines).toHaveLength(3);
  });
});

describe("the working line in the session frame", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("the frame draws it while busy, and counts the rows it draws (the composer's cursor row stays exact)", () => {
    const props = { busy: true, columns: 100, nowMs: 0, theme, transcript: { messages: QUESTION, state: getTurnState() } };
    const frame = stripAnsi(renderInkTranscriptToString(props)).split("\n");
    expect(frame.some((line) => SPINNER.test(line))).toBe(true);
    expect(inkTranscriptRowCount(props)).toBe(frame.length);

    const idle = { ...props, busy: false };
    const idleFrame = stripAnsi(renderInkTranscriptToString(idle)).split("\n");
    expect(idleFrame.some((line) => line.includes("Working…"))).toBe(false);
    expect(inkTranscriptRowCount(idle)).toBe(idleFrame.length);
  });
});
