import { describe, expect, it, vi } from "vitest";

import {
  connectXContract,
  createXLiveDependencies,
  detectXContract,
  setupXContract,
  syncXContract,
  type XDependencies
} from "./x.js";

describe("X provider contract", () => {
  it("mints a bearer token from stored API credentials, resolves the X user, and keeps secrets out of public artifacts", async () => {
    const saveCredential = vi.fn(async () => undefined);
    const deps = createXLiveDependencies({
      credentials: {
        async load() {
          return {
            refs: { connectionCredentialId: "cred_1" },
            apiKey: "x-api-key-secret",
            apiSecret: "x-api-secret-secret",
            username: "@acme"
          };
        },
        save: saveCredential
      },
      developerApi: {
        async mintBearerToken({ apiKey, apiSecret }) {
          expect(apiKey).toBe("x-api-key-secret");
          expect(apiSecret).toBe("x-api-secret-secret");
          return { kind: "ok", bearerToken: "x-bearer-secret" };
        }
      },
      users: {
        async lookupByUsername({ bearerToken, username }) {
          expect(bearerToken).toBe("x-bearer-secret");
          expect(username).toBe("acme");
          return {
            kind: "resolved",
            user: { userId: "99", username: "acme" }
          };
        },
        async lookupById() {
          throw new Error("unused");
        }
      },
      ads: {
        async detectState() {
          return {
            adsAccountId: "ads_123",
            hasAdsAccount: true,
            paymentCardAdded: true,
            pixelId: "o1234",
            eventTagIds: { page_view: "tw-1234-1", signup: "tw-1234-2" }
          };
        }
      }
    });

    const outcome = await detectXContract(deps, { websiteUrl: "https://acme.test" });

    expect(saveCredential).toHaveBeenCalledWith({
      refs: { connectionCredentialId: "cred_1" },
      apiKey: "x-api-key-secret",
      apiSecret: "x-api-secret-secret",
      bearerToken: "x-bearer-secret",
      username: "acme",
      userId: "99"
    });
    expect(outcome.result.status).toBe("ok");
    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: true,
      assetId: "o1234",
      installId: "o1234"
    });
    expect(outcome.state.assets).toMatchObject({
      userId: "99",
      username: "acme",
      adsAccountId: "ads_123",
      paymentCardAdded: true
    });
    expect(outcome.publicArtifacts).toEqual({
      pixelId: "o1234",
      eventTagIds: { page_view: "tw-1234-1", signup: "tw-1234-2" },
      adsAccountId: "ads_123"
    });
    expect(outcome.secretRefs).toEqual({ connectionCredentialId: "cred_1" });
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("x-api-key-secret");
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("x-api-secret-secret");
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("x-bearer-secret");
  });

  it("returns needs_human with browser resume metadata when the developer app or API credentials are missing", async () => {
    const deps = createXLiveDependencies({
      credentials: {
        async load() {
          return null;
        }
      },
      developerApi: {
        async mintBearerToken() {
          throw new Error("unused");
        }
      },
      users: {
        async lookupByUsername() {
          throw new Error("unused");
        },
        async lookupById() {
          throw new Error("unused");
        }
      },
      handoff: {
        async forStage(stage) {
          expect(stage).toBe("developer_portal");
          return {
            profileRef: "x-dev-setup",
            resumeNonce: "resume-dev-1",
            handoffUrl: "https://developer.x.com/"
          };
        }
      }
    });

    const outcome = await detectXContract(deps, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail).toContain("developer");
    expect(outcome.result.detail).toContain("API key");
    expect(outcome.browser).toEqual({
      profileRef: "x-dev-setup",
      resumeNonce: "resume-dev-1",
      handoffUrl: "https://developer.x.com/"
    });
  });

  it("returns needs_human with payment-card browser handoff before Events Manager can be used", async () => {
    const deps = createXLiveDependencies({
      credentials: {
        async load() {
          return {
            refs: { connectionCredentialId: "cred_1" },
            bearerToken: "x-bearer-secret",
            username: "acme",
            userId: "99"
          };
        }
      },
      developerApi: {
        async mintBearerToken() {
          throw new Error("unused");
        }
      },
      users: {
        async lookupByUsername() {
          return {
            kind: "resolved",
            user: { userId: "99", username: "acme" }
          };
        },
        async lookupById() {
          throw new Error("unused");
        }
      },
      ads: {
        async detectState() {
          return {
            hasAdsAccount: true,
            adsAccountId: "ads_123",
            paymentCardAdded: false
          };
        }
      },
      handoff: {
        async forStage(stage) {
          expect(stage).toBe("payment_card");
          return {
            profileRef: "x-ads-payment",
            resumeNonce: "resume-ads-1",
            handoffUrl: "https://ads.x.com/"
          };
        }
      }
    });

    const detected = await detectXContract(deps, { websiteUrl: "https://acme.test" });
    const outcome = await setupXContract(deps, detected, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail.toLowerCase()).toContain("payment");
    expect(outcome.result.detail.toLowerCase()).toContain("card");
    expect(outcome.publicArtifacts).toEqual({ pixelId: null, eventTagIds: null, adsAccountId: "ads_123" });
    expect(outcome.browser).toEqual({
      profileRef: "x-ads-payment",
      resumeNonce: "resume-ads-1",
      handoffUrl: "https://ads.x.com/"
    });
  });

  it("returns needs_human with pixel-creation browser handoff when the ads account is ready but pixel artifacts are still missing", async () => {
    const deps = createXLiveDependencies({
      credentials: {
        async load() {
          return {
            refs: { connectionCredentialId: "cred_1" },
            bearerToken: "x-bearer-secret",
            username: "acme",
            userId: "99"
          };
        }
      },
      developerApi: {
        async mintBearerToken() {
          throw new Error("unused");
        }
      },
      users: {
        async lookupByUsername() {
          return {
            kind: "resolved",
            user: { userId: "99", username: "acme" }
          };
        },
        async lookupById() {
          throw new Error("unused");
        }
      },
      ads: {
        async detectState() {
          return {
            hasAdsAccount: true,
            adsAccountId: "ads_123",
            paymentCardAdded: true
          };
        }
      },
      handoff: {
        async forStage(stage) {
          expect(stage).toBe("pixel_setup");
          return {
            profileRef: "x-events-manager",
            resumeNonce: "resume-pixel-1",
            handoffUrl: "https://ads.x.com/conversion_events/ads_123/events_manager"
          };
        }
      }
    });

    const detected = await detectXContract(deps, { websiteUrl: "https://acme.test" });
    const outcome = await setupXContract(deps, detected, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail.toLowerCase()).toContain("pixel");
    expect(outcome.browser).toEqual({
      profileRef: "x-events-manager",
      resumeNonce: "resume-pixel-1",
      handoffUrl: "https://ads.x.com/conversion_events/ads_123/events_manager"
    });
  });

  it("separates developer auth from pixel artifacts and keeps bearer secrets out of public artifacts", async () => {
    const deps: XDependencies = {
      async authorizeDeveloperAccess() {
        return {
          kind: "available",
          session: {
            refs: { connectionCredentialId: "cred_1" },
            bearerToken: "x-bearer-secret",
            username: "acme",
            userId: "99"
          }
        };
      },
      async resolveUser() {
        return { userId: "99", username: "acme" };
      },
      async detectAdsContext() {
        return {
          hasAdsAccount: true,
          billingEnabled: true,
          paymentCardAdded: true,
          adsAccountId: "ads_123"
        };
      },
      async detectPixel() {
        return {
          pixelId: "o1234",
          eventTagIds: { page_view: "tw-1234-1", signup: "tw-1234-2" }
        };
      }
    };

    const outcome = await detectXContract(deps, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("ok");
    expect(outcome.state).toMatchObject({
      accountExists: true,
      assetExists: true,
      assetId: "o1234",
      installId: "o1234"
    });
    expect(outcome.state.assets).toMatchObject({
      userId: "99",
      username: "acme",
      adsAccountId: "ads_123",
      billingEnabled: true
    });
    expect(outcome.publicArtifacts).toEqual({
      pixelId: "o1234",
      eventTagIds: { page_view: "tw-1234-1", signup: "tw-1234-2" },
      adsAccountId: "ads_123"
    });
    expect(outcome.secretRefs).toEqual({ connectionCredentialId: "cred_1" });
    expect(JSON.stringify(outcome.publicArtifacts)).not.toContain("x-bearer-secret");
  });

  it("returns needs_human when developer app access still needs a human handoff", async () => {
    const deps: XDependencies = {
      async authorizeDeveloperAccess() {
        return {
          kind: "needs_human",
          reason: "missing_developer_app",
          handoffUrl: "https://developer.x.com/",
          instructions: "Create an X developer app and enable billing before resuming."
        };
      },
      async resolveUser() {
        throw new Error("unused");
      },
      async detectAdsContext() {
        return null;
      },
      async detectPixel() {
        return null;
      }
    };

    const outcome = await detectXContract(deps, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.handoff).toEqual({
      kind: "open_url",
      url: "https://developer.x.com/",
      instructions: "Create an X developer app and enable billing before resuming."
    });
  });

  it.each([
    {
      name: "billing is missing",
      ads: {
        hasAdsAccount: true,
        billingEnabled: false,
        paymentCardAdded: false,
        adsAccountId: "ads_123"
      },
      expected: "card"
    },
    {
      name: "an ads account is missing",
      ads: { hasAdsAccount: false, billingEnabled: false },
      expected: "ads account"
    },
    {
      name: "the pixel still needs to be created",
      ads: { hasAdsAccount: true, billingEnabled: true, adsAccountId: "ads_123" },
      expected: "pixel"
    }
  ])("returns needs_human when $name", async ({ ads, expected }) => {
    const deps: XDependencies = {
      async authorizeDeveloperAccess() {
        return {
          kind: "available",
          session: {
            refs: { connectionCredentialId: "cred_1" },
            bearerToken: "x-bearer-secret",
            username: "acme",
            userId: "99"
          }
        };
      },
      async resolveUser() {
        return { userId: "99", username: "acme" };
      },
      async detectAdsContext() {
        return ads;
      },
      async detectPixel() {
        return null;
      }
    };

    const detected = await detectXContract(deps, { websiteUrl: "https://acme.test" });
    const outcome = await setupXContract(deps, detected, { websiteUrl: "https://acme.test" });

    expect(outcome.result.status).toBe("needs_human");
    expect(outcome.result.detail.toLowerCase()).toContain(expected);
  });

  it("maps setup auth into connect_source and leaves background sync conditional for X", async () => {
    const executed: Array<{ id: string; input: unknown }> = [];
    const deps: XDependencies = {
      async authorizeDeveloperAccess() {
        return {
          kind: "available",
          session: {
            refs: { connectionCredentialId: "cred_1" },
            bearerToken: "x-bearer-secret",
            username: "acme",
            userId: "99"
          }
        };
      },
      async resolveUser() {
        return { userId: "99", username: "acme" };
      },
      async detectAdsContext() {
        return {
          hasAdsAccount: true,
          billingEnabled: true,
          paymentCardAdded: true,
          adsAccountId: "ads_123"
        };
      },
      async detectPixel() {
        return { pixelId: "o1234" };
      }
    };

    const detected = await detectXContract(deps, { websiteUrl: "https://acme.test" });
    const connected = await connectXContract(
      {
        workspaceId: "ws1",
        actions: {
          async execute(id, input) {
            executed.push({ id, input });
            return {
              ok: true,
              actionId: "connect_source",
              authority: "operator",
              status: "queued",
              data: {
                source: { id: "src_x", provider: "x" },
                connectionTest: {
                  ok: true,
                  mode: "live",
                  provider: "x",
                  accountExternalId: "99"
                },
                initialSync: {
                  queued: true,
                  sourceId: "src_x",
                  mode: "incremental"
                }
              },
              provenance: ["sources"],
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
    const synced = await syncXContract(
      {
        workspaceId: "ws1",
        actions: {
          async execute() {
            throw new Error("sync should stay conditional for X");
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
          provider: "x",
          connectionName: "X",
          credentialKind: "bearer_token",
          accountExternalId: "99",
          credentialPayload: {
            mode: "live",
            bearerToken: "x-bearer-secret",
            userId: "99",
            username: "acme"
          }
        }
      }
    ]);
    expect(connected.result.data).toMatchObject({
      sourceId: "src_x",
      initialSync: {
        queued: true,
        sourceId: "src_x",
        mode: "incremental"
      }
    });
    expect(connected.verification).toMatchObject({
      queryabilityStatus: "verified"
    });
    expect(synced.result).toMatchObject({
      status: "skipped"
    });
    expect(JSON.stringify(detected.publicArtifacts)).not.toContain("x-bearer-secret");
  });
});
