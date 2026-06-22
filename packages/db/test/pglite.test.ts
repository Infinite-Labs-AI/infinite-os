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

  it("applied ALL 39 migrations on first boot and is idempotent on a re-run", async () => {
    expect(loadMigrations().length).toBe(39);
    expect(firstRun).toHaveLength(39);
    expect(firstRun).toContain("0001_control_plane.sql");
    expect(firstRun).toContain("0006_security_roles.sql");
    expect(firstRun).toContain("0036_chat_sessions_desktop_surface.sql");
    expect(firstRun).toContain("0037_meta_ads_ad_grain.sql");
    expect(firstRun).toContain("0038_chat_action_calls_workspace_id.sql");
    expect(firstRun).toContain("0039_connection_credentials_metadata.sql");

    // Idempotent: a second boot re-applies zero (the `rows.length` gate, not the pg `rowCount`
    // gate, makes this true on PGlite).
    const secondRun = await runMigrations(url);
    expect(secondRun).toEqual([]);
  });

  it("created the schema_migrations ledger with all 39 rows", async () => {
    const ledger = await db.query<{ id: string }>(
      "select id from schema_migrations order by id"
    );
    expect(ledger).toHaveLength(39);
    expect(ledger[0]?.id).toBe("0001_control_plane.sql");
    expect(ledger.at(-1)?.id).toBe("0039_connection_credentials_metadata.sql");
  });

  it("0038 pins chat_action_calls to its origin workspace (NOT NULL, FK, backfilled from chat_sessions)", async () => {
    // Column exists, is NOT NULL, and references workspaces(id).
    const columns = await db.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `select column_name, is_nullable, data_type
         from information_schema.columns
        where table_name = 'chat_action_calls' and column_name = 'workspace_id'`
    );
    expect(columns).toHaveLength(1);
    expect(columns[0]?.is_nullable).toBe("NO");
    expect(columns[0]?.data_type).toBe("text");

    // The FK to workspaces(id) exists.
    const fk = await db.query<{ constraint_name: string }>(
      `select tc.constraint_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
        where tc.table_name = 'chat_action_calls'
          and tc.constraint_type = 'FOREIGN KEY'
          and kcu.column_name = 'workspace_id'`
    );
    expect(fk.length).toBeGreaterThanOrEqual(1);

    // recordActionCall writes workspace_id; a row is bound to the session's workspace.
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_pin_a", "Pin A");
    });
    await db.query(
      `insert into chat_sessions (id, workspace_id, session_key, actor_id, surface)
       values ('sess_pin_a', 'ws_pin_a', 'sess_pin_a', 'cli', 'cli')`
    );
    await db.query(
      `insert into chat_action_calls (id, session_id, workspace_id, action_id, authority, status)
       values ('call_pin_a', 'sess_pin_a', 'ws_pin_a', 'create_meta_campaign', 'operator', 'requires_confirmation')`
    );
    const stored = await db.query<{ workspace_id: string }>(
      "select workspace_id from chat_action_calls where id = 'call_pin_a'"
    );
    expect(stored[0]?.workspace_id).toBe("ws_pin_a");
  });

  it("0039 adds the 5 connection_credentials operational columns with the stated types/defaults", async () => {
    const columns = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'connection_credentials'
          and column_name in (
            'selected_pixel_id', 'is_system_user', 'last_dispatch_at',
            'last_dispatch_status', 'last_error'
          )
        order by column_name`
    );
    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]));

    // All 5 new columns exist.
    expect(columns).toHaveLength(5);

    // selected_pixel_id — text, nullable.
    expect(byName.selected_pixel_id?.data_type).toBe("text");
    expect(byName.selected_pixel_id?.is_nullable).toBe("YES");

    // is_system_user — boolean, NOT NULL, default false.
    expect(byName.is_system_user?.data_type).toBe("boolean");
    expect(byName.is_system_user?.is_nullable).toBe("NO");
    expect(byName.is_system_user?.column_default).toBe("false");

    // last_dispatch_at — timestamptz, nullable.
    expect(byName.last_dispatch_at?.data_type).toBe("timestamp with time zone");
    expect(byName.last_dispatch_at?.is_nullable).toBe("YES");

    // last_dispatch_status — text, nullable, no CHECK.
    expect(byName.last_dispatch_status?.data_type).toBe("text");
    expect(byName.last_dispatch_status?.is_nullable).toBe("YES");

    // last_error — text, nullable.
    expect(byName.last_error?.data_type).toBe("text");
    expect(byName.last_error?.is_nullable).toBe("YES");

    // expires_at is REUSED (added 0021) — token_expires_at must NOT exist.
    const reused = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'connection_credentials'
          and column_name in ('expires_at', 'token_expires_at', 'account_external_id')`
    );
    const reusedNames = reused.map((r) => r.column_name);
    expect(reusedNames).toContain("expires_at");
    expect(reusedNames).not.toContain("token_expires_at");
    // account_external_id lives on sources — not denormalized here.
    expect(reusedNames).not.toContain("account_external_id");
  });

  it("0039 creates the partial-unique connection_credentials_source_kind_uq index (unique, partial on revoked_at is null, on (source_id, credential_kind))", async () => {
    const idx = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where tablename = 'connection_credentials'
          and indexname = 'connection_credentials_source_kind_uq'`
    );
    expect(idx).toHaveLength(1);
    const def = (idx[0]?.indexdef ?? "").toLowerCase();
    // Unique, on the right columns, partial on revoked_at is null.
    expect(def).toContain("create unique index");
    expect(def).toContain("(source_id, credential_kind)");
    expect(def).toContain("where (revoked_at is null)");
  });

  it("0039 partial-unique rejects two live rows of the same (source_id, credential_kind) but allows a revoked + live pair", async () => {
    // Seed a workspace + dataset + source so the FK chain holds.
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace("ws_cred_uq", "Cred UQ");
      await tx.ensureFirstPhaseDatasets("ws_cred_uq");
    });
    const ds = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = 'ws_cred_uq' and key = 'web'"
    );
    await db.query(
      `insert into sources (
         id, workspace_id, dataset_id, provider, connection_name, account_external_id, status
       ) values ('src_cred_uq', 'ws_cred_uq', $1, 'posthog', 'conn', 'acct', 'connected')`,
      [ds[0]?.id]
    );

    // First live credential of kind 'access_token' — inserts fine.
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ('cred_live_1', 'ws_cred_uq', 'src_cred_uq', 'access_token', 'enc')`
    );

    // Second live credential of the SAME (source_id, credential_kind) — rejected by the partial-unique.
    await expect(
      db.query(
        `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
         values ('cred_live_2', 'ws_cred_uq', 'src_cred_uq', 'access_token', 'enc')`
      )
    ).rejects.toThrow();

    // Revoke the live row, then a fresh live row of the same kind is ALLOWED (revoked row excluded from the index).
    await db.query("update connection_credentials set revoked_at = now() where id = 'cred_live_1'");
    await db.query(
      `insert into connection_credentials (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ('cred_live_3', 'ws_cred_uq', 'src_cred_uq', 'access_token', 'enc')`
    );
    const live = await db.query<{ count: string }>(
      `select count(*)::text as count from connection_credentials
        where source_id = 'src_cred_uq' and credential_kind = 'access_token' and revoked_at is null`
    );
    expect(live[0]?.count).toBe("1");
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

describe("connectSource writes the 0039 operational metadata + upserts on re-connect (P0-B2)", () => {
  let dataDir: string;
  let url: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-pglite-connectsrc-"));
    url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists selectedPixelId / isSystemUser / expiresAt / dispatch telemetry when supplied", async () => {
    await db.connectSource({
      workspaceId: "ws_cs_supplied",
      provider: "meta_ads",
      connectionName: "Meta Supplied",
      accountExternalId: "act_supplied",
      credentialKind: "access_token",
      encryptedPayload: "enc-supplied",
      selectedPixelId: "px_123",
      isSystemUser: true,
      expiresAt: "2027-01-02T03:04:05.000Z",
      lastDispatchAt: "2026-06-22T10:00:00.000Z",
      lastDispatchStatus: "succeeded",
      lastError: "prior transient error"
    });

    const rows = await db.query<{
      selected_pixel_id: string | null;
      is_system_user: boolean;
      expires_at: string | null;
      last_dispatch_at: string | null;
      last_dispatch_status: string | null;
      last_error: string | null;
    }>(
      `select selected_pixel_id, is_system_user, expires_at, last_dispatch_at,
              last_dispatch_status, last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_supplied'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected_pixel_id).toBe("px_123");
    expect(rows[0]?.is_system_user).toBe(true);
    expect(new Date(rows[0]?.expires_at ?? "").toISOString()).toBe("2027-01-02T03:04:05.000Z");
    expect(new Date(rows[0]?.last_dispatch_at ?? "").toISOString()).toBe("2026-06-22T10:00:00.000Z");
    expect(rows[0]?.last_dispatch_status).toBe("succeeded");
    expect(rows[0]?.last_error).toBe("prior transient error");
  });

  it("defaults the new columns (NULL / is_system_user=false) when omitted — existing callers unchanged", async () => {
    await db.connectSource({
      workspaceId: "ws_cs_default",
      provider: "stripe",
      connectionName: "Stripe Default",
      accountExternalId: "acct_default",
      credentialKind: "secret_key",
      encryptedPayload: "enc-default"
    });

    const rows = await db.query<{
      selected_pixel_id: string | null;
      is_system_user: boolean;
      expires_at: string | null;
      last_dispatch_at: string | null;
      last_dispatch_status: string | null;
      last_error: string | null;
    }>(
      `select selected_pixel_id, is_system_user, expires_at, last_dispatch_at,
              last_dispatch_status, last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_default'
          and cc.credential_kind = 'secret_key'
          and cc.revoked_at is null`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected_pixel_id).toBeNull();
    expect(rows[0]?.is_system_user).toBe(false);
    expect(rows[0]?.expires_at).toBeNull();
    expect(rows[0]?.last_dispatch_at).toBeNull();
    expect(rows[0]?.last_dispatch_status).toBeNull();
    expect(rows[0]?.last_error).toBeNull();
  });

  it("a re-run for the same (source_id, credential_kind) UPDATEs — one live row, no duplicate", async () => {
    const base = {
      workspaceId: "ws_cs_rerun",
      provider: "meta_ads" as const,
      connectionName: "Meta Rerun",
      accountExternalId: "act_rerun",
      credentialKind: "access_token"
    };

    await db.connectSource({
      ...base,
      encryptedPayload: "enc-first",
      selectedPixelId: "px_first",
      isSystemUser: false
    });
    await db.connectSource({
      ...base,
      encryptedPayload: "enc-second",
      selectedPixelId: "px_second",
      isSystemUser: true,
      lastError: "second-run error"
    });

    const rows = await db.query<{
      encrypted_payload: string;
      selected_pixel_id: string | null;
      is_system_user: boolean;
      last_error: string | null;
    }>(
      `select cc.encrypted_payload, cc.selected_pixel_id, cc.is_system_user, cc.last_error
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_rerun'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );

    // Exactly one live row — the upsert UPDATEd the existing row rather than orphaning a duplicate.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encrypted_payload).toBe("enc-second");
    expect(rows[0]?.selected_pixel_id).toBe("px_second");
    expect(rows[0]?.is_system_user).toBe(true);
    expect(rows[0]?.last_error).toBe("second-run error");

    // And there is still exactly one credential row total for this source (no orphaned duplicate).
    const total = await db.query<{ count: string }>(
      `select count(*)::text as count
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_rerun' and cc.credential_kind = 'access_token'`
    );
    expect(total[0]?.count).toBe("1");
  });

  it("a re-connect AFTER revoking the prior credential inserts a fresh live row (partial-unique does not block)", async () => {
    const base = {
      workspaceId: "ws_cs_revoke",
      provider: "meta_ads" as const,
      connectionName: "Meta Revoke",
      accountExternalId: "act_revoke",
      credentialKind: "access_token"
    };

    await db.connectSource({ ...base, encryptedPayload: "enc-original", selectedPixelId: "px_orig" });

    // Operator revokes the live credential (the partial-unique excludes revoked rows).
    await db.query(
      `update connection_credentials cc
          set revoked_at = now()
         from sources s
        where cc.source_id = s.id
          and s.workspace_id = 'ws_cs_revoke'
          and cc.credential_kind = 'access_token'`
    );

    // Re-connect — a fresh live row is inserted (the conflict target only sees the live partial index).
    await db.connectSource({ ...base, encryptedPayload: "enc-reconnected", selectedPixelId: "px_new" });

    const live = await db.query<{ encrypted_payload: string; selected_pixel_id: string | null }>(
      `select cc.encrypted_payload, cc.selected_pixel_id
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_revoke'
          and cc.credential_kind = 'access_token'
          and cc.revoked_at is null`
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.encrypted_payload).toBe("enc-reconnected");
    expect(live[0]?.selected_pixel_id).toBe("px_new");

    // Two rows total: one revoked (history) + one fresh live.
    const total = await db.query<{ revoked: boolean }[]>(
      `select (cc.revoked_at is not null) as revoked
         from connection_credentials cc
         join sources s on s.id = cc.source_id
        where s.workspace_id = 'ws_cs_revoke' and cc.credential_kind = 'access_token'
        order by cc.created_at`
    );
    expect(total).toHaveLength(2);
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
