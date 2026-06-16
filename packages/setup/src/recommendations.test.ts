import { describe, expect, it } from "vitest";

type RecommendationsModule = typeof import("./recommendations.js");

async function loadRecommendationsModule(): Promise<RecommendationsModule | null> {
  try {
    return await import("./recommendations.js");
  } catch {
    return null;
  }
}

describe("setup recommendations", () => {
  it("recommends GA4 and PostHog for web by default while deferring non-v1 providers", async () => {
    const mod = await loadRecommendationsModule();
    expect(mod, "recommendations module should exist").not.toBeNull();
    if (!mod) return;

    const recommendations = mod.buildSetupRecommendations({ productSurface: "web" });

    expect(recommendations).toMatchObject([
      {
        provider: "ga4",
        status: "recommended",
        track: "v1",
        reasonCode: "web_default",
        orchestration: "queue_now"
      },
      {
        provider: "posthog",
        status: "recommended",
        track: "v1",
        reasonCode: "web_default",
        orchestration: "queue_now"
      },
      {
        provider: "x",
        status: "deferred",
        track: "v1",
        reasonCode: "developer_billing_friction",
        orchestration: "defer"
      },
      {
        provider: "meta",
        status: "deferred",
        track: "v2",
        reasonCode: "not_in_v1_scope",
        orchestration: "defer"
      },
      {
        provider: "stripe",
        status: "deferred",
        track: "v2",
        reasonCode: "not_in_v1_scope",
        orchestration: "defer"
      },
      {
        provider: "linkedin",
        status: "deferred",
        track: "v2",
        reasonCode: "not_in_v1_scope",
        orchestration: "defer"
      },
      {
        provider: "tiktok",
        status: "deferred",
        track: "v2",
        reasonCode: "not_in_v1_scope",
        orchestration: "defer"
      }
    ]);
    expect(mod.selectRecommendedV1Providers(recommendations)).toEqual(["ga4", "posthog"]);
  });

  it("promotes X when the founder explicitly asks for it", async () => {
    const mod = await loadRecommendationsModule();
    expect(mod, "recommendations module should exist").not.toBeNull();
    if (!mod) return;

    const recommendations = mod.buildSetupRecommendations({
      productSurface: "web",
      founderRequestedProviders: ["x"]
    });

    expect(recommendations.find((item) => item.provider === "x")).toMatchObject({
      provider: "x",
      status: "recommended",
      track: "v1",
      reasonCode: "explicit_founder_request",
      orchestration: "queue_now"
    });
    expect(mod.selectRecommendedV1Providers(recommendations)).toEqual(["ga4", "posthog", "x"]);
  });

  it("keeps already-present X setups in the active queue even without a fresh request", async () => {
    const mod = await loadRecommendationsModule();
    expect(mod, "recommendations module should exist").not.toBeNull();
    if (!mod) return;

    const recommendations = mod.buildSetupRecommendations({
      productSurface: "web",
      existingProviders: {
        x: { hasAccount: true }
      }
    });

    expect(recommendations.find((item) => item.provider === "x")).toMatchObject({
      provider: "x",
      status: "recommended",
      track: "v1",
      reasonCode: "already_present",
      orchestration: "resume_existing"
    });
  });

  it("marks web analytics as not applicable on mobile surfaces", async () => {
    const mod = await loadRecommendationsModule();
    expect(mod, "recommendations module should exist").not.toBeNull();
    if (!mod) return;

    const recommendations = mod.buildSetupRecommendations({ productSurface: "mobile" });

    expect(recommendations.find((item) => item.provider === "ga4")).toMatchObject({
      provider: "ga4",
      status: "not_applicable",
      track: "v1",
      reasonCode: "surface_not_supported",
      orchestration: "skip"
    });
    expect(recommendations.find((item) => item.provider === "posthog")).toMatchObject({
      provider: "posthog",
      status: "not_applicable",
      track: "v1",
      reasonCode: "surface_not_supported",
      orchestration: "skip"
    });
  });
});
