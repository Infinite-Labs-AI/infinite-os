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
