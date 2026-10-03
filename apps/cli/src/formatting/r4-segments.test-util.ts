// Test helper: one ANSI line at the truecolor tier → r4 `{text, style}`
// segments, the shape the terminal-r4 goldens use (spec §2.2). A small SGR
// state machine; each cell's state maps back to an r4 token by its colour, and
// the line is folded the way the goldens are (same-style runs merge, a space
// run takes a style only when both neighbours share it, trailing spaces drop).
import { R4_TOKENS, type Token } from "../tui/style/tokens.js";

export interface Segment {
  text: string;
  style: string;
}

interface State {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  underline: boolean;
  inverse: boolean;
}

const RESET: State = { fg: null, bg: null, bold: false, underline: false, inverse: false };

function apply(state: State, params: string): State {
  const next = { ...state };
  const codes = params === "" ? [0] : params.split(";").map(Number);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code === 0) Object.assign(next, RESET);
    else if (code === 1) next.bold = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) next.bold = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
      const hex = `#${codes.slice(i + 2, i + 5).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      if (code === 38) next.fg = hex;
      else next.bg = hex;
      i += 4;
    }
  }
  return next;
}

const FG_TOKENS: readonly Token[] = ["dim", "line", "cyan", "green", "amber", "red", "hatch", "blue"];
const BOLD_OF: Partial<Record<Token, Token>> = { cyan: "cb", amber: "ab", green: "gb", red: "rb", blue: "bb" };
const CHIP_TOKENS: readonly Token[] = ["inv", "key", "pk", "tag"];

function tokenOf(state: State): string {
  const tokens: string[] = [];
  const chip = CHIP_TOKENS.find((token) => R4_TOKENS[token as Exclude<Token, "">].bg === state.bg);
  if (chip) {
    tokens.push(chip);
  } else {
    if (state.bg === R4_TOKENS.sel.bg) tokens.push("sel");
    else if (state.bg) tokens.push(`?bg${state.bg}`);
    const fg = FG_TOKENS.find((token) => R4_TOKENS[token as Exclude<Token, "">].fg === state.fg);
    if (state.fg === "#ffffff" && state.bold) tokens.push("b");
    else if (fg && state.bold && BOLD_OF[fg]) tokens.push(BOLD_OF[fg]!);
    else if (fg) tokens.push(fg, ...(state.bold ? ["bold"] : []));
    else if (state.fg) tokens.push(`?${state.fg}`, ...(state.bold ? ["bold"] : []));
    else if (state.bold) tokens.push("bold");
  }
  if (state.underline) tokens.push("u");
  if (state.inverse) tokens.push("inverse");
  return tokens.sort().join(" ");
}

/** The r4 segments of one rendered line (truecolor tier). */
export function r4Segments(line: string): Segment[] {
  const cells: { ch: string; style: string }[] = [];
  let state: State = { ...RESET };
  // eslint-disable-next-line no-control-regex
  const re = /\u001b\[([\d;]*)m|([^\u001b]+)/gu;
  for (const match of line.matchAll(re)) {
    if (match[1] !== undefined) {
      state = apply(state, match[1]);
      continue;
    }
    for (const ch of match[2] ?? "") {
      cells.push({ ch, style: tokenOf(state) });
    }
  }
  const keeps = (style: string) => /\b(key|pk|inv|tag|sel|u)\b|\?bg/u.test(style);
  for (let index = 0; index < cells.length;) {
    if (!/\s/u.test(cells[index]!.ch) || keeps(cells[index]!.style)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < cells.length && /\s/u.test(cells[end]!.ch) && !keeps(cells[end]!.style)) end += 1;
    const before = index > 0 ? cells[index - 1]!.style : null;
    const after = end < cells.length ? cells[end]!.style : null;
    for (let k = index; k < end; k += 1) cells[k]!.style = before !== null && before === after ? before : "";
    index = end;
  }
  const out: Segment[] = [];
  for (const cell of cells) {
    const last = out.at(-1);
    if (last && last.style === cell.style) last.text += cell.ch;
    else out.push({ text: cell.ch, style: cell.style });
  }
  while (out.length) {
    const last = out.at(-1)!;
    if (keeps(last.style)) break;
    const trimmed = last.text.replace(/\s+$/u, "");
    if (trimmed === last.text) break;
    if (trimmed) {
      last.text = trimmed;
      break;
    }
    out.pop();
  }
  return out;
}

/** Shorthand for expected segments: `seg(["│", "line"], [" x", ""])`. */
export function seg(...parts: readonly (readonly [string, string])[]): Segment[] {
  return parts.map(([text, style]) => ({ text, style }));
}
