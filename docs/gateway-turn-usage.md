# Gateway turn usage

`POST /gateway/turn` and `/gateway/turn/stream` return optional `usage` on successful turns. Failed turns return measured usage inside the JSON `error`, or on the SSE `error` event. Counters sum distinct model invocations in a tool loop, including completed rounds before a later failure. Unreported counters are omitted; reported zero is preserved.

The optional counters are `promptTokens`, `completionTokens`, `cacheReadTokens`, `cacheCreationTokens`, and `reasoningTokens`. They preserve provider semantics: Codex cached input is included in prompt tokens and reasoning is included in completion tokens. Do not add those subsets to the totals.

The streaming endpoint emits `progress` frames with `{type: "usage.update", usage}` after each completed model invocation. These are cumulative snapshots, not increments. Clients should replace their latest snapshot and retain it if the connection ends before a terminal frame. A snapshot cannot account for provider work that never reports usage. Background memory review and explicit compaction are separate model calls and are not included in these turn counters.

Both endpoints accept optional `model: {modelId, effort?}` to pin a Codex model and reasoning effort to the accepted turn. The override applies to every tool-loop round without changing persisted selection. Omitting it preserves configured defaults. The session ID remains the stable `prompt_cache_key`; a model override does not reuse conversation state across unrelated requests.


## Background memory and compaction

The daemon writes separate, content-free auxiliary receipts to `auxiliary_brain_usage_outbox` (migration 0066). `memory_review` records the single model call after each persisted chat/union turn; exclusive scoped-tool turns do not run memory review. `compaction` records model-generated summaries requested through `/chat/sessions/:id/compact`; caller-supplied summaries do not invoke a model and create no receipt. These calls never enter the gateway turn aggregate.

The gateway accepts optional `memoryModel: {modelId, effort?}` to pin a separate Codex model for memory review. The engine default is unchanged when omitted. Memory requests use `memory:<workspaceId>` as their stable prompt cache key. Compaction accepts optional `model` and requires operator authority plus the session's workspace header.

`GET /brain/usage/pending` requires an install operator token. Without a workspace header it returns the oldest 100 pending receipts across the operator's local projects; with a header it filters that project. `POST /brain/usage/ack` requires an operator token and explicit workspace header, with `{receiptIds: [UUID, ...]}` (maximum 100). It deletes only matching project receipts and is idempotent. A desktop must first durably queue each receipt using its stable UUID, then ACK it. Repeated reads/retries must not count the same UUID twice.

Receipts expose only `id`, `engineProjectId`, `feature`, `provider`, `model`, `effort`, `status`, nullable measured `usage`, `occurredAt`, and `latencyMs`. No prompts, outputs, provider error text, credentials, or user identity are stored. Successful and failed configured-model outcomes are recorded even after the chat response closes, and survive daemon restarts once committed. No start-phase record is written: a process crash or unavailable database between provider completion and the receipt commit cannot be recovered by this outbox. Standalone in-process CLI model calls are outside these daemon endpoint receipts.
