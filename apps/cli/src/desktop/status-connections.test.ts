import { describe, expect, it } from "vitest";

import { stripAnsi } from "../tui/lib/display-width.js";
import { GOLDEN, goldenCells, goldenText, renderedCells, type GoldenLine } from "../tui/ink/__fixtures__/r4-chrome.js";
import { topBarLines } from "../tui/ink/top-bar.js";
import { resolveTheme } from "../tui/theme.js";
import {
  MAX_CONNECTION_NAME_CHARS,
  MAX_STATUS_CONNECTIONS,
  STATUS_CONNECTIONS_CAPABILITY,
  decodeStatusConnections,
  desktopTopBarData,
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

// The session's top bar from what `/v1/status` says, against terminal-r4's
// region-topbar goldens (the synthetic ones this public repo carries).
describe("the desktop session's top bar from /v1/status", () => {
  const TRUECOLOR = resolveTheme({ INFINITE_COLOR: "truecolor" }, { isTTY: true });
  // The wire rows, in the app's own order.
  const WIRE_OK = [
    { name: "Shopify", status: "broken" },
    { name: "GA4", status: "connected" },
    { name: "Stripe", status: "connected" },
    { name: "PostHog", status: "connected" },
    { name: "Google Ads", status: "connected" },
    { name: "Meta", status: "connected" }
  ];
  const WIRE_ONE_OFF = WIRE_OK.map((row) => (row.name === "Google Ads" ? { ...row, status: "off" } : row));
  const status = (rows: unknown) => ({ workspace: { name: "Infinite workspace" }, connections: decodeStatusConnections(rows) });
  const bar = (rows: unknown, width: number) => topBarLines(desktopTopBarData(status(rows)), width, TRUECOLOR)[0]!;
  const expectGolden = (line: string, golden: GoldenLine) => {
    expect(stripAnsi(line).replace(/\s+$/u, "")).toBe(goldenText(golden));
    expect(renderedCells(line)).toEqual(goldenCells(golden, "truecolor"));
  };

  it("connected is a green dot and broken a red mark, broken first (region-topbar-ok)", () => {
    expectGolden(bar(WIRE_OK, 100), GOLDEN.topbarOk);
  });

  it("off is the amber mark and leads the bar (region-topbar-not-connected)", () => {
    expectGolden(bar(WIRE_ONE_OFF, 100), GOLDEN.topbarNotConnected);
  });

  it("dots that do not fit a narrow window are dropped (region-topbar-narrow-60)", () => {
    expectGolden(bar(WIRE_OK, 60), GOLDEN.topbarNarrow60);
  });

  it("says the session runs through the app when the whole line fits (boot--c160)", () => {
    expectGolden(bar(WIRE_OK, 160), GOLDEN.topbarWide160);
  });

  it("an old desktop (no connections in its status) draws no dots, as before", () => {
    const data = desktopTopBarData({ workspace: { name: "Infinite workspace" } });
    expect(data).toEqual({ workspace: "Infinite workspace", throughApp: true });
    const line = stripAnsi(topBarLines(data, 100, TRUECOLOR)[0]!);
    expect(line).not.toMatch(/[●⊘]/u);
    expect(line).toContain("Infinite workspace");
  });

  it("a desktop that knows of no connections draws none, and no workspace is the chip alone", () => {
    expect(desktopTopBarData({ workspace: { name: "Infinite workspace" }, connections: [] })).toEqual({
      workspace: "Infinite workspace", sources: [], throughApp: true
    });
    expect(desktopTopBarData({})).toEqual({ throughApp: true });
  });

  it("scrubs and bounds the workspace name", () => {
    expect(desktopTopBarData({ workspace: { name: "\u001b[31mInfinite\u001b[0m workspace" } }).workspace).toBe("Infinite workspace");
    expect(Array.from(desktopTopBarData({ workspace: { name: "W".repeat(300) } }).workspace!).length).toBeLessThanOrEqual(80);
  });
});
