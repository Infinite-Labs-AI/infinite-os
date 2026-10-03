// What a write view says when it is not sure it happened. `outcome_unknown`
// shows the view's reconcile step (check first), never "try again": only a
// `retry: "safe_resend"` card may offer its OK key again (the app dedupes), and
// only a failed, not-sent `retry: "retryable"` card offers `r` (certain nothing
// ran; the app's only retryable shape, since `outcome_unknown` + `retryable`
// contradicts itself and the app's view cleaner rejects it). The words of the
// step are the app's (`reconcile.label`); the arrow is chrome.
//
// It also says what a settled write left behind (terminal-r4 receipts): a
// view that ended without running anything draws no object, only its
// sentence and one dim afterword ("Nothing ran.", "Sent to the app",
// "Nothing was proposed.").
import type { AnswerViewV1 } from "@infinite-os/types";

import { isRecord, paint, toneRole, viewText, wrapText } from "./primitives.js";
import { stateHeadFor } from "./states.js";
import type { ViewRenderCtx } from "./types.js";

/** The reconcile step as a line (`→ Check Ads for the result`), when the view carries one. */
export function reconcileLines(view: AnswerViewV1, ctx: ViewRenderCtx): string[] {
  const reconcile = isRecord(view.reconcile) ? view.reconcile : null;
  const label = viewText(reconcile?.label);
  return label ? wrapText(`→ ${label}`, ctx.width).map((line) => paint(line, "amber", ctx)) : [];
}

/** States where the write ended and nothing ran: no object is drawn, only what was said. */
const SETTLED_WITHOUT_RUNNING = new Set([
  "no_change", "expired", "cancelled", "blocked", "hit_limit", "cmdl_only", "nothing_found", "not_connected"
]);

/**
 * Whether a write view ended without running anything: dismissed, expired,
 * blocked, out of budget, already so, or failed with nothing sent.
 * Its object (the change's rows, the tree, the images) is not drawn: there is
 * nothing to show that happened.
 */
export function isSettledWithoutRunning(view: AnswerViewV1): boolean {
  if (SETTLED_WITHOUT_RUNNING.has(view.state)) {
    return true;
  }
  // A failed write that may have left (no `not_sent`) still shows what it knows (a launch's per-item results).
  return view.state === "failed" && view.outcome === "not_sent";
}

/**
 * The lines a settled write prints under its sentence (r4 receipts):
 * - the app's receipt sentence with the state's glyph, in its tone, when the
 *   view carries no state reason (the shell prints a reason itself);
 * - under a dismissal, `Sending to the app…` while the no is on its way, then
 *   `Sent to the app` (r4's last frame, run-3 N22), with the receipt's
 *   provenance line, if any, as its own dim line under it;
 * - `Nothing ran.` when nothing was sent and there is no fix to point at;
 * - `Nothing was proposed.` when a limit stopped it before any card.
 */
export function afterwordLines(view: AnswerViewV1, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [];
  const reason = isRecord(view.stateReason) ? view.stateReason : null;
  const receipt = isRecord(view.receipt) ? view.receipt : null;
  const sentence = viewText(receipt?.sentence);
  if (!reason && sentence) {
    const head = stateHeadFor(view);
    lines.push(...wrapText(`${head.glyph} ${sentence}`, ctx.width).map((line) => paint(line, toneRole(head.tone), ctx)));
  }
  if (view.state === "cancelled" && (receipt || reason?.code === "dismissed")) {
    lines.push(paint(dismissalAfterword(view, ctx), "dim", ctx));
    // A provenance line is a fact of the receipt (who proposed, a side effect),
    // never the delivery word: its own dim line under it, as change.ts draws it.
    const provenance = viewText(receipt?.provenanceLine);
    if (provenance) lines.push(...wrapText(provenance, ctx.width).map((line) => paint(line, "dim", ctx)));
  } else if (view.outcome === "not_sent" && !(reason && isRecord(reason.fix))) {
    lines.push(paint("Nothing ran.", "dim", ctx));
  } else if (view.state === "hit_limit" && view.outcome === undefined && !receipt) {
    lines.push(paint("Nothing was proposed.", "dim", ctx));
  }
  return lines;
}

/**
 * What a dismissal's last line says. The session marks the dismissed card it
 * draws at `n` as `sending` (renderer-local) until the app answers; then the
 * app's receipt (or the same card, unmarked) says it was sent. Scrollback is
 * printed once and follows no answer: the no was sent.
 */
function dismissalAfterword(view: AnswerViewV1, ctx: ViewRenderCtx): string {
  if ((view as { sending?: unknown }).sending === true && ctx.scrollback !== true) return "Sending to the app…";
  return "Sent to the app";
}

/** The reconcile ask (a NEW user turn), when the view carries one. */
export function reconcileAsk(view: AnswerViewV1): string | null {
  const reconcile = isRecord(view.reconcile) ? view.reconcile : null;
  return viewText(reconcile?.ask) || null;
}

/** OK again is offered only when the app dedupes a resend. */
export function offersResend(view: AnswerViewV1): boolean {
  return view.state === "outcome_unknown" && view.retry === "safe_resend";
}

/**
 * `r` is offered only when nothing ran for certain: `failed` + `retryable`
 * (the app puts that card's handle back to pending, so it is live again).
 */
export function offersRetry(view: AnswerViewV1): boolean {
  return view.state === "failed" && view.retry === "retryable";
}
