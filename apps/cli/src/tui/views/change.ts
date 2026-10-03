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
//
// The target's parents (contract revision 3, `target.path`: "Sample campaign ›
// Sample ad set") print as ONE dim line under the target in every state:
// first in a card (its title names the target), under the bold target line,
// or, when nothing is drawn of the object, first under the head and source.
// The target's picture (`target.creativeRef`) is Cmd+L's: never drawn here.
import type { AnswerViewEnvelopeV1, AnswerViewV1 } from "@infinite-os/types";

import { beforeAfter, cardBody, cardBox, cardWidth, chipRows, fieldRows, paragraphIn, setTo, type CardTone, type FieldRow } from "./card.js";
import { displayWidth } from "../lib/display-width.js";
import { afterwordLines, isSettledWithoutRunning } from "./outcome.js";
import { cellText, cutAtWord, FootnoteBook, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** The words a done change's card adds after its title: who proposed it and who said yes. */
export const APPROVED_SUFFIX = "Agent proposed · You approved";

/**
 * The app's provenance in r4's short words: `Proposed by the agent · approved
 * by You` reads `Agent proposed · You approved`. Words in any other shape stay
 * the app's own.
 */
export function shortProvenance(words: string): string {
  const match = /^proposed by (?:the )?(.+?) · approved by (.+)$/iu.exec(words);
  if (!match) return words;
  const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return `${capital(match[1]!)} proposed · ${capital(match[2]!)} approved`;
}

/** States a write card is still open in (asking, running, or not sure yet). */
const OPEN_CARD_STATES = new Set(["needs_yes", "needs_answer", "applying", "outcome_unknown", "partial"]);

export function renderChange(view: AnswerViewEnvelopeV1<"change">, ctx: ViewRenderCtx): KindRender {
  const notes = new FootnoteBook();
  const detail = changeViewLines(view, ctx, notes);
  // A settled change draws no object: its path leads the details, under the head.
  const path = isSettledWithoutRunning(view) ? targetPathLine(view.body, ctx.width, ctx) : null;
  // A card ends with its own `? what it does` (r4 `card()`), the view's explanation included.
  return {
    detail, footnotes: notes.lines(), keys: [], okKey: null, rowCount: 0,
    ...(path ? { lead: [path] } : {}),
    ...(drawnAsCard(view) ? { offersExplain: true } : {})
  };
}

/** The separator between a target's parents (cmdl-r2 `pauseObj`). */
const PATH_SEPARATOR = " › ";

/**
 * A change target's parents as one dim line (`Sample campaign › Sample ad
 * set`), cut to `width` with `…` at a word's or a name part's end (never a
 * name broken mid-word where a part ends near); null when the target has no path. Read
 * defensively and scrubbed, like every body field. Never a picture.
 */
export function targetPathLine(body: unknown, width: number, ctx: Pick<ViewRenderCtx, "color" | "theme">): string | null {
  const target = isRecord(body) && isRecord(body.target) ? body.target : null;
  const path: unknown[] = Array.isArray(target?.path) ? target.path : [];
  const parts = path.map((part) => viewText(part)).filter(Boolean);
  return parts.length ? paint(fitPath(parts, Math.max(1, Math.floor(width))), "dim", ctx) : null;
}

/** An outer part is never cut shorter than this (its first letters and `…`), or they all fold into one `…`. */
const MIN_OUTER_PART = 6;

/**
 * A path cut to `width` from its OUTER parts first (TJ-7): the nearest parent
 * (the last part, the ad set) is what names the target's place, so it keeps
 * its leading words. The outer parts share what is left fairly (a short one
 * gives its spare cells to the others), each cut with `…`; when even that
 * does not fit, they fold into one `…` and the nearest parent is cut at its
 * end.
 */
function fitPath(parts: readonly string[], width: number): string {
  const whole = parts.join(PATH_SEPARATOR);
  if (displayWidth(whole) <= width || parts.length === 1) {
    return cutAtWord(whole, width);
  }
  const nearest = parts[parts.length - 1]!;
  const outer = parts.slice(0, -1);
  const budget = width - displayWidth(nearest) - PATH_SEPARATOR.length * outer.length;
  if (budget >= MIN_OUTER_PART * outer.length) {
    return [...fairCut(outer, budget), nearest].join(PATH_SEPARATOR);
  }
  return cutAtWord(`…${PATH_SEPARATOR}${nearest}`, width);
}

/** Cut `parts` to share `budget` cells: an equal share each, a short part's spare going to the rest. */
function fairCut(parts: readonly string[], budget: number): string[] {
  const shares = parts.map(() => 0);
  let left = budget;
  let open = parts.map((_part, index) => index);
  while (open.length && left >= open.length) {
    const share = Math.floor(left / open.length);
    const still: number[] = [];
    for (const index of open) {
      const give = Math.min(displayWidth(parts[index]!) - shares[index]!, share);
      shares[index] = shares[index]! + give;
      left -= give;
      if (displayWidth(parts[index]!) > shares[index]!) still.push(index);
    }
    // Every open part took its whole share: nothing is spare to hand on.
    if (still.length === open.length) break;
    open = still;
  }
  // A short share still ends at a word where one ends at all (`Sample …`, never `Sample camp…`).
  return parts.map((part, index) => cutAtWord(part, Math.max(1, shares[index]!), 1 / 3));
}

/** Whether the change is drawn as a card: done, or still open with a card approval (or running its yes). */
function drawnAsCard(view: AnswerViewV1): boolean {
  if (isSettledWithoutRunning(view)) return false;
  const approval = isRecord(view.approval) && view.approval.kind === "card" ? view.approval : null;
  return view.state === "done" || (OPEN_CARD_STATES.has(view.state) && (approval !== null || view.state === "applying"));
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
    // Who proposed and who said yes is said once, in the card's title, in r4's
    // words: the app's own provenance when its title already ends with it
    // (`… · Proposed by the agent · approved by You` reads `… · Agent proposed
    // · You approved`), which is then not repeated in the card. Any other
    // provenance line is a fact of the card.
    const provenance = receipt ? viewText(receipt.provenanceLine) : "";
    const rawTitle = viewText(approval?.doneTitle) || viewText(view.title);
    const titled = provenance !== "" && rawTitle.endsWith(` · ${provenance}`);
    const base = titled ? rawTitle.slice(0, -(provenance.length + 3)) : rawTitle;
    const title = receipt ? [base, titled ? shortProvenance(provenance) : APPROVED_SUFFIX].filter(Boolean).join(" · ") : rawTitle;
    const facts = receipt ? [viewText(receipt.sentence), titled ? "" : provenance].filter(Boolean) : [];
    return changeCard(view, title, "green", [
      ...pathRows(body, ctx),
      ...cardRows(body, approval, ctx, notes),
      ...facts.flatMap((fact) => paragraphIn(fact, cardInner(ctx), "dim", ctx))
    ], ctx);
  }
  if (OPEN_CARD_STATES.has(view.state) && (approval || view.state === "applying")) {
    const title = viewText(approval?.title) || viewText(view.title);
    // r4 "Working": a stopwatch since the yes was sent (`appliedAt`, set by
    // the session when it sends it: `applying` is renderer-local), and the
    // app says when it is still running after 20 s. Then r4's empty key row.
    const working = view.state === "applying"
      ? ["", `${paint(`◑ Working…${stopwatch(view)}`, "cyan", ctx)}  ${paint("· after 20 s it says it's still running", "dim", ctx)}`, "", ""]
      : [];
    return changeCard(view, title, "amber", [...pathRows(body, ctx), ...cardRows(body, approval, ctx, notes), ...working], ctx);
  }
  return changeLines(view.body, ctx, notes);
}

/** ` 4s`: whole seconds since the yes was sent, when the session stamped it; "" otherwise. */
function stopwatch(view: AnswerViewV1): string {
  const sent = (view as { appliedAt?: unknown }).appliedAt;
  if (typeof sent !== "number" || !Number.isFinite(sent)) return "";
  return ` ${Math.max(0, Math.floor((Date.now() - sent) / 1000))}s`;
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
  return cardBox(title, cardBody([...content, ...opened], chips, own !== "" || summary !== "", ctx, ctx.explainOpen), ctx.width, tone, ctx);
}

/**
 * The approval's summary a change card offers behind `?`, when the view is
 * drawn as a card (done, or still open with a card approval); else "".
 */
export function changeCardSummary(view: AnswerViewV1): string {
  if (view.kind !== "change" || !drawnAsCard(view)) {
    return "";
  }
  const approval = isRecord(view.approval) && view.approval.kind === "card" ? view.approval : null;
  return viewText(approval?.summary);
}

/** The target's path as a card's first row (its title names the target), or nothing. */
function pathRows(body: Record<string, unknown>, ctx: ViewRenderCtx): string[] {
  const line = targetPathLine(body, cardInner(ctx), ctx);
  return line ? [line] : [];
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

/**
 * The change body as lines (no card): the target and its path, its rows, its
 * effect, warnings. `path: false` when the caller already drew the path.
 */
export function changeLines(body: unknown, ctx: ViewRenderCtx, notes: FootnoteBook, options: { path?: boolean } = {}): string[] {
  const record = isRecord(body) ? body : {};
  const lines: string[] = [];
  const target = isRecord(record.target) ? record.target : {};
  const label = viewText(target.label);
  if (label) {
    lines.push(...paragraphIn(label, ctx.width, "b", ctx));
  }
  const path = options.path === false ? null : targetPathLine(record, ctx.width, ctx);
  if (path) {
    lines.push(path);
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
    // A reason shown as words is the row's whole value (`kept as it is`), never `set to kept as it is`.
    const words = isRecord(row.reason) && row.reason.show === "words";
    return words ? reason : `${paint("set to", "dim", ctx)} ${reason}`;
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
