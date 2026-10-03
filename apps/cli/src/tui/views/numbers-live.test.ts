// The numbers view the r4 way, on a view shaped like the live eval's (run-2
// M7): one row in the main table, a today leg of totals, a funnel, a day
// strip, and four sections (by day, the prior period, sign-ups, billing
// trials). Every name and number is synthetic (infinite-os is public); only
// the SHAPE copies the live view.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { viewFocusAfterTurnDone, viewKeyHints } from "./focus.js";
import { paneWidths, renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function live(): AnswerViewV1 {
  const view = decodeAnswerView(JSON.parse(readFileSync(`${FIXTURES}numbers-live-week.json`, "utf8")));
  if (!view) throw new Error("numbers-live-week does not decode");
  return view;
}

/** The fixture with its body edited (a deep copy). */
function edited(edit: (body: Record<string, any>, view: Record<string, any>) => void): AnswerViewV1 {
  const view = JSON.parse(JSON.stringify(live())) as Record<string, any>;
  edit(view.body as Record<string, any>, view);
  return view as unknown as AnswerViewV1;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const draw = (view: AnswerViewV1, overrides: Partial<ViewRenderCtx> = {}): ViewRender => renderView(view, ctx(overrides));
const all = (render: ViewRender) => [...render.detail, ...render.footnotes];

const messages: Msg[] = [
  { role: "user", text: "how are my ads this week?" },
  { role: "assistant", text: "Spend is up; clicks are down." }
];
const liveTurn = (views: AnswerViewV1[], width: number) =>
  renderLiveTurn({ messages, views, focus: viewFocusAfterTurnDone(views), width, color: false, theme, timeZone: "UTC" }).lines;
const committedTurn = (views: AnswerViewV1[], width: number) =>
  renderCommittedTurn({ messages, views, focus: null, width, color: false, theme, timeZone: "UTC" });
/** At 120 and up the details pane is right of ` │ `: its own lines. */
const detailsOf = (lines: readonly string[], width: number, split = true) => {
  const panes = paneWidths(width);
  return panes.wide && split ? lines.map((line) => line.slice(panes.left + 3)) : [...lines];
};

/** A `label: value` record line (the long dump the live eval saw). */
const RECORD = /^\s*(?:Status|Spent|Day|Impressions|Link clicks|CTR \(link\)|CPC \(link\)|CPM|Results|Cost per result|ROAS|Result): /u;

describe("numbers, the live shape: one bordered table per block, never records (run-2 M7)", () => {
  it.each([60, 100, 140])("at %i, live and committed, every block is a table and nothing prints as label: value records", (width) => {
    for (const [lines, split] of [[liveTurn([live()], width), true], [committedTurn([live()], width), false]] as const) {
      const details = detailsOf(lines, width, split);
      expect(details.filter((line) => RECORD.test(line))).toEqual([]);
      // The main table, by day, the prior period, sign-ups, billing trials: five tables.
      expect(details.filter((line) => line.startsWith("┌"))).toHaveLength(5);
      expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
      // About a screen and a half, never ~150 lines.
      expect(lines.length).toBeLessThan(90);
    }
  });

  it("the r4 look at 100: the one-row table wraps its long name, names what it hid, and has no Total", () => {
    const detail = draw(live()).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    expect(detail.slice(at, at + 9)).toEqual([
      "Sep 28 – Oct 1",
      "┌────────────────────────┬───────────────────────┬─────────┬─────────────┬────────────┬──────┐",
      "│                        │ Status                │   Spent │ Link clicks │ CTR (link) │ ROAS │",
      "├────────────────────────┼───────────────────────┼─────────┼─────────────┼────────────┼──────┤",
      "│ Sample · Trials · US · │ Numbers not confirmed │ $212.40 │          47 │      5.87% │   —¹ │",
      "│ 2026-09-01 —           │                       │         │             │            │      │",
      "│ sample_b1_trial_us     │                       │         │             │            │      │",
      "└────────────────────────┴───────────────────────┴─────────┴─────────────┴────────────┴──────┘",
      "+ Impressions, Cost per result, CPM, CPC (link), Result, Results · → to see"
    ]);
    expect(detail.some((line) => /│ Total /u.test(line))).toBe(false);
  });

  it("the r4 look at 60: the same table keeps spend, the rate and ROAS, and names the rest", () => {
    const detail = draw(live(), { width: 60 }).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    expect(detail.slice(at + 1, at + 10)).toEqual([
      "┌────────────────────────┬─────────┬────────────┬──────┐",
      "│                        │   Spent │ CTR (link) │ ROAS │",
      "├────────────────────────┼─────────┼────────────┼──────┤",
      "│ Sample · Trials · US · │ $212.40 │      5.87% │   —¹ │",
      "│ 2026-09-01 —           │         │            │      │",
      "│ sample_b1_trial_us     │         │            │      │",
      "└────────────────────────┴─────────┴────────────┴──────┘",
      "+ Impressions, Cost per result, CPM, CPC (link), Result,",
      "Results, Link clicks, Status · → to see"
    ]);
  });

  it("the r4 look at 140: the details pane draws the by-day table whole, with no Day column", () => {
    const details = detailsOf(liveTurn([live()], 140), 140);
    const at = details.indexOf("By day");
    expect(details.slice(at, at + 9)).toEqual([
      "By day",
      "┌────────┬────────┬─────────────┬─────────────┬────────────┬───────────────┬────────────────┐",
      "│        │  Spent │ Impressions │ Link clicks │ CTR (link) │ Registrations │ Website trials │",
      "├────────┼────────┼─────────────┼─────────────┼────────────┼───────────────┼────────────────┤",
      "│ Sep 28 │ $28.10 │         110 │           9 │      8.18% │            —³ │             —² │",
      "│ Sep 29 │ $61.20 │         240 │          12 │      5.00% │            —³ │             —² │",
      "│ Sep 30 │ $63.50 │         231 │          11 │      4.76% │             1 │             —² │",
      "│ Oct 1  │ $59.60 │         220 │          15 │      6.82% │            —³ │             —² │",
      "└────────┴────────┴─────────────┴─────────────┴────────────┴───────────────┴────────────────┘"
    ]);
    expect(details.join("\n")).not.toMatch(/2026-09-28|Day\b/u);
  });

  it("a section is ONE heading line over its table: sign-ups, the prior period as one row of its days, billing trials", () => {
    const detail = draw(live()).detail;
    expect(detail).toContain("Our sign-ups · Sep 28 – Oct 2 (today so far) · not final");
    expect(detail).toContain("Billing trials · Sep 28 – Oct 1 (UTC days)");
    const prior = detail.indexOf("Prior 4 days");
    expect(detail[prior + 4]).toBe("│ Sep 24 – 27 │ $171.30 │         121 │      8.06% │             1 │             —² │   —¹ │");
    // `New trials` once per row, never as a heading over its own column.
    expect(detail.filter((line) => /New trials\b/u.test(line) && !line.startsWith("│"))).toEqual([]);
    expect(detail).toContain("│ New trials                                │                    1 │");
  });
});

describe("numbers, the live shape: what is drawn (run-2 M7)", () => {
  it("a Total row prints only under two or more rows", () => {
    expect(all(draw(live())).some((line) => /\bTotal\b/u.test(line))).toBe(false);
    const two = edited((body) => {
      const second = JSON.parse(JSON.stringify(body.legs.settled.rows[0]));
      second.id = "c_2";
      second.label = "Second campaign";
      body.legs.settled.rows.push(second);
    });
    const totals = draw(two).detail.filter((line) => /│ Total /u.test(line));
    expect(totals).toHaveLength(1);
    // The Total says nothing in the Status and Result columns: blank, never a dash.
    expect(totals[0]).not.toMatch(/—\s*│\s*\$/u);
  });

  it("a measure the read did not carry is not drawn: no Results or Cost per result in today's pairs, no `did not carry` note", () => {
    const render = draw(live());
    const today = render.detail.indexOf("Oct 2 so far · not final · as of 15:30");
    const block = render.detail.slice(today, render.detail.indexOf("", today));
    expect(block).toEqual([
      "Oct 2 so far · not final · as of 15:30",
      "Spent        $38.90",
      "Impressions  179",
      "Link clicks  16",
      "CTR (link)   8.94%",
      "CPC (link)   $2.43",
      "CPM          $217.32",
      "ROAS         —¹"
    ]);
    expect(all(render).join("\n")).not.toContain("did not carry");
  });

  it("a day column that is not the row's own date prints as r4 writes days (`Sep 30`), never `2026-09-30`", () => {
    const view = edited((body) => {
      body.sections[0].body.legs.settled.rows.forEach((row: any) => { row.label = `Campaign ${row.id.slice(-2)}`; });
    });
    const detail = draw(view).detail.join("\n");
    expect(detail).toMatch(/│ Campaign 28 │ Sep 28 /u);
    expect(detail).not.toContain("2026-09-28");
  });

  it("ONE day strip per view, and today synced so far is `◌ today, not final` (run-2 N14)", () => {
    const detail = draw(live()).detail;
    expect(detail.filter((line) => line.startsWith("Days "))).toEqual(["Days Sep 28 ████◌ Oct 2"]);
    expect(detail).toContain("     █ spent   ◌ today, not final");
    const unsynced = edited((body) => { body.legs.today.asOf = null; });
    expect(draw(unsynced).detail).toContain("     █ spent   ◌ today, not synced yet");
  });

  it("no verdict-source note (r4 draws none)", () => {
    expect(all(draw(live())).join("\n")).not.toMatch(/Verdicts|verdict rules/u);
  });

  it("footnotes: one line per reason, and only for marks the view shows", () => {
    const render = draw(live());
    expect(render.footnotes).toEqual(["¹ no purchase value counted", "² the provider hasn't confirmed the count", "³ none credited yet"]);
    const shown = render.detail.join("\n");
    for (const mark of ["¹", "²", "³"]) expect(shown).toContain(mark);
  });
});

describe("numbers, the live shape: empty and unmeasured sections (run-2 M7)", () => {
  it("a section whose every number is unmeasured is ONE dim line saying why, with no table and no footnote", () => {
    const why = { code: "prior_period_incomplete", words: "the prior period is not complete", show: "dash" };
    const view = edited((body) => {
      const prior = body.sections[1].body.legs.settled;
      prior.window = { from: "2026-09-18", to: "2026-09-24", tz: "UTC", label: "Sep 18 – 24" };
      prior.final = false;
      for (const key of Object.keys(prior.totals)) prior.totals[key] = { value: null, reason: why };
      body.sections[1].title = "Prior 7 days";
    });
    const render = draw(view);
    expect(render.detail).toContain("Prior 7 days · Sep 18 – 24 · the prior period is not complete");
    expect(render.detail.join("\n")).not.toMatch(/not final[^\n]*\n┌[^\n]*\n[^\n]*Spent/u);
    expect(render.footnotes.join("\n")).not.toContain("prior period");
    // Mixed reasons say `not measured`.
    const mixed = edited((body) => {
      const totals = body.sections[1].body.legs.settled.totals;
      for (const key of Object.keys(totals)) totals[key] = { value: null, reason: key === "spend" ? why : { code: "x", words: "other", show: "dash" } };
    });
    expect(draw(mixed).detail).toContain("Prior 4 days · Sep 24 – 27 · not measured");
  });

  it("an empty section is nothing: no title over no lines", () => {
    const view = edited((body) => {
      body.sections[3].body.legs.settled.rows = [];
    });
    expect(draw(view).detail.join("\n")).not.toContain("Billing trials");
  });

  it("a period that ended before the view's day is never `not final` (settled sign-ups, the live T3)", () => {
    const view = edited((body) => {
      body.sections[2].body.legs.settled.window = { from: "2026-09-25", to: "2026-10-01", tz: "UTC", label: "Sep 25 – Oct 1" };
    });
    expect(draw(view).detail).toContain("Our sign-ups · Sep 25 – Oct 1");
    // One that runs into the view's day keeps it.
    expect(draw(live()).detail).toContain("Our sign-ups · Sep 28 – Oct 2 (today so far) · not final");
  });
});

describe("numbers: `→ to see` only where → works (run-2 M7)", () => {
  it("the live turn's focused view names the key; committed to scrollback it names what is hidden, in words", () => {
    const hint = (lines: readonly string[]) => lines.filter((line) => line.includes("Cost per result, CPM"));
    expect(hint(liveTurn([live()], 100))).toEqual(["+ Impressions, Cost per result, CPM, CPC (link), Result, Results · → to see"]);
    expect(hint(committedTurn([live()], 100))).toEqual(["+ Impressions, Cost per result, CPM, CPC (link), Result, Results hidden"]);
    expect(committedTurn([live()], 100).join("\n")).not.toContain("→");
  });

  it("a view the keys are not on names what it hid in words too", () => {
    const other = edited((_body, view) => { view.title = "Another read"; });
    const lines = liveTurn([live(), other], 100);
    const hints = lines.filter((line) => line.startsWith("+ Impressions, Cost per result"));
    // The first view is not focused (the keys are on the last one).
    expect(hints).toEqual([
      "+ Impressions, Cost per result, CPM, CPC (link), Result, Results hidden",
      "+ Impressions, Cost per result, CPM, CPC (link), Result, Results · → to see"
    ]);
  });

  it("after → the focused table shows every column as records (records only after →)", () => {
    const detail = draw(live(), { showHiddenColumns: true }).detail.join("\n");
    expect(detail).toMatch(/Cost per result: —/u);
  });
});

describe("the view's `?` is the key bar's (run-2 N12)", () => {
  it("no `? what it does` line inside the view, live or committed; the bar offers it", () => {
    for (const width of [60, 100, 140]) {
      expect(liveTurn([live()], width).join("\n")).not.toContain("what it does");
      expect(committedTurn([live()], width).join("\n")).not.toContain("what it does");
    }
    expect(viewKeyHints(viewFocusAfterTurnDone([live()]))).toContainEqual({ key: "?", label: "what it does" });
  });
});

