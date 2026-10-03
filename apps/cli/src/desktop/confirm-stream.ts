// A streamed yes (T12, confirm.stream.v1): the app answers with the card's
// receipt first, then the agent's follow-up, then one terminal frame. The
// session draws the receipt the moment it arrives (as a plain confirm's
// answer), puts the follow-up's views, Steps and answer on the card's own
// turn, and queues any card the follow-up proposed. An error after the
// receipt never undoes it: it only adds the follow-up's words. A follow-up
// that ends after its card's turn went up prints as labelled lines, never as
// another question's answer.
import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import type { CreativeDraftFrameV1, ToolViewFrameV1 } from "@infinite-os/types";

import {
  decodeCreativeDraftFrame,
  decodeToolViewFrame,
  isCreativeDraftFrameData,
  isToolViewFrameData
} from "./answer-view-decode.js";
import type { InSessionConfirmationAction } from "./confirm-in-session.js";
import type { ConfirmLine } from "./confirm-result-lines.js";
import { bridgeFrameToChatEvent, parsePendingConfirmations } from "./desktop-turn-source.js";
import { boundedTerminalText, scrubTerminalControls } from "./terminal-text.js";

const MAX_LINE_CHARS = 240;
const MAX_LABEL_CHARS = 80;
const STOPPED_LINE = "■ Stopped the follow-up. Anything already running in the app may still finish.";

export interface FollowUpOutcome {
  /**
   * The agent's answer after the receipt ("" when it said nothing): markdown,
   * scrubbed of terminal controls line by line, its line breaks kept (the
   * transcript's markdown renderer draws it, as it draws any answer).
   */
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
    message: followUp && typeof followUp.message === "string" ? answerText(followUp.message) : "",
    pending,
    errorLines
  };
}

/**
 * An answer's text as the markdown renderer reads it (markdown-render.ts
 * `renderDocument`): line endings and tabs normalized, each line scrubbed of
 * escape, OSC and bidi controls, the line breaks kept. Never `terminalText`,
 * which folds every line into one. Blank lines at either end are dropped.
 */
function answerText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "    ")
    .split("\n")
    .map((line) => scrubTerminalControls(line).trimEnd())
    .join("\n")
    .replace(/^\n+/u, "")
    .trimEnd();
}

/** One thing the session does, in order, once a confirm call ends. */
export type ConfirmStreamStep =
  /** Settle the card from the app's answer (a result) or from the error it threw. */
  | { type: "settle"; outcome: unknown; thrown: boolean }
  /** The agent's follow-up answer, as an assistant message on the card's own turn. */
  | { type: "message"; text: string }
  /** Lines under the receipt (the follow-up's error words), or the follow-up labelled off its turn. */
  | { type: "lines"; lines: ConfirmLine[] }
  /** Cards the follow-up proposed, queued after any already waiting. */
  | { type: "queue"; pending: InSessionConfirmationAction[] };

export interface ConfirmStreamStepOptions {
  answered: boolean;
  confirmFieldsCapable: boolean;
  /**
   * Whether the card's turn is still the live one. Off it (a new line went up
   * first), the follow-up's answer and words print as lines labelled with
   * whose follow-up they are, never as the new question's answer, and a card
   * it proposed is queued only after a line says whose it is. Default true.
   */
  onCardTurn?: boolean;
  /** The card the follow-up follows (its summary), for the off-turn label. */
  label?: string;
  /** The user stopped the follow-up (Esc / Ctrl-C): one stop line instead of its error words. */
  stopped?: boolean;
}

/**
 * The session's sequencing when a confirm call ends, as data (CI-tested here,
 * so the session only carries each step out). The receipt is settled once: a
 * streamed receipt already settled it (`answered`), so it is never settled
 * again; otherwise the result (or the thrown error) settles it first. Then the
 * follow-up's answer, its error words, and its cards, in that order. A throw
 * after the receipt adds only the follow-up's error words: the receipt stays.
 * A stop after the receipt ends only the follow-up: the write already went and
 * is never re-decided.
 */
export function confirmStreamSteps(
  end: { type: "resolved"; result: unknown } | { type: "rejected"; error: unknown },
  options: ConfirmStreamStepOptions
): ConfirmStreamStep[] {
  const onCardTurn = options.onCardTurn !== false;
  const steps: ConfirmStreamStep[] = [];
  let follow: FollowUpOutcome;
  if (end.type === "rejected") {
    if (!options.answered) return [{ type: "settle", outcome: end.error, thrown: true }];
    follow = followUpOutcome({ followUpError: end.error }, { confirmFieldsCapable: false });
  } else {
    if (!options.answered) steps.push({ type: "settle", outcome: end.result, thrown: false });
    follow = followUpOutcome(end.result, { confirmFieldsCapable: options.confirmFieldsCapable });
  }
  const errorLines = options.stopped && options.answered ? [{ tone: "muted" as const, text: STOPPED_LINE }] : follow.errorLines;
  if (onCardTurn) {
    if (follow.message) steps.push({ type: "message", text: follow.message });
    if (errorLines.length) steps.push({ type: "lines", lines: errorLines });
    if (follow.pending.length) steps.push({ type: "queue", pending: follow.pending });
    return steps;
  }
  const label = followUpLabel(options.label);
  const said: ConfirmLine[] = [
    ...(follow.message ? follow.message.split("\n").map((line) => ({ tone: "muted" as const, text: line ? `  ${line}` : "" })) : []),
    ...errorLines
  ];
  if (said.length) steps.push({ type: "lines", lines: [{ tone: "muted", text: `↳ ${label}:` }, ...said] });
  if (follow.pending.length) {
    steps.push({ type: "lines", lines: [{ tone: "muted", text: `↳ ${label} asks for your OK on a new card.` }] });
    steps.push({ type: "queue", pending: follow.pending });
  }
  return steps;
}

/** `The follow-up to “Pause ad 01”` (the card's summary, scrubbed and bounded). */
export function followUpLabel(summary: string | undefined): string {
  const words = boundedTerminalText(summary ?? "", MAX_LABEL_CHARS);
  return words ? `The follow-up to “${words}”` : "The follow-up to your OK";
}

/** A follow-up progress frame that is a view (decoded), else null. */
export function followUpViewFrame(frame: { data: unknown }): ToolViewFrameV1 | null {
  return isToolViewFrameData(frame.data) ? decodeToolViewFrame(frame.data) : null;
}

/** Where one follow-up progress frame goes on the card's turn (P33-S3). */
export type FollowUpFrameRoute =
  /** A decoded answer view. */
  | { type: "view"; frame: ToolViewFrameV1 }
  /** An image draft in progress (`drawing 2 of 3`), rebuilt from its allowlist. */
  | { type: "draft"; frame: CreativeDraftFrameV1 }
  /** A call's start, progress or end, for the Steps strip. */
  | { type: "step"; event: ChatProgressEvent };

const STEP_EVENT_TYPES: ReadonlySet<string> = new Set(["tool.generating", "tool.start", "tool.progress", "tool.complete"]);

/**
 * Route one follow-up progress frame the way a normal turn's frame goes
 * (desktop-turn-source.ts): a view to the turn's views, a `creative.draft` to
 * the draft lines, a call's start / progress / end to the Steps. Streamed
 * text and everything else is dropped: the follow-up's answer arrives whole
 * with its terminal frame. Null = nothing to draw.
 */
export function followUpFrameRoute(frame: { data: unknown }): FollowUpFrameRoute | null {
  if (isToolViewFrameData(frame.data)) {
    const view = decodeToolViewFrame(frame.data);
    return view ? { type: "view", frame: view } : null;
  }
  if (isCreativeDraftFrameData(frame.data)) {
    const draft = decodeCreativeDraftFrame(frame.data);
    return draft ? { type: "draft", frame: draft } : null;
  }
  // Step words are decoded and scrubbed when the frame carries them (a desktop that streams a confirm sends them).
  const event = bridgeFrameToChatEvent({ kind: "progress", data: frame.data }, { stepWords: true });
  return event && "type" in event && STEP_EVENT_TYPES.has(event.type) ? { type: "step", event } : null;
}

function stoppedLine(message: string): ConfirmLine {
  const words = boundedTerminalText(message, MAX_LINE_CHARS);
  return { tone: "warn", text: `! The follow-up stopped: ${words || "it did not finish."}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
