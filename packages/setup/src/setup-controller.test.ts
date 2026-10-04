import { describe, expect, it } from "vitest";

import { runSetup, type SetupRunStore } from "./setup-controller.js";
import { createGa4Provisioner, type Provisioner, type ProvisionerContext } from "./provisioner.js";
import type { DetectionState, PhaseResult, ProviderRunState } from "./types.js";

function fakeStore(): SetupRunStore & {
  phases: Array<[string, PhaseResult]>;
  stateUpdates: Array<{ runId: string; update: Record<string, unknown> }>;
  readonly finished?: string;
} {
  const phases: Array<[string, PhaseResult]> = [];
  const stateUpdates: Array<{ runId: string; update: Record<string, unknown> }> = [];
  let finished: string | undefined;
  return {
    phases,
    stateUpdates,
    get finished() {
      return finished;
    },
    async startOrResume() {
      return { runId: "run_1", resumed: false };
    },
    async recordPhase(_runId, verb, result) {
      phases.push([verb, result]);
    },
    async recordSetupState(runId, update) {
      stateUpdates.push({ runId, update: update as Record<string, unknown> });
    },
    async finish(_runId, status) {
      finished = status;
    }
  };
}

const ctx = {
  workspaceId: "ws1",
  browser: { async create() { throw new Error("unused"); } },
  actions: { async execute() { throw new Error("unused"); } },
  prompt: { async ask() { return ""; }, note() {} },
  log() {}
} as unknown as ProvisionerContext;

function provisioner(state: DetectionState, overrides: Partial<Provisioner> = {}): Provisioner {
  return {
    tool: "ga4",
    friction: "green",
    capabilities: { detect: { rung: "api", automatable: true } },
    async detect() { return state; },
    async setup() { return { status: "ok", detail: "created" }; },
    async connect() { return { status: "ok", detail: "connected" }; },
    async sync() { return { status: "ok", detail: "synced" }; },
    async implement() { return { status: "ok", detail: "installed" }; },
    ...overrides
  };
}

const nothing: DetectionState = { accountExists: false, assetExists: false };
const green: DetectionState = {
  accountExists: true, assetExists: true, assetId: "p1", sourceId: "s",
  credentialValid: true, tagInstalled: true, tagFiring: true
};

describe("runSetup", () => {
  it("runs all verbs in order for a blank state and succeeds", async () => {
    const store = fakeStore();
    const r = await runSetup(provisioner(nothing), ctx, store);
    expect(r.status).toBe("succeeded");
    expect(store.phases.map(([v]) => v)).toEqual(["setup", "connect", "sync", "implement"]);
    expect(store.finished).toBe("succeeded");
  });

  it("skips every verb for a green state (no-op re-run)", async () => {
    const store = fakeStore();
    const r = await runSetup(provisioner(green), ctx, store);
    expect(r.status).toBe("succeeded");
    expect(store.phases).toEqual([]); // nothing executed
    // detect is always "ok"; the four executable verbs must all be skipped
    for (const v of ["setup", "connect", "sync", "implement"] as const) {
      expect(r.phases[v].status).toBe("skipped");
    }
  });

  it("pauses and stops at the first needs_human", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, { async connect() { return { status: "needs_human", detail: "log in" }; } });
    const r = await runSetup(p, ctx, store);
    expect(r.status).toBe("paused_handoff");
    expect(store.phases.map(([v]) => v)).toEqual(["setup", "connect"]); // sync/implement not reached
    expect(store.finished).toBe("paused_handoff");
  });

  it("skipImplement defers implement", async () => {
    const store = fakeStore();
    const r = await runSetup(provisioner(nothing), ctx, store, { skipImplement: true });
    expect(store.phases.map(([v]) => v)).toEqual(["setup", "connect", "sync"]);
    expect(r.phases.implement.status).toBe("skipped");
  });

  it("treats an unsupported verb as skipped", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, { connect: undefined, sync: undefined }); // X-like (no connect/sync)
    const r = await runSetup(p, ctx, store);
    expect(r.status).toBe("succeeded");
    expect(store.phases.map(([v]) => v)).toEqual(["setup", "implement"]);
    expect(r.phases.connect.status).toBe("skipped");
  });

  it("persists provider state snapshots, including detect handoff info, when the store supports it", async () => {
    const store = fakeStore();
    const ga4 = createGa4Provisioner({
      async authorize() {
        return {
          kind: "needs_human" as const,
          reason: "google_login" as const,
          handoffUrl: "https://accounts.google.com/",
          instructions: "Log in to Google and complete any 2FA prompts."
        };
      },
      async listAccountSummaries() {
        throw new Error("unused");
      },
      async listWebDataStreams() {
        throw new Error("unused");
      },
      async createProperty() {
        throw new Error("unused");
      },
      async createWebDataStream() {
        throw new Error("unused");
      }
    });

    const result = await runSetup(ga4, {
      ...ctx,
      setup: { projectName: "Acme", websiteUrl: "https://acme.test" }
    }, store, {
      skipImplement: true,
      inventory: {
        provider: "ga4",
        hasAccount: false,
        installState: "unknown",
        selected: true,
        recommended: true
      }
    });

    expect(result.status).toBe("paused_handoff");
    expect(result.phases.detect).toMatchObject({
      status: "needs_human",
      handoff: {
        kind: "open_url",
        url: "https://accounts.google.com/",
        instructions: "Log in to Google and complete any 2FA prompts."
      }
    });
    expect(result.providerState).toMatchObject({
      inventory: expect.objectContaining({
        provider: "ga4",
        selected: true
      }),
      phases: expect.objectContaining({
        detect: expect.objectContaining({
          status: "needs_human"
        })
      })
    } satisfies Partial<ProviderRunState>);
    expect(store.stateUpdates).toContainEqual({
      runId: "run_1",
      update: expect.objectContaining({
        provider: "ga4",
        pendingHandoff: {
          provider: "ga4",
          runId: "run_1",
          kind: "open_url",
          url: "https://accounts.google.com/",
          instructions: "Log in to Google and complete any 2FA prompts.",
          reason: "google_login",
          browser: {
            handoffUrl: "https://accounts.google.com/",
            lastUrl: "https://accounts.google.com/"
          }
        },
        providerState: expect.objectContaining({
          inventory: expect.objectContaining({ provider: "ga4" }),
          phases: expect.objectContaining({
            detect: expect.objectContaining({ status: "needs_human" })
          })
        })
      })
    });
  });

  it("persists the resumable interview state before provider detection", async () => {
    const store = fakeStore();
    const events: string[] = [];
    const recordSetupState = store.recordSetupState!.bind(store);
    store.recordSetupState = async (runId, update) => {
      events.push("persist");
      await recordSetupState(runId, update);
    };
    const interview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web" as const,
      providerInventory: [
        { provider: "ga4" as const, hasAccount: true, installState: "unknown" as const, selected: true, recommended: true }
      ]
    };
    const selectedProviders = ["ga4" as const];
    const recommendedProviders = ["ga4" as const];

    await runSetup(provisioner(green, {
      async detect() {
        events.push("detect");
        return green;
      }
    }), ctx, store, {
      interview,
      selectedProviders,
      recommendedProviders,
      inventory: interview.providerInventory[0],
      skipImplement: true
    });

    expect(events.slice(0, 2)).toEqual(["persist", "detect"]);
    expect(store.stateUpdates[0]).toEqual({
      runId: "run_1",
      update: expect.objectContaining({
        interview,
        selectedProviders,
        recommendedProviders,
        provider: "ga4",
        providerState: expect.objectContaining({
          inventory: expect.objectContaining({ provider: "ga4" }),
          phases: {}
        })
      })
    });
  });

  it("preserves query-bearing OAuth handoff URLs in persisted state for trusted resume flows", async () => {
    const store = fakeStore();
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=oauth-state-1#consent";
    const ga4 = createGa4Provisioner({
      async authorize() {
        return {
          kind: "needs_human" as const,
          reason: "google_login" as const,
          handoffUrl: authorizationUrl,
          instructions: "Approve Google Analytics access for this workspace."
        };
      },
      async listAccountSummaries() {
        throw new Error("unused");
      },
      async listWebDataStreams() {
        throw new Error("unused");
      },
      async createProperty() {
        throw new Error("unused");
      },
      async createWebDataStream() {
        throw new Error("unused");
      }
    });

    await runSetup(ga4, {
      ...ctx,
      setup: { projectName: "Acme", websiteUrl: "https://acme.test" }
    }, store, {
      skipImplement: true,
      inventory: {
        provider: "ga4",
        hasAccount: true,
        installState: "unknown",
        selected: true,
        recommended: true
      }
    });

    expect(store.stateUpdates).toContainEqual({
      runId: "run_1",
      update: expect.objectContaining({
        pendingHandoff: expect.objectContaining({
          provider: "ga4",
          url: authorizationUrl,
          browser: expect.objectContaining({
            handoffUrl: authorizationUrl,
            lastUrl: authorizationUrl
          })
        })
      })
    });
  });

  const ga4Interview = {
    projectName: "Acme",
    websiteUrl: "https://acme.test",
    productSurface: "web" as const,
    providerInventory: [
      { provider: "ga4" as const, hasAccount: true, installState: "unknown" as const, selected: true, recommended: true }
    ]
  };

  it("links the primary site to the connected GA4 source after a successful connect", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, {
      async connect() {
        return {
          result: { status: "ok", detail: "connected", data: { sourceId: "src_connected" } },
          state: { ...nothing, sourceId: "src_connected", credentialValid: true }
        };
      }
    });

    await runSetup(p, ctx, store, { interview: ga4Interview, skipImplement: true });

    const siteWrite = store.stateUpdates.find((u) => (u.update as { site?: unknown }).site);
    expect(siteWrite?.update).toMatchObject({
      provider: "ga4",
      site: {
        workspaceId: "ws1",
        url: "https://acme.test",
        ga4SourceId: "src_connected"
      }
    });
  });

  it("back-fills the site link on an idempotent re-run where connect is skipped", async () => {
    const store = fakeStore();
    // green = already connected with valid creds → reconciler returns connect='skip'.
    // This is the re-run path for a GA4 source connected BEFORE this feature shipped:
    // ga4_source_id must still be back-filled from the detected sourceId.
    const p = provisioner(green);

    const r = await runSetup(p, ctx, store, { interview: ga4Interview, skipImplement: true });

    expect(r.phases.connect.status).toBe("skipped");
    const siteWrite = store.stateUpdates.find((u) => (u.update as { site?: unknown }).site);
    expect(siteWrite?.update).toMatchObject({
      provider: "ga4",
      site: {
        workspaceId: "ws1",
        url: "https://acme.test",
        ga4SourceId: "s"
      }
    });
  });

  it("does NOT emit a site link on a skipped setup verb (only the connect verb)", async () => {
    const store = fakeStore();
    // assetReady but source not yet connected: setup='skip', connect='run'.
    const assetOnly: DetectionState = { accountExists: true, assetExists: true, assetId: "p1" };
    const p = provisioner(assetOnly, {
      async connect() {
        return {
          result: { status: "ok", detail: "connected", data: { sourceId: "src_connected" } },
          state: { ...assetOnly, sourceId: "src_connected", credentialValid: true }
        };
      }
    });

    await runSetup(p, ctx, store, { interview: ga4Interview, skipImplement: true });

    // Exactly one site write, and it carries the source from the executed connect verb
    // (src_connected) — the skipped setup verb (where no sourceId is known yet) emitted none.
    const siteWrites = store.stateUpdates.filter((u) => (u.update as { site?: unknown }).site);
    expect(siteWrites).toHaveLength(1);
    expect(siteWrites[0].update).toMatchObject({ site: { ga4SourceId: "src_connected" } });
  });

  it("does NOT emit a site link when connect needs a human (no real sourceId)", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, {
      async connect() {
        return { status: "needs_human", detail: "log in to Google" };
      }
    });

    const r = await runSetup(p, ctx, store, { interview: ga4Interview, skipImplement: true });

    expect(r.status).toBe("paused_handoff");
    expect(store.stateUpdates.every((u) => !(u.update as { site?: unknown }).site)).toBe(true);
  });

  it("does NOT emit a site link when the interview has no websiteUrl", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, {
      async connect() {
        return {
          result: { status: "ok", detail: "connected" },
          state: { ...nothing, sourceId: "src_connected" }
        };
      }
    });

    await runSetup(p, ctx, store, {
      interview: { ...ga4Interview, websiteUrl: undefined },
      skipImplement: true
    });

    expect(store.stateUpdates.every((u) => !(u.update as { site?: unknown }).site)).toBe(true);
  });

  it("does NOT emit a site link for a non-ga4 provider connect", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, {
      tool: "posthog",
      async connect() {
        return {
          result: { status: "ok", detail: "connected" },
          state: { ...nothing, sourceId: "src_posthog" }
        };
      }
    });

    await runSetup(p, ctx, store, { interview: ga4Interview, skipImplement: true });

    expect(store.stateUpdates.every((u) => !(u.update as { site?: unknown }).site)).toBe(true);
  });

  it("persists resumable handoff payloads with provider metadata and safe browser context", async () => {
    const store = fakeStore();
    const p = provisioner(nothing, {
      async connect() {
        return {
          result: {
            status: "needs_human",
            detail: "Create a PostHog personal API key.",
            data: {
              reason: "posthog_manual_key",
              resume: {
                profileRef: "posthog-api-key",
                resumeNonce: "nonce-123",
                lastKnownUrl: "https://us.posthog.com/settings/user-api-keys"
              }
            },
            handoff: {
              kind: "open_url",
              url: "https://us.posthog.com/settings/user-api-keys",
              instructions: "Create a PostHog personal API key."
            }
          },
          browser: {
            profileRef: "posthog-api-key",
            resumeNonce: "nonce-123",
            handoffUrl: "https://us.posthog.com/settings/user-api-keys",
            lastUrl: "https://us.posthog.com/settings/user-api-keys"
          }
        };
      }
    });

    const result = await runSetup(p, ctx, store, {
      inventory: {
        provider: "ga4",
        hasAccount: false,
        installState: "unknown",
        selected: true,
        recommended: true
      }
    });

    expect(result.status).toBe("paused_handoff");
    expect(store.stateUpdates).toContainEqual({
      runId: "run_1",
      update: expect.objectContaining({
        provider: "ga4",
        pendingHandoff: {
          provider: "ga4",
          runId: "run_1",
          kind: "open_url",
          url: "https://us.posthog.com/settings/user-api-keys",
          instructions: "Create a PostHog personal API key.",
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
        }
      })
    });
  });
});
