// The r4 card and its parts (terminal-r4 `card()`, `boxed()`, `lbl()`, `K()`,
// `PK()`): a light, square box whose title sits in its top border, field rows
// with a dim label column, `before → after` values, and key chips. Pure; every
// string here arrives already scrubbed, and every line fits the width it is
// given. Colour goes through `paint`, so a terminal without colour gets the
// same layout (chips print as same-width brackets: ` p ` → `[p]`).
import wrapAnsi from "wrap-ansi";

import type { KeyHint } from "../keys/keymap.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { paint, wrapText } from "./primitives.js";
import type { ViewRenderCtx } from "./types.js";

/** A card is never wider than this (r4 `card()`: `Math.min(w, 74)`). */
export const CARD_MAX_WIDTH = 74;
/** An open document's body wraps inside this (r4: `Math.min(w, 76)`). */
export const DOCUMENT_MAX_WIDTH = 76;
/** The label column of a field row is at least this wide (r4 `lbl()`: `padEnd(9)`). */
const LABEL_COLUMN = 9;
/** A label longer than this is cut, so a long label never squeezes the values off the line. */
const MAX_LABEL_CELLS = 18;
/** The widest label column (r4 `lbl(k, v, 14)`). */
const MAX_COLUMN = 14;

/** The border colour: amber while a card asks or works, green once it is done. */
export type CardTone = "amber" | "green";

type PaintCtx = Pick<ViewRenderCtx, "color" | "theme">;

/** The card's outer width at `width` columns. */
export function cardWidth(width: number): number {
  return Math.max(8, Math.min(CARD_MAX_WIDTH, Math.floor(width)));
}

/** Rows a box adds around its body (the top and bottom borders). */
export const BOX_ROWS = 2;

/**
 * A box with the title in its top border (r4 `boxed()`):
 * `┌─ Title ───┐`, `│ body │`, `└───┘`, the borders in `tone` and the title
 * bold white. A body line wider than the inside is cut (renderers wrap to
 * `width - 4` first). A title too long for the border is cut to end in `…`,
 * always leaving ` ─┐`, so the box is never open at its top right.
 */
export function cardBox(
  title: string,
  body: readonly string[],
  width: number,
  tone: CardTone,
  ctx: PaintCtx
): string[] {
  const outer = cardWidth(width);
  const inner = outer - 4;
  const border = (text: string) => paint(text, tone, ctx);
  const lines = body.length ? body : [""];
  return [
    topBorder(title, outer, tone, ctx),
    ...lines.map((line) => `${border("│")} ${padEndCells(fitPainted(line, inner), inner)} ${border("│")}`),
    border(`└${"─".repeat(outer - 2)}┘`)
  ];
}

function topBorder(title: string, outer: number, tone: CardTone, ctx: PaintCtx): string {
  const border = (text: string) => paint(text, tone, ctx);
  // ┌─ + " title " + at least one rule cell + ┐: the title gets the width less 6.
  const room = outer - 6;
  if (!title || room < 1) {
    return border(`┌${"─".repeat(outer - 2)}┐`);
  }
  // A title too long for the border is cut and ends in "…", so the box always
  // closes (r4's trunc() would drop the corner, leaving the box open: run-r2 MUST 3).
  const shown = displayWidth(title) <= room ? title : `${cutCells(title, room - 1)}…`;
  return `${border("┌─")} ${paint(shown, "b", ctx)} ${border(`${"─".repeat(outer - 5 - displayWidth(shown))}┐`)}`;
}

/** The first `width` cells of plain text (no ellipsis). */
function cutCells(text: string, width: number): string {
  let out = "";
  for (const char of text) {
    if (displayWidth(out + char) > width) break;
    out += char;
  }
  return out;
}

/**
 * Fit a painted line to `width` cells, keeping its colours: a line that is too
 * wide is cut to `width - 1` cells and ends in `…`.
 */
export function fitPainted(line: string, width: number): string {
  const max = Math.max(1, Math.floor(width));
  if (displayWidth(line) <= max) {
    return line;
  }
  if (max === 1) {
    return "…";
  }
  const [first = ""] = wrapAnsi(line, max - 1, { hard: true, trim: false, wordWrap: false }).split("\n");
  return `${first}…`;
}

/** A field row's value: plain text, or already painted parts. */
export interface FieldRow {
  label: string;
  /** The value as painted text (wrapped under its own column). */
  value: string;
}

/**
 * Field rows (r4 `lbl()`): the label dim and padded to one column (at least 9
 * wide, so `status   on → PAUSED` lines up), the value after it and wrapped
 * under itself. Too narrow for two columns: the label, then the value under it.
 */
export function fieldRows(rows: readonly FieldRow[], width: number, ctx: PaintCtx): string[] {
  const shown = rows.filter((row) => row.label || displayWidth(row.value) > 0);
  if (!shown.length) {
    return [];
  }
  const max = Math.max(1, Math.floor(width));
  // r4 pads labels to 9 (14 at most): the column follows the labels that fit
  // it; a longer label sits on its own row, its value under the column.
  const fitting = shown.map((row) => displayWidth(row.label)).filter((cells) => cells + 2 <= MAX_COLUMN);
  const labelCells = Math.min(MAX_LABEL_CELLS, Math.max(0, ...fitting));
  const column = Math.max(LABEL_COLUMN, labelCells + 2);
  const valueWidth = max - column;
  if (valueWidth < 8) {
    return shown.flatMap((row) => [
      ...(row.label ? [paint(fitPainted(row.label, max), "dim", ctx)] : []),
      ...wrapText(row.value, max)
    ]);
  }
  const indent = " ".repeat(column);
  return shown.flatMap((row) => {
    if (displayWidth(row.label) + 2 > column) {
      const values = row.value ? wrapText(row.value, valueWidth) : [];
      return [paint(fitPainted(row.label, max), "dim", ctx), ...values.map((value) => `${indent}${value}`)];
    }
    const label = row.label;
    const values = row.value ? wrapText(row.value, valueWidth) : [""];
    const pad = " ".repeat(Math.max(0, column - displayWidth(label)));
    return values.map((value, index) =>
      index === 0
        ? `${label ? paint(label, "dim", ctx) : ""}${pad}${value}`.trimEnd()
        : `${indent}${value}`
    );
  });
}

/** `before → after` (r4): the old value plain, a dim arrow, the new value bold white. */
export function beforeAfter(before: string, after: string, ctx: PaintCtx): string {
  return `${before} ${paint("→", "dim", ctx)} ${paint(after, "b", ctx)}`;
}

/** A value with no `before`: `set to` dim, the new value bold white. */
export function setTo(after: string, ctx: PaintCtx): string {
  return `${paint("set to", "dim", ctx)} ${paint(after, "b", ctx)}`;
}

/** One key chip: ` k ` on the key grey, or on amber with a bold label for the card's OK key. */
export function keyChip(hint: KeyHint, ok: boolean, ctx: PaintCtx): string {
  const chip = paint(` ${hint.key} `, ok ? "pk" : "key", ctx);
  return hint.label ? `${chip} ${ok ? paint(hint.label, "b", ctx) : hint.label}` : chip;
}

/**
 * Key chips three spaces apart (r4 `K()`/`PK()`), wrapped between chips to
 * `width`. `okKey` names the chip drawn on amber. A chip wider than the line
 * is cut.
 */
export function chipRows(hints: readonly KeyHint[], okKey: string | null, width: number, ctx: PaintCtx): string[] {
  const max = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let row = "";
  for (const hint of hints) {
    const chip = fitPainted(keyChip(hint, okKey !== null && hint.key === okKey, ctx), max);
    if (row && displayWidth(row) + 3 + displayWidth(chip) > max) {
      rows.push(row);
      row = "";
    }
    row = row ? `${row}   ${chip}` : chip;
  }
  if (row) {
    rows.push(row);
  }
  return rows;
}

/** `?  what it does` (r4: every card ends with it), when `?` has something to show. */
export function explainChip(ctx: PaintCtx): string {
  return `${paint(" ? ", "key", ctx)} ${paint("what it does", "dim", ctx)}`;
}

/** A link in words: cyan, underlined, with `↗` (r4 `link()`). */
export function linkWords(words: string, ctx: PaintCtx): string {
  return paint(`${words} ↗`, ["cyan", "u"], ctx);
}

/**
 * The inside of a card (r4 `card()`): the content, then the key chips after a
 * blank row, then `?  what it does` after another, when the card offers `?`.
 */
export function cardBody(
  content: readonly string[],
  chips: readonly string[],
  explain: boolean,
  ctx: PaintCtx
): string[] {
  const lines = [...content];
  if (chips.length) {
    lines.push("", ...chips);
  }
  if (explain) {
    lines.push("", explainChip(ctx));
  }
  return lines;
}

/** Wrap a painted paragraph to `width` and paint each line in one style. */
export function paragraphIn(text: string, width: number, style: Parameters<typeof paint>[1], ctx: PaintCtx): string[] {
  return wrapText(text, width).map((line) => paint(line, style, ctx));
}
