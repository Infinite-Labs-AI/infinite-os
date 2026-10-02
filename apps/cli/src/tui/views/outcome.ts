// What a write view says when it is not sure it happened. `outcome_unknown`
// shows the view's reconcile step (check first), never "try again": only a
// `retry: "safe_resend"` card may offer its OK key again (the app dedupes), and
// only a failed, not-sent `retry: "retryable"` card offers `r` (certain nothing
// ran; the app's only retryable shape, since `outcome_unknown` + `retryable`
// contradicts itself and the app's view cleaner rejects it). The words of the
// step are the app's (`reconcile.label`); the arrow is chrome.
import type { AnswerViewV1 } from "@infinite-os/types";

import { isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { ViewRenderCtx } from "./types.js";

/** The reconcile step as a line (`→ Check Ads for the result`), when the view carries one. */
export function reconcileLines(view: AnswerViewV1, ctx: ViewRenderCtx): string[] {
  const reconcile = isRecord(view.reconcile) ? view.reconcile : null;
  const label = viewText(reconcile?.label);
  return label ? wrapText(`→ ${label}`, ctx.width).map((line) => paint(line, "warning", ctx)) : [];
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
