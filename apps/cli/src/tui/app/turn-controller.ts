import type { ChatProgressEvent } from "@infinite-os/llm-controller";

import {
  REASONING_PULSE_MS,
  STREAM_BATCH_MS,
  STREAM_IDLE_BATCH_MS,
  STREAM_TYPING_BATCH_MS
} from "../config/timing.js";
import { appendToolShelfMessage, isToolShelfMessage } from "../lib/live-progress.js";
import {
  boundedLiveRenderText,
  buildToolTrailLine,
  compactPreview,
  estimateTokensRough,
  isTransientTrailLine,
  sameToolTrailGroup,
  toolTrailLabel
} from "../lib/text.js";
import { hasReasoningTag, splitReasoning } from "../lib/reasoning.js";
import type { ActiveTool, ActivityItem, Msg, SubagentProgress, TodoItem } from "../types.js";

import { getTurnState, patchTurnState, resetTurnState } from "./turn-store.js";

const ACTIVITY_LIMIT = 8;
const TRAIL_LIMIT = 8;

type Timer = null | ReturnType<typeof setTimeout>;

const clear = (t: Timer): null => {
  if (t) {
    clearTimeout(t);
  }

  return null;
};

const isTodoStatus = (status: unknown): status is TodoItem["status"] =>
  status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled";

const hasDetails = (msg: Msg): boolean => Boolean(msg.thinking || msg.tools?.length || msg.toolTokens);

const assistantSegmentTexts = (segments: readonly Msg[]): string[] =>
  segments.filter((msg) => msg.role === "assistant" && msg.kind !== "diff").map((msg) => msg.text);

// The final `message.complete` text often repeats prose the agent already
// streamed (and which we committed as its own segment mid-turn). Strip the
// already-committed prefix so the closing message only carries what is new,
// avoiding a duplicated paragraph stacked under its own copy.
const finalTail = (finalText: string, segments: readonly Msg[]): string => {
  let tail = finalText;

  for (const text of assistantSegmentTexts(segments)) {
    const trimmed = text.trim();
    if (trimmed && tail.startsWith(trimmed)) {
      tail = tail.slice(trimmed.length).trimStart();
    }
  }

  return tail;
};

const parseTodos = (value: unknown): null | TodoItem[] => {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const status = row.status;

      if (!isTodoStatus(status)) {
        return null;
      }

      return {
        content: String(row.content ?? "").trim(),
        id: String(row.id ?? "").trim(),
        status
      };
    })
    .filter((item): item is TodoItem => Boolean(item?.id && item.content));
};

export class InfiniteTurnController {
  private readonly now: () => number;
  private activeReasoningText = "";
  private activeTools: ActiveTool[] = [];
  private activityId = 0;
  private bufRef = "";
  private pendingSegmentTools: string[] = [];
  private reasoningSegmentIndex: null | number = null;
  private reasoningStreamingTimer: Timer = null;
  private reasoningText = "";
  private reasoningTimer: Timer = null;
  private segmentMessages: Msg[] = [];
  private streamDelay = STREAM_IDLE_BATCH_MS;
  private streamTimer: Timer = null;
  private toolProgressTimer: Timer = null;
  private toolTokenAcc = 0;
  private turnTools: string[] = [];

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  boostStreamingForTyping() {
    this.streamDelay = STREAM_TYPING_BATCH_MS;
  }

  relaxStreaming() {
    this.streamDelay = STREAM_IDLE_BATCH_MS;
  }

  recordProgressEvent(event: ChatProgressEvent) {
    if (!("type" in event)) {
      this.recordStatus(event.message, event.stage === "tool" ? "info" : "info");
      return;
    }

    if (event.type === "tool.generating") {
      this.recordToolGenerating(event.name);
      return;
    }

    if (event.type === "tool.start") {
      this.recordToolStart(event.toolId, event.name, event.context || event.message);
      return;
    }

    if (event.type === "tool.progress") {
      this.recordToolProgress(event.toolId ?? event.name, event.name, event.preview || event.message);
      return;
    }

    if (event.type === "tool.complete") {
      this.recordToolComplete(event.toolId, event.name, event.error, event.summary, event.durationMs, event.status);
      return;
    }

    if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
      this.recordReasoningDelta(event.text);
      return;
    }

    if (event.type === "status.update") {
      this.recordStatus(
        event.text || event.message,
        event.kind === "error" ? "error" : event.kind === "warn" ? "warn" : "info"
      );
      return;
    }

    if (event.type === "message.start") {
      this.startMessage();
      return;
    }

    if (event.type === "message.delta") {
      this.recordMessageDelta({ rendered: event.rendered, text: event.text });
      return;
    }

    if (event.type === "message.complete") {
      return this.recordMessageComplete({
        rendered: event.rendered,
        reasoning: event.reasoning,
        text: event.text
      });
    }

    if (event.type === "subagent.start" || event.type === "subagent.progress" || event.type === "subagent.complete") {
      this.recordSubagentEvent(event);
      return;
    }
  }

  clearReasoning() {
    this.reasoningTimer = clear(this.reasoningTimer);
    this.reasoningStreamingTimer = clear(this.reasoningStreamingTimer);
    this.activeReasoningText = "";
    this.reasoningSegmentIndex = null;
    this.reasoningText = "";
    this.toolTokenAcc = 0;
    patchTurnState({
      reasoning: "",
      reasoningActive: false,
      reasoningStreaming: false,
      reasoningTokens: 0,
      toolTokens: 0
    });
  }

  endReasoningPhase() {
    this.reasoningStreamingTimer = clear(this.reasoningStreamingTimer);
    patchTurnState({ reasoningActive: false, reasoningStreaming: false });
  }

  idle() {
    this.endReasoningPhase();
    this.activeTools = [];
    this.pendingSegmentTools = [];
    this.segmentMessages = [];
    this.streamTimer = clear(this.streamTimer);

    patchTurnState({
      streamPendingTools: [],
      streamSegments: [],
      streaming: "",
      tools: [],
      turnTrail: []
    });
  }

  pruneTransient() {
    this.turnTools = this.turnTools.filter((line) => !isTransientTrailLine(line));
    patchTurnState((state) => {
      const next = state.turnTrail.filter((line) => !isTransientTrailLine(line));

      return next.length === state.turnTrail.length ? state : { ...state, turnTrail: next };
    });
  }

  private syncReasoningSegment() {
    const thinking = this.activeReasoningText.trim();

    if (!thinking) {
      return;
    }

    const msg: Msg = {
      kind: "trail",
      role: "system",
      text: "",
      thinking,
      thinkingTokens: estimateTokensRough(thinking),
      toolTokens: this.toolTokenAcc || undefined
    };

    if (this.reasoningSegmentIndex === null) {
      this.reasoningSegmentIndex = this.segmentMessages.length;
      this.segmentMessages = [...this.segmentMessages, msg];
    } else {
      this.segmentMessages = this.segmentMessages.map((item, index) =>
        index === this.reasoningSegmentIndex ? msg : item
      );
    }

    patchTurnState({ streamSegments: this.segmentMessages });
  }

  private closeReasoningSegment() {
    this.syncReasoningSegment();
    this.activeReasoningText = "";
    this.reasoningSegmentIndex = null;
  }

  private pushSegment(msg: Msg) {
    this.segmentMessages = appendToolShelfMessage(this.segmentMessages, msg);
  }

  // Commit the prose streamed so far (in `bufRef`) as its own transcript
  // segment, then clear the live streaming region for whatever comes next.
  //
  // This is the fix for sequential assistant messages overwriting each other:
  // within a single turn the agent may stream prose, call a tool, then stream
  // more prose. Each prose chunk arrives as `message.delta` into the same live
  // `streaming` region; without flushing, the next `tool.start`/`message.start`
  // wipes that region and only the *final* `message.complete` reaches history.
  // Flushing here anchors each completed chunk into `streamSegments` so they
  // STACK in the transcript (see `flushStreamingSegment`).
  flushStreamingSegment() {
    const raw = this.bufRef.trimStart();
    const split = raw && hasReasoningTag(raw) ? splitReasoning(raw) : { reasoning: "", text: raw };

    if (split.reasoning && !this.reasoningText.trim()) {
      this.reasoningText = split.reasoning;
      this.activeReasoningText = split.reasoning;
      patchTurnState({ reasoning: this.reasoningText, reasoningTokens: estimateTokensRough(this.reasoningText) });
      this.syncReasoningSegment();
    }

    const msg: Msg = {
      role: split.text ? "assistant" : "system",
      text: split.text,
      ...(!split.text && { kind: "trail" as const }),
      ...(this.pendingSegmentTools.length && { tools: this.pendingSegmentTools })
    };

    this.streamTimer = clear(this.streamTimer);

    if (split.text || hasDetails(msg)) {
      this.pushSegment(msg);
    }

    this.pendingSegmentTools = [];
    this.bufRef = "";
    patchTurnState({ streamPendingTools: [], streamSegments: this.segmentMessages, streaming: "" });
  }

  pushActivity(text: string, tone: ActivityItem["tone"] = "info", replaceLabel?: string) {
    const trimmed = compactPreview(text, 96);

    if (!trimmed) {
      return;
    }

    patchTurnState((state) => {
      const base = replaceLabel
        ? state.activity.filter((item) => !sameToolTrailGroup(replaceLabel, item.text))
        : state.activity;

      const tail = base.at(-1);

      if (tail?.text === trimmed && tail.tone === tone) {
        return state;
      }

      return { ...state, activity: [...base, { id: ++this.activityId, text: trimmed, tone }].slice(-ACTIVITY_LIMIT) };
    });
  }

  pushTrail(line: string) {
    patchTurnState((state) => {
      if (state.turnTrail.at(-1) === line) {
        return state;
      }

      const next = [...state.turnTrail.filter((item) => !isTransientTrailLine(item)), line].slice(-TRAIL_LIMIT);

      this.turnTools = next;

      return { ...state, turnTrail: next };
    });
  }

  recordStatus(text: string, tone: ActivityItem["tone"] = "info") {
    this.pushActivity(text, tone);
  }

  recordTodos(value: unknown) {
    const todos = parseTodos(value);

    if (todos !== null) {
      patchTurnState({ todos });
    }
  }

  private recordSubagentEvent(
    event: Extract<ChatProgressEvent, { type: "subagent.start" | "subagent.progress" | "subagent.complete" }>
  ) {
    const status = event.subagent.status ?? (
      event.type === "subagent.complete" ? "completed" : event.type === "subagent.start" ? "running" : undefined
    );

    patchTurnState((state) => {
      const existing = state.subagents.find((item) => item.id === event.subagent.id);
      const parentId = event.subagent.parentId ?? existing?.parentId ?? null;
      const parent = parentId ? state.subagents.find((item) => item.id === parentId) : undefined;
      const depth = event.subagent.depth ?? existing?.depth ?? (parent ? parent.depth + 1 : 0);
      const index = event.subagent.index ?? existing?.index ?? state.subagents.filter((item) =>
        (item.parentId ?? null) === parentId && item.depth === depth
      ).length;
      const startedAt = event.subagent.startedAt ?? existing?.startedAt ?? (event.type === "subagent.start" ? this.now() : undefined);
      const durationSeconds = event.subagent.durationMs !== undefined
        ? event.subagent.durationMs / 1000
        : existing?.durationSeconds ?? (
          event.type === "subagent.complete" && startedAt !== undefined ? (this.now() - startedAt) / 1000 : undefined
        );
      const next: SubagentProgress = {
        apiCalls: event.subagent.apiCalls ?? existing?.apiCalls,
        costUsd: event.subagent.costUsd ?? existing?.costUsd,
        depth,
        durationSeconds,
        filesRead: event.subagent.filesRead ?? existing?.filesRead,
        filesWritten: event.subagent.filesWritten ?? existing?.filesWritten,
        id: event.subagent.id,
        index,
        inputTokens: event.subagent.inputTokens ?? existing?.inputTokens,
        iteration: event.subagent.iteration ?? existing?.iteration,
        model: event.subagent.model ?? existing?.model,
        notes: event.subagent.notes ?? existing?.notes ?? [],
        outputTail: event.subagent.outputTail?.map((output) => ({
          isError: Boolean(output.isError),
          preview: output.preview,
          tool: output.tool
        })) ?? existing?.outputTail,
        outputTokens: event.subagent.outputTokens ?? existing?.outputTokens,
        parentId,
        reasoningTokens: event.subagent.reasoningTokens ?? existing?.reasoningTokens,
        startedAt,
        status: status ?? existing?.status ?? "running",
        summary: event.subagent.summary ?? existing?.summary ?? event.message,
        taskCount: event.subagent.taskCount ?? existing?.taskCount ?? 1,
        thinking: event.subagent.thinking ?? existing?.thinking ?? [],
        toolCount: event.subagent.toolCount ?? existing?.toolCount ?? event.subagent.tools?.length ?? existing?.tools?.length ?? 0,
        tools: event.subagent.tools ?? existing?.tools ?? [],
        toolsets: event.subagent.toolsets ?? existing?.toolsets
      };

      const withoutExisting = state.subagents.filter((item) => item.id !== next.id);
      return {
        ...state,
        subagents: [...withoutExisting, next].sort((a, b) => a.depth - b.depth || a.index - b.index)
      };
    });

    if (event.type === "subagent.start") {
      this.pushActivity(`delegating ${event.subagent.summary ?? event.subagent.id}`);
    } else if (event.type === "subagent.complete") {
      this.pushActivity(`subagent ${event.subagent.status === "completed" || !event.subagent.status ? "complete" : event.subagent.status}: ${event.subagent.summary ?? event.subagent.id}`);
    }
  }

  private flushPendingToolsIntoLastSegment() {
    if (!this.pendingSegmentTools.length) {
      return false;
    }

    const next = appendToolShelfMessage(this.segmentMessages, {
      kind: "trail",
      role: "system",
      text: "",
      tools: this.pendingSegmentTools
    });

    if (next.length === this.segmentMessages.length + 1) {
      return false;
    }

    this.segmentMessages = next;
    this.pendingSegmentTools = [];
    patchTurnState({ streamPendingTools: [], streamSegments: this.segmentMessages });

    return true;
  }

  pulseReasoningStreaming() {
    this.reasoningStreamingTimer = clear(this.reasoningStreamingTimer);
    patchTurnState({ reasoningActive: true, reasoningStreaming: true });

    this.reasoningStreamingTimer = setTimeout(() => {
      this.reasoningStreamingTimer = null;
      patchTurnState({ reasoningStreaming: false });
    }, REASONING_PULSE_MS);
  }

  recordReasoningDelta(text: string) {
    // A fresh reasoning phase that follows streamed prose means the agent
    // finished an assistant message and is now thinking again. Commit that
    // prose (and any pending tools) as its own segment so it stacks above the
    // upcoming reasoning instead of being overwritten.
    if (!this.activeReasoningText.trim() && (this.bufRef.trim() || this.pendingSegmentTools.length)) {
      this.flushStreamingSegment();
    }

    this.reasoningText += text;
    this.activeReasoningText += text;

    if (this.reasoningText.length > 80_000) {
      this.reasoningText = this.reasoningText.slice(-60_000);
    }

    this.scheduleReasoning();
    this.syncReasoningSegment();
    this.pulseReasoningStreaming();
  }

  recordToolGenerating(name: string) {
    const label = toolTrailLabel(name);
    this.pushTrail(`drafting ${label}…`);
    this.pushActivity(`drafting ${label}`, "info", label);
  }

  recordToolProgress(toolId: string, toolName: string, preview: string) {
    const index = this.activeTools.findIndex((tool) => tool.id === toolId || tool.name === toolName);

    if (index < 0) {
      return;
    }

    this.activeTools = this.activeTools.map((tool, i) => (i === index ? {
      ...tool,
      latestPreview: preview,
      progressCount: (tool.progressCount ?? 0) + 1,
      updatedAt: this.now()
    } : tool));

    patchTurnState({ tools: [...this.activeTools] });

    if (this.toolProgressTimer) {
      return;
    }

    this.toolProgressTimer = setTimeout(() => {
      this.toolProgressTimer = null;
      patchTurnState({ tools: [...this.activeTools] });
    }, STREAM_BATCH_MS);
  }

  recordToolStart(toolId: string, name: string, context: string) {
    this.flushStreamingSegment();
    this.closeReasoningSegment();
    this.pruneTransient();
    this.endReasoningPhase();

    const sample = `${name} ${context}`.trim();

    this.toolTokenAcc += sample ? estimateTokensRough(sample) : 0;
    this.activeTools = [
      ...this.activeTools.filter((tool) => tool.id !== toolId),
      { context, id: toolId, name, progressCount: 0, startedAt: this.now(), updatedAt: this.now() }
    ];

    patchTurnState({ toolTokens: this.toolTokenAcc, tools: this.activeTools });
  }

  recordToolComplete(
    toolId: string,
    fallbackName?: string,
    error?: string,
    summary?: string,
    durationMs?: number,
    status?: string,
    todos?: unknown
  ) {
    this.recordTodos(todos);
    const line = this.completeTool(toolId, fallbackName, error || (status === "error" ? summary : undefined), summary, durationMs);

    this.pendingSegmentTools = [...this.pendingSegmentTools, line];
    this.flushPendingToolsIntoLastSegment();
    this.publishToolState();
  }

  private completeTool(toolId: string, fallbackName?: string, error?: string, summary?: string, durationMs?: number) {
    const done = this.activeTools.find((tool) => tool.id === toolId);
    const name = done?.name ?? fallbackName ?? "tool";
    const label = toolTrailLabel(name);
    const fallbackDuration = done?.startedAt ? (this.now() - done.startedAt) / 1000 : undefined;

    const line = buildToolTrailLine(
      name,
      done?.latestPreview || done?.context || "",
      Boolean(error),
      error || summary || "",
      durationMs !== undefined ? durationMs / 1000 : fallbackDuration
    );

    this.activeTools = this.activeTools.filter((tool) => tool.id !== toolId);

    const next = this.turnTools.filter((item) => !sameToolTrailGroup(label, item));

    if (!this.activeTools.length) {
      next.push("analyzing tool output…");
    }

    this.turnTools = next.slice(-TRAIL_LIMIT);

    return line;
  }

  private publishToolState() {
    patchTurnState({
      streamPendingTools: this.pendingSegmentTools,
      tools: this.activeTools,
      turnTrail: this.turnTools
    });
  }

  recordMessageDelta({ rendered, text }: { rendered?: string; text?: string }) {
    this.pruneTransient();
    this.endReasoningPhase();

    if (!text && !rendered) {
      return;
    }

    this.bufRef = rendered ?? `${this.bufRef}${text ?? ""}`;
    const raw = this.bufRef.trimStart();
    const split = raw && hasReasoningTag(raw) ? splitReasoning(raw) : { reasoning: "", text: raw };

    if (split.reasoning && !this.reasoningText.trim()) {
      this.reasoningText = split.reasoning;
      this.activeReasoningText = split.reasoning;
      this.syncReasoningSegment();
      this.scheduleReasoning();
    }

    this.scheduleStreaming();
  }

  recordMessageComplete(payload: { reasoning?: string; rendered?: string; text?: string } = {}) {
    this.closeReasoningSegment();
    const rawText = (payload.rendered ?? payload.text ?? this.bufRef).trimStart();
    const split = rawText && hasReasoningTag(rawText)
      ? splitReasoning(rawText)
      : { reasoning: "", text: rawText };

    let tools = this.pendingSegmentTools;
    const last = this.segmentMessages[this.segmentMessages.length - 1];

    if (tools.length && isToolShelfMessage(last)) {
      this.segmentMessages = [
        ...this.segmentMessages.slice(0, -1),
        { ...last, tools: [...(last.tools ?? []), ...tools] }
      ];
      this.pendingSegmentTools = [];
      tools = [];
    }

    // Reasoning that already streamed into its own committed segment must not
    // be duplicated as the final message's trailing thinking block.
    const hasReasoningSegment =
      this.reasoningSegmentIndex !== null || this.segmentMessages.some((msg) => Boolean(msg.thinking?.trim()));
    const savedReasoning = this.reasoningText.trim() || String(payload.reasoning ?? "").trim() || split.reasoning;
    const finalThinking = hasReasoningSegment ? "" : savedReasoning;
    const finalDetails: Msg = {
      kind: "trail",
      role: "system",
      text: "",
      thinking: finalThinking || undefined,
      thinkingTokens: finalThinking ? estimateTokensRough(finalThinking) : undefined,
      toolTokens: this.toolTokenAcc || undefined,
      ...(tools.length && { tools })
    };

    // Strip any prose the final text repeats from segments already committed
    // mid-turn, so a closing recap doesn't stack a duplicate paragraph under
    // its own copy.
    const finalText = finalTail(split.text.trimStart(), this.segmentMessages);

    const finalMessages: Msg[] = [...this.segmentMessages];

    if (hasDetails(finalDetails)) {
      finalMessages.push(finalDetails);
    }

    if (finalText.trim()) {
      finalMessages.push({ role: "assistant", text: finalText });
    }

    this.reset();

    return { finalMessages, finalText };
  }

  reset() {
    this.toolProgressTimer = clear(this.toolProgressTimer);
    this.clearReasoning();
    this.idle();
    this.activeReasoningText = "";
    this.activeTools = [];
    this.bufRef = "";
    this.pendingSegmentTools = [];
    this.reasoningSegmentIndex = null;
    this.reasoningText = "";
    this.segmentMessages = [];
    this.streamTimer = clear(this.streamTimer);
    this.streamDelay = STREAM_IDLE_BATCH_MS;
    this.turnTools = [];
    this.toolTokenAcc = 0;
    patchTurnState({ activity: [], outcome: "" });
  }

  fullReset() {
    this.reset();
    resetTurnState();
  }

  scheduleReasoning() {
    if (this.reasoningTimer) {
      return;
    }

    this.reasoningTimer = setTimeout(() => {
      this.reasoningTimer = null;
      patchTurnState({
        reasoning: this.reasoningText,
        reasoningTokens: estimateTokensRough(this.reasoningText)
      });
    }, STREAM_BATCH_MS);

    patchTurnState({
      reasoning: this.reasoningText,
      reasoningTokens: estimateTokensRough(this.reasoningText)
    });
  }

  scheduleStreaming() {
    if (this.streamTimer) {
      return;
    }

    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      const raw = this.bufRef.trimStart();
      const visible = raw && hasReasoningTag(raw) ? splitReasoning(raw).text : raw;
      patchTurnState({ streaming: boundedLiveRenderText(visible) });
    }, this.streamDelay);
  }

  startMessage() {
    this.endReasoningPhase();
    // A new assistant message is beginning. If prose from the previous message
    // is still sitting in the live region (no intervening tool call flushed
    // it), commit it as its own segment first — otherwise clearing `streaming`
    // below would discard it and the messages would overwrite in place.
    if (this.bufRef.trim()) {
      this.flushStreamingSegment();
    }
    this.bufRef = "";
    this.streamTimer = clear(this.streamTimer);
    this.pruneTransient();
    patchTurnState({ streaming: "" });
  }
}

export const turnController = new InfiniteTurnController();

export { getTurnState, resetTurnState };
