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

## Daemon routes

`apps/app/src/interactive-task-routes.ts`, registered in `createApp`, published as the
`interactive_tasks_v1` capability on `/health`. All routes are operator-only and scoped to the
validated `x-growth-os-workspace`; the actor is derived from that workspace row (its opaque owner
id when claimed, else `local`), never from the body.

| Route | Store call |
|---|---|
| `POST /interactive/tasks` | `createTask` (201; 200 on replay) |
| `GET /interactive/tasks` | `listActiveTasks` |
| `GET /interactive/tasks/:id` | `getTask` |
| `GET /interactive/tasks/:id/events?after=&limit=` | `listEvents` |
| `POST /interactive/tasks/:id/transitions` | `transition` |
| `GET /interactive/proposals` | `listLiveProposals` |
| `GET /interactive/recovery?states=` | `listRecoverableActions` (across actors) |

Typed errors map to HTTP: not found is 404; expired task or grant authority is 410; bad input,
origin violations and a missing typed approval are 422; every other conflict is 409. A create body
is bounded to 256 KiB and a transition to 1 MiB (413 above). Any untyped fault is a generic 500.

## Not built yet

1. Negotiating `task.events.v1` on the Cmd+L bridge.
2. An independent review before any desktop release depends on these routes.

Cloud service journals remain authoritative. A missing service-journal row is not proof that a
dispatch did not happen, unless an owning adapter proves non-dispatch or supplies a valid
idempotency guarantee. Process-local confirmation thunks are never restored after a restart.
