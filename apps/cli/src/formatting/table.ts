import { terminalText } from "../desktop/confirm-in-session.js";
import { displayWidth, padEndCells } from "../tui/lib/display-width.js";
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
 * `labelMin`: a table too wide for `width` first wraps its FIRST column (the row labels, on their words) to the room
 * the other columns leave, never narrower than `labelMin`, before any column drops. A long row name (an ad's full
 * campaign name) then costs lines, not numbers. Absent: a label never wraps (r4 `table()`, markdown tables).
 */
export interface TableOptions { width: number; color: boolean; theme: Theme; role?: AnsiRole; labelMin?: number }
export interface TableRender {
  lines: string[];
  hidden: string[];
  fallback: "record" | null;
  /** The width the table would take with every column shown (what a wider window needs). */
  fullWidth: number;
  /** Each body row's first line in `lines` and how many lines it takes (a wrapped label takes several). */
  rowLines: [number, number][];
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
  // Each body row's first-column lines: one, unless a long label wraps (`labelMin`).
  let labelLines: string[][] = rows.map((row) => [row[0] ?? ""]);
  const floor = opts.labelMin === undefined ? null : Math.max(1, Math.floor(opts.labelMin));
  if (floor !== null && columnCount > 1 && fullWidth > width && (widths[0] ?? 0) > floor) {
    // The room the other columns leave, never under the floor: wrap the labels to it on their words.
    const room = Math.max(floor, width - (fullWidth - (widths[0] ?? 0)));
    labelLines = rows.map((row) => wrapLabel(row[0] ?? "", room));
    widths[0] = Math.max(
      displayWidth(labels[0] ?? ""),
      ...labelLines.flat().map((line) => displayWidth(line)),
      total ? displayWidth(total[0] ?? "") : 0
    );
  }
  const hidden: string[] = [];
  const dropOrder = dropCandidates(input.columns);
  for (const candidate of dropOrder) {
    if (tableWidth(keep) <= width || keep.length <= 2) {
      break;
    }
    keep = keep.filter((index) => index !== candidate);
    hidden.push(labels[candidate] ?? "");
  }

  if (columnCount === 0 || tableWidth(keep) > width) {
    return { lines: renderRecords(labels, rows, total, width, opts), hidden: [], fallback: "record", fullWidth, rowLines: [] };
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
    // A wrapped label's later lines carry nothing in the other cells.
    const parts = labelLines[index] ?? [row[0] ?? ""];
    rowLines.push([lines.length, parts.length]);
    parts.forEach((part, at) => lines.push(line(at === 0 ? [part, ...row.slice(1)] : [part], false)));
  });
  if (total) {
    lines.push(rule("├", "┼", "┤"), line(total, true));
  }
  lines.push(rule("└", "┴", "┘"));

  return { lines, hidden, fallback: null, fullWidth, rowLines };
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

/** A row label on its words: a word moves down whole, and only a word wider than the whole width breaks. */
function wrapLabel(text: string, width: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    current = "";
    if (displayWidth(word) <= width) {
      current = word;
      continue;
    }
    for (const char of Array.from(word)) {
      if (displayWidth(current + char) > width && current) {
        out.push(current);
        current = "";
      }
      current += char;
    }
  }
  if (current || out.length === 0) out.push(current);
  return out;
}

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
