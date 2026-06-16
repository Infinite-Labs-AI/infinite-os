# AGENTS.md — working agreement for Infinite OS

Operating guide for anyone (human or AI agent) changing code in this repo. Pairs with
[CONTRIBUTING.md](CONTRIBUTING.md) (human-oriented) and [SECURITY.md](SECURITY.md).
If you read one thing: **work on a branch, open a PR, let CI gate it, get a review,
squash-merge.** Never push to `main`.

## What this repo is

**Infinite OS** — a self-hosted, local-first growth-analytics runtime. It connects a
user's data sources (GA4, PostHog, Stripe, Meta, Shopify, X) into a local Postgres
database, keeps them synced, and answers plain-English questions from a governed
metric layer. Everything runs on the user's machine; their data never leaves it.

Pure-TypeScript **pnpm-workspace monorepo**, Node ≥ 20:

| Path | What |
|---|---|
| `apps/cli` | the `infinite` command — operator shell + chat |
| `apps/app` | local HTTP API daemon the CLI talks to |
| `apps/worker` | scheduler + background sync jobs |
| `packages/*` | the engine (`db`, `core`, `config`, `connectors`, `runtime`, `metadata`, `analytical-engine`, `setup`, `llm-controller`, `instrument`) |
| `ui-tui/` | terminal UI (Ink) renderer |

## The shipping workflow

`main` is protected: **no direct pushes, squash-merge only, CI (`ci`) must be green.**
Every change — including a maintainer's own — goes through a PR.

```bash
# 1. sync
git switch main && git pull --ff-only

# 2. branch (or a worktree for parallel work)
git switch -c <type>/<slug>            # type ∈ feat | fix | docs | chore | refactor
#   git worktree add ../io-<slug> -b <type>/<slug>

# 3. build
pnpm install
pnpm -r --if-present build             # or just run ./infinite once (it builds on first run)

# 4. verify — ALL must pass before opening the PR
pnpm typecheck                                 # tsc -b
pnpm test                                      # full vitest suite
PUBLIC_SURFACE=1 scripts/ci/repo-tripwire.sh   # no secrets / internal files tracked

# 5. PR
gh pr create --base main               # conventional-commit title; say what + why + tests run

# 6. review  → a separate pass reads the diff (CI green is necessary, not sufficient)
# 7. merge   → squash-merge, then delete the branch
```

CI also runs **gitleaks** over tracked content. External (fork) PRs run CI with
restricted permissions, and a maintainer approves the first run for new contributors —
fork PRs never receive repo secrets, and the tripwire degrades gracefully when a
secret-gated check can't run.

### Conventions

- **Conventional commits:** `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.
- One logical change per PR; keep PRs small and reviewable.
- New behavior ⇒ tests. Changed behavior ⇒ updated docs.
- **Author and review are separate passes.** Don't self-approve a change in the same
  breath you wrote it — have a fresh pass (a reviewer or a second read) check it.

## Golden rules (non-negotiable)

1. **Never commit secrets.** `.env*` and `.growth-os/` are gitignored — never
   `git add -f` them. Real secrets live in a local `.env`; `.env.example` documents
   names with placeholders only. The tripwire + gitleaks fail the build on a leak.
2. **Data safety.** Connector credentials, synced rows, and chats live in the user's
   local Postgres + `.growth-os/` — never in git.
3. **`GROWTH_OS_ENCRYPTION_KEY` is load-bearing** — it decrypts stored credentials.
   Don't rename it or change its handling casually; rotating it orphans existing
   connections (forces re-auth).
4. **Don't break the wire.** Some string constants are load-bearing protocol/wire
   values (e.g. provider `User-Agent` strings). Don't "tidy" them without checking
   what reads them on the other end.
5. **Test a `bin` the way users run it.** If you touch a package's `bin` entry, verify
   it via the bin symlink / `npx`, not just `node dist/...` — a direct path can mask
   an entrypoint-resolution bug that only bites under a symlinked launcher.

## Tests

Single root `vitest.config.ts`. `pnpm test` runs everything; run one file with
`pnpm exec vitest run <path>` — **not** `pnpm --filter`.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Don't open public
issues for them.
