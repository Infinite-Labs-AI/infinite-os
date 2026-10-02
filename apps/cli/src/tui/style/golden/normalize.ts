// The golden segment model (terminal-r4 spec §2.2): one screen row is a list of
// `{text, style}` segments, where `style` is the r4 tokens of that run, sorted
// and space-separated ("" = body text in the terminal's default foreground).
//
// `normalizeCells` is a line-for-line port of the private comparator's
// `normalize` (spec/terminal/tools/golden_compare.py) and of the golden dump's
// `__norm`, so goldens and the CLI's output are folded the same way:
//   1. adjacent cells with the same style merge into one segment;
//   2. a whitespace run takes no style, unless both neighbours share one (then
//      it takes that style). Runs that paint a background (`key pk inv tag sel`,
//      or the mono tier's inverse) or underline (`u`) keep their style;
//   3. trailing whitespace with no background is trimmed.

export interface Segment {
  text: string;
  style: string;
}

export type SegmentLine = Segment[];

/** One screen cell: a single code point and its token string. */
export interface Cell {
  ch: string;
  style: string;
}

/** Tokens that paint a background: whitespace inside them is visible. */
export const BG_TOKENS: ReadonlySet<string> = new Set(["key", "pk", "inv", "tag", "sel"]);

const hasBackground = (style: string) =>
  style.split(" ").some((token) => BG_TOKENS.has(token) || token.startsWith("?bg") || token === "inverse");
const isUnderlined = (style: string) => style.split(" ").includes("u");
const isSpace = (ch: string) => /^\s$/u.test(ch);

export function normalizeCells(input: readonly Cell[]): SegmentLine {
  const cells = input.map((cell) => ({ ...cell }));
  const foldable = (index: number) =>
    isSpace(cells[index]!.ch) && !hasBackground(cells[index]!.style) && !isUnderlined(cells[index]!.style);
  let index = 0;
  while (index < cells.length) {
    if (!foldable(index)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < cells.length && foldable(end)) end += 1;
    const before = index > 0 ? cells[index - 1]!.style : null;
    const after = end < cells.length ? cells[end]!.style : null;
    const style = before !== null && before === after ? before : "";
    for (let k = index; k < end; k += 1) cells[k]!.style = style;
    index = end;
  }
  const out: SegmentLine = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last.style === cell.style) {
      last.text += cell.ch;
    } else {
      out.push({ text: cell.ch, style: cell.style });
    }
  }
  while (out.length) {
    const last = out[out.length - 1]!;
    if (hasBackground(last.style)) break;
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

/** A segment line back to cells (one per code point). */
export function cellsOf(line: SegmentLine): Cell[] {
  return line.flatMap((segment) => [...segment.text].map((ch) => ({ ch, style: segment.style })));
}

/** Re-normalize a segment line (after slicing or masking). */
export function normalizeLine(line: SegmentLine): SegmentLine {
  return normalizeCells(cellsOf(line));
}

export function textOf(line: SegmentLine): string {
  return line.map((segment) => segment.text).join("");
}

/** Code points, the unit every golden column is counted in (all r4 glyphs are narrow, spec §4). */
export function codePoints(text: string): number {
  return [...text].length;
}
