// The health view (terminal-r4 "Health"): is everything connected and fresh,
// with a key to fix what is not.
//
// One line per item: glyph (in the item's tone), name, state words (the
// server's blocker words win over the generic ones; amber or red when not OK),
// and how fresh its data is (dim). The fixes follow the rows, each `Fix it:`
// and a link; `(o) · <place>` marks the one fix `o` opens, and only when the
// session can open the app. With more than one fix to open, j/k picks which.
//
// `numbers.ts` and this file draw each other's sections (a composite can hold
// a health section and a health body can hold numbers). The two only call
// each other at draw time, never while loading.
import type { KeyHint } from "../keys/keymap.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { asList, asRecord, sectionLines, type MeasureDraw } from "./numbers.js";
import { FootnoteBook, formatAsOf, isRecord, linkLine, openHint, paint, viewText, wrapText } from "./primitives.js";
import { marker as selectionMarker } from "./things.js";
import { appOpenTarget, type AppOpenTarget } from "./open-target.js";
import type { KindRender, KindRenderer, ViewRenderCtx } from "./types.js";

type ItemTone = "success" | "warning" | "error" | "muted";

const ITEM_STATES: Record<string, { glyph: string; words: string; role: ItemTone }> = {
  ok: { glyph: "✓", words: "connected", role: "success" },
  // r4 view-10: a source that needs the user (an expired sign-in) is the amber ⊘ of a
  // broken connection; ▣ is the needs-you of a card waiting for an OK, never a source.
  needs_you: { glyph: "⊘", words: "needs you", role: "warning" },
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
  /** That fix's place (T12: what `o` sends to the app), null when `o` opens nothing here. */
  openLink: AppOpenTarget | null;
}

/** A health body, drawn. `nested`: inside a composite (no selection, no `o`, no sections). */
/** r4 freshness: `12 min ago`, `3 h ago`, `2 days ago` since a time; null for a date or nothing usable. */
function agoWords(value: unknown): string | null {
  if (typeof value !== "string" || /^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

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
    const lastSuccess = agoWords(item.lastSuccessAt) ?? formatAsOf(item.lastSuccessAt, ctx.timeZone);
    return {
      state,
      name,
      words: viewText(item.blocker) || state.words,
      fresh: dataThrough ? `up to ${dataThrough}` : lastSuccess ? lastSuccess : ""
    };
  });

  const marker = selectable ? 2 : 0;
  const nameWidth = Math.min(Math.max(8, Math.floor(ctx.width / 3)), Math.max(0, ...rows.map((row) => displayWidth(row.name))));
  const wordsWidth = Math.max(0, ...rows.map((row) => displayWidth(row.words)));
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const lead = selectable ? selectionMarker(index === selected, ctx) : "";
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
  });

  let openLabel = target >= 0 ? openableFix(items[target]!.fix) : null;
  let openLink = target >= 0 && isRecord(items[target]!.fix) ? appOpenTarget((items[target]!.fix as Record<string, unknown>).appLink) : null;
  const extra: string[][] = [];

  // r4: the fixes after the rows, each `Fix it: <link ↗>`, and `(o) · <place>`
  // on the one `o` opens. A fix the session cannot open prints plainly.
  extra.push(items.flatMap((item, index) => {
    const fix = asRecord(item.fix);
    const label = viewText(fix.label);
    if (!label) return [];
    const lead = "Fix it: ";
    if (ctx.caps.open && isRecord(fix.appLink)) {
      const inner = { ...ctx, width: Math.max(1, ctx.width - lead.length) };
      return [`${paint(lead, "muted", ctx)}${linkLine(label, inner, index === target ? openHint(fix.appLink) : "")}`];
    }
    return wrapText(`${lead}${label}`, ctx.width).map((line) => paint(line, "muted", ctx));
  }));

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
    if (opens) {
      openLabel = resumeLabel;
      openLink = appOpenTarget(resume.appLink);
    }
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
  return { lines, rowCount: selectable ? items.length : 0, openLabel, openLink: openLabel ? openLink : null };
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
    // `o` opens exactly the fix marked `(o)`; a health view that marks none opens nothing (T12).
    ...(ctx.caps.open ? { openLink: drawn.openLink, ...(drawn.openLabel ? { openLabel: drawn.openLabel } : {}) } : {}),
    rowCount: drawn.rowCount,
    ...(draw.hidden ? { hiddenColumns: draw.hidden } : {})
  };
};
