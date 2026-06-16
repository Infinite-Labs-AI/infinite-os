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
});
