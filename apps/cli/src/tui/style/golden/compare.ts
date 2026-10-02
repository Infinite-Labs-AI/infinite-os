// Compare the CLI's rendered screen with an r4 golden, region by region
// (terminal-r4 spec §11d). Text must match exactly per row and tokens must match
// per character, after the documented tolerances only:
//   T3  any braille spinner frame matches any other;
//   T5  clock text ("4s", "2:03 so far") is masked when locating a region;
//   T6  the golden body's trailing padding rows (r4 pads a turn to 16 rows) are
//       not required — scrollback must not pad;
//   T7  each region is located on its own (the CLI is inline: the top bar, the
//       composer and the key bar live in the live region, D1), never by
//       absolute row.
// Tier 1 renders from fixtures with fixed step start/end and a fixed clock, so
// the Steps bars (T4) and clock text (T5) compare exactly there: only T3 and the
// region rules (T6, T7) apply to cells. `maskText` (T3 + T5) is used to LOCATE
// a region, and by tier 2.
import { cellsOf, codePoints, normalizeCells, textOf, type Cell, type SegmentLine } from "./normalize.js";

export type RegionName = "topbar" | "rule_top" | "body" | "steps_header" | "steps" | "rule_bottom" | "composer" | "keybar";
export const FRAME_REGIONS: readonly RegionName[] = [
  "topbar", "rule_top", "body", "steps_header", "steps", "rule_bottom", "composer", "keybar"
];

export interface GoldenFile {
  id: string;
  view_kind: string;
  state: string | null;
  cols: number;
  derived?: boolean;
  flow_kind?: string;
  flow_step?: number;
  layout?: { wide: boolean; answer_w: number; separator: string; details_w: number };
  regions?: Partial<Record<RegionName, [number, number]>>;
  lines: SegmentLine[];
  data?: unknown;
}

export interface RowDiff {
  row: number;
  golden: string;
  actual: string;
  textEqual: boolean;
  /** First column whose token differs (text equal), or the first differing character (text not equal). */
  column: number;
  goldenStyle?: string;
  actualStyle?: string;
}

export interface RegionResult {
  region: string;
  verdict: "MATCH" | "DIFF" | "NOT_FOUND";
  goldenRows: number;
  locatedAt: { row: number; col: number } | null;
  diffs: RowDiff[];
}

const MASKS: readonly [RegExp, string][] = [
  [/[⠀-⣿]/gu, "⠿"],
  [/\b\d+(:\d\d)? ?s\b/gu, "#s"],
  [/\b\d+:\d\d so far/gu, "#:## so far"]
];

export function maskText(text: string): string {
  return MASKS.reduce((out, [rx, rep]) => out.replace(rx, rep), text);
}

/** T3 per cell (length-preserving): any braille spinner frame reads as one. Tier 1 pins the clock, so T5 is not applied to cells. */
function maskCells(cells: readonly Cell[]): Cell[] {
  return cells.map((cell) => ({ ch: /[\u2800-\u28ff]/u.test(cell.ch) ? "⠿" : cell.ch, style: cell.style }));
}

/** A body pad row: blank, or blank but for the pane separator `│` (T6). */
export const isBlankPadRow = (line: SegmentLine) => /^\s*│?\s*$/u.test(textOf(line));

/** The golden rows of one region, with T6 (trailing pad rows of the body) applied. */
export function goldenRegionRows(golden: GoldenFile, region: RegionName | "all"): SegmentLine[] {
  if (region === "all") return golden.lines;
  const span = golden.regions?.[region];
  if (!span) return [];
  const rows = golden.lines.slice(span[0], span[1] + 1);
  if (region === "body") {
    while (rows.length && isBlankPadRow(rows[rows.length - 1]!)) rows.pop();
  }
  return rows;
}

/**
 * Find where `golden` (rows of a region) sits in `actual`. First a full-row
 * match of the first non-blank golden row (masked text); else, for component
 * regions, that row as a substring at some column (a card inside the details
 * pane). Returns the row/col of golden row 0.
 */
export function locate(actual: readonly SegmentLine[], golden: readonly SegmentLine[], from = 0): { row: number; col: number } | null {
  const first = golden.findIndex((line) => textOf(line).trim() !== "");
  if (first < 0) return null;
  const want = maskText(textOf(golden[first]!));
  for (let row = from; row < actual.length; row += 1) {
    if (maskText(textOf(actual[row]!)) === want && row - first >= 0) return { row: row - first, col: 0 };
  }
  const needle = want.replace(/\s+$/u, "");
  for (let row = from; row < actual.length; row += 1) {
    const text = maskText(textOf(actual[row]!));
    const at = text.indexOf(needle);
    if (at > 0 && row - first >= 0) return { row: row - first, col: codePoints(text.slice(0, at)) };
  }
  return null;
}

function sliceCells(line: SegmentLine, col: number, width: number | null): Cell[] {
  const cells = cellsOf(line);
  return width === null ? cells.slice(col) : cells.slice(col, col + width);
}

/** For a region that is not on screen: the actual row sharing the longest prefix with what was wanted (a hint, not a match). */
function closestRow(actual: readonly SegmentLine[], want: string): { text: string; column: number } {
  const wanted = [...want];
  let best = { text: "", column: 0 };
  for (const line of actual) {
    const chars = [...textOf(line)];
    let k = 0;
    while (k < wanted.length && chars[k] === wanted[k]) k += 1;
    if (k > best.column) best = { text: chars.join(""), column: k };
  }
  return best;
}

/** Compare one golden region with the actual screen. */
export function compareRegion(
  actual: readonly SegmentLine[],
  goldenRows: readonly SegmentLine[],
  region: string,
  options: { gantt?: boolean; at?: { row: number; col: number } | null } = {}
): RegionResult {
  const result: RegionResult = { region, verdict: "MATCH", goldenRows: goldenRows.length, locatedAt: null, diffs: [] };
  if (!goldenRows.length) return result;
  const at = options.at === undefined ? locate(actual, goldenRows) : options.at;
  if (!at) {
    result.verdict = "NOT_FOUND";
    const first = goldenRows.find((line) => textOf(line).trim() !== "") ?? goldenRows[0]!;
    const { text, column } = closestRow(actual, textOf(first));
    result.diffs.push({ row: 0, golden: textOf(first), actual: text, textEqual: false, column });
    return result;
  }
  result.locatedAt = at;
  goldenRows.forEach((goldenLine, i) => {
    const actualLine = actual[at.row + i] ?? [];
    const goldenCells = maskCells(cellsOf(normalizeCells(cellsOf(goldenLine))));
    const width = at.col > 0 ? Math.max(goldenCells.length, 0) : null;
    let actualCells = maskCells(cellsOf(normalizeCells(sliceCells(actualLine, at.col, width))));
    let goldenCmp = goldenCells;
    if (options.gantt) {
      goldenCmp = ganttFree(goldenCmp);
      actualCells = ganttFree(actualCells);
    }
    const g = goldenCmp.map((cell) => cell.ch).join("");
    const a = actualCells.map((cell) => cell.ch).join("");
    if (g !== a) {
      const gs = [...g];
      const as = [...a];
      let column = 0;
      while (column < gs.length && gs[column] === as[column]) column += 1;
      result.diffs.push({ row: i, golden: g, actual: a, textEqual: false, column });
      return;
    }
    const column = goldenCmp.findIndex((cell, k) => cell.style !== actualCells[k]!.style);
    if (column >= 0) {
      result.diffs.push({
        row: i, golden: g, actual: a, textEqual: true, column,
        goldenStyle: goldenCmp[column]!.style, actualStyle: actualCells[column]!.style
      });
    }
  });
  if (result.diffs.length) result.verdict = "DIFF";
  return result;
}

/** T4 (tier 2 only): collapse a Steps bar run to one cell. Tier 1 compares bars exactly. */
function ganttFree(cells: Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of cells) {
    const bar = cell.ch === "━" || cell.ch === "╍";
    const prev = out[out.length - 1];
    if (bar && prev && (prev.ch === "━") ) continue;
    out.push(bar ? { ch: "━", style: cell.style } : cell);
  }
  return out;
}

/** A readable diff: the first differing row of each region, both texts, and a caret. */
export function formatRegionResults(id: string, results: readonly RegionResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    if (result.verdict === "MATCH") continue;
    const first = result.diffs[0];
    if (!first) continue;
    if (result.verdict === "NOT_FOUND") {
      lines.push(`${id} ${result.region}: NOT FOUND — no row reads`, `  golden: ${JSON.stringify(first.golden)}`);
      if (first.actual) lines.push(`  closest: ${JSON.stringify(first.actual)}`, `${" ".repeat(first.column + 12)}^ text`);
      continue;
    }
    lines.push(`${id} ${result.region}: ${result.diffs.length} of ${result.goldenRows} rows differ; first at region row ${first.row}`);
    lines.push(`  golden: ${JSON.stringify(first.golden)}`, `  actual: ${JSON.stringify(first.actual)}`);
    const caret = `${" ".repeat(first.column + 11)}^`;
    lines.push(first.textEqual ? `${caret} token ${JSON.stringify(first.goldenStyle)} vs ${JSON.stringify(first.actualStyle)}` : `${caret} text`);
  }
  return lines.join("\n");
}

/**
 * Paint golden segment lines with the palette's SGR at a tier (the inverse of
 * `ansiToSegmentLines`). Each segment opens from a reset and closes with one,
 * like golden_compare.py's `golden_to_ansi`; used by the model self-test.
 */
export function paintGoldenLines(lines: readonly SegmentLine[], sgrOf: (token: string) => string): string[] {
  return lines.map((line) =>
    line.map((segment) => {
      const codes = segment.style.split(" ").filter(Boolean).map(sgrOf).filter((code) => code && code !== "0");
      return `${codes.length ? `\u001b[0;${codes.join(";")}m` : "\u001b[0m"}${segment.text}\u001b[0m`;
    }).join("")
  );
}
