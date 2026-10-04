# Contributing to Infinite OS

Thanks for your interest in contributing! Infinite OS is the open-core engine bundled in the macOS-only Infinite Desktop app. The signed Desktop app is the supported customer product; this source topology is for maintainers and contributors.

## Prerequisites

- **Node.js ≥ 20** and **pnpm** — the repo is a pnpm-workspace monorepo.
- **Docker** — maintainers use Docker Compose to exercise the source engine topology. It is not an end-user installation path.

## Repo layout

- `apps/` — the CLI, the local daemon (`app`), and the sync `worker`.
- `packages/` — the engine: `db`, `core`, `connectors`, `runtime`, `analytical-engine`, `setup`, and more.
- `ui-tui/` — the terminal UI renderer.

## Development

```bash
pnpm install          # install workspace dependencies
pnpm typecheck        # tsc -b
pnpm test             # full vitest suite
```

Tests use a **single root `vitest.config.ts`**. Run one file with:

```bash
pnpm exec vitest run <path>      # not `pnpm --filter`
```

To run the app locally, `./infinite local start` brings up the Docker stack, then `./infinite local setup` walks you through connecting a data source.

## Workflow

1. Branch from `main`.
2. Open a PR with a clear what/why and the tests you ran. Conventional-commit style (`fix(scope): …`, `feat(scope): …`).
3. PRs are **squash-merged** to `main`. CI (typecheck + tests) must pass.

## Data safety (non-negotiable)

This tool handles real business data and credentials locally. Never commit secrets or personal data:

- `.env*` files and the `.growth-os/` directory are gitignored — never `git add -f` them.
- No hard-coded secrets in tracked files. Use a gitignored `.env`; `.env.example` documents variable names with placeholders only.
- Connector credentials are encrypted at rest with `GROWTH_OS_ENCRYPTION_KEY` — treat that key as load-bearing (rotating it forces re-authentication of every connection).

## Security

Please report security issues privately — see [`SECURITY.md`](./SECURITY.md). Do not open public issues for vulnerabilities.
