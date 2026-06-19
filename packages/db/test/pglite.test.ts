import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  resolvePgliteDataDir
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
});

describe("pglite migration + query path (real WASM Postgres)", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-"));
    url = `pglite://${dataDir}`;
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "applies ALL 36 migrations on first boot and is idempotent on the second",
    async () => {
      const expectedCount = loadMigrations().length;
      expect(expectedCount).toBe(36);

      const firstRun = await runMigrations(url);
      expect(firstRun).toHaveLength(expectedCount);
      expect(firstRun).toContain("0001_control_plane.sql");
      expect(firstRun).toContain("0006_security_roles.sql");
      expect(firstRun).toContain("0036_chat_sessions_desktop_surface.sql");

      // Idempotent: a second boot re-applies zero (the `rows.length` gate, not
      // the pg `rowCount` gate, makes this true on PGlite).
      const secondRun = await runMigrations(url);
      expect(secondRun).toEqual([]);
    },
    60_000
  );

  it("created the schema_migrations ledger with all 36 rows", async () => {
    db = createInfiniteOsDb(url);
    const ledger = await db.query<{ id: string }>(
      "select id from schema_migrations order by id"
    );
    expect(ledger).toHaveLength(36);
    expect(ledger[0]?.id).toBe("0001_control_plane.sql");
    expect(ledger.at(-1)?.id).toBe("0036_chat_sessions_desktop_surface.sql");
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
