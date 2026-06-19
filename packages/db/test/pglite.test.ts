import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInfiniteOsDb,
  createProject,
  deleteProject,
  findProject,
  listProjects,
  loadMigrations,
  runMigrations,
  type InfiniteOsDb
} from "../src/index.js";
import {
  isPgliteDatabaseUrl,
  resolvePgliteDataDir,
  runPgliteMigrations
} from "../src/pglite-adapter.js";

// End-to-end proof that the embedded PGlite backend applies the WHOLE migration
// stack on a real (WASM) Postgres data dir and serves real queries — the desktop
// path. Uses a throwaway temp data directory so it never touches `~/.growth-os`.

describe("pglite url selection", () => {
  it("routes non-postgres URLs to PGlite and keeps postgres URLs on pg", () => {
    expect(isPgliteDatabaseUrl("postgres://u:p@host:5432/db")).toBe(false);
    expect(isPgliteDatabaseUrl("postgresql://u:p@host:5432/db")).toBe(false);
    expect(isPgliteDatabaseUrl("POSTGRES://u:p@host/db")).toBe(false);
    expect(isPgliteDatabaseUrl("pglite:///abs/path")).toBe(true);
    expect(isPgliteDatabaseUrl("pglite://")).toBe(true);
    expect(isPgliteDatabaseUrl("file:///abs/path")).toBe(true);
    expect(isPgliteDatabaseUrl("/Users/me/.growth-os/pglite")).toBe(true);
    expect(isPgliteDatabaseUrl("memory://")).toBe(true);
  });

  it("strips the pglite:// scheme to a data dir and defaults to ~/.growth-os/pglite", () => {
    expect(resolvePgliteDataDir("pglite:///tmp/x")).toBe("/tmp/x");
    expect(resolvePgliteDataDir("/tmp/y")).toBe("/tmp/y");
    expect(resolvePgliteDataDir("memory://")).toBe("memory://");
    expect(resolvePgliteDataDir("pglite://")).toMatch(/\.growth-os\/pglite$/);
  });

  it("treats a missing/blank url as NOT pglite (keeps pg path, no TypeError on undefined)", () => {
    expect(isPgliteDatabaseUrl(undefined)).toBe(false);
    expect(isPgliteDatabaseUrl(null)).toBe(false);
    expect(isPgliteDatabaseUrl("")).toBe(false);
    expect(isPgliteDatabaseUrl("   ")).toBe(false);
  });

  it("resolves the pglite: scheme with OR without the // (no-slash edge)", () => {
    // Without the fix these fell through to `return trimmed`, handing PGlite a literal `pglite:...`.
    expect(resolvePgliteDataDir("pglite:/tmp/a")).toBe("/tmp/a");
    expect(resolvePgliteDataDir("pglite:relative/b")).toBe("relative/b");
    expect(resolvePgliteDataDir("pglite:")).toMatch(/\.growth-os\/pglite$/);
  });
});

describe("pglite migration + query path (real WASM Postgres)", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;
  let firstRun: string[];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-"));
    url = `pglite://${dataDir}`;
    // Boot ONCE for the whole describe: run the migration stack, then open the shared db. Doing this
    // in beforeAll (not as a side effect of the first `it`) keeps every test order-INDEPENDENT — the
    // concurrency regression test below must stand on its own under `-t` / `.only` / shuffle, not
    // rely on an earlier `it` having assigned `db`.
    firstRun = await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("applied ALL 37 migrations on first boot and is idempotent on a re-run", async () => {
    expect(loadMigrations().length).toBe(37);
    expect(firstRun).toHaveLength(37);
    expect(firstRun).toContain("0001_control_plane.sql");
    expect(firstRun).toContain("0006_security_roles.sql");
    expect(firstRun).toContain("0036_chat_sessions_desktop_surface.sql");
    expect(firstRun).toContain("0037_meta_ads_ad_grain.sql");

    // Idempotent: a second boot re-applies zero (the `rows.length` gate, not the pg `rowCount`
    // gate, makes this true on PGlite).
    const secondRun = await runMigrations(url);
    expect(secondRun).toEqual([]);
  });

  it("created the schema_migrations ledger with all 37 rows", async () => {
    const ledger = await db.query<{ id: string }>(
      "select id from schema_migrations order by id"
    );
    expect(ledger).toHaveLength(37);
    expect(ledger[0]?.id).toBe("0001_control_plane.sql");
    expect(ledger.at(-1)?.id).toBe("0037_meta_ads_ad_grain.sql");
  });

  it("created all five growth_os_* roles (0006 applied on PGlite)", async () => {
    const roles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname like 'growth_os_%' order by rolname"
    );
    expect(roles.map((r) => r.rolname)).toEqual([
      "growth_os_app",
      "growth_os_migrator",
      "growth_os_read_api",
      "growth_os_tool_agent",
      "growth_os_worker"
    ]);
  });

  it("runs real CRUD against the migrated schema (createProject/list/find)", async () => {
    const created = await createProject(db, "Acme Desktop");
    expect(created.id).toMatch(/^proj_[0-9a-f]{16}$/);
    expect(created.name).toBe("Acme Desktop");

    const listed = await listProjects(db);
    expect(listed.some((p) => p.id === created.id)).toBe(true);

    const found = await findProject(db, "Acme Desktop");
    expect(found?.id).toBe(created.id);
  });

  it("exercises a real withTransaction commit (ensureWorkspace + datasets)", async () => {
    const workspaceId = "ws_tx_test";
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, "Tx Workspace");
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });

    const datasets = await db.query<{ key: string }>(
      "select key from datasets where workspace_id = $1 order by key",
      [workspaceId]
    );
    expect(datasets.map((d) => d.key)).toEqual(["billing", "web"]);
  });

  it("rolls a failing withTransaction back (no partial workspace persists)", async () => {
    const workspaceId = "ws_tx_rollback";
    await expect(
      db.withTransaction(async (tx) => {
        await tx.ensureWorkspace(workspaceId, "Rollback Workspace");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const rows = await db.query<{ id: string }>(
      "select id from workspaces where id = $1",
      [workspaceId]
    );
    expect(rows).toHaveLength(0);
  });

  it("serializes CONCURRENT withTransaction calls — native tx, no interleaving (C4 HIGH)", async () => {
    // Read-modify-write one counter from N transactions at once. Under wrapPool's single-connection
    // begin/commit, the transactions would interleave on PGlite's ONE connection and lose updates
    // (final < N). PGlite's native transaction() holds the connection mutex, so they serialize and
    // every increment lands (final === N). The setImmediate yield maximizes the interleaving window.
    await db.query("create table if not exists tx_race (n int not null)");
    await db.query("delete from tx_race");
    await db.query("insert into tx_race (n) values (0)");

    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () =>
        db.withTransaction(async (tx) => {
          const rows = await tx.query<{ n: number }>("select n from tx_race");
          const current = Number(rows[0]?.n ?? 0);
          await new Promise((resolve) => setImmediate(resolve)); // yield — invites interleaving
          await tx.query("update tx_race set n = $1", [current + 1]);
        })
      )
    );

    const final = await db.query<{ n: number }>("select n from tx_race");
    expect(Number(final[0]?.n)).toBe(N); // every increment survived → no interleaving
  });

  it("can SELECT from a queryable view (full schema, incl. views, is live)", async () => {
    // vw_meta_ads_adset_daily is created by the last data migration (0035) — a
    // successful empty SELECT proves the whole view stack compiled and applied.
    const rows = await db.query(
      "select * from queryable.vw_meta_ads_adset_daily limit 1"
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it("deletes a project transactionally end-to-end", async () => {
    const created = await createProject(db, "Delete Me");
    const result = await deleteProject(db, created.id);
    expect(result.deleted).toBe(true);
    const found = await findProject(db, created.id);
    expect(found).toBeNull();
  });
});

describe("pglite boot-failure handling", () => {
  it("close() after a FAILED boot resolves — it swallows the boot error", async () => {
    // Point the data dir at a path under a regular FILE so PGlite.create can't mkdir it and the
    // lazy boot rejects on first use. close() must then NOT re-throw that boot error out of
    // teardown (awaiting the rejected boot promise would, without the try/catch).
    const base = mkdtempSync(join(tmpdir(), "infinite-os-pglite-badboot-"));
    const filePath = join(base, "afile");
    writeFileSync(filePath, "x");
    const badDb = createInfiniteOsDb(`pglite://${join(filePath, "nested")}`);
    try {
      await expect(badDb.query("select 1")).rejects.toThrow(); // boot fails on first use
      await expect(badDb.close()).resolves.toBeUndefined(); // close swallows it, no throw
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("close() on a never-used facade is a no-op (never boots PGlite)", async () => {
    const neverUsed = createInfiniteOsDb(`pglite://${join(tmpdir(), "infinite-os-pglite-unused")}`);
    await expect(neverUsed.close()).resolves.toBeUndefined();
  });

  it("double-close of a booted facade is idempotent (the `closed` flag no-ops the second)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-dblclose-"));
    try {
      const dbx = createInfiniteOsDb(`pglite://${dir}`);
      await dbx.query("select 1"); // force a real boot
      await expect(dbx.close()).resolves.toBeUndefined();
      // Raw PGlite.close() THROWS ("PGlite is closed") on a second call; the facade's `closed`
      // flag must make the second close a no-op rather than re-invoking it.
      await expect(dbx.close()).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a FAILING migration rolls back atomically — no ledger row, no partial schema (native tx)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-rollback-"));
    const url = `pglite://${dir}`;
    try {
      const ok = { id: "9001_ok.sql", sql: "create table mig_ok (id int);" };
      // The good DDL and the invalid statement share ONE migration body — the whole body must roll
      // back, so neither mig_bad nor a ledger row for 9002 may survive.
      const bad = { id: "9002_bad.sql", sql: "create table mig_bad (id int); this is not valid sql;" };
      await expect(runPgliteMigrations(url, [ok, bad])).rejects.toThrow();

      const after = createInfiniteOsDb(url);
      try {
        const ledger = await after.query<{ id: string }>(
          "select id from schema_migrations order by id"
        );
        expect(ledger.map((r) => r.id)).toEqual(["9001_ok.sql"]); // 9001 committed; 9002 NOT recorded
        const tables = await after.query<{ table_name: string }>(
          "select table_name from information_schema.tables where table_name in ('mig_ok','mig_bad')"
        );
        // mig_ok persisted (9001 committed in its own tx); mig_bad rolled back with the bad statement.
        expect(tables.map((r) => r.table_name).sort()).toEqual(["mig_ok"]);
      } finally {
        await after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
