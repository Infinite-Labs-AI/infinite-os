import { describe, expect, it } from "vitest";

import { homeInventoryCommands, homeInventoryProviderLabel } from "./index.js";

describe("homeInventoryProviderLabel", () => {
  it("maps known connector providers to short friendly labels", () => {
    expect(homeInventoryProviderLabel("google_analytics_4")).toBe("GA4");
    expect(homeInventoryProviderLabel("meta_ads")).toBe("Facebook");
    expect(homeInventoryProviderLabel("x")).toBe("X");
    expect(homeInventoryProviderLabel("posthog")).toBe("PostHog");
    expect(homeInventoryProviderLabel("shopify")).toBe("Shopify");
    expect(homeInventoryProviderLabel("stripe")).toBe("Stripe");
  });

  it("title-cases an unknown provider id rather than dumping the raw snake_case id", () => {
    expect(homeInventoryProviderLabel("some_new_source")).toBe("Some New Source");
  });
});

describe("homeInventoryCommands", () => {
  it("returns the curated subset, every entry a real registry command", () => {
    const commands = homeInventoryCommands();
    expect(commands.length).toBeGreaterThan(0);
    // The most useful front doors are present and curated (not the whole registry).
    const values = commands.map((command) => command.value);
    expect(values).toContain("/connect");
    expect(values).toContain("/sync");
    expect(values).toContain("/help");
    expect(values).toContain("/exit");
    // Curated subset stays short — it must fit on one line on a normal terminal.
    expect(commands.length).toBeLessThanOrEqual(8);
    // Every curated command is a leading-slash command.
    for (const value of values) {
      expect(value.startsWith("/")).toBe(true);
    }
  });
});
