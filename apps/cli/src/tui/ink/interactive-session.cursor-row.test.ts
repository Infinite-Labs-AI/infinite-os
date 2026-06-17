import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { composerCursorLayout, composerNativeCursorPosition, renderInkInteractiveSessionToString } from "./interactive-session.js";
import { inkTranscriptRowCount, renderInkTranscriptToString } from "./transcript-app.js";
import { Box, Text, renderToString } from "./renderer.js";
import { DEFAULT_THEME, type Theme } from "../theme.js";
import { displayWidth } from "../lib/display-width.js";

// Regression coverage for the native cursor parking one row off the composer.
// Two independent off-by-one bugs in the row prediction (both deterministic, no PTY):
//   Bug A — the composer's own value wrapped: composerCursorLayout char-packed while
//           the composer renders with Ink word-wrap (<Text wrap="wrap">), so the
//           cursor landed a row above (or below) the line being typed.
//   Bug B — the top rule wrapped to 2 rows under Ink's string-width (emoji-presentation
//           icon/title, or an overflowing title) while inkTranscriptRowCount assumed 1.

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

// Ground truth: the number of rows Ink renders `value` in via its composer <Text wrap="wrap">.
function inkComposerRows(value: string, inputWidth: number): number {
  const out = renderToString(
    createElement(Box, { width: inputWidth }, createElement(Text, { wrap: "wrap" }, value || " ")),
    { columns: inputWidth }
  );
  return stripAnsi(out).replace(/\n+$/, "").split("\n").length;
}

function themeWith(brand: Partial<Theme["brand"]>): Theme {
  return { ...DEFAULT_THEME, brand: { ...DEFAULT_THEME.brand, ...brand } };
}

describe("composer cursor row matches Ink word-wrap (Bug A)", () => {
  it("a cursor at the value end never lands ABOVE the last rendered row", () => {
    // The reported symptom: "the indicator is above the line I'm actually typing on."
    // The cursor must sit on the last rendered row (rows-1) — or, when that row is
    // exactly width-filled, on the phantom next row (rows) for the terminal's
    // deferred wrap. It must never be above the last row.
    const words = "the quick brown fox jumps over a lazy dog while infinite analyzes your traffic".split(" ");
    for (let n = 1; n <= words.length; n++) {
      const value = words.slice(0, n).join(" ");
      for (const inputWidth of [8, 10, 12, 16, 24, 38, 48]) {
        const line = composerCursorLayout(value, value.length, inputWidth).line;
        const rows = inkComposerRows(value, inputWidth);
        expect(line, `value=${JSON.stringify(value)} width=${inputWidth} rows=${rows}`)
          .toBeGreaterThanOrEqual(rows - 1);
        expect(line).toBeLessThanOrEqual(rows);
      }
    }
  });

  it("places a mid-value cursor on the word-wrapped row, not the char-packed one", () => {
    // "hello world foobar" at width 10 word-wraps to ["hello ","world ","foobar"].
    // Offset 12 (after "hello world ") is the start of row 2 — char-packing would
    // have mislabeled it row 1.
    expect(composerCursorLayout("hello world foobar", 12, 10)).toEqual({ column: 0, line: 2 });
  });

  it("preserves the exact-width boundary behavior (deferred wrap to next row start)", () => {
    expect(composerCursorLayout("abcdefgh", 8, 8)).toEqual({ column: 0, line: 1 });
    expect(composerCursorLayout("abcdefghi", 9, 8)).toEqual({ column: 1, line: 1 });
  });

  it("keeps multi-line (explicit newline) cursor placement intact", () => {
    expect(composerCursorLayout("a\nb", 3, 80)).toEqual({ column: 1, line: 1 });
    // Cursor on the empty middle line of two consecutive newlines.
    expect(composerCursorLayout("a\n\nb", 2, 80)).toEqual({ column: 0, line: 1 });
  });

  it("parks the native cursor on the bottom row of a wrapping typed follow-up (end-to-end)", () => {
    const columns = 40;
    const value = "this is my second follow up question that is long enough to wrap onto several rows";
    const frame = renderInkInteractiveSessionToString(
      { columns, initialInputValue: value, onSubmitLine: async () => ({}), title: "Infinite TUI" },
      { columns }
    );
    const lines = stripAnsi(frame).replace(/\n+$/, "").split("\n");
    const lastRow = lines.length - 1;
    const promptWidth = displayWidth("❯ ");
    const composerRows = composerCursorLayout(value, value.length, columns - promptWidth).line + 1;
    const cursorY = composerNativeCursorPosition({
      cursor: value.length,
      label: "❯",
      row: lastRow - (composerRows - 1),
      value,
      width: columns
    }).y;
    expect(cursorY).toBe(lastRow);
  });
});

describe("top-rule height prediction matches the render (Bug B)", () => {
  // The composer row (showComposer:false prediction) must equal the index of the
  // composer line in the real render, so the native cursor lands on it. The top rule
  // must stay one row even when its label measures wider under Ink's string-width.
  function predictedVsActual(theme: Theme, title: string | undefined): { predicted: number; composerIndex: number } {
    const transcript = { messages: [], state: undefined as never };
    const base = { busy: false, columns: 88, status: ["ready"], theme, title, transcript, nowMs: 5_000 };
    const predicted = inkTranscriptRowCount({ ...base, showComposer: false });
    const renderedTotal = renderInkTranscriptToString({ ...base, showComposer: true }, { columns: 88 })
      .replace(/\n+$/, "")
      .split("\n").length;
    return { predicted, composerIndex: renderedTotal - 1 };
  }

  const scenarios: { name: string; theme: Theme; title?: string }[] = [
    { name: "default ∞ icon", theme: DEFAULT_THEME, title: "Infinite TUI" },
    { name: "emoji-presentation brand icon", theme: themeWith({ icon: "♾️" }), title: "Infinite TUI" },
    { name: "emoji in the title", theme: DEFAULT_THEME, title: "Acme ♾️ Co" },
    { name: "title long enough to overflow columns", theme: DEFAULT_THEME, title: "X".repeat(120) }
  ];

  for (const { name, theme, title } of scenarios) {
    it(`${name}: predicted composer row equals the rendered composer row`, () => {
      const { predicted, composerIndex } = predictedVsActual(theme, title);
      expect(predicted).toBe(composerIndex);
    });
  }
});
