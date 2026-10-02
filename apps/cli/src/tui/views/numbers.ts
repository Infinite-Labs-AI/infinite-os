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
// The view's columns carry no drop priority, so the server's column order is
// its order of importance: a narrow table drops from the right (never the row
// label), and says which columns it hid (`→` shows them as records).
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
  /** The view has a state reason, which already says how many days are in: the legend skips its N-of-M lead. */
  reasonSaid?: boolean;
}

// ── tables of cells ──

export interface CellTableColumn {
  label: string;
  unit: UnitV1;
  dropPriority?: number;
  /** Format a cell's number with a sign (`+1%`): differences. */
  signed?: boolean;
}

/** A cell, or text already drawn (status words, labels). */
export type TableCell = CellV1 | TextCellV1 | string | null | undefined;

export interface CellTableRow {
  label: string;
  cells: TableCell[];
  /** Per-cell units that override the column's (a differences table mixes units). */
  units?: (UnitV1 | undefined)[];
}

export interface CellTableInput {
  columns: CellTableColumn[];
  rows: CellTableRow[];
  total?: CellTableRow | null;
  currency: string | null;
  /** The row j/k selected: it is marked `▸` (in place of the table's left border). */
  selected?: number | null;
}

/**
 * A table of cells at `ctx.width`, through the one table drawer. Columns that
 * do not fit drop (and are named: `+ A, B · → to see`); `showHiddenColumns`
 * draws every column as `label: value` records instead. A footnote is booked
 * only for a cell that is drawn, so no mark points at a hidden column.
 */
export function cellTableLines(input: CellTableInput, ctx: ViewRenderCtx, draw: MeasureDraw): string[] {
  const labels = ["", ...input.columns.map((column) => viewText(column.label))];
  const all = input.columns.map((_column, index) => index);
  // Pass 1 (a scratch book): which columns fit at this width.
  const trial = renderTable(tableInput(input, labels, all, new FootnoteBook()), tableOptions(ctx));
  const hiddenIndexes = trial.fallback === "record" ? [] : hiddenColumnIndexes(labels, trial.hidden);
  draw.hidden += hiddenIndexes.length;

  if (trial.fallback === "record" || (ctx.showHiddenColumns && hiddenIndexes.length)) {
    return recordLines(input, labels, ctx, draw.notes);
  }
  const keep = all.filter((index) => !hiddenIndexes.includes(index));
  const table = renderTable(tableInput(input, labels, keep, draw.notes), tableOptions(ctx));
  if (table.fallback === "record") {
    return recordLines(input, labels, ctx, draw.notes);
  }
  const lines = [...table.lines];
  // Rows start after the top border, the header and its rule.
  const selected = selectedRow(input);
  if (selected !== null && lines[3 + selected] !== undefined) {
    // Pass 2 never drops more than pass 1 (fewer footnotes, never wider cells), and rows are one line each.
    lines[3 + selected] = lines[3 + selected]!.replace("│", "▸");
  }
  if (hiddenIndexes.length) {
    const named = hiddenIndexes.map((index) => labels[index + 1]).filter(Boolean).join(", ");
    lines.push(...wrapText(`+ ${named} · → to see`, ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  return lines;
}

function tableOptions(ctx: ViewRenderCtx) {
  return { width: ctx.width, color: ctx.color, theme: ctx.theme };
}

function tableInput(input: CellTableInput, labels: readonly string[], keep: readonly number[], notes: FootnoteBook) {
  const columns: TableColumn[] = [
    { label: "", dropPriority: 0 },
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
  const row = (entry: CellTableRow) => [
    viewText(entry.label),
    ...keep.map((index) => drawCell(entry.cells[index], columnFor(input.columns[index]!, entry, index), input.currency, notes))
  ];
  return {
    columns,
    rows: input.rows.map(row),
    ...(input.total ? { total: row(input.total) } : {})
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

function columnFor(column: CellTableColumn, row: CellTableRow, index: number): CellTableColumn {
  const unit = row.units?.[index];
  return unit ? { ...column, unit } : column;
}

export function drawCell(cell: TableCell, column: CellTableColumn, currency: string | null, notes: FootnoteBook): string {
  if (typeof cell === "string") {
    return viewText(cell);
  }
  const text = cellText(cell as CellV1 | TextCellV1 | null | undefined, column.unit, currency, notes);
  const value = isRecord(cell) ? finite(cell.value) : null;
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
    const mark = selected === null ? "" : recordIndex === selected ? "▸ " : "  ";
    lines.push(...wrapText(viewText(record.label), Math.max(1, ctx.width - mark.length)).map((line, index) =>
      `${index === 0 ? mark : " ".repeat(mark.length)}${paint(line, "b", ctx)}`));
    if (!open) {
      return;
    }
    input.columns.forEach((column, index) => {
      const value = drawCell(record.cells[index], columnFor(column, record, index), input.currency, notes);
      const indent = " ".repeat(mark.length + 2);
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
function legTitle(leg: Leg, isToday: boolean, ctx: ViewRenderCtx): string {
  const window = asRecord(leg.window);
  const final = !isToday && leg.final === true;
  const asOf = clockTime(leg.asOf, ctx.timeZone);
  const refresh = asRecord(leg.refresh);
  const refreshWords = isToday && typeof refresh.status === "string" ? REFRESH_WORDS[refresh.status] : undefined;
  const retryAt = refreshWords ? clockTime(refresh.retryAt, ctx.timeZone) : null;
  return [
    viewText(window.label),
    isToday ? "" : windowDates(window) ?? "",
    final ? "" : "not final",
    final || !asOf ? "" : `as of ${asOf}`,
    refreshWords ? `${refreshWords}${retryAt ? ` until ${retryAt}` : ""}` : ""
  ].filter(Boolean).join(" · ");
}

interface NumbersColumn extends CellTableColumn {
  key: string;
}

function numbersColumns(body: Record<string, unknown>): NumbersColumn[] {
  return asList(body.columns).filter(isRecord).map((column) => ({
    key: typeof column.key === "string" ? column.key : "",
    label: viewText(column.label),
    unit: asUnit(column.unit)
  }));
}

function legLines(
  leg: Leg,
  isToday: boolean,
  nested: boolean,
  body: Record<string, unknown>,
  columns: NumbersColumn[],
  ctx: ViewRenderCtx,
  draw: MeasureDraw
): string[] {
  const layout = body.layout;
  const currency = typeof body.currency === "string" ? body.currency : null;
  const title = legTitle(leg, isToday, ctx);
  const lines = title ? wrapText(title, ctx.width).map((line) => paint(line, "b", ctx)) : [];

  const rows = asList(leg.rows).filter(isRecord);
  const legTotals = isRecord(leg.totals) ? leg.totals : null;
  // A Total row comes only from the settled leg's own totals: never computed, never across legs.
  // A today leg with no rows shows its OWN totals as its values (still its own block, never summed).
  const totals = !isToday ? legTotals : rows.length ? null : legTotals;
  // j/k select the settled leg's rows (the today leg's rows are the same things, not final).
  const selected = !isToday && !nested ? ctx.selected : null;
  const steps = asList(leg.steps).filter(isRecord);

  if (layout === "steps") {
    lines.push(...stepLines(steps, ctx, draw.notes));
    return lines;
  }
  const values: string[] = [];
  if (layout === "kpis" || (!rows.length && totals)) {
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
      rows: rows.map((row) => ({ label: viewText(row.label), cells: cellsOf(asRecord(row.cells), row.status) })),
      total: totals ? { label: "Total", cells: cellsOf(totals, null) } : null,
      currency,
      selected
    }, ctx, draw));
  }
  lines.push(...values);
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
  const blocks: { label: string; cells: Record<string, unknown> }[] = rows.map((row) => ({ label: viewText(row.label), cells: asRecord(row.cells) }));
  if (totals && rows.length !== 1) {
    blocks.push({ label: "Total", cells: totals });
  }
  const lines: string[] = [];
  blocks.forEach((block, index) => {
    if (blocks.length > 1) {
      if (index > 0) lines.push("");
      lines.push(...wrapText(block.label, ctx.width).map((line) => paint(line, "b", ctx)));
    }
    lines.push(...pairLines(columns.map((column) => ({
      label: column.label,
      value: drawCell(block.cells[column.key] as TableCell, column, currency, notes)
    })), ctx));
  });
  return lines;
}

// ── the coverage strip ──

type CoverageMark = { glyph: string; words: string; role: "primary" | "muted" | "warning" | "hatch" };

/** r4's day strip: `█` cyan, `·` dim, `◌` amber (today), `░` hatch (not synced yet). */
const COVERAGE_MARKS: Record<string, CoverageMark> = {
  measured: { glyph: "█", words: "measured", role: "primary" },
  partial: { glyph: "▒", words: "partial", role: "warning" },
  zero: { glyph: "·", words: "zero", role: "muted" },
  not_measured: { glyph: "—", words: "not measured", role: "muted" },
  not_synced: { glyph: "░", words: "not synced", role: "hatch" },
  unknown: { glyph: "?", words: "unknown", role: "muted" }
};
const TODAY_MARK: CoverageMark = { glyph: "◌", words: "today, not synced yet", role: "warning" };

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
function coverageLines(legs: Record<string, unknown>, ctx: ViewRenderCtx, reasonSaid = false): string[] {
  const settled = asRecord(legs.settled);
  const today = isRecord(legs.today) ? legs.today : null;
  const coverage = asRecord(settled.coverage);
  // Today's ◌ only extends the settled leg's strip: alone it tells the reader nothing.
  if (!asList(coverage.days).some(isRecord)) {
    return [];
  }
  const todayDates = new Set<string>();
  if (today) {
    const todayDays = asList(asRecord(today.coverage).days).filter(isRecord);
    for (const day of todayDays) if (typeof day.date === "string") todayDates.add(day.date);
    const to = asRecord(today.window).to;
    if (!todayDays.length && typeof to === "string") todayDates.add(to);
  }
  const days: { date: string; mark: CoverageMark }[] = [];
  for (const day of asList(coverage.days).filter(isRecord)) {
    if (typeof day.date !== "string") continue;
    days.push({ date: day.date, mark: todayDates.has(day.date) ? TODAY_MARK : coverageMark(day.status) });
  }
  for (const date of [...todayDates].sort()) {
    if (!days.some((day) => day.date === date)) days.push({ date, mark: TODAY_MARK });
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
  const used = new Map<string, string>();
  for (const day of days) used.set(day.mark.glyph, `${day.mark.glyph} ${day.mark.words}`);
  const requested = finite(coverage.requestedDays);
  const measured = finite(coverage.measuredDays);
  const legend = [
    ...(!reasonSaid && requested !== null && measured !== null ? [`${measured} of ${requested} days measured`] : []),
    ...used.values()
  ].join("   ");
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
    let drawn: string[];
    switch (section.kind) {
      case "numbers":
        drawn = numbersBodyLines(body, ctx, draw, true);
        break;
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
    const title = viewText(section.title);
    if (!title && !drawn.length) continue;
    if (lines.length) lines.push("");
    lines.push(...wrapText(title, ctx.width).map((line) => paint(line, "b", ctx)), ...drawn);
  }
  return lines;
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
export function numbersBodyLines(body: Record<string, unknown>, ctx: ViewRenderCtx, draw: MeasureDraw, nested = false): string[] {
  const columns = numbersColumns(body);
  const currency = typeof body.currency === "string" ? body.currency : null;
  const blocks: string[][] = [];
  const legs = isRecord(body.legs) ? body.legs : null;
  if (legs && isRecord(legs.settled)) {
    blocks.push(legLines(legs.settled, false, nested, body, columns, ctx, draw));
  }
  if (legs && isRecord(legs.today)) {
    blocks.push(legLines(legs.today, true, nested, body, columns, ctx, draw));
  }
  if (legs) {
    blocks.push(coverageLines(legs, ctx, draw.reasonSaid === true));
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

  const verdictSource = viewText(body.verdictSource);
  if (verdictSource) {
    blocks.push(wrapText(`Verdicts: ${verdictSource}`, ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  if (!nested) {
    blocks.push(sectionLines(body.sections, ctx, draw));
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

export const renderNumbers: KindRenderer<"numbers"> = (view, ctx): KindRender => {
  const draw: MeasureDraw = { notes: new FootnoteBook(), hidden: 0, reasonSaid: isRecord(view.stateReason) };
  const detail = numbersBodyLines(asRecord(view.body), ctx, draw);
  return {
    detail,
    footnotes: draw.notes.lines().flatMap((line) => wrapText(line, ctx.width).map((part) => paint(part, "muted", ctx))),
    keys: [],
    okKey: null,
    rowCount: selectableRows(asRecord(view.body)),
    ...(draw.hidden ? { hiddenColumns: draw.hidden } : {})
  };
};
