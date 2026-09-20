# Interactive task durability — deferred WIP handoff

Updated: 2026-09-20

This branch preserves an unfinished Task 3 draft after product work was
reprioritized toward user-visible Cmd+L capabilities. It is intentionally not
merged, pushed, or advertised as working.

## Source identity

- Worktree: `/Users/chaos/Github/infinite-os-task3-durability-20260920`
- Branch: `feature/2026-09-20-interactive-task-durability`
- Base: `0592a902ee92ddbaf12f6643ccbbd9180c3a5171` (reviewed Task 2 stack)
- Remote `main` observed before drafting: `cb974804270b953e0b3ab9d61c58ff0f493bf6ed`
- Candidate migration number at that observation: `0071`

The dirty canonical `~/Github/infinite-os` checkout was not edited. Dependencies
were installed offline into this worktree's own real `node_modules` directory;
no dependency symlink points at the canonical checkout.

## Drafted, not accepted

- A zero-dependency interactive task/event/action-reference wire contract.
- A three-table migration draft: `interactive_tasks`,
  `interactive_task_events`, and `interactive_action_refs`.
- Store input/transition types.
- A store implementation draft covering scoped reads, revision/event sequencing,
  request-id replay, proposal payload bounds, action identity checks, cancellation,
  and outcome/continuation transitions.
- A real temporary-PGlite test draft covering scoped create/replay, atomic final
  turn/action recording, request/CAS conflicts, immutable hashes/resume keys,
  cancellation, real database/store recreation, and secret-shaped proposal
  rejection.

The TDD red run was observed before the store file existed:

```text
FAIL packages/llm-controller/test/interactive-task-store.test.ts
Cannot find module '../src/interactive-task-store.js'
```

No green run, build, typecheck, migration apply, route test, or review is claimed.

## Required before this can be resumed or consumed

1. Compile the store and correct its types/SQL against real PGlite.
2. Run the focused store test to green, then add the migration manifest/count and
   PGlite schema assertions.
3. Export the store/types from `@infinite-os/llm-controller`.
4. Add the three tables to transactional workspace deletion ordering and prove
   zero residual rows.
5. Review the migration grants and validate its composite task/workspace/actor
   foreign-key invariants.
6. Add operator-only daemon routes and route-level workspace/opaque-actor scope,
   idempotency, CAS, and body-bound tests.
7. Add daemon capability negotiation only after those routes are real.
8. Obtain an independent review checkpoint before any Desktop dependency work.
9. Desktop service hooks, restart reconciliation, fake service-journal proof,
   documentation in `1bu-1`, and every user-visible surface remain completely
   unimplemented.

Cloud journals must remain authoritative. A missing service-journal row is not
proof that dispatch did not happen unless an owning adapter specifically proves
non-dispatch or supplies a valid idempotency guarantee. Old process-local
confirmation thunks must never be restored after restart.
