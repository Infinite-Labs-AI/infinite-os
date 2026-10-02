import { describe, expect, it } from "vitest";

import {
  MAX_CONNECTION_NAME_CHARS,
  MAX_STATUS_CONNECTIONS,
  STATUS_CONNECTIONS_CAPABILITY,
  decodeStatusConnections,
  topBarSourcesFromConnections
} from "./status-connections.js";

describe("status connections (status.connections.v1)", () => {
  it("names the capability the bridge advertises", () => {
    expect(STATUS_CONNECTIONS_CAPABILITY).toBe("status.connections.v1");
  });

  it("reads names and statuses in the app's order", () => {
    expect(decodeStatusConnections([
      { name: "Catalog", status: "broken" },
      { name: "Orders", status: "connected" },
      { name: "Ad Network", status: "off" }
    ])).toEqual([
      { name: "Catalog", status: "broken" },
      { name: "Orders", status: "connected" },
      { name: "Ad Network", status: "off" }
    ]);
  });

  it("is undefined when the field is absent or not a list, and empty for an empty list", () => {
    for (const value of [undefined, null, "Catalog", {}, 3]) {
      expect(decodeStatusConnections(value)).toBeUndefined();
    }
    expect(decodeStatusConnections([])).toEqual([]);
  });

  it("drops an entry that does not decode and keeps the rest", () => {
    expect(decodeStatusConnections([
      null,
      "Catalog",
      { name: "Catalog" },
      { name: "Catalog", status: "syncing" },
      { name: "", status: "connected" },
      { name: 7, status: "connected" },
      { name: "Orders", status: "connected" }
    ])).toEqual([{ name: "Orders", status: "connected" }]);
  });

  it.each([
    ["an email", "robin@example.test"],
    ["a URL", "https://example.test/catalog"],
    ["a path", "catalog/rows"],
    ["an account id", "account_00427"],
    ["a long number", "120213456789012"],
    ["JSON", '{"name":"Catalog"}']
  ])("never shows %s as a name", (_what, name) => {
    expect(decodeStatusConnections([{ name, status: "connected" }])).toEqual([]);
  });

  it("scrubs control sequences from a name", () => {
    expect(decodeStatusConnections([{ name: "\u001b[31mCatalog\u001b[0m", status: "connected" }])).toEqual([
      { name: "Catalog", status: "connected" }
    ]);
  });

  it("keeps at most 12 entries, each name at most 24 characters, and one entry per name", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `Source ${index + 1}`, status: "connected" }));
    expect(decodeStatusConnections(many)).toHaveLength(MAX_STATUS_CONNECTIONS);
    const long = decodeStatusConnections([{ name: "A very long connection name indeed", status: "connected" }])!;
    expect(long[0]!.name).toBe("A very long connection…");
    expect(Array.from(long[0]!.name).length).toBeLessThanOrEqual(MAX_CONNECTION_NAME_CHARS);
    const exact = "N".repeat(MAX_CONNECTION_NAME_CHARS);
    expect(decodeStatusConnections([{ name: exact, status: "connected" }])![0]!.name).toBe(exact);
    expect(decodeStatusConnections([
      { name: "Catalog", status: "connected" },
      { name: "Catalog", status: "broken" }
    ])).toEqual([{ name: "Catalog", status: "connected" }]);
  });

  it("maps connected, broken and off onto the top bar's green dot, red and amber marks", () => {
    expect(topBarSourcesFromConnections([
      { name: "Catalog", status: "broken" },
      { name: "Orders", status: "connected" },
      { name: "Ad Network", status: "off" }
    ])).toEqual([
      { label: "Catalog", state: "broken" },
      { label: "Orders", state: "connected" },
      { label: "Ad Network", state: "missing" }
    ]);
  });
});
