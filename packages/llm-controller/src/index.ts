import { createHash, randomUUID } from "node:crypto";
import {
  type ActionDefinition,
  type ActionEnvelope,
  type ActionRegistry,
  type RuntimeSurface,
  createSessionContext
} from "@infinite-os/runtime";
import { createConfiguredModelClient } from "./model-client.js";
import { assembleInfiniteOsPrompt } from "./prompt-assembler.js";
import type { InfiniteOsMemoryManager } from "./memory-manager.js";
import {
  buildQueryRefinementSections,
  buildQuerySynthesisSections,
  type QueryFamily,
  classifyQueryFamily,
  type InfiniteOsQueryAdvisor
} from "./query-advisor.js";
import type { ChatResponse } from "@infinite-os/types";
import type { ChatSessionStore } from "./session-store.js";

// `ChatResponse` is canonical in `@infinite-os/types` (the cross-zone contract
// the desktop also consumes). Re-export it so engine callers keep importing it
// from `@infinite-os/llm-controller` unchanged. The local `ChatActionCall` /
// `ModelUsage` shapes below stay engine-internal and are structurally identical
// to the contract copies, so internally-built `ChatResponse` objects still type.
export type { ChatResponse } from "@infinite-os/types";

export type {
  ChatSessionDetail,
  ChatSessionListItem,
  ChatSessionSearchResult,
  ChatSessionStore,
  CompactSessionInput,
  CompactSessionResult
} from "./session-store.js";
export { createSessionStore } from "./session-store.js";
export { createConfiguredModelClient } from "./model-client.js";
export { assembleInfiniteOsPrompt } from "./prompt-assembler.js";
export { createSourceAwareQueryAdvisor } from "./query-advisor.js";
export {
  createModelBackedMemoryReviewer,
  createCuratedMemoryManager,
  filterCuratedMemoryCandidates
} from "./memory-manager.js";
export type {
  CuratedMemoryCandidate,
  CuratedMemoryFact,
  CuratedMemoryScope,
  InfiniteOsMemoryManager,
  MemoryReviewInput
} from "./memory-manager.js";
export type {
  InfiniteOsQueryAdvisor,
  QueryAdvisorInput,
  QueryAdvisorResponse
} from "./query-advisor.js";

export type ChatProgressMode = "legacy" | "rich" | "both";
export type ChatProgressStage = "recall" | "resolve" | "tool" | "thinking" | "status" | "message" | "subagent";
export type ChatProgressStatusKind = "status" | "info" | "warn" | "error" | "approval";

export interface LegacyChatProgressEvent {
  stage: "recall" | "resolve" | "tool";
  message: string;
}

export interface ToolGeneratingProgressEvent {
  type: "tool.generating";
  stage: "tool";
  message: string;
  name: string;
}

export interface ToolStartProgressEvent {
  type: "tool.start";
  stage: "tool";
  message: string;
  toolId: string;
  name: string;
  context: string;
}

export interface ToolProgressProgressEvent {
  type: "tool.progress";
  stage: "tool";
  message: string;
  toolId?: string;
  name: string;
  preview: string;
}

export interface ToolCompleteProgressEvent {
  type: "tool.complete";
  stage: "tool";
  message: string;
  toolId: string;
  name: string;
  durationMs: number;
  summary?: string;
  error?: string;
  status?: ActionEnvelope["status"] | "requires_confirmation" | "error";
}

export interface ThinkingDeltaProgressEvent {
  type: "thinking.delta" | "reasoning.delta";
  stage: "thinking";
  message: string;
  text: string;
}

export interface StatusUpdateProgressEvent {
  type: "status.update";
  stage: Exclude<ChatProgressStage, "tool" | "thinking" | "message">;
  message: string;
  kind: ChatProgressStatusKind;
  text: string;
}

export interface MessageStartProgressEvent {
  type: "message.start";
  stage: "message";
  message: string;
}

export interface MessageDeltaProgressEvent {
  type: "message.delta";
  stage: "message";
  message: string;
  rendered?: string;
  text: string;
}

export interface MessageCompleteProgressEvent {
  type: "message.complete";
  stage: "message";
  message: string;
  reasoning?: string;
  rendered?: string;
  text: string;
  usage?: ModelUsage;
}

export type SubagentProgressStatus = "completed" | "error" | "failed" | "interrupted" | "queued" | "running" | "timeout";

export interface SubagentOutputProgressEntry {
  isError?: boolean;
  preview: string;
  tool: string;
}

export interface SubagentProgressSnapshot {
  apiCalls?: number;
  costUsd?: number;
  depth?: number;
  durationMs?: number;
  filesRead?: string[];
  filesWritten?: string[];
  id: string;
  index?: number;
  inputTokens?: number;
  iteration?: number;
  model?: string;
  notes?: string[];
  outputTail?: SubagentOutputProgressEntry[];
  outputTokens?: number;
  parentId?: null | string;
  reasoningTokens?: number;
  startedAt?: number;
  status?: SubagentProgressStatus;
  summary?: string;
  taskCount?: number;
  thinking?: string[];
  toolCount?: number;
  tools?: string[];
  toolsets?: string[];
}

export interface SubagentStartProgressEvent {
  type: "subagent.start";
  stage: "subagent";
  message: string;
  subagent: SubagentProgressSnapshot;
}

export interface SubagentProgressProgressEvent {
  type: "subagent.progress";
  stage: "subagent";
  message: string;
  subagent: SubagentProgressSnapshot;
}

export interface SubagentCompleteProgressEvent {
  type: "subagent.complete";
  stage: "subagent";
  message: string;
  subagent: SubagentProgressSnapshot;
}

export type InfiniteChatProgressEvent =
  | ToolGeneratingProgressEvent
  | ToolStartProgressEvent
  | ToolProgressProgressEvent
  | ToolCompleteProgressEvent
  | ThinkingDeltaProgressEvent
  | StatusUpdateProgressEvent
  | MessageStartProgressEvent
  | MessageDeltaProgressEvent
  | MessageCompleteProgressEvent
  | SubagentStartProgressEvent
  | SubagentProgressProgressEvent
  | SubagentCompleteProgressEvent;

export type ChatProgressEvent = LegacyChatProgressEvent | InfiniteChatProgressEvent;

export interface InfiniteOsToolSchema {
  name: string;
  title: string;
  summary: string;
  authority: "tool_agent" | "operator";
  inputSchema: Record<string, unknown>;
}

export interface ScopedAppToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ScopedAppTools {
  serverName: string;
  allowedTools: string[];
  tools: ScopedAppToolDefinition[];
  // How the injected app tools compose with the engine's native action registry.
  //   "exclusive" (default when absent) — the turn runs over ONLY the scoped app
  //     tools; the native registry is hidden and native calls fail closed. This is
  //     the locked, EPHEMERAL ads sub-agent contract (no session memory).
  //   "union" — the turn runs over the UNION of the native registry AND the scoped
  //     app tools, and persists like a normal chat turn (memory/recall/advisor).
  //     This is the Codex chat keystone: chat gets the engine's analytics AND the
  //     desktop's app tools together. Native wins on any (structurally impossible)
  //     name collision — see unionActionSet.
  mode?: "exclusive" | "union";
  callTool: (
    toolName: string,
    input: unknown,
    context?: { toolCallId: string; modelName: string }
  ) => Promise<unknown>;
}

interface NormalizedScopedAppTool {
  modelName: string;
  rawName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface NormalizedScopedAppTools {
  serverName: string;
  allowedTools: string[];
  // Resolved mode — absent on the wire ⇒ "exclusive" (preserves the ads sub-agent
  // contract). Only "union" opens the native registry + persistence.
  mode: "exclusive" | "union";
  tools: NormalizedScopedAppTool[];
  toolsByModelName: Map<string, NormalizedScopedAppTool>;
  callTool: ScopedAppTools["callTool"];
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResult {
  id: string;
  name: string;
  result:
    | ActionEnvelope
    | {
        status: "error";
        actionId: string;
        input: unknown;
        error: { code: string; message: string };
      }
    | {
        status: "requires_confirmation";
        actionId: string;
        input: unknown;
        confirmationId?: string;
        inputHash?: string;
      };
}

export interface TurnModel {
  modelId: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ModelRequest {
  model?: TurnModel;
  systemPrompt: string;
  userMessage: string;
  tools: InfiniteOsToolSchema[];
  toolResults: ModelToolResult[];
  onMessageDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (event: InfiniteChatProgressEvent) => Promise<void> | void;
  onReasoningDelta?: (delta: string) => Promise<void> | void;
  // Stable cache key for provider-side prompt prefix caching (Codex
  // `prompt_cache_key`). The chat loop passes the sessionId — stable across a
  // session's turns — so the large stable prefix is reused instead of
  // re-processed each turn. Optional: absent for non-chat/keyless callers.
  promptCacheKey?: string;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface ModelResponse {
  message?: string;
  toolCalls?: ModelToolCall[];
  usage?: ModelUsage;
}

export interface InfiniteOsModelClient {
  complete: (request: ModelRequest) => Promise<ModelResponse>;
  modelMetadata?: (model?: TurnModel) => { provider?: "codex" | "claude"; model?: string; authSource?: string };
}

export interface ChatInput {
  memoryModel?: TurnModel;
  /** Cumulative measured usage, emitted once per completed model invocation. */
  onUsage?: (usage: ModelUsage) => Promise<void> | void;
  model?: TurnModel;
  message: string;
  sessionId?: string;
  workspaceId: string;
  actorId: string;
  surface: Extract<RuntimeSurface, "api" | "app" | "cli" | "desktop">;
  modelProvider?: "codex" | "claude";
  modelName?: string;
  modelAuthSource?: string;
  progressMode?: ChatProgressMode;
  scopedAppTools?: ScopedAppTools;
  onProgress?: (event: ChatProgressEvent) => Promise<void> | void;
}

export interface ChatActionCall {
  id: string;
  actionId: string;
  input: unknown;
  status: ActionEnvelope["status"] | "requires_confirmation" | "error";
  requiresConfirmation: boolean;
  confirmationId?: string;
  inputHash?: string;
  envelope?: ActionEnvelope;
  error?: { code: string; message: string };
}

const RECENT_SYNC_LOOKUP_LIMIT = 20;
const FAMILY_PROVIDERS: Partial<Record<QueryFamily, string[]>> = {
  best_post: ["x"],
  follower_count: ["x"],
  comment_count: ["x"],
  post_count: ["x"],
  recognized_revenue: ["stripe"],
  revenue_source: ["stripe"],
  site_visitors: ["google_analytics_4"],
  visitor_channel_breakdown: ["google_analytics_4"],
  signup_count: ["posthog"],
  signup_channel_breakdown: ["posthog"],
  // Same-lane rule (engine 0062): the conversion rate divides GA4 key events by GA4 visitors —
  // PostHog is no longer an input, so a missing PostHog source must not block conversion answers.
  site_conversion_rate: ["google_analytics_4"],
  conversion_channel_breakdown: ["google_analytics_4"]
};
const PLANNED_PROGRESS_LABELS: Partial<Record<QueryFamily, string>> = {
  best_post: "Running engagement breakdown.",
  follower_count: "Running follower lookup.",
  comment_count: "Running authored comment count.",
  post_count: "Running authored post count.",
  revenue_source: "Running revenue-by-source breakdown.",
  recognized_revenue: "Running revenue total lookup.",
  source_status: "Running source status check.",
  visitor_channel_breakdown: "Running traffic channel breakdown.",
  site_visitors: "Running site traffic lookup.",
  signup_channel_breakdown: "Running signup channel breakdown.",
  signup_count: "Running signup lookup.",
  conversion_channel_breakdown: "Running conversion-rate channel breakdown.",
  site_conversion_rate: "Running conversion-rate lookup."
};
export interface LlmController {
  chat: (input: ChatInput) => Promise<ChatResponse>;
}

export function createLlmController(options: {
  registry: ActionRegistry;
  modelClient?: InfiniteOsModelClient;
  sessionStore?: ChatSessionStore;
  memoryManager?: InfiniteOsMemoryManager;
  queryAdvisor?: InfiniteOsQueryAdvisor;
  maxToolIterations?: number;
  now?: () => Date;
  // Scheduling of the post-turn durable-memory harvest (`reviewMemory`), which
  // only feeds FUTURE turns' prompts and never the current answer:
  //   "background" (default) — fire-and-forget AFTER the answer is emitted, so a
  //     turn returns as soon as the user-visible message + token usage are out
  //     (the harvest was measured adding p50 ~2.6s / max ~20s of dead spinner).
  //   "blocking" — await the harvest before the turn resolves. Used by tests so
  //     `chat_memory_facts` insert assertions after `chat()` are deterministic
  //     without sleeps or polling. Not used in production.
  memoryReview?: "blocking" | "background";
}): LlmController {
  const modelClient = options.modelClient ?? createConfiguredModelClient();
  const sessionStore = options.sessionStore;
  const memoryManager = options.memoryManager;
  const maxToolIterations = options.maxToolIterations ?? 8;
  const memoryReviewMode = options.memoryReview ?? "background";
  const now = options.now ?? (() => new Date());
  return {
    async chat(input) {
      let lastProgressKey: string | undefined;
      const progressMode = input.progressMode ?? "legacy";
      const wantsLegacyProgress = progressMode === "legacy" || progressMode === "both";
      const wantsInfiniteProgress = progressMode === "rich" || progressMode === "both";
      const emitRaw = async (event: ChatProgressEvent) => {
        const key = progressEventKey(event);
        if (shouldDedupeProgressEvent(event) && key === lastProgressKey) {
          return;
        }
        lastProgressKey = key;
        await emitProgress(input, event);
      };
      const emitLegacy = async (event: LegacyChatProgressEvent) => {
        if (wantsLegacyProgress) {
          await emitRaw(event);
        }
      };
      const emitInfinite = async (event: InfiniteChatProgressEvent) => {
        if (wantsInfiniteProgress) {
          await emitRaw(event);
        }
      };
      const emitStatus = async (
        stage: StatusUpdateProgressEvent["stage"],
        message: string,
        kind: ChatProgressStatusKind = "status"
      ) => {
        if (stage === "recall" || stage === "resolve") {
          await emitLegacy({ stage, message });
        }
        await emitInfinite({ type: "status.update", stage, message, kind, text: message });
      };
      const emitAssistantMessageStart = async () => {
        await emitInfinite({ type: "message.start", stage: "message", message: "Assistant message started." });
      };
      const emitAssistantMessageDelta = async (delta: string) => {
        await emitInfinite({ type: "message.delta", stage: "message", message: delta, text: delta });
      };
      const emitAssistantMessage = async (
        message: string,
        eventUsage?: ModelUsage,
        options: { alreadyStreamed?: boolean } = {}
      ) => {
        if (!options.alreadyStreamed) {
          await emitAssistantMessageStart();
          await emitAssistantMessageDelta(message);
        }
        await emitInfinite({
          type: "message.complete",
          stage: "message",
          message: "Assistant message complete.",
          text: message,
          usage: eventUsage
        });
      };
      const sessionId = input.sessionId ?? `${input.surface}_${randomUUID()}`;
      const scopedInput = { ...input, sessionId };
      const selectedMetadata = modelClient.modelMetadata?.(input.model);
      const modelMetadata = input.model
        ? { provider: "codex" as const, model: input.model.modelId,
            ...(selectedMetadata?.provider === "codex" ? { authSource: selectedMetadata.authSource } : {}) }
        : selectedMetadata;
      const scopedAppTools = normalizeScopedAppTools(input.scopedAppTools);
      // A plain chat turn (no scoped app tools) persists. A scoped turn persists ONLY
      // in "union" mode — Codex chat needs session memory + recall + advisor exactly
      // like a normal turn. "exclusive" scoped turns (the ads sub-agent) stay EPHEMERAL:
      // no session rows, no recall, no memory review. Every persistTurn use below is
      // gated on this so union turns get the full chat lifecycle and exclusive turns none.
      const persistTurn = !scopedAppTools || scopedAppTools.mode === "union";
      const responseMetadata = (usage?: ModelUsage) => ({
        ...(usage ? { usage } : {}),
        ...(input.modelProvider ?? modelMetadata?.provider ? { modelProvider: input.modelProvider ?? modelMetadata?.provider } : {}),
        ...(input.modelName ?? modelMetadata?.model ? { modelName: input.modelName ?? modelMetadata?.model } : {}),
        ...(input.modelAuthSource ?? modelMetadata?.authSource ? { modelAuthSource: input.modelAuthSource ?? modelMetadata?.authSource } : {})
      });
      await sessionStore?.ensureSession({
        sessionId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        surface: input.surface,
        modelProvider: input.modelProvider ?? modelMetadata?.provider,
        modelName: input.modelName ?? modelMetadata?.model,
        modelAuthSource: input.modelAuthSource ?? modelMetadata?.authSource
      });
      const priorSession = persistTurn ? await sessionStore?.getSession(sessionId) : undefined;
      let recalledSessions = persistTurn ? await loadSessionRecall(sessionStore, input, sessionId) : undefined;
      const memoryContext = persistTurn ? await loadMemoryContext(memoryManager, input, sessionId) : undefined;
      if ((recalledSessions?.length ?? 0) > 0) {
        await emitStatus("recall", "Recalled prior session context.");
      }
      if (persistTurn) {
        await sessionStore?.appendMessage({
          sessionId,
          role: "user",
          content: input.message
        });
      }
      const advisory = persistTurn
        ? await loadQueryAdvisory(options.queryAdvisor, {
            message: input.message,
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            sessionId,
            surface: input.surface,
            now: now(),
            recentMessages: priorSession?.messages
          })
        : undefined;
      const effectiveMessage = advisory?.effectiveMessage ?? input.message;
      // Kick off the post-turn durable-memory harvest. Callers MUST invoke this
      // only AFTER the user-visible message + token usage have been emitted: in
      // the default "background" mode it is fire-and-forget (the returned promise
      // resolves immediately; `reviewMemory` swallows its own errors and never
      // rejects, so the detached work is safe), which keeps the harvest off the
      // turn's critical path. "blocking" awaits it for deterministic tests.
      const scheduleMemoryReview = async (message: string, calls: ChatActionCall[]) => {
        const review = reviewMemory(memoryManager, input, sessionId, message, calls, effectiveMessage);
        if (memoryReviewMode === "blocking") {
          await review;
        } else {
          void review;
        }
      };
      if (persistTurn && effectiveMessage !== input.message) {
        if (sessionStore) {
          await emitStatus("resolve", "Preparing recall lookup.");
        }
        const effectiveRecall = await loadSessionRecallForMessage(
          sessionStore,
          input.workspaceId,
          effectiveMessage,
          sessionId
        );
        if ((effectiveRecall?.length ?? 0) > 0 && (recalledSessions?.length ?? 0) === 0) {
          await emitStatus("recall", "Recalled prior session context.");
        }
        recalledSessions = effectiveRecall;
      }
      for (const note of advisory?.progressNotes ?? []) {
        await emitStatus("resolve", note);
      }
      if (advisory?.message) {
        const message = advisory.message;
        if (persistTurn) {
          await sessionStore?.appendMessage({
            sessionId,
            role: "assistant",
            content: message
          });
        }
        await emitAssistantMessage(message);
        if (persistTurn) {
          await scheduleMemoryReview(message, []);
        }
        return {
          ok: true,
          sessionId,
          message,
          provenance: [],
          actionCalls: [],
          ...responseMetadata()
        };
      }
      // Action set is mode-aware:
      //   no scoped tools        ⇒ the native registry (a plain chat turn).
      //   scoped "exclusive"     ⇒ ONLY the scoped app tools (ads sub-agent; native hidden).
      //   scoped "union"         ⇒ native registry ∪ scoped app tools (Codex chat keystone),
      //                            with native winning on any name collision.
      const actions = scopedAppTools
        ? scopedAppTools.mode === "union"
          ? unionActionSet(options.registry, scopedAppTools)
          : scopedAppToolActions(scopedAppTools)
        : options.registry.list();
      const tools = toolSchemas(actions);
      const actionCalls: ChatActionCall[] = [];
      const toolResults: ModelToolResult[] = [];
      let usage: ModelResponse["usage"];
      try {
        for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
          const refinementSections = buildQueryRefinementSections(effectiveMessage, toolResults);
          const synthesisSections = buildQuerySynthesisSections(effectiveMessage, toolResults);
          if (iteration > 0 && refinementSections.length > 0) {
            await emitStatus("resolve", refinementProgressMessage(refinementSections));
          }
          const prompt = assembleInfiniteOsPrompt({
            actions,
            workspaceId: input.workspaceId,
            surface: input.surface,
            currentDate: now().toISOString().slice(0, 10),
            modelProvider: input.modelProvider ?? modelMetadata?.provider,
            recentMessages: priorSession?.messages,
            compactedSummaries: priorSession?.summaries,
            recalledSessions,
            curatedMemory: memoryContext,
            advisories: [...(advisory?.promptSections ?? []), ...refinementSections, ...synthesisSections]
          });
          const streamState = { messageStarted: false };
          const response = await modelClient.complete({
            model: input.model,
            systemPrompt: prompt,
            userMessage: effectiveMessage,
            tools,
            toolResults,
            // Stable across every turn of this session → lets the provider reuse its
            // cached prompt prefix instead of re-processing it each turn.
            promptCacheKey: sessionId,
            onMessageDelta: async (delta) => {
              if (!delta) {
                return;
              }
              if (!streamState.messageStarted) {
                streamState.messageStarted = true;
                await emitAssistantMessageStart();
              }
              await emitAssistantMessageDelta(delta);
            },
            onProgress: async (event) => emitInfinite(event),
            onReasoningDelta: async (delta) => {
              if (!delta) {
                return;
              }
              await emitInfinite({
                type: "reasoning.delta",
                stage: "thinking",
                message: delta,
                text: delta
              });
            }
          });
          usage = mergeUsage(usage, response.usage);
          if (usage) await input.onUsage?.(usage);
          if (!response.toolCalls?.length) {
            const message = response.message ??
              "I need more information before I can answer.";
            if (persistTurn) {
              await sessionStore?.appendMessage({
                sessionId,
                role: "assistant",
                content: message,
                tokenCount: usage?.completionTokens
              });
              await recordTokenUsage(sessionStore, sessionId, usage);
            }
            await emitAssistantMessage(message, usage, { alreadyStreamed: streamState.messageStarted });
            if (persistTurn) {
              await scheduleMemoryReview(message, actionCalls);
            }
            return {
              ok: true,
              sessionId,
              message,
              provenance: unique(actionCalls.flatMap((call) => call.envelope?.provenance ?? [])),
              actionCalls,
              ...responseMetadata(usage)
            };
          }
          const progressLabels = new Map<string, string>();
          for (const call of response.toolCalls) {
            const actionId = normalizeToolCallName(call.name, options.registry, scopedAppTools);
            const message = toolCallProgressMessage(effectiveMessage, call, options.registry, scopedAppTools);
            progressLabels.set(call.id, message);
            await emitLegacy({ stage: "tool", message });
            await emitInfinite({
              type: "tool.generating",
              stage: "tool",
              message: `Drafting ${actionId}.`,
              name: actionId
            });
          }
          const nextCalls = await executeToolCalls(options.registry, response.toolCalls, scopedInput, {
            scopedAppTools,
            progressLabels,
            nowMs: () => now().getTime(),
            emitToolStart: async (event) => emitInfinite(event),
            emitToolProgress: async (event) => emitInfinite(event),
            emitToolComplete: async (event) => emitInfinite(event)
          });
          for (const call of nextCalls) {
            if (persistTurn) {
              await sessionStore?.recordActionCall({
                sessionId,
                providerToolCallId: call.id,
                actionId: call.actionId,
                authority: call.requiresConfirmation ? "operator" : "tool_agent",
                input: call.input,
                outputEnvelope: call.envelope,
                status: call.status,
                requiresConfirmation: call.requiresConfirmation,
                confirmationId: call.confirmationId,
                inputHash: call.inputHash,
                // P0-A: pin the action call to the authoring workspace so the confirm
                // path can fail closed on a cross-workspace confirmation.
                workspaceId: input.workspaceId
              });
            }
            actionCalls.push(call);
            toolResults.push(modelToolResult(call));
          }
          if (nextCalls.some((call) => call.requiresConfirmation)) {
            const message = "This request includes an operator action that requires confirmation before execution.";
            if (persistTurn) {
              await sessionStore?.appendMessage({
                sessionId,
                role: "assistant",
                content: message,
                tokenCount: usage?.completionTokens
              });
              await recordTokenUsage(sessionStore, sessionId, usage);
            }
            await emitAssistantMessage(message, usage);
            if (persistTurn) {
              await scheduleMemoryReview(message, actionCalls);
            }
            return {
              ok: true,
              sessionId,
              message,
              provenance: [],
              actionCalls,
              ...responseMetadata(usage)
            };
          }
        }
        const message = "I reached the Infinite OS typed-action iteration limit before I could finish the answer.";
        if (persistTurn) {
          await sessionStore?.appendMessage({
            sessionId,
            role: "assistant",
            content: message,
            tokenCount: usage?.completionTokens
          });
          await recordTokenUsage(sessionStore, sessionId, usage);
        }
        await emitAssistantMessage(message, usage);
        if (persistTurn) {
          await scheduleMemoryReview(message, actionCalls);
        }
        return {
          ok: true,
          sessionId,
          message,
          provenance: unique(actionCalls.flatMap((call) => call.envelope?.provenance ?? [])),
          actionCalls,
          ...responseMetadata(usage)
        };
      } catch (error) {
        // Preserve measured work from completed model invocations when a later round fails.
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { usage: mergeUsage(usage, (error as { usage?: ModelUsage } | null)?.usage) });
      }
    }
  };
}

function modelToolResult(call: ChatActionCall): ModelToolResult {
  if (call.envelope) {
    return { id: call.id, name: call.actionId, result: call.envelope };
  }
  if (call.error) {
    return {
      id: call.id,
      name: call.actionId,
      result: {
        status: "error",
        actionId: call.actionId,
        input: call.input,
        error: call.error
      }
    };
  }
  return {
    id: call.id,
    name: call.actionId,
    result: {
      status: "requires_confirmation",
      actionId: call.actionId,
      input: call.input,
      confirmationId: call.confirmationId,
      inputHash: call.inputHash
    }
  };
}

async function recordTokenUsage(
  sessionStore: ChatSessionStore | undefined,
  sessionId: string,
  usage: ModelResponse["usage"]
): Promise<void> {
  if (!usage?.promptTokens && !usage?.completionTokens) {
    return;
  }
  await sessionStore?.recordTokenUsage?.({
    sessionId,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens
  });
}

export function mergeUsage(...usages: Array<ModelResponse["usage"]>): ModelResponse["usage"] {
  const result: ModelUsage = {};
  for (const key of ["promptTokens", "completionTokens", "cacheReadTokens", "cacheCreationTokens", "reasoningTokens"] as const) {
    const measured = usages.flatMap(usage => typeof usage?.[key] === "number" ? [usage[key]!] : []);
    if (measured.length) result[key] = measured.reduce((sum, value) => sum + value, 0);
  }
  return Object.keys(result).length ? result : undefined;
}

async function reviewMemory(
  memoryManager: InfiniteOsMemoryManager | undefined,
  input: ChatInput,
  sessionId: string,
  assistantMessage: string,
  actionCalls: ChatActionCall[],
  effectiveUserMessage?: string
): Promise<void> {
  try {
    await memoryManager?.reviewTurn({
      model: input.memoryModel,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      sessionId,
      userMessage: effectiveUserMessage ?? input.message,
      assistantMessage,
      actionCalls
    });
  } catch {
    // Memory review must never fail or rewrite the user-facing turn.
  }
}

async function loadMemoryContext(
  memoryManager: InfiniteOsMemoryManager | undefined,
  input: ChatInput,
  sessionId: string
) {
  try {
    return await memoryManager?.loadPromptContext?.({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      sessionId
    });
  } catch {
    return undefined;
  }
}

async function loadQueryAdvisory(
  queryAdvisor: InfiniteOsQueryAdvisor | undefined,
  input: {
    message: string;
    workspaceId: string;
    actorId: string;
    sessionId: string;
    surface: Extract<RuntimeSurface, "api" | "app" | "cli" | "desktop">;
    now?: Date;
    recentMessages?: Array<{ role?: unknown; content?: unknown }>;
  }
) {
  try {
    return await queryAdvisor?.advise(input);
  } catch {
    return undefined;
  }
}

async function emitProgress(input: Pick<ChatInput, "onProgress">, event: ChatProgressEvent): Promise<void> {
  try {
    await input.onProgress?.(event);
  } catch {
    // Progress reporting must never fail the user-facing turn.
  }
}

function progressEventKey(event: ChatProgressEvent): string {
  if ("type" in event) {
    const toolId = "toolId" in event ? event.toolId ?? "" : "";
    const name = "name" in event ? event.name ?? "" : "";
    const detail =
      "subagent" in event ? `${event.subagent.id}:${event.subagent.status ?? ""}:${event.subagent.summary ?? ""}` :
      "preview" in event ? event.preview :
      "text" in event ? event.text :
      "context" in event ? event.context :
      "summary" in event ? event.summary ?? event.error ?? event.status ?? "" :
      "";
    return `${event.type}:${toolId}:${name}:${event.message}:${detail}`;
  }
  return `${event.stage}:${event.message}`;
}

function shouldDedupeProgressEvent(event: ChatProgressEvent): boolean {
  if ("type" in event && (event.type === "message.delta" || event.type === "reasoning.delta" || event.type === "thinking.delta")) {
    return false;
  }
  return true;
}

async function loadSessionRecall(sessionStore: ChatSessionStore | undefined, input: ChatInput, sessionId: string) {
  return loadSessionRecallForMessage(sessionStore, input.workspaceId, input.message, sessionId);
}

async function loadSessionRecallForMessage(
  sessionStore: ChatSessionStore | undefined,
  workspaceId: string,
  message: string,
  sessionId: string
) {
  try {
    return await sessionStore?.searchSessions(workspaceId, message, { excludeSessionId: sessionId });
  } catch {
    return undefined;
  }
}

function toolSchemas(actions: ActionDefinition[]): InfiniteOsToolSchema[] {
  return actions.map((action) => ({
    name: action.id,
    title: action.title,
    summary: action.summary,
    authority: action.authority,
    inputSchema: action.inputSchema
  }));
}

function scopedAppToolActions(scoped: NormalizedScopedAppTools): ActionDefinition[] {
  return scoped.tools.map((tool) => ({
    id: tool.modelName as ActionDefinition["id"],
    title: tool.rawName,
    summary: tool.description,
    category: "operator",
    authority: "tool_agent",
    inputSchema: tool.inputSchema,
    outputSchema: { type: "object", additionalProperties: true },
    provenancePolicy: "metadata",
    recommendedNextActions: [],
    recipeIds: [],
    handler: async () => {
      throw new Error("Scoped app tools are executed through the per-turn app-tool bridge.");
    }
  }));
}

// Union-mode action set: the native registry followed by the scoped app tools.
// NATIVE WINS on any name collision — a native id and an app-tool model name are
// namespace-disjoint by construction (app tools are always `mcp__<server>__<tool>`;
// native ids are bare snake_case and never start with `mcp`), so this filter is
// empty in practice. It is kept as defense-in-depth so an injected app tool can
// never shadow a native action in the advertised tool set even if that invariant
// were ever violated upstream.
function unionActionSet(registry: ActionRegistry, scoped: NormalizedScopedAppTools): ActionDefinition[] {
  const nativeActions = registry.list();
  const nativeIds = new Set(nativeActions.map((action) => action.id));
  const appActions = scopedAppToolActions(scoped).filter((action) => !nativeIds.has(action.id));
  return [...nativeActions, ...appActions];
}

function normalizeScopedAppTools(scoped: ScopedAppTools | undefined): NormalizedScopedAppTools | undefined {
  if (!scoped) {
    return undefined;
  }
  const serverName = scoped.serverName.trim();
  const allowedTools = scoped.allowedTools.map((tool) => tool.trim()).filter(Boolean);
  const tools = scoped.tools
    .map((tool) => {
      const rawName = tool.name.trim();
      return {
        modelName: scopedModelToolName(serverName, rawName),
        rawName,
        description: tool.description,
        inputSchema: tool.inputSchema
      };
    })
    .filter((tool) => tool.rawName && matchesAllowedTool(tool.modelName, allowedTools));
  return {
    serverName,
    allowedTools,
    // Absent ⇒ "exclusive" so existing callers (the ads sub-agent) are byte-for-byte
    // unchanged. parseScopedAppTools has already rejected any value other than
    // "exclusive" | "union", so this fallback only ever fires for the absent case.
    mode: scoped.mode === "union" ? "union" : "exclusive",
    tools,
    toolsByModelName: new Map(tools.map((tool) => [tool.modelName, tool])),
    callTool: scoped.callTool
  };
}

function scopedModelToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function matchesAllowedTool(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.some((allowed) => {
    if (allowed.endsWith("*")) {
      return toolName.startsWith(allowed.slice(0, -1));
    }
    return toolName === allowed;
  });
}

function scopedAppToolConfirmation(result: unknown): { confirmationId: string; actionHash?: string } | null {
  if (!isRecord(result) || result.requiresConfirmation !== true) {
    return null;
  }
  const confirmationId = stringValue(result.confirmationId);
  if (!confirmationId) {
    return null;
  }
  const proposal = isRecord(result.proposal) ? result.proposal : undefined;
  const actionHash = stringValue(result.actionHash) ?? stringValue(proposal?.actionHash);
  return {
    confirmationId,
    ...(actionHash ? { actionHash } : {})
  };
}

async function executeToolCalls(
  registry: ActionRegistry,
  toolCalls: ModelToolCall[],
  input: ChatInput,
  progress?: {
    scopedAppTools?: NormalizedScopedAppTools;
    progressLabels?: Map<string, string>;
    nowMs: () => number;
    emitToolStart: (event: ToolStartProgressEvent) => Promise<void>;
    emitToolProgress: (event: ToolProgressProgressEvent) => Promise<void>;
    emitToolComplete: (event: ToolCompleteProgressEvent) => Promise<void>;
  }
): Promise<ChatActionCall[]> {
  const calls: ChatActionCall[] = [];
  for (const toolCall of toolCalls) {
    const normalizedName = normalizeToolCallName(toolCall.name, registry, progress?.scopedAppTools);
    const progressLabel = progress?.progressLabels?.get(toolCall.id) ?? `Running ${normalizedName}.`;
    const startedAt = progress?.nowMs() ?? Date.now();
    await progress?.emitToolStart({
      type: "tool.start",
      stage: "tool",
      message: progressLabel,
      toolId: toolCall.id,
      name: normalizedName,
      context: progressLabel
    });
    const inputPreview = toolInputProgressPreview(normalizedName, toolCall.input);
    if (inputPreview && inputPreview !== progressLabel) {
      await progress?.emitToolProgress({
        type: "tool.progress",
        stage: "tool",
        message: inputPreview,
        toolId: toolCall.id,
        name: normalizedName,
        preview: inputPreview
      });
    }
    const scopedAppTools = progress?.scopedAppTools;
    const appTool = scopedAppTools?.toolsByModelName.get(normalizedName);
    if (appTool && scopedAppTools) {
      const call = await executeScopedAppToolCall(appTool, toolCall, scopedAppTools).catch((error: unknown) => ({
        id: toolCall.id,
        actionId: appTool.modelName,
        input: toolCall.input,
        status: "error" as const,
        requiresConfirmation: false,
        error: {
          code: "scoped_app_tool_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      }));
      calls.push(call);
      await progress?.emitToolComplete({
        type: "tool.complete",
        stage: "tool",
        message:
          call.status === "requires_confirmation"
            ? `Requires confirmation: ${appTool.modelName}.`
            : call.status === "error"
              ? `Failed ${appTool.modelName}.`
              : `Completed ${appTool.modelName}.`,
        toolId: toolCall.id,
        name: appTool.modelName,
        durationMs: elapsedMs(startedAt, progress),
        ...(call.status === "error" ? { error: call.error?.message ?? "Scoped app tool failed" } : {}),
        ...(call.status === "requires_confirmation" ? { summary: "Requires app confirmation" } : {}),
        status: call.status
      });
      continue;
    }
    // EXCLUSIVE fail-closed isolation: when scoped app tools REPLACE the native
    // registry, a call that isn't one of the scoped tools must NOT fall through to
    // a native action — the ads sub-agent is locked to its own tools. In UNION mode
    // that isolation is intentionally lifted (chat gets native + app tools), so a
    // non-app-tool name drops through to the native registry lookup below. Because
    // app tools are already resolved above (toolsByModelName), native winning here
    // on a hypothetical collision is automatic.
    if (scopedAppTools && scopedAppTools.mode !== "union") {
      const errorMessage = `Unknown scoped app tool: ${normalizedName}`;
      calls.push({
        id: toolCall.id,
        actionId: normalizedName,
        input: toolCall.input,
        status: "error",
        requiresConfirmation: false,
        error: { code: "unknown_action", message: errorMessage }
      });
      await progress?.emitToolComplete({
        type: "tool.complete",
        stage: "tool",
        message: errorMessage,
        toolId: toolCall.id,
        name: normalizedName,
        durationMs: elapsedMs(startedAt, progress),
        error: errorMessage,
        status: "error"
      });
      continue;
    }
    const action = registry.get(normalizedName);
    if (!action) {
      const errorMessage = `Unknown Infinite OS action: ${normalizedName}`;
      calls.push({
        id: toolCall.id,
        actionId: normalizedName,
        input: toolCall.input,
        status: "error",
        requiresConfirmation: false,
        error: { code: "unknown_action", message: errorMessage }
      });
      await progress?.emitToolComplete({
        type: "tool.complete",
        stage: "tool",
        message: errorMessage,
        toolId: toolCall.id,
        name: normalizedName,
        durationMs: elapsedMs(startedAt, progress),
        error: errorMessage,
        status: "error"
      });
      continue;
    }
    if (action.authority === "operator") {
      const inputHash = actionInputHash(action.id, toolCall.input);
      calls.push({
        id: toolCall.id,
        actionId: action.id,
        input: redactActionValue(toolCall.input),
        status: "requires_confirmation",
        requiresConfirmation: true,
        confirmationId: `confirm_${inputHash.slice(0, 16)}`,
        inputHash
      });
      await progress?.emitToolComplete({
        type: "tool.complete",
        stage: "tool",
        message: `Requires confirmation: ${action.id}.`,
        toolId: toolCall.id,
        name: action.id,
        durationMs: elapsedMs(startedAt, progress),
        summary: "Requires operator confirmation",
        status: "requires_confirmation"
      });
      continue;
    }
    const envelope = await registry.execute(
      action.id,
      toolCall.input,
      createSessionContext({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        authority: "tool_agent",
        surface: input.surface
      })
    ).catch((error: unknown) => ({
      ok: false,
      actionId: action.id,
      authority: "tool_agent" as const,
      status: "error" as const,
      error: {
        code: "action_execution_failed",
        message: error instanceof Error ? error.message : String(error)
      },
      provenance: [],
      caveats: [],
      truncated: false,
      nextActions: []
    }));
    const error = envelope.status === "error"
      ? stringValue(isRecord(envelope.error) ? envelope.error.message : undefined) ?? "Action execution failed"
      : undefined;
    calls.push({
      id: toolCall.id,
      actionId: action.id,
      input: redactActionValue(toolCall.input),
      status: envelope.status,
      requiresConfirmation: false,
      envelope
    });
    await progress?.emitToolComplete({
      type: "tool.complete",
      stage: "tool",
      message: error ?? `Finished ${action.id}.`,
      toolId: toolCall.id,
      name: action.id,
      durationMs: elapsedMs(startedAt, progress),
      summary: error ? undefined : summarizeActionEnvelope(action.id, envelope),
      error,
      status: envelope.status
    });
  }
  return calls;
}

async function executeScopedAppToolCall(
  appTool: NormalizedScopedAppTool,
  toolCall: ModelToolCall,
  scoped: NormalizedScopedAppTools
): Promise<ChatActionCall> {
  const result = await scoped.callTool(appTool.rawName, toolCall.input, {
    toolCallId: toolCall.id,
    modelName: appTool.modelName
  });
  const confirmation = scopedAppToolConfirmation(result);
  if (confirmation) {
    return {
      id: toolCall.id,
      actionId: appTool.modelName,
      input: redactActionValue(toolCall.input),
      status: "requires_confirmation",
      requiresConfirmation: true,
      confirmationId: confirmation.confirmationId,
      inputHash: confirmation.actionHash
    };
  }
  const failure = scopedAppToolFailure(result);
  if (failure) {
    return {
      id: toolCall.id,
      actionId: appTool.modelName,
      input: redactActionValue(toolCall.input),
      status: "error",
      requiresConfirmation: false,
      error: failure
    };
  }
  return {
    id: toolCall.id,
    actionId: appTool.modelName,
    input: toolCall.input,
    status: "ok",
    requiresConfirmation: false,
    envelope: {
      ok: true,
      actionId: appTool.modelName as ActionDefinition["id"],
      authority: "tool_agent",
      status: "ok",
      data: result,
      provenance: [],
      caveats: [],
      truncated: false,
      nextActions: []
    }
  };
}

function scopedAppToolFailure(result: unknown): { code: string; message: string } | null {
  if (!isRecord(result)) return null;
  if (result.ok !== false && result.status !== "error") return null;
  const error = isRecord(result.error) ? result.error : {};
  const code = stringValue(error.code) ?? stringValue(result.code) ?? "scoped_app_tool_failed";
  const message = stringValue(error.message) ?? stringValue(result.message) ?? code;
  return { code, message };
}

function elapsedMs(startedAt: number, progress: { nowMs: () => number } | undefined): number {
  return Math.max(0, (progress?.nowMs() ?? Date.now()) - startedAt);
}

function summarizeActionEnvelope(actionId: string, envelope: ActionEnvelope): string {
  if (envelope.status === "error") {
    return envelope.error?.message ?? `Failed ${actionId}`;
  }
  const parts: string[] = [envelope.status];
  const data = isRecord(envelope.data) ? envelope.data : undefined;
  const rows = Array.isArray(data?.rows) ? data.rows.length : undefined;
  if (rows !== undefined) {
    parts.push(`${rows} ${rows === 1 ? "row" : "rows"}`);
  }
  if (envelope.provenance.length) {
    parts.push(`${envelope.provenance.length} source${envelope.provenance.length === 1 ? "" : "s"}`);
  }
  if (envelope.caveats.length) {
    parts.push(`${envelope.caveats.length} caveat${envelope.caveats.length === 1 ? "" : "s"}`);
  }
  if (envelope.freshness) {
    const freshness = envelope.freshness.asOf ?? envelope.freshness.target;
    if (freshness) {
      parts.push(`${envelope.freshness.stale ? "stale" : "fresh"} ${freshness}`);
    }
  }
  if (envelope.truncated) {
    parts.push("truncated");
  }
  if (envelope.nextActions.length) {
    parts.push(`${envelope.nextActions.length} next`);
  }
  return parts.length > 1 ? parts.join("; ") : `Finished ${actionId}`;
}

const PROGRESS_PREVIEW_KEYS = [
  "metric",
  "metricId",
  "priorResultMetric",
  "view",
  "groupBy",
  "breakdown",
  "provider",
  "sourceId",
  "username",
  "limit",
  "dateRange",
  "timeRange"
] as const;

function toolInputProgressPreview(actionId: string, input: unknown): string {
  const redacted = redactActionValue(input);

  if (isRecord(redacted)) {
    const allEntries = Object.entries(redacted);
    if (allEntries.length === 0) {
      return "";
    }

    const preferred = PROGRESS_PREVIEW_KEYS
      .filter((key) => redacted[key] !== undefined)
      .map((key) => `${key}=${compactJsonPreview(redacted[key], 48)}`)
      .filter((part) => !part.endsWith("="));

    if (preferred.length > 0) {
      return compactPreview(preferred.join(", "), 120);
    }

    const entries = allEntries
      .slice(0, 3)
      .map(([key, value]) => `${key}=${compactJsonPreview(value, 48)}`);

    if (entries.length > 0) {
      return compactPreview(entries.join(", "), 120);
    }
  }

  const fallback = compactJsonPreview(redacted, 120);
  return fallback ? compactPreview(`${actionId} input ${fallback}`, 120) : "";
}

function compactJsonPreview(value: unknown, maxLength: number): string {
  const rendered = typeof value === "string"
    ? value
    : JSON.stringify(stableJson(value));

  return compactPreview(rendered ?? "", maxLength);
}

function compactPreview(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();

  return oneLine.length > maxLength ? `${oneLine.slice(0, Math.max(0, maxLength - 1))}…` : oneLine;
}

function normalizeToolCallName(
  name: string,
  registry: ActionRegistry,
  scopedAppTools?: NormalizedScopedAppTools
): string {
  if (scopedAppTools?.toolsByModelName.has(name)) {
    return name;
  }
  if (registry.get(name)) {
    return name;
  }
  if (name.startsWith("mcp_")) {
    const stripped = name.slice(4);
    if (registry.get(stripped)) {
      return stripped;
    }
  }
  return name;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function actionInputHash(actionId: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ actionId, input: stableJson(input) }))
    .digest("hex");
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)])
    );
  }
  return value;
}

function toolCallProgressMessage(
  message: string,
  call: ModelToolCall,
  registry: ActionRegistry,
  scopedAppTools?: NormalizedScopedAppTools
): string {
  const actionId = normalizeToolCallName(call.name, registry, scopedAppTools);
  const openEndedProgress = openEndedAnalysisProgressMessage(message, actionId, call);
  if (openEndedProgress) {
    return openEndedProgress;
  }
  const capabilityProgress = capabilityExplorationProgressMessage(message, actionId);
  if (capabilityProgress) {
    return capabilityProgress;
  }
  if (actionId === "list_queryable_views") {
    return "Checking available queryable views.";
  }
  if (actionId === "describe_queryable_view") {
    return "Checking queryable view definition.";
  }
  if (actionId === "list_metrics") {
    return "Checking available metrics.";
  }
  if (actionId === "describe_metric") {
    return "Checking metric definition.";
  }
  if (actionId === "list_source_schedules") {
    return "Checking source schedule configuration.";
  }
  if (actionId === "list_sources" || actionId === "get_recent_sync_runs") {
    return autoDiagnoseProgressMessage(message, actionId);
  }
  const xBreakdownProgress = xBreakdownProgressMessage(message, actionId, call);
  if (xBreakdownProgress) {
    return xBreakdownProgress;
  }
  const metricFamily = metricFamilyFromToolCall(call);
  if (metricFamily) {
    return PLANNED_PROGRESS_LABELS[metricFamily] ?? `Running ${actionId}.`;
  }
  if (actionId === "run_funnel_query") {
    return "Running funnel lookup.";
  }
  if (actionId === "drilldown_result") {
    return "Checking underlying drilldown rows.";
  }
  if (actionId === "explain_answer") {
    return "Checking answer provenance.";
  }
  return `Running ${actionId}.`;
}

function openEndedAnalysisProgressMessage(
  message: string,
  actionId: string,
  call: ModelToolCall
): string | undefined {
  if (!isOpenEndedAnalysisProgressQuestion(message)) {
    return undefined;
  }
  if (actionId === "list_sources") {
    return "Checking source coverage.";
  }
  if (actionId === "get_recent_sync_runs") {
    return "Checking data freshness.";
  }
  if (actionId === "list_source_schedules") {
    return "Checking source schedule coverage.";
  }
  if (actionId === "list_metrics") {
    return "Checking strongest available metrics.";
  }
  if (actionId === "list_queryable_views") {
    return "Checking what can be compared safely.";
  }
  if (actionId === "describe_queryable_view") {
    return "Checking how that dataset can be analyzed.";
  }
  if (actionId === "run_breakdown_query") {
    const metricFamily = metricFamilyFromToolCall(call);
    return metricFamily ? undefined : "Checking comparison breakdown.";
  }
  if (actionId === "run_metric_query") {
    const metric = metricIdFromToolCall(call);
    if (metric === "site_visitors") {
      return "Checking site traffic signal.";
    }
    if (metric === "recognized_revenue") {
      return "Checking revenue signal.";
    }
    if (metric === "signup_count") {
      return "Checking signup signal.";
    }
    if (metric === "site_conversion_rate") {
      return "Checking conversion signal.";
    }
    return "Checking the strongest available signal.";
  }
  if (actionId === "describe_metric") {
    return "Checking how that metric should be interpreted.";
  }
  return undefined;
}

function capabilityExplorationProgressMessage(message: string, actionId: string): string | undefined {
  if (!isCapabilityExplorationProgressQuestion(message)) {
    return undefined;
  }
  if (actionId === "list_metrics") {
    return "Checking which metrics are available to inspect.";
  }
  if (actionId === "describe_metric") {
    return "Checking how that metric can be analyzed.";
  }
  if (actionId === "list_queryable_views") {
    return "Checking which datasets can be queried safely.";
  }
  if (actionId === "describe_queryable_view") {
    return "Checking how that dataset can be explored.";
  }
  if (actionId === "list_sources") {
    return "Checking which connected sources back these metrics.";
  }
  if (actionId === "get_recent_sync_runs") {
    return "Checking whether those sources are current.";
  }
  return undefined;
}

function refinementProgressMessage(refinementSections: string[]): string {
  const joined = refinementSections.join("\n");
  if (joined.includes("Capability-exploration refinement guidance:")) {
    return "Refining capability overview with more query detail.";
  }
  if (joined.includes("workspace inventory and freshness context")) {
    return "Refining workspace analysis with a concrete signal.";
  }
  if (joined.includes("Open-ended analysis refinement guidance:")) {
    return "Refining open-ended analysis with more comparison context.";
  }
  if (joined.includes("Timing-analysis refinement guidance:")) {
    return "Refining timing analysis with posting-volume context.";
  }
  if (joined.includes("X negative-strategy refinement guidance:")) {
    return "Refining X strategy answer with a richer cautionary post sample.";
  }
  if (joined.includes("X strategy refinement guidance:")) {
    return "Refining X strategy answer with a richer post sample.";
  }
  if (joined.includes("X pattern-analysis refinement guidance:")) {
    return "Refining X pattern analysis with a richer post sample.";
  }
  if (joined.includes("Best-post refinement guidance:")) {
    return "Refining best-post answer with a richer breakdown.";
  }
  return "Refining answer with a better-targeted follow-up query.";
}

function xBreakdownProgressMessage(message: string, actionId: string, call: ModelToolCall): string | undefined {
  if (actionId !== "run_breakdown_query") {
    return undefined;
  }
  const metricFamily = metricFamilyFromToolCall(call);
  if (metricFamily !== "best_post" && metricFamily !== "post_count") {
    return undefined;
  }
  if (isXTimingProgressQuestion(message)) {
    return "Running X timing breakdown.";
  }
  if (isXNegativeStrategyProgressQuestion(message)) {
    return "Running X strategy post-sample breakdown.";
  }
  if (isXStrategyProgressQuestion(message)) {
    return "Running top-post strategy breakdown.";
  }
  if (isXPatternProgressQuestion(message)) {
    return "Running top-post pattern breakdown.";
  }
  return undefined;
}

function isXTimingProgressQuestion(message: string): boolean {
  return /\b(best|worst)\s+times?\b/i.test(message) && /\b(tweet|tweets|post|posts)\b/i.test(message);
}

function isXPatternProgressQuestion(message: string): boolean {
  return /\b(had in common|have in common|what do .* have in common|analyse|analyze)\b/i.test(message)
    && /\b(tweet|tweets|post|posts)\b/i.test(message)
    && /\b(best|top|performing|performance)\b/i.test(message);
}

function isXStrategyProgressQuestion(message: string): boolean {
  return /\bwhat should i (post|tweet|write) more of\b/i.test(message)
    || (/\b(post|tweet|write)\b/i.test(message) && /\bmore of\b/i.test(message) && /\b(x|twitter|tweet|tweets|post|posts)\b/i.test(message));
}

function isXNegativeStrategyProgressQuestion(message: string): boolean {
  return /\bwhat should i stop (posting|tweeting|writing)\b/i.test(message)
    || (/\bstop posting\b/i.test(message) && /\b(x|twitter)\b/i.test(message));
}

function metricFamilyFromToolCall(call: ModelToolCall): QueryFamily | undefined {
  const metric = metricIdFromToolCall(call);
  if (!metric) {
    return undefined;
  }
  if (metric === "x_public_engagement") {
    return "best_post";
  }
  if (metric === "x_follower_count") {
    return "follower_count";
  }
  if (metric === "x_comment_count") {
    return "comment_count";
  }
  if (metric === "x_post_count") {
    return "post_count";
  }
  if (metric === "recognized_revenue") {
    return call.name === "run_breakdown_query" ? "revenue_source" : "recognized_revenue";
  }
  if (metric === "site_visitors") {
    return call.name === "run_breakdown_query" ? "visitor_channel_breakdown" : "site_visitors";
  }
  if (metric === "signup_count") {
    return call.name === "run_breakdown_query" ? "signup_channel_breakdown" : "signup_count";
  }
  if (metric === "site_conversion_rate") {
    return call.name === "run_breakdown_query" ? "conversion_channel_breakdown" : "site_conversion_rate";
  }
  return undefined;
}

function metricIdFromToolCall(call: ModelToolCall): string | undefined {
  const input = isRecord(call.input) ? call.input : undefined;
  return stringValue(input?.metric) ?? stringValue(input?.metricId) ?? stringValue(input?.priorResultMetric);
}

function isOpenEndedAnalysisProgressQuestion(message: string): boolean {
  return /\b(what stands out|what should i know|what matters|what jumps out|help me understand|analy[sz]e this|analyze this)\b/i.test(message);
}

function isCapabilityExplorationProgressQuestion(message: string): boolean {
  return /\b(what can i inspect|what .* can i inspect|what can i query|what is available)\b/i.test(message);
}

function autoDiagnoseProgressMessage(message: string, actionId: string): string {
  const providers = progressProvidersForMessage(message);
  if (actionId === "list_sources") {
    if (providers.length === 1) {
      return `Checking connected ${providerDisplayName(providers[0])} source.`;
    }
    if (providers.length > 1) {
      return `Checking connected ${providers.map(providerDisplayName).join(" and ")} sources.`;
    }
    return "Checking connected sources.";
  }
  if (actionId === "get_recent_sync_runs") {
    if (providers.length === 1) {
      return `Checking recent ${providerDisplayName(providers[0])} syncs.`;
    }
    if (providers.length > 1) {
      return `Checking recent ${providers.map(providerDisplayName).join(" and ")} syncs.`;
    }
    return "Checking recent sync runs.";
  }
  return `Running ${actionId}.`;
}

function progressProvidersForMessage(message: string): string[] {
  if (isSourceStatusQuestion(message)) {
    const explicit = detectProviderMention(message);
    return explicit ? [explicit] : [];
  }
  return requiredProvidersForFamily(classifyQueryFamily(message));
}

function requiredProvidersForFamily(family: ReturnType<typeof classifyQueryFamily>): string[] {
  return FAMILY_PROVIDERS[family] ?? [];
}

function latestEnvelope(actionCalls: ChatActionCall[], actionId: string): ActionEnvelope | undefined {
  for (let index = actionCalls.length - 1; index >= 0; index -= 1) {
    const call = actionCalls[index];
    if (call.actionId === actionId && call.envelope) {
      return call.envelope;
    }
  }
  return undefined;
}

function latestMetricEnvelope(actionCalls: ChatActionCall[], metric: string): ActionEnvelope | undefined {
  for (let index = actionCalls.length - 1; index >= 0; index -= 1) {
    const call = actionCalls[index];
    if (call.actionId !== "run_metric_query" || !call.envelope) {
      continue;
    }
    const data = isRecord(call.envelope.data) ? call.envelope.data : undefined;
    if (stringValue(data?.metric) === metric) {
      return call.envelope;
    }
  }
  return undefined;
}

function normalizePostBody(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = decodeEntities(value)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\bhttps?:\/\/\S+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || /^https?:\/\/\S+$/i.test(normalized)) {
    return undefined;
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function numericStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function pluralizeWord(word: string, count: number | undefined): string {
  if (count === 1) {
    return word;
  }
  if (word === "reply") {
    return "replies";
  }
  return `${word}s`;
}

function countWithNoun(countText: string | undefined, singular: string): string | undefined {
  if (!countText) {
    return undefined;
  }
  const count = numericCount(countText);
  return `${countText} ${pluralizeWord(singular, Number.isFinite(count) ? count : undefined)}`;
}

function displayChannelValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  const known: Record<string, string> = {
    google: "Google",
    twitter: "Twitter",
    newsletter: "Newsletter",
    email: "Email",
    cpc: "CPC",
    organic: "Organic",
    brand: "Brand",
    launch: "Launch",
    welcome: "Welcome"
  };
  return known[lower] ?? normalized;
}

function numericCount(value: unknown): number {
  const raw = numericStringValue(value);
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSourceStatusQuestion(message: string): boolean {
  return classifyQueryFamily(message) === "source_status";
}

function detectProviderMention(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes("stripe")) return "stripe";
  if (lower.includes("posthog")) return "posthog";
  if (lower.includes("google analytics") || lower.includes("ga4")) return "google_analytics_4";
  if (lower.includes("shopify")) return "shopify";
  if (/\bmeta ads\b|\bfacebook ads\b|\binstagram ads\b/.test(lower)) return "meta_ads";
  if (/(^|\s)x(\s|$)|twitter/.test(lower)) return "x";
  return undefined;
}

function providerDisplayName(provider: string): string {
  if (provider === "x") return "X";
  if (provider === "google_analytics_4") return "Google Analytics 4";
  if (provider === "posthog") return "PostHog";
  if (provider === "stripe") return "Stripe";
  if (provider === "shopify") return "Shopify";
  if (provider === "meta_ads") return "Meta Ads";
  return provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampValue(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return stringValue(value);
}

function redactActionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactActionValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        shouldRedactKey(key) ? "[redacted]" : redactActionValue(entry)
      ])
    );
  }
  if (typeof value === "string" && looksSensitiveValue(value)) {
    return "[redacted]";
  }
  return value;
}

function shouldRedactKey(key: string): boolean {
  return /credential|secret|token|password|api[_-]?key|bearer/i.test(key);
}

function looksSensitiveValue(value: string): boolean {
  return /\b(sk-[a-z0-9-]+|sk_live_[a-z0-9_]+|sk_test_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/i.test(value);
}
