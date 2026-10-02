// The change view (terminal-r4 "Change"): one thing, what it was and what it
// becomes. `before → after`; a row with no `before` reads `set to <after>`; a
// null `after` prints its reason (in place for `show: "words"`, else a dash
// and a footnote), never a made-up value. Warnings print in amber, and a stale
// "before" (ours vs live) says so. Draws only what the view says.
import type { AnswerViewEnvelopeV1 } from "@infinite-os/types";

import { displayWidth, padEndCells, truncateCells } from "../lib/display-width.js";
import { cellText, FootnoteBook, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** Label column width cap, so a long label never squeezes the values off the line. */
const MAX_LABEL_CELLS = 18;

export function renderChange(view: AnswerViewEnvelopeV1<"change">, ctx: ViewRenderCtx): KindRender {
  const notes = new FootnoteBook();
  const detail = changeLines(view.body, ctx, notes);
  return { detail, footnotes: notes.lines(), keys: [], okKey: null, rowCount: 0 };
}

/** The change body as lines (shared with the approval card). */
export function changeLines(body: unknown, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  const record = isRecord(body) ? body : {};
  const lines: string[] = [];
  const target = isRecord(record.target) ? record.target : {};
  const label = viewText(target.label);
  if (label) {
    lines.push(...wrapText(label, ctx.width).map((line) => paint(line, "text", ctx, { bold: true })));
  }

  const rows: unknown[] = Array.isArray(record.rows) ? record.rows : [];
  const labelled = rows.filter(isRecord).map((row) => ({
    label: viewText(row.label),
    value: changeValue(row, notes)
  }));
  lines.push(...labelValueLines(labelled, ctx));

  const effect = viewText(record.effect);
  if (effect) {
    lines.push(...wrapText(effect, ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  const stale = isRecord(record.staleBefore) ? record.staleBefore : null;
  if (stale) {
    const words = `! ${viewText(stale.label)}: ours says ${viewText(stale.ours, "—")}, live says ${viewText(stale.live, "—")}`;
    lines.push(...wrapText(words, ctx.width).map((line) => paint(line, "warning", ctx)));
  }
  lines.push(...warningLines(record.warnings, ctx));
  return lines;
}

function changeValue(row: Record<string, unknown>, notes: FootnoteBook): string {
  const after = typeof row.after === "string"
    ? viewText(row.after)
    : cellText({ text: null, ...(isRecord(row.reason) ? { reason: row.reason as never } : {}) }, "text", null, notes);
  if (!("before" in row) || row.before === undefined) {
    return `set to ${after}`;
  }
  const before = typeof row.before === "string" ? viewText(row.before) : "—";
  return `${before} → ${after}`;
}

/** Warnings, verbatim (scrubbed), in amber. */
export function warningLines(warnings: unknown, ctx: ViewRenderCtx): string[] {
  const list: unknown[] = Array.isArray(warnings) ? warnings : [];
  return list.flatMap((warning) => {
    const words = viewText(warning);
    return words ? wrapText(`! ${words}`, ctx.width).map((line) => paint(line, "warning", ctx)) : [];
  });
}

/**
 * `label  value` rows with the labels in one column (capped), values wrapped
 * under their own column. Labels muted, values plain.
 */
export function labelValueLines(rows: readonly { label: string; value: string }[], ctx: ViewRenderCtx): string[] {
  const shown = rows.filter((row) => row.label || row.value);
  if (!shown.length) {
    return [];
  }
  const labelCells = Math.min(
    MAX_LABEL_CELLS,
    Math.max(...shown.map((row) => displayWidth(row.label))),
    Math.max(1, Math.floor(ctx.width / 3))
  );
  const valueWidth = Math.max(1, ctx.width - labelCells - 2);
  return shown.flatMap((row) => {
    const label = displayWidth(row.label) > labelCells ? truncateCells(row.label, labelCells) : row.label;
    const values = wrapText(row.value, valueWidth);
    const first = values[0] ?? "";
    const indent = " ".repeat(labelCells + 2);
    return [
      `${paint(padEndCells(label, labelCells), "muted", ctx)}  ${first}`.trimEnd(),
      ...values.slice(1).map((value) => `${indent}${value}`)
    ];
  });
}
