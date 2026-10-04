import { describe, expect, it, vi } from "vitest";

import {
  connectPostHogContract,
  createPostHogApiClient,
  createPostHogBrowserHandoffPlanner,
  createPostHogLiveDependencies,
  detectPostHogContract,
  setupPostHogContract,
  syncPostHogContract,
  type PostHogDependencies,
  type PostHogNeedsHumanReason,
  type PostHogTransport
} from "./posthog.js";

describe("PostHog provider contract", () => {
  it("calls the official app-host API endpoints and maps project install artifacts", async () => {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const transport: PostHogTransport = async (url, init) => {
      calls.push({ url, init: init as Record<string, unknown> | undefined });
      if (url.endsWith("/api/organizations/")) {
        return jsonResponse(200, {
          results: [{ id: "org_1", name: "Acme Org" }]
        });
      }
      if (url.endsWith("/api/organizations/org_1/projects/") && init?.method !== "POST") {
        return jsonResponse(200, {
          results: [
            {
              id: 42,
              name: "Acme Project",
              api_token: "phc_abc123",
              completed_snippet_onboarding: true,
              ingested_event: true
            }
          ]
        });
      }
      if (url.endsWith("/api/organizations/org_1/projects/") && init?.method === "POST") {
        return jsonResponse(201, {
          id: 84,
          api_token: "phc_newproject"
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    };

    const client = createPostHogApiClient({ transport });
    const session = {
      refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
      apiHost: "https://us.posthog.com",
      publicApiHost: "https://us.i.posthog.com",
      accessToken: "oauth-secret-token"
    };

    const organizations = await client.listOrganizations(session);
    const projects = await client.listProjects(session, "org_1");
    const created = await client.createProject(session, { orgId: "org_1", name: "Acme" });

    expect(organizations).toEqual([{ orgId: "org_1", name: "Acme Org" }]);
    expect(projects).toEqual([
      {
        projectId: "42",
        name: "Acme Project",
        projectKey: "phc_abc123",
        apiHost: "https://us.i.posthog.com",
        completedSnippetOnboarding: true,
        ingestedEvent: true
      }
    ]);
    expect(created).toEqual({
      projectId: "84",
      projectKey: "phc_newproject",
      apiHost: "https://us.i.posthog.com"
    });
    expect(calls).toEqual([
      {
        url: "https://us.posthog.com/api/organizations/",
        init: {
          headers: {
            Authorization: "Bearer oauth-secret-token"
          },
          method: "GET"
        }
      },
      {
        url: "https://us.posthog.com/api/organizations/org_1/projects/",
        init: {
          headers: {
            Authorization: "Bearer oauth-secret-token"
          },
          method: "GET"
        }
      },
      {
        url: "https://us.posthog.com/api/organizations/org_1/projects/",
        init: {
          body: JSON.stringify({ name: "Acme" }),
          headers: {
            Authorization: "Bearer oauth-secret-token",
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      }
    ]);
  });

  it("creates a personal API key through the authenticated session and returns its one-time value", async () => {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const transport: PostHogTransport = async (url, init) => {
      calls.push({ url, init: init as Record<string, unknown> | undefined });
      if (url.endsWith("/api/personal_api_keys/") && init?.method === "POST") {
        return jsonResponse(201, {
          id: "key_1",
          label: "Infinite",
          value: "phx_created_secret"
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    };

    const client = createPostHogApiClient({ transport });
    const value = await client.createPersonalApiKey({
      refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
      apiHost: "https://us.posthog.com",
      accessToken: "oauth-secret-token"
    });

    expect(value).toBe("phx_created_secret");
    expect(calls).toEqual([
      {
        url: "https://us.posthog.com/api/personal_api_keys/",
        init: {
          body: JSON.stringify({ label: "Infinite", scopes: ["*"] }),
          headers: {
            Authorization: "Bearer oauth-secret-token",
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      }
    ]);
  });

  it("fails personal API key creation when PostHog omits the one-time value", async () => {
    const client = createPostHogApiClient({
      transport: async () => jsonResponse(201, { id: "key_1", label: "Infinite" })
    });

    await expect(
      client.createPersonalApiKey({
        apiHost: "https://us.posthog.com",
        accessToken: "oauth-secret-token"
      })
    ).rejects.toThrow("Missing PostHog field: personal_api_key.value");
  });

  it("rejects a created personal API key value that is not a phx_ secret", async () => {
    const client = createPostHogApiClient({
      transport: async () => jsonResponse(201, { id: "key_1", value: "phc_public_project_key" })
    });

    await expect(
      client.createPersonalApiKey({
        apiHost: "https://us.posthog.com",
        accessToken: "oauth-secret-token"
      })
    ).rejects.toThrow("PostHog returned a personal API key value that does not start with phx_");
  });

  it("surfaces plain-text 401 failures with wrong-key and region guidance while redacting secrets", async () => {
    const client = createPostHogApiClient({
      transport: async () => textResponse(
        401,
        "Unauthorized for this region. Authorization: Bearer oauth-secret-token. Key: phx_secret_to_redact"
      )
    });

    await expect(
      client.listOrganizations({
        apiHost: "https://eu.posthog.com",
        personalApiKey: "phx_secret_to_redact"
      })
    ).rejects.toThrow(
      "PostHog API request failed (401 GET https://eu.posthog.com/api/organizations/): Unauthorized for this region. Authorization: Bearer [redacted]. Key: phx_[redacted] Hint: Check that the value is a PostHog personal API key starting with phx_, not a project key starting with phc_, and that the PostHog host matches the workspace region, for example https://eu.posthog.com or https://us.posthog.com."
    );
  });

  it("surfaces 403 scope failures with a resumable permission hint while redacting secrets", async () => {
    const client = createPostHogApiClient({
      transport: async () => jsonResponse(403, {
        type: "authentication_error",
        code: "permission_denied",
        detail: "Missing scope project:read",
        authorization: "Bearer oauth-secret-token",
        key: "phx_secret_to_redact"
      })
    });

    await expect(
      client.listProjects(
        {
          apiHost: "https://us.posthog.com",
          accessToken: "oauth-secret-token"
        },
        "org_1"
      )
    ).rejects.toThrow(
      'PostHog API request failed (403 GET https://us.posthog.com/api/organizations/org_1/projects/): {"type":"authentication_error","code":"permission_denied","detail":"Missing scope project:read","authorization":"Bearer [redacted]","key":"phx_[redacted]"} Hint: Create a personal API key with organization/project read access, or all organization/project access, then resume setup again.'
    );
  });

  it("preserves non-JSON PostHog failure bodies so the operator sees the upstream cause", async () => {
    const client = createPostHogApiClient({
      transport: async () => textResponse(502, "proxy upstream timed out while reaching PostHog")
    });

    await expect(
      client.listOrganizations({
        apiHost: "https://us.posthog.com",
        accessToken: "oauth-secret-token"
      })
    ).rejects.toThrow(
      "PostHog API request failed (502 GET https://us.posthog.com/api/organizations/): proxy upstream timed out while reaching PostHog"
    );
  });

  it("rejects browser-authenticated requests to non-PostHog origins", async () => {
    const transport = vi.fn<PostHogTransport>(async () => {
      throw new Error("browser transport should not be called for rejected origins");
    });
    const client = createPostHogApiClient();

    for (const apiHost of ["https://evilposthog.com", "https://notposthog.com"]) {
      await expect(
        client.listOrganizations({
          apiHost,
          browser: {
            profileRef: "posthog-signup",
            sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup"
          },
          transport
        })
      ).rejects.toThrow("official PostHog origins");
    }

    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects browser-authenticated requests to official PostHog hosts over http", async () => {
    const transport = vi.fn<PostHogTransport>(async () => {
      throw new Error("browser transport should not be called for rejected origins");
    });
    const client = createPostHogApiClient();

    await expect(
      client.listOrganizations({
        apiHost: "http://us.posthog.com",
        browser: {
          profileRef: "posthog-signup",
          sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup"
        },
        transport
      })
    ).rejects.toThrow("official PostHog origins");

    expect(transport).not.toHaveBeenCalled();
  });

  it("detects an existing org/project/install state, prefers OAuth, and keeps secrets out of public artifacts", async () => {
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "oauth",
            session: {
              refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
              apiHost: "https://us.posthog.com",
              publicApiHost: "https://us.i.posthog.com",
              accessToken: "oauth-secret-token",
              projectIdHint: "42"
            }
          };
        }
      },
      api: {
        async listOrganizations() {
          return [{ orgId: "org_1", name: "Acme Org" }];
        },
        async listProjects() {
          return [
            {
              projectId: "42",
              name: "Acme Project",
              projectKey: "phc_abc123",
              apiHost: "https://us.i.posthog.com",
              completedSnippetOnboarding: true,
              ingestedEvent: true
            }
          ];
        },
        async createProject() {
          throw new Error("unused");
        }
      }
    });

    const outcome = await detectPostHogContract(deps, { projectName: "Acme" });

    expect(outcome.result.status).toBe("ok");
    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: true,
      assetId: "42",
      installId: "phc_abc123",
      tagInstalled: true,
      tagFiring: true
    });
    expect(outcome.state.assets).toMatchObject({
      organizationId: "org_1",
      installState: "installed",
      authKind: "oauth"
    });
    expect(outcome.publicArtifacts).toEqual({
      projectId: "42",
      projectKey: "phc_abc123",
      apiHost: "https://us.i.posthog.com"
    });
    expect(outcome.secretRefs).toEqual({
      oauthAppId: "oauth_app_1",
      oauthTokenId: "oauth_tok_1"
    });
    expect(outcome.connectSourceInput).toEqual({
      provider: "posthog",
      connectionName: "PostHog",
      credentialKind: "oauth_access_token",
      accountExternalId: "42",
      credentialPayload: {
        mode: "live",
        projectId: "42",
        accessToken: "oauth-secret-token",
        apiHost: "https://us.posthog.com"
      }
    });
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("oauth-secret-token");
  });

  it("preserves organization lookup API failures without leaking personal keys", async () => {
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "credential",
            session: {
              apiHost: "https://eu.posthog.com",
              personalApiKey: "phx_secret_to_redact"
            }
          };
        }
      },
      api: {
        async listOrganizations() {
          throw new Error("PostHog API request failed (403): {\"detail\":\"Missing scope organization:read\",\"authorization\":\"Bearer oauth-secret-token\",\"key\":\"phx_secret_to_redact\"}");
        },
        async listProjects() {
          throw new Error("unused");
        },
        async createProject() {
          throw new Error("unused");
        }
      }
    });

    await expect(detectPostHogContract(deps, { projectName: "Acme" })).rejects.toThrow(
      "PostHog access discovery failed before organization lookup: PostHog API request failed (403): {\"detail\":\"Missing scope organization:read\",\"authorization\":\"Bearer [redacted]\",\"key\":\"phx_[redacted]\"}"
    );
  });

  it("preserves project lookup API failures without leaking personal keys", async () => {
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "credential",
            session: {
              apiHost: "https://eu.posthog.com",
              personalApiKey: "phx_secret_to_redact"
            }
          };
        }
      },
      api: {
        async listOrganizations() {
          return [{ orgId: "org_1", name: "Acme Org" }];
        },
        async listProjects() {
          throw new Error("PostHog API request failed (403): {\"detail\":\"Missing scope project:read\",\"key\":\"phx_secret_to_redact\"}");
        },
        async createProject() {
          throw new Error("unused");
        }
      }
    });

    await expect(detectPostHogContract(deps, { projectName: "Acme" })).rejects.toThrow(
      "PostHog access discovery failed before project lookup: PostHog API request failed (403): {\"detail\":\"Missing scope project:read\",\"key\":\"phx_[redacted]\"}"
    );
  });

  it("creates a project through the API when org access exists without a project", async () => {
    const createProject = vi.fn(async () => ({
      projectId: "84",
      projectKey: "phc_newproject",
      apiHost: "https://eu.i.posthog.com"
    }));
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "credential",
            session: {
              refs: { connectionCredentialId: "cred_1" },
              apiHost: "https://eu.posthog.com",
              publicApiHost: "https://eu.i.posthog.com",
              personalApiKey: "phx_personal_secret"
            }
          };
        }
      },
      api: {
        async listOrganizations() {
          return [{ orgId: "org_1", name: "Acme Org" }];
        },
        async listProjects() {
          return [];
        },
        createProject
      }
    });

    const detected = await detectPostHogContract(deps, { projectName: "Acme" });
    const outcome = await setupPostHogContract(deps, detected, { projectName: "Acme" });

    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: { connectionCredentialId: "cred_1" },
        apiHost: "https://eu.posthog.com",
        publicApiHost: "https://eu.i.posthog.com"
      }),
      {
        orgId: "org_1",
        name: "Acme"
      }
    );
    expect(outcome.result.status).toBe("ok");
    expect(outcome.publicArtifacts).toEqual({
      projectId: "84",
      projectKey: "phc_newproject",
      apiHost: "https://eu.i.posthog.com"
    });
    expect(outcome.secretRefs).toEqual({ connectionCredentialId: "cred_1" });
    expect(outcome.connectSourceInput).toEqual({
      provider: "posthog",
      connectionName: "PostHog",
      credentialKind: "personal_api_key",
      accountExternalId: "84",
      credentialPayload: {
        mode: "live",
        projectId: "84",
        personalApiKey: "phx_personal_secret",
        apiHost: "https://eu.posthog.com"
      }
    });
  });

  it("uses an authenticated browser session to discover an existing project without exposing reusable credentials", async () => {
    const transport = vi.fn<PostHogTransport>(async (url, init) => {
      if (url.endsWith("/api/organizations/")) {
        return jsonResponse(200, {
          results: [{ id: "org_browser", name: "Browser Org" }]
        });
      }
      if (url.endsWith("/api/organizations/org_browser/projects/")) {
        return jsonResponse(200, {
          results: [
            {
              id: "project_browser",
              name: "Acme",
              api_token: "phc_browser_project",
              completed_snippet_onboarding: false,
              ingested_event: false
            }
          ]
        });
      }
      throw new Error(`Unexpected browser-authenticated request: ${init?.method ?? "GET"} ${url}`);
    });

    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "browser",
            session: {
              apiHost: "https://eu.posthog.com",
              publicApiHost: "https://eu.i.posthog.com",
              browser: {
                profileRef: "posthog-signup",
                sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup",
                lastUrl: "https://eu.posthog.com/project/project_browser"
              },
              transport
            }
          };
        }
      },
      api: createPostHogApiClient()
    });

    const detected = await detectPostHogContract(deps, { projectName: "Acme" });
    const outcome = await setupPostHogContract(deps, detected, { projectName: "Acme" });

    expect(detected.state).toMatchObject({
      accountExists: true,
      assetExists: true,
      assetId: "project_browser",
      installId: "phc_browser_project"
    });
    expect(detected.state.assets).toMatchObject({
      organizationId: "org_browser",
      installState: "not_installed",
      authKind: "browser"
    });
    expect(detected.publicArtifacts).toEqual({
      projectId: "project_browser",
      projectKey: "phc_browser_project",
      apiHost: "https://eu.i.posthog.com"
    });
    expect(detected.secretRefs).toBeUndefined();
    expect(detected.connectSourceInput).toBeUndefined();
    expect(detected.result.status).toBe("needs_human");
    expect(detected.result.handoff).toEqual({
      kind: "open_url",
      url: "https://eu.posthog.com/settings/user-api-keys",
      instructions:
        "Create a scoped PostHog personal API key for this project. Infinite still cannot read the key from the browser, so resume setup and paste/import it through the encrypted credential flow."
    });
    expect(detected.result.data).toEqual({
      reason: "posthog_manual_key",
      resume: {
        profileRef: "posthog-signup",
        sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup",
        lastKnownUrl: "https://eu.posthog.com/project/project_browser",
        status: "pending_auth",
        phase: "credential_setup",
        step: "posthog_manual_key"
      }
    });
    expect(outcome).toEqual(detected);
    expect(JSON.stringify(outcome)).not.toContain("Bearer");
  });

  it("creates the PostHog project via an authenticated browser session before handing off for manual key import", async () => {
    const createProject = vi.fn(async () => ({
      projectId: "created_browser_project",
      projectKey: "phc_created_browser_project",
      apiHost: "https://us.i.posthog.com"
    }));

    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "browser",
            session: {
              apiHost: "https://us.posthog.com",
              publicApiHost: "https://us.i.posthog.com",
              browser: {
                profileRef: "posthog-signup",
                sessionKey: "scope=workspace%3Aws_1|provider=posthog|context=posthog-signup",
                lastUrl: "https://us.posthog.com/organization/org_browser"
              },
              transport: async (url, init) => {
                if (url.endsWith("/api/organizations/")) {
                  return jsonResponse(200, {
                    results: [{ id: "org_browser", name: "Browser Org" }]
                  });
                }
                if (url.endsWith("/api/organizations/org_browser/projects/") && init?.method !== "POST") {
                  return jsonResponse(200, { results: [] });
                }
                throw new Error(`Unexpected browser transport call: ${init?.method ?? "GET"} ${url}`);
              }
            }
          };
        }
      },
      api: {
        listOrganizations: async (session) => createPostHogApiClient().listOrganizations(session),
        listProjects: async (session, orgId) => createPostHogApiClient().listProjects(session, orgId),
        createProject
      }
    });

    const detected = await detectPostHogContract(deps, { projectName: "Acme" });
    const outcome = await setupPostHogContract(deps, detected, { projectName: "Acme" });

    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "browser",
        browser: expect.objectContaining({
          profileRef: "posthog-signup"
        })
      }),
      {
        orgId: "org_browser",
        name: "Acme"
      }
    );
    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.publicArtifacts).toEqual({
      projectId: "created_browser_project",
      projectKey: "phc_created_browser_project",
      apiHost: "https://us.i.posthog.com"
    });
    expect(outcome.connectSourceInput).toBeUndefined();
    expect(outcome.secretRefs).toBeUndefined();
  });

  it.each([
    {
      reason: "posthog_manual_key",
      handoffUrl: "https://us.posthog.com/settings/user-api-keys",
      instructions: "Create a scoped personal API key, copy it once, then resume setup."
    },
    {
      reason: "posthog_email_verification",
      handoffUrl: "https://us.posthog.com/verify",
      instructions: "Verify the PostHog account email, then resume setup."
    },
    {
      reason: "posthog_sso",
      handoffUrl: "https://us.posthog.com/login",
      instructions: "Complete the SSO login flow in PostHog, then resume setup."
    },
    {
      reason: "posthog_2fa",
      handoffUrl: "https://us.posthog.com/login",
      instructions: "Complete the 2FA challenge in PostHog, then resume setup."
    }
  ] as const satisfies ReadonlyArray<{
    reason: PostHogNeedsHumanReason;
    handoffUrl: string;
    instructions: string;
  }>)("models $reason as a resumable needs_human handoff", async ({ reason, handoffUrl, instructions }) => {
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "needs_human",
            reason,
            handoffUrl,
            instructions
          };
        }
      },
      api: unusedPostHogApi(),
      handoff: createPostHogBrowserHandoffPlanner({
        async load() {
          return {
            profileRef: "posthog-founder-1",
            resumeNonce: "nonce-123",
            lastUrl: "https://us.posthog.com/login"
          };
        }
      })
    });

    const outcome = await detectPostHogContract(deps, { projectName: "Acme" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.handoff).toEqual({
      kind: "open_url",
      url: handoffUrl,
      instructions
    });
    expect(outcome.result.data).toEqual({
      reason,
      resume: {
        profileRef: "posthog-founder-1",
        resumeNonce: "nonce-123",
        lastKnownUrl: "https://us.posthog.com/login",
        status: reason === "posthog_manual_key" ? "pending_auth" : "pending_account_setup",
        phase: reason === "posthog_manual_key" ? "credential_setup" : "account_setup",
        step: reason
      }
    });
    expect(outcome.browser).toEqual({
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123",
      handoffUrl
    });
  });

  it("returns needs_human with resumable browser metadata when no organization exists yet", async () => {
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "oauth",
            session: {
              refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
              apiHost: "https://us.posthog.com",
              publicApiHost: "https://us.i.posthog.com"
            }
          };
        }
      },
      api: {
        async listOrganizations() {
          return [];
        },
        async listProjects() {
          return [];
        },
        async createProject() {
          throw new Error("unused");
        }
      },
      handoff: createPostHogBrowserHandoffPlanner({
        profileRef: "posthog-founder-setup",
        createResumeNonce() {
          return "nonce-456";
        }
      })
    });

    const detected = await detectPostHogContract(deps, { projectName: "Acme" });
    const outcome = await setupPostHogContract(deps, detected, { projectName: "Acme" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail).toContain("organization");
    expect(outcome.result.data).toEqual({
      reason: "posthog_signup",
      resume: {
        profileRef: "posthog-founder-setup",
        resumeNonce: "nonce-456",
        status: "pending_account_setup",
        phase: "account_setup",
        step: "posthog_signup"
      }
    });
    expect(outcome.browser).toEqual({
      profileRef: "posthog-founder-setup",
      resumeNonce: "nonce-456",
      handoffUrl: "https://us.posthog.com/signup"
    });
  });

  it("maps setup access into connect_source and sync requests for existing action paths", async () => {
    const executed: Array<{ id: string; input: unknown }> = [];
    const deps = createPostHogLiveDependencies({
      access: {
        async resolve() {
          return {
            kind: "oauth",
            session: {
              refs: { oauthAppId: "oauth_app_1", oauthTokenId: "oauth_tok_1" },
              apiHost: "https://us.posthog.com",
              publicApiHost: "https://us.i.posthog.com",
              accessToken: "oauth-secret-token"
            }
          };
        }
      },
      api: {
        async listOrganizations() {
          return [{ orgId: "org_1", name: "Acme Org" }];
        },
        async listProjects() {
          return [
            {
              projectId: "42",
              name: "Acme",
              projectKey: "phc_abc123",
              apiHost: "https://us.i.posthog.com"
            }
          ];
        },
        async createProject() {
          throw new Error("unused");
        }
      }
    });

    const detected = await detectPostHogContract(deps, { projectName: "Acme" });
    const connected = await connectPostHogContract(
      {
        workspaceId: "ws1",
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
                      accountExternalId: "42"
                    }
                  }
                : { job: { id: "job_posthog_sync" } },
              provenance: [id === "connect_source" ? "sources" : "job_runs"],
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
    const synced = await syncPostHogContract(
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
              data: { job: { id: "job_posthog_sync" } },
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
          provider: "posthog",
          connectionName: "PostHog",
          credentialKind: "oauth_access_token",
          accountExternalId: "42",
          credentialPayload: {
            mode: "live",
            projectId: "42",
            accessToken: "oauth-secret-token",
            apiHost: "https://us.posthog.com"
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
    expect(connected.state).toMatchObject({
      sourceId: "src_posthog",
      credentialValid: true
    });
    expect(connected.verification).toMatchObject({
      installStatus: "pending",
      queryabilityStatus: "verified"
    });
    expect(synced.result.data).toEqual({
      jobId: "job_posthog_sync",
      mode: "incremental",
      refreshWindowDays: 7
    });
    expect(JSON.stringify(detected.publicArtifacts)).not.toContain("oauth-secret-token");
  });
});

function unusedPostHogApi(): Pick<PostHogDependencies, "listOrganizations" | "listProjects" | "createProject"> {
  return {
    async listOrganizations() {
      throw new Error("unused");
    },
    async listProjects() {
      throw new Error("unused");
    },
    async createProject() {
      throw new Error("unused");
    }
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

function textResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body) as unknown;
    },
    async text() {
      return body;
    }
  };
}
