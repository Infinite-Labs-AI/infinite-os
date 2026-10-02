// The one-shot path's progress lines (non-Ink output: a pipe, or a terminal
// without the live session), in the r4 Steps look: no `┊` gutter and no
// East-Asian-wide glyph (spec §4), a friendly label, never a raw tool id.
//
//   ⠋ running breakdown query  9.8s          a call or a step still running
//   running breakdown query ✓ 3 rows          a call that finished (r4: no duration)
//   pausing entity ✗ not allowed              a call that failed
//   · recall  Recalled prior session context  1.2s
//   ◇ delegate  Review the renderer  2.1s     a subagent
import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import { TOOL_VERBS } from "../tui/content/verbs.js";
import { compactPreview } from "../tui/lib/text.js";
import { viewText } from "../tui/views/primitives.js";
import { bareToolName, friendlyStepLabel } from "../tui/views/steps.js";

type LegacyRenderableProgress = {
  stage: "recall" | "resolve" | "tool";
  message: string;
};

/** r4's running glyph (the one-shot line is printed once, so it does not spin). */
const RUNNING = "⠋";
/** A step that is information, not a call (thinking, recall, context). */
const NOTE = "·";

export function formatInteractiveProgress(event: ChatProgressEvent, elapsedMs: number): string {
  if ("type" in event) {
    return formatInfiniteProgress(event, elapsedMs);
  }
  return formatLegacyProgress(event, elapsedMs);
}

function formatInfiniteProgress(event: Extract<ChatProgressEvent, { type: string }>, elapsedMs: number): string {
  if (event.type === "tool.generating") {
    const verb = TOOL_VERBS[event.name] ?? "drafting";
    return `  ${RUNNING} ${verb} ${toolWords(event.name)}…  ${formatElapsedSeconds(elapsedMs)}`;
  }
  if (event.type === "tool.start") {
    return formatLegacyProgress({ stage: "tool", message: event.context || event.message }, elapsedMs);
  }
  if (event.type === "tool.progress") {
    return formatLegacyProgress({ stage: "tool", message: event.preview || event.message }, elapsedMs);
  }
  if (event.type === "tool.complete") {
    // A transport may report failure as status:"error" with no error string.
    const failed = Boolean(event.error || event.status === "error");
    const result = compactPreview(viewText(event.error || event.summary || ""), 72);
    return `  ${friendlyStepLabel(event.name)} ${failed ? "✗" : "✓"}${result ? ` ${result}` : ""}`;
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

/** A tool's name as plain words (`mcp__app__run_breakdown_query` → `run breakdown query`). */
function toolWords(name: string): string {
  const words = bareToolName(viewText(name))
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.:/-]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.join(" ") || "tool";
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
