import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import { TOOL_VERBS } from "../tui/content/verbs.js";
import { buildToolTrailLine, compactPreview, toolTrailLabel } from "../tui/lib/text.js";

type LegacyRenderableProgress = {
  stage: "recall" | "resolve" | "tool";
  message: string;
};

export function formatInteractiveProgress(event: ChatProgressEvent, elapsedMs: number): string {
  if ("type" in event) {
    return formatInfiniteProgress(event, elapsedMs);
  }
  return formatLegacyProgress(event, elapsedMs);
}

function formatInfiniteProgress(event: Extract<ChatProgressEvent, { type: string }>, elapsedMs: number): string {
  if (event.type === "tool.generating") {
    const verb = TOOL_VERBS[event.name] ?? "drafting";
    return `┊ ⚡ ${verb.padEnd(9)} ${toolTrailLabel(event.name)}…  ${formatElapsedSeconds(elapsedMs)}`;
  }
  if (event.type === "tool.start") {
    return formatLegacyProgress({ stage: "tool", message: event.context || event.message }, elapsedMs);
  }
  if (event.type === "tool.progress") {
    return formatLegacyProgress({ stage: "tool", message: event.preview || event.message }, elapsedMs);
  }
  if (event.type === "tool.complete") {
    const mark = event.error || event.status === "error" ? "✗" : "⚡";
    const label = event.error || event.status === "error" ? "failed" : "tool";
    const trail = buildToolTrailLine(
      event.name,
      "",
      Boolean(event.error || event.status === "error"),
      event.error || event.summary,
      event.durationMs / 1000
    );
    return `┊ ${mark} ${label.padEnd(10)}${trail}`;
  }
  if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
    const detail = event.text.replace(/\s+/g, " ").trim();
    return `┊ 🧠 thinking  ${compactPreview(detail || "reasoning", 42)}  ${formatElapsedSeconds(elapsedMs)}`;
  }
  if (event.type === "message.start" || event.type === "message.delta" || event.type === "message.complete") {
    return "";
  }
  if (event.type === "subagent.start" || event.type === "subagent.progress" || event.type === "subagent.complete") {
    const summary = event.subagent.summary || event.message;
    const status = event.subagent.status ?? (event.type === "subagent.complete" ? "completed" : "running");
    const mark = status === "completed" ? "✓" : status === "running" || status === "queued" ? "◇" : "✗";
    const label = event.type === "subagent.start"
      ? "delegate"
      : event.type === "subagent.complete"
        ? "subagent"
        : "working";
    return `┊ ${mark} ${label.padEnd(9)} ${compactPreview(summary, 60)}  ${formatElapsedSeconds(elapsedMs)}`;
  }
  return formatLegacyProgress({
    stage: event.stage === "recall" ? "recall" : "resolve",
    message: event.text || event.message
  }, elapsedMs);
}

function formatLegacyProgress(event: LegacyRenderableProgress, elapsedMs: number): string {
  const detail = compactPreview(event.message.replace(/\.$/, ""), 96);
  const elapsed = formatElapsedSeconds(elapsedMs);
  if (event.stage === "recall") {
    return `┊ 🔍 recall    ${detail}  ${elapsed}`;
  }
  if (event.stage === "tool") {
    if (/^Checking /i.test(detail)) {
      const checked = detail.replace(/^Checking /i, "");
      return `┊ 🔍 checking  ${checked}  ${elapsed}`;
    }
    const normalized = detail.replace(/^Running\s+/i, "").replace(/\.$/, "");
    return `┊ ⚡ tool      ${normalized}  ${elapsed}`;
  }
  if (/^Preparing /i.test(detail)) {
    const prepared = detail.replace(/^Preparing /i, "");
    return `┊ ⚡ preparing ${prepared}…  ${elapsed}`;
  }
  if (/^Checking /i.test(detail)) {
    const checked = detail.replace(/^Checking /i, "");
    return `┊ 🔍 checking  ${checked}  ${elapsed}`;
  }
  if (/^Resolved /i.test(detail)) {
    return `┊ 🧠 context   ${detail}  ${elapsed}`;
  }
  if (/^Recalled /i.test(detail)) {
    return `┊ 🧠 recall    ${detail}  ${elapsed}`;
  }
  return `┊ ⚡ working   ${detail}  ${elapsed}`;
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
