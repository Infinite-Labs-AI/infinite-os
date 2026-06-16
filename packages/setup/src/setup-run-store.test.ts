import { describe, expect, it } from "vitest";

import {
  SETUP_RUN_STALE_MS,
  abandonActiveSetupRuns,
  createDbSetupRunStore
} from "./setup-run-store.js";
import type { SetupInterview } from "./types.js";

function fakeDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let existing: { id: string; status?: string; provider?: string; phase_state?: Record<string, unknown>; updated_at?: string | Date } | null = null;
  return {
    calls,
    setExisting(v: { id: string; status?: string; provider?: string; phase_state?: Record<string, unknown>; updated_at?: string | Date } | null) {
      existing = v;
    },
    db: {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("update setup_runs set phase_state = $2::jsonb") && existing) {
          existing = {
            ...existing,
            phase_state: params[1] as Record<string, unknown>
          };
        }
        return [];
      },
      async one(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return sql.includes("from setup_runs") ? existing : null;
      }
    }
  };
}

describe("createDbSetupRunStore", () => {
  it("inserts a new run when none is active", async () => {
    const f = fakeDb();
    const store = createDbSetupRunStore(f.db as never);
    const { resumed } = await store.startOrResume("ws1", "ga4");
    expect(resumed).toBe(false);
    expect(f.calls.some((c) => c.sql.includes("insert into setup_runs"))).toBe(true);
  });

  it("resumes the active run when one exists", async () => {
    const f = fakeDb();
    f.setExisting({ id: "run_existing", status: "paused_handoff", provider: "ga4" });
    const store = createDbSetupRunStore(f.db as never);
    const { runId, resumed } = await store.startOrResume("ws1", "ga4");
    expect(resumed).toBe(true);
    expect(runId).toBe("run_existing");
    expect(f.calls.some((c) => c.sql.includes("insert into setup_runs"))).toBe(false);
    expect(
      f.calls.some((c) => c.sql.includes("update setup_runs set status='running'"))
    ).toBe(true);
  });

  it("records a phase via jsonb_set and finishes", async () => {
    const f = fakeDb();
    f.setExisting({ id: "run_1", provider: "ga4", phase_state: {} });
    const store = createDbSetupRunStore(f.db as never);
    await store.recordPhase("run_1", "connect", { status: "ok", detail: "connected" });
    await store.finish("run_1", "succeeded");
    expect(f.calls.some((c) => c.sql.includes("update setup_runs set phase_state = $2::jsonb"))).toBe(true);
    expect(f.calls.some((c) => c.sql.includes("status = $2") && c.params[1] === "succeeded")).toBe(true);
  });

  it("records interview/site/provider state and preserves existing phases while merging artifacts", async () => {
    const f = fakeDb();
    f.setExisting({
      id: "run_1",
      provider: "ga4",
      phase_state: {
        interview: { projectName: "Acme", productSurface: "web", providerInventory: [] },
        providers: {
          ga4: {
            phases: { detect: { status: "ok", detail: "detected" } },
            publicArtifacts: { measurementId: "G-OLD" },
            secretRefs: { oauthTokenId: "tok_1" }
          }
        }
      }
    });
    const store = createDbSetupRunStore(f.db as never);
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: []
    };

    await store.recordSetupState("run_1", {
      interview,
      selectedProviders: ["ga4", "posthog"],
      recommendedProviders: ["ga4"],
      site: { workspaceId: "ws1", url: "https://acme.test", framework: "vite-react" }
    });
    await store.recordSetupState("run_1", {
      provider: "ga4",
      providerState: {
        publicArtifacts: { propertyId: "123456789" },
        verification: { installStatus: "verified", queryabilityStatus: "pending" },
        secretRefs: { oauthTokenId: "tok_1", connectionCredentialId: "cred_1" }
      }
    });

    const phaseStateUpdates = f.calls.filter((c) =>
      c.sql.includes("update setup_runs set phase_state = $2::jsonb")
    );
    expect(phaseStateUpdates).toHaveLength(2);
    expect(phaseStateUpdates[0]?.params[1]).toMatchObject({
      interview,
      selectedProviders: ["ga4", "posthog"],
      recommendedProviders: ["ga4"]
    });
    expect(phaseStateUpdates[1]?.params[1]).toMatchObject({
      interview,
      selectedProviders: ["ga4", "posthog"],
      recommendedProviders: ["ga4"],
      providers: {
        ga4: {
          phases: { detect: { status: "ok", detail: "detected" } },
          publicArtifacts: { measurementId: "G-OLD", propertyId: "123456789" },
          verification: { installStatus: "verified", queryabilityStatus: "pending" },
          secretRefs: { oauthTokenId: "tok_1", connectionCredentialId: "cred_1" }
        }
      }
    });
    expect(JSON.stringify(phaseStateUpdates[1]?.params[1])).not.toContain("access_token");
    expect(f.calls.some((c) => c.sql.includes("workspace_sites"))).toBe(true);
  });

  it("back-fills workspace_sites.ga4_source_id with a scoped UPDATE when site carries ga4SourceId", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return [];
      },
      async one(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("from setup_runs")) {
          return { id: "run_1", provider: "ga4", phase_state: {} };
        }
        // workspace_sites primary-row lookup -> existing row so upsert returns its id
        if (sql.includes("from workspace_sites")) {
          return { id: "site_1" };
        }
        if (sql.includes("update workspace_sites")) {
          return { id: "site_1" };
        }
        return null;
      }
    };
    const store = createDbSetupRunStore(db as never);

    await store.recordSetupState("run_1", {
      site: { workspaceId: "ws1", url: "https://acme.test", ga4SourceId: "src_ga4_1" }
    });

    const fkWrite = calls.find(
      (c) => c.sql.includes("update workspace_sites set ga4_source_id = $2")
    );
    expect(fkWrite).toBeDefined();
    expect(fkWrite?.params).toEqual(["site_1", "src_ga4_1"]);
    // The FK is scoped to the upserted site id and links setup_runs.site_id too.
    expect(
      calls.some((c) => c.sql.includes("update setup_runs set site_id = $2") && c.params[1] === "site_1")
    ).toBe(true);
  });

  it("does NOT write ga4_source_id when the site carries no source id", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return [];
      },
      async one(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("from setup_runs")) {
          return { id: "run_1", provider: "ga4", phase_state: {} };
        }
        if (sql.includes("from workspace_sites")) {
          return { id: "site_1" };
        }
        if (sql.includes("update workspace_sites")) {
          return { id: "site_1" };
        }
        return null;
      }
    };
    const store = createDbSetupRunStore(db as never);

    await store.recordSetupState("run_1", {
      site: { workspaceId: "ws1", url: "https://acme.test", framework: "vite-react" }
    });

    expect(
      calls.some((c) => c.sql.includes("update workspace_sites set ga4_source_id"))
    ).toBe(false);
  });

  describe("staleness reclaim", () => {
    const now = new Date("2026-06-10T12:00:00.000Z");

    it("reclaims a stale active run (marks it failed) and starts a fresh run", async () => {
      const f = fakeDb();
      f.setExisting({
        id: "run_stale",
        status: "running",
        provider: "ga4",
        updated_at: new Date(now.getTime() - SETUP_RUN_STALE_MS - 1)
      });
      const store = createDbSetupRunStore(f.db as never, { now: () => now });
      const { runId, resumed } = await store.startOrResume("ws1", "ga4");
      expect(resumed).toBe(false);
      expect(runId).not.toBe("run_stale");
      const abandon = f.calls.find((c) => c.sql.includes("status='failed'"));
      expect(abandon).toBeDefined();
      expect(abandon?.params[0]).toBe("run_stale");
      expect(abandon?.sql).toContain("finished_at=now()");
      expect(abandon?.sql).toContain("updated_at=now()");
      expect(f.calls.some((c) => c.sql.includes("insert into setup_runs"))).toBe(true);
      expect(f.calls.some((c) => c.sql.includes("update setup_runs set status='running'"))).toBe(false);
    });

    it("resumes an active run that is not stale", async () => {
      const f = fakeDb();
      f.setExisting({
        id: "run_fresh",
        status: "running",
        provider: "ga4",
        updated_at: new Date(now.getTime() - SETUP_RUN_STALE_MS + 1000)
      });
      const store = createDbSetupRunStore(f.db as never, { now: () => now });
      const { runId, resumed } = await store.startOrResume("ws1", "ga4");
      expect(resumed).toBe(true);
      expect(runId).toBe("run_fresh");
      expect(f.calls.some((c) => c.sql.includes("status='failed'"))).toBe(false);
      expect(f.calls.some((c) => c.sql.includes("insert into setup_runs"))).toBe(false);
    });

    it("treats an active run without updated_at as in progress (no reclaim)", async () => {
      const f = fakeDb();
      f.setExisting({ id: "run_no_ts", status: "running", provider: "ga4" });
      const store = createDbSetupRunStore(f.db as never, { now: () => now });
      const { runId, resumed } = await store.startOrResume("ws1", "ga4");
      expect(resumed).toBe(true);
      expect(runId).toBe("run_no_ts");
      expect(f.calls.some((c) => c.sql.includes("status='failed'"))).toBe(false);
    });

    it("respects an overridden staleMs threshold", async () => {
      const f = fakeDb();
      f.setExisting({
        id: "run_recent",
        status: "running",
        provider: "ga4",
        updated_at: new Date(now.getTime() - 5000)
      });
      const store = createDbSetupRunStore(f.db as never, { now: () => now, staleMs: 1000 });
      const { resumed } = await store.startOrResume("ws1", "ga4");
      expect(resumed).toBe(false);
      expect(f.calls.some((c) => c.sql.includes("status='failed'") && c.params[0] === "run_recent")).toBe(true);
    });

    it("reclaims a stale winner after losing the insert race", async () => {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      let insertAttempts = 0;
      let selects = 0;
      const db = {
        async query(sql: string, params: unknown[] = []) {
          calls.push({ sql, params });
          if (sql.includes("insert into setup_runs")) {
            insertAttempts += 1;
            if (insertAttempts === 1) {
              throw Object.assign(new Error("duplicate key"), { code: "23505" });
            }
          }
          return [];
        },
        async one(sql: string, params: unknown[] = []) {
          calls.push({ sql, params });
          selects += 1;
          // First select (before insert): no active run. Second select (after the
          // unique violation): a stale winner appeared.
          if (selects === 1) return null;
          return {
            id: "run_stale_winner",
            status: "running",
            provider: "ga4",
            updated_at: new Date(now.getTime() - SETUP_RUN_STALE_MS - 1)
          };
        }
      };
      const store = createDbSetupRunStore(db as never, { now: () => now });
      const { runId, resumed } = await store.startOrResume("ws1", "ga4");
      expect(resumed).toBe(false);
      expect(runId).not.toBe("run_stale_winner");
      expect(insertAttempts).toBe(2);
      expect(calls.some((c) => c.sql.includes("status='failed'") && c.params[0] === "run_stale_winner")).toBe(true);
    });

    it("resumes a fresh winner after losing the insert race", async () => {
      let selects = 0;
      const db = {
        async query(sql: string) {
          if (sql.includes("insert into setup_runs")) {
            throw Object.assign(new Error("duplicate key"), { code: "23505" });
          }
          return [];
        },
        async one() {
          selects += 1;
          if (selects === 1) return null;
          return { id: "run_fresh_winner", status: "running", provider: "ga4", updated_at: now };
        }
      };
      const store = createDbSetupRunStore(db as never, { now: () => now });
      const { runId, resumed } = await store.startOrResume("ws1", "ga4");
      expect(resumed).toBe(true);
      expect(runId).toBe("run_fresh_winner");
    });
  });
});

describe("abandonActiveSetupRuns", () => {
  it("marks active runs failed and returns the affected rows", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return [
          { id: "run_1", tool: "ga4" },
          { id: "run_2", tool: "posthog" }
        ];
      },
      async one() {
        return null;
      }
    };
    const cleared = await abandonActiveSetupRuns(db as never, "ws1");
    expect(cleared).toEqual([
      { id: "run_1", tool: "ga4" },
      { id: "run_2", tool: "posthog" }
    ]);
    const update = calls[0];
    expect(update?.sql).toContain("update setup_runs");
    expect(update?.sql).toContain("status in ('running','paused_handoff')");
    expect(update?.sql).toContain("returning id, tool");
    expect(update?.params).toEqual(["ws1", null]);
  });

  it("scopes the update to one tool when provided", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return [{ id: "run_1", tool: "ga4" }];
      },
      async one() {
        return null;
      }
    };
    const cleared = await abandonActiveSetupRuns(db as never, "ws1", "ga4");
    expect(cleared).toEqual([{ id: "run_1", tool: "ga4" }]);
    expect(calls[0]?.params).toEqual(["ws1", "ga4"]);
  });
});
