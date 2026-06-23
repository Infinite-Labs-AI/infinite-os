# Adding an engine action — the 6-touchpoint checklist

> Reference for the connector-convergence plan (P0-H). Every task that adds a new engine **action**
> (e.g. `list_meta_assets`, the Shopify/Stripe write actions, `dispatch_capi_event`) edits these same
> places. **Read this before adding an action so nothing is silently skipped.**
>
> Verified against `origin/main` (`5f6e8e5`) on 2026-06-22. Line numbers drift — grep the symbol.

Two of the six are **compile-enforced** (omit them and `tsc` fails). The other four are
**runtime-required**: the build stays green if you omit them, but the action is unschema'd,
unauthorized, or **unreachable** at runtime. **Do not rely on the compiler to catch the runtime four.**

| # | Touchpoint | File | Enforcement | What it does if omitted |
|---|---|---|---|---|
| 1 | `READ_ACTIONS` / `OPERATOR_ACTIONS` const | `packages/types/src/index.ts:128` / `:157` | **compile** (indirect) | the action id doesn't exist in `InfiniteOsActionId` → every other site rejects it |
| 2 | `metadataFor` | `packages/runtime/src/index.ts:460` | **compile** | `const metadata: Record<InfiniteOsActionId, …>` is **non-`Partial`** (`:467`) → a missing key is a TS error |
| 3 | `inputSchemaFor` | `packages/runtime/src/index.ts:806` | **runtime** | `Partial<Record<…>>` → omitting compiles, but input validation is skipped (empty schema) |
| 4 | `provenancePolicyFor` | `packages/runtime/src/index.ts:436` | **runtime** (often no edit) | if/else; operator actions get `operator_audit` automatically via `isOperatorAction(id)` — only add a case for non-standard provenance |
| 5 | handler binding | `packages/analytical-engine/src/index.ts:80` | **runtime** | `createActionHandlers` returns `Partial<Record<…, ActionHandler>>` → omitting compiles, but the action is **unreachable** (no handler) |
| 6 | `InfiniteOsActionId` type | `packages/types/src/index.ts:182` | (auto) | `InfiniteOsActionId = (typeof FIRST_PHASE_ACTIONS)[number]`, `FIRST_PHASE_ACTIONS = [...READ_ACTIONS, ...OPERATOR_ACTIONS]` — derived from #1, no separate edit |

## Step by step

1. **Declare the id** — add the string to `READ_ACTIONS` (read/`tool_agent` authority) or `OPERATOR_ACTIONS`
   (operator authority, `assertAuthority` enforced) in `packages/types/src/index.ts`. This widens
   `InfiniteOsActionId` (#6, auto), which is what makes the `metadataFor` switch (#2) demand the new key.
2. **`metadataFor`** (`runtime:460`) — add `{ title, summary, category, recommendedNextActions, recipeIds }`.
   The compiler **requires** this (non-`Partial` Record). `category` should be `'operator'` for writes,
   `'read'`/`'tool_agent'` for reads.
3. **`inputSchemaFor`** (`runtime:806`) — add the input JSON-schema entry. Runtime-required: without it the
   action accepts unvalidated input. Operator writes that move money/state MUST have a real schema.
4. **`provenancePolicyFor`** (`runtime:436`) — usually **no edit**: `isOperatorAction(id)` already returns
   `operator_audit` for anything in `OPERATOR_ACTIONS`, and reads fall through to `metadata`. Only touch it
   for a non-standard provenance class.
5. **Bind the handler** (`analytical-engine:80`, `createActionHandlers`) — `myAction: (input, context) => myHandler(db, context, input)`.
   Runtime-required: without it the registry has no handler and the action 500s as unreachable.
6. **Authority + safety** — operator actions are `assertAuthority`-gated (no read token), and money-moving
   writes keep the invariants: hard-`PAUSED` create, `assertCreateNotActive`, atomic `meta_write_dedup`
   (workspace-scoped unique index), `integration_audit_log`. Never weaken these.

## Acceptance for "I added an action correctly"

- `pnpm -r build` is green (proves #1 + #2).
- The action appears in the registry and a `/tools/call` (read) or `/gateway/turn`+confirm (operator)
  reaches the handler (proves #5).
- A bad-input call is rejected by the schema (proves #3).
- An operator action called with a read token returns `operator authority required` (proves the authority gate).

## Note: add-an-**action** vs add-a-**source**

This checklist is for an **action**. Adding a new analytical **source/provider** (e.g. a new connector) is a
*different* 5-touchpoint pattern: `FirstPhaseProvider` union (`packages/db/src/index.ts:103`) +
`FIRST_PHASE_PROVIDERS` (`packages/runtime/src/index.ts:164`) + `assertFirstPhaseProvider` (`db:855`) + a
CHECK-widening migration across all three places the provider CHECK appears (pattern:
`packages/db/migrations/0015_shopify_meta_ads_provider_truth.sql`) + the connector def in
`packages/connectors/src/index.ts`. Don't conflate the two.
