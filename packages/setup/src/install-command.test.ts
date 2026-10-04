import { describe, expect, it } from "vitest";

import { buildInstrumentInstallCommand } from "./install-command.js";

describe("buildInstrumentInstallCommand", () => {
  it("builds the complete command with every captured provider's public artifacts", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_acme",
          collectPath: "/infinite/events/collect",
          productionHosts: ["acme.test", "www.acme.test"],
          staticProxy: "vercel",
          consentMode: "not_required"
        },
        ga4: { measurementId: "G-ACME123", propertyId: "properties/123" },
        posthog: { projectId: "project_1", projectKey: "phc_test_key", apiHost: "https://us.i.posthog.com" },
        x: { pixelId: "px_123", eventTagIds: { signup: "tw-event-1", purchase: "tw-event-2" } }
      }
    });

    expect(command).toBe(
      "npx infinite-tag install --workspace ws_1 " +
        "--infinite-site-source-key site_public_acme " +
        "--infinite-collect-path /infinite/events/collect " +
        "--infinite-production-host acme.test --infinite-production-host www.acme.test " +
        "--infinite-static-proxy vercel " +
        "--infinite-consent-mode not-required " +
        "--ga4-measurement-id G-ACME123 " +
        "--posthog-project-key phc_test_key --posthog-api-host https://us.i.posthog.com " +
        "--x-pixel-id px_123 --x-event-tag-id tw-event-1 --x-event-tag-id tw-event-2 " +
        "--yes"
    );
  });

  it("emits the required consent mode explicitly", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_acme",
          collectPath: "/infinite/events/collect",
          productionHosts: ["acme.test"],
          consentMode: "required"
        }
      }
    });

    expect(command).toBe(
      "npx infinite-tag install --workspace ws_1 " +
        "--infinite-site-source-key site_public_acme " +
        "--infinite-collect-path /infinite/events/collect " +
        "--infinite-production-host acme.test " +
        "--infinite-consent-mode required --yes"
    );
  });

  it("builds an Infinite-only command from the browser-safe public artifact", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_acme",
          collectPath: "/infinite/events/collect",
          productionHosts: ["acme.test"]
        }
      }
    });

    expect(command).toBe(
      "npx infinite-tag install --workspace ws_1 " +
        "--infinite-site-source-key site_public_acme " +
        "--infinite-collect-path /infinite/events/collect " +
        "--infinite-production-host acme.test --yes"
    );
  });

  it("emits only the flags for providers that actually captured artifacts", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { ga4: { measurementId: "G-ACME123" }, posthog: null, x: null }
    });

    expect(command).toBe("npx infinite-tag install --workspace ws_1 --ga4-measurement-id G-ACME123 --yes");
  });

  it("passes explicit production hosts for a mirror-only install", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: {
        productionHosts: ["acme.test"],
        ga4: { measurementId: "G-ACME123" }
      }
    });

    expect(command).toBe(
      "npx infinite-tag install --workspace ws_1 " +
        "--infinite-production-host acme.test --ga4-measurement-id G-ACME123 --yes"
    );
  });

  it("emits the PostHog project key without an api host when none was captured", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { posthog: { projectKey: "phc_test_key" } }
    });

    expect(command).toBe("npx infinite-tag install --workspace ws_1 --posthog-project-key phc_test_key --yes");
  });

  it("ignores a PostHog api host captured without a project key (installer needs the key)", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { posthog: { apiHost: "https://us.i.posthog.com" } }
    });

    expect(command).toBeNull();
  });

  it("ignores X event tags captured without a pixel id (installer refuses event tags alone)", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { x: { eventTagIds: { signup: "tw-event-1" } } }
    });

    expect(command).toBeNull();
  });

  it("dedupes repeated X event tag ids", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { x: { pixelId: "px_123", eventTagIds: { signup: "tw-event-1", trial: "tw-event-1" } } }
    });

    expect(command).toBe(
      "npx infinite-tag install --workspace ws_1 --x-pixel-id px_123 --x-event-tag-id tw-event-1 --yes"
    );
  });

  it("returns null when nothing was captured", () => {
    expect(buildInstrumentInstallCommand({ workspaceId: "ws_1", artifacts: {} })).toBeNull();
    expect(buildInstrumentInstallCommand({ workspaceId: "ws_1", artifacts: null })).toBeNull();
    expect(buildInstrumentInstallCommand({ workspaceId: "ws_1", artifacts: undefined })).toBeNull();
  });

  it("treats blank or whitespace-only values as missing", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { ga4: { measurementId: "   " }, posthog: { projectKey: "" } }
    });

    expect(command).toBeNull();
  });

  it("trims surrounding whitespace from captured values", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { ga4: { measurementId: "  G-ACME123  " } }
    });

    expect(command).toBe("npx infinite-tag install --workspace ws_1 --ga4-measurement-id G-ACME123 --yes");
  });

  it("shell-quotes values that are not safely pasteable as-is", () => {
    const command = buildInstrumentInstallCommand({
      workspaceId: "ws_1",
      artifacts: { ga4: { measurementId: "G-ACME 123'X" } }
    });

    expect(command).toBe(
      "npx infinite-tag install --workspace ws_1 --ga4-measurement-id 'G-ACME 123'\\''X' --yes"
    );
  });
});
