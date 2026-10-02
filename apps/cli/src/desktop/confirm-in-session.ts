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
  askDismissOnly,
  confirmErrorLines,
  confirmResultLines,
  leftForLaterLine,
  type ConfirmLine
} from "./confirm-result-lines.js";
import { boundedTerminalText, scrubTerminalControls, terminalText } from "./terminal-text.js";

export { boundedTerminalText, scrubTerminalControls, terminalText };

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
  /**
   * The Desktop that minted this card takes field answers (`confirm.fields.v1`).
   * False or absent: a card with a required field can only be dismissed here.
   */
  confirmFieldsCapable?: boolean;
  /**
   * A card brought back after an approve the app is not sure of: the answers
   * that approve sent. OK again (`safe_resend`) and `r` (`retryable`) re-send
   * exactly these, so the app's dedupe sees the same answer.
   */
  sentFields?: Record<string, ApprovalFieldAnswerV1>;
  /** A card put back after the app refused its answer (`field_invalid`): the app's words. */
  fieldError?: string;
}

/**
 * A card coming back to the queue. A card brought back after an unsure
 * approve goes behind the card the user is on now (`behind_head`), so that
 * card and its key state stay put; a card whose answer the app refused goes
 * in front, to fix it now.
 */
export function requeueConfirmation(
  queue: readonly InSessionConfirmationAction[],
  entry: InSessionConfirmationAction,
  place: "front" | "behind_head"
): InSessionConfirmationAction[] {
  if (place === "front" || queue.length === 0) return [entry, ...queue];
  return [queue[0]!, entry, ...queue.slice(1)];
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

  // A card that needs a typed value (a daily budget) cannot be answered on this
  // line prompt: it is never approved here, only dismissed or left.
  if (needsTypedField(action.view)) {
    io.write(`${typedFieldLine(action.view)}\n`);
    const answer = await askDismissOnly((question) => io.prompt(question), DISMISS_ONLY_QUESTION);
    if (answer === "pending") {
      io.write(`${leftForLaterLine(action.view?.approval?.expiresAt)}\n`);
      return;
    }
    await sendDecision(action, "decline", io, client, signal);
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

  await sendDecision(action, decision, io, client, signal);
}

/** The words a line prompt asks with on a card it can only dismiss. */
export const DISMISS_ONLY_QUESTION = "Type n to dismiss, or press Enter to leave it: ";
const TYPED_FIELD_WORDS = "Answer this in the Infinite app or the chat session";

/** The card asks for a value (a required field) that a y/n prompt cannot send. */
export function needsTypedField(view: AnswerViewV1 | undefined): boolean {
  const fields: unknown = view?.approval?.fields;
  return Array.isArray(fields) && fields.some((field) =>
    typeof field === "object" && field !== null && (field as { required?: unknown }).required === true);
}

/** Where to answer a card that needs a typed value: the app's finishInApp words, else ours. */
export function typedFieldLine(view: AnswerViewV1 | undefined): string {
  const words = view?.approval?.finishInApp?.words;
  return (typeof words === "string" ? boundedTerminalText(words, MAX_CONFIRMATION_VALUE_CHARS) : "") || TYPED_FIELD_WORDS;
}

async function sendDecision(
  action: InSessionConfirmationAction,
  decision: "approve" | "decline",
  io: InSessionConfirmationIo,
  client: InSessionConfirmationClient,
  signal?: AbortSignal
): Promise<void> {
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
