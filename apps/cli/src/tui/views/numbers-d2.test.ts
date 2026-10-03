// Wave 3 r3 (io-term, D2): a numbers view in partial / out of date / not
// measured / nothing found goes compact (its head and ONE line: the host's
// state reason) ONLY when its table would be all dashes: no rows, or every
// number null. Any real number, a measured 0 included, keeps the measured
// table. The rule reads the cells and the state; it computes no number. The
// same rule is pinned on the Cmd+L card. Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const SPEND = { key: "spend", label: "Spend", unit: "money", factGroup: "delivery" };
const CLICKS = { key: "clicks", label: "Clicks", unit: "count", factGroup: "delivery" };
const WINDOW = { from: "2026-01-10", to: "2026-01-14", tz: "UTC", label: "Jan 10–14" };
const NULL = (words: string) => ({ value: null, reason: { code: "sample_code", words, show: "dash" } });

function numbers(state: string, rows: unknown[], extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "numbers", tool: "read_ads", title: "Sample campaign", state, asOf: "2026-01-15T06:00:00Z",
    provenance: { source: "Demo ads", via: "our_db" }, scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { layout: "table", currency: "USD", columns: [SPEND, CLICKS], rowLabel: "Campaign", legs: { settled: { window: WINDOW, final: true, rows } }, ...body },
    ...extra
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (width: number): ViewRenderCtx => ({
  width, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC"
});
const lines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail, ...render.footnotes].map(stripAnsi);
const reason = (code: string, words: string) => ({ stateReason: { code, words } });
const row = (id: string, label: string, spend: unknown, clicks: unknown) => ({ id, label, cells: { spend, clicks } });

describe("D2: a numbers view goes compact only when its table would be all dashes", () => {
  for (const width of [60, 100, 140]) {
    it(`not measured, every cell null → the head and the host's one line, no dashes, no table (${width} columns)`, () => {
      const view = numbers("not_measured", [row("c1", "Ad A", NULL("not synced yet"), NULL("not synced yet"))], reason("not_synced", "Nothing is synced for this window yet."));
      const out = lines(renderView(view, ctx(width)));
      expect(out.join("\n")).toContain("Nothing is synced for this window yet.");
      expect(out.join("\n")).not.toContain("—¹");
      expect(out.join("\n")).not.toContain("┌");
      expect(out.join("\n")).not.toContain("not synced yet");
      expect(out.filter((line) => line.trim()).length).toBeLessThanOrEqual(3);
      for (const line of out) expect(line.length).toBeLessThanOrEqual(width);
    });

    it(`partial, every cell null → compact too (${width} columns)`, () => {
      const view = numbers("partial", [row("c1", "Ad A", NULL("not in yet"), NULL("not in yet"))], reason("partial", "No day of this window is in yet."));
      const out = lines(renderView(view, ctx(width))).join("\n");
      expect(out).toContain("No day of this window is in yet.");
      expect(out).not.toContain("┌");
      expect(out).not.toContain("—");
    });

    it(`nothing found with no rows → the head and one line (${width} columns)`, () => {
      const view = numbers("nothing_found", [], reason("nothing_found", "No spend Jan 10–14 · 3 campaigns checked"));
      const out = lines(renderView(view, ctx(width)));
      expect(out.join("\n")).toContain("No spend Jan 10–14 · 3 campaigns checked");
      expect(out.join("\n")).not.toContain("┌");
      expect(out.filter((line) => line.trim()).length).toBeLessThanOrEqual(3);
    });

    it(`partial with real numbers keeps the measured table; the null stays a dash with its reason (${width} columns)`, () => {
      const view = numbers("partial", [row("c1", "Ad A", { value: 12.34 }, NULL("not in yet")), row("c2", "Ad B", { value: 5 }, { value: 40 })], reason("partial", "4 of 5 days in"));
      const out = lines(renderView(view, ctx(width))).join("\n");
      expect(out).toContain("$12.34");
      expect(out).toContain("—");
      expect(out).toContain("not in yet");
    });

    it(`out of date with a measured 0 and nulls keeps the table: 0 is a real number (${width} columns)`, () => {
      const view = numbers("out_of_date", [row("c1", "Ad A", { value: 0 }, NULL("not synced yet"))], reason("stale", "Data only through Jan 12."));
      const out = lines(renderView(view, ctx(width))).join("\n");
      expect(out).toMatch(/\$0\.00|\b0\b/u);
      expect(out).toContain("—");
      expect(out).toContain("not synced yet");
    });
  }

  it("compact keeps the day strip: it says which days are in, never a number (r4 flow-numbers-03)", () => {
    const view = numbers("partial", [row("c1", "Ad A", NULL("not in yet"), NULL("not in yet"))], reason("partial", "1 of 2 days in"), {
      legs: { settled: { window: { from: "2026-01-13", to: "2026-01-14", tz: "UTC", label: "Jan 13–14" }, final: false, rows: [row("c1", "Ad A", NULL("not in yet"), NULL("not in yet"))], coverage: {
        requestedDays: 2, measuredDays: 1, days: [{ date: "2026-01-13", status: "measured" }, { date: "2026-01-14", status: "not_synced" }]
      } } }
    });
    const out = lines(renderView(view, ctx(100)));
    expect(out.find((line) => line.startsWith("Days "))).toBeDefined();
    expect(out.join("\n")).not.toContain("┌");
    expect(out.join("\n")).not.toContain("not in yet");
  });

  it("the rule reads the state too: a ready view of dashes still draws its dashes and reasons", () => {
    const view = numbers("ready", [row("c1", "Ad A", NULL("not reported"), NULL("not reported"))]);
    const out = lines(renderView(view, ctx(100))).join("\n");
    expect(out).toContain("—");
    expect(out).toContain("not reported");
  });

  it("with no state reason words there is no line to stand in, so the dashes and their reasons stay", () => {
    const view = numbers("not_measured", [row("c1", "Ad A", NULL("not synced yet"), NULL("not synced yet"))]);
    const out = lines(renderView(view, ctx(100))).join("\n");
    expect(out).toContain("—");
    expect(out).toContain("not synced yet");
  });

  it("a kpi view of one null number goes compact (the not-synced read)", () => {
    const view = numbers("not_measured", [{ id: "value", label: "Sessions", cells: { sessions: NULL("not synced yet") } }], reason("not_synced", "Sessions is not measured for this window (not synced yet)."), {
      layout: "kpis", currency: null, columns: [{ key: "sessions", label: "Sessions", unit: "count", factGroup: "sample" }]
    });
    const out = lines(renderView(view, ctx(100)));
    expect(out.join("\n")).toContain("Sessions is not measured for this window (not synced yet).");
    expect(out.join("\n")).not.toContain("—¹");
    expect(out.join("\n")).not.toContain("¹ not synced yet");
  });
  // A composite's other sections are not numbers: a list's row names or a
  // health item's state are content, so the body stays even when every number
  // is null. A numbers section of all nulls stays quiet as before.
  const nullRows = [row("c1", "Ad A", NULL("not in yet"), NULL("not in yet"))];
  const listSection = {
    kind: "list", title: "Sample list",
    body: { layout: "rows", columns: [], rows: [{ id: "r1", title: "Sample row one", cells: {} }], total: 1, shown: 1 }
  };
  const healthSection = {
    kind: "health", title: "Sample sources",
    body: { items: [{ id: "s1", name: "Sample source", state: "needs_you", blocker: "Sample blocker words" }] }
  };
  for (const width of [60, 100, 140]) {
    it(`a composite whose list section has rows keeps its body (${width} columns)`, () => {
      const view = numbers("partial", nullRows, reason("partial", "No day of this window is in yet."), { layout: "composite", sections: [listSection] });
      const out = lines(renderView(view, ctx(width))).join("\n");
      expect(out).toContain("Sample row one");
    });
  }

  it("a composite whose health section has an item keeps its body", () => {
    const view = numbers("partial", nullRows, reason("partial", "No day of this window is in yet."), { layout: "composite", sections: [healthSection] });
    expect(lines(renderView(view, ctx(100))).join("\n")).toContain("Sample source");
  });

  it("a composite whose sections are all-null numbers still goes compact", () => {
    const numbersSection = {
      kind: "numbers", title: "Sample section",
      body: { layout: "table", currency: "USD", columns: [SPEND], rowLabel: "Campaign", legs: { settled: { window: WINDOW, final: true, rows: [{ id: "x", label: "Ad B", cells: { spend: NULL("not in yet") } }] } } }
    };
    const view = numbers("partial", nullRows, reason("partial", "No day of this window is in yet."), { layout: "composite", sections: [numbersSection] });
    const out = lines(renderView(view, ctx(100))).join("\n");
    expect(out).toContain("No day of this window is in yet.");
    expect(out).not.toContain("—");
    expect(out).not.toContain("Ad B");
  });

  it("a text cell counts as measured even when empty, the same rule as the Cmd+L card", () => {
    const view = numbers("partial", [row("c1", "Ad A", NULL("not in yet"), { text: "" })], reason("partial", "No day of this window is in yet."));
    expect(lines(renderView(view, ctx(100))).join("\n")).toContain("Ad A");
  });
});
