// Wave 3 r1, numbers: a day not verified is `—` with its own words (TJ-8 /
// N30), never `?`; a long name prefix the rows share is said once and each row
// shows what tells it apart (N28); a window's `as of` that repeats the source
// line's is not said twice (W3-num-zero). Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});

function numbers(body: Record<string, unknown>, extra: Record<string, unknown> = {}): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "numbers", tool: "read_ads", title: "Ads since launch", state: "ready", asOf: "2026-01-15T18:30:00Z",
    provenance: { source: "Demo ads", via: "our_db" },
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
const SPEND = { key: "spend", label: "Spend", unit: "money", factGroup: "delivery" };
const CLICKS = { key: "clicks", label: "Clicks", unit: "count", factGroup: "delivery" };

describe("a day not verified is a dash with its own words (TJ-8 / N30)", () => {
  const days = ["2026-01-10", "2026-01-11", "2026-01-12", "2026-01-13", "2026-01-14"];
  const view = numbers({
    layout: "table", currency: "USD", columns: [SPEND],
    legs: {
      settled: {
        window: { from: days[0], to: days[4], tz: "UTC", label: "Last 5 days" }, final: true, asOf: "2026-01-15T06:00:00Z",
        rows: [{ id: "c1", label: "Campaign one", cells: { spend: { value: 10 } } }],
        coverage: {
          requestedDays: 5, measuredDays: 3,
          days: [
            { date: days[0], status: "measured" }, { date: days[1], status: "not_verified" }, { date: days[2], status: "measured" },
            { date: days[3], status: "not_measured" }, { date: days[4], status: "measured" }
          ]
        }
      }
    }
  });

  for (const width of [48, 60, 100, 140]) {
    it(`never a ?; the legend names it 'not verified' (${width} columns)`, () => {
      const out = lines(renderView(view, ctx({ width })));
      const strip = out.find((line) => line.startsWith("Days "))!;
      expect(strip).not.toContain("?");
      expect(strip).toContain("█—█—█");
      const legend = out.join("\n");
      expect(legend).toContain("— not verified");
      expect(legend).toContain("— not measured");
      for (const line of out) expect(line.length, line).toBeLessThanOrEqual(width);
    });
  }
});

describe("rows that share a long name prefix say it once (N28)", () => {
  const prefix = "Sample tests with a long shared name ";
  const view = numbers({
    layout: "table", currency: "USD", rowLabel: "Campaign", columns: [SPEND, CLICKS],
    legs: {
      settled: {
        window: { from: "2026-01-01", to: "2026-01-14", tz: "UTC", label: "Since launch" }, final: true, asOf: "2026-01-15T06:00:00Z",
        rows: ["version-1", "version-2", "version-4"].map((name, index) => ({
          id: `r${index}`, label: `${prefix}${name}`, cells: { spend: { value: 14 + index }, clicks: { value: 40 + index } }
        })),
        totals: { spend: { value: 45 }, clicks: { value: 123 } }
      }
    }
  });

  for (const width of [60, 100, 140]) {
    it(`each row shows the part that tells it apart; the prefix is said once (${width} columns)`, () => {
      const out = lines(renderView(view, ctx({ width })));
      const table = out.filter((line) => line.startsWith("│"));
      for (const name of ["version-1", "version-2", "version-4"]) {
        expect(table.some((line) => line.includes(`… ${name}`)), name).toBe(true);
      }
      expect(table.join("\n")).not.toContain("shared");
      expect(out.filter((line) => line.includes("Sample tests with a long shared name"))).toHaveLength(1);
      expect(table.some((line) => line.includes("Total"))).toBe(true);
      for (const line of out) expect(line.length, line).toBeLessThanOrEqual(width);
    });
  }

  it("→ shows every row's whole name", () => {
    const out = lines(renderView(view, ctx({ width: 60, showHiddenColumns: true }))).join("\n");
    expect(out).toContain(`${prefix}version-2`);
  });

  it("short names, or names with no long shared start, stay as they are", () => {
    const short = numbers({
      layout: "table", currency: "USD", columns: [SPEND],
      legs: { settled: { window: { from: "2026-01-01", to: "2026-01-14", tz: "UTC", label: "Since launch" }, final: true,
        rows: [{ id: "a", label: "Demo A", cells: { spend: { value: 1 } } }, { id: "b", label: "Demo B", cells: { spend: { value: 2 } } }] } }
    });
    const out = lines(renderView(short, ctx())).join("\n");
    expect(out).toContain("│ Demo A");
    expect(out).not.toContain("…");
  });
});

describe("a kpis window's 'as of' that repeats the source line's is said once (W3-num-zero)", () => {
  const view = numbers({
    layout: "kpis", currency: null, columns: [
      { key: "matches", label: "Matches", unit: "count", factGroup: "audience" },
      { key: "checked", label: "Checked", unit: "count", factGroup: "audience" }
    ],
    legs: { settled: {
      window: { from: "2026-01-15", to: "2026-01-15", tz: "UTC", label: "Now" }, final: false, asOf: "2026-01-15T18:30:00Z",
      rows: [], totals: { matches: { value: 0 }, checked: { value: 52 } }
    } }
  });

  it("the window line keeps 'not final' and drops the repeated 'as of'; a measured zero stays 0", () => {
    const out = lines(renderView(view, ctx()));
    expect(out.join("\n").match(/as of/gu)).toHaveLength(1);
    expect(out).toContain("Now · Jan 15 · not final");
    expect(out.some((line) => /^Matches +0$/u.test(line))).toBe(true);
  });

  it("a leg read at another instant keeps its own 'as of'", () => {
    const other = numbers({ ...(view.body as unknown as Record<string, unknown>), legs: { settled: { ...(view.body as unknown as { legs: { settled: Record<string, unknown> } }).legs.settled, asOf: "2026-01-15T17:00:00Z" } } });
    expect(lines(renderView(other, ctx()))).toContain("Now · Jan 15 · not final · as of 17:00");
  });
});

// Wave 3 r2 (W3-num-gads): the head's chip already says `stateReason.short`
// (`◐ 6 of 7 days in`); a title that only says the same words again
// (`6 of 7 days are in`) gives way to what the numbers are of, the source.
describe("the head does not say the chip's words twice (W3-num-gads)", () => {
  const partial = (title: string, short: string | null) => numbers({
    layout: "table", currency: "USD", columns: [SPEND],
    legs: {
      settled: {
        window: { from: "2026-01-08", to: "2026-01-14", tz: "UTC", label: "Jan 8–14" }, final: true, asOf: "2026-01-15T06:00:00Z",
        rows: [{ id: "c1", label: "Campaign one", cells: { spend: { value: 10 } } }]
      }
    }
  }, {
    title, state: "partial",
    stateReason: { code: "partial_coverage", words: "Jan 12 is not in yet.", ...(short ? { short } : {}) }
  });

  for (const width of [60, 100, 140]) {
    it(`a title that repeats the short gives way to the source (${width} columns)`, () => {
      const head = lines(renderView(partial("6 of 7 days are in", "6 of 7 days in"), ctx({ width })))[0]!;
      expect(head).toContain("◐ 6 of 7 days in");
      expect(head.match(/6 of 7 days/gu) ?? []).toHaveLength(1);
      expect(head).toContain("Demo ads");
    });
  }

  it("a title with words of its own stays", () => {
    const head = lines(renderView(partial("Ads since launch", "6 of 7 days in"), ctx()))[0]!;
    expect(head).toContain("Ads since launch");
    expect(head).toContain("◐ 6 of 7 days in");
  });

  it("with no short, the chip says the generic words and the title stays", () => {
    const head = lines(renderView(partial("6 of 7 days are in", null), ctx()))[0]!;
    expect(head).toContain("6 of 7 days are in");
    expect(head).toContain("◐ Partial");
  });

  it("with no source either, the head is the chip alone", () => {
    const view = numbers({ layout: "kpis", columns: [SPEND], legs: { settled: { window: { from: "2026-01-14", to: "2026-01-14", tz: "UTC", label: "Jan 14" }, final: true, rows: [{ id: "t", label: "Total", cells: { spend: { value: 0 } } }] } } },
      { title: "1 of 2 days are in", state: "partial", provenance: undefined, stateReason: { code: "partial_coverage", words: "One day is not in yet.", short: "1 of 2 days in" } });
    const head = lines(renderView(view, ctx()))[0]!;
    expect(head.trim()).toBe("◐ 1 of 2 days in");
  });
});
