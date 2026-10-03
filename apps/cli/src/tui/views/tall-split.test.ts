import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { r4Segments } from "../../formatting/r4-segments.test-util.js";
import type { TurnStep } from "../app/turn-store.js";
import { displayWidth, stripAnsi } from "../lib/display-width.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { resolveViewKey, viewFocusAfterTurnDone, viewKeyHints, type ViewFocusState } from "./focus.js";
import { layoutTurn, paneWidths, PANE_MIN_ROWS, renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { renderView } from "./registry.js";
import type { ViewRender } from "./types.js";

// A turn taller than the window keeps the split (layout decision, 2026-10-03:
// an everyday window should see it). From 80 columns the current turn is drawn in the two
// panes WHATEVER its height: the answer pane keeps the question and the
// answer (while it runs, the newest lines when the answer alone is taller than
// the room; finished, such a turn still goes whole to scrollback), the
// details pane shows the view from its top, cut to the room with a dim
// `↓ N more · tab, then ↓` line, and after tab ↓/↑ (PgDn/PgUp) scroll it.
// Committed to scrollback the turn is written whole, in one column, as before.
// r4 `frame()` also pads a short pane to 16 rows and the Steps rule never sits
// right under the last line. Synthetic data only.
const theme = INFINITE_R4_THEME;
const messages: Msg[] = [
  { role: "user", text: "show me every row" },
  { role: "assistant", text: "Here they are, newest first." }
];
const steps: TurnStep[] = [
  { id: "s1", name: "list_items", label: "reading the rows", status: "ok", startedAt: 0, endedAt: 500, result: "60 rows" }
];

/** A list view with `count` rows: one line each, so its details are taller than a 44-row window. */
function tallList(count = 60): AnswerViewV1 {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./__fixtures__/list-rows.json", import.meta.url)), "utf8"));
  const template = raw.body.rows[0];
  raw.body.rows = Array.from({ length: count }, (_unused, index) => ({
    ...template, id: `row_${index + 1}`, title: `Sample row ${String(index + 1).padStart(2, "0")}`
  }));
  delete raw.body.total;
  const view = decodeAnswerView(raw);
  if (!view) throw new Error("list fixture does not decode");
  return view;
}

/** About the rows a 44-row window leaves the turn, under the top bar and over the composer and key bar. */
const TURN_ROWS = 38;
const plain = (lines: readonly string[]) => lines.map(stripAnsi);
const stepsHeaderAt = (lines: readonly string[]) => lines.findIndex((line) => /^─ Steps /u.test(line));
const focusOf = (view: AnswerViewV1, over: Partial<ViewFocusState> = {}): ViewFocusState => ({
  ...viewFocusAfterTurnDone([view]), engaged: true, focus: "rows", ...over
});

describe("a tall turn keeps the split from 80 columns", () => {
  for (const width of [80, 100, 120]) {
    const panes = paneWidths(width);
    const draw = (focus: ViewFocusState | null = null) => renderLiveTurn({
      messages, views: [tallList()], focus, width, color: true, theme, rows: TURN_ROWS, steps
    });

    it(`at ${width}: fits the rows it is given, every pane row keeps the separator, nothing wider than ${width}`, () => {
      const drawn = draw();
      const lines = plain(drawn.lines);
      expect(lines.length).toBeLessThanOrEqual(TURN_ROWS);
      const header = stepsHeaderAt(lines);
      expect(header).toBeGreaterThan(10);
      for (const line of lines.slice(0, header)) {
        expect(line.slice(panes.left, panes.left + 2), line).toBe(" │");
      }
      for (const line of drawn.lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
      // The question is on screen, at the top of the answer pane.
      expect(lines[0]).toMatch(/^❯ show me every row/u);
    });

    it(`at ${width}: the details pane starts at the view's top and says how much is below, dim`, () => {
      const drawn = draw();
      const lines = plain(drawn.lines);
      const right = lines.map((line) => line.slice(panes.left + 3));
      expect(right[0]).toMatch(/Ads running/u);
      const more = right.findIndex((line) => /^↓ \d+ more · tab, then ↓$/u.test(line.trimEnd()));
      expect(more, right.join("\n")).toBeGreaterThan(0);
      expect(drawn.pane).not.toBeNull();
      expect(drawn.pane!.above).toBe(0);
      expect(drawn.pane!.below).toBe(Number(/↓ (\d+) more/u.exec(right[more]!)![1]));
      // The more line is dim.
      expect(r4Segments(drawn.lines[more]!).at(-1)).toEqual({ text: `↓ ${drawn.pane!.below} more · tab, then ↓`, style: "dim" });
      // r4: a blank pane row before the Steps rule.
      const header = stepsHeaderAt(lines);
      expect(lines[header - 1]!.trim()).toBe("│");
      // The key facts know the pane is cut, so tab has something to unlock.
      expect(drawn.focused?.facts.pane).toEqual({ above: 0, below: drawn.pane!.below, page: drawn.pane!.shown });
    });

    it(`at ${width}: scrolling moves only the details pane; the answer pane and the Steps stay as they were`, () => {
      const top = plain(draw(focusOf(tallList())).lines);
      const scrolled = draw(focusOf(tallList(), { paneScroll: 5 }));
      const lines = plain(scrolled.lines);
      expect(lines).toHaveLength(top.length);
      const header = stepsHeaderAt(lines);
      expect(lines.slice(header)).toEqual(top.slice(header));
      for (let row = 0; row < header; row += 1) {
        expect(lines[row]!.slice(0, panes.left + 2)).toBe(top[row]!.slice(0, panes.left + 2));
      }
      expect(lines[0]!.slice(panes.left + 3)).toBe(top[5]!.slice(panes.left + 3));
      expect(scrolled.pane!.above).toBe(5);
      // Engaged, the line names the keys that scroll it.
      expect(lines.some((line) => /↓ \d+ more · ↓ PgDn$/u.test(line.trimEnd()))).toBe(true);
    });

    it(`at ${width}: scrolled to the end, the pane shows the last row and says what is above`, () => {
      const drawn = draw(focusOf(tallList(), { paneScroll: 999 }));
      const lines = plain(drawn.lines);
      expect(drawn.pane!.below).toBe(0);
      expect(lines.some((line) => line.includes("Sample row 60"))).toBe(true);
      expect(lines.some((line) => /↑ \d+ above · ↑ PgUp$/u.test(line.trimEnd()))).toBe(true);
    });

    it(`at ${width}: committed to scrollback, the whole view is written in one column`, () => {
      const lines = plain(renderCommittedTurn({ messages, views: [tallList()], focus: null, width, color: false, theme, steps }));
      for (let index = 1; index <= 60; index += 1) {
        expect(lines.some((line) => line.includes(`Sample row ${String(index).padStart(2, "0")}`))).toBe(true);
      }
      expect(lines.some((line) => line.includes(" │ "))).toBe(false);
      expect(lines.some((line) => /more · tab/u.test(line))).toBe(false);
    });
  }

  const long: Msg[] = [
    { role: "user", text: "tell me everything" },
    { role: "assistant", text: Array.from({ length: 60 }, (_unused, index) => `Line ${index + 1} of the answer.`).join("\n\n") }
  ];

  it("while it runs, an answer taller than the room keeps its newest lines in view", () => {
    const lines = plain(renderLiveTurn({ messages: long, views: [tallList()], focus: null, width: 100, color: false, theme, rows: TURN_ROWS, steps, running: true }).lines);
    expect(lines.length).toBeLessThanOrEqual(TURN_ROWS);
    const left = lines.slice(0, stepsHeaderAt(lines)).map((line) => line.slice(0, 28).trim()).filter(Boolean);
    expect(left.at(-1)).toBe("Line 60 of the answer.");
    expect(left.some((line) => line.startsWith("❯"))).toBe(false);
  });

  it("finished, an answer taller than the room is drawn whole (the session sends it whole to scrollback)", () => {
    const lines = plain(renderLiveTurn({ messages: long, views: [tallList()], focus: null, width: 100, color: false, theme, rows: TURN_ROWS, steps }).lines);
    expect(lines.length).toBeGreaterThan(TURN_ROWS);
    expect(lines[0]).toMatch(/^❯ tell me everything/u);
  });

  it("a window too short to split usefully keeps today's draw", () => {
    const lines = renderLiveTurn({ messages, views: [tallList()], focus: null, width: 100, color: false, theme, rows: 4, steps }).lines;
    expect(lines.length).toBeGreaterThan(60);
  });
});

describe("tab, then ↓ ↑ PgDn PgUp scroll a cut details pane", () => {
  const pane = { above: 0, below: 20, page: 30 };
  const focus = (over: Partial<ViewFocusState> = {}): ViewFocusState => {
    const base = viewFocusAfterTurnDone([tallList()]);
    return { ...base, facts: { ...base.facts, pane }, ...over };
  };

  it("before tab, ↓ stays the composer's history recall", () => {
    const next = resolveViewKey("", focus(), { downArrow: true });
    expect(next.handled).toBe(false);
    expect(next.paneScroll ?? 0).toBe(0);
  });

  it("after tab, ↓ scrolls one row, PgDn a page, ↑ and PgUp back; never past either end", () => {
    let state = resolveViewKey("", focus(), { tab: true });
    expect(state.engaged).toBe(true);
    state = resolveViewKey("", state, { downArrow: true });
    expect(state.handled).toBe(true);
    expect(state.paneScroll).toBe(1);
    expect(state.selected).toBe(focus().selected);
    state = resolveViewKey("", state, { pageDown: true }, { ...state.facts, pane: { above: 1, below: 19, page: 30 } });
    expect(state.paneScroll).toBe(20);
    state = resolveViewKey("", state, { downArrow: true }, { ...state.facts, pane: { above: 20, below: 0, page: 30 } });
    expect(state.handled).toBe(true);
    expect(state.paneScroll).toBe(20);
    state = resolveViewKey("", state, { upArrow: true }, { ...state.facts, pane: { above: 20, below: 0, page: 30 } });
    expect(state.paneScroll).toBe(19);
    state = resolveViewKey("", state, { pageUp: true }, { ...state.facts, pane: { above: 19, below: 1, page: 30 } });
    expect(state.paneScroll).toBe(0);
  });

  it("j and k still move the row; the bar offers ↑ ↓ scroll once engaged", () => {
    const engaged = resolveViewKey("", focus(), { tab: true });
    const moved = resolveViewKey("j", engaged, {});
    expect(moved.selected).toBe(engaged.selected + 1);
    expect(moved.paneScroll ?? 0).toBe(0);
    expect(viewKeyHints(engaged).map((hint) => `${hint.key} ${hint.label}`)).toContain("↑ ↓ scroll");
    expect(viewKeyHints(focus()).map((hint) => hint.key)).not.toContain("↑ ↓");
  });

  it("a pane that is not cut keeps ↓ as the row move", () => {
    const base = viewFocusAfterTurnDone([tallList()]);
    const engaged = resolveViewKey("", base, { tab: true });
    const next = resolveViewKey("", engaged, { downArrow: true });
    expect(next.selected).toBe(engaged.selected + 1);
  });
});

describe("a short details pane is padded like r4's frame", () => {
  const short: ViewRender = { head: " Rows  ✓ Ready", source: "Demo", detail: ["row one", "row two"], footnotes: [], keys: [], okKey: null, rowCount: 0 };
  const stepRow = ["  reading the rows   ━━━━  ✓ 2 rows"];

  it("with the window's rows known, the panes take r4's 16 rows, the last a blank pane row over the Steps", () => {
    const lines = plain(layoutTurn(["❯ q", "", "∞ a"], short, stepRow, 100, null, { maxRows: 38 }));
    const header = stepsHeaderAt(lines);
    expect(header).toBe(PANE_MIN_ROWS);
    expect(lines[header - 1]!.trim()).toBe("│");
  });

  it("in a short window the padding never goes past the rows given", () => {
    const lines = layoutTurn(["❯ q", "", "∞ a"], short, stepRow, 100, null, { maxRows: 10 });
    expect(lines).toHaveLength(10);
  });

  it("without the window's rows, a blank pane row still parts the panes from the Steps rule", () => {
    const lines = plain(layoutTurn(["❯ q", "", "∞ a"], short, stepRow, 100));
    const header = stepsHeaderAt(lines);
    expect(lines[header - 1]!.trim()).toBe("│");
    expect(lines[header - 2]!.trim()).not.toBe("│");
  });
});

// Review of 4b5acc2: a resize recomputes the caps (the scroll offset kept and
// clamped), and j/k keep the selected row on screen in a cut pane.
describe("a resize recomputes the cut pane", () => {
  const draw = (width: number, rows: number, paneScroll: number) => renderLiveTurn({
    messages, views: [tallList()], focus: focusOf(tallList(), { paneScroll }), width, color: true, theme, rows, steps
  });

  for (const [from, to] of [[[80, 38], [90, 24]], [[100, 38], [80, 24]], [[120, 24], [100, 38]]] as const) {
    it(`${from[0]}x${from[1]} → ${to[0]}x${to[1]}: the more line's count follows the room, the offset is kept, every line fits`, () => {
      const before = draw(from[0], from[1], 5);
      const after = draw(to[0], to[1], 5);
      for (const [drawn, [width, rows]] of [[before, from], [after, to]] as const) {
        expect(drawn.lines.length).toBeLessThanOrEqual(rows);
        for (const line of drawn.lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
        expect(drawn.pane!.above).toBe(5);
        const more = plain(drawn.lines).find((line) => /↓ \d+ more · ↓ PgDn$/u.test(line.trimEnd()))!;
        expect(Number(/↓ (\d+) more/u.exec(more)![1])).toBe(drawn.pane!.below);
      }
      expect(after.pane!.shown).not.toBe(before.pane!.shown);
      expect(after.pane!.below).not.toBe(before.pane!.below);
    });

    it(`${from[0]}x${from[1]} → ${to[0]}x${to[1]}: an offset past the end is clamped to the last page`, () => {
      const after = draw(to[0], to[1], 999);
      expect(after.pane!.below).toBe(0);
      expect(after.pane!.above).toBeLessThan(999);
      expect(plain(after.lines).some((line) => line.includes("Sample row 60"))).toBe(true);
      for (const line of after.lines) expect(displayWidth(line)).toBeLessThanOrEqual(to[0]);
    });
  }
});

describe("j and k keep the selected row on screen in a cut pane", () => {
  const width = 100;
  const panes = paneWidths(width);
  const draw = (over: Partial<ViewFocusState>) => renderLiveTurn({
    messages, views: [tallList()], focus: focusOf(tallList(), over), width, color: true, theme, rows: TURN_ROWS, steps
  });
  /** The details-pane rows on screen. */
  const right = (lines: readonly string[]) => plain(lines).map((line) => line.slice(panes.left + 3));

  it("j onto a row below the cut scrolls the pane just enough to show it", () => {
    const top = draw({ selected: 0 });
    const facts = top.focused!.facts;
    let state: ViewFocusState = focusOf(tallList(), { selected: 0, facts });
    // Walk j down past the bottom of the pane.
    for (let step = 0; step < 45; step += 1) {
      state = resolveViewKey("j", state, {}, draw(state).focused!.facts);
    }
    expect(state.selected).toBe(45);
    const shown = right(draw(state).lines);
    expect(shown.some((line) => line.includes("Sample row 46")), shown.join("\n")).toBe(true);
    // Just enough: the selected row is the last row the pane shows before its more line.
    const more = shown.findIndex((line) => /^↓ \d+ more/u.test(line.trimEnd()));
    expect(shown.slice(0, more).at(-1)).toContain("Sample row 46");
  });

  it("k back above the top scrolls the pane up to it", () => {
    let state: ViewFocusState = focusOf(tallList(), { selected: 30, paneScroll: 25 });
    for (let step = 0; step < 10; step += 1) {
      state = resolveViewKey("k", state, {}, draw(state).focused!.facts);
    }
    expect(state.selected).toBe(20);
    const shown = right(draw(state).lines);
    expect(shown.some((line) => line.includes("Sample row 21")), shown.join("\n")).toBe(true);
  });

  it("↓ after j scrolls the pane, and the pane no longer snaps back to the selected row", () => {
    let state: ViewFocusState = focusOf(tallList(), { selected: 0 });
    state = resolveViewKey("j", state, {}, draw(state).focused!.facts);
    for (let step = 0; step < 40; step += 1) {
      state = resolveViewKey("", state, { downArrow: true }, draw(state).focused!.facts);
    }
    const drawn = draw(state);
    expect(drawn.pane!.above).toBe(state.paneScroll);
    expect(right(drawn.lines).some((line) => line.includes("Sample row 02"))).toBe(false);
  });
});

describe("a view says where its selected row is drawn (what j/k keep on screen)", () => {
  const ctx = (selected: number) => ({
    width: 70, color: true, theme, selected, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false,
    caps: { open: false, watch: false, retry: false }, timeZone: "UTC", engaged: true
  });

  it("a list: the line of the selected row", () => {
    const render = renderView(tallList(), ctx(41));
    const [start, count] = render.selectedLines!;
    expect(count).toBe(1);
    expect(stripAnsi(render.detail[start]!)).toContain("Sample row 42");
  });

  it("a list under the state's sentence: the row's line counts what the shell drew above it", () => {
    const view = { ...tallList(), state: "partial", stateReason: { code: "partial_rows", words: "Some rows are still loading." } } as AnswerViewV1;
    const render = renderView(view, ctx(41));
    expect(render.detail.map(stripAnsi).join("\n")).toContain("Some rows are still loading.");
    const [start] = render.selectedLines!;
    expect(stripAnsi(render.detail[start]!)).toContain("Sample row 42");
  });

  it("a numbers table: the line of the selected row, on the selection background", () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./__fixtures__/numbers-tall.json", import.meta.url)), "utf8"));
    const view = decodeAnswerView(raw)!;
    const render = renderView(view, ctx(30));
    const [start, count] = render.selectedLines!;
    expect(count).toBeGreaterThan(0);
    expect(stripAnsi(render.detail.slice(start, start + count).join(" "))).toContain("Ad set 31");
  });
});
