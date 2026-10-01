/**
 * In-session confirmation for the forked desktop interactive loop.
 *
 * When a Desktop turn's terminal frame carries a `requires_confirmation` action,
 * the interactive loop pauses, renders the (already-redacted) confirm card into
 * the transcript and prompts the operator on the TTY. Only `y`/`yes` approves
 * and only `n`/`no` declines; both call `client.confirm(...)` (a decline is a
 * real "no" that reaches the app's ledger) and print the receipt lines, never
 * JSON. Bare Enter or any other answer never decides: it re-prompts once, then
 * leaves the card pending until it expires and calls nothing.
 *
 * The card detail values are redacted UPSTREAM (the desktop-app-client parser
 * fills `confirmationDetails` with redacted label/value pairs), so the renderer
 * here is the same minimal `label: value` layout the one-shot `app` command
 * uses — it never re-derives or exposes raw input.
 *
 * The `summary`, however, is NOT covered by that upstream redaction contract, so
 * — exactly as the reference `renderPendingConfirmation` / `promptForConfirmation`
 * do — every place we write it to the terminal runs it through {@link terminalText}
 * (strip ANSI/OSC/control sequences, collapse whitespace) and, at the prompt,
 * {@link boundedTerminalText} (bound length). A summary carrying escape/control
 * sequences must never reach the raw TTY: that is a terminal-injection defense the
 * one-shot path keeps, and the in-session path must keep it too.
 *
 * {@link terminalText} is exported so the Ink confirmation overlay (the default
 * TTY surface's in-session write gate) can apply the SAME summary sanitization
 * before rendering — the Ink `<Text>` child ultimately reaches the terminal, so
 * a summary carrying escape/control sequences must be scrubbed there too. The
 * (already-redacted) detail values are rendered verbatim, exactly as this file's
 * `renderConfirmationCard` writes them.
 */

import type { AnswerViewV1, ApprovalFieldAnswerV1 } from "@infinite-os/types";

import {
  askConfirmDecision,
  confirmErrorLines,
  confirmResultLines,
  leftForLaterLine,
  type ConfirmLine
} from "./confirm-result-lines.js";
import { boundedTerminalText, terminalText } from "./terminal-text.js";

export { boundedTerminalText, terminalText };

/** Upper bound on the summary length echoed into the TTY prompt (reference parity). */
const MAX_CONFIRMATION_VALUE_CHARS = 240;

/** A single redacted label/value line of the confirm card. */
export interface InSessionConfirmationDetail {
  label: string;
  value: string;
}

/**
 * The pending action to confirm. `confirmationDetails` are ALREADY redacted by
 * the client parser; `turnId` scopes the confirmation to its originating turn.
 */
export interface InSessionConfirmationAction {
  turnId: string;
  confirmationHandle: string;
  summary: string;
  confirmationDetails: InSessionConfirmationDetail[];
  /**
   * The decoded approval view (`done.actionCalls[i].view`), present only when
   * the turn accepted `result.view.v1` and the view decoded. Its strings are
   * NOT redacted or scrubbed here: renderers scrub every one before printing.
   */
  view?: AnswerViewV1;
}

/** The TTY seam: readiness flags, a line prompt, and a transcript writer. */
export interface InSessionConfirmationIo {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  prompt(question: string): Promise<string>;
  write(text: string): void;
}

/** The narrow client contract this handler drives (the real client's `confirm`). */
export interface InSessionConfirmationClient {
  confirm(input: {
    turnId: string;
    confirmationHandle: string;
    decision: "approve" | "decline";
    /** Answers to the card's `approval.fields` (needs `confirm.fields.v1`). */
    fields?: Record<string, ApprovalFieldAnswerV1>;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Render the redacted confirm card, prompt `Approve "…"? [y/n]`, and on an
 * explicit `y`/`yes` or `n`/`no` call `client.confirm(...)` with that decision
 * and print its receipt. Any other answer (bare Enter included) re-prompts
 * once, then leaves the card pending and calls nothing.
 */
export async function handleInSessionConfirmation(
  action: InSessionConfirmationAction,
  io: InSessionConfirmationIo,
  client: InSessionConfirmationClient,
  signal?: AbortSignal
): Promise<void> {
  renderConfirmationCard(action, io);

  // Never prompt on a non-interactive terminal — surface the pending action and
  // leave it unexecuted rather than blocking on an absent TTY.
  if (!io.inputIsTTY || !io.outputIsTTY) {
    io.write("Action was not executed (non-interactive terminal).\n");
    return;
  }

  const promptSummary = boundedTerminalText(
    action.summary,
    MAX_CONFIRMATION_VALUE_CHARS,
    "action"
  );
  const decision = await askConfirmDecision(
    (question) => io.prompt(question),
    `Approve "${promptSummary}"? [y/n] `
  );
  if (decision === "pending") {
    io.write(`${leftForLaterLine(action.view?.approval?.expiresAt)}\n`);
    return;
  }

  let lines: ConfirmLine[];
  try {
    const result = await client.confirm({
      turnId: action.turnId,
      confirmationHandle: action.confirmationHandle,
      decision,
      ...(signal ? { signal } : {})
    });
    lines = confirmResultLines(result, decision);
  } catch (error) {
    lines = confirmErrorLines(error);
  }
  for (const line of lines) {
    io.write(`${line.text}\n`);
  }
}

function renderConfirmationCard(
  action: InSessionConfirmationAction,
  io: InSessionConfirmationIo
): void {
  io.write(`Pending confirmation: ${terminalText(action.summary, "action")}\n`);
  for (const detail of action.confirmationDetails) {
    io.write(`  ${detail.label}: ${detail.value}\n`);
  }
}
