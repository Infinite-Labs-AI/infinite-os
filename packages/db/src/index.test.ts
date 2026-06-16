import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createProject,
  dbBoot,
  findProject,
  listProjects,
  mergeSetupProviderState,
  loadMigrations,
  migrationsDir,
  readLatestSetupPublicArtifacts,
  upsertWorkspaceSite
} from "./index.js";

describe("db smoke", () => {
  it("exports the db boot marker", () => {
    expect(dbBoot).toBe(true);
  });

  it("loads migrations from source and built package layouts", async () => {
    expect(loadMigrations().map((migration) => migration.id)).toContain(
      "0020_journey_core.sql"
    );
    expect(migrationsDir()).toMatch(/packages\/db\/migrations$/);

    execFileSync("pnpm", ["--filter", "@infinite-os/db", "build"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdio: "pipe"
    });
    const builtDb = await import(
      `${new URL("../dist/src/index.js", import.meta.url).href}?built=${Date.now()}`
    );

    expect(builtDb.migrationsDir()).toMatch(/packages\/db\/migrations$/);
    expect(
      builtDb.loadMigrations().map((migration: { id: string }) => migration.id)
    ).toContain("0020_journey_core.sql");
  });
});

describe("projects", () => {
  it("createProject inserts a proj_ row with a plain INSERT (no upsert)", async () => {
    let captured: { sql: string; params?: unknown[] } | undefined;
    const db = {
      async one<T>(sql: string, params?: unknown[]) {
        captured = { sql, params };
        return { id: String(params?.[0]), name: String(params?.[1]), createdAt: "2026-06-08T00:00:00Z" } as T;
      }
    };
    const row = await createProject(db as never, "Acme");
    expect(row.id).toMatch(/^proj_[0-9a-f]{16}$/);
    expect(row.name).toBe("Acme");
    expect(captured?.sql).toContain("insert into workspaces");
    expect(captured?.sql).not.toContain("on conflict"); // must NOT be an upsert
    expect(captured?.params?.[1]).toBe("Acme");
  });

  it("createProject throws if the insert returns no row (e.g. duplicate id)", async () => {
    const db = { async one<T>() { return null as T; } };
    await expect(createProject(db as never, "Acme")).rejects.toThrow();
  });

  it("listProjects selects ordered by created_at", async () => {
    let sql = "";
    const db = { async query<T>(s: string) { sql = s; return [] as T[]; } };
    await listProjects(db as never);
    expect(sql).toContain("from workspaces");
    expect(sql).toContain("order by created_at");
  });

  it("findProject matches by id or exact name, oldest first", async () => {
    let params: unknown[] | undefined;
    const db = {
      async one<T>(_sql: string, p?: unknown[]) { params = p; return { id: "proj_1", name: "Acme", createdAt: "t" } as T; }
    };
    const row = await findProject(db as never, "Acme");
    expect(row?.id).toBe("proj_1");
    expect(params).toEqual(["Acme", "Acme"]);
  });
});

describe("setup onboarding helpers", () => {
  it("upsertWorkspaceSite inserts a new primary site when one does not exist", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      async one<T>(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes("select id from workspace_sites")) {
          return null as T;
        }
        if (sql.includes("insert into workspace_sites")) {
          return { id: String(params?.[0]) } as T;
        }
        return null as T;
      }
    };

    const row = await upsertWorkspaceSite(db as never, {
      workspaceId: "ws_1",
      url: "https://acme.test",
      framework: "vite-react"
    });

    expect(row?.id).toMatch(/^site_[0-9a-f-]{36}$/);
    expect(calls.some((call) => call.sql.includes("insert into workspace_sites"))).toBe(true);
    expect(calls.at(-1)?.params).toEqual([
      row?.id,
      "ws_1",
      "https://acme.test",
      null,
      null,
      "vite-react",
      null
    ]);
  });

  it("upsertWorkspaceSite updates the existing primary row and tolerates missing url", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      async one<T>(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes("from workspace_sites")) {
          return { id: "site_existing" } as T;
        }
        if (sql.includes("update workspace_sites")) {
          return { id: "site_existing" } as T;
        }
        return null as T;
      }
    };

    const row = await upsertWorkspaceSite(db as never, {
      workspaceId: "ws_1",
      repoPath: "/repo",
      appDir: "apps/web",
      businessType: "saas"
    });

    expect(row).toEqual({ id: "site_existing" });
    expect(calls.some((call) => call.sql.includes("update workspace_sites"))).toBe(true);
    expect(calls.at(-1)?.params).toEqual([
      "site_existing",
      null,
      "/repo",
      "apps/web",
      null,
      "saas"
    ]);
  });

  it("mergeSetupProviderState deep-merges nested provider state instead of replacing it", async () => {
    let updatedPhaseState: unknown;
    const db = {
      async one<T>(sql: string, params?: unknown[]) {
        if (sql.includes("select phase_state from setup_runs")) {
          return {
            phase_state: {
              providers: {
                ga4: {
                  phases: { detect: { status: "ok", detail: "detected" } },
                  publicArtifacts: { measurementId: "G-OLD" },
                  secretRefs: { oauthTokenId: "tok_1" }
                }
              }
            }
          } as T;
        }
        return null as T;
      },
      async query(sql: string, params: unknown[] = []) {
        expect(sql).toContain("update setup_runs set phase_state = $2::jsonb");
        updatedPhaseState = params[1];
        return [];
      }
    };

    await mergeSetupProviderState(db as never, "run_1", "ga4", {
      phases: { setup: { status: "ok", detail: "created" } },
      publicArtifacts: { propertyId: "123456789" },
      verification: { installStatus: "verified", queryabilityStatus: "pending" }
    });

    expect(updatedPhaseState).toEqual({
      providers: {
        ga4: {
          phases: {
            detect: { status: "ok", detail: "detected" },
            setup: { status: "ok", detail: "created" }
          },
          publicArtifacts: { measurementId: "G-OLD", propertyId: "123456789" },
          secretRefs: { oauthTokenId: "tok_1" },
          verification: { installStatus: "verified", queryabilityStatus: "pending" }
        }
      }
    });
  });

  it("readLatestSetupPublicArtifacts normalizes only the allowlisted public fields", async () => {
    const db = {
      async query<T>() {
        return [
          {
            phase_state: {
              providers: {
                x: {
                  publicArtifacts: {
                    pixelId: "o1234",
                    eventTagIds: { purchase: "tw-1234-5678" },
                    apiSecret: "must-not-leak"
                  }
                }
              }
            }
          },
          {
            phase_state: {
              providers: {
                ga4: {
                  publicArtifacts: {
                    measurementId: "G-ACME123",
                    propertyId: "123456789",
                    apiSecret: "nope"
                  }
                },
                posthog: {
                  publicArtifacts: {
                    projectId: "12345",
                    projectKey: "phc_abc",
                    apiHost: "https://us.i.posthog.com",
                    personalApiKey: "nope"
                  }
                }
              }
            }
          }
        ] as T[];
      }
    };

    await expect(readLatestSetupPublicArtifacts(db as never, "ws_1")).resolves.toEqual({
      ga4: { measurementId: "G-ACME123", propertyId: "123456789" },
      posthog: {
        projectId: "12345",
        projectKey: "phc_abc",
        apiHost: "https://us.i.posthog.com"
      },
      x: { pixelId: "o1234", eventTagIds: { purchase: "tw-1234-5678" } }
    });
  });
});
