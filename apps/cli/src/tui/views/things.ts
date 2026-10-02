// Shared pieces of the "things" views (T10: list, record, document, link,
// quiet): reading a body defensively, the selection marker, label/value rows,
// who-changed-what words, and the view's `next` steps as selectable rows.
//
// The contract has no per-row ask and no per-step key yet (contract rev 2), so
// a view's `next` steps print as rows of their own, after the data rows: j/k
// reach them and Enter sends the step's ask as a NEW user turn (never a tool
// call). Every string is scrubbed (`viewText`) before it is measured or drawn.
import type { AnswerViewV1, UnitV1 } from "@infinite-os/types";

import { displayWidth, padEndCells } from "../lib/display-width.js";
import { fitLine, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { ViewRenderCtx } from "./types.js";

export type Fields = Record<string, unknown>;

/** The body as a plain record (a decoded view vouches only for its envelope). */
export function bodyOf(view: AnswerViewV1): Fields {
  return isRecord(view.body) ? view.body : {};
}

/** The records in an array field; anything else is an empty list. */
export function recordsOf(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => viewText(item)).filter(Boolean) : [];
}

const UNITS: ReadonlySet<string> = new Set(["money", "count", "percent", "ratio", "seconds", "text"]);

export function unitOf(value: unknown, fallback: UnitV1): UnitV1 {
  return typeof value === "string" && UNITS.has(value) ? (value as UnitV1) : fallback;
}

export function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

export function clampIndex(value: number, count: number): number {
  if (count <= 0) {
    return -1;
  }
  return Math.max(0, Math.min(count - 1, Math.floor(Number.isFinite(value) ? value : 0)));
}

/** The two columns before a selectable row: `▸ ` on the selected one. */
export function marker(selected: boolean, ctx: ViewRenderCtx): string {
  return selected ? paint("▸ ", "primary", ctx, { bold: true }) : "  ";
}

/**
 * Who made a change: `by Sam`; a null `who` (the host knows nobody was
 * recorded) is `who: unknown`; an absent `who` says nothing.
 */
export function whoText(record: Fields): string {
  if (!("who" in record) || record.who === undefined) {
    return "";
  }
  const who = viewText(record.who);
  return who ? `by ${who}` : "who: unknown";
}

/** `from → to`, a null side as `—`; empty when the record carries neither. */
export function changeText(record: Fields): string {
  const has = (key: string) => key in record && record[key] !== undefined;
  if (!has("from") && !has("to")) {
    return "";
  }
  return `${viewText(record.from) || "—"} → ${viewText(record.to) || "—"}`;
}

/** The width of a label column: the longest label, capped at 40% of the width (at least 4). */
export function labelColumnWidth(labels: readonly string[], width: number): number {
  const longest = labels.reduce((max, label) => Math.max(max, displayWidth(label)), 0);
  return Math.max(1, Math.min(longest, Math.max(4, Math.floor(width * 0.4))));
}

/** `label  value`, the label muted and padded, the value wrapped under itself. */
export function labelValueLines(
  label: string,
  value: string,
  labelWidth: number,
  ctx: ViewRenderCtx,
  valueRole: "text" | "muted" | "warning" = "text"
): string[] {
  const width = Math.max(1, Math.floor(ctx.width));
  const shownLabel = fitLine(label, labelWidth);
  const valueWidth = width - labelWidth - 2;
  if (valueWidth < 8) {
    // Too narrow for two columns: the label, then the value under it.
    return [
      paint(fitLine(label, width), "muted", ctx),
      ...wrapText(value, width).map((line) => paint(line, valueRole, ctx))
    ];
  }
  const wrapped = value ? wrapText(value, valueWidth) : [""];
  const indent = " ".repeat(labelWidth + 2);
  return wrapped.map((line, index) =>
    index === 0
      ? `${paint(padEndCells(shownLabel, labelWidth), "muted", ctx)}  ${paint(line, valueRole, ctx)}`
      : `${indent}${paint(line, valueRole, ctx)}`
  );
}

export interface NextStep {
  label: string;
  ask: string;
}

/** The view's `next` steps that can be sent (a label and an ask), scrubbed. */
export function nextSteps(view: AnswerViewV1): NextStep[] {
  return recordsOf(view.next)
    .map((step) => ({ label: viewText(step.label), ask: viewText(step.ask) }))
    .filter((step) => step.label !== "" && step.ask !== "");
}

/** The next steps as selectable rows: `▸ → Pause it`. `first` is the first step's row index; `selectedRow` the selection. */
export function nextStepLines(steps: readonly NextStep[], first: number, selectedRow: number, ctx: ViewRenderCtx): string[] {
  return steps.map((step, index) => {
    const selected = selectedRow === first + index;
    const text = fitLine(`→ ${step.label}`, Math.max(1, ctx.width - 2));
    return `${marker(selected, ctx)}${paint(text, selected ? "text" : "primary", ctx, { bold: selected })}`;
  });
}

/** A blank line, then `block`, when the block has lines and something came before it. */
export function section(lines: string[], block: readonly string[]): void {
  if (!block.length) {
    return;
  }
  if (lines.length) {
    lines.push("");
  }
  lines.push(...block);
}
