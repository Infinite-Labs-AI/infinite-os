import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredentialPayload, encryptCredentialPayload } from "@infinite-os/core";

import {
  launchPersistedSetupHandoff,
  readLiveSetupPublicArtifacts,
  runLiveSetupOnboarding,
  resumeLiveSetupOnboarding,
  startLiveSetupOnboarding,
  type ActiveSetupRun
} from "./live.js";
import type { BrowserSessionStore } from "./browser/session-store.js";
import type { ActionRunner, Provisioner, ProvisionerContext } from "./provisioner.js";
import type { SetupRunStore } from "./setup-controller.js";
import type { DetectionState, PhaseResult, SetupInterview } from "./types.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() }))
}));

const spawnMock = vi.mocked(spawn);

const blank: DetectionState = { accountExists: false, assetExists: false };

function fakeStore(): SetupRunStore {
  return {
    async startOrResume(_workspaceId, tool) {
      return { runId: `run_${tool}`, resumed: false };
    },
    async recordPhase() {},
    async finish() {},
    async recordSetupState() {}
  };
}

function capturingStore() {
  const updates: Array<{ runId: string; update: Record<string, unknown> }> = [];
  return {
    updates,
    store: {
      async startOrResume(_workspaceId, tool) {
        return { runId: `run_${tool}`, resumed: false };
      },
      async recordPhase() {},
      async finish() {},
      async recordSetupState(runId, update) {
        updates.push({ runId, update: update as Record<string, unknown> });
      }
    } satisfies SetupRunStore
  };
}

function fakeDb(activeRuns: ActiveSetupRun[] = []) {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
        return activeRuns.map((run) => ({
          id: run.id,
          tool: run.tool,
          provider: run.provider,
          status: run.status,
          pending_handoff: run.pendingHandoff
            ? {
                kind: run.pendingHandoff.kind,
                url: run.pendingHandoff.url,
                instructions: run.pendingHandoff.instructions,
                provider: run.pendingHandoff.provider,
                runId: run.pendingHandoff.runId,
                reason: run.pendingHandoff.reason,
                resume: run.pendingHandoff.resume,
                browser: run.pendingHandoff.browser
              }
            : null,
          browser_profile: run.browserProfile ?? null,
          phase_state: {
            providers: run.provider
              ? {
                  [run.provider]: {
                    browser: run.pendingHandoff?.browser ?? null,
                    publicArtifacts: run.provider === "posthog"
                      ? { projectId: "ph_project", projectKey: "phc_test_key", apiHost: "https://us.i.posthog.com" }
                      : null
                  }
                }
              : {}
          }
        })) as unknown as T[];
      }
      if (sql.includes("from setup_runs")) {
        return activeRuns.map((run) => ({
          id: run.id,
          workspace_id: "ws_1",
          provider: run.provider,
          status: run.status,
          pending_handoff: run.pendingHandoff,
          browser_profile: run.browserProfile ?? null,
          phase_state: {
            interview: {
              projectName: "Acme",
              websiteUrl: "https://acme.test",
              productSurface: "web",
              providerInventory: [
                {
                  provider: "posthog",
                  hasAccount: true,
                  installState: "unknown",
                  selected: true,
                  recommended: true
                }
              ]
            },
            providers: run.provider
              ? {
                  [run.provider]: {
                    browser: run.pendingHandoff?.browser ?? null,
                    publicArtifacts: run.provider === "posthog"
                      ? { projectId: "ph_project", projectKey: "phc_test_key", apiHost: "https://us.i.posthog.com" }
                      : null
                  }
                }
              : {}
          }
        })) as unknown as T[];
      }
      return [] as unknown as T[];
    },
    async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      if (sql.includes("where workspace_id = $1 and id = $2")) {
        const persisted = activeRuns.find((run) => run.id === "run_posthog");
        if (persisted) {
          return {
            id: persisted.id,
            provider: persisted.provider,
            status: persisted.status,
            pending_handoff: persisted.pendingHandoff,
            browser_profile: persisted.browserProfile ?? null,
            phase_state: {
              interview: {
                projectName: "Acme",
                websiteUrl: "https://acme.test",
                productSurface: "web",
                providerInventory: [
                  {
                    provider: "posthog",
                    hasAccount: true,
                    installState: "unknown",
                    selected: true,
                    recommended: true
                  }
                ]
              },
              providers: persisted.provider
                ? {
                    [persisted.provider]: {
                      browser: persisted.pendingHandoff?.browser ?? null,
                      publicArtifacts: persisted.provider === "posthog"
                        ? { projectId: "ph_project", projectKey: "phc_test_key", apiHost: "https://us.i.posthog.com" }
                        : null
                    }
                  }
                : {}
            }
          } as unknown as T;
        }
        return {
          id: "run_posthog",
          provider: "posthog",
          status: "paused_handoff",
          phase_state: {
            interview: {
              projectName: "Acme",
              websiteUrl: "https://acme.test",
              productSurface: "web",
              providerInventory: [
                {
                  provider: "posthog",
                  hasAccount: true,
                  installState: "unknown",
                  selected: true,
                  recommended: true
                }
              ]
            }
          }
        } as unknown as T;
      }
      return null;
    }
  };
}

const browserSessionStore: BrowserSessionStore = {
  async save(_sessionKey, ref) {
    return ref;
  },
  async load() {
    return null;
  },
  async clear() {}
};

function memoryBrowserSessionStore(): BrowserSessionStore {
  const sessions = new Map<string, { profileRef?: string; resumeNonce?: string; lastUrl?: string }>();
  return {
    async save(sessionKey, ref) {
      const next = {
        profileRef: typeof ref.profileRef === "string" ? ref.profileRef : undefined,
        resumeNonce: typeof ref.resumeNonce === "string" ? ref.resumeNonce : undefined,
        lastUrl: typeof ref.lastUrl === "string" ? ref.lastUrl : undefined
      };
      sessions.set(sessionKey, next);
      return next;
    },
    async load(sessionKey) {
      return sessions.get(sessionKey) ?? null;
    },
    async clear(sessionKey) {
      sessions.delete(sessionKey);
    }
  };
}

interface RecordedBrowserRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function jsonBrowserResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function posthogBrowserFactory(
  requests: RecordedBrowserRequest[],
  handle: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
) {
  return {
    async create() {
      return {
        async goto() {},
        async waitForSignal() {
          return null;
        },
        async readNetwork() {
          return [];
        },
        async request(
          url: string,
          init?: { method?: string; headers?: Record<string, string>; body?: string }
        ) {
          requests.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
          return handle(url, init);
        },
        async destroy() {}
      };
    }
  };
}

function capturingActions(executed: Array<{ id: string; input: unknown }>): ActionRunner {
  return {
    async execute(id, input) {
      executed.push({ id, input });
      return {
        ok: true,
        actionId: id,
        authority: "operator",
        status: "queued",
        data: id === "connect_source"
          ? {
              source: { id: "src_posthog", provider: "posthog" },
              connectionTest: {
                ok: true,
                mode: "live",
                provider: "posthog",
                accountExternalId: "project_1"
              }
            }
          : { job: { id: "job_posthog_sync" } },
        provenance: [id === "connect_source" ? "sources" : "job_runs"],
        caveats: [],
        truncated: false,
        nextActions: []
      } as unknown as Awaited<ReturnType<ActionRunner["execute"]>>;
    }
  };
}

function posthogBrowserResumeFixture() {
  const interview: SetupInterview = {
    projectName: "Acme",
    websiteUrl: "https://acme.test",
    productSurface: "web",
    providerInventory: [
      { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
      { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
      { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
    ]
  };
  const phaseState = {
    interview,
    providers: {
      posthog: {
        browser: {
          profileRef: "posthog-api-key",
          resumeNonce: "nonce-posthog",
          sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key",
          handoffUrl: "https://us.posthog.com/settings/user-api-keys",
          lastUrl: "https://us.posthog.com/settings/user-api-keys"
        }
      }
    }
  };
  const resumeDb = {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
        return [] as unknown as T[];
      }
      if (sql.includes("select phase_state") && sql.includes("from setup_runs")) {
        return [{ phase_state: phaseState }] as unknown as T[];
      }
      return [] as unknown as T[];
    },
    async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      if (sql.includes("from sources s")) {
        return null;
      }
      if (sql.includes("where workspace_id = $1 and id = $2")) {
        return {
          id: "run_posthog",
          provider: "posthog",
          status: "paused_handoff",
          pending_handoff: {
            kind: "open_url",
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Create a PostHog personal API key.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            browser: phaseState.providers.posthog.browser
          },
          browser_profile: "posthog-api-key",
          phase_state: phaseState
        } as unknown as T;
      }
      return null;
    }
  };
  return { interview, phaseState, resumeDb };
}

let artifactsDir: string;

beforeEach(() => {
  spawnMock.mockClear();
  delete process.env.INFINITE_SETUP_HANDOFF_BROWSER;
  // Confine the end-of-setup artifacts handoff file to a temp dir so no test can
  // ever write into the developer's real ~/.infinite/artifacts.
  artifactsDir = mkdtempSync(join(tmpdir(), "live-setup-artifacts-"));
  process.env.INFINITE_ARTIFACTS_DIR = artifactsDir;
});

afterEach(() => {
  delete process.env.INFINITE_ARTIFACTS_DIR;
  rmSync(artifactsDir, { recursive: true, force: true });
});

const ctx = {
  workspaceId: "ws_1",
  browser: { async create() { throw new Error("unused"); } },
  actions: {
    async execute() {
      return {
        ok: true,
        actionId: "noop",
        authority: "operator",
        status: "succeeded",
        provenance: [],
        caveats: [],
        nextActions: [],
        data: {}
      };
    }
  },
  prompt: { async ask() { return ""; }, note() {} },
  log() {}
} as unknown as ProvisionerContext;

function setupProvisioner(id: Provisioner["tool"], overrides: Partial<Provisioner> = {}): Provisioner {
  return {
    tool: id,
    friction: "green",
    capabilities: { detect: { rung: "api", automatable: true } },
    async detect() {
      return blank;
    },
    async setup() {
      return { status: "ok", detail: `${id} setup` };
    },
    async connect() {
      return { status: "ok", detail: `${id} connect` };
    },
    async sync() {
      return { status: "ok", detail: `${id} sync` };
    },
    async implement() {
      return { status: "ok", detail: `${id} implement` };
    },
    ...overrides
  };
}

describe("live setup orchestration", () => {
  it("starts PostHog signup in a persisted browser session when no account or credential exists yet", async () => {
    const handoffLauncher = vi.fn(async () => undefined);
    const notes: string[] = [];
    const { store, updates } = capturingStore();

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: { ...ctx.prompt, note(message: string) { notes.push(message); } },
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: store,
      handoffLauncher
    });

    expect(result.paused).toEqual(["posthog"]);
    expect(result.runs.posthog?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/signup"
      },
      data: {
        reason: "posthog_signup",
        resume: expect.objectContaining({
          status: "pending_account_setup",
          phase: "account_setup",
          step: "posthog_signup"
        })
      }
    });
    expect(result.runs.posthog?.providerState?.browser).toMatchObject({
      profileRef: "posthog-signup"
    });
    const browser = result.runs.posthog?.providerState?.browser;
    expect(browser?.sessionKey).toBe(
      "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup"
    );
    expect(handoffLauncher).toHaveBeenCalledWith({
      provider: "posthog",
      url: "https://us.posthog.com/signup",
      contextRef: "posthog-signup",
      sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup"
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("POSTHOG: Infinite is starting PostHog account setup in your browser.");
    expect(notes[0]).toContain("you do not need to find the project API key/pixel yet");
    expect(notes[0]).toContain("Open: https://us.posthog.com/signup");
    expect(notes[1]).toContain("→ PostHog not connected yet");
    expect(notes[1]).toContain("run `infinite setup status` to get the resume command");
    expect(updates).toContainEqual({
      runId: "run_posthog",
      update: expect.objectContaining({
        provider: "posthog",
        browserProfile: "posthog-signup",
        pendingHandoff: expect.objectContaining({
          reason: "posthog_signup",
          browser: expect.objectContaining({
            profileRef: "posthog-signup",
            sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup"
          })
        })
      })
    });
  });

  it("opens paused human auth handoffs in the system browser by default", async () => {
    const notes: string[] = [];

    await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: { ...ctx.prompt, note(message: string) { notes.push(message); } },
      browserFactory: ctx.browser,
      browserSessionStore: memoryBrowserSessionStore(),
      runStore: fakeStore()
    });

    const expectedCommand =
      process.platform === "darwin"
        ? { binary: "open", args: ["https://us.posthog.com/signup"] }
        : process.platform === "win32"
          ? { binary: "cmd", args: ["/c", "start", "", "https://us.posthog.com/signup"] }
          : { binary: "xdg-open", args: ["https://us.posthog.com/signup"] };
    expect(spawnMock).toHaveBeenCalledWith(
      expectedCommand.binary,
      expectedCommand.args,
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("POSTHOG: Infinite is starting PostHog account setup in your browser.");
    expect(notes[0]).toContain("you do not need to find the project API key/pixel yet");
    expect(notes[0]).toContain("Open: https://us.posthog.com/signup");
    expect(notes[1]).toContain("→ PostHog not connected yet");
  });

  it("opens the PostHog API key page when the founder already has an account but no reusable credential", async () => {
    const handoffLauncher = vi.fn(async () => undefined);

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher
    });

    expect(result.paused).toEqual(["posthog"]);
    expect(result.runs.posthog?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys"
      },
      data: {
        reason: "posthog_manual_key",
        resume: expect.objectContaining({
          status: "pending_auth",
          phase: "credential_setup",
          step: "posthog_manual_key"
        })
      }
    });
    expect(result.runs.posthog?.providerState?.browser).toMatchObject({
      profileRef: "posthog-api-key",
      sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key"
    });
    expect(handoffLauncher).toHaveBeenCalledWith({
      provider: "posthog",
      url: "https://us.posthog.com/settings/user-api-keys",
      contextRef: "posthog-api-key",
      sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key"
    });
  });

  it("marks GA4 as pending auth/account setup instead of giving a generic missing-connector handoff", async () => {
    const handoffLauncher = vi.fn(async () => undefined);
    const notes: string[] = [];

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: { ...ctx.prompt, note(message: string) { notes.push(message); } },
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher
    });

    expect(result.paused).toEqual(["ga4"]);
    expect(result.runs.ga4?.phases.detect).toMatchObject({
      status: "needs_human",
      detail: expect.stringContaining("opening Google Analytics account setup"),
      handoff: {
        kind: "open_url",
        url: "https://analytics.google.com/analytics/web/"
      },
      data: {
        reason: "google_login",
        resume: expect.objectContaining({
          status: "pending_account_setup",
          phase: "account_setup",
          step: "ga4_google_auth",
          source: "manual_handoff",
          nextAction: "resume_for_ga4_credential_check"
        })
      }
    });
    expect(result.runs.ga4?.phases.detect.detail).toContain("keeps this setup run state");
    expect(result.runs.ga4?.phases.detect.detail).toContain(
      "GA4 authorization lets Infinite create/read the Analytics property and web stream for sync/query"
    );
    expect(result.runs.ga4?.phases.detect.detail).toContain(
      "keep the Measurement ID (G-...) visible"
    );
    expect(result.runs.ga4?.phases.detect.detail).not.toContain("continue through the Admin API");
    expect(result.runs.ga4?.providerState?.browser).toMatchObject({
      profileRef: "ga4-google",
      sessionKey: "scope=workspace%3Aws_1|provider=ga4|context=ga4-google"
    });
    expect(handoffLauncher).toHaveBeenCalledWith({
      provider: "ga4",
      url: "https://analytics.google.com/analytics/web/",
      contextRef: "ga4-google",
      sessionKey: "scope=workspace%3Aws_1|provider=ga4|context=ga4-google"
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("GA4: Infinite is opening Google Analytics account setup in your browser.");
    expect(notes[0]).toContain("Measurement ID (G-...)");
    expect(notes[0]).toContain("Open: https://analytics.google.com/analytics/web/");
    expect(notes[1]).toContain("→ GA4 not connected yet");
    expect(notes[1]).toContain("Next: finish that step");
  });

  it("continues GA4 onboarding from stored setup OAuth state without requiring a preconnected source", async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    const handoffLauncher = vi.fn(async () => undefined);
    const executed: Array<{ id: string; input: unknown }> = [];
    const notes: string[] = [];
    const encryptedAppPayload = encryptCredentialPayload(
      {
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://growth-os.test/oauth/callback/google_analytics_4",
        authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: [
          "https://www.googleapis.com/auth/analytics.edit",
          "https://www.googleapis.com/auth/analytics.readonly"
        ]
      },
      "test-encryption-key"
    );
    const encryptedTokenPayload = encryptCredentialPayload(
      {
        accessToken: "stored-ga4-access-token",
        refreshToken: "stored-ga4-refresh-token",
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      "test-encryption-key"
    );
    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        if (sql.includes("select phase_state") && sql.includes("from setup_runs")) {
          return [] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("from oauth_tokens")) {
          return {
            oauth_app_id: "oauth_app_1",
            oauth_token_id: "oauth_token_1",
            encrypted_app_payload: encryptedAppPayload,
            encrypted_token_payload: encryptedTokenPayload
          } as unknown as T;
        }
        return null;
      }
    };
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
        return new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/1",
                propertySummaries: [{ property: "properties/123", displayName: "Acme" }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams") {
        return new Response(
          JSON.stringify({
            dataStreams: [
              {
                type: "WEB_DATA_STREAM",
                webStreamData: {
                  measurementId: "G-ACME123",
                  defaultUri: "https://acme.test"
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runLiveSetupOnboarding({
        db: db as never,
        workspaceId: "ws_1",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
            { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
            { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
          ]
        },
        actions: {
          async execute(id, input, _session) {
            executed.push({ id, input });
            if (id === "connect_source") {
              return {
                ok: true,
                actionId: "connect_source",
                authority: "operator",
                status: "queued",
                provenance: ["sources"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: {
                  source: { id: "src_ga4", provider: "google_analytics_4" },
                  connectionTest: { ok: true, mode: "live", accountExternalId: "properties/123" }
                }
              };
            }
            if (id === "start_source_sync") {
              return {
                ok: true,
                actionId: "start_source_sync",
                authority: "operator",
                status: "queued",
                provenance: ["job_runs"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: { job: { id: "job_ga4_1" } }
              };
            }
            throw new Error(`unexpected action: ${id}`);
          }
        },
        prompt: { ...ctx.prompt, note(message: string) { notes.push(message); } },
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: fakeStore(),
        handoffLauncher
      });

      expect(result.paused).toEqual([]);
      expect(result.completed).toEqual(["ga4"]);
      // The picker echoes the committed choice, then the per-provider confirmation.
      expect(notes).toHaveLength(2);
      expect(notes[0]).toBe("GA4: using the existing property Acme — properties/123.");
      expect(notes[1]).toContain("✓ GA4 connected — property properties/123 · Measurement ID G-ACME123.");
      expect(notes[1]).toContain(
        "Next: use the install command at the end of this setup (covers all connected providers)."
      );
      expect(notes[1]).not.toContain("npx infinite-tag install");
      expect(result.runs.ga4?.phases.detect).toMatchObject({
        status: "ok",
        detail: "Using your selected GA4 property and web data stream."
      });
      expect(result.runs.ga4?.providerState?.publicArtifacts).toEqual({
        propertyId: "properties/123",
        measurementId: "G-ACME123",
        defaultUri: "https://acme.test"
      });
      expect(result.runs.ga4?.providerState?.secretRefs).toEqual({
        oauthAppId: "oauth_app_1",
        oauthTokenId: "oauth_token_1"
      });
      expect(executed).toEqual([
        {
          id: "connect_source",
          input: expect.objectContaining({
            provider: "google_analytics_4",
            credentialKind: "oauth_access_token",
            credentialPayload: expect.objectContaining({
              propertyId: "properties/123",
              accessToken: "stored-ga4-access-token",
              refreshToken: "stored-ga4-refresh-token"
            })
          })
        },
        {
          id: "start_source_sync",
          input: {
            sourceId: "src_ga4",
            mode: "incremental",
            refreshWindowDays: 7
          }
        }
      ]);
      expect(handoffLauncher).not.toHaveBeenCalled();
      expect(result.resolvedPublicArtifacts.ga4).toEqual({
        measurementId: null,
        propertyId: null
      });
      // Fake store persists nothing → no DB-resolved artifacts → no combined command.
      expect(result.installCommand).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  });

  it("marks GA4 auth-only handoff as credential setup and avoids promising automatic Admin API continuation", async () => {
    const handoffLauncher = vi.fn(async () => undefined);

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher
    });

    expect(result.paused).toEqual(["ga4"]);
    expect(result.runs.ga4?.phases.detect).toMatchObject({
      status: "needs_human",
      detail: expect.stringContaining("opening Google Analytics authorization"),
      data: {
        reason: "google_login",
        resume: expect.objectContaining({
          status: "pending_auth",
          phase: "credential_setup",
          step: "ga4_google_auth",
          source: "manual_handoff",
          nextAction: "resume_for_ga4_credential_check"
        })
      }
    });
    expect(result.runs.ga4?.phases.detect.detail).toContain("approve access for this workspace");
    expect(result.runs.ga4?.phases.detect.detail).toContain(
      "GA4 authorization lets Infinite create/read the Analytics property and web stream for sync/query"
    );
    expect(result.runs.ga4?.phases.detect.detail).not.toContain("continue through the Admin API");
  });

  it("starts a setup-owned GA4 OAuth bootstrap session and persists only resumable metadata", async () => {
    const handoffLauncher = vi.fn(async () => undefined);
    const { store, updates } = capturingStore();
    const bootstrap = {
      prepareConfig: vi.fn(async () => ({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      start: vi.fn(async (_input: unknown) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        expiresAt: "2099-01-01T00:00:00.000Z"
      })),
      status: vi.fn(async (_sessionId: string) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        expiresAt: "2099-01-01T00:00:00.000Z"
      })),
      exchange: vi.fn(async (_sessionId: string) => ({
        ok: true,
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "authorized",
        oauthAppId: "oauth_app_1",
        oauthTokenId: "oauth_token_1"
      }))
    };

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: store,
      handoffLauncher,
      ga4OauthBootstrap: bootstrap,
      // status stays pending → the poll loop must time out fast and fall back to
      // the resumable pause without waiting the production 5-minute window.
      ga4OauthWaitMs: 10,
      ga4OauthPollIntervalMs: 1,
      sleep: async () => {}
    });

    expect(result.paused).toEqual(["ga4"]);
    expect(result.runs.ga4?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1"
      },
      data: {
        reason: "google_login",
        resume: expect.objectContaining({
          status: "pending_auth",
          phase: "credential_setup",
          step: "ga4_oauth_consent",
          oauthSessionId: "oauth_session_1",
          nextAction: "resume_for_ga4_oauth_exchange"
        })
      }
    });
    expect(bootstrap.prepareConfig).toHaveBeenCalledTimes(1);
    expect(bootstrap.start).toHaveBeenCalledWith({
      clientId: "ga-client-id",
      clientSecret: "ga-client-secret",
      redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
    });
    expect(handoffLauncher).toHaveBeenCalledWith({
      provider: "ga4",
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
      contextRef: "ga4-google",
      sessionKey: "scope=workspace%3Aws_1|provider=ga4|context=ga4-google"
    });

    const persisted = [...updates].reverse().find((entry) => entry.runId === "run_ga4")?.update;
    expect(persisted).toBeDefined();
    expect(persisted?.pendingHandoff).toMatchObject({
      provider: "ga4",
      runId: "run_ga4",
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
      reason: "google_login",
      resume: expect.objectContaining({
        oauthSessionId: "oauth_session_1"
      }),
      browser: expect.objectContaining({
        handoffUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1"
      })
    });
    expect(JSON.stringify(persisted)).not.toContain("ga-client-secret");
  });

  it("auto-resolves a setup-owned GA4 OAuth bootstrap when the browser consent completes during the poll window", async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    const encryptedAppPayload = encryptCredentialPayload(
      {
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: [
          "https://www.googleapis.com/auth/analytics.edit",
          "https://www.googleapis.com/auth/analytics.readonly"
        ]
      },
      "test-encryption-key"
    );
    const encryptedTokenPayload = encryptCredentialPayload(
      {
        accessToken: "stored-ga4-access-token",
        refreshToken: "stored-ga4-refresh-token",
        // Far-future so the stored token reads as live and no refresh fetch fires.
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      "test-encryption-key"
    );
    let exchanged = false;
    const bootstrap = {
      prepareConfig: vi.fn(async () => ({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      start: vi.fn(async (_input: unknown) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      status: vi.fn(async (_sessionId: string) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "completed" as const,
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        hasAuthorizationCode: true,
        error: null
      })),
      exchange: vi.fn(async (_sessionId: string) => {
        exchanged = true;
        return {
          ok: true,
          sessionId: "oauth_session_1",
          provider: "google_analytics_4",
          status: "authorized",
          oauthAppId: "oauth_app_1",
          oauthTokenId: "oauth_token_1"
        };
      })
    };
    const executed: Array<{ id: string; input: unknown }> = [];
    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("from oauth_tokens")) {
          // Token row only exists once the bootstrap exchange has run.
          return exchanged
            ? ({
                oauth_app_id: "oauth_app_1",
                oauth_token_id: "oauth_token_1",
                encrypted_app_payload: encryptedAppPayload,
                encrypted_token_payload: encryptedTokenPayload
              } as unknown as T)
            : null;
        }
        return null;
      }
    };
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
        return new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/1",
                propertySummaries: [{ property: "properties/123", displayName: "Acme" }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams") {
        return new Response(
          JSON.stringify({
            dataStreams: [
              {
                type: "WEB_DATA_STREAM",
                webStreamData: { measurementId: "G-ACME123", defaultUri: "https://acme.test" }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runLiveSetupOnboarding({
        db: db as never,
        workspaceId: "ws_1",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
            { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
            { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
          ]
        },
        actions: {
          async execute(id, input, _session) {
            executed.push({ id, input });
            if (id === "connect_source") {
              return {
                ok: true,
                actionId: "connect_source",
                authority: "operator",
                status: "queued",
                provenance: ["sources"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: {
                  source: { id: "src_ga4", provider: "google_analytics_4" },
                  connectionTest: { ok: true, mode: "live", accountExternalId: "properties/123" }
                }
              };
            }
            if (id === "start_source_sync") {
              return {
                ok: true,
                actionId: "start_source_sync",
                authority: "operator",
                status: "queued",
                provenance: ["job_runs"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: { job: { id: "job_ga4_1" } }
              };
            }
            throw new Error(`unexpected action: ${id}`);
          }
        },
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: fakeStore(),
        handoffLauncher: async () => undefined,
        ga4OauthBootstrap: bootstrap,
        // Block-and-poll with a fast injected sleep so the test never waits real time.
        ga4OauthWaitMs: 1000,
        ga4OauthPollIntervalMs: 1,
        sleep: async () => {}
      });

      expect(bootstrap.start).toHaveBeenCalledTimes(1);
      expect(bootstrap.status).toHaveBeenCalledWith("oauth_session_1");
      expect(bootstrap.exchange).toHaveBeenCalledWith("oauth_session_1");
      // The whole point: no human handoff, GA4 resolves end-to-end.
      expect(result.paused).toEqual([]);
      expect(result.completed).toEqual(["ga4"]);
      expect(JSON.stringify(result)).not.toContain("needs_human");
      expect(executed).toEqual([
        {
          id: "connect_source",
          input: expect.objectContaining({
            provider: "google_analytics_4",
            credentialKind: "oauth_access_token",
            credentialPayload: expect.objectContaining({
              propertyId: "properties/123",
              accessToken: "stored-ga4-access-token",
              refreshToken: "stored-ga4-refresh-token"
            })
          })
        },
        {
          id: "start_source_sync",
          input: { sourceId: "src_ga4", mode: "incremental", refreshWindowDays: 7 }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  });

  it("falls back to a resumable GA4 OAuth pause when the browser consent never completes within the poll window", async () => {
    const { store } = capturingStore();
    const bootstrap = {
      prepareConfig: vi.fn(async () => ({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      start: vi.fn(async (_input: unknown) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      status: vi.fn(async (_sessionId: string) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      exchange: vi.fn(async (_sessionId: string) => {
        throw new Error("exchange must not run when consent never completes");
      })
    };

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: store,
      handoffLauncher: async () => undefined,
      ga4OauthBootstrap: bootstrap,
      // status stays pending → the loop times out fast and yields the resumable pause.
      ga4OauthWaitMs: 5,
      ga4OauthPollIntervalMs: 1,
      sleep: async () => {}
    });

    expect(result.paused).toEqual(["ga4"]);
    expect(result.completed).toEqual([]);
    expect(bootstrap.status).toHaveBeenCalled();
    expect(bootstrap.exchange).not.toHaveBeenCalled();
    expect(result.runs.ga4?.phases.detect).toMatchObject({
      status: "needs_human",
      data: {
        reason: "google_login",
        resume: expect.objectContaining({
          step: "ga4_oauth_consent",
          oauthSessionId: "oauth_session_1",
          nextAction: "resume_for_ga4_oauth_exchange"
        })
      }
    });
  });

  it("surfaces status.error and offers the options menu when the GA4 OAuth session fails (#7)", async () => {
    const { store } = capturingStore();
    const onFailed = vi.fn(async () => null);
    const bootstrap = {
      prepareConfig: vi.fn(async () => ({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      start: vi.fn(async (_input: unknown) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      status: vi.fn(async (_sessionId: string) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "failed" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        error: "redirect_uri_mismatch"
      })),
      exchange: vi.fn(async (_sessionId: string) => {
        throw new Error("exchange must not run on a failed session");
      })
    };

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: store,
      handoffLauncher: async () => undefined,
      ga4OauthBootstrap: bootstrap,
      ga4OauthWaitMs: 1000,
      ga4OauthPollIntervalMs: 1,
      sleep: async () => {},
      // Inject the interaction so the failure surfaces status.error; returning null = pause.
      ga4OauthInteraction: { onFailed }
    });

    expect(onFailed).toHaveBeenCalledWith({ error: "redirect_uri_mismatch", sessionId: "oauth_session_1" });
    expect(bootstrap.exchange).not.toHaveBeenCalled();
    // A null decision falls through to the resumable pause.
    expect(result.paused).toEqual(["ga4"]);
  });

  // Regression for the #7 cancellable-wait teardown bug. The wait is armed once (waitForDecision)
  // for the whole poll; on the terminal paths #7 added (failed/timeout) no key is pressed, so the
  // poll MUST tear the wait down (cancelWait) BEFORE onTimeout()/onFailed() open their stdin menu —
  // otherwise the stale keypress listener collides with the menu's own. Here we assert the poll
  // calls cancelWait strictly before onFailed/onTimeout (the CLI's cancelWait does the real stdin
  // teardown). Pre-fix the poll never calls cancelWait → these order assertions fail.
  it("disarms the keypress wait (cancelWait) before opening the failed/timeout menu (#7)", async () => {
    for (const terminal of ["failed", "timeout"] as const) {
      const { store } = capturingStore();
      const order: string[] = [];
      const interaction = {
        waitForDecision: vi.fn(async () => null),
        cancelWait: vi.fn(() => {
          order.push("cancelWait");
        }),
        onFailed: vi.fn(async () => {
          order.push("onFailed");
          return null;
        }),
        onTimeout: vi.fn(async () => {
          order.push("onTimeout");
          return null;
        })
      };
      const bootstrap = {
        prepareConfig: vi.fn(async () => ({
          clientId: "ga-client-id",
          clientSecret: "ga-client-secret",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
        })),
        start: vi.fn(async (_input: unknown) => ({
          sessionId: "oauth_session_1",
          provider: "google_analytics_4",
          status: "pending" as const,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
        })),
        status: vi.fn(async (_sessionId: string) => ({
          sessionId: "oauth_session_1",
          provider: "google_analytics_4",
          status: terminal === "failed" ? ("failed" as const) : ("pending" as const),
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
          error: terminal === "failed" ? "redirect_uri_mismatch" : null
        })),
        exchange: vi.fn(async () => {
          throw new Error("exchange must not run");
        })
      };

      const result = await runLiveSetupOnboarding({
        db: fakeDb() as never,
        workspaceId: "ws_1",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
            { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
            { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
          ]
        },
        actions: ctx.actions,
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: store,
        handoffLauncher: async () => undefined,
        ga4OauthBootstrap: bootstrap,
        // A tiny window so the pending (non-failed) case times out into onTimeout quickly.
        ga4OauthWaitMs: terminal === "failed" ? 1000 : 5,
        ga4OauthPollIntervalMs: 1,
        sleep: async () => {},
        ga4OauthInteraction: interaction
      });

      const menuCall = terminal === "failed" ? "onFailed" : "onTimeout";
      // The wait was disarmed, and strictly BEFORE the menu opened.
      expect(interaction.cancelWait).toHaveBeenCalled();
      expect(order.indexOf("cancelWait")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("cancelWait")).toBeLessThan(order.indexOf(menuCall));
      expect(result.paused).toEqual(["ga4"]);
    }
  });

  it("retries the GA4 OAuth bootstrap exactly once when the injected interaction cancels with retry (#7)", async () => {
    const { store } = capturingStore();
    const waitForDecision = vi
      .fn(async (): Promise<"retry" | null> => null)
      // First wait: founder hits a key and chooses retry. Second wait: let the poll finish.
      .mockResolvedValueOnce("retry")
      .mockResolvedValue(null);

    let statusCalls = 0;
    const bootstrap = {
      prepareConfig: vi.fn(async () => ({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      start: vi.fn(async (_input: unknown) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      status: vi.fn(async (_sessionId: string) => {
        statusCalls += 1;
        // Stay pending so the first attempt is interrupted by the retry decision; the second
        // attempt also stays pending and times out into a resumable pause.
        return {
          sessionId: "oauth_session_1",
          provider: "google_analytics_4",
          status: "pending" as const,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
          error: null
        };
      }),
      exchange: vi.fn(async () => {
        throw new Error("exchange must not run");
      })
    };

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: store,
      handoffLauncher: async () => undefined,
      ga4OauthBootstrap: bootstrap,
      ga4OauthWaitMs: 30,
      ga4OauthPollIntervalMs: 1,
      sleep: async () => {},
      ga4OauthInteraction: {
        waitForDecision
      }
    });

    // retry re-starts the bootstrap exactly once more (no orphan-session chain) → 2 starts total.
    expect(bootstrap.start).toHaveBeenCalledTimes(2);
    expect(result.paused).toEqual(["ga4"]);
    expect(statusCalls).toBeGreaterThan(0);
  });

  it("maps an injected quit/byo/manual decision to the resumable pause without exchanging (#7)", async () => {
    for (const decision of ["byo", "manual", "quit"] as const) {
      const { store } = capturingStore();
      const bootstrap = {
        prepareConfig: vi.fn(async () => ({
          clientId: "ga-client-id",
          clientSecret: "ga-client-secret",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
        })),
        start: vi.fn(async (_input: unknown) => ({
          sessionId: "oauth_session_1",
          provider: "google_analytics_4",
          status: "pending" as const,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
        })),
        status: vi.fn(async (_sessionId: string) => ({
          sessionId: "oauth_session_1",
          provider: "google_analytics_4",
          status: "pending" as const,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
          error: null
        })),
        exchange: vi.fn(async () => {
          throw new Error("exchange must not run");
        })
      };
      const result = await runLiveSetupOnboarding({
        db: fakeDb() as never,
        workspaceId: "ws_1",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
            { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
            { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
          ]
        },
        actions: ctx.actions,
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: store,
        handoffLauncher: async () => undefined,
        ga4OauthBootstrap: bootstrap,
        ga4OauthWaitMs: 1000,
        ga4OauthPollIntervalMs: 1,
        sleep: async () => {},
        ga4OauthInteraction: { waitForDecision: vi.fn(async () => decision) }
      });
      // Non-retry decisions never re-start; they fall through to a single resumable pause.
      expect(bootstrap.start).toHaveBeenCalledTimes(1);
      expect(bootstrap.exchange).not.toHaveBeenCalled();
      expect(result.paused).toEqual(["ga4"]);
    }
  });

  it("non-interactive GA4 wait (no interaction) keeps today's timeout→pause and never prompts (#7)", async () => {
    const { store } = capturingStore();
    const bootstrap = {
      prepareConfig: vi.fn(async () => ({
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      start: vi.fn(async (_input: unknown) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
      })),
      status: vi.fn(async (_sessionId: string) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "pending" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        error: null
      })),
      exchange: vi.fn(async () => {
        throw new Error("exchange must not run");
      })
    };

    const result = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: store,
      handoffLauncher: async () => undefined,
      ga4OauthBootstrap: bootstrap,
      ga4OauthWaitMs: 5,
      ga4OauthPollIntervalMs: 1,
      sleep: async () => {}
      // No ga4OauthInteraction injected → non-interactive path.
    });

    // Exactly one start, no exchange, resumable pause with the OAuth session id preserved.
    expect(bootstrap.start).toHaveBeenCalledTimes(1);
    expect(bootstrap.exchange).not.toHaveBeenCalled();
    expect(result.paused).toEqual(["ga4"]);
    expect(result.runs.ga4?.phases.detect).toMatchObject({
      status: "needs_human",
      data: { resume: expect.objectContaining({ oauthSessionId: "oauth_session_1" }) }
    });
  });

  it("opens paused hand-offs strictly sequentially in canonical order, gated between launches (#8)", async () => {
    const launchOrder: string[] = [];
    const gateOrder: string[] = [];
    let gateResolvedFor: string | null = null;
    const handoffLauncher = vi.fn(async (input: { provider: string }) => {
      // When PostHog launches, GA4's gate must already have resolved (one-at-a-time).
      if (input.provider === "posthog") {
        expect(gateResolvedFor).toBe("ga4");
      }
      launchOrder.push(input.provider);
    });
    const awaitProviderHandoff = vi.fn(async (provider: "ga4" | "posthog" | "x") => {
      gateOrder.push(provider);
      gateResolvedFor = provider;
    });

    const ga4Handoff: PhaseResult = {
      status: "needs_human",
      detail: "Finish GA4.",
      handoff: { kind: "open_url", url: "https://analytics.google.com/analytics/web/", instructions: "Finish GA4." }
    };
    const posthogHandoff: PhaseResult = {
      status: "needs_human",
      detail: "Finish PostHog.",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys",
        instructions: "Finish PostHog."
      }
    };

    const result = await runLiveSetupOnboarding({
      // DB returns active runs in PostHog-first (recency) order on purpose — the launcher must
      // re-sort to canonical GA4 → PostHog regardless of DB ordering.
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Finish PostHog.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            browser: { profileRef: "posthog-api-key", resumeNonce: "n2" }
          },
          browserProfile: "posthog-api-key"
        },
        {
          id: "run_ga4",
          provider: "ga4",
          tool: "ga4",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://analytics.google.com/analytics/web/",
            instructions: "Finish GA4.",
            provider: "ga4",
            runId: "run_ga4",
            reason: "google_login",
            browser: { profileRef: "ga4-google", resumeNonce: "n1" }
          },
          browserProfile: "ga4-google"
        }
      ]) as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher,
      awaitProviderHandoff,
      async createProvisioners() {
        return [
          setupProvisioner("ga4", {
            async connect() {
              return { result: ga4Handoff, browser: { profileRef: "ga4-google", resumeNonce: "n1" } };
            }
          }),
          setupProvisioner("posthog", {
            async connect() {
              return { result: posthogHandoff, browser: { profileRef: "posthog-api-key", resumeNonce: "n2" } };
            }
          })
        ];
      }
    });

    expect(result.paused.sort()).toEqual(["ga4", "posthog"]);
    // Canonical launch order, GA4 first, with the gate firing for GA4 before PostHog launches.
    expect(launchOrder).toEqual(["ga4", "posthog"]);
    expect(gateOrder).toEqual(["ga4", "posthog"]);
    expect(handoffLauncher).toHaveBeenCalledTimes(2);
  });

  it("non-interactive paused launch opens every handoff with no gate prompt (#8)", async () => {
    const handoffLauncher = vi.fn(async () => undefined);
    const ga4Handoff: PhaseResult = {
      status: "needs_human",
      detail: "Finish GA4.",
      handoff: { kind: "open_url", url: "https://analytics.google.com/analytics/web/", instructions: "Finish GA4." }
    };
    const posthogHandoff: PhaseResult = {
      status: "needs_human",
      detail: "Finish PostHog.",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys",
        instructions: "Finish PostHog."
      }
    };

    await runLiveSetupOnboarding({
      db: fakeDb([
        {
          id: "run_ga4",
          provider: "ga4",
          tool: "ga4",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://analytics.google.com/analytics/web/",
            instructions: "Finish GA4.",
            provider: "ga4",
            runId: "run_ga4",
            reason: "google_login",
            browser: { profileRef: "ga4-google", resumeNonce: "n1" }
          },
          browserProfile: "ga4-google"
        },
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Finish PostHog.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            browser: { profileRef: "posthog-api-key", resumeNonce: "n2" }
          },
          browserProfile: "posthog-api-key"
        }
      ]) as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher,
      // No awaitProviderHandoff → gate is a no-op; both URLs are still launched.
      async createProvisioners() {
        return [
          setupProvisioner("ga4", {
            async connect() {
              return { result: ga4Handoff, browser: { profileRef: "ga4-google", resumeNonce: "n1" } };
            }
          }),
          setupProvisioner("posthog", {
            async connect() {
              return { result: posthogHandoff, browser: { profileRef: "posthog-api-key", resumeNonce: "n2" } };
            }
          })
        ];
      }
    });

    expect(handoffLauncher).toHaveBeenCalledTimes(2);
  });

  it("launches paused provider handoffs after sequential onboarding completes", async () => {
    const handoffLauncher = vi.fn(async () => undefined);
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: true, installState: "unknown", selected: false, recommended: false },
        { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    };

    const pausedResult: PhaseResult = {
      status: "needs_human",
      detail: "Finish PostHog setup.",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys",
        instructions: "Finish PostHog setup."
      }
    };

    const result = await runLiveSetupOnboarding({
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            ...pausedResult.handoff,
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            resume: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              lastKnownUrl: "https://us.posthog.com/settings/user-api-keys"
            },
            browser: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              handoffUrl: "https://us.posthog.com/settings/user-api-keys",
              lastUrl: "https://us.posthog.com/settings/user-api-keys"
            }
          },
          browserProfile: "posthog-api-key"
        }
      ]) as never,
      workspaceId: "ws_1",
      interview,
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher,
      async createProvisioners() {
        return [
          setupProvisioner("posthog", {
            async connect() {
              return {
                result: pausedResult,
                browser: {
                  profileRef: "posthog-api-key",
                  resumeNonce: "nonce-123"
                }
              };
            }
          })
        ];
      }
    });

    expect(result.paused).toEqual(["posthog"]);
    expect(result.activeRuns).toEqual([
      {
        id: "run_posthog",
        provider: "posthog",
        tool: "posthog",
        status: "paused_handoff",
        pendingHandoff: {
          ...pausedResult.handoff,
          provider: "posthog",
          runId: "run_posthog",
          reason: "posthog_manual_key",
          resume: {
            profileRef: "posthog-api-key",
            resumeNonce: "nonce-123",
            lastKnownUrl: "https://us.posthog.com/settings/user-api-keys"
          },
          browser: {
            profileRef: "posthog-api-key",
            resumeNonce: "nonce-123",
            handoffUrl: "https://us.posthog.com/settings/user-api-keys",
            lastUrl: "https://us.posthog.com/settings/user-api-keys"
          }
        },
        browserProfile: "posthog-api-key"
      }
    ]);
    expect(handoffLauncher).toHaveBeenCalledWith({
      provider: "posthog",
      url: "https://us.posthog.com/settings/user-api-keys",
      contextRef: "posthog-api-key",
      sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key"
    });
  });

  it("exports a stable start alias for live onboarding callers", async () => {
    expect(startLiveSetupOnboarding).toBe(runLiveSetupOnboarding);
  });

  it("reconstructs interview state from the persisted run before resuming onboarding", async () => {
    const createProvisioners = vi.fn(async ({ interview }: { interview: SetupInterview }) => [
      setupProvisioner("posthog")
    ]);

    await resumeLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher: async () => undefined,
      createProvisioners
    });

    expect(createProvisioners).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        interview: expect.objectContaining({
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            expect.objectContaining({
              provider: "posthog",
              selected: true
            })
          ]
        })
      })
    );
  });

  it("rejects direct resume for a running setup run that is not paused for handoff", async () => {
    const createProvisioners = vi.fn(async () => [setupProvisioner("posthog")]);

    await expect(resumeLiveSetupOnboarding({
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "running",
          pendingHandoff: null
        }
      ]) as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher: async () => undefined,
      createProvisioners
    })).rejects.toThrow("setup run run_posthog is not resumable");

    expect(createProvisioners).not.toHaveBeenCalled();
  });

  it("advances a resumed PostHog signup handoff to the API-key step instead of reopening signup", async () => {
    const handoffLauncher = vi.fn(async () => undefined);
    const sessionStore = memoryBrowserSessionStore();
    const { store, updates } = capturingStore();
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    };

    const initial = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview,
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore: sessionStore,
      runStore: store,
      handoffLauncher
    });

    expect(initial.runs.posthog?.phases.detect.handoff?.url).toBe("https://us.posthog.com/signup");
    const initialSessionKey = initial.runs.posthog?.providerState?.browser?.sessionKey;
    expect(initialSessionKey).toBe("scope=workspace%3Aws_1|provider=posthog|context=posthog-signup");

    const persisted = [...updates].reverse().find((entry) => entry.runId === "run_posthog")?.update;
    expect(persisted).toBeDefined();
    const phaseState = {
      interview,
      providers: {
        posthog: persisted?.providerState
      }
    };
    const resumeDb = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        if (sql.includes("select phase_state") && sql.includes("from setup_runs")) {
          return [{ phase_state: phaseState }] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("where workspace_id = $1 and id = $2")) {
          return {
            id: "run_posthog",
            provider: "posthog",
            status: "paused_handoff",
            pending_handoff: persisted?.pendingHandoff,
            browser_profile: persisted?.browserProfile ?? null,
            phase_state: phaseState
          } as unknown as T;
        }
        return null;
      }
    };

    const resumed = await resumeLiveSetupOnboarding({
      db: resumeDb as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore: sessionStore,
      runStore: fakeStore(),
      handoffLauncher
    });

    expect(resumed.paused).toEqual(["posthog"]);
    expect(resumed.runs.posthog?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys"
      },
      data: {
        reason: "posthog_manual_key",
        resume: expect.objectContaining({
          step: "posthog_manual_key",
          phase: "credential_setup",
          status: "pending_auth"
        })
      }
    });
    expect(resumed.runs.posthog?.phases.detect.handoff?.url).not.toBe("https://us.posthog.com/signup");
    expect(resumed.runs.posthog?.providerState?.browser).toMatchObject({
      profileRef: "posthog-signup",
      sessionKey: initialSessionKey
    });
    expect(handoffLauncher).toHaveBeenLastCalledWith({
      provider: "posthog",
      url: "https://us.posthog.com/settings/user-api-keys",
      contextRef: "posthog-signup",
      sessionKey: initialSessionKey
    });
  });

  it("uses the resumed PostHog browser session to discover org/project state before pausing for manual key import", async () => {
    process.env.INFINITE_SETUP_HANDOFF_BROWSER = "playwright";
    const handoffLauncher = vi.fn(async () => undefined);
    const sessionStore = memoryBrowserSessionStore();
    const { store, updates } = capturingStore();
    const browserVisits: string[] = [];
    const browserRequests: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    const browserFactory = {
      async create() {
        return {
          async goto(url: string) {
            browserVisits.push(url);
          },
          async waitForSignal() {
            return null;
          },
          async readNetwork() {
            return [];
          },
          async request(url: string, init?: { method?: string; headers?: Record<string, string> }) {
            browserRequests.push({ url, method: init?.method, headers: init?.headers });
            if (url.endsWith("/api/organizations/")) {
              return {
                ok: true,
                status: 200,
                async json() {
                  return { results: [{ id: "org_1", name: "Acme Org" }] };
                },
                async text() {
                  return JSON.stringify({ results: [{ id: "org_1", name: "Acme Org" }] });
                }
              };
            }
            if (url.endsWith("/api/organizations/org_1/projects/")) {
              return {
                ok: true,
                status: 200,
                async json() {
                  return {
                    results: [
                      {
                        id: "project_1",
                        name: "Acme",
                        api_token: "phc_project_1",
                        completed_snippet_onboarding: false,
                        ingested_event: false
                      }
                    ]
                  };
                },
                async text() {
                  return JSON.stringify({
                    results: [
                      {
                        id: "project_1",
                        name: "Acme",
                        api_token: "phc_project_1",
                        completed_snippet_onboarding: false,
                        ingested_event: false
                      }
                    ]
                  });
                }
              };
            }
            throw new Error(`Unexpected browser-authenticated request: ${init?.method ?? "GET"} ${url}`);
          },
          async destroy() {}
        };
      }
    };
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    };

    const initial = await runLiveSetupOnboarding({
      db: fakeDb() as never,
      workspaceId: "ws_1",
      interview,
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore: sessionStore,
      runStore: store,
      handoffLauncher
    });

    const persisted = [...updates].reverse().find((entry) => entry.runId === "run_posthog")?.update;
    const phaseState = {
      interview,
      providers: {
        posthog: persisted?.providerState
      }
    };
    const resumeDb = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        if (sql.includes("select phase_state") && sql.includes("from setup_runs")) {
          return [{ phase_state: phaseState }] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("where workspace_id = $1 and id = $2")) {
          return {
            id: "run_posthog",
            provider: "posthog",
            status: "paused_handoff",
            pending_handoff: persisted?.pendingHandoff,
            browser_profile: persisted?.browserProfile ?? null,
            phase_state: phaseState
          } as unknown as T;
        }
        return null;
      }
    };

    const resumed = await resumeLiveSetupOnboarding({
      db: resumeDb as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: browserFactory as never,
      browserSessionStore: sessionStore,
      runStore: fakeStore(),
      handoffLauncher
    });

    expect(resumed.paused).toEqual(["posthog"]);
    expect(resumed.runs.posthog?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys"
      }
    });
    expect(resumed.runs.posthog?.providerState?.publicArtifacts).toEqual({
      projectId: "project_1",
      projectKey: "phc_project_1",
      apiHost: "https://us.i.posthog.com"
    });
    expect(browserRequests).toEqual([
      {
        url: "https://us.posthog.com/api/personal_api_keys/",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      {
        url: "https://us.posthog.com/api/organizations/",
        method: "GET",
        headers: {}
      },
      {
        url: "https://us.posthog.com/api/organizations/org_1/projects/",
        method: "GET",
        headers: {}
      },
    ]);
    expect(browserVisits).toContain("https://us.posthog.com/signup");
    expect(handoffLauncher).toHaveBeenLastCalledWith({
      provider: "posthog",
      url: "https://us.posthog.com/settings/user-api-keys",
      contextRef: "posthog-signup",
      sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup"
    });
  });

  it.each([
    "http://us.posthog.com/project/project_1",
    "https://evilposthog.com/project/project_1",
    "https://notposthog.com/project/project_1"
  ])("rejects hostile or non-https PostHog browser origins during resume: %s", async (lastUrl) => {
    process.env.INFINITE_SETUP_HANDOFF_BROWSER = "playwright";
    const handoffLauncher = vi.fn(async () => undefined);
    const sessionStore = memoryBrowserSessionStore();
    const sessionKey = "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup";
    await sessionStore.save(sessionKey, {
      profileRef: "posthog-signup",
      resumeNonce: "nonce-posthog",
      lastUrl
    });
    const browserVisits: string[] = [];
    const browserRequests: Array<{ url: string; method: string; headers: Record<string, string> | undefined }> = [];
    const browserFactory = {
      async create() {
        return {
          async goto(url: string) {
            browserVisits.push(url);
          },
          async waitForSignal() {
            return null;
          },
          async readNetwork() {
            return [];
          },
          async request(url: string, init?: { method?: "GET" | "POST"; headers?: Record<string, string> }) {
            browserRequests.push({
              url,
              method: init?.method ?? "GET",
              headers: init?.headers
            });
            if (url.endsWith("/api/organizations/")) {
              return {
                ok: true,
                status: 200,
                async json() {
                  return { results: [{ id: "org_1", name: "Acme Org" }] };
                },
                async text() {
                  return JSON.stringify({ results: [{ id: "org_1", name: "Acme Org" }] });
                }
              };
            }
            if (url.endsWith("/api/organizations/org_1/projects/")) {
              return {
                ok: true,
                status: 200,
                async json() {
                  return {
                    results: [
                      {
                        id: "project_1",
                        name: "Acme",
                        api_token: "phc_project_1",
                        completed_snippet_onboarding: false,
                        ingested_event: false
                      }
                    ]
                  };
                },
                async text() {
                  return JSON.stringify({
                    results: [
                      {
                        id: "project_1",
                        name: "Acme",
                        api_token: "phc_project_1",
                        completed_snippet_onboarding: false,
                        ingested_event: false
                      }
                    ]
                  });
                }
              };
            }
            throw new Error(`Unexpected browser-authenticated request: ${init?.method ?? "GET"} ${url}`);
          },
          async destroy() {}
        };
      }
    };

    const resumed = await resumeLiveSetupOnboarding({
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: lastUrl,
            instructions: "Resume PostHog setup.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_signup",
            resume: {
              profileRef: "posthog-signup",
              resumeNonce: "nonce-posthog",
              lastKnownUrl: lastUrl
            },
            browser: {
              profileRef: "posthog-signup",
              resumeNonce: "nonce-posthog",
              sessionKey,
              handoffUrl: lastUrl,
              lastUrl
            }
          },
          browserProfile: "posthog-signup"
        }
      ]) as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: browserFactory as never,
      browserSessionStore: sessionStore,
      runStore: fakeStore(),
      handoffLauncher
    });

    expect(resumed.paused).toEqual(["posthog"]);
    expect(resumed.runs.posthog?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys"
      }
    });
    expect(browserVisits.length).toBeGreaterThan(0);
    expect(browserVisits).not.toContain(lastUrl);
    expect(browserVisits.every((value) => value === "https://us.posthog.com/settings/user-api-keys")).toBe(true);
    expect(browserRequests).toEqual([
      {
        url: "https://us.posthog.com/api/personal_api_keys/",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      {
        url: "https://us.posthog.com/api/organizations/",
        method: "GET",
        headers: {}
      },
      {
        url: "https://us.posthog.com/api/organizations/org_1/projects/",
        method: "GET",
        headers: {}
      }
    ]);
  });

  it("resumes a PostHog manual-key handoff with a supplied key and keeps the secret out of persisted state", async () => {
    const secret = "phx_resume_secret";
    const executed: Array<{ id: string; input: unknown }> = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { store, updates } = capturingStore();
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
        { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    };
    const phaseState = {
      interview,
      providers: {
        posthog: {
          browser: {
            profileRef: "posthog-api-key",
            resumeNonce: "nonce-posthog",
            sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key",
            handoffUrl: "https://us.posthog.com/settings/user-api-keys",
            lastUrl: "https://us.posthog.com/settings/user-api-keys"
          },
          publicArtifacts: {
            projectId: "project_1",
            projectKey: "phc_project_1",
            apiHost: "https://us.i.posthog.com"
          }
        }
      }
    };
    const resumeDb = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        if (sql.includes("select phase_state") && sql.includes("from setup_runs")) {
          return [{ phase_state: phaseState }] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("where workspace_id = $1 and id = $2")) {
          return {
            id: "run_posthog",
            provider: "posthog",
            status: "paused_handoff",
            pending_handoff: {
              kind: "open_url",
              url: "https://us.posthog.com/settings/user-api-keys",
              instructions: "Create a PostHog personal API key.",
              provider: "posthog",
              runId: "run_posthog",
              reason: "posthog_manual_key",
              browser: phaseState.providers.posthog.browser
            },
            browser_profile: "posthog-api-key",
            phase_state: phaseState
          } as unknown as T;
        }
        return null;
      }
    };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const normalized = String(url);
      fetchCalls.push({ url: normalized, init });
      if (normalized.endsWith("/api/organizations/")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { results: [{ id: "org_1", name: "Acme Org" }] };
          },
          async text() {
            return JSON.stringify({ results: [{ id: "org_1", name: "Acme Org" }] });
          }
        };
      }
      if (normalized.endsWith("/api/organizations/org_1/projects/")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: [
                {
                  id: "project_1",
                  name: "Acme",
                  api_token: "phc_project_1",
                  completed_snippet_onboarding: false,
                  ingested_event: false
                }
              ]
            };
          },
          async text() {
            return JSON.stringify({
              results: [
                {
                  id: "project_1",
                  name: "Acme",
                  api_token: "phc_project_1",
                  completed_snippet_onboarding: false,
                  ingested_event: false
                }
              ]
            });
          }
        };
      }
      throw new Error(`Unexpected PostHog fetch: ${normalized}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await resumeLiveSetupOnboarding({
        db: resumeDb as never,
        workspaceId: "ws_1",
        runId: "run_posthog",
        actions: {
          async execute(id, input) {
            executed.push({ id, input });
            return {
              ok: true,
              actionId: id as "connect_source" | "start_source_sync",
              authority: "operator",
              status: "queued",
              data: id === "connect_source"
                ? {
                    source: { id: "src_posthog", provider: "posthog" },
                    connectionTest: {
                      ok: true,
                      mode: "live",
                      provider: "posthog",
                      accountExternalId: "project_1"
                    }
                  }
                : { job: { id: "job_posthog_sync" } },
              provenance: [id === "connect_source" ? "sources" : "job_runs"],
              caveats: [],
              truncated: false,
              nextActions: []
            };
          }
        },
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore: browserSessionStore,
        runStore: store,
        handoffLauncher: async () => undefined,
        resumeSecrets: {
          posthog: {
            personalApiKey: secret,
            apiHost: "https://eu.posthog.com"
          }
        }
      });

      expect(result.completed).toEqual(["posthog"]);
      expect(result.paused).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.runs.posthog?.providerState?.publicArtifacts).toEqual({
        projectId: "project_1",
        projectKey: "phc_project_1",
        apiHost: "https://eu.i.posthog.com"
      });
      expect(fetchCalls).toEqual([
        expect.objectContaining({
          url: "https://eu.posthog.com/api/organizations/",
          init: expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({
              Authorization: `Bearer ${secret}`
            })
          })
        }),
        expect.objectContaining({
          url: "https://eu.posthog.com/api/organizations/org_1/projects/",
          init: expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({
              Authorization: `Bearer ${secret}`
            })
          })
        })
      ]);
      expect(executed).toEqual([
        {
          id: "connect_source",
          input: {
            provider: "posthog",
            connectionName: "PostHog",
            credentialKind: "personal_api_key",
            accountExternalId: "project_1",
            credentialPayload: {
              mode: "live",
              projectId: "project_1",
              personalApiKey: secret,
              apiHost: "https://eu.posthog.com"
            }
          }
        },
        {
          id: "start_source_sync",
          input: {
            sourceId: "src_posthog",
            mode: "incremental",
            refreshWindowDays: 7
          }
        }
      ]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(updates)).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("auto-creates a PostHog personal API key from the authenticated browser session and stores it through connect_source", async () => {
    process.env.INFINITE_SETUP_HANDOFF_BROWSER = "playwright";
    const secret = "phx_auto_created_secret";
    const executed: Array<{ id: string; input: unknown }> = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const notes: string[] = [];
    const ask = vi.fn(async (_question: string) => "");
    const { store, updates } = capturingStore();
    const { resumeDb } = posthogBrowserResumeFixture();
    const browserRequests: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    const browserFactory = posthogBrowserFactory(browserRequests, async (url, init) => {
      if (url.endsWith("/api/personal_api_keys/") && init?.method === "POST") {
        return jsonBrowserResponse(201, { id: "key_1", label: "Infinite", value: secret });
      }
      throw new Error(`Unexpected browser-authenticated request: ${init?.method ?? "GET"} ${url}`);
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const normalized = String(url);
      fetchCalls.push({ url: normalized, init });
      if (normalized.endsWith("/api/organizations/")) {
        return jsonBrowserResponse(200, { results: [{ id: "org_1", name: "Acme Org" }] });
      }
      if (normalized.endsWith("/api/organizations/org_1/projects/")) {
        return jsonBrowserResponse(200, {
          results: [
            {
              id: "project_1",
              name: "Acme",
              api_token: "phc_project_1",
              completed_snippet_onboarding: false,
              ingested_event: false
            }
          ]
        });
      }
      throw new Error(`Unexpected PostHog fetch: ${normalized}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await resumeLiveSetupOnboarding({
        db: resumeDb as never,
        workspaceId: "ws_1",
        runId: "run_posthog",
        actions: capturingActions(executed),
        prompt: { ask, note: (message: string) => notes.push(message) },
        browserFactory: browserFactory as never,
        browserSessionStore: browserSessionStore,
        runStore: store,
        handoffLauncher: async () => undefined
      });

      expect(result.completed).toEqual(["posthog"]);
      expect(result.paused).toEqual([]);
      expect(result.failed).toEqual([]);
      // Exactly one creation POST even though discoverAccess runs once per phase.
      expect(browserRequests).toEqual([
        {
          url: "https://us.posthog.com/api/personal_api_keys/",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "Infinite", scopes: ["*"] })
        }
      ]);
      expect(ask).not.toHaveBeenCalled();
      expect(notes.some((note) => note.includes("created an \"Infinite\" personal API key"))).toBe(true);
      expect(fetchCalls[0]).toEqual(
        expect.objectContaining({
          url: "https://us.posthog.com/api/organizations/",
          init: expect.objectContaining({
            headers: expect.objectContaining({ Authorization: `Bearer ${secret}` })
          })
        })
      );
      expect(executed).toEqual([
        {
          id: "connect_source",
          input: expect.objectContaining({
            provider: "posthog",
            credentialKind: "personal_api_key",
            credentialPayload: {
              mode: "live",
              projectId: "project_1",
              personalApiKey: secret,
              apiHost: "https://us.posthog.com"
            }
          })
        },
        {
          id: "start_source_sync",
          input: {
            sourceId: "src_posthog",
            mode: "incremental",
            refreshWindowDays: 7
          }
        }
      ]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(updates)).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to pasting a personal API key when PostHog rejects the automatic key creation", async () => {
    process.env.INFINITE_SETUP_HANDOFF_BROWSER = "playwright";
    const secret = "phx_pasted_secret";
    const executed: Array<{ id: string; input: unknown }> = [];
    const notes: string[] = [];
    const ask = vi.fn(async (_question: string) => secret);
    const { store, updates } = capturingStore();
    const { resumeDb } = posthogBrowserResumeFixture();
    const browserRequests: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    const browserFactory = posthogBrowserFactory(browserRequests, async (url, init) => {
      if (url.endsWith("/api/personal_api_keys/") && init?.method === "POST") {
        return jsonBrowserResponse(403, { detail: "You do not have permission to perform this action." });
      }
      throw new Error(`Unexpected browser-authenticated request: ${init?.method ?? "GET"} ${url}`);
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const normalized = String(url);
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(authorization).toBe(`Bearer ${secret}`);
      if (normalized.endsWith("/api/organizations/")) {
        return jsonBrowserResponse(200, { results: [{ id: "org_1", name: "Acme Org" }] });
      }
      if (normalized.endsWith("/api/organizations/org_1/projects/")) {
        return jsonBrowserResponse(200, {
          results: [
            {
              id: "project_1",
              name: "Acme",
              api_token: "phc_project_1",
              completed_snippet_onboarding: false,
              ingested_event: false
            }
          ]
        });
      }
      throw new Error(`Unexpected PostHog fetch: ${normalized}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await resumeLiveSetupOnboarding({
        db: resumeDb as never,
        workspaceId: "ws_1",
        runId: "run_posthog",
        actions: capturingActions(executed),
        prompt: { ask, note: (message: string) => notes.push(message) },
        browserFactory: browserFactory as never,
        browserSessionStore: browserSessionStore,
        runStore: store,
        handoffLauncher: async () => undefined
      });

      expect(result.completed).toEqual(["posthog"]);
      expect(result.paused).toEqual([]);
      // The paste prompt runs once; later phases reuse the memoized key.
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0]?.[0]).toContain("Paste a PostHog personal API key (phx_...)");
      expect(ask.mock.calls[0]?.[0]).toContain("https://us.posthog.com/settings/user-api-keys");
      expect(notes.some((note) => note.includes("could not create a personal API key automatically"))).toBe(true);
      expect(executed[0]).toEqual({
        id: "connect_source",
        input: expect.objectContaining({
          credentialKind: "personal_api_key",
          credentialPayload: expect.objectContaining({ personalApiKey: secret })
        })
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(updates)).not.toContain(secret);
      expect(JSON.stringify(notes)).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an invalid pasted personal API key and pauses for the manual key handoff instead", async () => {
    process.env.INFINITE_SETUP_HANDOFF_BROWSER = "playwright";
    const executed: Array<{ id: string; input: unknown }> = [];
    const notes: string[] = [];
    const ask = vi.fn(async (_question: string) => "phc_this_is_the_public_project_key");
    const { resumeDb } = posthogBrowserResumeFixture();
    const browserRequests: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    const browserFactory = posthogBrowserFactory(browserRequests, async (url, init) => {
      if (url.endsWith("/api/personal_api_keys/") && init?.method === "POST") {
        return jsonBrowserResponse(403, { detail: "You do not have permission to perform this action." });
      }
      if (url.endsWith("/api/organizations/")) {
        return jsonBrowserResponse(200, { results: [{ id: "org_1", name: "Acme Org" }] });
      }
      if (url.endsWith("/api/organizations/org_1/projects/")) {
        return jsonBrowserResponse(200, {
          results: [
            {
              id: "project_1",
              name: "Acme",
              api_token: "phc_project_1",
              completed_snippet_onboarding: false,
              ingested_event: false
            }
          ]
        });
      }
      throw new Error(`Unexpected browser-authenticated request: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await resumeLiveSetupOnboarding({
      db: resumeDb as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: capturingActions(executed),
      prompt: { ask, note: (message: string) => notes.push(message) },
      browserFactory: browserFactory as never,
      browserSessionStore: browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher: async () => undefined
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(notes.some((note) => note.includes("not a personal API key"))).toBe(true);
    expect(result.paused).toEqual(["posthog"]);
    expect(result.runs.posthog?.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://us.posthog.com/settings/user-api-keys"
      }
    });
    // The rejected paste never reaches connect_source.
    expect(executed).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("phc_this_is_the_public_project_key");
  });

  it("scopes resume to the requested provider run instead of replaying every originally selected provider", async () => {
    const posthogDetect = vi.fn(async () => blank);
    const ga4Detect = vi.fn(async () => blank);
    const createProvisioners = vi.fn(async () => [
      setupProvisioner("posthog", { detect: posthogDetect }),
      setupProvisioner("ga4", { detect: ga4Detect })
    ]);

    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and id = $2")) {
          return {
            id: "run_posthog",
            provider: "posthog",
            status: "paused_handoff",
            phase_state: {
              interview: {
                projectName: "Acme",
                websiteUrl: "https://acme.test",
                productSurface: "web",
                providerInventory: [
                  {
                    provider: "posthog",
                    hasAccount: true,
                    installState: "unknown",
                    selected: true,
                    recommended: true
                  },
                  {
                    provider: "ga4",
                    hasAccount: true,
                    installState: "unknown",
                    selected: true,
                    recommended: true
                  }
                ]
              }
            }
          } as unknown as T;
        }
        return null;
      }
    };

    const result = await resumeLiveSetupOnboarding({
      db: db as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher: async () => undefined,
      createProvisioners
    });

    expect(result.selectedProviders).toEqual(["posthog"]);
    expect(result.interview.providerInventory.filter((row) => row.selected).map((row) => row.provider)).toEqual(["posthog"]);
    expect(result.completed).toEqual(["posthog"]);
    expect(posthogDetect).toHaveBeenCalledTimes(1);
    expect(ga4Detect).not.toHaveBeenCalled();
  });

  it("resumes GA4 onboarding by polling the stored OAuth session and exchanging it without a property id", async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    const encryptedAppPayload = encryptCredentialPayload(
      {
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: [
          "https://www.googleapis.com/auth/analytics.edit",
          "https://www.googleapis.com/auth/analytics.readonly"
        ]
      },
      "test-encryption-key"
    );
    const encryptedTokenPayload = encryptCredentialPayload(
      {
        accessToken: "stored-ga4-access-token",
        refreshToken: "stored-ga4-refresh-token",
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      "test-encryption-key"
    );
    const bootstrap = {
      prepareConfig: vi.fn(async () => null),
      start: vi.fn(async (_input: unknown) => {
        throw new Error("unexpected start");
      }),
      status: vi.fn(async (_sessionId: string) => ({
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "completed" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        expiresAt: "2099-01-01T00:00:00.000Z",
        hasAuthorizationCode: true,
        error: null
      })),
      exchange: vi.fn(async (_sessionId: string) => ({
        ok: true,
        sessionId: "oauth_session_1",
        provider: "google_analytics_4",
        status: "authorized",
        oauthAppId: "oauth_app_1",
        oauthTokenId: "oauth_token_1"
      }))
    };
    let exchanged = false;
    const executed: Array<{ id: string; input: unknown }> = [];
    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and id = $2")) {
          return {
            id: "run_ga4",
            provider: "ga4",
            status: "paused_handoff",
            pending_handoff: {
              provider: "ga4",
              runId: "run_ga4",
              kind: "open_url",
              url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id",
              instructions: "Authorize Google Analytics for this workspace.",
              reason: "google_login",
              resume: {
                status: "pending_auth",
                phase: "credential_setup",
                step: "ga4_oauth_consent",
                oauthSessionId: "oauth_session_1",
                nextAction: "resume_for_ga4_oauth_exchange"
              },
              browser: {
                profileRef: "ga4-google",
                resumeNonce: "resume-123",
                sessionKey: "scope=workspace%3Aws_1|provider=ga4|context=ga4-google",
                handoffUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id",
                lastUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id"
              }
            },
            browser_profile: "ga4-google",
            phase_state: {
              interview: {
                projectName: "Acme",
                websiteUrl: "https://acme.test",
                productSurface: "web",
                providerInventory: [
                  {
                    provider: "ga4",
                    hasAccount: true,
                    installState: "unknown",
                    selected: true,
                    recommended: true
                  }
                ]
              }
            }
          } as unknown as T;
        }
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("from oauth_tokens")) {
          return exchanged
            ? ({
                oauth_app_id: "oauth_app_1",
                oauth_token_id: "oauth_token_1",
                encrypted_app_payload: encryptedAppPayload,
                encrypted_token_payload: encryptedTokenPayload
              } as unknown as T)
            : null;
        }
        return null;
      }
    };
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
        return new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/1",
                propertySummaries: [{ property: "properties/123", displayName: "Acme" }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams") {
        return new Response(
          JSON.stringify({
            dataStreams: [
              {
                type: "WEB_DATA_STREAM",
                webStreamData: {
                  measurementId: "G-ACME123",
                  defaultUri: "https://acme.test"
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const result = await resumeLiveSetupOnboarding({
        db: db as never,
        workspaceId: "ws_1",
        runId: "run_ga4",
        actions: {
          async execute(id, input, _session) {
            executed.push({ id, input });
            if (id === "connect_source") {
              return {
                ok: true,
                actionId: "connect_source",
                authority: "operator",
                status: "queued",
                provenance: ["sources"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: {
                  source: { id: "src_ga4", provider: "google_analytics_4" },
                  connectionTest: { ok: true, mode: "live", accountExternalId: "properties/123" }
                }
              };
            }
            if (id === "start_source_sync") {
              return {
                ok: true,
                actionId: "start_source_sync",
                authority: "operator",
                status: "queued",
                provenance: ["job_runs"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: { job: { id: "job_ga4_1" } }
              };
            }
            throw new Error(`unexpected action: ${id}`);
          }
        },
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: fakeStore(),
        handoffLauncher: async () => undefined,
        ga4OauthBootstrap: {
          ...bootstrap,
          async exchange(sessionId: string) {
            exchanged = true;
            return bootstrap.exchange(sessionId);
          }
        }
      });

      expect(bootstrap.status).toHaveBeenCalledWith("oauth_session_1");
      expect(bootstrap.exchange).toHaveBeenCalledWith("oauth_session_1");
      expect(result.completed).toEqual(["ga4"]);
      expect(result.paused).toEqual([]);
      expect(executed).toEqual([
        {
          id: "connect_source",
          input: expect.objectContaining({
            provider: "google_analytics_4",
            credentialKind: "oauth_access_token",
            credentialPayload: expect.objectContaining({
              propertyId: "properties/123",
              accessToken: "stored-ga4-access-token",
              refreshToken: "stored-ga4-refresh-token"
            })
          })
        },
        {
          id: "start_source_sync",
          input: {
            sourceId: "src_ga4",
            mode: "incremental",
            refreshWindowDays: 7
          }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  });

  it("refreshes an expired stored GA4 OAuth token before calling the Admin API", async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    const encryptedAppPayload = encryptCredentialPayload(
      {
        clientId: "ga-client-id",
        clientSecret: "ga-client-secret",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.test/token",
        scope: [
          "https://www.googleapis.com/auth/analytics.edit",
          "https://www.googleapis.com/auth/analytics.readonly"
        ]
      },
      "test-encryption-key"
    );
    let tokenPayload = {
      accessToken: "expired-ga4-access-token",
      refreshToken: "stored-ga4-refresh-token",
      expiresAt: "2000-01-01T00:00:00.000Z"
    };
    const refreshUpdates: Array<{ sql: string; params: unknown[] }> = [];
    const executed: Array<{ id: string; input: unknown }> = [];
    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        refreshUpdates.push({ sql, params });
        if (sql.includes("update oauth_tokens")) {
          tokenPayload = decryptCredentialPayload<Record<string, unknown>>(
            String(params[1]),
            "test-encryption-key"
          ) as typeof tokenPayload;
        }
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("from oauth_tokens")) {
          return {
            oauth_app_id: "oauth_app_1",
            oauth_token_id: "oauth_token_1",
            encrypted_app_payload: encryptedAppPayload,
            encrypted_token_payload: encryptCredentialPayload(tokenPayload, "test-encryption-key")
          } as unknown as T;
        }
        return null;
      }
    };
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.test/token") {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-ga4-access-token",
            refresh_token: "rotated-ga4-refresh-token",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
        expect(init?.headers).toMatchObject({
          authorization: "Bearer refreshed-ga4-access-token"
        });
        return new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/1",
                propertySummaries: [{ property: "properties/123", displayName: "Acme" }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams") {
        return new Response(
          JSON.stringify({
            dataStreams: [
              {
                type: "WEB_DATA_STREAM",
                webStreamData: {
                  measurementId: "G-ACME123",
                  defaultUri: "https://acme.test"
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runLiveSetupOnboarding({
        db: db as never,
        workspaceId: "ws_1",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
            { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
            { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
          ]
        },
        actions: {
          async execute(id, input, _session) {
            executed.push({ id, input });
            if (id === "connect_source") {
              return {
                ok: true,
                actionId: "connect_source",
                authority: "operator",
                status: "queued",
                provenance: ["sources"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: {
                  source: { id: "src_ga4", provider: "google_analytics_4" },
                  connectionTest: { ok: true, mode: "live", accountExternalId: "properties/123" }
                }
              };
            }
            if (id === "start_source_sync") {
              return {
                ok: true,
                actionId: "start_source_sync",
                authority: "operator",
                status: "queued",
                provenance: ["job_runs"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: { job: { id: "job_ga4_1" } }
              };
            }
            throw new Error(`unexpected action: ${id}`);
          }
        },
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: fakeStore()
      });

      expect(result.completed).toEqual(["ga4"]);
      expect(result.paused).toEqual([]);
      expect(refreshUpdates.some((entry) => entry.sql.includes("update oauth_tokens"))).toBe(true);
      expect(executed[0]).toMatchObject({
        id: "connect_source",
        input: expect.objectContaining({
          credentialPayload: expect.objectContaining({
            accessToken: "refreshed-ga4-access-token",
            refreshToken: "rotated-ga4-refresh-token"
          })
        })
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  });

  it("refreshes a stored GA4 OAuth token with the app snapshot captured on that token, not the current workspace app row", async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.GROWTH_OS_ENCRYPTION_KEY = "test-encryption-key";
    const currentWorkspaceAppPayload = encryptCredentialPayload(
      {
        clientId: "ga-client-id",
        clientSecret: "secret-b",
        redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
        authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.test/token-b",
        scope: [
          "https://www.googleapis.com/auth/analytics.edit",
          "https://www.googleapis.com/auth/analytics.readonly"
        ]
      },
      "test-encryption-key"
    );
    const tokenPayload = encryptCredentialPayload(
      {
        accessToken: "expired-ga4-access-token",
        refreshToken: "stored-ga4-refresh-token",
        expiresAt: "2000-01-01T00:00:00.000Z",
        oauthApp: {
          clientId: "ga-client-id",
          clientSecret: "secret-a",
          redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
          authorizationBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.test/token-a",
          scope: [
            "https://www.googleapis.com/auth/analytics.edit",
            "https://www.googleapis.com/auth/analytics.readonly"
          ]
        }
      },
      "test-encryption-key"
    );
    const tokenRequests: Array<{ url: string; params: Record<string, string> }> = [];
    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("where workspace_id = $1 and status in ('running', 'paused_handoff')")) {
          return [] as unknown as T[];
        }
        return [] as unknown as T[];
      },
      async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
        if (sql.includes("from sources s")) {
          return null;
        }
        if (sql.includes("from oauth_tokens")) {
          return {
            oauth_app_id: "oauth_app_current",
            oauth_token_id: "oauth_token_1",
            encrypted_app_payload: currentWorkspaceAppPayload,
            encrypted_token_payload: tokenPayload
          } as unknown as T;
        }
        return null;
      }
    };
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      tokenRequests.push({
        url,
        params: Object.fromEntries(new URLSearchParams(String(init?.body ?? "")).entries())
      });
      if (url === "https://oauth2.test/token-a") {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-ga4-access-token",
            refresh_token: "rotated-ga4-refresh-token",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
        return new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/1",
                propertySummaries: [{ property: "properties/123", displayName: "Acme" }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams") {
        return new Response(
          JSON.stringify({
            dataStreams: [
              {
                type: "WEB_DATA_STREAM",
                webStreamData: {
                  measurementId: "G-ACME123",
                  defaultUri: "https://acme.test"
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runLiveSetupOnboarding({
        db: db as never,
        workspaceId: "ws_1",
        interview: {
          projectName: "Acme",
          websiteUrl: "https://acme.test",
          productSurface: "web",
          providerInventory: [
            { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
            { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
            { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
          ]
        },
        actions: {
          async execute(id, _input, _session) {
            if (id === "connect_source") {
              return {
                ok: true,
                actionId: "connect_source",
                authority: "operator",
                status: "queued",
                provenance: ["sources"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: {
                  source: { id: "src_ga4", provider: "google_analytics_4" },
                  connectionTest: { ok: true, mode: "live", accountExternalId: "properties/123" }
                }
              };
            }
            if (id === "start_source_sync") {
              return {
                ok: true,
                actionId: "start_source_sync",
                authority: "operator",
                status: "queued",
                provenance: ["job_runs"],
                caveats: [],
                nextActions: [],
                truncated: false,
                data: { job: { id: "job_ga4_1" } }
              };
            }
            throw new Error(`unexpected action: ${id}`);
          }
        },
        prompt: ctx.prompt,
        browserFactory: ctx.browser,
        browserSessionStore,
        runStore: fakeStore()
      });

      expect(result.completed).toEqual(["ga4"]);
      expect(tokenRequests[0]).toEqual({
        url: "https://oauth2.test/token-a",
        params: expect.objectContaining({
          grant_type: "refresh_token",
          refresh_token: "stored-ga4-refresh-token",
          client_id: "ga-client-id",
          client_secret: "secret-a"
        })
      });
      expect(tokenRequests.some((request) => request.url === "https://oauth2.test/token-b")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  });

  it("reads public artifacts for live callers without exposing provider secrets", async () => {
    await expect(readLiveSetupPublicArtifacts(fakeDb([
      {
        id: "run_posthog",
        provider: "posthog",
        tool: "posthog",
        status: "paused_handoff",
        pendingHandoff: {
          kind: "open_url",
          url: "https://us.posthog.com/settings/user-api-keys",
          instructions: "Create a PostHog personal API key.",
          provider: "posthog",
          runId: "run_posthog"
        },
        browserProfile: "posthog-api-key"
      }
    ]) as never, "ws_1")).resolves.toEqual({
      ga4: { measurementId: null, propertyId: null },
      posthog: {
        projectId: "ph_project",
        projectKey: "phc_test_key",
        apiHost: "https://us.i.posthog.com"
      },
      x: { pixelId: null, eventTagIds: null }
    });
  });

  it("launches a persisted paused handoff through the injected browser factory seam", async () => {
    const create = vi.fn(async () => ({
      goto: vi.fn(async () => undefined),
      waitForSignal: vi.fn(async () => null),
      readNetwork: vi.fn(async () => []),
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        }
      })),
      destroy: vi.fn(async () => undefined)
    }));

    const browser = await launchPersistedSetupHandoff({
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Create a PostHog personal API key.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            resume: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              lastKnownUrl: "https://us.posthog.com/settings/user-api-keys"
            },
            browser: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              handoffUrl: "https://us.posthog.com/settings/user-api-keys",
              lastUrl: "https://us.posthog.com/settings/user-api-keys"
            }
          },
          browserProfile: "posthog-api-key"
        }
      ]) as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      browserFactory: { create } as ProvisionerContext["browser"],
      browserSessionStore
    });

    expect(create).toHaveBeenCalledWith({
      provider: "posthog",
      purpose: "provider_auth",
      contextRef: "posthog-api-key",
      sessionKey: "scope=workspace%3Aws_1%3Arun%3Arun_posthog|provider=posthog|context=posthog-api-key"
    });
    expect(browser.runId).toBe("run_posthog");
    expect(browser.provider).toBe("posthog");
    expect(browser.url).toBe("https://us.posthog.com/settings/user-api-keys");
    expect(browser.pendingHandoff).toMatchObject({
      provider: "posthog",
      runId: "run_posthog",
      reason: "posthog_manual_key"
    });
  });

  it("reuses the persisted browser session key when relaunching a paused handoff", async () => {
    const create = vi.fn(async () => ({
      goto: vi.fn(async () => undefined),
      waitForSignal: vi.fn(async () => null),
      readNetwork: vi.fn(async () => []),
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        }
      })),
      destroy: vi.fn(async () => undefined)
    }));

    await launchPersistedSetupHandoff({
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Create a PostHog personal API key.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            resume: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key",
              lastKnownUrl: "https://us.posthog.com/settings/user-api-keys"
            },
            browser: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key",
              handoffUrl: "https://us.posthog.com/settings/user-api-keys",
              lastUrl: "https://us.posthog.com/settings/user-api-keys"
            }
          },
          browserProfile: "posthog-api-key"
        }
      ]) as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      browserFactory: { create } as ProvisionerContext["browser"],
      browserSessionStore
    });

    expect(create).toHaveBeenCalledWith({
      provider: "posthog",
      purpose: "provider_auth",
      contextRef: "posthog-api-key",
      sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key"
    });
  });

  it("ignores a persisted browser session key that belongs to another provider", async () => {
    const create = vi.fn(async () => ({
      goto: vi.fn(async () => undefined),
      waitForSignal: vi.fn(async () => null),
      readNetwork: vi.fn(async () => []),
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        }
      })),
      destroy: vi.fn(async () => undefined)
    }));

    await launchPersistedSetupHandoff({
      db: fakeDb([
        {
          id: "run_posthog",
          provider: "posthog",
          tool: "posthog",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Create a PostHog personal API key.",
            provider: "posthog",
            runId: "run_posthog",
            reason: "posthog_manual_key",
            resume: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              sessionKey: "scope=workspace%3Aws_1|provider=ga4|context=ga4-google",
              lastKnownUrl: "https://us.posthog.com/settings/user-api-keys"
            },
            browser: {
              profileRef: "posthog-api-key",
              resumeNonce: "nonce-123",
              sessionKey: "scope=workspace%3Aws_1|provider=ga4|context=ga4-google",
              handoffUrl: "https://us.posthog.com/settings/user-api-keys",
              lastUrl: "https://us.posthog.com/settings/user-api-keys"
            }
          },
          browserProfile: "posthog-api-key"
        }
      ]) as never,
      workspaceId: "ws_1",
      runId: "run_posthog",
      browserFactory: { create } as ProvisionerContext["browser"],
      browserSessionStore
    });

    expect(create).toHaveBeenCalledWith({
      provider: "posthog",
      purpose: "provider_auth",
      contextRef: "posthog-api-key",
      sessionKey: "scope=workspace%3Aws_1%3Arun%3Arun_posthog|provider=posthog|context=posthog-api-key"
    });
  });

  it("saves the public install artifacts to the same-machine handoff file at the end of onboarding", async () => {
    const result = await runLiveSetupOnboarding({
      db: fakeDb([
        { id: "run_posthog", provider: "posthog", status: "paused_handoff" }
      ]) as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: ctx.prompt,
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher: vi.fn(async () => undefined)
    });

    expect(result.installCommand).toContain("--posthog-project-key phc_test_key");
    expect(result.installArtifactsPath).toBe(join(artifactsDir, "ws_1.json"));
    // Whitelisted public payload only — the resolved projectId never reaches the file.
    expect(JSON.parse(readFileSync(join(artifactsDir, "ws_1.json"), "utf8"))).toEqual({
      workspaceId: "ws_1",
      posthog: { projectKey: "phc_test_key", apiHost: "https://us.i.posthog.com" }
    });
  });

  it("keeps onboarding successful and notes the failure when the artifacts handoff file cannot be written", async () => {
    const blocked = join(artifactsDir, "not-a-directory");
    writeFileSync(blocked, "occupied");
    process.env.INFINITE_ARTIFACTS_DIR = blocked;
    const notes: string[] = [];

    const result = await runLiveSetupOnboarding({
      db: fakeDb([
        { id: "run_posthog", provider: "posthog", status: "paused_handoff" }
      ]) as never,
      workspaceId: "ws_1",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      actions: ctx.actions,
      prompt: { ...ctx.prompt, note(message: string) { notes.push(message); } },
      browserFactory: ctx.browser,
      browserSessionStore,
      runStore: fakeStore(),
      handoffLauncher: vi.fn(async () => undefined)
    });

    expect(result.installCommand).toContain("--posthog-project-key phc_test_key");
    expect(result.installArtifactsPath).toBeNull();
    expect(notes.some((note) => note.includes("could not save"))).toBe(true);
  });
});
