// The list view (terminal-r4 "List"): one line per thing, status first, the
// selected row marked `▸` (j/k move it). Below the rows: the selected row's
// details, then the view's next steps as rows of their own (Enter sends the
// step's ask as a NEW turn; a data row has no ask in contract v1).
//
// Layouts: `rows` and `files` are aligned columns; `log` is one change per line
// (`when  what  from → to · by who`, and a null who is `who: unknown`);
// `groups` prints each group's label and reason above its rows. Columns that do
// not fit drop from the right (`+ Spend · → to see`); `→` then prints every row
// as a record. `omitted`, `filterWords` and `emptyWords` print verbatim.
//
// The list opens on the row the view names (`body.selected`, r4 view-02 opens
// on the flagged Hook B, so its details show at once), and a cell the view
// marks `tone: "bad"` is amber (r4 `0 trials`).
import type { AnswerViewV1, CellV1, TextCellV1, UnitV1 } from "@infinite-os/types";

import { looksNumeric } from "../../formatting/table.js";
import { displayWidth, padEndCells, truncateCells } from "../lib/display-width.js";
import {
  cellText,
  fitLine,
  formatAsOf,
  FootnoteBook,
  isRecord,
  linkLine,
  paint,
  toneRole,
  viewText,
  wrapText
} from "./primitives.js";
import {
  bodyOf,
  changeText,
  clampIndex,
  countOf,
  formatCount,
  labelColumnWidth,
  labelValueLines,
  marker,
  nextStepLines,
  rowLine,
  nextSteps,
  recordsOf,
  section,
  unitOf,
  whoText,
  type Fields,
  type Span
} from "./things.js";
import type { KindRenderer, ViewRenderCtx } from "./types.js";

interface Column {
  key: string;
  label: string;
  unit: UnitV1;
}

/** A title never gets narrower than this (or its own width) before columns drop. */
const MIN_TITLE_CELLS = 12;
const GAP = "  ";
/** r4's row grammar pads money to 8 and a percent to 6, right-aligned (`padStart(8)`, `padStart(6)`). */
const ROW_GRAMMAR_MIN: Partial<Record<UnitV1, number>> = { money: 8, percent: 6 };

/** The row the list opens on: the one `body.selected` names, else the first. Rows count top rows, then each group's. */
export function listOpeningRow(view: AnswerViewV1): number {
  if (view.kind !== "list") return 0;
  const body = bodyOf(view);
  const id = typeof body.selected === "string" ? body.selected : "";
  if (!id) return 0;
  const rows = [...recordsOf(body.rows), ...recordsOf(body.groups).flatMap((group) => recordsOf(group.rows))];
  return Math.max(0, rows.findIndex((row) => row.id === id));
}

export const renderList: KindRenderer<"list"> = (view, ctx) => {
  const body = bodyOf(view);
  const notes = new FootnoteBook();
  const columns: Column[] = recordsOf(body.columns)
    .map((column) => ({ key: viewText(column.key), label: viewText(column.label), unit: unitOf(column.unit, "text") }))
    .filter((column) => column.key !== "");
  const top = recordsOf(body.rows);
  const groups = recordsOf(body.groups).map((group) => ({
    label: viewText(group.label),
    reason: viewText(group.reason),
    rows: recordsOf(group.rows)
  }));
  const rows = [...top, ...groups.flatMap((group) => group.rows)];
  const steps = nextSteps(view);
  const rowCount = rows.length + steps.length;
  const selected = clampIndex(ctx.selected, rowCount);
  const lines: string[] = [];

  const filterWords = viewText(body.filterWords);
  if (filterWords) {
    lines.push(...wrapText(filterWords, ctx.width).map((line) => paint(line, "muted", ctx)));
  }

  let hiddenColumns = 0;
  if (!rows.length) {
    const emptyWords = viewText(body.emptyWords);
    if (emptyWords) {
      lines.push(...wrapText(emptyWords, ctx.width));
    }
  } else if (body.layout === "log") {
    lines.push(...logLines(top, 0, selected, ctx));
    let index = top.length;
    for (const group of groups) {
      lines.push(...groupHead(group.label, group.reason, ctx), ...logLines(group.rows, index, selected, ctx));
      index += group.rows.length;
    }
  } else {
    const currency = typeof body.currency === "string" ? body.currency : null;
    const drawn = rowLines(rows, columns, selected, ctx, notes, currency);
    hiddenColumns = drawn.hidden.length;
    // Top rows first, then each group under its label and reason.
    lines.push(...drawn.header, ...drawn.rows.slice(0, top.length).flat());
    let index = top.length;
    for (const group of groups) {
      lines.push(...groupHead(group.label, group.reason, ctx), ...drawn.rows.slice(index, index + group.rows.length).flat());
      index += group.rows.length;
    }
    if (drawn.hidden.length && !ctx.showHiddenColumns) {
      lines.push(paint(fitLine(`+ ${drawn.hidden.join(", ")} · → to see`, ctx.width), "muted", ctx));
    }
  }

  const omitted = isRecord(body.omitted) ? body.omitted : null;
  const omittedCount = countOf(omitted?.count);
  if (omitted && omittedCount !== null && omittedCount > 0) {
    const reason = viewText(omitted.reason);
    section(lines, wrapText(`${formatCount(omittedCount)} not shown${reason ? ` · ${reason}` : ""}`, ctx.width).map((line) => paint(line, "muted", ctx)));
  }

  const chosen = selected >= 0 && selected < rows.length ? rows[selected] : undefined;
  if (chosen) {
    section(lines, rowDetailLines(chosen, ctx, notes));
  }
  section(lines, nextStepLines(steps, rows.length, selected, ctx));

  const copies = rows.map((row) => viewText(row.copy) || viewText(row.url) || null);
  return {
    detail: lines,
    footnotes: notes.lines(),
    keys: [],
    okKey: null,
    rowCount,
    rowAsks: [...rows.map(() => null), ...steps.map((step) => step.ask)],
    ...(copies.some((copy) => copy !== null) ? { rowCopies: [...copies, ...steps.map(() => null)] } : {}),
    ...(hiddenColumns ? { hiddenColumns } : {})
  };
};

function groupHead(label: string, reason: string, ctx: ViewRenderCtx): string[] {
  if (!label && !reason) {
    return [];
  }
  const plain = [label, reason].filter(Boolean).join(" · ");
  const fitted = fitLine(plain, ctx.width);
  if (fitted !== plain || !label) {
    return [paint(fitted, label ? "text" : "muted", ctx)];
  }
  return [`${paint(label, "b", ctx)}${reason ? paint(` · ${reason}`, "muted", ctx) : ""}`];
}

/** `▸ ● on  ` — the marker and the status word, in the status tone. */
function statusText(row: Fields): { text: string; tone: ReturnType<typeof toneRole> } | null {
  const status = isRecord(row.status) ? row.status : null;
  const word = viewText(status?.word);
  if (!word) {
    return null;
  }
  const tone = status?.tone === "ok" || status?.tone === "warn" || status?.tone === "bad" ? status.tone : "muted";
  return { text: `● ${word}`, tone: toneRole(tone) };
}

/**
 * r4's row grammar (`● on  Hook A · demo loop  $18.20  1.32%  3 trials`)
 * needs no header when every cell says what it is: at most one money column
 * (with its currency) and one percent column, and counts that carry their
 * column's noun. Anything else keeps the header row.
 */
function selfDescribing(columns: readonly Column[]): boolean {
  const count = (unit: UnitV1) => columns.filter((column) => column.unit === unit).length;
  return columns.length > 0
    && count("money") <= 1
    && count("percent") <= 1
    && columns.every((column) => column.unit === "money" || column.unit === "percent" || (column.unit === "count" && column.label !== ""));
}

/** `3 trials`, `1 trial`: a measured count with its column's noun (a dash or words stay as they are). */
function withNoun(text: string, cell: CellV1 | TextCellV1 | null, label: string): string {
  const value = cell && "value" in cell && typeof cell.value === "number" && Number.isFinite(cell.value) ? cell.value : null;
  if (value === null || !label) return text;
  const noun = label.toLowerCase();
  return `${text} ${value === 1 && noun.endsWith("s") && !noun.endsWith("ss") ? noun.slice(0, -1) : noun}`;
}

function rowLines(
  rows: readonly Fields[],
  columns: readonly Column[],
  selected: number,
  ctx: ViewRenderCtx,
  notes: FootnoteBook,
  currency: string | null = null
): { header: string[]; rows: string[][]; hidden: string[] } {
  const width = Math.max(1, Math.floor(ctx.width));
  const titles = rows.map((row) => viewText(row.title));
  const statuses = rows.map(statusText);
  const bare = selfDescribing(columns);
  // Cell text in row order, so footnote marks number top to bottom.
  const cells = rows.map((row) => {
    const own = isRecord(row.cells) ? row.cells : {};
    return columns.map((column) => {
      const cell = asCell(own[column.key]);
      const text = cellText(cell, column.unit, currency, notes);
      return bare && column.unit === "count" ? withNoun(text, cell, column.label) : text;
    });
  });
  // The cells the view flags as the ones to look at (`tone: "bad"`): amber (r4 `0 trials`).
  const bad = rows.map((row) => {
    const own = isRecord(row.cells) ? row.cells : {};
    return columns.map((column) => asCell(own[column.key])?.tone === "bad");
  });
  const statusWidth = statuses.reduce((max, status) => Math.max(max, status ? displayWidth(status.text) : 0), 0);
  const fixed = 2 + (statusWidth ? statusWidth + GAP.length : 0);
  const columnWidths = columns.map((column, index) =>
    Math.max(bare ? 0 : displayWidth(column.label), ...cells.map((row) => displayWidth(row[index] ?? "")))
  );
  const longestTitle = titles.reduce((max, title) => Math.max(max, displayWidth(title)), 0);
  const minTitle = Math.max(1, Math.min(longestTitle, MIN_TITLE_CELLS));

  let kept = columns.map((_column, index) => index);
  const used = (keep: readonly number[]) => keep.reduce((sum, index) => sum + (columnWidths[index] ?? 0) + GAP.length, 0);
  while (kept.length && width - fixed - used(kept) < minTitle) {
    kept = kept.slice(0, -1);
  }
  const hidden = columns.filter((_column, index) => !kept.includes(index)).map((column) => column.label || column.key);
  // r4's row grammar pads money and percents a little wider (8 and 6) when the
  // row has the room; that padding never costs a column.
  if (bare) {
    const padded = columnWidths.map((cellWidth, index) => Math.max(cellWidth, ROW_GRAMMAR_MIN[columns[index]!.unit] ?? 0));
    if (width - fixed - kept.reduce((sum, index) => sum + padded[index]! + GAP.length, 0) >= Math.max(minTitle, longestTitle)) {
      padded.forEach((cellWidth, index) => { columnWidths[index] = cellWidth; });
    }
  }
  const titleWidth = Math.max(1, Math.min(longestTitle, width - fixed - used(kept)));
  // A count that carries its noun (`3 trials`) reads left-aligned, as r4 prints it.
  const right = columns.map((column, index) =>
    !(bare && column.unit === "count") && (column.unit !== "text" || cells.every((row) => !row[index] || looksNumeric(row[index] ?? "")))
  );
  const align = (text: string, index: number) => {
    const cellWidth = columnWidths[index] ?? 0;
    return right[index] ? `${" ".repeat(Math.max(0, cellWidth - displayWidth(text)))}${text}` : padEndCells(text, cellWidth);
  };
  // One cell as spans: its padding plain, its value amber when the view flags it.
  // The first cell's gap is the padded title's.
  const cellSpans = (row: number, index: number): Span[] => {
    const text = cells[row]?.[index] ?? "";
    const gap = index === kept[0] ? "" : GAP;
    const pad = " ".repeat(Math.max(0, (columnWidths[index] ?? 0) - displayWidth(text)));
    const value: Span = { text, style: bad[row]?.[index] ? "warning" : "text" };
    return right[index] ? [{ text: `${gap}${pad}`, style: "text" }, value] : [{ text: gap, style: "text" }, value, { text: pad, style: "text" }];
  };
  // `● on  ` — the status word in its tone, padded (in its tone, as r4 does) to the status column.
  const statusSpans = (row: number): Span[] => {
    if (!statusWidth) return [];
    const status = statuses[row];
    const shown = status ? status.text : "";
    return [{ text: `${shown}${" ".repeat(statusWidth - displayWidth(shown))}${GAP}`, style: status ? status.tone : "text" }];
  };
  // Padded, the title takes the gap before the first cell too (r4 `padEnd(22)` in bold on the selection).
  const titleSpan = (row: number, padded: boolean): Span => {
    const title = truncateCells(titles[row] ?? "", titleWidth);
    return { text: padded ? padEndCells(title, titleWidth + (kept.length ? GAP.length : 0)) : title, style: row === selected ? "b" : "text" };
  };

  if (ctx.showHiddenColumns && hidden.length) {
    // Every row as a record: its head line, then each column as `label  value`.
    const labelWidth = labelColumnWidth(columns.map((column) => column.label || column.key), width - 4);
    const inner = { ...ctx, width: width - 4 };
    return {
      header: [],
      hidden,
      rows: rows.map((_row, index) => [
        rowLine([...statusSpans(index), titleSpan(index, false)], index === selected, ctx),
        ...columns.flatMap((column, columnIndex) =>
          labelValueLines(column.label || column.key, cells[index]?.[columnIndex] ?? "", labelWidth, inner).map((line) => `    ${line}`)
        )
      ])
    };
  }

  const header = !bare && kept.length && kept.some((index) => columns[index]?.label)
    ? [paint(fitLine(`${" ".repeat(fixed + titleWidth)}${kept.map((index) => `${GAP}${align(columns[index]?.label ?? "", index)}`).join("")}`.trimEnd(), width), "muted", ctx)]
    : [];
  return {
    header,
    hidden,
    rows: rows.map((_row, index) => [
      rowLine([
        ...statusSpans(index),
        titleSpan(index, true),
        ...kept.flatMap((column) => cellSpans(index, column))
      ], index === selected, ctx)
    ])
  };
}

/**
 * One change per line: `▸ Jan 15, 09:12  Ad set 01 budget  $40 → $30 · by Sam`.
 * Too narrow for that, the change and who made it move to their own line, so
 * `who: unknown` is never cut off.
 */
function logLines(rows: readonly Fields[], first: number, selected: number, ctx: ViewRenderCtx): string[] {
  const width = Math.max(1, Math.floor(ctx.width));
  return rows.flatMap((row, offset) => {
    const index = first + offset;
    const status = statusText(row);
    const what = [changeText(row), whoText(row)].filter(Boolean).join(" · ");
    const head = [
      status ? paint(status.text, status.tone, ctx) : "",
      paint(formatAsOf(row.at, ctx.timeZone) ?? "", "muted", ctx),
      index === selected ? paint(viewText(row.title), "b", ctx) : viewText(row.title)
    ].filter(Boolean);
    const one = `${marker(index === selected, ctx)}${[...head, what].filter(Boolean).join(GAP)}`;
    if (displayWidth(one) <= width || !what) {
      return [fitLine(one, width)];
    }
    return [
      fitLine(`${marker(index === selected, ctx)}${head.join(GAP)}`, width),
      ...wrapText(what, Math.max(1, width - 4)).map((line) => `    ${line}`)
    ];
  });
}

/**
 * The selected row's details: one dim line (r4 `Hook B · since Sep 24 ·
 * Broad · US · 25–54`), each detail as its value, or `label value` when the
 * value does not already say what it is; then its URL, and its app place
 * when `o` can open it.
 */
function rowDetailLines(row: Fields, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  const detail = recordsOf(row.detail).map((item) => ({
    label: viewText(item.label),
    value: cellText(asCell(item.value), "text", null, notes)
  })).filter((item) => item.label !== "" || item.value !== "");
  const lines: string[] = [];
  const words = detail.map((item) =>
    !item.label || item.value.toLowerCase().includes(item.label.toLowerCase()) ? item.value : `${item.label} ${item.value}`);
  if (words.length) {
    lines.push(...wrapText(words.join(" · "), ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  const url = viewText(row.url);
  if (url) {
    lines.push(paint(fitLine(url, ctx.width), "muted", ctx));
  }
  const appLink = isRecord(row.appLink) ? row.appLink : null;
  const place = viewText(appLink?.label);
  if (place && ctx.caps.open) {
    lines.push(linkLine(place, ctx, "(o)"));
  }
  return lines;
}

function asCell(value: unknown): CellV1 | TextCellV1 | null {
  return isRecord(value) ? (value as unknown as CellV1 | TextCellV1) : null;
}
