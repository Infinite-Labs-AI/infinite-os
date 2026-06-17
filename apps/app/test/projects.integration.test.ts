// End-to-end integration test against a LIVE Postgres (not stubbed).
// Covers the full multi-project cutover: real migration stack -> createProject ->
// connectSource -> cross-project isolation (DB + HTTP) -> deny-by-default auth.
//
// Skipped by default so `pnpm test` needs no database. Run it explicitly:
//   GROWTH_OS_INTEGRATION_DB=postgres://growth_os:growth_os_dev@127.0.0.1:5432/growth_os_it \
//     pnpm exec vitest run apps/app/test/projects.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInfiniteOsDb,
  createProject,
  deleteProject,
  findProject,
  listProjects,
  runMigrations,
  type InfiniteOsDb,
  type ProjectRow
} from "@infinite-os/db";

import { createApp } from "../src/index.js";

const IT_URL = process.env.GROWTH_OS_INTEGRATION_DB;
const OPERATOR = "it-operator-token";
const READ = "it-read-token";

function providersOf(payload: unknown): string[] {
  // /sources returns { ok, data: { sources: [{ provider, ... }] } } (be defensive about shape)
  const data = (payload as { data?: { sources?: Array<{ provider?: string }> } })?.data;
  const sources = data?.sources ?? (payload as { sources?: Array<{ provider?: string }> })?.sources ?? [];
  return sources.map((s) => String(s.provider)).sort();
}

describe.skipIf(!IT_URL)("projects e2e (live postgres)", () => {
  let db: InfiniteOsDb;
  let acme: ProjectRow;
  let beta: ProjectRow;

  beforeAll(async () => {
    process.env.DATABASE_URL = IT_URL;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "integration-test-encryption-key";
    process.env.GROWTH_OS_OPERATOR_TOKEN = OPERATOR;
    process.env.GROWTH_OS_READ_TOKEN = READ;

    await runMigrations(IT_URL as string); // real migration stack incl. 0021_setup_onboarding
    db = createInfiniteOsDb(IT_URL as string);

    acme = await createProject(db, "Acme");
    beta = await createProject(db, "Beta");
    await db.connectSource({ workspaceId: acme.id, provider: "stripe", connectionName: "acme-stripe" });
    await db.connectSource({ workspaceId: beta.id, provider: "x", connectionName: "beta-x" });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("createProject yields proj_ ids and findProject/listProjects resolve them", async () => {
    expect(acme.id).toMatch(/^proj_[0-9a-f]{16}$/);
    expect(beta.id).toMatch(/^proj_[0-9a-f]{16}$/);
    const all = await listProjects(db);
    const ids = all.map((p) => p.id);
    expect(ids).toContain(acme.id);
    expect(ids).toContain(beta.id);
    expect((await findProject(db, acme.id))?.id).toBe(acme.id);
    expect((await findProject(db, "Beta"))?.id).toBe(beta.id);
  });

  it("data is isolated per project at the DB layer", async () => {
    const acmeSources = await db.query<{ provider: string }>(
      "select provider from sources where workspace_id = $1",
      [acme.id]
    );
    const betaSources = await db.query<{ provider: string }>(
      "select provider from sources where workspace_id = $1",
      [beta.id]
    );
    expect(acmeSources.map((r) => r.provider)).toEqual(["stripe"]);
    expect(betaSources.map((r) => r.provider)).toEqual(["x"]);
  });

  it("app enforces deny-by-default auth + per-request workspace isolation (live DB)", async () => {
    const app = createApp({ databaseUrl: IT_URL });
    try {
      // public route reachable without a token
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

      // no token -> 401 on a guarded route
      expect((await app.inject({ method: "GET", url: "/sources" })).statusCode).toBe(401);

      // unknown workspace header -> 400
      const unknown = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${OPERATOR}`, "x-growth-os-workspace": "proj_doesnotexist0" }
      });
      expect(unknown.statusCode).toBe(400);

      // operator token + project A header -> A's sources ONLY
      const aRes = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${OPERATOR}`, "x-growth-os-workspace": acme.id }
      });
      expect(aRes.statusCode).toBe(200);
      expect(providersOf(aRes.json())).toEqual(["stripe"]);

      // same install token + project B header -> B's sources ONLY (cross-project isolation over HTTP)
      const bRes = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${OPERATOR}`, "x-growth-os-workspace": beta.id }
      });
      expect(bRes.statusCode).toBe(200);
      expect(providersOf(bRes.json())).toEqual(["x"]);

      // read token on an operator-only route -> 403 (gate survived authorityFromRequest deletion)
      const readOnProjects = await app.inject({
        method: "POST",
        url: "/projects",
        headers: { authorization: `Bearer ${READ}` },
        payload: { name: "Nope" }
      });
      expect(readOnProjects.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // Every table carrying a `workspace_id` FK, discovered dynamically from the
  // catalog so the assertion catches ANY table the static delete list misses.
  async function workspaceScopedTables(): Promise<Array<{ schema: string; table: string }>> {
    return db.query<{ schema: string; table: string }>(
      `
        select table_schema as schema, table_name as table
        from information_schema.columns
        where column_name = 'workspace_id'
          and table_schema in ('public', 'metadata', 'journey')
        order by table_schema, table_name
      `
    );
  }

  async function totalRowsFor(workspaceId: string): Promise<number> {
    const tables = await workspaceScopedTables();
    let total = 0;
    for (const { schema, table } of tables) {
      const rows = await db.query<{ n: string }>(
        `select count(*)::text as n from "${schema}"."${table}" where workspace_id = $1`,
        [workspaceId]
      );
      total += Number(rows[0]?.n ?? "0");
    }
    return total;
  }

  it("deleteProject removes the workspace + ALL child rows and leaves others untouched", async () => {
    // A throwaway project with child data spanning several dependency tiers
    // (sources -> sync_runs/sync_batches/raw_records, datasets, oauth_tokens).
    const doomed = await createProject(db, "Doomed");
    await db.connectSource({ workspaceId: doomed.id, provider: "google_analytics_4", connectionName: "doomed-ga4" });
    const source = await db.one<{ id: string }>(
      "select id from sources where workspace_id = $1 limit 1",
      [doomed.id]
    );
    const syncRunId = `run_doomed_${Date.now()}`;
    await db.query(
      "insert into sync_runs (id, workspace_id, source_id, status) values ($1, $2, $3, 'queued')",
      [syncRunId, doomed.id, source?.id]
    );
    const batchId = `batch_doomed_${Date.now()}`;
    await db.query(
      "insert into sync_batches (id, sync_run_id, workspace_id, source_id, status, batch_type) values ($1, $2, $3, $4, 'pending', 'full')",
      [batchId, syncRunId, doomed.id, source?.id]
    );
    const rawId = `raw_doomed_${Date.now()}`;
    await db.query(
      `insert into raw_records
         (id, workspace_id, source_id, sync_batch_id, provider, object_type, external_id, payload, source_record_hash)
       values ($1, $2, $3, $4, 'google_analytics_4', 'report', 'ext-1', '{}'::jsonb, 'hash-1')`,
      [rawId, doomed.id, source?.id, batchId]
    );
    await db.query(
      "insert into oauth_tokens (id, workspace_id, provider, encrypted_payload) values ($1, $2, 'google_analytics_4', 'enc')",
      [`oauth_doomed_${Date.now()}`, doomed.id]
    );
    const sbrId = `sbr_doomed_${Date.now()}`;
    await db.query(
      "insert into sync_batch_records (id, sync_batch_id, raw_record_id, record_status) values ($1, $2, $3, 'ok')",
      [sbrId, batchId, rawId]
    );

    // Sanity: there IS child data before the delete.
    expect(await totalRowsFor(doomed.id)).toBeGreaterThan(0);

    // Snapshot the OTHER projects' row counts to prove isolation.
    const acmeBefore = await totalRowsFor(acme.id);
    const betaBefore = await totalRowsFor(beta.id);

    const result = await deleteProject(db, doomed.id);
    expect(result).toEqual({ deleted: true });

    // The workspace row is gone and ZERO residual rows remain in any scoped table.
    expect(await findProject(db, doomed.id)).toBeNull();
    expect(await totalRowsFor(doomed.id)).toBe(0);
    const sbrLeft = await db.query<{ id: string }>(
      "select id from sync_batch_records where id = $1",
      [sbrId]
    );
    expect(sbrLeft).toHaveLength(0);

    // Other projects are untouched (no over-deletion across workspaces).
    expect(await totalRowsFor(acme.id)).toBe(acmeBefore);
    expect(await totalRowsFor(beta.id)).toBe(betaBefore);
    const remaining = (await listProjects(db)).map((p) => p.id);
    expect(remaining).toContain(acme.id);
    expect(remaining).toContain(beta.id);
    expect(remaining).not.toContain(doomed.id);
  });

  it("deleteProject on an unknown id returns { deleted: false } (no throw)", async () => {
    expect(await deleteProject(db, "proj_doesnotexist0")).toEqual({ deleted: false });
  });

  it("DELETE /projects/:id is operator-gated: 200 operator, 403 read-token, 404 unknown", async () => {
    const app = createApp({ databaseUrl: IT_URL });
    try {
      const victim = await createProject(db, "Victim");

      // read token -> 403 (operator-only route)
      const readRes = await app.inject({
        method: "DELETE",
        url: `/projects/${victim.id}`,
        headers: { authorization: `Bearer ${READ}` }
      });
      expect(readRes.statusCode).toBe(403);

      // operator + unknown id -> 404
      const unknownRes = await app.inject({
        method: "DELETE",
        url: "/projects/proj_doesnotexist0",
        headers: { authorization: `Bearer ${OPERATOR}` }
      });
      expect(unknownRes.statusCode).toBe(404);
      expect(unknownRes.json()).toMatchObject({ ok: false, error: { code: "project_not_found" } });

      // operator + real id -> 200 deleted
      const okRes = await app.inject({
        method: "DELETE",
        url: `/projects/${victim.id}`,
        headers: { authorization: `Bearer ${OPERATOR}` }
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toMatchObject({ ok: true, deleted: true });
      expect(await findProject(db, victim.id)).toBeNull();
    } finally {
      await app.close();
    }
  });
});
