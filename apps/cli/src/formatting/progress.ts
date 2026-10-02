// The one-shot path's progress lines (non-Ink output: a pipe, or a terminal
// without the live session), in the r4 Steps look: no `┊` gutter and no
// East-Asian-wide glyph (spec §4), a friendly label, never a raw tool id.
//
//   ⠋ running breakdown query  9.8s          a call or a step still running
//   running breakdown query ✓ 3 rows          a call that finished (r4: no duration)
//   pausing entity ✗ not allowed              a call that failed
//   proposing pause entity ▣ waiting for your OK   a call that waits for the person's OK
//
// A call's words are the app's own when its frame carries them
// (`step.words.v1`), else generic words from the tool's name; a context or a
// preview is shown only when it reads as words, never as JSON arguments.
//   · recall  Recalled prior session context  1.2s
//   ◇ delegate  Review the renderer  2.1s     a subagent
import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import { isDisplayWords, stepWordsOf } from "../desktop/step-words.js";
import { TOOL_VERBS } from "../tui/content/verbs.js";
import { compactPreview } from "../tui/lib/text.js";
import { viewText } from "../tui/views/primitives.js";
import { friendlyStepLabel, plainToolWords, toolOutcome, WAITING_WORDS } from "../tui/views/steps.js";

type LegacyRenderableProgress = {
  stage: "recall" | "resolve" | "tool";
  message: string;
};

/** r4's running glyph (the one-shot line is printed once, so it does not spin). */
const RUNNING = "⠋";
/** A step that is information, not a call (thinking, recall, context). */
const NOTE = "·";
/** r4's needs-you glyph: a call that waits for the person's OK. */
const PENDING = "▣";

export function formatInteractiveProgress(event: ChatProgressEvent, elapsedMs: number): string {
  if ("type" in event) {
    return formatInfiniteProgress(event, elapsedMs);
  }
  return formatLegacyProgress(event, elapsedMs);
}

function formatInfiniteProgress(event: Extract<ChatProgressEvent, { type: string }>, elapsedMs: number): string {
  if (event.type === "tool.generating") {
    const verb = TOOL_VERBS[event.name] ?? "drafting";
    return `  ${RUNNING} ${verb} ${plainToolWords(event.name)}…  ${formatElapsedSeconds(elapsedMs)}`;
  }
  if (event.type === "tool.start") {
    return runningToolLine(event, event.context, elapsedMs);
  }
  if (event.type === "tool.progress") {
    return runningToolLine(event, event.preview, elapsedMs);
  }
  if (event.type === "tool.complete") {
    // A transport may report failure as status:"error" with no error string;
    // a call that waits for the person's OK is pending (▣), never ✓.
    const words = stepWordsOf(event);
    const outcome = toolOutcome({ status: event.status, error: event.error, summary: event.summary, words });
    const mark = outcome.status === "fail" ? "✗" : outcome.status === "wait" ? PENDING : "✓";
    const result = outcome.result || (outcome.status === "wait" ? WAITING_WORDS : "");
    return `  ${words?.label ?? friendlyStepLabel(event.name)} ${mark}${result ? ` ${result}` : ""}`;
  }
  if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
    const detail = viewText(event.text).replace(/\s+/g, " ").trim();
    return `  ${NOTE} thinking  ${compactPreview(detail || "reasoning", 42)}  ${formatElapsedSeconds(elapsedMs)}`;
  }
  if (event.type === "message.start" || event.type === "message.delta" || event.type === "message.complete") {
    return "";
  }
  if (event.type === "subagent.start" || event.type === "subagent.progress" || event.type === "subagent.complete") {
    const summary = viewText(event.subagent.summary || event.message);
    const status = event.subagent.status ?? (event.type === "subagent.complete" ? "completed" : "running");
    const mark = status === "completed" ? "✓" : status === "running" || status === "queued" ? "◇" : "✗";
    const label = event.type === "subagent.start"
      ? "delegate"
      : event.type === "subagent.complete"
        ? "subagent"
        : "working";
    return `  ${mark} ${label}  ${compactPreview(summary, 60)}  ${formatElapsedSeconds(elapsedMs)}`;
  }
  return formatLegacyProgress({
    stage: event.stage === "recall" ? "recall" : "resolve",
    message: event.text || event.message
  }, elapsedMs);
}

/**
 * A call still running: the app's words for it; else its context or preview
 * when that reads as words (as the local engine sends them); else its own
 * message when that is words; else generic words from the tool's name. Never
 * JSON arguments and never the raw tool id.
 */
function runningToolLine(
  event: { name: string; message: string },
  detail: string | undefined,
  elapsedMs: number
): string {
  const words = stepWordsOf(event);
  if (words) {
    return `  ${RUNNING} ${words.label}  ${formatElapsedSeconds(elapsedMs)}`;
  }
  const said = [detail, event.message].map((text) => viewText(text)).find((text) => text && isDisplayWords(text));
  if (said) {
    return formatLegacyProgress({ stage: "tool", message: said }, elapsedMs);
  }
  return `  ${RUNNING} ${friendlyStepLabel(event.name)}  ${formatElapsedSeconds(elapsedMs)}`;
}

function formatLegacyProgress(event: LegacyRenderableProgress, elapsedMs: number): string {
  const detail = compactPreview(viewText(event.message).replace(/\.$/, ""), 96);
  const elapsed = formatElapsedSeconds(elapsedMs);
  if (event.stage === "recall") {
    return `  ${NOTE} recall  ${detail}  ${elapsed}`;
  }
  if (event.stage === "tool") {
    if (/^Checking /i.test(detail)) {
      return `  ${RUNNING} checking ${detail.replace(/^Checking /i, "")}  ${elapsed}`;
    }
    const call = detail.replace(/^Running\s+/i, "").replace(/\.$/, "");
    // A bare tool id (`run_breakdown_query`) reads as its friendly label.
    const label = /^[\w.:-]+$/u.test(call) && /[_.:]/u.test(call) ? friendlyStepLabel(call) : call;
    return `  ${RUNNING} ${label}  ${elapsed}`;
  }
  if (/^Preparing /i.test(detail)) {
    return `  ${RUNNING} preparing ${detail.replace(/^Preparing /i, "")}…  ${elapsed}`;
  }
  if (/^Checking /i.test(detail)) {
    return `  ${RUNNING} checking ${detail.replace(/^Checking /i, "")}  ${elapsed}`;
  }
  if (/^Resolved /i.test(detail)) {
    return `  ${NOTE} context  ${detail}  ${elapsed}`;
  }
  if (/^Recalled /i.test(detail)) {
    return `  ${NOTE} recall  ${detail}  ${elapsed}`;
  }
  return `  ${RUNNING} ${detail}  ${elapsed}`;
}

export function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
}
