import { terminalText } from "../desktop/confirm-in-session.js";
import { displayWidth, padEndCells, truncateCells } from "../tui/lib/display-width.js";
import { ansi, type Theme } from "../tui/theme.js";

/**
 * The one table drawer for the terminal. Markdown tables (T3) and the numbers,
 * list and compare views draw through it, so every table in the CLI has the
 * same box, the same numeric alignment and the same column-dropping rule.
 *
 * Rules:
 * - A column aligns right when every non-empty body cell looks numeric, unless
 *   the column says otherwise.
 * - Too wide: columns drop in descending `dropPriority`, then unprioritized
 *   columns from the right. The first column and `dropPriority: 0` never drop.
 * - Never fewer than 2 columns. When two cannot fit, the table becomes
 *   `label: value` record lines (`fallback: "record"`).
 * - Cells truncate at half the width with `…`, and every cell is scrubbed of
 *   terminal control and bidi characters before it is measured.
 */

export type TableAlign = "left" | "right";
export interface TableColumn { label: string; align?: TableAlign; dropPriority?: number } // 0 = never drop; higher drops first
export interface TableInput { columns: TableColumn[]; rows: string[][]; total?: string[] }
export interface TableOptions { width: number; color: boolean; theme: Theme }
export interface TableRender { lines: string[]; hidden: string[]; fallback: "record" | null }

const NUMBER = String.raw`[+\-−]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[%kKMBx×]?`;
const NUMERIC_RE = new RegExp(String.raw`^(?:${NUMBER}(?:\s?[–\-]\s?${NUMBER})?|[—–\-])[¹²³⁴⁵⁶⁷⁸⁹⁰*]*$`, "u");

/** True for cells like `$1,234.50`, `1.22%`, `−3`, `9,790`, `—`, `1.2k`, `1.7–5.3%`. */
export function looksNumeric(cell: string): boolean {
  const value = cell.trim();
  return value.length > 0 && NUMERIC_RE.test(value);
}

export function renderTable(input: TableInput, opts: TableOptions): TableRender {
  const width = Math.max(1, Math.floor(opts.width));
  const maxCell = Math.max(1, Math.floor(width / 2));
  const columnCount = input.columns.length;
  const labels = input.columns.map((column) => scrub(column.label));
  const rows = input.rows.map((row) => normalizeRow(row, columnCount));
  const total = input.total ? normalizeRow(input.total, columnCount) : undefined;

  const fit = (value: string) => truncateCells(value, maxCell);
  const cellWidth = (index: number) =>
    Math.max(
      displayWidth(fit(labels[index] ?? "")),
      ...rows.map((row) => displayWidth(fit(row[index] ?? ""))),
      total ? displayWidth(fit(total[index] ?? "")) : 0
    );
  const widths = input.columns.map((_column, index) => cellWidth(index));
  const tableWidth = (keep: readonly number[]) =>
    keep.reduce((sum, index) => sum + (widths[index] ?? 0), 0) + 3 * keep.length + 1;

  let keep = input.columns.map((_column, index) => index);
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
    return { lines: renderRecords(labels, rows, total, width, opts), hidden: [], fallback: "record" };
  }

  const right = input.columns.map((column, index) => {
    if (column.align) {
      return column.align === "right";
    }
    const body = rows.map((row) => row[index] ?? "").filter((cell) => cell.trim().length > 0);
    return body.length > 0 && body.every(looksNumeric);
  });

  const border = (value: string) => ansi(opts.theme, "muted", value, opts.color);
  const rule = (left: string, middle: string, end: string) =>
    border(`${left}${keep.map((index) => "─".repeat((widths[index] ?? 0) + 2)).join(middle)}${end}`);
  const line = (cells: readonly string[], strong: boolean) => {
    const parts = keep.map((index) => {
      const value = fit(cells[index] ?? "");
      const cellW = widths[index] ?? 0;
      const padded = right[index]
        ? `${" ".repeat(Math.max(0, cellW - displayWidth(value)))}${value}`
        : padEndCells(value, cellW);
      return ` ${strong ? bold(padded, opts) : padded} `;
    });
    return `${border("│")}${parts.join(border("│"))}${border("│")}`;
  };

  const lines = [rule("┌", "┬", "┐"), line(labels, true), rule("├", "┼", "┤"), ...rows.map((row) => line(row, false))];
  if (total) {
    lines.push(rule("├", "┼", "┤"), line(total, true));
  }
  lines.push(rule("└", "┴", "┘"));

  return { lines, hidden, fallback: null };
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
        if (lineIndex === 0 && opts.color && text.startsWith(head)) {
          lines.push(`${bold(label, opts)}${text.slice(label.length)}`);
          return;
        }
        lines.push(text);
      });
    });
  });
  return lines;
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

function bold(value: string, opts: TableOptions): string {
  return opts.color ? `\u001b[1m${value}\u001b[22m` : value;
}
