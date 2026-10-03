// The write card the session draws under the transcript (terminal-r4 "Needs
// your OK"). Purely presentational: every key stays with the single
// `useInput` owner in `interactive-session.tsx`.
//
// - A card the desktop sent as an approval view is drawn by
//   `views/approval.ts`; its lines arrive scrubbed, coloured and laid out.
// - A desktop that sends no view gets the SAME r4 card: an amber box with the
//   app's summary in its top border (never the tool's name: a summary made
//   from it gives way to "Approve this write?"), the already-redacted
//   `confirmationDetails` as field rows, the key chips inside (`y Confirm`
//   on amber, `n dismiss`) and `? what it does` last; `?` opens the summary
//   inside the card.
//
// Every line goes through the ANSI bridge (`AnsiLine`), so the chips'
// backgrounds and the bold labels reach the screen.
//
// Once answered, a card whose app sent a settled receipt view leaves that view
// on its turn (`receiptViewFrame`), where the views draw it as r4 does: a done
// change as the green card, a dismissal as its dim sentence and "Sent to the
// app". Anything else keeps the receipt lines.
import type { ToolViewFrameV1 } from "@infinite-os/types";
import React from "react";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { terminalText, type InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { confirmErrorLines, confirmResultLines, type ConfirmDecision, type ConfirmLine } from "../../desktop/confirm-result-lines.js";
import { confirmCardKeys, keyBarHints } from "../keys/keymap.js";
import { colorEnabled, DEFAULT_THEME, type Theme } from "../theme.js";
import type { ApprovalRender } from "../views/approval.js";
import { cardBody, cardBox, cardWidth, chipRows, fieldRows } from "../views/card.js";
import { wrapText } from "../views/primitives.js";
import { Box } from "./renderer.js";
import { AnsiLine } from "./transcript-app.js";

/** The card's title when the app sent no summary of its own. */
const UNNAMED_WRITE = "Approve this write?";
/** No view, so nothing to open, watch or retry. */
const NO_CAPS = { open: false, watch: false, retry: false } as const;

/** The kinds whose views draw their own receipt (views/change, launch, images, job). */
const RECEIPT_KINDS: ReadonlySet<string> = new Set(["change", "launch", "images", "job"]);
/** Receipts that are final: nothing to check, retry or bring back. */
const SETTLED_STATES: ReadonlySet<string> = new Set(["done", "cancelled", "expired", "no_change", "blocked", "hit_limit"]);

/**
 * The receipt a resolved card leaves on its turn: the confirm's (or its
 * error's) receipt view, as a turn view, when it is settled (done, dismissed,
 * expired, already so, blocked, out of budget, or failed with nothing sent and
 * nothing to retry), its kind draws receipts, and it has words to say. Null
 * otherwise: the session prints the receipt lines, and a card that is not sure
 * or can be retried keeps its reconcile step and comes back.
 */
export function receiptViewFrame(head: InSessionConfirmationAction, outcome: unknown): ToolViewFrameV1 | null {
  const view = typeof outcome === "object" && outcome !== null ? decodeAnswerView((outcome as { view?: unknown }).view) : null;
  if (!view || !RECEIPT_KINDS.has(view.kind)) {
    return null;
  }
  const settled = SETTLED_STATES.has(view.state)
    || (view.state === "failed" && view.outcome === "not_sent" && view.retry !== "retryable");
  const words = terminalText(typeof view.receipt?.sentence === "string" ? view.receipt.sentence : "")
    || terminalText(typeof view.stateReason?.words === "string" ? view.stateReason.words : "");
  if (!settled || !words) {
    return null;
  }
  // A receipt that brings no approval keeps the card's: the done card still
  // says what it did behind `?` (r4 flow-pause-03; S4's app sends none).
  const card = head.view?.approval;
  const kept = !view.approval && card?.kind === "card" ? ({ ...view, approval: card } as typeof view) : view;
  return {
    type: "tool.view",
    stage: "tool",
    message: terminalText(view.title),
    viewId: `receipt:${head.confirmationHandle}`,
    name: view.tool,
    view: kept
  };
}

/** What a dismissed card says (r4 flow-pause-09): the same words the app's receipt uses. */
export const DISMISSED_WORDS = "Dismissed — nothing was executed.";

/**
 * The dismissed card a `n` leaves on its turn AT ONCE (run-2 M5): the card's
 * own view, settled as dismissed, in the receipt's place (`receipt:<handle>`),
 * so the dismissed card and the Steps row's `· dismissed` draw in the same
 * frame as the key, not 1–10 s later when the app answers. The decline is
 * still sent once; the app's answer then replaces this in place (or takes it
 * off, when the decline failed). Null for a card with no view of a receipt
 * kind: its receipt lines wait for the app.
 */
export function dismissedReceiptFrame(head: InSessionConfirmationAction): ToolViewFrameV1 | null {
  const view = head.view;
  if (!view || !RECEIPT_KINDS.has(view.kind)) {
    return null;
  }
  return {
    type: "tool.view",
    stage: "tool",
    message: terminalText(view.title),
    viewId: `receipt:${head.confirmationHandle}`,
    name: view.tool,
    view: { ...view, state: "cancelled", stateReason: { code: "dismissed", words: DISMISSED_WORDS } } as typeof view
  };
}

/** The frame a decision leaves on its turn the moment it is made: only a `n` leaves one (the dismissed card). */
export function declineFrame(head: InSessionConfirmationAction, decision: ConfirmDecision): ToolViewFrameV1 | null {
  return decision === "decline" ? dismissedReceiptFrame(head) : null;
}

/**
 * The line a declined card's turn gets when the app sent no words of its own
 * (an older desktop) and the turn said nothing: it claims nothing about what
 * still runs or spends.
 */
export const DECLINED_FALLBACK_CAPTION = "Okay, nothing changed.";

/** One of the app's lines, scrubbed, or "" when it sent none. */
function appLine(value: unknown): string {
  return typeof value === "string" ? terminalText(value).trim() : "";
}

/**
 * The turn's messages once the app took its card's `n` (live re-check run 3,
 * M5; r4 flow-pause-09, and Cmd+L after Dismiss). The app sends the line it put
 * over the card (`askedCaption`, "Ready. It stops spending once you say OK.")
 * and its words after a no (`dismissedCaption`, "Okay, left it running.").
 * The line is swapped only when the turn's one answer IS the app's line, so
 * the model's own words always stay. A desktop that sends neither gives a turn
 * that said nothing the neutral line, and leaves any words alone. A no the app
 * did not take, or a turn whose question already went to scrollback, keeps
 * its messages as they are (the same array).
 */
export function messagesAfterDecline<M extends { role: string; text: string }>(messages: readonly M[], outcome: unknown): readonly M[] {
  if (!isRecord(outcome) || outcome.ok !== true) return messages;
  let question = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") question = index;
  });
  if (question < 0) return messages;
  const answers = messages.map((message, index) => ({ message, index })).filter(({ message, index }) => index > question && message.role === "assistant");
  const dismissed = appLine(outcome.dismissedCaption);
  if (dismissed) {
    const asked = appLine(outcome.askedCaption);
    const only = answers.length === 1 ? answers[0]! : null;
    if (!asked || !only || terminalText(only.message.text).trim() !== asked) return messages;
    return messages.map((message, index) => (index === only.index ? { ...message, text: dismissed } : message));
  }
  if (answers.some(({ message }) => message.text.trim())) return messages;
  const first = answers[0];
  if (first) return messages.map((message, index) => (index === first.index ? { ...message, text: DECLINED_FALLBACK_CAPTION } : message));
  return [...messages.slice(0, question + 1), { role: "assistant", text: DECLINED_FALLBACK_CAPTION } as M, ...messages.slice(question + 1)];
}

/** The app's words when it refused a card's answer before anything ran (`field_invalid`). */
export function fieldInvalidMessage(outcome: unknown): string | null {
  if (!isRecord(outcome) || outcome.code !== "field_invalid") return null;
  return typeof outcome.message === "string" ? outcome.message : "";
}

/**
 * What the app's answer does to a resolved card's frame on its turn (the
 * working card after a yes, the dismissed card after a `n`):
 * - `receipt`: a settled receipt view replaces it in place (on the card's turn);
 * - `keep`: the frame already says it (a `n` the app took with no receipt of
 *   its own, or a dismissal on a turn that has moved on);
 * - `drop`: take the frame off and print these lines (the session then shows
 *   the receipt's object or brings the card back).
 * A refused field (`field_invalid`) on a resolved answer is the session's to
 * handle before this, since it puts the card back in front.
 */
export type ConfirmSettle =
  | { type: "receipt"; frame: ToolViewFrameV1 }
  | { type: "keep" }
  | { type: "drop"; lines: ConfirmLine[] };

export function settleConfirmOutcome(
  head: InSessionConfirmationAction,
  outcome: unknown,
  opts: { decision: ConfirmDecision; dismissed: boolean; onCardTurn: boolean; thrown: boolean }
): ConfirmSettle {
  if (opts.thrown) {
    const receipt = fieldInvalidMessage(outcome) === null ? receiptViewFrame(head, outcome) : null;
    if (receipt && opts.onCardTurn) return { type: "receipt", frame: receipt };
    return { type: "drop", lines: confirmErrorLines(outcome) };
  }
  const receipt = receiptViewFrame(head, outcome);
  if (receipt && opts.onCardTurn) return { type: "receipt", frame: receipt };
  if (opts.dismissed && !isRecord(isRecord(outcome) ? outcome.view : undefined)) {
    // The app took the no and sent no receipt of its own: the dismissed card already says it.
    return { type: "keep" };
  }
  if (opts.dismissed && receipt?.view.state === "cancelled") {
    // The turn moved on, the dismissed card with it: the app agreed, nothing more to print.
    return { type: "keep" };
  }
  return { type: "drop", lines: confirmResultLines(outcome, opts.decision) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The lines of the r4 card for a pending write that came without an approval view. */
export function fallbackCardLines(
  pending: InSessionConfirmationAction,
  explainText: string | null,
  width: number,
  theme: Theme = DEFAULT_THEME
): string[] {
  const ctx = { color: colorEnabled(theme), theme };
  const keys = confirmCardKeys(pending, NO_CAPS);
  const inner = cardWidth(width) - 4;
  const summary = pending.summaryFromTool ? "" : terminalText(pending.summary);
  const rows = fieldRows(
    pending.confirmationDetails.map((detail) => ({ label: terminalText(detail.label), value: terminalText(detail.value) })),
    inner,
    ctx
  );
  const explain = explainText ? ["", ...wrapText(terminalText(explainText), inner)] : [];
  const chips = chipRows(keyBarHints(keys.ctx).filter((hint) => hint.key !== "?"), keys.ctx.okKey, inner, ctx);
  return cardBox(summary || UNNAMED_WRITE, cardBody([...rows, ...explain], chips, keys.ctx.explain === true, ctx), width, "amber", ctx);
}

/** Rows the card for a pending write without a view takes (the live region reserves them). */
export function fallbackCardRowCount(pending: InSessionConfirmationAction, explainText: string | null, width: number): number {
  return fallbackCardLines(pending, explainText, width).length;
}

/** The head pending write's card: the view's card when there is one, else the r4 card from its details. */
export function ConfirmActionMenu({
  card,
  explainText,
  pending,
  theme,
  width
}: {
  /** The card drawn from its approval view (views/approval.ts), else null (an old desktop). */
  card: ApprovalRender | null;
  /** The scrubbed `?` text when the explanation is open, else null. */
  explainText: string | null;
  pending: InSessionConfirmationAction | null;
  theme: Theme;
  width: number;
}) {
  if (!pending) {
    return null;
  }
  const lines = card ? card.lines : fallbackCardLines(pending, explainText, width, theme);
  // Ink gives an empty <Text> no height: a blank row is drawn as one space, so
  // the card takes exactly `lines.length` rows (the live region reserves them).
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, index) => <AnsiLine key={`card-${index}`} line={line || " "} />)}
    </Box>
  );
}
