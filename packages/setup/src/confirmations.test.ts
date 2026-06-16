import { describe, expect, it } from "vitest";

import { buildProviderConfirmations, formatProviderConfirmation } from "./confirmations.js";
import type { SetupRunResult } from "./setup-controller.js";
import type { SetupInterview } from "./types.js";

function run(overrides: Partial<SetupRunResult> = {}): Pick<SetupRunResult, "status" | "phases" | "providerState"> {
  return {
    status: "succeeded",
    phases: {} as SetupRunResult["phases"],
    providerState: {},
    ...overrides
  };
}

describe("formatProviderConfirmation", () => {
  it("confirms a connected GA4 with property + Measurement ID and the in-repo install command", () => {
    const line = formatProviderConfirmation({
      provider: "ga4",
      workspaceId: "ws_1",
      run: run({
        providerState: {
          publicArtifacts: { propertyId: "properties/123", measurementId: "G-ACME123" }
        }
      })
    });

    expect(line).toBe(
      "✓ GA4 connected — property properties/123 · Measurement ID G-ACME123. " +
        "Next: use the install command at the end of this setup (covers all connected providers)."
    );
    // Never a per-provider --yes command: pasting two of those in sequence could
    // rewrite the managed analytics module without the first provider's tag.
    expect(line).not.toContain("npx infinite-tag install");
  });

  it("does not advertise an artifact-less install when GA4 connected without a Measurement ID", () => {
    const line = formatProviderConfirmation({ provider: "ga4", workspaceId: "ws_1", run: run() });

    expect(line).toBe(
      "✓ GA4 connected. Next: re-run `infinite setup` to capture its Measurement ID — nothing to install yet."
    );
    expect(line).not.toContain("npx infinite-tag install");
  });

  it("confirms PostHog captured the project key and project id with the snippet install next step", () => {
    const line = formatProviderConfirmation({
      provider: "posthog",
      workspaceId: "ws_1",
      run: run({
        providerState: {
          publicArtifacts: {
            projectId: "project_1",
            projectKey: "phc_test_key",
            apiHost: "https://us.i.posthog.com"
          }
        }
      })
    });

    expect(line).toBe(
      "✓ PostHog connected — project key phc_test_key captured + pixel ready · project project_1. " +
        "Next: use the install command at the end of this setup (covers all connected providers)."
    );
    expect(line).not.toContain("npx infinite-tag install");
  });

  it("confirms X captured the pixel id with the pixel install next step", () => {
    const line = formatProviderConfirmation({
      provider: "x",
      workspaceId: "ws_1",
      run: run({ providerState: { publicArtifacts: { pixelId: "px_123" } } })
    });

    expect(line).toBe(
      "✓ X connected — pixel id px_123 captured. " +
        "Next: use the install command at the end of this setup (covers all connected providers)."
    );
    expect(line).not.toContain("npx infinite-tag install");
  });

  it("surfaces the resume command for a paused provider when the run id is known", () => {
    const line = formatProviderConfirmation({
      provider: "ga4",
      workspaceId: "ws_1",
      runId: "run_ga4",
      run: run({ status: "paused_handoff" })
    });

    expect(line).toBe(
      "→ GA4 not connected yet — setup paused for a step in your browser. " +
        "Next: finish that step, then run `infinite setup resume run_ga4`."
    );
  });

  it("points a paused provider at setup status when no run id is known", () => {
    const line = formatProviderConfirmation({
      provider: "posthog",
      workspaceId: "ws_1",
      run: run({ status: "paused_handoff" })
    });

    expect(line).toBe(
      "→ PostHog not connected yet — setup paused for a step in your browser. " +
        "Next: finish that step, then run `infinite setup status` to get the resume command."
    );
  });

  it("reports a failed provider with the failing phase detail and a retry next step", () => {
    const line = formatProviderConfirmation({
      provider: "x",
      workspaceId: "ws_1",
      run: run({
        status: "failed",
        phases: {
          detect: { status: "ok", detail: "found" },
          connect: { status: "error", detail: "X API rejected the bearer token." }
        } as SetupRunResult["phases"]
      })
    });

    expect(line).toBe(
      "✗ X failed — X API rejected the bearer token. Next: fix the issue above, then run `infinite setup` again."
    );
  });

  it("reports a failed provider without a detail when no phase carries one", () => {
    const line = formatProviderConfirmation({
      provider: "ga4",
      workspaceId: "ws_1",
      run: run({ status: "failed" })
    });

    expect(line).toBe("✗ GA4 failed. Next: fix the issue above, then run `infinite setup` again.");
  });

  it("marks a provider without a run as skipped", () => {
    const line = formatProviderConfirmation({ provider: "posthog", workspaceId: "ws_1" });

    expect(line).toBe(
      "– PostHog skipped — nothing was set up or captured for it in this run. Next: run `infinite setup` again to include it."
    );
  });
});

describe("buildProviderConfirmations", () => {
  const interview: SetupInterview = {
    projectName: "Acme",
    websiteUrl: "https://acme.test",
    productSurface: "web",
    providerInventory: [
      { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
      { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
      { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
    ]
  };

  it("emits one confirmation per selected provider, resolving paused resume ids from active runs", () => {
    const lines = buildProviderConfirmations({
      interview,
      runs: {
        ga4: {
          tool: "ga4",
          status: "succeeded",
          phases: {} as SetupRunResult["phases"],
          providerState: { publicArtifacts: { measurementId: "G-ACME123" } }
        },
        posthog: {
          tool: "posthog",
          status: "paused_handoff",
          phases: {} as SetupRunResult["phases"]
        }
      },
      activeRuns: [{ id: "run_posthog", provider: "posthog", status: "paused_handoff" }],
      workspaceId: "ws_1"
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("✓ GA4 connected — Measurement ID G-ACME123.");
    expect(lines[0]).toContain(
      "Next: use the install command at the end of this setup (covers all connected providers)."
    );
    expect(lines[0]).not.toContain("npx infinite-tag install");
    expect(lines[1]).toContain("→ PostHog not connected yet");
    expect(lines[1]).toContain("infinite setup resume run_posthog");
  });

  it("marks selected providers that never ran as skipped and ignores unselected ones", () => {
    const lines = buildProviderConfirmations({
      interview,
      runs: {},
      activeRuns: [],
      workspaceId: "ws_1"
    });

    expect(lines).toEqual([
      "– GA4 skipped — nothing was set up or captured for it in this run. Next: run `infinite setup` again to include it.",
      "– PostHog skipped — nothing was set up or captured for it in this run. Next: run `infinite setup` again to include it."
    ]);
  });
});
