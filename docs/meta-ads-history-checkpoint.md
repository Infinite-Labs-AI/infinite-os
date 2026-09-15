# Meta Ads history H1 checkpoint — 2026-09-15

Status: **H1 implementation ready for verification/review — do not vendor downstream until the
root review signs off on the final commit SHA.**

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

## Review fixes in this H1 worktree

- Source/account binding now checks `sources.account_external_id` against the decrypted Meta
  credential before the first provider request. Its real-PGlite mismatch test passes with zero
  provider calls, facts and coverage.
- Entity-version hashing now canonicalizes object keys recursively while preserving array order.
  The real-PGlite reordered top-level/nested metadata test passes without opening false versions.
- URL-only image, thumbnail and carousel creative slots are retained after signed-URL removal.
  Descriptors now freeze the H5 handoff shape:
  `{slotKey, kind, providerAssetId, providerAssetType, slotFingerprint, sourceUrl, sourceLocator}`.
  `providerAssetType` is `image_hash`, `video_id` or `null`; H5 must consume it instead of guessing
  from decimal/hex-looking ids. `sourceUrl` remains `null`; `sourceLocator` stores only `{host, path}`
  and `slotFingerprint` is non-reversible.
- Successful CLOSE re-checks and locks the exact still-owned source/workspace/provider/account,
  still-running sync run and live credential id/update version before replacement deletes, coverage,
  cursor advance or source status transition.
- Both failure cleanup paths mark only the exact run they own, then re-check source + credential
  ownership before touching source status or failure counters. A revoke/reconnect during the old run
  now stays revoked/reconnected.
- New real-PGlite fixtures cover URL-only descriptors, revoke between LOAD and CLOSE, and concurrent
  reconnect during a partial chunk failure.

## Remaining handoff items

1. Obtain the root independent review before the closed cloud/archive work vendors this H1 SHA.
2. H5 must consume `providerAssetType` for provider ids and use `slotFingerprint` + `sourceLocator` as
   advisory slot identity only, then resolve a fresh provider download URL under the workspace
   credential.

## Verification run in this worktree

- `pnpm exec vitest run packages/connectors/src/index.test.ts packages/connectors/src/sync-batch-chunking.test.ts packages/connectors/src/meta-history-pglite.test.ts` — 279/279 passed.
- `pnpm exec vitest run packages/db/test/migrations.test.ts packages/db/test/pglite.test.ts` — 106/106 passed.
- `pnpm typecheck` — passed.
- `PUBLIC_SURFACE=1 scripts/ci/repo-tripwire.sh` — passed with the expected local warning that `IP_CANARIES` is unavailable.
- `git diff --check` — passed.

Provider-asset-type follow-up: after adding `providerAssetType` for H5, the connector target above was
rerun at 279/279, plus `pnpm typecheck`, `PUBLIC_SURFACE=1 scripts/ci/repo-tripwire.sh` and
`git diff --check`. No DB/schema files changed after the 106/106 DB verification above.

The closed H5 media archive must consume `meta_ads_entity_versions` creative rows and their canonical
asset descriptors. It must resolve fresh provider download URLs under the workspace credential and
store bytes in workspace-owned object storage, never Postgres binary columns.
