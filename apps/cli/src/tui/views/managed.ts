// An `operation_managed` approval on a tool-result view (the tool asks twice:
// its first call returns a preview, and the user's yes is a NEW user turn,
// `approval.ask`). It never goes through the confirm queue, so the view itself
// draws it: the approval's title and rows (its summary behind `?`), and the
// key bar offers the named OK key and `n` once the view is engaged.
//
// OK sends `approval.ask` as a new user turn, never a confirm; `n` only
// closes it here (nothing is sent: the tool never acts without the ask). An
// ask that is a command (`/…`) offers no OK key at all.
//
// It always says where the OK is given (W3-chg-xpub): in the app, in the
// view's own `finishInApp` words, when it finishes there; else here, with the
// key that sends the ask (`OK it here: tab, then p (Publish)`; `tab` only
// while the view is not engaged). In scrollback, or with the keys on another
// view, no key works, so none is named.
import type { AnswerViewV1 } from "@infinite-os/types";

import { okKeyFor } from "../keys/keymap.js";
import { labelValueLines } from "./change.js";
import { appOpenTarget } from "./open-target.js";
import { isRecord, linkLine, paint, turnAsk, viewText, wrapText } from "./primitives.js";
import type { ViewRenderCtx } from "./types.js";

export interface ManagedApproval {
  /** The named OK key (`okKeyFor(confirmLabel)`). */
  key: string;
  label: string;
  /** The new user turn OK sends. */
  ask: string;
  title: string;
  summary: string;
  effect: string;
  rows: { label: string; value: string }[];
  /** The app's words when the OK is given there (`approval.finishInApp`), and whether `o` opens that place. */
  finishInApp: { words: string; opens: boolean } | null;
}

/** Two app places are the same place (and the same params). */
function samePlace(a: unknown, b: unknown): boolean {
  const left = appOpenTarget(a);
  const right = appOpenTarget(b);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

const LIVE_STATES = new Set(["needs_yes", "needs_answer"]);

/** The view's operation_managed approval while it waits for a yes, else null. */
export function managedApproval(view: AnswerViewV1): ManagedApproval | null {
  const approval = isRecord(view.approval) ? view.approval : null;
  if (!approval || approval.kind !== "operation_managed" || !LIVE_STATES.has(view.state)) {
    return null;
  }
  const ask = turnAsk(approval.ask);
  if (!ask) {
    return null;
  }
  const label = viewText(approval.confirmLabel, "Confirm");
  const rows: unknown[] = Array.isArray(approval.rows) ? approval.rows : [];
  const finish = isRecord(approval.finishInApp) ? approval.finishInApp : null;
  const finishWords = finish ? viewText(finish.words) : "";
  // `o` opens the state's fix place, else the view's own (the shell's `openFor`).
  const fix = isRecord(view.stateReason) && isRecord(view.stateReason.fix) ? view.stateReason.fix : null;
  const opened = fix && isRecord(fix.appLink) ? fix.appLink : view.appLink;
  return {
    key: okKeyFor(label),
    label,
    ask,
    title: viewText(approval.title),
    summary: viewText(approval.summary),
    effect: viewText(approval.effect),
    rows: rows.filter(isRecord).map((row) => ({ label: viewText(row.label), value: viewText(row.value) })),
    finishInApp: finishWords ? { words: finishWords, opens: samePlace(finish?.appLink, opened) } : null
  };
}

/** Where the OK is given: the app's words, or here with the key that sends the ask; nothing where no key works. */
function whereLines(approval: ManagedApproval, ctx: ViewRenderCtx): string[] {
  if (approval.finishInApp) {
    const { words, opens } = approval.finishInApp;
    return ctx.caps.open && opens && !ctx.scrollback
      ? [linkLine(words, ctx, "(o)")]
      : wrapText(words, ctx.width).map((line) => paint(line, "muted", ctx));
  }
  if (ctx.scrollback || ctx.keysElsewhere) return [];
  const keys = ctx.engaged ? approval.key : `tab, then ${approval.key}`;
  return wrapText(`OK it here: ${keys} (${approval.label})`, ctx.width).map((line) => paint(line, "muted", ctx));
}

/** The approval's lines under the view's body: its title, rows and effect. */
export function managedApprovalLines(approval: ManagedApproval, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [""];
  if (approval.title) {
    lines.push(...wrapText(approval.title, ctx.width).map((line) => paint(line, "warning", ctx, { bold: true })));
  }
  lines.push(...labelValueLines(approval.rows, ctx));
  if (approval.effect) {
    lines.push(...wrapText(approval.effect, ctx.width).map((line) => paint(line, "warning", ctx)));
  }
  const where = whereLines(approval, ctx);
  if (where.length) lines.push(...(lines.length > 1 ? [""] : []), ...where);
  return lines.length > 1 ? lines : [];
}

/** The approval's summary, once `?` opened the explanation. */
export function managedSummaryLines(approval: ManagedApproval | null, ctx: ViewRenderCtx): string[] {
  return approval?.summary && ctx.explainOpen
    ? wrapText(approval.summary, ctx.width).map((line) => paint(line, "muted", ctx))
    : [];
}
