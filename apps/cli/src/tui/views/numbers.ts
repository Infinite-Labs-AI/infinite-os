// The numbers view (terminal-r4 "Numbers"): real tables that fit the pane, a
// day strip, and a footnote for anything not measured.
//
// The rules a reviewer attacks, each pinned in `measures.test.ts`:
// - Legs are NEVER summed. The settled leg and the today leg draw as two
//   blocks; the today leg says `not final · as of HH:MM`. A Total row prints
//   only from `legs.settled.totals`: the renderer never adds anything up.
// - A null is a dash with a footnote (or its words, in place), never 0.
// - A today leg with no rows shows its OWN totals in its own block (still never
//   summed into the settled leg); a today leg with rows never prints a Total.
// - Funnel steps print `n of m` (both counts measured), never a %. A leg's
//   steps draw after its rows or totals, never instead of them.
// - Leaders print one line per measure; nothing here ever names a winner.
// - The coverage strip never draws a not-measured day as `·` (zero).
//
// Columns drop in r4's order (the renderer owns it; ColumnV1 has no priority):
// reach before cost-per before outcomes before clicks, while spend and rates
// never drop (`DROP_PRIORITY`); any other column drops from the right, after
// those. A long row name is cut with … before a number drops, one line per row
// (run-3 N18), and shows whole on →, like a hidden column. A table says
// which columns it hid: `+ CPM · → to see` where `→` works (the live turn's
// focused view; `→` then shows them as records), `+ CPM hidden` where it does
// not (scrollback, a view the keys are not on). Scrollback keeps the table.
//
// The live eval's rules (run-2 M7), each pinned in `numbers-live.test.ts`:
// - a Total row only under 2+ rows (one row is its own total);
// - a column the read did not carry (every cell `not_served`, or absent) and a
//   day column that only repeats the row's date are not drawn;
// - every section is one bordered table under ONE heading line; a section with
//   nothing measured is one dim line saying why; an empty section is nothing;
// - ONE day strip per view; no verdict-source note (r4 draws none);
// - a period that ended before the view's day is never `not final`.
import type { CellV1, TextCellV1, UnitV1 } from "@infinite-os/types";

import { renderTable, type TableColumn } from "../../formatting/table.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { healthBodyLines } from "./health.js";
import {
  cellText,
  fitLine,
  FootnoteBook,
  formatAsOf,
  isRecord,
  paint,
  viewText,
  wrapText
} from "./primitives.js";
import type { KindRender, KindRenderer, ViewRenderCtx } from "./types.js";

// ── small guards: a decoded view vouches only for its envelope ──

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const UNITS = new Set<UnitV1>(["money", "count", "percent", "ratio", "seconds", "text"]);

export function asUnit(value: unknown, fallback: UnitV1 = "count"): UnitV1 {
  return typeof value === "string" && UNITS.has(value as UnitV1) ? (value as UnitV1) : fallback;
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What one view's measures share while drawing: the footnotes and how many columns its tables hid. */
export interface MeasureDraw {
  notes: FootnoteBook;
  hidden: number;
  /** The view has a state reason, which already says which days are in: the strip draws no legend. */
  reasonSaid?: boolean;
  /** The view's title: a single leg whose window it names needs no title of its own. */
  viewTitle?: string;
  /** Set when the coverage strip was drawn with its legend (the source line then closes the view). */
  legendDrawn?: boolean;
  /** A coverage strip was drawn: a view draws ONE (a section's own strip would repeat its days). */
  stripDrawn?: boolean;
  /** The instant the view is as of (else now): a window that ended before its day is past, never `not final`. */
  refMs?: number;
}

// ── tables of cells ──

export interface CellTableColumn {
  label: string;
  unit: UnitV1;
  dropPriority?: number;
  /** Format a cell's number with a sign (`+1%`): differences. */
  signed?: boolean;
  /** A percent column's decimals, the same on every row (set by the table, r4 `1.50%`). */
  fixedDigits?: number;
}

/** A cell, or text already drawn (status words, labels). */
export type TableCell = CellV1 | TextCellV1 | string | null | undefined;

export interface CellTableRow {
  label: string;
  cells: TableCell[];
  /** Per-cell units that override the column's (a differences table mixes units). */
  units?: (UnitV1 | undefined)[];
  /** Per-cell words drawn after the value: what one of it is (`—¹ trial`), from a column folded into it. */
  nouns?: (string | undefined)[];
}

export interface CellTableInput {
  columns: CellTableColumn[];
  rows: CellTableRow[];
  total?: CellTableRow | null;
  currency: string | null;
  /** The row j/k selected: once the view is engaged, it is on r4's selection background (never a `▸` in the table). */
  selected?: number | null;
  /** The row-label column's header (r4 `Campaign`, `Version`); empty when the view names none. */
  rowLabel?: string;
}

/**
 * A table of cells at `ctx.width`, through the one table drawer. Columns that
 * do not fit drop (and are named: `+ A, B · → to see`); `showHiddenColumns`
 * draws every column as `label: value` records instead. A footnote is booked
 * only for a cell that is drawn, so no mark points at a hidden column.
 */
export function cellTableLines(raw: CellTableInput, ctx: ViewRenderCtx, draw: MeasureDraw): string[] {
  const input = withUnmeasuredFirst(withFixedDigits(withNounsFolded(withoutUncarried(raw))));
  const labels = [viewText(input.rowLabel), ...input.columns.map((column) => viewText(column.label))];
  const all = input.columns.map((_column, index) => index);
  // Pass 1 (a scratch book): which columns fit at this width.
  const trial = renderTable(tableInput(input, labels, all, new FootnoteBook()), tableOptions(ctx));
  const dropped = trial.fallback === "record" ? [] : hiddenColumnIndexes(labels, trial.hidden);
  // A column with nothing measured never stays while a measured one is hidden,
  // not even in room only it fits: it is named with the rest, first.
  const dash = (index: number) => input.columns[index]?.dropPriority === UNMEASURED_DROP;
  const hiddenIndexes = dropped.some((index) => !dash(index))
    ? [...all.filter((index) => dash(index) && !dropped.includes(index)), ...dropped]
    : dropped;
  const keep = all.filter((index) => !hiddenIndexes.includes(index));
  // A row name cut with … (run-3 N18) is shown whole on → (the records), like a hidden column.
  const cut = trial.fallback !== "record" && !hiddenIndexes.length
    && renderTable(tableInput(input, labels, keep, new FootnoteBook()), tableOptions(ctx)).labelsCut;
  draw.hidden += hiddenIndexes.length + (cut ? 1 : 0);

  if (trial.fallback === "record" || (ctx.showHiddenColumns && (hiddenIndexes.length || cut))) {
    return recordLines(input, labels, ctx, draw.notes);
  }
  const table = renderTable(tableInput(input, labels, keep, draw.notes), tableOptions(ctx));
  if (table.fallback === "record") {
    return recordLines(input, labels, ctx, draw.notes);
  }
  const lines = [...table.lines];
  // r4 draws a table with nothing selected; once the user moves (j/k), the
  // selected row sits on the selection background, its borders kept.
  const selected = ctx.engaged ? selectedRow(input) : null;
  const span = selected === null ? undefined : table.rowLines[selected];
  if (span) {
    // Pass 2 never drops more than pass 1 (fewer footnotes, never wider cells).
    for (let line = span[0]; line < span[0] + span[1]; line += 1) {
      if (lines[line] !== undefined) lines[line] = paint(lines[line]!, "sel", ctx);
    }
  }
  if (hiddenIndexes.length) {
    const named = hiddenIndexes.map((index) => labels[index + 1]).filter(Boolean).join(", ");
    // `→ to see` only where `→` acts on this view; elsewhere the hint says what is hidden, in words.
    const hint = columnKeyWorks(ctx) ? `+ ${named} · → to see` : `+ ${named} hidden`;
    lines.push(...wrapText(hint, ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  return lines;
}

/** Whether `→` acts on this view now: never in scrollback, nor on a view the keys are not on. */
export function columnKeyWorks(ctx: ViewRenderCtx): boolean {
  return ctx.scrollback !== true && ctx.columnKey !== false;
}

/** The reason code for a number the read did not carry (`this read did not carry it`). */
const NOT_CARRIED = "not_served";

/** A cell the read did not carry: absent, or null for `not_served` (nothing measured, nothing to say). */
function uncarried(cell: TableCell): boolean {
  if (cell === undefined) return true;
  if (!isRecord(cell)) return false;
  const value = "value" in cell ? cell.value : "text" in cell ? cell.text : null;
  return (value === null || value === undefined) && isRecord(cell.reason) && cell.reason.code === NOT_CARRIED;
}

/** `2026-09-28` → `Sep 28`; anything else unchanged. */
function isoDay(text: string): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? formatAsOf(text) ?? text : text;
}

/** A row's name: a date as r4 writes days (`2026-09-28` → `Sep 28`), anything else as is. */
function rowName(label: unknown): string {
  return viewText(typeof label === "string" ? isoDay(label) : label);
}

/** A window label that is only ISO dates (`2026-09-28 to 2026-10-02`) names nothing but its days. */
const ISO_ONLY_LABEL = /^\d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?$/u;

/**
 * A window's words: its label, except that a label of only ISO dates is said
 * as r4 says dates (`Sep 28–Oct 2`), once.
 */
function windowLabel(window: Record<string, unknown>): string {
  const label = viewText(window.label);
  return ISO_ONLY_LABEL.test(label) ? windowDates(window) ?? label.replace(/\d{4}-\d{2}-\d{2}/gu, isoDay) : label;
}

/** The plain text of a text cell (or a string), else null. */
function textOf(cell: TableCell): string | null {
  if (typeof cell === "string") return cell;
  return isRecord(cell) && "text" in cell && typeof cell.text === "string" ? cell.text : null;
}

/**
 * The table without the columns that say nothing: every cell one the read did
 * not carry, or a day column whose every cell is its row's own date (`Sep 28`
 * beside `2026-09-28`).
 */
function withoutUncarried(input: CellTableInput): CellTableInput {
  const rows = [...input.rows, ...(input.total ? [input.total] : [])];
  const keep = input.columns.map((column, index) => {
    if (!rows.length) return true;
    if (rows.every((row) => uncarried(row.cells[index]))) return false;
    if (column.unit === "text" && input.rows.length
      && input.rows.every((row) => {
        const text = textOf(row.cells[index]);
        return text !== null && viewText(isoDay(text)) === viewText(row.label);
      })) return false;
    return true;
  });
  if (keep.every(Boolean)) return input;
  return pickColumns(input, keep);
}

/** The table with only the columns `keep` marks (cells, units and nouns follow their columns). */
function pickColumns(input: CellTableInput, keep: readonly boolean[]): CellTableInput {
  const pick = <T,>(list: readonly T[]) => list.filter((_item, index) => keep[index]);
  const row = (entry: CellTableRow): CellTableRow => ({
    ...entry,
    cells: pick(entry.cells),
    ...(entry.units ? { units: pick(entry.units) } : {}),
    ...(entry.nouns ? { nouns: pick(entry.nouns) } : {})
  });
  return { ...input, columns: pick(input.columns), rows: input.rows.map(row), total: input.total ? row(input.total) : input.total };
}

/**
 * A count and the words for what one of it is, in ONE column (live re-check
 * run 3, N19: `Results` and `Result` side by side). A text column labelled as
 * the singular of a number column's label (`Result` beside `Results`) names
 * that column's unit: its words follow the number in the number's cell
 * (`—¹ trial`), under the number's label, and the text column is not drawn.
 */
function withNounsFolded(input: CellTableInput): CellTableInput {
  const folded = new Map<number, number>();
  input.columns.forEach((column, index) => {
    if (column.unit !== "text") return;
    const label = viewText(column.label).toLowerCase();
    if (!label) return;
    const count = input.columns.findIndex((other, at) =>
      other.unit !== "text" && !folded.has(at) && viewText(other.label).toLowerCase() === `${label}s`);
    if (count >= 0) folded.set(count, index);
  });
  if (!folded.size) return input;
  const fold = (entry: CellTableRow): CellTableRow => {
    const nouns = entry.cells.map((_cell, index) => {
      const from = folded.get(index);
      const noun = from === undefined ? null : textOf(entry.cells[from]);
      return noun ? viewText(noun) || undefined : entry.nouns?.[index];
    });
    return { ...entry, nouns };
  };
  const nounColumns = new Set(folded.values());
  return pickColumns(
    { ...input, rows: input.rows.map(fold), total: input.total ? fold(input.total) : input.total },
    input.columns.map((_column, index) => !nounColumns.has(index))
  );
}

/** Above every drop priority: a column with nothing measured drops first. */
const UNMEASURED_DROP = 9;

/** A cell that holds no measured value: a null number or text (a dash or the reason's words), or nothing. */
function unmeasured(cell: TableCell): boolean {
  if (cell === undefined || cell === null) return true;
  if (typeof cell === "string") return false;
  const value = "value" in cell ? cell.value : "text" in cell ? cell.text : null;
  return value === null || value === undefined;
}

/**
 * When a table must drop columns, a column with nothing measured in any row
 * (every cell a dash) goes before any measured one (live re-check run 3, N19:
 * an all-dash ROAS stayed while the measured Link clicks dropped at 60). It is
 * named with the rest (`+ ROAS · → to see`). A table that fits keeps it.
 */
function withUnmeasuredFirst(input: CellTableInput): CellTableInput {
  const rows = [...input.rows, ...(input.total ? [input.total] : [])];
  if (!rows.length) return input;
  const columns = input.columns.map((column, index) =>
    rows.every((row) => unmeasured(row.cells[index])) ? { ...column, dropPriority: UNMEASURED_DROP } : column);
  return { ...input, columns };
}

/**
 * A row name is cut with … before a number drops, down to 30% of the pane (at
 * least 16 columns; run-3 N18); a column that dropped before a wider one comes
 * back when it fits after all (run-3 N19).
 */
function tableOptions(ctx: ViewRenderCtx) {
  return { width: ctx.width, color: ctx.color, theme: ctx.theme, labelMin: Math.max(16, Math.floor(ctx.width * 0.3)), refill: true };
}

/** The fraction digits `value` needs (at most 2): 1.5 → 1, 1.25 → 2, 3 → 0. */
function fractionDigits(value: number): number {
  for (let digits = 0; digits < 2; digits += 1) {
    const scaled = value * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return digits;
  }
  return 2;
}

/**
 * A percent column prints every value with the same decimals (r4 `1.50%`
 * beside `1.33%`): the most any of its values needs, at most 2.
 */
function withFixedDigits(input: CellTableInput): CellTableInput {
  const columns = input.columns.map((column, index) => {
    if (column.unit !== "percent" || column.fixedDigits !== undefined) return column;
    const values = [...input.rows, ...(input.total ? [input.total] : [])]
      .filter((row) => !row.units?.[index] || row.units[index] === "percent")
      .map((row) => row.cells[index])
      .map((cell) => (isRecord(cell) ? finite(cell.value) : null))
      .filter((value): value is number => value !== null);
    return values.length ? { ...column, fixedDigits: Math.max(...values.map(fractionDigits)) } : column;
  });
  return { ...input, columns };
}

function tableInput(input: CellTableInput, labels: readonly string[], keep: readonly number[], notes: FootnoteBook) {
  const columns: TableColumn[] = [
    { label: labels[0] ?? "", dropPriority: 0 },
    ...keep.map((index) => {
      const column = input.columns[index]!;
      return {
        label: labels[index + 1] ?? "",
        // A number column stays right-aligned even when a null prints words ("New").
        ...(column.unit !== "text" ? { align: "right" as const } : {}),
        ...(column.dropPriority !== undefined ? { dropPriority: column.dropPriority } : {})
      };
    })
  ];
  const row = (entry: CellTableRow, isTotal = false) => [
    rowName(entry.label),
    ...keep.map((index) => {
      const column = columnFor(input.columns[index]!, entry, index);
      // A Total has no words of its own for a text column (a status, a result's noun): blank, never a dash.
      return isTotal && column.unit === "text" && entry.cells[index] === undefined ? "" : drawRowCell(input, entry, index, notes);
    })
  ];
  return {
    columns,
    rows: input.rows.map((entry) => row(entry)),
    ...(input.total ? { total: row(input.total, true) } : {})
  };
}

/** Which columns pass 1 dropped, by index (renderTable names them by label). */
function hiddenColumnIndexes(labels: readonly string[], hidden: readonly string[]): number[] {
  const out: number[] = [];
  for (const label of hidden) {
    for (let index = labels.length - 1; index >= 1; index -= 1) {
      if (labels[index] === label && !out.includes(index - 1)) {
        out.push(index - 1);
        break;
      }
    }
  }
  return out;
}

/**
 * One row's cell as drawn: its value, then the words for what one of it is (a
 * folded noun), if any. The app sends those words in the singular (`trial`;
 * the plural, `checkouts initiated`, is not a rule the CLI can apply), so they
 * follow a count of exactly 1 only. Any other count is drawn bare (`3`, never
 * `3 trial`), and a dash never has a noun after it.
 */
function drawRowCell(input: CellTableInput, row: CellTableRow, index: number, notes: FootnoteBook): string {
  const cell = row.cells[index];
  const value = drawCell(cell, columnFor(input.columns[index]!, row, index), input.currency, notes);
  const noun = row.nouns?.[index];
  return noun && isOne(cell) ? `${value} ${noun}` : value;
}

/** A measured number cell whose value is exactly 1. */
function isOne(cell: TableCell): boolean {
  return typeof cell === "object" && cell !== null && "value" in cell && cell.value === 1;
}

function columnFor(column: CellTableColumn, row: CellTableRow, index: number): CellTableColumn {
  const unit = row.units?.[index];
  return unit ? { ...column, unit } : column;
}

export function drawCell(cell: TableCell, column: CellTableColumn, currency: string | null, notes: FootnoteBook): string {
  if (typeof cell === "string") {
    return viewText(cell);
  }
  // A day as r4 writes days (`Sep 28`), never `2026-09-28`.
  const day = column.unit === "text" ? textOf(cell) : null;
  if (day !== null && day !== isoDay(day)) {
    return viewText(isoDay(day));
  }
  const value = isRecord(cell) ? finite(cell.value) : null;
  const text = column.unit === "percent" && column.fixedDigits !== undefined && value !== null
    ? `${value.toLocaleString("en-US", { minimumFractionDigits: column.fixedDigits, maximumFractionDigits: column.fixedDigits })}%`
    : cellText(cell as CellV1 | TextCellV1 | null | undefined, column.unit, currency, notes);
  return column.signed && value !== null && value > 0 ? `+${text}` : text;
}

/** The selected row's index, when there is more than one row to select. */
function selectedRow(input: CellTableInput): number | null {
  const selected = input.selected;
  return typeof selected === "number" && input.rows.length > 1 && selected >= 0 && selected < input.rows.length
    ? Math.floor(selected)
    : null;
}

/** Rows a record view expands (every value) around the selected one; the rest print their label. */
const RECORD_WINDOW = 12;

/**
 * Each row as its label, then `  Column: value` lines (the narrow-table record
 * view). A tall table expands only the rows around the selected one (and the
 * Total); the others print their label alone, and a muted line says j/k
 * moves the expanded rows. So a 200 × 40 table stays a few hundred lines and
 * every key press stays cheap. Only drawn cells book footnotes.
 */
function recordLines(input: CellTableInput, labels: readonly string[], ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  const lines: string[] = [];
  const records = input.total ? [...input.rows, input.total] : input.rows;
  const selected = selectedRow(input);
  const windowed = input.rows.length > RECORD_WINDOW;
  const first = windowed
    ? Math.max(0, Math.min(input.rows.length - RECORD_WINDOW, (selected ?? 0) - Math.floor(RECORD_WINDOW / 2)))
    : 0;
  const expanded = (recordIndex: number) =>
    !windowed || recordIndex >= input.rows.length || (recordIndex >= first && recordIndex < first + RECORD_WINDOW);
  if (windowed) {
    lines.push(...wrapText(`values for rows ${first + 1}–${first + RECORD_WINDOW} of ${input.rows.length} · j k move`, ctx.width)
      .map((line) => paint(line, "muted", ctx)));
  }
  records.forEach((record, recordIndex) => {
    const open = expanded(recordIndex);
    if (recordIndex > 0 && (open || expanded(recordIndex - 1))) {
      lines.push("");
    }
    const mark = selected === null ? "" : recordIndex === selected ? paint("▸ ", "cb", ctx) : "  ";
    const markWidth = selected === null ? 0 : 2;
    lines.push(...wrapText(viewText(record.label), Math.max(1, ctx.width - markWidth)).map((line, index) =>
      `${index === 0 ? mark : " ".repeat(markWidth)}${paint(line, "b", ctx)}`));
    if (!open) {
      return;
    }
    input.columns.forEach((_column, index) => {
      const value = drawRowCell(input, record, index, notes);
      const indent = " ".repeat(markWidth + 2);
      lines.push(...wrapText(`${labels[index + 1]}: ${value}`, Math.max(1, ctx.width - indent.length)).map((line) => `${indent}${line}`));
    });
  });
  return lines;
}

/** `Label   value` pairs, labels padded to one column; a pair too wide puts its value on the next line. */
export function pairLines(
  pairs: readonly { label: string; value: string }[],
  ctx: ViewRenderCtx,
  labelWidth = Math.max(0, ...pairs.map((pair) => displayWidth(pair.label)))
): string[] {
  return pairs.flatMap(({ label, value }) => {
    const line = `${padEndCells(label, labelWidth)}  ${value}`;
    if (displayWidth(line) <= ctx.width) {
      return [line];
    }
    return [...wrapText(label, ctx.width), ...wrapText(value, Math.max(1, ctx.width - 2)).map((part) => `  ${part}`)];
  });
}

// ── dates ──

/** `Jan 8–14`, `Jan 28–Feb 3`, `Jan 15`; null when the window has no dates. */
export function windowDates(window: unknown): string | null {
  const { from, to } = asRecord(window);
  const start = formatAsOf(from);
  const end = formatAsOf(to);
  if (!start || !end) {
    return start ?? end ?? null;
  }
  if (from === to) {
    return start;
  }
  const [startMonth] = start.split(" ");
  const [endMonth, endDay] = end.split(" ");
  return startMonth === endMonth && endDay ? `${start}–${endDay}` : `${start}–${end}`;
}

/**
 * Whether a window's label already names its dates (`Sep 24 — Sep 30`,
 * `Sep 24–30`), so the title does not say them twice. Case and dash style do
 * not matter; a label naming only one end (`Since Sep 24`) does not count.
 */
export function labelNamesDates(label: string, window: unknown): boolean {
  const { from, to } = asRecord(window);
  const start = formatAsOf(from)?.toLowerCase();
  const end = formatAsOf(to)?.toLowerCase();
  if (!label || !start || !end) return false;
  const text = label.toLowerCase().replace(/\s+/gu, " ");
  const at = text.indexOf(start);
  if (at < 0) return false;
  if (from === to) return true;
  const rest = text.slice(at + start.length);
  const [endMonth, endDay] = end.split(" ");
  const sameMonth = start.split(" ")[0] === endMonth;
  return rest.includes(end) || (sameMonth && endDay !== undefined && new RegExp(`(^|\\D)${endDay}(\\D|$)`, "u").test(rest));
}

/** `18:30` for an instant, in `timeZone` (else the system zone); null when unparseable. */
export function clockTime(value: unknown, timeZone?: string): string | null {
  if (typeof value !== "string" || /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const format = (zone: string | undefined) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    } catch {
      return null;
    }
  };
  return format(timeZone) ?? format("UTC");
}

// ── legs ──

type Leg = Record<string, unknown>;

const REFRESH_WORDS: Record<string, string> = {
  still_running: "still updating",
  held: "update held",
  failed: "update failed",
  skipped: "update skipped"
};

/**
 * A leg's title. Settled: `Last 7 days · Jan 8–14` (plus `not final · as of
 * HH:MM` while its window still holds unsettled days). Today: `Today · not
 * final · as of 18:30`: a today leg is never final, whatever it says.
 */
function legTitle(leg: Leg, isToday: boolean, ctx: ViewRenderCtx, refMs?: number, withWindow = true): string {
  const window = asRecord(leg.window);
  // A period that ended before the day the data was read (the leg's own as-of,
  // else the view's) is settled: never `not final`. No read time: the
  // adapter's `final` stands; the clock never decides (a re-render after
  // midnight must not settle today).
  const legMs = typeof leg.asOf === "string" ? Date.parse(leg.asOf) : Number.NaN;
  const ref = Number.isFinite(legMs) ? legMs : refMs;
  const final = !isToday && (leg.final === true || (ref !== undefined && endedBefore(window, ref)));
  const asOf = clockTime(leg.asOf, ctx.timeZone);
  const refresh = asRecord(leg.refresh);
  const refreshWords = isToday && typeof refresh.status === "string" ? REFRESH_WORDS[refresh.status] : undefined;
  const retryAt = refreshWords ? clockTime(refresh.retryAt, ctx.timeZone) : null;
  const label = windowLabel(window);
  return [
    withWindow ? label : "",
    !withWindow || isToday || labelNamesDates(label, window) ? "" : windowDates(window) ?? "",
    final ? "" : "not final",
    final || !asOf ? "" : `as of ${asOf}`,
    refreshWords ? `${refreshWords}${retryAt ? ` until ${retryAt}` : ""}` : ""
  ].filter(Boolean).join(" · ");
}

/** The day `ms` falls on in `timeZone` (else UTC), as `YYYY-MM-DD`. */
function dayOf(ms: number, timeZone: unknown): string {
  const format = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  try {
    return format(typeof timeZone === "string" && timeZone ? timeZone : "UTC");
  } catch {
    return format("UTC");
  }
}

/** Whether a window ended before the day of `refMs` (a read time of the data) in the window's own zone. */
function endedBefore(window: Record<string, unknown>, refMs: number): boolean {
  const to = window.to;
  if (typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(to)) return false;
  return to < dayOf(refMs, window.tz);
}

interface NumbersColumn extends CellTableColumn {
  key: string;
}

/**
 * r4's drop order for the ads measures (`table()` priorities: Impressions 4,
 * CPC 3, Conv 2, Clicks 1): the higher drops first; 0 never drops (spend and
 * the rates a reader judges by). Keyed by the column's key; any other column
 * drops from the right after these (`renderTable`). Of the two click counts,
 * all clicks go before link clicks, the one `CTR (link)` and `CPC (link)` are
 * of (live run-4 N19: a tie dropped the right-hand Link clicks first).
 */
const DROP_PRIORITY: Readonly<Record<string, number>> = {
  impressions: 4, reach: 4, frequency: 4,
  cpc: 3, cpclink: 3, cpm: 3, cpa: 3, cpl: 3, costper: 3, costperresult: 3, costperconversion: 3,
  conv: 2, conversions: 2, purchases: 2, purchasevalue: 2, results: 2, result: 2, leads: 2, registrations: 2, trials: 2,
  clicks: 1, linkclicks: 0.5,
  spend: 0, spent: 0, ctr: 0, ctrlink: 0, roas: 0
};

/** A column key as `DROP_PRIORITY` knows it: lower case, no `_` or `-` (`linkClicks`, `link_clicks` → `linkclicks`). */
function dropKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, "");
}

function numbersColumns(body: Record<string, unknown>): NumbersColumn[] {
  return asList(body.columns).filter(isRecord).map((column) => {
    const key = typeof column.key === "string" ? column.key : "";
    const priority = DROP_PRIORITY[dropKey(key)];
    return {
      key,
      label: viewText(column.label),
      unit: asUnit(column.unit),
      ...(priority !== undefined ? { dropPriority: priority } : {})
    };
  });
}

function legLines(
  leg: Leg,
  isToday: boolean,
  nested: boolean,
  body: Record<string, unknown>,
  columns: NumbersColumn[],
  ctx: ViewRenderCtx,
  draw: MeasureDraw,
  heading = ""
): string[] {
  const layout = body.layout;
  const currency = typeof body.currency === "string" ? body.currency : null;
  // r4 draws no title over a single leg the view's title already names
  // ("Google Ads since launch"), once it is final or a state reason says what
  // is not in yet. Two legs keep theirs: they tell settled from today.
  const window = asRecord(leg.window);
  const label = viewText(window.label).toLowerCase();
  const single = !isRecord(asRecord(body.legs).today);
  const named = Boolean(label) && (draw.viewTitle ?? "").toLowerCase().includes(label);
  const untitled = single && !isToday && named && (leg.final === true || draw.reasonSaid === true);

  const rows = asList(leg.rows).filter(isRecord);
  const legTotals = isRecord(leg.totals) ? leg.totals : null;
  // A Total row comes only from the settled leg's own totals: never computed, never across legs.
  // A today leg with no rows shows its OWN totals as its values (still its own block, never summed).
  const totals = !isToday ? legTotals : rows.length ? null : legTotals;
  // j/k select the settled leg's rows (the today leg's rows are the same things, not final).
  const selected = !isToday && !nested ? ctx.selected : null;
  const steps = asList(leg.steps).filter(isRecord);
  // A section's totals with no rows are ONE table row named by its days (r4: every section is a table).
  const totalsRow = nested && !rows.length && totals !== null && layout !== "steps";
  const legWords = untitled ? "" : legTitle(leg, isToday, ctx, draw.refMs, !totalsRow);
  // A section's heading and its leg's title share one line (`Our sign-ups · Sep 28 – Oct 2 · not final`).
  const title = [heading, legWords].filter(Boolean).join(" · ");
  const lines = title ? wrapText(title, ctx.width).map((line) => paint(line, "b", ctx)) : [];

  if (layout === "steps") {
    lines.push(...stepLines(steps, ctx, draw.notes));
    return lines;
  }
  const values: string[] = [];
  if (totalsRow) {
    values.push(...cellTableLines({
      columns,
      rows: [{ label: windowLabel(window) || windowDates(window) || "", cells: columns.map((column) => totals[column.key] as TableCell) }],
      currency
    }, ctx, draw));
  } else if (!nested && (layout === "kpis" || (!rows.length && totals))) {
    // Totals with no rows print as `Label  value` pairs (no `Total` label, never an empty table).
    values.push(...kpiLines(rows, totals, columns, currency, ctx, draw.notes));
  } else if (rows.length) {
    const hasStatus = rows.some((row) => isRecord(row.status) && viewText(row.status.word) !== "");
    const tableColumns: CellTableColumn[] = [
      ...(hasStatus ? [{ label: "Status", unit: "text" as const }] : []),
      ...columns
    ];
    const cellsOf = (cells: Record<string, unknown>, status: unknown): TableCell[] => [
      ...(hasStatus ? [isRecord(status) ? viewText(status.word) : ""] : []),
      ...columns.map((column) => cells[column.key] as TableCell)
    ];
    values.push(...cellTableLines({
      columns: tableColumns,
      rows: rows.map((row) => ({ label: rowName(row.label), cells: cellsOf(asRecord(row.cells), row.status) })),
      // One row is its own total: a Total row prints only under two or more.
      total: totals && rows.length > 1 ? { label: "Total", cells: cellsOf(totals, null) } : null,
      currency,
      selected,
      rowLabel: viewText(body.rowLabel)
    }, ctx, draw));
  }
  lines.push(...values);
  if (!values.length && !steps.length) {
    // A title over nothing says nothing (r4 "Not connected" draws no title).
    return [];
  }
  if (steps.length) {
    // The funnel follows the leg's numbers; neither replaces the other.
    if (values.length) lines.push("");
    lines.push(...stepLines(steps, ctx, draw.notes));
  }
  return lines;
}

/** Funnel steps: `label  count`, or `label  127 of 176` when both counts are measured. Never a %. */
function stepLines(steps: Record<string, unknown>[], ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  const count = { label: "", unit: "count" as const };
  const pairs: { label: string; value: string; since: string | null }[] = steps.map((step, index) => {
    const value = finite(step.count);
    const previous = index > 0 ? finite(steps[index - 1]!.count) : null;
    const text = value === null
      ? drawCell({ value: null, ...(isRecord(step.reason) ? { reason: step.reason as never } : {}) }, count, null, notes)
      : step.ofPrevious === true && previous !== null
        ? `${drawCell({ value }, count, null, notes)} of ${drawCell({ value: previous }, count, null, notes)}`
        : drawCell({ value }, count, null, notes);
    const since = formatAsOf(step.countingSince);
    return { label: viewText(step.label), value: text, since: value === null ? null : since };
  });
  const valueWidth = Math.max(0, ...pairs.map((pair) => displayWidth(pair.value)));
  const labelWidth = Math.max(0, ...pairs.map((pair) => displayWidth(pair.label)));
  const aligned = pairs.map((pair) => ({ ...pair, value: " ".repeat(valueWidth - displayWidth(pair.value)) + pair.value }));
  return aligned.flatMap((pair) => [
    ...pairLines([pair], ctx, labelWidth),
    ...(pair.since ? wrapText(`counting since ${pair.since}`, Math.max(1, ctx.width - 2)).map((line) => paint(`  ${line}`, "muted", ctx)) : [])
  ]);
}

/** KPIs: `Label  value` per column; several rows get their label as a heading. */
function kpiLines(
  rows: Record<string, unknown>[],
  totals: Record<string, unknown> | null,
  columns: NumbersColumn[],
  currency: string | null,
  ctx: ViewRenderCtx,
  notes: FootnoteBook
): string[] {
  const blocks: { label: string; cells: Record<string, unknown> }[] = rows.map((row) => ({ label: rowName(row.label), cells: asRecord(row.cells) }));
  if (totals && rows.length !== 1) {
    blocks.push({ label: "Total", cells: totals });
  }
  const lines: string[] = [];
  blocks.forEach((block, index) => {
    if (blocks.length > 1) {
      if (index > 0) lines.push("");
      lines.push(...wrapText(block.label, ctx.width).map((line) => paint(line, "b", ctx)));
    }
    // A measure the read did not carry for this block says nothing: it is not listed.
    lines.push(...pairLines(columns.filter((column) => !uncarried(block.cells[column.key] as TableCell)).map((column) => ({
      label: column.label,
      value: drawCell(block.cells[column.key] as TableCell, column, currency, notes)
    })), ctx));
  });
  return lines;
}

// ── the coverage strip ──

type CoverageMark = { glyph: string; words: string; role: "primary" | "muted" | "warning" | "hatch"; legend?: string };

/**
 * r4's day strip: `█` cyan, `·` dim, `◌` amber (today), `░` hatch (not synced
 * yet). A not-measured day is `—`, never `·` (a measured zero).
 */
const COVERAGE_MARKS: Record<string, CoverageMark> = {
  measured: { glyph: "█", words: "measured", role: "primary" },
  partial: { glyph: "▒", words: "partial", role: "warning" },
  // The legend shows five dots: one is too small to read (r4 `····· no spend`).
  zero: { glyph: "·", words: "zero", role: "muted", legend: "·····" },
  not_measured: { glyph: "—", words: "not measured", role: "muted" },
  not_synced: { glyph: "░", words: "not synced", role: "hatch" },
  unknown: { glyph: "?", words: "unknown", role: "muted" }
};
const TODAY_MARK: CoverageMark = { glyph: "◌", words: "today, not synced yet", role: "warning" };
/** Today, synced so far (the today leg is as of a time): in, but never final (run-2 N14). */
const TODAY_SYNCED_MARK: CoverageMark = { ...TODAY_MARK, words: "today, not final" };
/** A strip of spend (the table has a spend column) says r4's words: `no spend`, `spent`. */
const SPEND_WORDS: Readonly<Record<string, string>> = { zero: "no spend", measured: "spent" };

/** Today's date (`YYYY-MM-DD`) in `timeZone`, else UTC. */
function todayIn(timeZone: unknown): string {
  const zone = typeof timeZone === "string" && timeZone ? timeZone : "UTC";
  const format = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now()));
  try {
    return format(zone);
  } catch {
    return format("UTC");
  }
}

function coverageMark(status: unknown) {
  return typeof status === "string" && Object.hasOwn(COVERAGE_MARKS, status) && status !== "unknown"
    ? COVERAGE_MARKS[status]!
    : COVERAGE_MARKS.unknown!;
}

/**
 * `Days Jan 8 ·—█████◌ Jan 15`: one mark per day of the settled leg's
 * coverage, then the today leg's day(s) as `◌` (today is never final). A
 * strip too long for the pane wraps below its dates. Then the legend, naming
 * only the marks the strip uses.
 */
function coverageLines(legs: Record<string, unknown>, ctx: ViewRenderCtx, reasonSaid = false, spend = false): string[] {
  const settled = asRecord(legs.settled);
  const today = isRecord(legs.today) ? legs.today : null;
  const coverage = asRecord(settled.coverage);
  // Today's ◌ only extends the settled leg's strip: alone it tells the reader nothing.
  if (!asList(coverage.days).some(isRecord)) {
    return [];
  }
  const todayDates = new Set<string>();
  // Today is in so far when its leg is as of a time AND carries a number; else it is not synced yet.
  const todayMark = today && clockTime(today.asOf) !== null && numberCells({ legs: { today } }).some((cell) => finite(cell.value) !== null)
    ? TODAY_SYNCED_MARK
    : TODAY_MARK;
  if (today) {
    const todayDays = asList(asRecord(today.coverage).days).filter(isRecord);
    for (const day of todayDays) if (typeof day.date === "string") todayDates.add(day.date);
    const to = asRecord(today.window).to;
    if (!todayDays.length && typeof to === "string") todayDates.add(to);
  }
  // A day not synced yet that is today is today's ◌ (today is never final).
  const today2 = todayIn(asRecord(settled.window).tz);
  const words = (key: string, mark: CoverageMark): CoverageMark => (spend && SPEND_WORDS[key] ? { ...mark, words: SPEND_WORDS[key]! } : mark);
  const days: { date: string; mark: CoverageMark }[] = [];
  for (const day of asList(coverage.days).filter(isRecord)) {
    if (typeof day.date !== "string") continue;
    const isToday = todayDates.has(day.date) || (day.status === "not_synced" && day.date === today2);
    days.push({ date: day.date, mark: isToday ? (todayDates.has(day.date) ? todayMark : TODAY_MARK) : words(String(day.status), coverageMark(day.status)) });
  }
  for (const date of [...todayDates].sort()) {
    if (!days.some((day) => day.date === date)) days.push({ date, mark: todayMark });
  }
  if (!days.length) {
    return [];
  }
  const first = formatAsOf(days[0]!.date) ?? "";
  const last = formatAsOf(days[days.length - 1]!.date) ?? "";
  const plainGlyphs = days.map((day) => day.mark.glyph).join("");
  const painted = (from: number, to: number) =>
    days.slice(from, to).map((day) => paint(day.mark.glyph, day.mark.role, ctx)).join("");
  const lines: string[] = [];
  const one = `Days ${first} ${plainGlyphs} ${last}`;
  // The legend hangs under the strip, past `Days ` (r4), when the strip is one line.
  let legendIndent = "";
  if (displayWidth(one) <= ctx.width) {
    legendIndent = " ".repeat(DAYS_LABEL.length);
    lines.push(`${paint("Days", "b", ctx)} ${paint(first, "muted", ctx)} ${painted(0, days.length)} ${paint(last, "muted", ctx)}`);
  } else {
    lines.push(fitLine(`${paint("Days", "b", ctx)} ${paint(`${first} – ${last}`, "muted", ctx)}`, ctx.width));
    const chunk = Math.max(1, ctx.width - 2);
    for (let start = 0; start < days.length; start += chunk) {
      lines.push(`  ${painted(start, Math.min(days.length, start + chunk))}`);
    }
  }
  // The legend (r4): each mark the strip uses and its words, three spaces
  // apart. A state reason already says which days are in: then no legend.
  if (reasonSaid) {
    return lines;
  }
  const used = new Map<string, string>();
  for (const day of days) used.set(day.mark.glyph, `${day.mark.legend ?? day.mark.glyph} ${day.mark.words}`);
  const legend = [...used.values()].join("   ");
  lines.push(...wrapText(legend, Math.max(1, ctx.width - legendIndent.length)).map((line) => `${legendIndent}${paint(line, "muted", ctx)}`));
  return lines;
}

const DAYS_LABEL = "Days ";

// ── sections (composite) ──

/**
 * A composite's sections, ONE level deep: a section's own sections never
 * draw (the contract allows one level, the decoder cannot enforce it).
 */
export function sectionLines(sections: unknown, ctx: ViewRenderCtx, draw: MeasureDraw): string[] {
  const lines: string[] = [];
  for (const section of asList(sections).filter(isRecord)) {
    const body = asRecord(section.body);
    const title = viewText(section.title);
    let drawn: string[];
    // A numbers section puts its title on its leg's own title line (one heading line).
    let titled = false;
    switch (section.kind) {
      case "numbers": {
        const quiet = unmeasuredLine(title, body, ctx);
        drawn = quiet ?? numbersBodyLines(body, ctx, draw, true, title);
        titled = true;
        break;
      }
      case "health":
        drawn = healthBodyLines(body, ctx, draw, { nested: true }).lines;
        break;
      case "list":
        drawn = listSectionLines(body, ctx, draw);
        break;
      case "record":
        drawn = recordSectionLines(body, ctx, draw.notes);
        break;
      default:
        drawn = [];
    }
    // An empty section is nothing: never a title over no lines.
    if (!drawn.length) continue;
    if (lines.length) lines.push("");
    if (!titled) lines.push(...wrapText(title, ctx.width).map((line) => paint(line, "b", ctx)));
    lines.push(...drawn);
  }
  return lines;
}

/** Every number of a numbers body (rows, totals, steps of each leg), as its cells. */
function numberCells(body: Record<string, unknown>): Record<string, unknown>[] {
  const legs = asRecord(body.legs);
  return [legs.settled, legs.today].filter(isRecord).flatMap((leg) => [
    ...asList(leg.rows).filter(isRecord).flatMap((row) => Object.values(asRecord(row.cells))),
    ...Object.values(asRecord(leg.totals)),
    ...asList(leg.steps).filter(isRecord).map((step) => ({ value: step.count, reason: step.reason }))
  ]).filter(isRecord).filter((cell) => "value" in cell);
}

/**
 * A numbers section with nothing measured (every number null) as ONE dim line
 * saying why: `Prior 7 days · Sep 18–24 · the prior period is not complete`.
 * The why is the one reason every number gives, else `not measured`. Null when
 * any number is measured, or the section has none at all.
 */
function unmeasuredLine(title: string, body: Record<string, unknown>, ctx: ViewRenderCtx): string[] | null {
  const cells = numberCells(body);
  if (!cells.length || cells.some((cell) => finite(cell.value) !== null)) return null;
  const reasons = new Set(cells.map((cell) => (isRecord(cell.reason) ? viewText(cell.reason.words) : "")));
  const [only] = [...reasons];
  const why = reasons.size === 1 && only ? only : "not measured";
  const window = asRecord(asRecord(asRecord(body.legs).settled).window);
  const label = windowLabel(window);
  const dates = label && !title.toLowerCase().includes(label.toLowerCase()) ? label : "";
  return wrapText([title, dates, why].filter(Boolean).join(" · "), ctx.width).map((line) => paint(line, "muted", ctx));
}

function listSectionLines(body: Record<string, unknown>, ctx: ViewRenderCtx, draw: MeasureDraw): string[] {
  const columns = asList(body.columns).filter(isRecord).map((column) => ({
    key: typeof column.key === "string" ? column.key : "",
    label: viewText(column.label),
    unit: asUnit(column.unit, "text")
  }));
  const rows = asList(body.rows).filter(isRecord);
  if (!rows.length) {
    const empty = viewText(body.emptyWords);
    return empty ? wrapText(empty, ctx.width).map((line) => paint(line, "muted", ctx)) : [];
  }
  return cellTableLines({
    columns,
    rows: rows.map((row) => ({ label: viewText(row.title), cells: columns.map((column) => asRecord(row.cells)[column.key] as TableCell) })),
    currency: null
  }, ctx, draw);
}

function recordSectionLines(body: Record<string, unknown>, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  return pairLines(asList(body.fields).filter(isRecord).map((field) => ({
    label: viewText(field.label),
    value: drawCell(field.value as TableCell, { label: "", unit: asUnit(field.unit, "text") }, null, notes)
  })), ctx);
}

// ── the body ──

/** A numbers body, drawn. `nested`: inside a composite (its own sections never draw). */
export function numbersBodyLines(body: Record<string, unknown>, ctx: ViewRenderCtx, draw: MeasureDraw, nested = false, heading = ""): string[] {
  const columns = numbersColumns(body);
  const currency = typeof body.currency === "string" ? body.currency : null;
  const blocks: string[][] = [];
  const legs = isRecord(body.legs) ? body.legs : null;
  if (legs && isRecord(legs.settled)) {
    blocks.push(legLines(legs.settled, false, nested, body, columns, ctx, draw, heading));
  }
  if (legs && isRecord(legs.today)) {
    blocks.push(legLines(legs.today, true, nested, body, columns, ctx, draw, isRecord(legs.settled) ? "" : heading));
  }
  const legsDrew = blocks.some((block) => block.length);
  if (legs && !draw.stripDrawn) {
    // ONE day strip per view: a section's own strip would repeat the same days.
    const strip = coverageLines(legs, ctx, draw.reasonSaid === true, columns.some((column) => column.key.toLowerCase() === "spend"));
    // The legend is drawn when no state reason already says which days are in.
    if (strip.length && !nested && draw.reasonSaid !== true) draw.legendDrawn = true;
    if (strip.length) draw.stripDrawn = true;
    blocks.push(strip);
  }

  const leaders = asList(body.leaders).filter(isRecord).flatMap((leader) => {
    const measure = asRecord(leader.measure);
    const column = columns.find((entry) => entry.key === measure.key);
    const label = viewText(measure.label);
    const row = viewText(leader.rowLabel);
    if (!label || !row) return [];
    const value = drawCell(leader.value as TableCell, column ?? { label: "", unit: "count" }, currency, draw.notes);
    return wrapText(`${label} · ${row} · ${value}`, ctx.width);
  });
  blocks.push(leaders);

  // No verdict-source note: r4 draws none, and the rows' own words carry each verdict.
  if (!nested) {
    blocks.push(sectionLines(body.sections, ctx, draw));
  }
  if (heading && !legsDrew && blocks.some((block) => block.length)) {
    // A section whose legs drew nothing but has a strip or leaders still says what it is, once.
    blocks.unshift(wrapText(heading, ctx.width).map((line) => paint(line, "b", ctx)));
  }
  return blocks.filter((block) => block.length).flatMap((block, index) => (index > 0 ? ["", ...block] : block));
}

/** The settled leg's rows, when they draw as a table (j/k select them); 0 otherwise. */
function selectableRows(body: Record<string, unknown>): number {
  const legs = asRecord(body.legs);
  const settled = asRecord(legs.settled);
  const rows = asList(settled.rows).filter(isRecord);
  if (body.layout === "steps" || body.layout === "kpis") {
    return 0;
  }
  return rows.length > 1 ? rows.length : 0;
}

/** The provenance words r4 closes a numbers view with, per `via` (only our stored copy has words yet). */
const VIA_WORDS: Readonly<Record<string, string>> = { our_db: "via our data" };

/**
 * r4 view-01's last row, `Source: Google Ads, via our data`, in dim: where the
 * strip's days come from, under the strip's legend. Not drawn without one: a
 * bare table (r4 flow-numbers-01) has none, and a state reason that says which
 * days are in (flow-numbers-03) speaks for the days instead. The app link that
 * follows it in r4 (`· Open in Google Ads ↗`) waits for the app-link wave.
 */
function sourceWordsLines(view: Parameters<KindRenderer<"numbers">>[0], ctx: ViewRenderCtx): string[] {
  const provenance = asRecord(view.provenance);
  const source = viewText(provenance.source);
  const via = VIA_WORDS[String(provenance.via)];
  return source && via ? wrapText(`Source: ${source}, ${via}`, ctx.width).map((line) => paint(line, "muted", ctx)) : [];
}

export const renderNumbers: KindRenderer<"numbers"> = (view, ctx): KindRender => {
  const asOf = typeof view.asOf === "string" ? Date.parse(view.asOf) : Number.NaN;
  const draw: MeasureDraw = {
    notes: new FootnoteBook(), hidden: 0, reasonSaid: isRecord(view.stateReason), viewTitle: viewText(view.title),
    ...(Number.isFinite(asOf) ? { refMs: asOf } : {})
  };
  const body = numbersBodyLines(asRecord(view.body), ctx, draw);
  const source = draw.legendDrawn ? sourceWordsLines(view, ctx) : [];
  const detail = source.length ? [...body, "", ...source] : body;
  return {
    detail,
    footnotes: draw.notes.lines().flatMap((line) => wrapText(line, ctx.width).map((part) => paint(part, "muted", ctx))),
    keys: [],
    okKey: null,
    // r4: a ready table is browsed by row (`j k row`); one that carries a state
    // (not measured, partial, out of date…) is read, not browsed (flow-numbers-02: no keys).
    rowCount: view.state === "ready" ? selectableRows(asRecord(view.body)) : 0,
    ...(draw.hidden ? { hiddenColumns: draw.hidden } : {})
  };
};
