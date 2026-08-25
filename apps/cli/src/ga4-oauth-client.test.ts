import { describe, expect, it } from "vitest";
import { resolveEmbeddedGa4OAuthClient } from "./ga4-oauth-client.js";

describe("resolveEmbeddedGa4OAuthClient", () => {
  it("prefers explicit env override", () => {
    const got = resolveEmbeddedGa4OAuthClient({
      env: { GROWTH_OS_GA4_OAUTH_CLIENT_ID: "env-id", GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "env-secret" },
      readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
    });
    expect(got).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
  });

  it("falls back to release-injected config", () => {
    const got = resolveEmbeddedGa4OAuthClient({
      env: {},
      readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
    });
    expect(got).toEqual({ clientId: "rel-id", clientSecret: "rel-secret" });
  });

  it("returns null when neither present (self-hoster prompt fallback)", () => {
    const got = resolveEmbeddedGa4OAuthClient({ env: {}, readReleaseConfig: () => null });
    expect(got).toBeNull();
  });

  it("ignores a partial env override (id without secret)", () => {
    const got = resolveEmbeddedGa4OAuthClient({
      env: { GROWTH_OS_GA4_OAUTH_CLIENT_ID: "env-id" },
      readReleaseConfig: () => null
    });
    expect(got).toBeNull();
  });
});
