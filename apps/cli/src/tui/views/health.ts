// The health view (terminal-r4 "Health"): is everything connected and fresh,
// with a key to fix what is not.
//
// One line per item: glyph, name, state words (the server's blocker words win
// over the generic ones), and how fresh its data is. A fix prints under its
// item; `(o)` marks the one fix `o` opens, and only when the session can open
// the app. With more than one fix to open, j/k picks which.
//
// `numbers.ts` and this file draw each other's sections (a composite can hold
// a health section and a health body can hold numbers). The two only call
// each other at draw time, never while loading.
import type { KeyHint } from "../keys/keymap.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { asList, asRecord, sectionLines, type MeasureDraw } from "./numbers.js";
import { FootnoteBook, formatAsOf, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, KindRenderer, ViewRenderCtx } from "./types.js";

type ItemTone = "success" | "warning" | "error" | "muted";

const ITEM_STATES: Record<string, { glyph: string; words: string; role: ItemTone }> = {
  ok: { glyph: "✓", words: "OK", role: "success" },
  needs_you: { glyph: "▣", words: "needs you", role: "warning" },
  blocked: { glyph: "⊗", words: "blocked", role: "error" },
  unknown: { glyph: "?", words: "unknown", role: "muted" },
  error: { glyph: "✗", words: "error", role: "error" },
  not_connected: { glyph: "⊘", words: "not connected", role: "warning" }
};

const STEP_GLYPHS: Record<string, { glyph: string; role: ItemTone }> = {
  done: { glyph: "✓", role: "success" },
  needs_you: { glyph: "▣", role: "warning" },
  blocked: { glyph: "⊗", role: "error" },
  unreadable: { glyph: "?", role: "muted" }
};

/** The label of a fix `o` can open (it has an app link), else null. */
function openableFix(fix: unknown): string | null {
  return isRecord(fix) && isRecord(fix.appLink) ? viewText(fix.label) || null : null;
}

export interface HealthBodyDraw {
  lines: string[];
  /** Rows j/k select (0 unless more than one fix can be opened). */
  rowCount: number;
  /** The fix `o` opens, when the session can open the app. */
  openLabel: string | null;
}

/** A health body, drawn. `nested`: inside a composite (no selection, no `o`, no sections). */
export function healthBodyLines(
  body: Record<string, unknown>,
  ctx: ViewRenderCtx,
  draw: MeasureDraw,
  options: { nested?: boolean } = {}
): HealthBodyDraw {
  const nested = options.nested === true;
  const items = asList(body.items).filter(isRecord);
  const openable = items.map((item) => openableFix(item.fix));
  const fixCount = openable.filter(Boolean).length;
  const selectable = !nested && ctx.caps.open && fixCount > 1;
  const selected = Math.max(0, Math.min(items.length - 1, Math.floor(ctx.selected)));
  const target = nested || !ctx.caps.open
    ? -1
    : selectable
      ? (openable[selected] ? selected : -1)
      : openable.findIndex(Boolean);

  const rows = items.map((item) => {
    const state = typeof item.state === "string" && Object.hasOwn(ITEM_STATES, item.state) ? ITEM_STATES[item.state]! : ITEM_STATES.unknown!;
    const account = viewText(item.account);
    const name = [viewText(item.name), account].filter(Boolean).join(" · ");
    const dataThrough = formatAsOf(item.dataThrough, ctx.timeZone);
    const lastSuccess = formatAsOf(item.lastSuccessAt, ctx.timeZone);
    return {
      state,
      name,
      words: viewText(item.blocker) || state.words,
      fresh: dataThrough ? `up to ${dataThrough}` : lastSuccess ? `last OK ${lastSuccess}` : ""
    };
  });

  const marker = selectable ? 2 : 0;
  const nameWidth = Math.min(Math.max(8, Math.floor(ctx.width / 3)), Math.max(0, ...rows.map((row) => displayWidth(row.name))));
  const wordsWidth = Math.max(0, ...rows.map((row) => displayWidth(row.words)));
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const lead = selectable ? (index === selected ? "▸ " : "  ") : "";
    const glyph = paint(row.state.glyph, row.state.role, ctx);
    const one = `${row.state.glyph} ${padEndCells(row.name, nameWidth)}  ${padEndCells(row.words, wordsWidth)}  ${row.fresh}`.trimEnd();
    if (displayWidth(row.name) <= nameWidth && marker + displayWidth(one) <= ctx.width) {
      const words = paint(row.words, row.state.role === "success" ? "text" : row.state.role, ctx);
      const pad = " ".repeat(Math.max(0, wordsWidth - displayWidth(row.words)));
      lines.push(row.fresh
        ? `${lead}${glyph} ${padEndCells(row.name, nameWidth)}  ${words}${pad}  ${paint(row.fresh, "muted", ctx)}`
        : `${lead}${glyph} ${padEndCells(row.name, nameWidth)}  ${words}`);
    } else {
      // Too narrow for one line: the name, then the state and freshness beneath.
      const indent = " ".repeat(marker + 2);
      wrapText(row.name, Math.max(1, ctx.width - marker - 2)).forEach((part, partIndex) =>
        lines.push(partIndex === 0 ? `${lead}${glyph} ${part}` : `${indent}${part}`));
      wrapText([row.words, row.fresh].filter(Boolean).join(" · "), Math.max(1, ctx.width - marker - 2))
        .forEach((part) => lines.push(`${indent}${paint(part, "muted", ctx)}`));
    }
    const fix = asRecord(items[index]!.fix);
    const label = viewText(fix.label);
    if (label) {
      const text = `→ ${label}${index === target ? " (o)" : ""}`;
      wrapText(text, Math.max(1, ctx.width - marker - 2)).forEach((part) =>
        lines.push(`${" ".repeat(marker + 2)}${paint(part, "muted", ctx)}`));
    }
  });

  let openLabel = target >= 0 ? openableFix(items[target]!.fix) : null;
  const extra: string[][] = [];

  const steps = asList(body.steps).filter(isRecord).map((step) => {
    const mark = typeof step.state === "string" && Object.hasOwn(STEP_GLYPHS, step.state) ? STEP_GLYPHS[step.state]! : STEP_GLYPHS.unreadable!;
    return wrapText(viewText(step.label), Math.max(1, ctx.width - 2)).map((part, index) =>
      index === 0 ? `${paint(mark.glyph, mark.role, ctx)} ${part}` : `  ${part}`);
  });
  extra.push(steps.flat());

  const resume = asRecord(body.resume);
  const resumeLabel = isRecord(resume.appLink) ? viewText(resume.appLink.label) : "";
  if (resumeLabel) {
    // `o` opens the resume place only when no item fix holds it and no row is
    // selectable (with j/k, `o` belongs to the selected row, even one with no fix).
    const opens = !nested && ctx.caps.open && !selectable && openLabel === null;
    if (opens) openLabel = resumeLabel;
    extra.push(wrapText(`→ ${resumeLabel}${opens ? " (o)" : ""}`, ctx.width).map((line) => paint(line, "muted", ctx)));
  }

  const lockedBy = viewText(body.lockedBy);
  if (lockedBy) {
    extra.push(wrapText(`Locked by ${lockedBy}`, ctx.width).map((line) => paint(line, "warning", ctx)));
  }

  const scopes = isRecord(body.scopes) ? body.scopes : null;
  if (scopes) {
    const list = (value: unknown) => asList(value).map((entry) => viewText(entry)).filter(Boolean).join(", ");
    const granted = list(scopes.granted);
    const missing = list(scopes.missing);
    extra.push([
      ...(granted ? wrapText(`Granted: ${granted}`, ctx.width).map((line) => paint(line, "muted", ctx)) : []),
      ...(missing ? wrapText(`Missing: ${missing}`, ctx.width).map((line) => paint(line, "warning", ctx)) : []),
      ...(scopes.stale === true ? [paint(wrapText("Permissions are out of date", ctx.width)[0] ?? "", "warning", ctx)] : [])
    ]);
  }

  if (!nested) {
    extra.push(sectionLines(body.sections, ctx, draw));
  }

  for (const block of extra) {
    if (!block.length) continue;
    if (lines.length) lines.push("");
    lines.push(...block);
  }
  return { lines, rowCount: selectable ? items.length : 0, openLabel };
}

export const renderHealth: KindRenderer<"health"> = (view, ctx): KindRender => {
  const draw: MeasureDraw = { notes: new FootnoteBook(), hidden: 0 };
  const drawn = healthBodyLines(asRecord(view.body), ctx, draw);
  const keys: KeyHint[] = drawn.openLabel ? [{ key: "o", label: drawn.openLabel }] : [];
  return {
    detail: drawn.lines,
    footnotes: draw.notes.lines().flatMap((line) => wrapText(line, ctx.width).map((part) => paint(part, "muted", ctx))),
    keys,
    okKey: null,
    rowCount: drawn.rowCount,
    ...(draw.hidden ? { hiddenColumns: draw.hidden } : {})
  };
};
