// ANSI renderer output → r4 `{text, style}` segment lines (terminal-r4 spec §11d).
//
// A small SGR state machine. The CLI's renderers already emit line-addressed
// text, so there is no terminal emulation: each `\n`-separated line is one row,
// every code point is one cell (all r4 glyphs are narrow, spec §4), and every
// cell's SGR state maps BACK to r4 tokens through the palette (`tokenOf`, a port
// of golden_compare.py's `token_of`). Anything that is not an r4 token prints as
// itself (`?#00d5ff`, `?ansi:36`, `faint`, `bold`, `italic`, a chip's wrong
// `?chipfg…`/`?chipbold`), so a diff names what the CLI actually painted.
import { BG_BASE, BODY_FG, BOLD_OF, FG_BASE, PALETTE, xterm256Hex } from "./palette.js";
import { normalizeCells, type Cell, type SegmentLine } from "./normalize.js";

/** One cell's raw SGR state. Colours are `#rrggbb`, or `ansi:<n>` for the 16 named colours. */
export interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

export const RESET_STATE: Readonly<SgrState> = Object.freeze({
  fg: null, bg: null, bold: false, faint: false, italic: false, underline: false, inverse: false, strike: false
});

const ESC = "\u001b";

/** Apply one SGR parameter list (`1;38;2;1;2;3`) to a state. Unknown codes are ignored. */
export function applySgr(state: SgrState, params: string): SgrState {
  const next = { ...state };
  const codes = params === "" ? [0] : params.split(/[;:]/u).map((part) => (part === "" ? 0 : Number(part)));
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code === 0) Object.assign(next, RESET_STATE);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.faint = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 21 || code === 22) { next.bold = false; next.faint = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = `ansi:${code - 30}`;
    else if (code >= 90 && code <= 97) next.fg = `ansi:${code - 90 + 8}`;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = `ansi:${code - 40}`;
    else if (code >= 100 && code <= 107) next.bg = `ansi:${code - 100 + 8}`;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      let colour: string | null = null;
      if (mode === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]].map((v) => Math.max(0, Math.min(255, v ?? 0)));
        colour = `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
        i += 4;
      } else if (mode === 5) {
        const index = codes[i + 2] ?? 0;
        colour = index < 16 ? `ansi:${index}` : xterm256Hex(index);
        i += 2;
      }
      if (code === 38) next.fg = colour;
      else next.bg = colour;
    }
  }
  return next;
}

const CHIPS: ReadonlySet<string> = new Set(["key", "tag", "pk", "inv"]);

/** True when `fg` is the chip's own foreground (its truecolor value or its 256-tier hex). */
function isChipFg(chip: string, fg: string): boolean {
  const token = PALETTE.tokens[chip];
  return fg !== "" && (fg === token?.fg?.toLowerCase() || fg === token?.fg_256?.hex.toLowerCase());
}

/**
 * One cell state → the canonical r4 token string (sorted, space-separated).
 * `ch` is the cell's character, when known: a chip's foreground and weight are
 * part of the chip token, so they must be the palette's (`key`/`tag` white,
 * `pk`/`inv` #0a0d11 bold, `tag` bold); a different one is named next to the
 * chip (`?chipfg#a0a0a0`, `?chipfgdefault`, `?chipbold`). A blank cell shows no
 * foreground or weight, so only its background counts.
 */
export function tokenOf(state: SgrState, ch?: string): string {
  const tokens = new Set<string>();
  let fg = (state.fg ?? "").toLowerCase();
  const bg = (state.bg ?? "").toLowerCase();
  let bold = state.bold;
  if (bg) {
    const chip = BG_BASE.get(bg);
    tokens.add(chip ?? `?bg${bg}`);
    if (chip && CHIPS.has(chip)) {
      if (ch === undefined || !/\s/u.test(ch)) {
        if (!isChipFg(chip, fg)) tokens.add(`?chipfg${fg || "default"}`);
        if (bold !== Boolean(PALETTE.tokens[chip]?.bold)) tokens.add("?chipbold");
      }
      fg = "";
      bold = false;
    }
  }
  if (state.inverse) tokens.add("inverse");
  if (state.underline) tokens.add("u");
  if (fg && fg !== BODY_FG) {
    const base = FG_BASE.get(fg);
    if (base === undefined) tokens.add(`?${fg}`);
    else if (bold) tokens.add(BOLD_OF[base] ?? `${base}+bold`);
    else tokens.add(base);
  } else if (bold) {
    tokens.add("bold");
  }
  if (state.faint) tokens.add("faint");
  if (state.italic) tokens.add("italic");
  if (state.strike) tokens.add("strike");
  return [...tokens].sort().join(" ");
}

/**
 * One ANSI line → cells. SGR (`CSI … m`) changes the pen; every other CSI and
 * every OSC / single escape is dropped (renderer output is line-addressed). A
 * tab is not expanded: renderers must not print one, so it stays visible.
 */
export function ansiLineToCells(line: string, start: SgrState = RESET_STATE): { cells: Cell[]; end: SgrState } {
  const cells: Cell[] = [];
  let state: SgrState = { ...start };
  const chars = [...line];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === ESC) {
      const kind = chars[i + 1];
      if (kind === "[") {
        let j = i + 2;
        while (j < chars.length && !/[@-~]/u.test(chars[j]!)) j += 1;
        if (chars[j] === "m") state = applySgr(state, chars.slice(i + 2, j).join(""));
        i = j;
      } else if (kind === "]") {
        let j = i + 2;
        while (j < chars.length && chars[j] !== "\u0007" && !(chars[j] === ESC && chars[j + 1] === "\\")) j += 1;
        i = chars[j] === ESC ? j + 1 : j;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "\r") continue;
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(ch)) continue;
    cells.push({ ch, style: tokenOf(state, ch) });
  }
  return { cells, end: state };
}

/** A whole rendered block (rows joined by `\n`) → normalized segment lines. The pen carries across rows. */
export function ansiToSegmentLines(output: string | readonly string[]): SegmentLine[] {
  const rows = typeof output === "string" ? output.split("\n") : output;
  let pen: SgrState = RESET_STATE;
  return rows.map((row) => {
    const { cells, end } = ansiLineToCells(row, pen);
    pen = end;
    return normalizeCells(cells);
  });
}
