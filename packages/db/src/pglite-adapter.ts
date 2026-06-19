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
//
// SINGLE-CONNECTION IMPLICATIONS: PGlite serves one connection, so on the desktop
// there is no cross-connection concurrency. `claimNextJob`'s `for update skip
// locked` therefore never actually skips a locked row (no other session can hold
// one) — it degrades to a plain serial dequeue, which is exactly right for a
// single-process desktop with one worker. Transactions get the same treatment:
// `withTransaction` uses PGlite's native `transaction()` (which holds the
// connection mutex) instead of bare begin/commit, so even concurrent in-process
// callers are serialized rather than interleaved on the shared connection.
// ---------------------------------------------------------------------------

// The subset of the PGlite instance this adapter relies on. PGlite's own
// `query` returns `{ rows, affectedRows?, fields }`, which already satisfies the
// `QueryableClient` contract the domain helpers + `wrapPool` consume — so a
// booted PGlite instance can be passed straight into `wrapPool` as the client.
// A PGlite transaction handle carries both `query` (so it satisfies QueryableClient and can be
// wrapped by wrapPool) AND `exec` (multi-statement, needed to apply a migration body inside the tx).
interface PgliteTransactionClient extends QueryableClient {
  exec(sql: string): Promise<unknown>;
}

interface PgliteInstance extends QueryableClient {
  exec(sql: string): Promise<unknown>;
  // PGlite's native transaction: it holds the single connection's mutex for the whole callback,
  // so concurrent transactions are serialized (not interleaved). The callback's `tx` carries
  // `query`, satisfying QueryableClient — so it can be wrapped by `wrapPool` like any client.
  transaction<T>(fn: (tx: PgliteTransactionClient) => Promise<T>): Promise<T>;
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
export function isPgliteDatabaseUrl(databaseUrl: string | null | undefined): boolean {
  // A missing url is NOT a PGlite selector — it keeps the `pg` path (which then fails loudly on a
  // real-Postgres deploy, or reads PG* env vars). Guarding here keeps the predicate total so a
  // caller passing `config.databaseUrl` (optional) can't trip a TypeError on `.trim()`.
  if (!databaseUrl) {
    return false;
  }
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

  // `pglite:<path>` — strip the scheme, keep whatever path was written. The `//` is optional so
  // `pglite:/data`, `pglite://data`, and `pglite:data` all resolve their path rather than falling
  // through to `return trimmed` (which would hand PGlite the literal `pglite:...` string as a dir).
  const pgliteMatch = /^pglite:(?:\/\/)?(.*)$/i.exec(trimmed);
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

  // The boot promise resolves to BOTH the wrapPool-built db (domain methods) AND the raw PGlite
  // instance — the latter is needed for the native transaction() (see withTransaction) and an
  // honest close(). Concurrent first calls share the single boot promise (no double-create).
  let booted: Promise<{ db: InfiniteOsDb; instance: PgliteInstance }> | undefined;
  let closed = false;
  const ready = (): Promise<{ db: InfiniteOsDb; instance: PgliteInstance }> => {
    if (!booted) {
      booted = importPglite()
        .then(({ create }) => create(dataDir))
        .then((instance) => ({ db: wrapPool(instance, () => instance.close()), instance }));
    }
    return booted;
  };

  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ) {
      return (await ready()).db.query<T>(sql, params);
    },
    async one<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ) {
      return (await ready()).db.one<T>(sql, params);
    },
    async close() {
      // Terminal + idempotent: a second close() is a no-op (the `closed` flag), so instance.close()
      // is never called twice.
      if (closed || !booted) return;
      closed = true;
      let instance: PgliteInstance;
      try {
        ({ instance } = await booted);
      } catch {
        // ONLY the failed-BOOT case is quiet: the boot promise rejected, so there is nothing to
        // release and re-throwing a boot error out of teardown would be wrong.
        return;
      }
      // A genuine close()/closeFs() failure on a HEALTHY instance (e.g. a final persistence flush
      // that didn't durably land) is NOT swallowed — masking it would hide real data loss, against
      // the no-fallbacks rule.
      await instance.close();
    },
    async ensureWorkspace(workspaceId, name) {
      return (await ready()).db.ensureWorkspace(workspaceId, name);
    },
    async ensureFirstPhaseDatasets(workspaceId) {
      return (await ready()).db.ensureFirstPhaseDatasets(workspaceId);
    },
    async connectSource(input) {
      return (await ready()).db.connectSource(input);
    },
    async updateSourceStatus(sourceId, status, lastSyncedAt) {
      return (await ready()).db.updateSourceStatus(sourceId, status, lastSyncedAt);
    },
    async createJob(input) {
      return (await ready()).db.createJob(input);
    },
    async claimNextJob(workerId, leaseSeconds) {
      return (await ready()).db.claimNextJob(workerId, leaseSeconds);
    },
    async completeJob(jobId, status, error) {
      return (await ready()).db.completeJob(jobId, status, error);
    },
    async withTransaction<T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T> {
      const { instance } = await ready();
      // Use PGlite's NATIVE transaction(), NOT wrapPool's single-client begin/commit. PGlite has
      // ONE connection: wrapPool would issue `begin` on the shared connection, so two concurrent
      // withTransaction callers would interleave into a single tangled transaction (the C4-review
      // HIGH). transaction() holds the connection mutex for the whole callback, serializing them.
      // The tx satisfies QueryableClient (it carries `query`), so wrap it as a child InfiniteOsDb
      // whose close is a no-op — the tx lifecycle is owned by transaction().
      return instance.transaction((tx) => {
        const child = wrapPool(tx, async () => undefined);
        // Re-entry guard: a NESTED withTransaction on this child would hit wrapPool's single-client
        // branch and issue `begin` on a connection ALREADY inside the native transaction. Postgres
        // ignores the nested BEGIN, and the inner COMMIT would commit the OUTER tx early — a silent
        // partial-commit / lost-rollback. No caller nests today; make a future one fail LOUD (per
        // the no-fallbacks rule) instead of silently corrupting.
        const guarded: InfiniteOsDb = {
          ...child,
          withTransaction: () => {
            throw new Error("nested withTransaction is unsupported on PGlite's single connection");
          },
        };
        return fn(guarded);
      });
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
      // Apply the migration body + ledger insert in ONE native transaction. PGlite's transaction()
      // wraps begin/commit and auto-rolls-back on throw, so a failing migration can't leave a
      // half-applied schema with the ledger marked done. (Migrations run serially at boot — single
      // caller — so there's no interleaving concern here; this is for atomic rollback + clarity,
      // replacing the hand-rolled begin/exec/commit/rollback.)
      await db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query("insert into schema_migrations (id) values ($1)", [migration.id]);
      });
      applied.push(migration.id);
    }
    return applied;
  } finally {
    await db.close();
  }
}
