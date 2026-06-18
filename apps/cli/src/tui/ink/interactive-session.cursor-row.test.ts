import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { composerCursorLayout, composerNativeCursorPosition, renderInkInteractiveSessionToString, wouldTriggerInkFullscreen } from "./interactive-session.js";
import { inkTranscriptRowCount, renderInkTranscriptToString } from "./transcript-app.js";
import { Box, Text, renderToString } from "./renderer.js";
import { DEFAULT_THEME, type Theme } from "../theme.js";
import { displayWidth } from "../lib/display-width.js";
import type { Msg } from "../types.js";

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

describe("native cursor under ink's fullscreen write branch (the /sync-tall regression)", () => {
  // Distinct from Bug A/B: those were errors in OUR static row prediction (still correct —
  // the suites above prove delta 0). This guards a defect INSIDE ink@6.8: when the frame is
  // as tall as the terminal it writes `output` without the trailing "\n" (its fullscreen
  // branch), which violates buildCursorSuffix's "cursor just after the last line" assumption
  // and parks the native cursor a row ABOVE the composer (width-independent; a tall /sync all
  // dump trips it). We predict that condition and fall back to the in-text caret.

  it("predicts ink's fullscreen flip conservatively (>= rows - 1) and not below it", () => {
    // predicted frame height = rowsAboveComposer + composerRows + rowsBelowComposer.
    // ink itself flips at height >= terminalRows; we trip one row earlier (>= rows-1).
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 10, composerRows: 1, terminalRows: 24 })).toBe(false); // height 11
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 22, composerRows: 1, terminalRows: 24 })).toBe(true);  // height 23 == rows-1: conservative early trip
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 21, composerRows: 1, terminalRows: 24 })).toBe(false); // height 22 < 23
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 22, composerRows: 2, terminalRows: 24 })).toBe(true);  // height 24: composer's own span counted
    // Completion menu rows render BELOW the composer and count toward ink's outputHeight.
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 10, composerRows: 1, rowsBelowComposer: 0, terminalRows: 18 })).toBe(false); // height 11
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 10, composerRows: 1, rowsBelowComposer: 6, terminalRows: 18 })).toBe(true);  // height 17 == rows-1
    // No reliable terminal height → never suppress (matches non-TTY / renderToString-less paths).
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 100, composerRows: 5, terminalRows: undefined })).toBe(false);
    expect(wouldTriggerInkFullscreen({ rowsAboveComposer: 100, composerRows: 5, terminalRows: 0 })).toBe(false);
  });

  it("wires the fullscreen guard into the composer's native-cursor decision (caller regression)", () => {
    // The behaviour can't be observed through renderToString — that path has isTTY=false,
    // so the native cursor is always off there regardless of the guard (same non-PTY limit
    // the animation-clock wiring guard documents). So pin the wiring: InkLineInput must
    // consult wouldTriggerInkFullscreen and gate the native cursor on it, using the live
    // terminal row count. Dropping any of these reopens the /sync-tall drift.
    const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
    expect(source).toContain("wouldTriggerInkFullscreen");
    expect(source).toContain("terminalRows: stdout?.rows");
    expect(source).toContain("rowsBelowComposer: completionRows"); // open completion menu counts toward ink's height
    expect(source).toMatch(/&&\s*!inkFullscreen/);
  });

  // Behavioural proof, deterministic & no PTY: replay frames through ink's REAL log-update
  // module (the actual moveUp/eraseLines code) and emulate the terminal, so we observe the
  // physical native-cursor row. Confirms the bug exists in ink's fullscreen path and that
  // suppressing the native cursor (what the gate does) removes the one-row-high parking.
  it("ink's fullscreen write parks the native cursor a row high; suppression fixes it", () => {
    const tall: Msg[] = Array.from({ length: 18 }, (_, i) => ({ kind: "trail", role: "system", text: `sync line ${i}` }));
    const value = "confeeeeeee so this is still happening";
    const columns = 80;
    const frame = renderInkInteractiveSessionToString(
      { columns, initialInputValue: value, onSubmitLine: async () => ({}), title: "Infinite TUI", initialMessages: tall },
      { columns }
    ).replace(/\n+$/, "");
    const composerLogicalRow = stripAnsi(frame).split("\n").findIndex((l) => l.startsWith("❯"));
    const promptWidth = displayWidth("❯ ");
    const pos = composerNativeCursorPosition({ cursor: value.length, label: "❯", row: composerLogicalRow, value, width: columns });

    // (a) ink's FULLSCREEN write (bare frame, no trailing newline) WITH a native cursor → −1.
    const fs = replayLogUpdate({ frame, cursor: pos, fullscreen: true, columns });
    expect(fs.cursorRow).toBe(fs.composerRow - 1);

    // (b) the fix: same fullscreen write but native cursor SUPPRESSED → ink emits no cursor
    //     positioning, so it never parks above the composer (the in-text caret takes over).
    const fixed = replayLogUpdate({ frame, cursor: undefined, fullscreen: true, columns });
    expect(fixed.cursorParked).toBe(false);

    // (c) control: the NORMAL write (frame + "\n") is already correct at any width.
    const normal = replayLogUpdate({ frame, cursor: pos, fullscreen: false, columns });
    expect(normal.cursorRow).toBe(normal.composerRow);
  });
});

// Replays a frame through ink@6.8's REAL log-update (its true moveUp/eraseLines/cursor code),
// then runs the captured ANSI through a minimal VT100 emulator (DECAWM deferred-wrap + ONLCR)
// to report the PHYSICAL native-cursor row vs the composer row. `fullscreen` mirrors ink.js's
// `outputToRender = isFullscreen ? output : output + "\n"`.
function replayLogUpdate(
  { frame, cursor, fullscreen, columns }:
  { frame: string; cursor: { x: number; y: number } | undefined; fullscreen: boolean; columns: number }
): { cursorRow: number; composerRow: number; cursorParked: boolean } {
  const require = createRequire(import.meta.url);
  const logUpdatePath = require.resolve("ink").replace(/index\.js$/, "log-update.js");
  const logUpdate = require(logUpdatePath).default as {
    create: (s: NodeJS.WriteStream) => { (str: string): boolean; setCursorPosition: (p: { x: number; y: number } | undefined) => void };
  };
  const bytes: string[] = [];
  const out = { write: (c: string) => { bytes.push(String(c)); return true; }, columns, rows: 50, isTTY: true } as unknown as NodeJS.WriteStream;
  const logu = logUpdate.create(out);
  logu.setCursorPosition(cursor);
  logu(fullscreen ? frame : frame + "\n");
  const joined = bytes.join("");
  const { row, grid } = emulateVt(joined, columns);
  const composerRow = grid.map((r) => r.join("")).findIndex((l) => stripAnsi(l).startsWith("❯"));
  // `?25h` (show cursor) only appears when ink positioned a native cursor.
  const cursorParked = joined.includes("\x1b[?25h");
  return { cursorRow: row, composerRow, cursorParked };
}

function emulateVt(bytes: string, width: number) {
  const grid: string[][] = [];
  let row = 0, col = 0, pendingWrap = false;
  const ensure = (r: number) => { while (grid.length <= r) grid.push([]); };
  const put = (ch: string) => {
    if (pendingWrap) { col = 0; row += 1; pendingWrap = false; }
    ensure(row); grid[row]![col] = ch;
    if (col >= width - 1) pendingWrap = true; else col += 1;
  };
  let i = 0;
  while (i < bytes.length) {
    const ch = bytes[i]!;
    if (ch === "\x1b" && bytes[i + 1] === "[") {
      let j = i + 2, params = "";
      while (j < bytes.length && /[0-9;?]/.test(bytes[j]!)) { params += bytes[j]!; j += 1; }
      const final = bytes[j]!; const nums = params.replace(/\?/g, "").split(";").filter((x) => x !== "").map(Number); const n = nums[0] ?? 1;
      switch (final) {
        case "A": row = Math.max(0, row - n); pendingWrap = false; break;
        case "B": row += n; pendingWrap = false; break;
        case "C": col = Math.min(width - 1, col + n); pendingWrap = false; break;
        case "D": col = Math.max(0, col - n); pendingWrap = false; break;
        case "G": col = Math.max(0, n - 1); pendingWrap = false; break;
        case "H": case "f": row = Math.max(0, (nums[0] ?? 1) - 1); col = Math.max(0, (nums[1] ?? 1) - 1); pendingWrap = false; break;
        case "J": if (n === 2 || n === 3) grid.length = 0; break;
        case "K": { ensure(row); const m = nums[0] ?? 0; if (m === 2) grid[row]!.length = 0; else if (m === 0) grid[row]!.splice(col); else for (let c = 0; c <= col; c++) grid[row]![c] = " "; break; }
        default: break;
      }
      i = j + 1; continue;
    }
    if (ch === "\x1b") { i += 2; continue; }
    if (ch === "\n") { row += 1; col = 0; pendingWrap = false; i += 1; continue; } // TTY ONLCR
    if (ch === "\r") { col = 0; pendingWrap = false; i += 1; continue; }
    if (ch === "\b") { col = Math.max(0, col - 1); pendingWrap = false; i += 1; continue; }
    put(ch); i += 1;
  }
  return { row, grid };
}
