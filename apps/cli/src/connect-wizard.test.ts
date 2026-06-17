import { describe, expect, it } from "vitest";

import {
  buildConnectDispatchLine,
  buildConnectSetupDescriptor,
  connectorSetupDefinition,
  decideConnectWizard,
  normalizeConnectorPayload,
  requiresOperatorConfirmation
} from "./index.js";

// Pure-helper coverage for the in-chat /connect wizard (#20). These run on CI (no
// PTY loop). The live keystroke flow + transcript/disk leak assertions live in the
// PTY-driven tests in tui/ink/interactive-session.connect.test.ts.

describe("decideConnectWizard — scope + routing", () => {
  it("returns a token-provider wizard descriptor for posthog/stripe/x", () => {
    for (const provider of ["posthog", "stripe", "x"]) {
      const decision = decideConnectWizard(`/connect ${provider}`);
      expect(decision.kind).toBe("wizard");
      if (decision.kind !== "wizard") {
        throw new Error("expected wizard");
      }
      expect(decision.descriptor.provider).toBe(provider);
      expect(decision.descriptor.fields.length).toBeGreaterThan(0);
    }
  });

  it("works without a leading slash and via provider aliases (twitter → x)", () => {
    expect(decideConnectWizard("connect posthog").kind).toBe("wizard");
    const twitter = decideConnectWizard("/connect twitter");
    expect(twitter.kind).toBe("wizard");
    if (twitter.kind === "wizard") {
      expect(twitter.descriptor.provider).toBe("x");
    }
  });

  it("DEFERS GA4: /connect ga4 and google_analytics_4 show the `infinite setup` note (no wizard)", () => {
    for (const token of ["ga4", "google_analytics_4", "google"]) {
      const decision = decideConnectWizard(`/connect ${token}`);
      expect(decision.kind).toBe("note");
      if (decision.kind !== "note") {
        throw new Error("expected note");
      }
      expect(decision.text).toContain("infinite setup");
      expect(decision.text).toContain("browser");
    }
  });

  it("GUARDS meta_ads + shopify: /connect <provider> shows the terminal fallback note (no wizard)", () => {
    for (const provider of ["meta_ads", "shopify", "meta", "facebook"]) {
      const decision = decideConnectWizard(`/connect ${provider}`);
      expect(decision.kind).toBe("note");
      if (decision.kind !== "note") {
        throw new Error("expected note");
      }
      expect(decision.text).toContain("infinite connect");
      expect(decision.text).toContain("in your terminal");
    }
  });

  it("falls through (kind=none) for inline-JSON, oauth subcommands, unknown providers, and non-connect lines", () => {
    expect(decideConnectWizard('/connect posthog PostHog {"projectId":1}').kind).toBe("none");
    expect(decideConnectWizard("/connect oauth google_analytics_4 --client-id x").kind).toBe("none");
    expect(decideConnectWizard("/connect oauth-status sess_1").kind).toBe("none");
    expect(decideConnectWizard("/connect oauth-exchange sess_1").kind).toBe("none");
    expect(decideConnectWizard("/connect bogus").kind).toBe("none");
    expect(decideConnectWizard("/connect").kind).toBe("none");
    expect(decideConnectWizard("how many views yesterday").kind).toBe("none");
    expect(decideConnectWizard("/sources").kind).toBe("none");
  });
});

describe("buildConnectSetupDescriptor — fields, masking, region step, guidance", () => {
  it("posthog: project id (required, plain) + personal api key (required, MASKED) + region step", () => {
    const definition = connectorSetupDefinition("posthog")!;
    const descriptor = buildConnectSetupDescriptor(definition);
    expect(descriptor.fields.map((f) => f.key)).toEqual(["projectId", "personalApiKey", "apiHost"]);

    const key = descriptor.fields.find((f) => f.key === "personalApiKey")!;
    expect(key.secret).toBe(true);
    expect(key.required).toBe(true);
    expect(key.guidance).toContain("phx_");
    expect(key.guidance).toContain("query:read");
    expect(key.guidance).toContain("project:read");

    const projectId = descriptor.fields.find((f) => f.key === "projectId")!;
    expect(projectId.secret).toBe(false);
    expect(projectId.guidance).toContain("numeric project id");

    // The deliberate US/EU region step replaces the silent free-text host default.
    const region = descriptor.fields.find((f) => f.key === "apiHost")!;
    expect(region.required).toBe(true);
    expect(region.secret).toBe(false);
    expect(region.choices?.map((c) => c.value)).toEqual(["us.posthog.com", "eu.posthog.com"]);
  });

  it("stripe: only the required masked secret key is prompted (optional apiBaseUrl dropped)", () => {
    const descriptor = buildConnectSetupDescriptor(connectorSetupDefinition("stripe")!);
    expect(descriptor.fields.map((f) => f.key)).toEqual(["secretKey"]);
    expect(descriptor.fields[0]!.secret).toBe(true);
    expect(descriptor.fields[0]!.guidance).toContain("sk_live_");
  });

  it("x: masked bearer token + plain username are prompted (optional apiBaseUrl dropped)", () => {
    const descriptor = buildConnectSetupDescriptor(connectorSetupDefinition("x")!);
    expect(descriptor.fields.map((f) => f.key)).toEqual(["bearerToken", "username"]);
    expect(descriptor.fields.find((f) => f.key === "bearerToken")!.secret).toBe(true);
    expect(descriptor.fields.find((f) => f.key === "username")!.secret).toBe(false);
  });
});

describe("buildConnectDispatchLine — leading slash + normalization (security seam)", () => {
  it("posthog: line STARTS WITH '/', carries the secret only in the JSON, and EU region sets the right apiHost", () => {
    const definition = connectorSetupDefinition("posthog")!;
    const line = buildConnectDispatchLine(definition, "PostHog", {
      projectId: "12345",
      personalApiKey: "phx_secret_value",
      apiHost: "eu.posthog.com"
    });
    expect(line.startsWith("/")).toBe(true);
    expect(line.startsWith("/connect posthog PostHog ")).toBe(true);
    const json = line.slice("/connect posthog PostHog ".length);
    const payload = JSON.parse(json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mode: "live",
      projectId: 12345,
      personalApiKey: "phx_secret_value",
      apiHost: "https://eu.posthog.com"
    });
  });

  it("posthog: US region sets the US apiHost (the EU 403 fix)", () => {
    const definition = connectorSetupDefinition("posthog")!;
    const usLine = buildConnectDispatchLine(definition, "PostHog", {
      projectId: "1",
      personalApiKey: "phx_us",
      apiHost: "us.posthog.com"
    });
    const usPayload = JSON.parse(usLine.slice("/connect posthog PostHog ".length)) as Record<string, unknown>;
    expect(usPayload.apiHost).toBe("https://us.posthog.com");

    const euLine = buildConnectDispatchLine(definition, "PostHog", {
      projectId: "1",
      personalApiKey: "phx_eu",
      apiHost: "eu.posthog.com"
    });
    const euPayload = JSON.parse(euLine.slice("/connect posthog PostHog ".length)) as Record<string, unknown>;
    expect(euPayload.apiHost).toBe("https://eu.posthog.com");
    expect(usPayload.apiHost).not.toBe(euPayload.apiHost);
  });

  it("x: strips the leading @ from the username and keeps the masked bearer token in JSON", () => {
    const definition = connectorSetupDefinition("x")!;
    const line = buildConnectDispatchLine(definition, "X Public Metrics", {
      bearerToken: "AAAA_bearer",
      username: "@infinite_os"
    });
    expect(line.startsWith("/connect x ")).toBe(true);
    const payload = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    expect(payload.username).toBe("infinite_os");
    expect(payload.bearerToken).toBe("AAAA_bearer");
  });

  it("normalizeConnectorPayload drops empty values (skipped optional fields)", () => {
    const definition = connectorSetupDefinition("stripe")!;
    const payload = normalizeConnectorPayload(definition, { secretKey: "sk_live_x", apiBaseUrl: "" });
    expect(payload).toEqual({ mode: "live", secretKey: "sk_live_x" });
  });
});

describe("terminal readline gate is unchanged (binding revision)", () => {
  it("`connect posthog` STILL requires operator confirmation (the `Type confirm` gate)", () => {
    // The TUI wizard bypasses this gate, but the terminal readline path keeps it.
    expect(requiresOperatorConfirmation("connect posthog")).toBe(true);
    expect(requiresOperatorConfirmation("/connect posthog")).toBe(true);
  });
});
