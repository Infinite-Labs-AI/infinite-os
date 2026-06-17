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

  it("GUARDS shopify: /connect shopify shows the terminal fallback note (no wizard)", () => {
    for (const provider of ["shopify"]) {
      const decision = decideConnectWizard(`/connect ${provider}`);
      expect(decision.kind).toBe("note");
      if (decision.kind !== "note") {
        throw new Error("expected note");
      }
      expect(decision.text).toContain("infinite connect");
      expect(decision.text).toContain("in your terminal");
    }
  });

  it("ROUTES meta_ads to the masked wizard (not the terminal-only note) via meta/facebook aliases too", () => {
    for (const token of ["meta_ads", "meta", "facebook"]) {
      const decision = decideConnectWizard(`/connect ${token}`);
      expect(decision.kind).toBe("wizard");
      if (decision.kind !== "wizard") {
        throw new Error("expected wizard");
      }
      expect(decision.descriptor.provider).toBe("meta_ads");
      expect(decision.descriptor.fields.length).toBeGreaterThan(0);
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

  it("meta_ads: plain ad account id → MASKED access token → backfill-window choice (transport fields dropped)", () => {
    const descriptor = buildConnectSetupDescriptor(connectorSetupDefinition("meta_ads")!);
    // Credential fields first, backfill-window LAST (so the secret is collected
    // before the non-secret window pick), and the optional CLI/MCP/apiVersion
    // transport fields are dropped (in-chat always uses the native marketing_api).
    expect(descriptor.fields.map((f) => f.key)).toEqual([
      "adAccountId",
      "accessToken",
      "backfillWindow"
    ]);

    const adAccountId = descriptor.fields.find((f) => f.key === "adAccountId")!;
    expect(adAccountId.secret).toBe(false);
    expect(adAccountId.required).toBe(true);
    expect(adAccountId.guidance).toContain("act_");

    const token = descriptor.fields.find((f) => f.key === "accessToken")!;
    expect(token.secret).toBe(true);
    expect(token.required).toBe(true);
    // The broad management scopes so a later write PR needs no token re-mint.
    expect(token.guidance).toContain("ads_management");
    expect(token.guidance).toContain("business_management");
    expect(token.guidance).toContain("System Users");

    // Option B: the backfill window is a fixed pick-list (NOT a secret/free-text),
    // covering every META_ADS_BACKFILL_OPTIONS value, defaulting to 30 days.
    const window = descriptor.fields.find((f) => f.key === "backfillWindow")!;
    expect(window.secret).toBe(false);
    expect(window.required).toBe(true);
    expect(window.choices?.map((c) => c.value)).toEqual([
      "7_days",
      "14_days",
      "30_days",
      "3_months",
      "6_months",
      "12_months",
      "all_time"
    ]);
    expect(window.choices?.find((c) => c.value === "30_days")?.description).toBe("default");
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

  it("meta_ads: derives transport=marketing_api, strips act_, keeps the masked token in JSON, and splices --backfill-window OUT of the credential JSON", () => {
    const definition = connectorSetupDefinition("meta_ads")!;
    const line = buildConnectDispatchLine(definition, "Meta Ads", {
      adAccountId: "act_1234567890",
      accessToken: "EAAB_system_user_token",
      backfillWindow: "6_months"
    });

    // Leading slash routes to POST /sources/connect (never the LLM chat branch).
    expect(line.startsWith("/connect meta_ads Meta Ads ")).toBe(true);
    // The chosen window rides as a PRE-JSON token so runCommand's connect branch
    // (metaAdsBackfillBody) drives the backfill with the user's pick (Option B).
    expect(line).toContain(" --backfill-window 6_months ");
    expect(line.indexOf("--backfill-window")).toBeLessThan(line.indexOf("{"));

    const payload = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    // No cliCommand/mcpCommand collected in chat → native Graph transport.
    expect(payload.transport).toBe("marketing_api");
    // act_ prefix stripped; the masked token rides ONLY in the JSON arg.
    expect(payload.adAccountId).toBe("1234567890");
    expect(payload.accessToken).toBe("EAAB_system_user_token");
    // The window is NOT a credential — it must never leak into the payload.
    expect(payload).not.toHaveProperty("backfillWindow");
    expect(payload.mode).toBe("live");
  });

  it("meta_ads: the default 30-day window round-trips as a pre-JSON token", () => {
    const definition = connectorSetupDefinition("meta_ads")!;
    const line = buildConnectDispatchLine(definition, "Meta Ads", {
      adAccountId: "1",
      accessToken: "tok",
      backfillWindow: "30_days"
    });
    expect(line).toContain(" --backfill-window 30_days ");
    const payload = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("backfillWindow");
  });
});

describe("terminal readline gate is unchanged (binding revision)", () => {
  it("`connect posthog` STILL requires operator confirmation (the `Type confirm` gate)", () => {
    // The TUI wizard bypasses this gate, but the terminal readline path keeps it.
    expect(requiresOperatorConfirmation("connect posthog")).toBe(true);
    expect(requiresOperatorConfirmation("/connect posthog")).toBe(true);
  });
});
