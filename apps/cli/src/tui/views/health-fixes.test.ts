// Wave 3 r1 (TJ-4, W3-health-scopes): health rows are read, not browsed (r4
// view-10 has no `j k`); the same fix prints once; `o` opens the first fix, or
// the view's own place when no item has one; a headerless one-column table is
// a plain list. Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts } from "./focus.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const OPEN = { open: true, watch: false, retry: false };
const CONNECTIONS = { place: "connections", label: "Connections" };

function health(body: Record<string, unknown>, extra: Record<string, unknown> = {}): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "health", tool: "list_sources", title: "Connections", state: "ready", asOf: null,
    provenance: { source: "Connections", via: "our_db" },
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], body, ...extra
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const lines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail, ...render.footnotes].map(stripAnsi);

const TWO_SAME_FIXES = health({
  items: [
    { id: "a", name: "Site analytics", state: "ok", dataThrough: "2026-01-14" },
    { id: "b", name: "Payments", state: "error", blocker: "3 syncs in a row failed", fix: { label: "Reconnect payments", appLink: CONNECTIONS } },
    { id: "c", name: "Ads", state: "ok", dataThrough: "2026-01-14" },
    { id: "d", name: "Photos", state: "not_connected", fix: { label: "Reconnect payments", appLink: CONNECTIONS } }
  ]
}, { appLink: { place: "connections", label: "Open Connections" } });

describe("health: read, not browsed (TJ-4)", () => {
  it("rows are never selectable: no ▸, no j k, whatever the fixes", () => {
    for (const caps of [OPEN, { open: false, watch: false, retry: false }]) {
      const render = renderView(TWO_SAME_FIXES, ctx({ caps }));
      expect(render.rowCount).toBe(0);
      expect(lines(render).join("\n")).not.toContain("▸");
    }
  });

  it("the same fix prints once", () => {
    for (const caps of [OPEN, { open: false, watch: false, retry: false }]) {
      const out = lines(renderView(TWO_SAME_FIXES, ctx({ caps })));
      expect(out.filter((line) => line.includes("Reconnect payments"))).toHaveLength(1);
    }
    expect(lines(renderView(TWO_SAME_FIXES, ctx({ caps: OPEN })))).toContain("Fix it: Reconnect payments ↗  (o) · Connections");
  });

  it("o opens the first fix, whatever row the view opened on, and the bar names o", () => {
    const render = renderView(TWO_SAME_FIXES, ctx({ caps: OPEN }));
    expect(render.openLink).toEqual({ place: "connections" });
    expect(render.openLabel).toBe("Reconnect payments");
    const state = resolveViewKey("", viewFocusAfterTurnDone(TWO_SAME_FIXES, OPEN), { tab: true });
    const pressed = resolveViewKey("o", state, {}, viewKeyFacts(TWO_SAME_FIXES, render));
    expect(pressed.effect).toEqual({ type: "open", target: { place: "connections" } });
  });

  it("with no item fix, o opens the view's own place", () => {
    const fine = health({ items: [{ id: "a", name: "Site analytics", state: "ok" }] }, { appLink: { place: "connections", label: "Open Connections" } });
    const render = renderView(fine, ctx({ caps: OPEN }));
    expect(render.openLink).toEqual({ place: "connections" });
    expect(render.openLabel).toBe("Open Connections");
  });

  it("without app.open, no ↗ and no (o) anywhere (an older desktop)", () => {
    const out = lines(renderView(TWO_SAME_FIXES, ctx())).join("\n");
    expect(out).toContain("Fix it: Reconnect payments");
    expect(out).not.toMatch(/↗|\(o\)/u);
  });
});

describe("a one-column table with no header label is a plain list (W3-health-scopes)", () => {
  const store = health({
    items: [{ id: "store", name: "Demo store", state: "ok" }],
    sections: [{
      title: "Themes", kind: "list",
      body: {
        layout: "rows", columns: [],
        rows: [
          { id: "t1", title: "Dawn", status: { word: "Live", tone: "ok" }, cells: {} },
          { id: "t2", title: "Dawn copy", status: { word: "Not published", tone: "muted" }, cells: {} }
        ],
        total: 2, shown: 2
      }
    }]
  }, { title: "Store" });

  for (const width of [48, 60, 100, 140]) {
    it(`no empty boxed header, one line per row with its status (${width} columns)`, () => {
      const out = lines(renderView(store, ctx({ width })));
      expect(out.join("\n")).not.toMatch(/[┌├└│]/u);
      const at = out.indexOf("Themes");
      expect(at).toBeGreaterThan(0);
      expect(out[at + 1]).toMatch(/^Dawn +Live$/u);
      expect(out[at + 2]).toMatch(/^Dawn copy +Not published$/u);
      for (const line of out) expect(line.length, line).toBeLessThanOrEqual(width);
    });
  }
});
