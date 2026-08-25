import React from "react";
import { describe, expect, it } from "vitest";

import {
  HomeInventory,
  homeInventoryRowCount,
  type HomeInventoryProps
} from "./home-inventory.js";
import { Box, Text, renderToString } from "./renderer.js";

const BASE: HomeInventoryProps = {
  tools: [
    { label: "connect" },
    { label: "sync" },
    { label: "generate ads" },
    { label: "insights" }
  ],
  commands: [
    { value: "/connect" },
    { value: "/sync" },
    { value: "/help" },
    { value: "/exit" }
  ],
  connections: [
    { label: "X" },
    { label: "Facebook" },
    { label: "GA4", degraded: true }
  ],
  version: "0.1.1",
  workspace: "Acme",
  columns: 88
};

function render(props: Partial<HomeInventoryProps> = {}, columns = 88): string {
  return renderToString(
    React.createElement(HomeInventory, { ...BASE, ...props, columns }),
    { columns }
  );
}

// Render the inventory with a trailing SENTINEL row after it, mirroring the live
// session where `InkTranscriptApp` always follows. This preserves the panel's
// trailing blank spacer (Ink collapses a trailing blank only when it's the very
// last row of a render) so the row count we measure is the height the panel
// actually occupies above the transcript — exactly what the composer's
// native-cursor prediction adds via `homeInventoryRowCount`.
function renderWithSentinel(props: Partial<HomeInventoryProps> = {}, columns = 88): number {
  const SENTINEL = "::sentinel::";
  const out = renderToString(
    React.createElement(
      Box,
      { flexDirection: "column", width: columns },
      React.createElement(HomeInventory, { ...BASE, ...props, columns }),
      React.createElement(Text, { key: "sentinel" }, SENTINEL)
    ),
    { columns }
  );
  // Rows above the sentinel = the panel's rendered height.
  return out.split("\n").findIndex((line) => line.includes(SENTINEL));
}

describe("HomeInventory", () => {
  it("renders the big INFINITE wordmark, tagline, version and workspace on a wide terminal", () => {
    const out = render();
    // The reused ANSI-shadow block art (NOT a hand-drawn duplicate).
    expect(out).toContain("██╗");
    expect(out).toContain("███████╗");
    expect(out).toContain("the growth engineer's OS");
    expect(out).toContain("v0.1.1");
    expect(out).toContain("workspace: Acme");
  });

  it("renders the curated Tools and Commands rows", () => {
    const out = render();
    expect(out).toContain("Tools");
    expect(out).toContain("connect");
    expect(out).toContain("generate ads");
    expect(out).toContain("Commands");
    expect(out).toContain("/connect");
    expect(out).toContain("/help");
    expect(out).toContain("/exit");
  });

  it("renders the live Connected row with ticks for connected/degraded sources", () => {
    const out = render();
    expect(out).toContain("Connected");
    expect(out).toContain("X");
    expect(out).toContain("Facebook");
    expect(out).toContain("GA4");
    // A connected source gets a filled tick; a degraded one a hollow marker.
    expect(out).toContain("✓");
    expect(out).toContain("◐");
  });

  it("renders the welcome line", () => {
    const out = render();
    expect(out).toContain("Welcome to Infinite");
    expect(out).toContain("/help");
    expect(out).toContain("/exit");
  });

  it("degrades gracefully when connections are unavailable (daemon not reachable)", () => {
    const out = render({ connections: undefined });
    // Still renders the inventory — just a muted note instead of the live line.
    expect(out).toContain("Tools");
    expect(out).toContain("Commands");
    expect(out).toContain("Connected");
    expect(out).toContain("daemon not reachable");
    // No false "connected" ticks when the fetch failed.
    expect(out).not.toContain("✓");
  });

  it("shows a 'nothing connected' nudge when the daemon answers with no sources", () => {
    const out = render({ connections: [] });
    expect(out).toContain("Connected");
    expect(out).toContain("nothing connected yet");
    expect(out).not.toContain("✓");
  });

  it("falls back to the compact wordmark on a narrow terminal", () => {
    const out = render({}, 40);
    expect(out).toContain("INFINITE");
    expect(out).toContain("Tools");
    // The 54-col block art cannot fit at 40 cols.
    expect(out).not.toContain("███████╗");
  });

  it("renders exactly homeInventoryRowCount rows (the composer-cursor prediction invariant)", () => {
    // Wide: big art (6 rows) + the fixed body rows.
    expect(renderWithSentinel()).toBe(homeInventoryRowCount(88));

    // Narrow: compact wordmark (1 row) + the same fixed body rows.
    expect(renderWithSentinel({}, 40)).toBe(homeInventoryRowCount(40));

    // The row count must NOT change whether the live line, the muted note, or the
    // empty nudge renders — the Connected row is always exactly one row.
    expect(renderWithSentinel({ connections: undefined })).toBe(homeInventoryRowCount(88));
    expect(renderWithSentinel({ connections: [] })).toBe(homeInventoryRowCount(88));
  });
});
