# Meta Ads history H1 checkpoint — 2026-09-15

Status: **WIP — do not merge or vendor this checkpoint yet.**

Worktree: `/Users/chaos/Github/infinite-os-meta-history-h1`

Branch: `feat/2026-09-15-meta-history-h1`

Base: `2e79e565b2273faa65ac591056deeb68d27846a9`

Committed implementation chain before this checkpoint:

- `b2c3b5e` — canonical three-grain daily facts, conversion parity, 0069 schema, coverage,
  successful-CLOSE replacement, request telemetry/budget, entity/creative versions and PGlite tests.
- `d61787f` — account-local settled-window dates with DST tests.
- `bf49088` — migration-count label correction.
- `01f2e80` — remove signed Meta media URL capabilities from readable/raw history payloads.

## Proven at the last full green boundary

- Connector + real Meta-history PGlite suites: 248/248 passed.
- Migration contract suite: 46/46 passed.
- Full DB/PGlite suite: 106/106 passed; the 0069 idempotency subset also passed sequentially.
- Root `pnpm typecheck` passed.
- `PUBLIC_SURFACE=1 scripts/ci/repo-tripwire.sh` passed.
- No Meta API, production DB, migration apply, deploy, push or PR occurred.

## Review fixes in this WIP checkpoint

- Source/account binding now checks `sources.account_external_id` against the decrypted Meta
  credential before the first provider request. Its real-PGlite mismatch test passes with zero
  provider calls, facts and coverage.
- Entity-version hashing now canonicalizes object keys recursively while preserving array order.
  The real-PGlite reordered top-level/nested metadata test passes without opening false versions.
- New red fixtures specify URL-only image, thumbnail and carousel slots after signed-URL removal.
  They intentionally remain red at this checkpoint because the descriptor fingerprint/locator
  implementation is unfinished.

## Remaining blockers

1. Preserve URL-only creative slots without storing the signed URL: add a non-reversible fingerprint
   and safe host/path locator so H5 can refetch by creative + slot and record inaccessible failures.
2. At Meta CLOSE, lock and re-check the exact source/workspace/account, exact still-running sync run,
   and frozen credential id/update version before any replacement delete, coverage or cursor/status
   transition.
3. Gate both failure cleanup paths on the exact still-owned `syncing` source so a revoke/reconnect
   during extract/load stays revoked/reconnected and cannot be changed to `error` or `connected`.
4. Add a real-PGlite revoke-between-OPEN-and-CLOSE test proving no prune, coverage, cursor advance or
   source resurrection.
5. Re-run full connector, history PGlite, DB migration/PGlite, typecheck, tripwire and diff checks;
   obtain a clear independent review before integration.

The closed H5 media archive must consume `meta_ads_entity_versions` creative rows and their canonical
asset descriptors. It must resolve fresh provider download URLs under the workspace credential and
store bytes in workspace-owned object storage, never Postgres binary columns.
