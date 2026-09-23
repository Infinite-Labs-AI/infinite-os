# Interactive task durability — engine ledger (work in progress)

Updated: 2026-09-23

The engine keeps a small local ledger of interactive agent tasks: the task, its ordered events,
and references to the actions it proposed. The ledger is engine-only today. Nothing advertises
it or calls it yet.

## What exists

- **Migration** `packages/db/migrations/0072_interactive_task_ledger.sql`, with three tables:
  - `interactive_tasks`
  - `interactive_task_events`
  - `interactive_action_refs`

  All three are in `deleteProject`.
- **Store** `packages/llm-controller/src/interactive-task-store.ts`, with its types in
  `interactive-task-types.ts`. It is exported from `@infinite-os/llm-controller`, and the wire
  types are in `@infinite-os/types` (`interactive-task.ts`).
- **Tests:**
  - `packages/llm-controller/test/interactive-task-store.test.ts`, on real temporary PGlite through
    the real migrations, with an injected clock;
  - the 0072 assertions in `packages/db/test/migrations.test.ts` and `pglite.test.ts`.

## Rules the ledger enforces

**Origin and surface.**
- A task has an origin: `human`, `triggered` (a data alert) or `scheduled` (a time reminder).
- It has a surface: `cmdl`, `terminal`, `imessage` or `agent_tasks`.
- Automatic turns never render in Cmd+L or the terminal.
- Automatic tasks open with a `trigger` event and can never record a `user_message`. The database
  enforces this as well as the store.
- A `human` task on the terminal is not proof of who typed. Its actions can only be authorized by a
  typed approval that names the exact proposal revision. The database enforces this too.

**Provenance.** Automatic tasks carry host-written provenance:
- the trigger key;
- the rule id and version;
- optional check and event keys;
- a sha256 of the untrusted event payload.

A triggered task's key must equal `trigger:{alert_id}:{event_key}`. When that key would exceed 200
characters, it is `trigger:{alert_id}:sha256:{lowercase hex sha256 of the UTF-8 event key}`
instead. `interactiveTriggerKey()` computes the same value.

**Retries.**
- A retried automatic create returns the task its trigger key already opened.
- A retried model turn, meaning the same turn key, returns the recorded outcome and writes nothing.
- A later turn with a new turn key is recorded. A continuation's reply is an example.

**Proposals outlive grants.**
- A grant lasts at most 10 minutes from the injected clock.
- A proposal can be approved only within that window after it was prepared.
- A proposal from an automatic turn can be approved only after it has been re-prepared.
- `revise_proposal` re-prepares: it creates a new revision and marks the old one `superseded`.
- `expire_authorization` ends a lapsed or restarted grant, leaving the proposal `expired`.
- `reject_proposal` (Cancel) retires a proposal permanently.

**Task state follows the task's live actions.** Cancelled is terminal. After a cancel, only
effects already in flight can still be recorded.

**Reads:**
- `listActiveTasks` and `listLiveProposals` return keyset pages;
- `listRecoverableActions` lists, across actors, the grants to end and the dispatches to reconcile
  after a restart.

**Errors.** Every database error leaves the store as a typed `InteractiveTaskConflictError`.

## Not built yet

1. Operator-only daemon routes, with route-level tests for:
   - workspace and actor scope;
   - idempotency;
   - CAS;
   - body bounds.

   Only the host may create an automatic task. Its origin and provenance come from the claimed
   cloud turn, never from model output.
2. Capability negotiation for task events, only after the routes exist.
3. Desktop use: a write-ahead record at dispatch, and a boot pass that ends every `authorized`
   grant with `host_restart` and reports `dispatching` or `unknown` actions for verification. The
   boot pass never re-dispatches.
4. An independent review before any desktop dependency.

Cloud service journals remain authoritative. A missing service-journal row is not proof that a
dispatch did not happen, unless an owning adapter proves non-dispatch or supplies a valid
idempotency guarantee. Process-local confirmation thunks are never restored after a restart.
