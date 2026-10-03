import { terminalText } from "../desktop/confirm-in-session.js";
import { displayWidth, padEndCells, truncateCells } from "../tui/lib/display-width.js";
import { ansi, type AnsiRole, type Theme, type ThemeStyle } from "../tui/theme.js";

/**
 * The one table drawer for the terminal. Markdown tables (T3) and the numbers,
 * list and compare views draw through it, so every table in the CLI has the
 * same box, the same numeric alignment and the same column-dropping rule.
 *
 * Rules (terminal-r4 `table()`):
 * - Borders in `line`, the header and the Total in `b` (bold white), body cells
 *   in the caller's role; a `├┼┤` rule under the header and above the Total.
 * - A column aligns right when every non-empty body cell looks numeric, unless
 *   the column says otherwise.
 * - Too wide: columns drop in descending `dropPriority`, then unprioritized
 *   columns from the right. The first column and `dropPriority: 0` never drop.
 *   A cell is never cut: a column that does not fit drops whole, and is named.
 * - Never fewer than 2 columns. When two cannot fit, the table becomes
 *   `label: value` record lines (`fallback: "record"`).
 * - Every cell is scrubbed of terminal control and bidi characters before it
 *   is measured. Each segment paints and ends itself (`line`, `b`, the role),
 *   so a line never relies on a colour it did not open, and never ends in a
 *   full reset.
 */

export type TableAlign = "left" | "right";
export interface TableColumn { label: string; align?: TableAlign; dropPriority?: number } // 0 = never drop; higher drops first
export interface TableInput { columns: TableColumn[]; rows: string[][]; total?: string[] }
/**
 * `role` paints the body cells (default `text`: the terminal's own foreground); borders and bold cells paint themselves.
 * `labelMin`: a table too wide for `width` first cuts its FIRST column (the row labels, with …) to the room the
 * other columns leave, never narrower than `labelMin`, before any column drops; once the columns are chosen the
 * labels grow into the room that is left. A long row name (an ad's full campaign name) then costs its end, not a
 * number, and each row stays one line (run-3 N18: a name wrapped to 3 lines). Absent: a label is never cut (r4
 * `table()`, markdown tables).
 * `refill`: after the drops, a dropped column comes back when it fits after all (it went before a wider column that
 * had to go too), the most kept first. Absent: r4 `table()`'s drop rule as is (markdown tables).
 */
export interface TableOptions { width: number; color: boolean; theme: Theme; role?: AnsiRole; labelMin?: number; refill?: boolean }
export interface TableRender {
  lines: string[];
  hidden: string[];
  fallback: "record" | null;
  /** The width the table would take with every column shown (what a wider window needs). */
  fullWidth: number;
  /** Each body row's line in `lines` and how many lines it takes (one: a long label is cut, never wrapped). */
  rowLines: [number, number][];
  /** Whether a row label was cut with … to fit (`labelMin`): the whole label is not on screen. */
  labelsCut: boolean;
}

const NUMBER = String.raw`[+\-−]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[%kKMBx×]?`;
const NUMERIC_RE = new RegExp(String.raw`^(?:${NUMBER}(?:\s?[–\-]\s?${NUMBER})?|[—–\-])[¹²³⁴⁵⁶⁷⁸⁹⁰*]*$`, "u");

/** True for cells like `$1,234.50`, `1.22%`, `−3`, `9,790`, `—`, `1.2k`, `1.7–5.3%`. */
export function looksNumeric(cell: string): boolean {
  const value = cell.trim();
  return value.length > 0 && NUMERIC_RE.test(value);
}

export function renderTable(input: TableInput, opts: TableOptions): TableRender {
  const width = Math.max(1, Math.floor(opts.width));
  const columnCount = input.columns.length;
  const labels = input.columns.map((column) => scrub(column.label));
  const rows = input.rows.map((row) => normalizeRow(row, columnCount));
  const total = input.total ? normalizeRow(input.total, columnCount) : undefined;

  const cellWidth = (index: number) =>
    Math.max(
      displayWidth(labels[index] ?? ""),
      ...rows.map((row) => displayWidth(row[index] ?? "")),
      total ? displayWidth(total[index] ?? "") : 0
    );
  const widths = input.columns.map((_column, index) => cellWidth(index));
  const tableWidth = (keep: readonly number[]) =>
    keep.reduce((sum, index) => sum + (widths[index] ?? 0), 0) + 3 * keep.length + 1;

  let keep = input.columns.map((_column, index) => index);
  const fullWidth = tableWidth(keep);
  // A long row label (`labelMin`) is cut with … rather than drop a number: it
  // takes the room the other columns leave, never under the floor, while the
  // columns are chosen; then it grows into whatever room is left.
  const floor = opts.labelMin === undefined ? null : Math.max(1, Math.floor(opts.labelMin));
  const fullLabel = widths[0] ?? 0;
  const labelFloor = Math.max(displayWidth(labels[0] ?? ""), total ? displayWidth(total[0] ?? "") : 0);
  const cuttable = floor !== null && columnCount > 1 && fullWidth > width && fullLabel > floor;
  if (cuttable) {
    widths[0] = Math.max(labelFloor, floor, width - (fullWidth - fullLabel));
  }
  const dropped: number[] = [];
  const dropOrder = dropCandidates(input.columns);
  for (const candidate of dropOrder) {
    if (tableWidth(keep) <= width || keep.length <= 2) {
      break;
    }
    keep = keep.filter((index) => index !== candidate);
    dropped.push(candidate);
  }
  // A column dropped before a wider one that had to go too may fit after all:
  // the last dropped (the most kept) comes back first, so a column is hidden
  // only when the table cannot hold it (live re-check run 3, N19: the measured
  // Link clicks dropped before a wide Status, then fit beside what was left).
  for (const candidate of opts.refill ? [...dropped].reverse() : []) {
    const back = [...keep, candidate].sort((a, b) => a - b);
    if (tableWidth(back) <= width) {
      keep = back;
      dropped.splice(dropped.indexOf(candidate), 1);
    }
  }
  const hidden = dropped.map((index) => labels[index] ?? "");
  if (cuttable) {
    widths[0] = Math.min(fullLabel, Math.max(widths[0] ?? 0, width - (tableWidth(keep) - (widths[0] ?? 0))));
  }
  // Each body row's label on one line, cut with … to its column (run-3 N18).
  const rowLabels = rows.map((row) => cutLabel(row[0] ?? "", widths[0] ?? 0));
  const labelsCut = rowLabels.some((label, index) => label !== (rows[index]?.[0] ?? ""));

  if (columnCount === 0 || tableWidth(keep) > width) {
    return { lines: renderRecords(labels, rows, total, width, opts), hidden: [], fallback: "record", fullWidth, rowLines: [], labelsCut: false };
  }

  const right = input.columns.map((column, index) => {
    if (column.align) {
      return column.align === "right";
    }
    const body = rows.map((row) => row[index] ?? "").filter((cell) => cell.trim().length > 0);
    return body.length > 0 && body.every(looksNumeric);
  });

  const border = (value: string) => paint(value, "line", opts);
  const rule = (left: string, middle: string, end: string) =>
    border(`${left}${keep.map((index) => "─".repeat((widths[index] ?? 0) + 2)).join(middle)}${end}`);
  const line = (cells: readonly string[], strong: boolean) => {
    const parts = keep.map((index) => {
      const value = cells[index] ?? "";
      const pad = " ".repeat(Math.max(0, (widths[index] ?? 0) - displayWidth(value)));
      const painted = strong ? paint(value, "b", opts) : paint(value, opts.role ?? "text", opts);
      return right[index] ? ` ${pad}${painted} ` : ` ${painted}${pad} `;
    });
    return `${border("│")}${parts.join(border("│"))}${border("│")}`;
  };

  const lines = [rule("┌", "┬", "┐"), line(labels, true), rule("├", "┼", "┤")];
  const rowLines: [number, number][] = [];
  rows.forEach((row, index) => {
    rowLines.push([lines.length, 1]);
    lines.push(line([rowLabels[index] ?? "", ...row.slice(1)], false));
  });
  if (total) {
    lines.push(rule("├", "┼", "┤"), line(total, true));
  }
  lines.push(rule("└", "┴", "┘"));

  return { lines, hidden, fallback: null, fullWidth, rowLines, labelsCut };
}

function dropCandidates(columns: readonly TableColumn[]): number[] {
  const prioritized = columns
    .map((column, index) => ({ index, priority: column.dropPriority }))
    .filter((entry) => entry.index > 0 && typeof entry.priority === "number" && entry.priority > 0)
    .sort((a, b) => (b.priority as number) - (a.priority as number) || b.index - a.index)
    .map((entry) => entry.index);
  const unprioritized = columns
    .map((column, index) => ({ index, priority: column.dropPriority }))
    .filter((entry) => entry.index > 0 && entry.priority === undefined)
    .map((entry) => entry.index)
    .reverse();
  return [...prioritized, ...unprioritized];
}

function renderRecords(
  labels: readonly string[],
  rows: readonly string[][],
  total: readonly string[] | undefined,
  width: number,
  opts: TableOptions
): string[] {
  const lines: string[] = [];
  const records = total ? [...rows, total] : [...rows];
  records.forEach((record, recordIndex) => {
    if (recordIndex > 0) {
      lines.push("");
    }
    labels.forEach((label, index) => {
      const head = `${label}: `;
      const value = record[index] ?? "";
      const wrapped = wrapPlain(`${head}${value}`, width);
      wrapped.forEach((text, lineIndex) => {
        if (lineIndex === 0 && text.startsWith(head)) {
          lines.push(`${paint(label, "b", opts)}${paint(text.slice(label.length), opts.role ?? "text", opts)}`);
          return;
        }
        lines.push(paint(text, opts.role ?? "text", opts));
      });
    });
  });
  return lines;
}

/** A row label cut with … to `width` cells; a cut that ends on a separator drops it (`Trials ·…` → `Trials…`). */
function cutLabel(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const cut = truncateCells(text, Math.max(1, width));
  if (!cut.endsWith("…")) return cut;
  const chars = Array.from(cut.slice(0, -1));
  let end = chars.length;
  while (end > 0 && SEPARATORS.has(chars[end - 1]!)) end -= 1;
  return `${(end > 0 ? chars.slice(0, end) : chars).join("")}…`;
}

/** What a cut label never ends on before its …: spaces and the separators names are built with. */
const SEPARATORS: ReadonlySet<string> = new Set([" ", "\t", "·", "—", "–", "-", "|", "/", ",", ":", ";"]);

/** Word wrap; a word wider than half the line hard-breaks in place instead of moving down. */
function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/(\s+)/).filter((part) => part.length > 0)) {
    const candidate = current ? `${current}${word}` : word.trimStart();
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (displayWidth(word.trimStart()) <= width / 2) {
      if (current.trim()) {
        out.push(current.trimEnd());
      }
      current = word.trimStart();
      continue;
    }
    for (const char of Array.from(word)) {
      if (displayWidth(current + char) > width && current) {
        out.push(current.trimEnd());
        current = char.trim() ? char : "";
        continue;
      }
      current += char;
    }
  }
  if (current.trim() || out.length === 0) {
    out.push(current.trimEnd());
  }
  return out;
}

function normalizeRow(row: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_value, index) => scrub(row[index] ?? ""));
}

function scrub(value: string): string {
  return terminalText(value);
}

/** One self-contained span: opened and closed with its own escapes ("" when color is off or the tier paints none). */
function paint(value: string, tone: ThemeStyle, opts: TableOptions): string {
  return opts.color && value && tone !== "text" ? ansi(opts.theme, tone, value) : value;
}
