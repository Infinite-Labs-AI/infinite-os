# Gateway turn usage

`POST /gateway/turn` and `/gateway/turn/stream` return optional `usage` on successful turns. Failed turns return measured usage inside the JSON `error`, or on the SSE `error` event. Counters sum distinct model invocations in a tool loop, including completed rounds before a later failure. Unreported counters are omitted; reported zero is preserved.

The optional counters are `promptTokens`, `completionTokens`, `cacheReadTokens`, `cacheCreationTokens`, and `reasoningTokens`. They preserve provider semantics: Codex cached input is included in prompt tokens and reasoning is included in completion tokens. Do not add those subsets to the totals.

The streaming endpoint emits `progress` frames with `{type: "usage.update", usage}` after each completed model invocation. These are cumulative snapshots, not increments. Clients should replace their latest snapshot and retain it if the connection ends before a terminal frame. A snapshot cannot account for provider work that never reports usage. Background memory review and explicit compaction are separate model calls and are not included in these turn counters.

Both endpoints accept optional `model: {modelId, effort?}` to pin a Codex model and reasoning effort to the accepted turn. The override applies to every tool-loop round without changing persisted selection. Omitting it preserves configured defaults. The session ID remains the stable `prompt_cache_key`; a model override does not reuse conversation state across unrelated requests.
