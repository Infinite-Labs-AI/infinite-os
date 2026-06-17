import { describe, expect, it, vi } from "vitest";

import {
  connectGa4Contract,
  createGa4AdminApiClient,
  createGa4LiveDependencies,
  detectGa4Contract,
  implementGa4Contract,
  implementProviderTagsContract,
  setupGa4Contract,
  syncGa4Contract,
  type Ga4AuthResolution,
  type Ga4Dependencies,
  type Ga4ImplementDependencies,
  type Ga4PropertySelector,
  type Ga4SelectPropertyInput
} from "./ga4.js";
import type { ApplyResult, InstallPlan, WorkspaceInstallArtifacts } from "infinite-tag";

describe("GA4 provider contract", () => {
  it("detects an existing account/property/web stream through the live Admin API and keeps OAuth secrets out of public artifacts", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const deps = createGa4LiveDependencies({
      oauth: {
        authorize: async () => ({
          kind: "authorized",
          session: {
            refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
            accessToken: "google-secret-token",
            refreshToken: "google-refresh-token",
            expiresAt: "2026-06-08T12:00:00.000Z"
          }
        })
      },
      admin: createGa4AdminApiClient({
        fetch: vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          fetchCalls.push({ url, init });

          if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
            return jsonResponse({
              accountSummaries: [
                {
                  account: "accounts/1",
                  propertySummaries: [
                    { property: "properties/100", displayName: "Acme" }
                  ]
                }
              ]
            });
          }

          if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/100/dataStreams") {
            return jsonResponse({
              dataStreams: [
                {
                  type: "WEB_DATA_STREAM",
                  webStreamData: {
                    measurementId: "G-ACME123",
                    defaultUri: "https://acme.test"
                  }
                }
              ]
            });
          }

          throw new Error(`unexpected request: ${url}`);
        })
      })
    });

    const outcome = await detectGa4Contract(deps, { websiteUrl: "https://acme.test/pricing" });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.url).toBe("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    expect(fetchCalls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer google-secret-token"
    });
    expect(fetchCalls[1]?.url).toBe("https://analyticsadmin.googleapis.com/v1beta/properties/100/dataStreams");
    expect(outcome.result.status).toBe("ok");
    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: true,
      assetId: "properties/100",
      installId: "G-ACME123"
    });
    expect(outcome.publicArtifacts).toEqual({
      propertyId: "properties/100",
      measurementId: "G-ACME123",
      defaultUri: "https://acme.test"
    });
    expect(outcome.secretRefs).toEqual({
      oauthAppId: "oauth_app_1",
      oauthTokenId: "oauth_tok_1"
    });
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("google-secret-token");
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("google-refresh-token");
    expect(outcome.connectSourceInput).toMatchObject({
      credentialKind: "oauth_access_token",
      credentialPayload: {
        propertyId: "properties/100",
        accessToken: "google-secret-token",
        refreshToken: "google-refresh-token",
        expiresAt: "2026-06-08T12:00:00.000Z",
        apiBaseUrl: "https://analyticsdata.googleapis.com/v1beta"
      }
    });
  });

  it("creates a property and web data stream through the live Admin API when an account exists without a property", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const deps = createGa4LiveDependencies({
      oauth: {
        authorize: async () => ({
          kind: "authorized",
          session: {
            refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
            accessToken: "google-secret-token",
            refreshToken: "google-refresh-token"
          }
        })
      },
      admin: createGa4AdminApiClient({
        fetch: vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          fetchCalls.push({ url, init });

          if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
            return jsonResponse({
              accountSummaries: [{ account: "accounts/1", propertySummaries: [] }]
            });
          }

          if (url === "https://analyticsadmin.googleapis.com/v1beta/properties") {
            return jsonResponse({ name: "properties/200" });
          }

          if (url === "https://analyticsadmin.googleapis.com/v1beta/properties/200/dataStreams") {
            return jsonResponse({
              type: "WEB_DATA_STREAM",
              displayName: "Acme Web Stream",
              webStreamData: {
                measurementId: "G-NEW12345",
                defaultUri: "https://acme.test"
              }
            });
          }

          throw new Error(`unexpected request: ${url}`);
        })
      })
    });

    const detected = await detectGa4Contract(deps, { websiteUrl: "https://acme.test" });
    const notes: string[] = [];
    const outcome = await setupGa4Contract(deps, detected, {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      timeZone: "Europe/London",
      note: (message) => notes.push(message)
    });

    // The founder sees creation happen in real time, ending with the next step.
    expect(notes).toEqual([
      'GA4: creating the Google Analytics 4 property "Acme"…',
      'GA4: property created — "Acme" (properties/200).',
      "GA4: web stream ready — Measurement ID G-NEW12345. " +
        "Next: install the tag in your website's repo (setup prints the exact npx command at the end)."
    ]);

    expect(fetchCalls.map((entry) => entry.url)).toEqual([
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
      "https://analyticsadmin.googleapis.com/v1beta/properties",
      "https://analyticsadmin.googleapis.com/v1beta/properties/200/dataStreams"
    ]);
    expect(parseJsonBody(fetchCalls[1]?.init?.body)).toEqual({
      parent: "accounts/1",
      displayName: "Acme",
      timeZone: "Europe/London"
    });
    expect(parseJsonBody(fetchCalls[2]?.init?.body)).toEqual({
      type: "WEB_DATA_STREAM",
      displayName: "Acme Web Stream",
      webStreamData: {
        defaultUri: "https://acme.test"
      }
    });
    expect(outcome.result.status).toBe("ok");
    expect(outcome.publicArtifacts).toEqual({
      propertyId: "properties/200",
      measurementId: "G-NEW12345",
      defaultUri: "https://acme.test"
    });
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("google-secret-token");
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("google-refresh-token");
  });

  it("does not promise the end-of-setup npx command when the new web stream has no Measurement ID yet", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [{ accountId: "accounts/1", properties: [] }];
      },
      async createProperty() {
        return { propertyId: "properties/200" };
      },
      async createWebDataStream() {
        // A stream can come back before Google issues its Measurement ID.
        return { measurementId: "", defaultUri: "https://acme.test" };
      }
    });

    const detected = await detectGa4Contract(deps, { websiteUrl: "https://acme.test" });
    const notes: string[] = [];
    const outcome = await setupGa4Contract(deps, detected, {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      timeZone: "Europe/London",
      note: (message) => notes.push(message)
    });

    expect(outcome.result.status).toBe("ok");
    const streamNote = notes.find((note) => note.includes("web stream ready")) ?? "";
    expect(streamNote).toContain("Measurement ID is still pending");
    expect(streamNote).toContain("re-run `infinite setup`");
    // No command will print at the end without a Measurement ID — don't promise one.
    expect(streamNote).not.toContain("setup prints the exact npx command");
  });

  it("returns needs_human with browser resume metadata when Google login or 2FA is required", async () => {
    const deps = createGa4LiveDependencies({
      oauth: {
        authorize: async () => ({
          kind: "needs_human",
          reason: "google_login",
          handoffUrl: "https://accounts.google.com/",
          instructions: "Log in to Google and complete any 2FA prompts.",
          browser: {
            profileRef: "ga4-founder-1",
            handoffUrl: "https://accounts.google.com/",
            resumeNonce: "resume-123"
          },
          resume: {
            step: "oauth_authorize",
            scopes: ["https://www.googleapis.com/auth/analytics.edit"]
          }
        })
      },
      admin: createGa4AdminApiClient({
        fetch: vi.fn(async () => {
          throw new Error("unused");
        })
      })
    });

    const outcome = await detectGa4Contract(deps, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.handoff).toEqual({
      kind: "open_url",
      url: "https://accounts.google.com/",
      instructions: "Log in to Google and complete any 2FA prompts."
    });
    expect(outcome.result.data).toEqual({
      reason: "google_login",
      resume: {
        step: "oauth_authorize",
        scopes: ["https://www.googleapis.com/auth/analytics.edit"]
      }
    });
    expect(outcome.browser).toEqual({
      profileRef: "ga4-founder-1",
      handoffUrl: "https://accounts.google.com/",
      resumeNonce: "resume-123"
    });
  });

  it("returns needs_human with a provisioned account ticket for the first-account Terms-of-Service path", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const deps = createGa4LiveDependencies({
      oauth: {
        authorize: async () => ({
          kind: "authorized",
          session: {
            refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
            accessToken: "google-secret-token",
            browser: {
              profileRef: "ga4-founder-1",
              resumeNonce: "resume-456"
            }
          }
        })
      },
      admin: createGa4AdminApiClient({
        fetch: vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          fetchCalls.push({ url, init });

          if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
            return jsonResponse({ accountSummaries: [] });
          }

          if (url === "https://analyticsadmin.googleapis.com/v1beta/accounts:provisionAccountTicket") {
            return jsonResponse({ accountTicketId: "ticket-123" });
          }

          throw new Error(`unexpected request: ${url}`);
        }),
        termsOfServiceUrl: ({ accountTicketId }) =>
          `https://analytics.google.com/analytics/web/provision/?ticket=${accountTicketId}`
      })
    });

    const detected = await detectGa4Contract(deps, { websiteUrl: "https://acme.test" });
    const outcome = await setupGa4Contract(deps, detected, {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      accountRegionCode: "GB",
      oauthRedirectUri: "https://growthos.test/oauth/google/callback"
    });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail).toContain("Terms of Service");
    expect(outcome.result.handoff).toEqual({
      kind: "open_url",
      url: "https://analytics.google.com/analytics/web/provision/?ticket=ticket-123",
      instructions: "Accept the Google Analytics Terms of Service to finish creating the first account."
    });
    expect(outcome.result.data).toEqual({
      reason: "google_tos",
      resume: {
        step: "provision_account_ticket",
        accountTicketId: "ticket-123",
        redirectUri: "https://growthos.test/oauth/google/callback"
      }
    });
    expect(parseJsonBody(fetchCalls[1]?.init?.body)).toEqual({
      account: {
        displayName: "Acme",
        regionCode: "GB"
      },
      redirectUri: "https://growthos.test/oauth/google/callback"
    });
    expect(outcome.secretRefs).toEqual({
      oauthAppId: "oauth_app_1",
      oauthTokenId: "oauth_tok_1"
    });
    expect(outcome.browser).toEqual({
      profileRef: "ga4-founder-1",
      handoffUrl: "https://analytics.google.com/analytics/web/provision/?ticket=ticket-123",
      resumeNonce: "resume-456"
    });
  });

  it("maps setup output into connect_source and start_source_sync payloads", async () => {
    const executed: Array<{ id: string; input: unknown }> = [];
    const deps: Ga4Dependencies = {
      async authorize() {
        return {
          kind: "authorized",
          session: {
            refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
            accessToken: "ga4-secret-token"
          }
        };
      },
      async listAccountSummaries() {
        return [{ accountId: "accounts/1", properties: [{ propertyId: "properties/123", displayName: "Acme" }] }];
      },
      async listWebDataStreams() {
        return [{ measurementId: "G-ACME123", defaultUri: "https://acme.test" }];
      },
      async createProperty() {
        throw new Error("unused");
      },
      async createWebDataStream() {
        throw new Error("unused");
      }
    };

    const detected = await detectGa4Contract(deps, { websiteUrl: "https://acme.test" });
    const connected = await connectGa4Contract(
      {
        workspaceId: "ws1",
        actions: {
          async execute(id, input) {
            executed.push({ id, input });
            return id === "connect_source"
              ? {
                  ok: true,
                  actionId: "connect_source",
                  authority: "operator",
                  status: "queued",
                  data: {
                    source: { id: "src_ga4", provider: "google_analytics_4" },
                    connectionTest: {
                      ok: true,
                      mode: "live",
                      provider: "google_analytics_4",
                      accountExternalId: "properties/123"
                    }
                  },
                  provenance: ["sources"],
                  caveats: [],
                  truncated: false,
                  nextActions: []
                }
              : {
                  ok: true,
                  actionId: "start_source_sync",
                  authority: "operator",
                  status: "queued",
                  data: { job: { id: "job_ga4_sync" } },
                  provenance: ["job_runs"],
                  caveats: [],
                  truncated: false,
                  nextActions: []
                };
          }
        }
      },
      detected,
      detected.state
    );
    const synced = await syncGa4Contract(
      {
        workspaceId: "ws1",
        actions: {
          async execute(id, input) {
            executed.push({ id, input });
            return {
              ok: true,
              actionId: "start_source_sync",
              authority: "operator",
              status: "queued",
              data: { job: { id: "job_ga4_sync" } },
              provenance: ["job_runs"],
              caveats: [],
              truncated: false,
              nextActions: []
            };
          }
        }
      },
      connected,
      connected.state
    );

    expect(executed).toEqual([
      {
        id: "connect_source",
        input: {
          provider: "google_analytics_4",
          connectionName: "Google Analytics 4",
          credentialKind: "oauth_access_token",
          accountExternalId: "properties/123",
          oauthTokenId: "oauth_tok_1",
          credentialPayload: {
            mode: "live",
            propertyId: "properties/123",
            accessToken: "ga4-secret-token",
            apiBaseUrl: "https://analyticsdata.googleapis.com/v1beta"
          }
        }
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
    expect(connected.state).toMatchObject({
      sourceId: "src_ga4",
      credentialValid: true
    });
    expect(connected.verification).toMatchObject({
      queryabilityStatus: "verified"
    });
    expect(synced.result.data).toEqual({
      jobId: "job_ga4_sync",
      mode: "incremental",
      refreshWindowDays: 7
    });
    expect(JSON.stringify(detected.publicArtifacts)).not.toContain("ga4-secret-token");
  });

  it("installs the GA4 tag via infinite-tag using the measurement id", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123" });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({
        changedFiles: ["app/layout.tsx"],
        manifestPath: "/repo/.infinite/install.json",
        warnings: []
      })
    );
    const deps: Ga4ImplementDependencies = { planInstallation, applyInstallation };

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      deps
    );

    expect(planInstallation).toHaveBeenCalledOnce();
    expect(planInstallation).toHaveBeenCalledWith({
      root: "/tmp/founder-app",
      workspaceId: "ws_1",
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    });
    expect(applyInstallation).toHaveBeenCalledOnce();
    expect(applyInstallation).toHaveBeenCalledWith({
      root: "/tmp/founder-app",
      workspaceId: "ws_1",
      plan
    });
    expect(outcome.result.status).toBe("ok");
    expect(outcome.verification?.installStatus).toBe("verified");
    expect(outcome.result.data).toMatchObject({ changedFiles: ["app/layout.tsx"] });
  });

  it("aborts the install when the founder declines the confirm gate (no files written)", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123" });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );
    const confirm = vi.fn(async () => false);

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1", confirm },
      { planInstallation, applyInstallation }
    );

    expect(planInstallation).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(plan);
    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("skipped");
    expect(outcome.result.detail).toContain("skipped");
  });

  it("applies the install when the founder accepts the confirm gate", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123" });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({
        changedFiles: ["app/layout.tsx"],
        manifestPath: "/repo/.infinite/install.json",
        warnings: []
      })
    );
    const confirm = vi.fn(async () => true);

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1", confirm },
      { planInstallation, applyInstallation }
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(applyInstallation).toHaveBeenCalledOnce();
    expect(outcome.result.status).toBe("ok");
    expect(outcome.verification?.installStatus).toBe("verified");
  });

  it("never reaches the confirm gate when a guard already blocks the install (dirty repo)", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123", repoStatus: "dirty" });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );
    const confirm = vi.fn(async () => true);

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1", confirm },
      { planInstallation, applyInstallation }
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("blocked");
  });

  it("blocks the install when the plan reports blockers", async () => {
    const plan = buildInstallPlan({
      measurementId: "G-TEST123",
      blockers: ["Unsupported repository shape for instrumentation."]
    });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );

    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.verification?.installStatus).toBe("failed");
    expect(outcome.result.detail).toContain("Unsupported repository shape");
  });

  it("defers to a human when the framework plan is not auto-applyable", async () => {
    const plan = buildInstallPlan({
      measurementId: "G-TEST123",
      applyMode: "plan-only",
      instructions: [
        {
          path: "app/layout.tsx",
          action: "modify",
          description: "Add the GA4 snippet to the root layout.",
          snippet: "<script>...</script>"
        }
      ]
    });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );

    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail).toContain("Add the GA4 snippet");
  });

  it("skips install and warns when no measurement id is present", async () => {
    const planInstallation = vi.fn(() => buildInstallPlan({ measurementId: "G-UNUSED" }));
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );

    const outcome = await implementGa4Contract(
      { measurementId: "", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );

    expect(planInstallation).not.toHaveBeenCalled();
    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("skipped");
  });

  it("blocks the install when the founder repo is dirty (does not call apply)", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123", repoStatus: "dirty" });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );

    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.result.detail).toContain("uncommitted changes");
  });

  it("returns blocked (does not throw) when applyInstallation throws", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123" });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn((): ApplyResult => {
      throw new Error("Refusing to apply on a dirty git tree without --allow-dirty.");
    });

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );

    expect(outcome.result.status).toBe("blocked");
    expect(outcome.result.detail).toContain("could not be applied");
  });

  it("defers to a human when plan confidence is below threshold", async () => {
    const plan = buildInstallPlan({ measurementId: "G-TEST123", confidence: 0.5 });
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn(
      (): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })
    );

    const outcome = await implementGa4Contract(
      { measurementId: "G-TEST123", repoRoot: "/tmp/founder-app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );

    expect(applyInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail).toContain("Not confident enough");
  });
});

describe("implementProviderTagsContract (#9 provider-neutral combined install)", () => {
  function multiPlan(providers: string[], overrides: Partial<InstallPlan> = {}): InstallPlan {
    return {
      framework: "next-app-router",
      providers,
      files: ["lib/infinite-analytics.ts"],
      envKeys: [],
      applyMode: "supported",
      instructions: [],
      assumptions: [],
      blockers: [],
      confidence: 1,
      appRoot: ".",
      packageManager: "pnpm",
      repoStatus: "clean",
      workspaceId: "ws_1",
      artifacts: {},
      ...overrides
    };
  }

  it("returns skipped (no plan) when the artifacts map is empty", async () => {
    const planInstallation = vi.fn(() => multiPlan([]));
    const applyInstallation = vi.fn((): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] }));
    const outcome = await implementProviderTagsContract(
      { artifacts: {}, repoRoot: "/tmp/app", workspaceId: "ws_1" },
      { planInstallation, applyInstallation }
    );
    expect(planInstallation).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("skipped");
  });

  it("plans + applies ALL providers in one pass and names them in the success detail", async () => {
    const artifacts: WorkspaceInstallArtifacts = {
      ga4: { measurementId: "G-OK" },
      posthog: { projectKey: "phc_1", apiHost: "https://us.i.posthog.com" },
      x: { pixelId: "px_1", eventTagIds: ["tag_a"] }
    };
    const plan = multiPlan(["ga4", "posthog", "x"]);
    const planInstallation = vi.fn(() => plan);
    const applyInstallation = vi.fn((): ApplyResult => ({ changedFiles: ["lib/infinite-analytics.ts"], manifestPath: "/repo/.infinite/install.json", warnings: [] }));
    const confirm = vi.fn(async () => true);
    const outcome = await implementProviderTagsContract(
      { artifacts, repoRoot: "/tmp/app", workspaceId: "ws_1", confirm },
      { planInstallation, applyInstallation }
    );
    expect(planInstallation).toHaveBeenCalledOnce();
    expect(planInstallation).toHaveBeenCalledWith({ root: "/tmp/app", workspaceId: "ws_1", artifacts });
    expect(applyInstallation).toHaveBeenCalledOnce();
    expect(outcome.result.status).toBe("ok");
    expect(outcome.result.detail).toContain("GA4 tag, PostHog snippet, and X pixel");
  });

  it("uses provider-neutral (non-GA4) wording in the guard details for a PostHog-only plan", async () => {
    const plan = multiPlan(["posthog"], { blockers: ["Unsupported repository shape."] });
    const outcome = await implementProviderTagsContract(
      { artifacts: { posthog: { projectKey: "phc_1", apiHost: "https://us.i.posthog.com" } }, repoRoot: "/tmp/app", workspaceId: "ws_1" },
      { planInstallation: vi.fn(() => plan), applyInstallation: vi.fn((): ApplyResult => ({ changedFiles: [], manifestPath: "", warnings: [] })) }
    );
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.result.detail).toContain("Could not install PostHog snippet");
    expect(outcome.result.detail).not.toContain("GA4");
  });
});

describe("GA4 account/property selection", () => {
  it("without a prompter, auto-selects the property whose web stream matches the site, ignoring an earlier property that merely has a stream", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/ultima",
            displayName: "Ultima | Main",
            properties: [{ propertyId: "properties/525", displayName: "Ultima Inc" }]
          },
          {
            accountId: "accounts/slv",
            displayName: "SLV",
            properties: [{ propertyId: "properties/999", displayName: "Startup Launch Videos" }]
          }
        ];
      },
      async listWebDataStreams(_session, propertyId) {
        if (propertyId === "properties/525") {
          return [{ measurementId: "G-ULTIMA", defaultUri: "https://ultima.test" }];
        }
        if (propertyId === "properties/999") {
          return [{ measurementId: "G-SLV", defaultUri: "https://slv.test" }];
        }
        return [];
      }
    });

    const outcome = await detectGa4Contract(deps, { websiteUrl: "https://slv.test" });

    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: true,
      assetId: "properties/999",
      installId: "G-SLV"
    });
    expect(outcome.publicArtifacts).toMatchObject({
      propertyId: "properties/999",
      measurementId: "G-SLV"
    });
  });

  it("always shows the picker when the founder has properties — even on a single clean match — offering the match first", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/slv",
            displayName: "SLV",
            properties: [{ propertyId: "properties/999", displayName: "Startup Launch Videos" }]
          }
        ];
      },
      async listWebDataStreams() {
        return [{ measurementId: "G-SLV", defaultUri: "https://slv.test" }];
      }
    });
    let received: Ga4SelectPropertyInput | undefined;
    const selectProperty: Ga4PropertySelector = async (input) => {
      received = input;
      const candidate = input.candidates[0]!;
      return {
        kind: "use_property",
        accountId: candidate.accountId,
        propertyId: candidate.propertyId,
        displayName: candidate.displayName,
        stream: candidate.stream
      };
    };

    const outcome = await detectGa4Contract(deps, {
      websiteUrl: "https://slv.test",
      selectProperty
    });

    expect(received?.candidates).toHaveLength(1);
    expect(received?.candidates[0]).toMatchObject({ propertyId: "properties/999", matchesSite: true });
    expect(outcome.state).toMatchObject({ assetExists: true, assetId: "properties/999", installId: "G-SLV" });
  });

  it("asks the selector with every match flagged when more than one property matches the same site host", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/slv",
            displayName: "SLV",
            properties: [
              { propertyId: "properties/700", displayName: "SLV Prod" },
              { propertyId: "properties/701", displayName: "SLV Staging" }
            ]
          }
        ];
      },
      async listWebDataStreams(_session, propertyId) {
        if (propertyId === "properties/700") {
          return [{ measurementId: "G-PROD", defaultUri: "https://slv.test" }];
        }
        return [{ measurementId: "G-STAGING", defaultUri: "https://www.slv.test" }];
      }
    });
    let received: Ga4SelectPropertyInput | undefined;
    const selectProperty: Ga4PropertySelector = async (input) => {
      received = input;
      const candidate = input.candidates.find((entry) => entry.propertyId === "properties/700")!;
      return {
        kind: "use_property",
        accountId: candidate.accountId,
        propertyId: candidate.propertyId,
        displayName: candidate.displayName,
        stream: candidate.stream
      };
    };

    const outcome = await detectGa4Contract(deps, {
      websiteUrl: "https://slv.test",
      selectProperty
    });

    expect(received?.candidates).toHaveLength(2);
    expect(received?.candidates.every((candidate) => candidate.matchesSite === true)).toBe(true);
    expect(outcome.state).toMatchObject({ assetId: "properties/700", installId: "G-PROD" });
  });

  it("never silently connects a non-matching property — asks the selector with all candidates when nothing matches the site", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/ultima",
            displayName: "Ultima | Main",
            properties: [{ propertyId: "properties/525", displayName: "Ultima Inc" }]
          },
          {
            accountId: "accounts/infinite",
            displayName: "Infinite Site",
            properties: [{ propertyId: "properties/396", displayName: "Infinite" }]
          }
        ];
      },
      async listWebDataStreams(_session, propertyId) {
        if (propertyId === "properties/525") {
          return [{ measurementId: "G-ULTIMA", defaultUri: "https://ultima.test" }];
        }
        return [{ measurementId: "G-INF", defaultUri: "https://infinite.test" }];
      }
    });
    let received: Ga4SelectPropertyInput | undefined;
    const selectProperty: Ga4PropertySelector = async (input) => {
      received = input;
      return { kind: "create_property", accountId: "accounts/ultima" };
    };

    const outcome = await detectGa4Contract(deps, {
      websiteUrl: "https://startuplaunchvideos.com",
      selectProperty
    });

    expect(received?.candidates).toHaveLength(2);
    expect(received?.candidates.every((candidate) => candidate.matchesSite === false)).toBe(true);
    expect(received?.accounts).toEqual([
      { accountId: "accounts/ultima", accountName: "Ultima | Main" },
      { accountId: "accounts/infinite", accountName: "Infinite Site" }
    ]);
    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: false,
      assets: { accountId: "accounts/ultima" }
    });
    expect(outcome.connectSourceInput).toBeUndefined();
  });

  it("connects the existing property the founder picks from the selector", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/ultima",
            displayName: "Ultima | Main",
            properties: [{ propertyId: "properties/525", displayName: "Ultima Inc" }]
          },
          {
            accountId: "accounts/infinite",
            displayName: "Infinite Site",
            properties: [{ propertyId: "properties/396", displayName: "Infinite" }]
          }
        ];
      },
      async listWebDataStreams(_session, propertyId) {
        if (propertyId === "properties/525") {
          return [{ measurementId: "G-ULTIMA", defaultUri: "https://ultima.test" }];
        }
        return [{ measurementId: "G-INF", defaultUri: "https://infinite.test" }];
      }
    });
    const selectProperty: Ga4PropertySelector = async (input) => {
      const candidate = input.candidates.find((entry) => entry.propertyId === "properties/525")!;
      return {
        kind: "use_property",
        accountId: candidate.accountId,
        propertyId: candidate.propertyId,
        displayName: candidate.displayName,
        stream: candidate.stream
      };
    };

    const outcome = await detectGa4Contract(deps, {
      websiteUrl: "https://startuplaunchvideos.com",
      selectProperty
    });

    expect(outcome.state).toMatchObject({
      assetExists: true,
      assetId: "properties/525",
      installId: "G-ULTIMA"
    });
    expect(outcome.connectSourceInput).toMatchObject({
      credentialPayload: { propertyId: "properties/525" }
    });
  });

  it("marks the selector's create-account choice for setup instead of handing off at detect", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/ultima",
            displayName: "Ultima | Main",
            properties: [{ propertyId: "properties/525", displayName: "Ultima Inc" }]
          }
        ];
      },
      async listWebDataStreams() {
        return [{ measurementId: "G-ULTIMA", defaultUri: "https://ultima.test" }];
      }
    });
    const selectProperty: Ga4PropertySelector = async () => ({ kind: "create_account" });

    const outcome = await detectGa4Contract(deps, {
      websiteUrl: "https://slv.test",
      selectProperty
    });

    // Detect no longer pauses for the browser: the SETUP phase owns account
    // creation so it can pre-stage the account via provisionAccountTicket.
    expect(outcome.result.status).toBe("ok");
    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: false,
      requestedNewAccount: true
    });
    expect(outcome.secretRefs).toEqual({
      oauthAppId: "oauth_app_1",
      oauthTokenId: "oauth_tok_1"
    });
  });

  it("routes a picker create-account choice through provisionAccountTicket in setup", async () => {
    const provisionAccountTicket = vi.fn(async () => ({
      accountTicketId: "ticket-789",
      handoffUrl: "https://analytics.google.com/analytics/web/provision/?ticket=ticket-789"
    }));
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/ultima",
            displayName: "Ultima | Main",
            properties: [{ propertyId: "properties/525", displayName: "Ultima Inc" }]
          }
        ];
      },
      async listWebDataStreams() {
        return [{ measurementId: "G-ULTIMA", defaultUri: "https://ultima.test" }];
      },
      provisionAccountTicket
    });
    const selectProperty: Ga4PropertySelector = async () => ({ kind: "create_account" });

    const detected = await detectGa4Contract(deps, {
      websiteUrl: "https://slv.test",
      selectProperty
    });
    const outcome = await setupGa4Contract(deps, detected, {
      projectName: "SLV",
      websiteUrl: "https://slv.test",
      accountRegionCode: "GB",
      oauthRedirectUri: "https://growthos.test/oauth/google/callback"
    });

    expect(provisionAccountTicket).toHaveBeenCalledWith(
      expect.objectContaining({ refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" } }),
      {
        displayName: "SLV",
        regionCode: "GB",
        redirectUri: "https://growthos.test/oauth/google/callback"
      }
    );
    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.handoff).toEqual({
      kind: "open_url",
      url: "https://analytics.google.com/analytics/web/provision/?ticket=ticket-789",
      instructions: "Accept the Google Analytics Terms of Service to finish creating the new account."
    });
    expect(outcome.result.data).toEqual({
      reason: "google_tos",
      resume: {
        step: "provision_account_ticket",
        accountTicketId: "ticket-789",
        redirectUri: "https://growthos.test/oauth/google/callback"
      }
    });
  });

  it("falls back to the manual analytics.google.com handoff when the ticket path is unavailable", async () => {
    const provisionAccountTicket = vi.fn(async () => {
      throw new Error("provisionAccountTicket not expected without an OAuth redirect URI");
    });
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/ultima",
            displayName: "Ultima | Main",
            properties: [{ propertyId: "properties/525", displayName: "Ultima Inc" }]
          }
        ];
      },
      async listWebDataStreams() {
        return [{ measurementId: "G-ULTIMA", defaultUri: "https://ultima.test" }];
      },
      provisionAccountTicket
    });
    const selectProperty: Ga4PropertySelector = async () => ({ kind: "create_account" });

    const detected = await detectGa4Contract(deps, {
      websiteUrl: "https://slv.test",
      selectProperty
    });
    // No oauthRedirectUri (today's live CLI flow never passes one) → exactly the
    // legacy manual handoff.
    const outcome = await setupGa4Contract(deps, detected, {
      projectName: "SLV",
      websiteUrl: "https://slv.test"
    });

    expect(provisionAccountTicket).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.handoff?.url).toBe("https://analytics.google.com/analytics/web/");
    expect(outcome.result.detail).toBe(
      "Create a new Google Analytics account at analytics.google.com, then resume setup to pick its property."
    );
    expect(outcome.result.data).toEqual({ reason: "google_tos" });
  });

  it("lets setup add a web stream when the founder picks an existing property that has none", async () => {
    const createWebDataStream = vi.fn(async () => ({
      measurementId: "G-NEWSTREAM",
      defaultUri: "https://slv.test"
    }));
    const createProperty = vi.fn(async () => {
      throw new Error("createProperty not expected");
    });
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/slv",
            displayName: "SLV",
            properties: [{ propertyId: "properties/300", displayName: "SLV (no stream)" }]
          }
        ];
      },
      async listWebDataStreams() {
        return [];
      },
      createProperty,
      createWebDataStream
    });
    const selectProperty: Ga4PropertySelector = async (input) => {
      const candidate = input.candidates[0]!;
      return {
        kind: "use_property",
        accountId: candidate.accountId,
        propertyId: candidate.propertyId,
        displayName: candidate.displayName,
        stream: candidate.stream
      };
    };

    const detected = await detectGa4Contract(deps, {
      websiteUrl: "https://slv.test",
      selectProperty
    });
    expect(detected.state).toMatchObject({
      accountExists: true,
      assetExists: false,
      assetId: "properties/300",
      assets: { accountId: "accounts/slv", propertyId: "properties/300" }
    });

    const setupOutcome = await setupGa4Contract(deps, detected, {
      projectName: "SLV",
      websiteUrl: "https://slv.test"
    });

    expect(createProperty).not.toHaveBeenCalled();
    expect(createWebDataStream).toHaveBeenCalledWith(expect.anything(), {
      propertyId: "properties/300",
      displayName: "SLV Web Stream",
      defaultUri: "https://slv.test"
    });
    expect(setupOutcome.state).toMatchObject({
      assetExists: true,
      assetId: "properties/300",
      installId: "G-NEWSTREAM"
    });
  });

  it("without a prompter, matches the site host leniently across www, protocol, and a trailing FQDN dot", async () => {
    const deps = makeGa4Deps({
      async listAccountSummaries() {
        return [
          {
            accountId: "accounts/1",
            displayName: "Acme",
            properties: [{ propertyId: "properties/100", displayName: "Acme" }]
          }
        ];
      },
      async listWebDataStreams() {
        return [{ measurementId: "G-ACME", defaultUri: "http://www.acme.test." }];
      }
    });

    const outcome = await detectGa4Contract(deps, { websiteUrl: "https://acme.test" });

    expect(outcome.state).toMatchObject({
      assetExists: true,
      assetId: "properties/100",
      installId: "G-ACME"
    });
  });
});

function makeGa4Deps(overrides: Partial<Ga4Dependencies>): Ga4Dependencies {
  return {
    async authorize(): Promise<Ga4AuthResolution> {
      return {
        kind: "authorized",
        session: {
          refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
          accessToken: "ga4-secret-token"
        }
      };
    },
    async listAccountSummaries() {
      return [];
    },
    async listWebDataStreams() {
      return [];
    },
    async createProperty() {
      throw new Error("createProperty not expected");
    },
    async createWebDataStream() {
      throw new Error("createWebDataStream not expected");
    },
    ...overrides
  };
}

function buildInstallPlan(
  overrides: {
    measurementId: string;
    blockers?: string[];
    applyMode?: InstallPlan["applyMode"];
    instructions?: InstallPlan["instructions"];
    repoStatus?: InstallPlan["repoStatus"];
    confidence?: number;
  }
): InstallPlan {
  return {
    framework: "next-app-router",
    providers: ["ga4"],
    files: ["app/layout.tsx"],
    envKeys: ["NEXT_PUBLIC_GA4_MEASUREMENT_ID"],
    applyMode: overrides.applyMode ?? "supported",
    instructions: overrides.instructions ?? [],
    assumptions: [],
    blockers: overrides.blockers ?? [],
    confidence: overrides.confidence ?? 1,
    appRoot: ".",
    packageManager: "pnpm",
    repoStatus: overrides.repoStatus ?? "clean",
    workspaceId: "ws_1",
    artifacts: { ga4: { measurementId: overrides.measurementId } }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function parseJsonBody(body: RequestInit["body"] | null | undefined): unknown {
  if (typeof body !== "string") {
    return undefined;
  }
  return JSON.parse(body);
}
