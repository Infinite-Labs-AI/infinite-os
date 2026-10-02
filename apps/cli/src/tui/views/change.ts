// The change view (terminal-r4 "Change"): one thing, what it was and what it
// becomes. `before → after` (the new value bold); a row with no `before` reads
// `set to <after>`; a null `after` prints its reason (in place for
// `show: "words"`, else a dash and a footnote), never a made-up value.
// Warnings print in amber, and a stale "before" (ours vs live) says so. Draws
// only what the view says.
//
// By state (r4 "Pause an ad"): a change that is done and carries the app's
// receipt is a GREEN card titled `<done title> · Agent proposed · You
// approved`, its rows, then the receipt in dim; a card still waiting or
// running is an AMBER card titled with the approval's words; one that ended
// without running (dismissed, expired, changed elsewhere, blocked) draws no
// rows, only what the shell says and the afterword (`outcome.ts`).
import type { AnswerViewEnvelopeV1, AnswerViewV1 } from "@infinite-os/types";

import { beforeAfter, cardBody, cardBox, cardWidth, chipRows, fieldRows, paragraphIn, setTo, type CardTone, type FieldRow } from "./card.js";
import { afterwordLines, isSettledWithoutRunning } from "./outcome.js";
import { cellText, FootnoteBook, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** The words a done change's card adds after its title: who proposed it and who said yes. */
export const APPROVED_SUFFIX = "Agent proposed · You approved";

/** States a write card is still open in (asking, running, or not sure yet). */
const OPEN_CARD_STATES = new Set(["needs_yes", "needs_answer", "applying", "outcome_unknown", "partial"]);

export function renderChange(view: AnswerViewEnvelopeV1<"change">, ctx: ViewRenderCtx): KindRender {
  const notes = new FootnoteBook();
  const detail = changeViewLines(view, ctx, notes);
  return { detail, footnotes: notes.lines(), keys: [], okKey: null, rowCount: 0 };
}

function changeViewLines(view: AnswerViewV1, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  if (isSettledWithoutRunning(view)) {
    return afterwordLines(view, ctx);
  }
  const body = isRecord(view.body) ? view.body : {};
  // An operation_managed approval is drawn by the shell under the body (managed.ts), never as a card here.
  const approval = isRecord(view.approval) && view.approval.kind === "card" ? view.approval : null;
  const receipt = isRecord(view.receipt) ? view.receipt : null;
  if (view.state === "done") {
    const doneTitle = viewText(approval?.doneTitle) || viewText(view.title);
    const title = receipt ? [doneTitle, APPROVED_SUFFIX].filter(Boolean).join(" · ") : doneTitle;
    const facts = receipt ? [viewText(receipt.sentence), viewText(receipt.provenanceLine)].filter(Boolean) : [];
    return changeCard(view, title, "green", [
      ...cardRows(body, approval, ctx, notes),
      ...facts.flatMap((fact) => paragraphIn(fact, cardInner(ctx), "dim", ctx))
    ], ctx);
  }
  if (OPEN_CARD_STATES.has(view.state) && (approval || view.state === "applying")) {
    const title = viewText(approval?.title) || viewText(view.title);
    // r4's hint is static (no clock): the app says when it is still running after 20 s.
    const working = view.state === "applying"
      ? ["", `${paint("◑ Working…", "cyan", ctx)}  ${paint("· after 20 s it says it's still running", "dim", ctx)}`]
      : [];
    return changeCard(view, title, "amber", [...cardRows(body, approval, ctx, notes), ...working], ctx);
  }
  return changeLines(view.body, ctx, notes);
}

/** A change drawn as a card (r4 `card()`): its rows, `o` when it opens, `?` when it explains. */
function changeCard(view: AnswerViewV1, title: string, tone: CardTone, content: string[], ctx: ViewRenderCtx): string[] {
  const inner = cardInner(ctx);
  const link = isRecord(view.appLink) ? view.appLink : null;
  const chips = ctx.caps.open && link
    ? chipRows([{ key: "o", label: viewText(link.label, "open in the app") }], null, inner, ctx)
    : [];
  // A view's own explain is printed by the shell under the view; the approval's
  // summary (the `?` text Cmd+L shows) has no other place, so it opens inside.
  const own = viewText(view.explain);
  const summary = own ? "" : changeCardSummary(view);
  const opened = ctx.explainOpen && summary ? ["", ...wrapText(summary, inner)] : [];
  return cardBox(title, cardBody([...content, ...opened], chips, own !== "" || summary !== "", ctx), ctx.width, tone, ctx);
}

/**
 * The approval's summary a change card offers behind `?`, when the view is
 * drawn as a card (done, or still open with a card approval); else "".
 */
export function changeCardSummary(view: AnswerViewV1): string {
  if (view.kind !== "change" || isSettledWithoutRunning(view)) {
    return "";
  }
  const approval = isRecord(view.approval) && view.approval.kind === "card" ? view.approval : null;
  const drawnAsCard = view.state === "done" || (OPEN_CARD_STATES.has(view.state) && (approval !== null || view.state === "applying"));
  return drawnAsCard ? viewText(approval?.summary) : "";
}

/** The width inside a card drawn at `ctx.width`. */
function cardInner(ctx: ViewRenderCtx): number {
  return cardWidth(ctx.width) - 4;
}

/**
 * A card's rows: the change's own rows (`before → after`), or, for a write
 * the app describes only in its own words (a generic change), those words.
 */
function cardRows(
  body: Record<string, unknown>,
  approval: Record<string, unknown> | null,
  ctx: ViewRenderCtx,
  notes: FootnoteBook
): string[] {
  const inner: ViewRenderCtx = { ...ctx, width: cardInner(ctx) };
  const target = isRecord(body.target) ? body.target : {};
  const rows = changeRows(body, inner, notes);
  if (target.kind === "pending_write" || !rows.length) {
    const approvalRows: unknown[] = Array.isArray(approval?.rows) ? approval.rows : [];
    const words = approvalRows.filter(isRecord).map((row) => ({ label: viewText(row.label), value: viewText(row.value) }));
    if (words.length) {
      return fieldRows(words, inner.width, inner);
    }
    if (target.kind === "pending_write") {
      // The generic body's rows ARE the app's words: plain values, no "set to".
      return fieldRows(plainRows(body), inner.width, inner);
    }
  }
  return [...fieldRows(rows, inner.width, inner), ...changeNotes(body, inner)];
}

function plainRows(body: Record<string, unknown>): FieldRow[] {
  const rows: unknown[] = Array.isArray(body.rows) ? body.rows : [];
  return rows.filter(isRecord).map((row) => ({ label: viewText(row.label), value: viewText(row.after) }));
}

/** The change body as lines (no card): the target, its rows, its effect, warnings. */
export function changeLines(body: unknown, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  const record = isRecord(body) ? body : {};
  const lines: string[] = [];
  const target = isRecord(record.target) ? record.target : {};
  const label = viewText(target.label);
  if (label) {
    lines.push(...paragraphIn(label, ctx.width, "b", ctx));
  }
  lines.push(...fieldRows(changeRows(record, ctx, notes), ctx.width, ctx));
  const effect = viewText(record.effect);
  if (effect) {
    lines.push(...paragraphIn(effect, ctx.width, "dim", ctx));
  }
  lines.push(...changeNotes(record, ctx));
  return lines;
}

/** The change's rows as field rows: `before → after`, `set to after`, or a null's reason. */
export function changeRows(body: Record<string, unknown>, ctx: ViewRenderCtx, notes: FootnoteBook): FieldRow[] {
  const rows: unknown[] = Array.isArray(body.rows) ? body.rows : [];
  return rows.filter(isRecord).map((row) => ({ label: viewText(row.label), value: changeValue(row, notes, ctx) }));
}

/** A stale "before" (ours vs live) and the warnings, in amber. */
export function changeNotes(body: Record<string, unknown>, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [];
  const stale = isRecord(body.staleBefore) ? body.staleBefore : null;
  if (stale) {
    const words = `! ${viewText(stale.label)}: ours says ${viewText(stale.ours, "—")}, live says ${viewText(stale.live, "—")}`;
    lines.push(...paragraphIn(words, ctx.width, "amber", ctx));
  }
  lines.push(...warningLines(body.warnings, ctx));
  return lines;
}

function changeValue(row: Record<string, unknown>, notes: FootnoteBook, ctx: ViewRenderCtx): string {
  if (typeof row.after === "string") {
    const after = viewText(row.after);
    if (!("before" in row) || row.before === undefined) {
      return setTo(after, ctx);
    }
    return beforeAfter(typeof row.before === "string" ? viewText(row.before) : "—", after, ctx);
  }
  // A null after prints its reason, never a made-up value.
  const reason = cellText({ text: null, ...(isRecord(row.reason) ? { reason: row.reason as never } : {}) }, "text", null, notes);
  if (!("before" in row) || row.before === undefined) {
    return `${paint("set to", "dim", ctx)} ${reason}`;
  }
  return `${typeof row.before === "string" ? viewText(row.before) : "—"} ${paint("→", "dim", ctx)} ${reason}`;
}

/** Warnings, verbatim (scrubbed), in amber. */
export function warningLines(warnings: unknown, ctx: ViewRenderCtx): string[] {
  const list: unknown[] = Array.isArray(warnings) ? warnings : [];
  return list.flatMap((warning) => {
    const words = viewText(warning);
    return words ? paragraphIn(`! ${words}`, ctx.width, "amber", ctx) : [];
  });
}

/**
 * `label  value` rows (r4 `lbl()`): the labels dim in one column (at least 9
 * wide, capped), the values plain and wrapped under their own column.
 */
export function labelValueLines(rows: readonly { label: string; value: string }[], ctx: ViewRenderCtx): string[] {
  return fieldRows(rows, ctx.width, ctx);
}
