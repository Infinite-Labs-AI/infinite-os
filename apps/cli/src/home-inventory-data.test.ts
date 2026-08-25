import { describe, expect, it } from "vitest";

import {
  homeInventoryCommands,
  homeInventoryData,
  homeInventoryProviderLabel
} from "./index.js";

describe("homeInventoryData", () => {
  it("builds the shared startup inventory with the active desktop workspace", () => {
    const connections = [{ label: "GA4" }] as const;

    const inventory = homeInventoryData("Acme", connections);

    expect(inventory.workspace).toBe("Acme");
    expect(inventory.connections).toEqual(connections);
    expect(inventory.tools.map((tool) => tool.label)).toEqual([
      "connect",
      "sync",
      "generate ads",
      "insights",
      "outreach",
      "query"
    ]);
    expect(inventory.commands).toEqual(homeInventoryCommands());
    expect(inventory.version).toEqual(expect.any(String));
  });

  it("neutralizes terminal controls in workspace and connection labels", () => {
    const inventory = homeInventoryData(
      "Acme\nFORGED\u001b]0;spoof-title\u0007",
      [{ label: "G\u001b[31mA4\u001b[0m\rFORGED" }]
    );

    expect(inventory.workspace).toBe("Acme FORGED");
    expect(inventory.connections).toEqual([{ label: "GA4 FORGED" }]);
  });
});

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

  it("neutralizes terminal controls in unknown provider ids", () => {
    expect(homeInventoryProviderLabel("some\u001b]0;spoof-title\u0007_provider\nFORGED"))
      .toBe("Some Provider FORGED");
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
