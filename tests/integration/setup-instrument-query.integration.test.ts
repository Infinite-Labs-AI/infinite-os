// End-to-end harness against a LIVE Postgres using fake setup providers plus
// fixture connector credentials. This covers the strongest secrets-free path
// we can automate today:
//   onboarding state -> resolved public ids -> instrumentation apply/verify ->
//   connect_source -> sync_source_now -> query execution through the app API.
//
// Skipped by default so normal `pnpm test` stays local-only. Run explicitly:
//   GROWTH_OS_INTEGRATION_DB=postgres://growth_os:growth_os_dev@127.0.0.1:5432/growth_os_it \
//     pnpm exec vitest run tests/integration/setup-instrument-query.integration.test.ts
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createInfiniteOsDb,
  createProject,
  runMigrations,
  type InfiniteOsDb,
  type SetupResolvedArtifacts
} from "../../packages/db/src/index.js";
import { createApp } from "../../apps/app/src/index.js";
import {
  runLiveSetupOnboarding,
  type Provisioner,
  type ProvisionerContext,
  type SetupInterview,
  type SetupProviderPublicArtifacts
} from "../../packages/setup/src/index.js";
import {
  applyInstallation,
  inspectWorkspace,
  planInstallation,
  verifyInstallation
} from "../../packages/instrument/src/index.js";

const IT_URL = process.env.GROWTH_OS_INTEGRATION_DB;
const OPERATOR = "it-operator-token";
const READ = "it-read-token";
const tempRoots: string[] = [];
const fixtureRoot = dirname(fileURLToPath(import.meta.url));

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../packages/instrument/test/fixtures", name);
  const targetRoot = mkdtempSync(join(tmpdir(), `setup-instrument-query-${name}-`));
  const target = join(targetRoot, name);
  tempRoots.push(targetRoot);
  cpSync(source, target, { recursive: true });
  return target;
}

function onboardingInterview(): SetupInterview {
  return {
    projectName: "Harness Co",
    websiteUrl: "https://harness.example",
    productSurface: "web",
    providerInventory: [
      {
        provider: "ga4",
        hasAccount: true,
        installState: "unknown",
        selected: true,
        recommended: true
      },
      {
        provider: "posthog",
        hasAccount: true,
        installState: "unknown",
        selected: true,
        recommended: true
      },
      {
        provider: "x",
        hasAccount: false,
        installState: "unknown",
        selected: false,
        recommended: false
      }
    ]
  };
}

function fakeSetupProvisioner(
  tool: "ga4" | "posthog",
  publicArtifacts: SetupProviderPublicArtifacts
): Provisioner {
  const assetId =
    tool === "ga4"
      ? String(publicArtifacts.propertyId ?? "properties/123456789")
      : String(publicArtifacts.projectId ?? "12345");
  const installId =
    tool === "ga4"
      ? String(publicArtifacts.measurementId ?? "G-TEST123")
      : String(publicArtifacts.projectKey ?? "phc_test_key");

  return {
    tool,
    friction: "green",
    capabilities: {
      detect: { rung: "api", automatable: true },
      setup: { rung: "api", automatable: true },
      connect: { rung: "api", automatable: true },
      sync: { rung: "api", automatable: true }
    },
    async detect() {
      return { accountExists: false, assetExists: false };
    },
    async setup() {
      return {
        result: { status: "ok", detail: `${tool} setup complete` },
        state: {
          accountExists: true,
          assetExists: true,
          assetId,
          installId
        },
        publicArtifacts,
        verification: {
          installStatus: "pending",
          queryabilityStatus: "pending"
        }
      };
    },
    async connect() {
      return {
        result: { status: "ok", detail: `${tool} connector saved` },
        state: {
          accountExists: true,
          assetExists: true,
          assetId,
          installId,
          credentialValid: true,
          sourceId: `seed_${tool}`
        },
        publicArtifacts
      };
    },
    async sync() {
      return {
        result: { status: "ok", detail: `${tool} verification primed` },
        state: {
          accountExists: true,
          assetExists: true,
          assetId,
          installId,
          credentialValid: true,
          tagInstalled: true,
          tagFiring: true
        },
        publicArtifacts,
        verification: {
          installStatus: "verified",
          queryabilityStatus: "verified",
          lastCheckedAt: "2026-06-09T00:00:00.000Z"
        }
      };
    }
  };
}

function operatorHeaders(workspaceId: string, host = "127.0.0.1") {
  return {
    authorization: `Bearer ${OPERATOR}`,
    "x-growth-os-workspace": workspaceId,
    host
  };
}

function readHeaders(workspaceId: string, host = "127.0.0.1") {
  return {
    authorization: `Bearer ${READ}`,
    "x-growth-os-workspace": workspaceId,
    host
  };
}

describe.skipIf(!IT_URL)("setup -> instrument -> query harness (live postgres)", () => {
  let db: InfiniteOsDb;

  beforeAll(async () => {
    process.env.DATABASE_URL = IT_URL;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "integration-test-encryption-key";
    process.env.GROWTH_OS_OPERATOR_TOKEN = OPERATOR;
    process.env.GROWTH_OS_READ_TOKEN = READ;
    await runMigrations(IT_URL as string);
    db = createInfiniteOsDb(IT_URL as string);
  });

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("persists onboarding artifacts, applies instrumentation, and answers queries from synced fixture data", async () => {
    const project = await createProject(db, "Setup Instrument Query Harness");
    const app = createApp({ database: db, databaseUrl: IT_URL as string });

    try {
      const onboarding = await runLiveSetupOnboarding({
        db,
        workspaceId: project.id,
        interview: onboardingInterview(),
        actions: {
          async execute() {
            throw new Error("setup harness actions should not be called by fake provisioners");
          }
        },
        prompt: { async ask() { return ""; }, note() {} },
        browserFactory: { async create() { throw new Error("unused"); } } as ProvisionerContext["browser"],
        createProvisioners: async () => [
          fakeSetupProvisioner("ga4", {
            measurementId: "G-HARNESS123",
            propertyId: "123456789"
          }),
          fakeSetupProvisioner("posthog", {
            projectId: "12345",
            projectKey: "phc_harness_key",
            apiHost: "https://us.i.posthog.com"
          })
        ]
      });

      expect(onboarding.completed).toEqual(["ga4", "posthog"]);
      expect(onboarding.paused).toEqual([]);
      expect(onboarding.failed).toEqual([]);

      const resolvedIds = await app.inject({
        method: "GET",
        url: "/setup/resolved-ids",
        headers: operatorHeaders(project.id)
      });
      expect(resolvedIds.statusCode).toBe(200);

      const artifacts = (resolvedIds.json() as { ok: true; data: SetupResolvedArtifacts }).data;
      expect(artifacts).toEqual({
        ga4: {
          measurementId: "G-HARNESS123",
          propertyId: "123456789"
        },
        posthog: {
          projectId: "12345",
          projectKey: "phc_harness_key",
          apiHost: "https://us.i.posthog.com"
        },
        x: {
          pixelId: null,
          eventTagIds: null
        }
      });

      const fixtureRoot = copyFixture("vite-react-basic");
      const plan = planInstallation({
        root: fixtureRoot,
        inspect: inspectWorkspace(fixtureRoot),
        workspaceId: project.id,
        artifacts: {
          ga4: {
            measurementId: String(artifacts.ga4.measurementId)
          },
          posthog: {
            projectKey: String(artifacts.posthog.projectKey),
            apiHost: String(artifacts.posthog.apiHost)
          }
        }
      });
      const applied = applyInstallation({
        root: fixtureRoot,
        workspaceId: project.id,
        plan
      });
      const verifiedInstall = verifyInstallation({ root: fixtureRoot });

      expect(applied.changedFiles).toEqual([
        "src/main.tsx",
        "src/lib/infinite-analytics.ts",
        ".infinite/install.json"
      ]);
      expect(verifiedInstall.buildOk).toBe(true);
      expect(readFileSync(join(fixtureRoot, "src/lib/infinite-analytics.ts"), "utf8")).toContain(
        "G-HARNESS123"
      );
      expect(readFileSync(join(fixtureRoot, "src/lib/infinite-analytics.ts"), "utf8")).toContain(
        "phc_harness_key"
      );

      const connectGa4 = await app.inject({
        method: "POST",
        url: "/sources/connect",
        headers: operatorHeaders(project.id),
        payload: {
          provider: "google_analytics_4",
          connectionName: "GA4 Fixture",
          credentialKind: "fixture"
        }
      });
      const connectPostHog = await app.inject({
        method: "POST",
        url: "/sources/connect",
        headers: operatorHeaders(project.id),
        payload: {
          provider: "posthog",
          connectionName: "PostHog Fixture",
          credentialKind: "fixture"
        }
      });

      expect(connectGa4.statusCode).toBe(200);
      expect(connectPostHog.statusCode).toBe(200);

      const ga4SourceId = String(
        (connectGa4.json() as { data: { source: { id: string } } }).data.source.id
      );
      const posthogSourceId = String(
        (connectPostHog.json() as { data: { source: { id: string } } }).data.source.id
      );

      const syncGa4 = await app.inject({
        method: "POST",
        url: "/tools/call",
        headers: operatorHeaders(project.id),
        payload: {
          actionId: "sync_source_now",
          input: { sourceId: ga4SourceId, refreshWindowDays: 30 }
        }
      });
      const syncPostHog = await app.inject({
        method: "POST",
        url: "/tools/call",
        headers: operatorHeaders(project.id),
        payload: {
          actionId: "sync_source_now",
          input: { sourceId: posthogSourceId, refreshWindowDays: 30 }
        }
      });

      expect(syncGa4.statusCode).toBe(200);
      expect(syncGa4.json()).toMatchObject({
        ok: true,
        actionId: "sync_source_now",
        status: "ok",
        data: {
          sourceId: ga4SourceId,
          provider: "google_analytics_4",
          recordsExtracted: 2,
          recordsLoaded: 2
        }
      });
      expect(syncPostHog.statusCode).toBe(200);
      expect(syncPostHog.json()).toMatchObject({
        ok: true,
        actionId: "sync_source_now",
        status: "ok",
        data: {
          sourceId: posthogSourceId,
          provider: "posthog",
          recordsExtracted: 2,
          recordsLoaded: 2
        }
      });

      const visitors = await app.inject({
        method: "POST",
        url: "/tools/call",
        headers: readHeaders(project.id),
        payload: {
          actionId: "run_metric_query",
          input: {
            metric: "site_visitors",
            view: "queryable.vw_site_traffic"
          }
        }
      });
      const signups = await app.inject({
        method: "POST",
        url: "/tools/call",
        headers: readHeaders(project.id),
        payload: {
          actionId: "run_metric_query",
          input: {
            metric: "signup_count",
            view: "queryable.vw_site_conversion_rate"
          }
        }
      });
      const byChannel = await app.inject({
        method: "POST",
        url: "/tools/call",
        headers: readHeaders(project.id),
        payload: {
          actionId: "run_breakdown_query",
          input: {
            metric: "signup_count",
            view: "queryable.vw_site_conversion_rate",
            groupBy: ["utm_source"],
            orderBy: { field: "signup_count", direction: "desc" },
            limit: 10
          }
        }
      });

      expect(visitors.statusCode).toBe(200);
      expect(visitors.json()).toMatchObject({
        ok: true,
        actionId: "run_metric_query",
        status: "ok",
        data: {
          metric: "site_visitors",
          view: "queryable.vw_site_traffic",
          rows: [{ site_visitors: "180" }]
        }
      });
      expect(signups.statusCode).toBe(200);
      expect(signups.json()).toMatchObject({
        ok: true,
        actionId: "run_metric_query",
        status: "ok",
        data: {
          metric: "signup_count",
          view: "queryable.vw_site_conversion_rate",
          rows: [{ signup_count: "2" }]
        }
      });
      expect(byChannel.statusCode).toBe(200);
      expect(byChannel.json()).toMatchObject({
        ok: true,
        actionId: "run_breakdown_query",
        status: "ok",
        data: {
          metric: "signup_count",
          view: "queryable.vw_site_conversion_rate",
          rows: expect.arrayContaining([
            expect.objectContaining({ utm_source: "google", signup_count: "1" }),
            expect.objectContaining({ utm_source: "newsletter", signup_count: "1" })
          ])
        }
      });
    } finally {
      await app.close();
    }
  });
});
