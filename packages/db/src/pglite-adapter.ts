import { join } from "node:path";
import { infiniteOsHome } from "@infinite-os/config";
import type { QueryResultRow } from "pg";

import type { InfiniteOsDb, Migration, QueryableClient } from "./index.js";

// ---------------------------------------------------------------------------
// Embedded PGlite backend (the desktop database path).
//
// PGlite (@electric-sql/pglite) is a full Postgres compiled to WASM that runs
// in-process with a SINGLE connection and no server/Docker. This module is the
// desktop-only backend behind the existing `createInfiniteOsDb` /
// `runMigrations` seam in `index.ts`. The real-Postgres (`pg.Pool`) path is left
// byte-identical; selection is purely by URL scheme (see `isPgliteDatabaseUrl`).
//
// Why a separate module: it lets the `pg` dependency stay the only thing the
// server bundle imports eagerly. `@electric-sql/pglite` is `import()`-ed lazily
// so a real-Postgres deploy never loads the WASM payload.
// ---------------------------------------------------------------------------

// The subset of the PGlite instance this adapter relies on. PGlite's own
// `query` returns `{ rows, affectedRows?, fields }`, which already satisfies the
// `QueryableClient` contract the domain helpers + `wrapPool` consume — so a
// booted PGlite instance can be passed straight into `wrapPool` as the client.
interface PgliteInstance extends QueryableClient {
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Returns true when `databaseUrl` selects the embedded PGlite backend rather
 * than a real Postgres server. The rule is intentionally narrow: ONLY a
 * `postgres://` / `postgresql://` URL keeps the `pg` path. Everything else — a
 * `pglite://` URL, a `file:` URL, or a bare absolute/relative path — is treated
 * as a PGlite data directory. This keeps server deploys (which always set a
 * `postgres://` `DATABASE_URL`) on `pg` unchanged, while letting the desktop
 * encode its data dir as `pglite://<path>` (or just the path).
 */
export function isPgliteDatabaseUrl(databaseUrl: string): boolean {
  const trimmed = databaseUrl.trim();
  if (trimmed === "") {
    return false;
  }
  return !/^postgres(ql)?:\/\//i.test(trimmed);
}

/**
 * Resolves a PGlite-selecting `databaseUrl` to an on-disk data directory.
 *
 * - `pglite://<path>`         -> `<path>` (absolute or relative, as written)
 * - `pglite://` (empty path)  -> the default `~/.growth-os/pglite`
 * - `file://<path>`           -> handed to PGlite verbatim (it accepts `file:`)
 * - bare path (e.g. `/data`)  -> used as-is
 * - `memory://` / `:memory:`  -> in-memory PGlite (handed to PGlite verbatim)
 *
 * The default lives under `infiniteOsHome()` (`~/.growth-os`, honoring
 * `GROWTH_OS_HOME` / the desktop userData override), matching where the rest of
 * the desktop runtime state is stored.
 */
export function resolvePgliteDataDir(databaseUrl: string): string {
  const trimmed = databaseUrl.trim();

  if (trimmed === "" || trimmed === "pglite://" || trimmed === "pglite:") {
    return join(infiniteOsHome(), "pglite");
  }

  // In-memory selector — pass straight through to PGlite.
  if (trimmed === "memory://" || trimmed === ":memory:") {
    return "memory://";
  }

  // `pglite://<path>`: strip the scheme, keep whatever path was written.
  const pgliteMatch = /^pglite:\/\/(.*)$/i.exec(trimmed);
  if (pgliteMatch) {
    const path = pgliteMatch[1];
    return path === "" ? join(infiniteOsHome(), "pglite") : path;
  }

  // `file://…` and bare paths are accepted by `PGlite.create` directly.
  return trimmed;
}

async function importPglite(): Promise<{
  create: (dataDir: string) => Promise<PgliteInstance>;
}> {
  // Lazy import so the real-Postgres bundle never loads the WASM payload.
  const mod = (await import("@electric-sql/pglite")) as {
    PGlite: { create(dataDir?: string): Promise<PgliteInstance> };
  };
  return {
    create: (dataDir: string) => mod.PGlite.create(dataDir)
  };
}

/**
 * Boots an embedded PGlite instance for `databaseUrl` and returns it wrapped in
 * the standard `InfiniteOsDb` interface produced by `wrapPool`.
 *
 * Creating the WASM instance is async, but `createInfiniteOsDb` MUST stay
 * synchronous (every caller uses it synchronously and the `pg` path returns a
 * plain object). So this returns a thin, synchronous LAZY FACADE: the PGlite
 * boot promise is created once and every `InfiniteOsDb` method awaits it before
 * delegating to the real `wrapPool`-built db. Concurrent first calls share the
 * single boot promise (no double-create).
 */
export function createPgliteDb(
  databaseUrl: string,
  wrapPool: (client: QueryableClient, closeFn: () => Promise<void>) => InfiniteOsDb
): InfiniteOsDb {
  const dataDir = resolvePgliteDataDir(databaseUrl);

  let booted: Promise<InfiniteOsDb> | undefined;
  const ready = (): Promise<InfiniteOsDb> => {
    if (!booted) {
      booted = importPglite()
        .then(({ create }) => create(dataDir))
        .then((instance) => wrapPool(instance, () => instance.close()));
    }
    return booted;
  };

  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ) {
      return (await ready()).query<T>(sql, params);
    },
    async one<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ) {
      return (await ready()).one<T>(sql, params);
    },
    async close() {
      // Only close if PGlite was actually booted; closing an un-booted facade is
      // a no-op (nothing to release).
      if (booted) {
        await (await booted).close();
      }
    },
    async ensureWorkspace(workspaceId, name) {
      return (await ready()).ensureWorkspace(workspaceId, name);
    },
    async ensureFirstPhaseDatasets(workspaceId) {
      return (await ready()).ensureFirstPhaseDatasets(workspaceId);
    },
    async connectSource(input) {
      return (await ready()).connectSource(input);
    },
    async updateSourceStatus(sourceId, status, lastSyncedAt) {
      return (await ready()).updateSourceStatus(sourceId, status, lastSyncedAt);
    },
    async createJob(input) {
      return (await ready()).createJob(input);
    },
    async claimNextJob(workerId, leaseSeconds) {
      return (await ready()).claimNextJob(workerId, leaseSeconds);
    },
    async completeJob(jobId, status, error) {
      return (await ready()).completeJob(jobId, status, error);
    },
    async withTransaction<T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T> {
      return (await ready()).withTransaction(fn);
    }
  };
}

/**
 * Runs the migration stack against an embedded PGlite data directory.
 *
 * This mirrors the `pg` migration loop in `runMigrations` (same
 * `schema_migrations` ledger, same per-file transactional apply, same
 * idempotency) with exactly two adapter-level differences PGlite forces:
 *
 *  1. The already-applied check gates on `rows.length`, NOT `rowCount`. PGlite's
 *     query result exposes `affectedRows` instead of pg's `rowCount`, so the
 *     `pg` loop's `if (existing.rowCount)` would be permanently falsy and every
 *     migration would re-apply on every boot. `rows.length` is correct on both.
 *
 *  2. Migration bodies are applied with `exec()` (multi-statement) rather than
 *     `query()` (single-statement). Migration files contain many statements;
 *     PGlite's `query` runs ONE, `exec` runs the whole script.
 *
 * The role/grant DDL in 0006 (and later re-grants) applies unmodified: PGlite
 * ships a full role/privilege system, the `create role` blocks are `if not
 * exists`-guarded, and the desktop connects as the implicit superuser so the
 * grants are simply never exercised at runtime (the engine never `SET ROLE`s).
 */
export async function runPgliteMigrations(
  databaseUrl: string,
  migrations: Migration[]
): Promise<string[]> {
  const dataDir = resolvePgliteDataDir(databaseUrl);
  const { create } = await importPglite();
  const db = await create(dataDir);
  try {
    await db.exec(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const applied: string[] = [];
    for (const migration of migrations) {
      const existing = await db.query<{ id: string }>(
        "select id from schema_migrations where id = $1",
        [migration.id]
      );
      // PGlite exposes `affectedRows`, not `rowCount` — gate on `rows.length`.
      if (existing.rows.length > 0) {
        continue;
      }
      try {
        await db.exec("begin");
        await db.exec(migration.sql);
        await db.query("insert into schema_migrations (id) values ($1)", [
          migration.id
        ]);
        await db.exec("commit");
        applied.push(migration.id);
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    }
    return applied;
  } finally {
    await db.close();
  }
}
