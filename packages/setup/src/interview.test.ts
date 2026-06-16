import { describe, expect, it } from "vitest";

import {
  createDefaultProviderInventory,
  normalizeSetupInterview,
  parseSetupProviderIds
} from "./interview.js";

describe("setup interview normalization", () => {
  it("defaults onboarding to web while preserving product descriptions for compatibility", () => {
    const interview = normalizeSetupInterview({
      projectName: "Acme Site",
      productDescription: "  AI bookkeeping software  ",
      productSurface: "mobile",
      websiteUrl: "https://acme.test"
    });

    expect(interview).toMatchObject({
      projectName: "Acme Site",
      productDescription: "AI bookkeeping software",
      productSurface: "web",
      websiteUrl: "https://acme.test"
    });
  });

  it("canonicalizes site URLs to a single https host", () => {
    expect(
      normalizeSetupInterview({
        projectName: "Acme",
        websiteUrl: "ACME.test/"
      }).websiteUrl
    ).toBe("https://acme.test");

    expect(
      normalizeSetupInterview({
        projectName: "Acme",
        websiteUrl: "www.acme.test/"
      }).websiteUrl
    ).toBe("https://acme.test");

    expect(
      normalizeSetupInterview({
        projectName: "Acme",
        websiteUrl: "https://https://acme.test/"
      }).websiteUrl
    ).toBe("https://acme.test");
  });

  it("preserves explicit http URLs for local and private development hosts", () => {
    expect(
      normalizeSetupInterview({
        projectName: "Localhost Acme",
        websiteUrl: "http://localhost:3000/"
      }).websiteUrl
    ).toBe("http://localhost:3000");

    expect(
      normalizeSetupInterview({
        projectName: "Local Domain Acme",
        websiteUrl: "http://app.local:3000/"
      }).websiteUrl
    ).toBe("http://app.local:3000");

    expect(
      normalizeSetupInterview({
        projectName: "Test Domain Acme",
        websiteUrl: "http://preview.test:4173/"
      }).websiteUrl
    ).toBe("http://preview.test:4173");

    expect(
      normalizeSetupInterview({
        projectName: "Private IP Acme",
        websiteUrl: "http://192.168.1.25:8080/"
      }).websiteUrl
    ).toBe("http://192.168.1.25:8080");
  });

  it("still upgrades public http URLs to https", () => {
    const interview = normalizeSetupInterview({
      projectName: "Public Acme",
      websiteUrl: "http://example.com/path/"
    });

    expect(interview.websiteUrl).toBe("https://example.com/path");
  });

  it("creates default inventory rows with x visible but not preselected", () => {
    const rows = createDefaultProviderInventory();

    expect(rows).toEqual([
      { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
      { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
      { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
    ]);
  });

  it("deduplicates provider selections and keeps only supported ids", () => {
    expect(parseSetupProviderIds("ga4, posthog, ga4, meta, x")).toEqual(["ga4", "posthog", "x"]);
  });
});
