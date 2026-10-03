// A streamed yes (T12, confirm.stream.v1): the app answers with the card's
// receipt first, then the agent's follow-up, then one terminal frame. The
// session draws the receipt the moment it arrives (as a plain confirm's
// answer), puts the follow-up's views and answer on the card's own turn, and
// queues any card the follow-up proposed. An error after the receipt never
// undoes it: it only adds the follow-up's words.
import type { ToolViewFrameV1 } from "@infinite-os/types";

import { decodeToolViewFrame, isToolViewFrameData } from "./answer-view-decode.js";
import type { InSessionConfirmationAction } from "./confirm-in-session.js";
import type { ConfirmLine } from "./confirm-result-lines.js";
import { parsePendingConfirmations } from "./desktop-turn-source.js";
import { boundedTerminalText, terminalText } from "./terminal-text.js";

const MAX_LINE_CHARS = 240;

export interface FollowUpOutcome {
  /** The agent's answer after the receipt ("" when it said nothing). Scrubbed. */
  message: string;
  /** Cards the follow-up proposed, each scoped to the follow-up's own turn. */
  pending: InSessionConfirmationAction[];
  /** The follow-up's error, when it failed after the receipt. */
  errorLines: ConfirmLine[];
}

/** The follow-up a streamed confirm's result carries (none on a plain confirm). */
export function followUpOutcome(result: unknown, options: { confirmFieldsCapable: boolean }): FollowUpOutcome {
  const record = isRecord(result) ? result : {};
  const followUp = isRecord(record.followUp) ? record.followUp : null;
  const failure = isRecord(record.followUpError) ? record.followUpError : null;
  let pending: InSessionConfirmationAction[] = [];
  const errorLines: ConfirmLine[] = [];
  if (followUp) {
    try {
      pending = parsePendingConfirmations(
        Array.isArray(followUp.actionCalls) ? followUp.actionCalls : [],
        typeof followUp.turnId === "string" && followUp.turnId.trim() ? followUp.turnId.trim() : undefined,
        options.confirmFieldsCapable
      );
    } catch (error) {
      // A card the follow-up could not hand over whole is never shown half-made.
      errorLines.push(stoppedLine(error instanceof Error ? error.message : ""));
    }
  }
  if (failure) {
    errorLines.push(stoppedLine(typeof failure.message === "string" ? failure.message : ""));
  }
  return {
    message: followUp && typeof followUp.message === "string" ? terminalText(followUp.message).trim() : "",
    pending,
    errorLines
  };
}

/** One thing the session does, in order, once a confirm call ends. */
export type ConfirmStreamStep =
  /** Settle the card from the app's answer (a result) or from the error it threw. */
  | { type: "settle"; outcome: unknown; thrown: boolean }
  /** The agent's follow-up answer, as an assistant message on the same turn. */
  | { type: "message"; text: string }
  /** Lines under the receipt (the follow-up's error words). */
  | { type: "lines"; lines: ConfirmLine[] }
  /** Cards the follow-up proposed, queued after any already waiting. */
  | { type: "queue"; pending: InSessionConfirmationAction[] };

/**
 * The session's sequencing when a confirm call ends, as data (CI-tested here,
 * so the session only carries each step out). The receipt is settled once: a
 * streamed receipt already settled it (`answered`), so it is never settled
 * again; otherwise the result (or the thrown error) settles it first. Then the
 * follow-up's answer, its error words, and its cards, in that order. A throw
 * after the receipt adds only the follow-up's error words: the receipt stays.
 */
export function confirmStreamSteps(
  end: { type: "resolved"; result: unknown } | { type: "rejected"; error: unknown },
  options: { answered: boolean; confirmFieldsCapable: boolean }
): ConfirmStreamStep[] {
  if (end.type === "rejected") {
    if (!options.answered) return [{ type: "settle", outcome: end.error, thrown: true }];
    const failed = followUpOutcome({ followUpError: end.error }, { confirmFieldsCapable: false });
    return failed.errorLines.length ? [{ type: "lines", lines: failed.errorLines }] : [];
  }
  const steps: ConfirmStreamStep[] = [];
  if (!options.answered) steps.push({ type: "settle", outcome: end.result, thrown: false });
  const follow = followUpOutcome(end.result, { confirmFieldsCapable: options.confirmFieldsCapable });
  if (follow.message) steps.push({ type: "message", text: follow.message });
  if (follow.errorLines.length) steps.push({ type: "lines", lines: follow.errorLines });
  if (follow.pending.length) steps.push({ type: "queue", pending: follow.pending });
  return steps;
}

/** A follow-up progress frame that is a view (decoded), else null. */
export function followUpViewFrame(frame: { data: unknown }): ToolViewFrameV1 | null {
  return isToolViewFrameData(frame.data) ? decodeToolViewFrame(frame.data) : null;
}

function stoppedLine(message: string): ConfirmLine {
  const words = boundedTerminalText(message, MAX_LINE_CHARS);
  return { tone: "warn", text: `! The follow-up stopped: ${words || "it did not finish."}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
