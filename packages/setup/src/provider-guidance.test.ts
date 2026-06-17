import { describe, expect, it } from "vitest";

import {
  providerDisplayLabel,
  providerGuidance,
  providerHandoffBoundary,
  type GuidanceProvider,
  type GuidanceStep
} from "./provider-guidance.js";

describe("provider-guidance", () => {
  const cases: Array<{ provider: GuidanceProvider; step: GuidanceStep }> = [
    { provider: "ga4", step: "quick_connect" },
    { provider: "ga4", step: "byo" },
    { provider: "ga4", step: "tos" },
    { provider: "posthog", step: "api_key" },
    { provider: "posthog", step: "signup" },
    { provider: "x", step: "billing" }
  ];

  for (const { provider, step } of cases) {
    it(`snapshots the ${provider}/${step} block`, () => {
      expect(providerGuidance(provider, step)).toMatchSnapshot();
    });
  }

  it("always has the consistent WHAT / WHY / CONFIRM / SKIP shape", () => {
    for (const { provider, step } of cases) {
      const block = providerGuidance(provider, step);
      expect(block).toContain("What to do there:");
      expect(block).toContain("Why:");
      expect(block).toContain("Confirm:");
      expect(block).toContain("Skip:");
    }
  });

  it("renders the pasteable authorization URL when provided (#7 'paste this link')", () => {
    const block = providerGuidance("ga4", "quick_connect", {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1"
    });
    expect(block).toContain("Paste this link:");
    expect(block).toContain("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });

  it("omits the paste line when no URL is known", () => {
    const block = providerGuidance("ga4", "quick_connect");
    expect(block).not.toContain("Paste this link:");
  });

  it("adds the remote/SSH loopback note only when both URL and hint are present", () => {
    const withHint = providerGuidance("ga4", "quick_connect", {
      authorizationUrl: "https://accounts.google.com/x",
      remoteLoopbackHint: true
    });
    expect(withHint).toContain("Remote/SSH note:");
    expect(withHint).toContain("127.0.0.1 of THIS machine");

    const withoutUrl = providerGuidance("ga4", "quick_connect", { remoteLoopbackHint: true });
    expect(withoutUrl).not.toContain("Remote/SSH note:");
  });

  it("adds a resume hint line only when a runId is provided", () => {
    expect(providerGuidance("posthog", "api_key", { runId: "run_123" })).toContain(
      "Resume any time with: infinite setup resume run_123"
    );
    // Without a runId, the explicit "Resume any time with:" line is absent (the api_key body
    // still references `infinite setup resume <run_id>` generically — that's the template copy).
    expect(providerGuidance("posthog", "api_key")).not.toContain("Resume any time with:");
  });

  it("varies the GA4 tos copy by hasAccount", () => {
    const hasAccount = providerGuidance("ga4", "tos", {}, true);
    const noAccount = providerGuidance("ga4", "tos", {}, false);
    expect(hasAccount).not.toEqual(noAccount);
    expect(noAccount).toContain("account setup");
  });

  it("exposes the canonical N-of-M boundary + display labels", () => {
    expect(providerHandoffBoundary("ga4", 1, 3)).toBe("Now connecting Google Analytics (1 of 3)…");
    expect(providerHandoffBoundary("posthog", 2, 3)).toBe("Now connecting PostHog (2 of 3)…");
    expect(providerDisplayLabel("x")).toBe("X");
  });
});
