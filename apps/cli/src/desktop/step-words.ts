// Step words (`step.words.v1`): the app's own short words for one tool call,
// carried on the bridge's existing `tool.start` / `tool.complete` progress
// frames as `words: { label, result? }`.
//
//   label   what the step is doing, present tense ("checking the catalog")
//   result  a short outcome ("3 rows"), only on the complete frame and only
//           when the app has one
//
// The terminal carries no product words of its own, so the app sends them. The
// capability is opt-in both ways: the turn asks for it in `accept` only when
// the descriptor and `/v1/status` both advertise it, and words on a turn that
// did not ask are dropped. An old desktop sends none and nothing changes.
//
// Words are DISPLAY text. A label that is really a tool id, JSON or an opaque
// id is refused here, and the step falls back to the generic label made from
// the tool's name (`friendlyStepLabel`), never to the raw string.
import { terminalText } from "./terminal-text.js";

export const STEP_WORDS_CAPABILITY = "step.words.v1" as const;

/** The longest label or result the contract allows; a longer one is cut with `…`. */
export const MAX_STEP_WORD_CHARS = 48;

export interface StepWords {
  label: string;
  result?: string;
}

/**
 * The words on one tool frame, scrubbed for the terminal: control sequences
 * out, whitespace collapsed, at most `MAX_STEP_WORD_CHARS` characters. Null
 * when the frame carries no usable label. A result that is not display text
 * is dropped on its own; the label still stands.
 */
export function decodeStepWords(value: unknown): StepWords | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const label = displayWords(record.label);
  if (!label) {
    return null;
  }
  const result = displayWords(record.result);
  return result ? { label, result } : { label };
}

/** The decoded words a progress event carries (`event.words`), if any. */
export function stepWordsOf(event: unknown): StepWords | null {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return null;
  }
  return decodeStepWords((event as { words?: unknown }).words);
}

/** One string as display words, or "" when it is not display text. */
function displayWords(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = terminalText(value);
  if (!text || !isDisplayWords(text)) {
    return "";
  }
  const characters = Array.from(text);
  return characters.length <= MAX_STEP_WORD_CHARS
    ? text
    : `${characters.slice(0, MAX_STEP_WORD_CHARS - 1).join("").trimEnd()}…`;
}

/**
 * Whether a string reads as words for a person. Refused: a tool id
 * (`mcp__app__get_report`, `get_report`), JSON or quoted call arguments (`{`,
 * `[`, `"`, a backslash, a backtick, angle brackets), a URL, and an opaque id
 * (a long run of digits, a long token that mixes letters and digits).
 */
export function isDisplayWords(text: string): boolean {
  if (/[{}[\]"\\`<>]/u.test(text) || text.includes("://")) {
    return false;
  }
  // snake_case or a namespaced tool id.
  if (/[A-Za-z0-9]_[A-Za-z0-9]/u.test(text) || text.includes("__")) {
    return false;
  }
  // An opaque id: 9+ digits in a row, or a 20+ character token with no spaces that mixes letters and digits.
  if (/\d{9,}/u.test(text)) {
    return false;
  }
  if (text.split(" ").some((word) => word.length >= 20 && /[A-Za-z]/u.test(word) && /\d/u.test(word))) {
    return false;
  }
  return true;
}
