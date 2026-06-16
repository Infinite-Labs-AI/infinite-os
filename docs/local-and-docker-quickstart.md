# Infinite OS — Local and Docker Quickstart

Infinite OS is a local-first, self-hosted growth-analytics runtime. The
TypeScript workspace runs the topology: Postgres, the app daemon + HTTP
API, the sync worker, migrations, typed actions, queryable views, and connector
paths for Google Analytics 4, PostHog, Stripe, Meta, Shopify, and read-only X
public post metrics.

## Local Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @infinite-os/db migrate
```

## Local Secrets And Config

Non-secret runtime config belongs in:

```txt
.growth-os/config.yml
```

Local deployment secrets belong in:

```txt
.growth-os/.env
```

Required deployment secrets:

- `DATABASE_URL`
- `GROWTH_OS_ENCRYPTION_KEY`

Required app/API/MCP auth secrets:

- `GROWTH_OS_READ_TOKEN`
- `GROWTH_OS_OPERATOR_TOKEN`

Connector credentials and OAuth tokens must be stored in encrypted
`connection_credentials` rows, not in `.growth-os/.env`.

## Docker Path

The root `docker-compose.yml` defines the Infinite OS Docker topology:

- `postgres`
- `migrate`
- `app`
- `worker`

Validate it with:

```bash
docker compose config
```

Start the stack with:

```bash
docker compose up
```

On first boot, Compose starts Postgres, runs the migration service, then starts
the app and worker. A fresh clone does not need a separate migration command for
the bundled Docker path.

Check the app from another terminal:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/metrics
```

Once the stack is up, drive it with the `infinite` CLI — `./infinite setup`, then
`./infinite`. See the [README](../README.md#commands) for the full command list.

## External Postgres Path

For an externally managed Postgres database, set:

```bash
export DATABASE_URL="postgres://..."
export GROWTH_OS_ENCRYPTION_KEY="..."
pnpm --filter @infinite-os/db migrate
pnpm --filter @infinite-os/app dev
pnpm --filter @infinite-os/worker dev
```

Supabase works as an external Postgres server: create or choose the Supabase
project, copy its Postgres connection string into `DATABASE_URL`, and use the
same migration flow.

## Service Layout

- `apps/app`: the app daemon — HTTP API + the app-hosted MCP transport
- `apps/cli`: Node CLI with the `infinite` executable
- `apps/worker`: worker-owned sync, view-refresh, and saved-report job loop
- `packages/runtime`: typed action registry and authority checks
- `packages/db`: Postgres migrations and migration runner

Bundled Docker Postgres and external Postgres must use the same migrations,
worker loop, action registry, and queryable views.
