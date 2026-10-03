// The numbers view the r4 way, on a view shaped like the live eval's (run-2
// M7): one row in the main table, a today leg of totals, a funnel, a day
// strip, and four sections (by day, the prior period, sign-ups, billing
// trials). Every name and number is synthetic (infinite-os is public); only
// the SHAPE copies the live view.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { viewFocusAfterTurnDone, viewKeyHints } from "./focus.js";
import { paneWidths, renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { cellTableLines } from "./numbers.js";
import { FootnoteBook } from "./primitives.js";
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

  it("the r4 look at 100: the one-row table cuts its long name to one line, names what it hid, and has no Total (run-3 N18)", () => {
    const detail = draw(live()).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    expect(detail.slice(at, at + 7)).toEqual([
      "Sep 28 – Oct 1",
      "┌─────────────────────────────────────┬───────────────────────┬─────────┬─────────────┬────────────┐",
      "│                                     │ Status                │   Spent │ Link clicks │ CTR (link) │",
      "├─────────────────────────────────────┼───────────────────────┼─────────┼─────────────┼────────────┤",
      "│ Sample · Trials · US · 2026-09-01…  │ Numbers not confirmed │ $212.40 │          47 │      5.87% │",
      "└─────────────────────────────────────┴───────────────────────┴─────────┴─────────────┴────────────┘",
      "+ ROAS, Cost per result, Results, Impressions, CPM, CPC (link) · → to see"
    ]);
    expect(detail.some((line) => /│ Total /u.test(line))).toBe(false);
  });

  it("the r4 look at 60: the same table keeps spend, link clicks and the rate, and names the rest (run-3 N19)", () => {
    const detail = draw(live(), { width: 60 }).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    expect(detail.slice(at + 1, at + 8)).toEqual([
      "┌─────────────────────┬─────────┬─────────────┬────────────┐",
      "│                     │   Spent │ Link clicks │ CTR (link) │",
      "├─────────────────────┼─────────┼─────────────┼────────────┤",
      "│ Sample · Trials…    │ $212.40 │          47 │      5.87% │",
      "└─────────────────────┴─────────┴─────────────┴────────────┘",
      "+ ROAS, Cost per result, Results, Impressions, CPM, CPC",
      "(link), Status · → to see"
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
      "│ Sep 28 │ $28.10 │         110 │           9 │      8.18% │            —³ │             —¹ │",
      "│ Sep 29 │ $61.20 │         240 │          12 │      5.00% │            —³ │             —¹ │",
      "│ Sep 30 │ $63.50 │         231 │          11 │      4.76% │             1 │             —¹ │",
      "│ Oct 1  │ $59.60 │         220 │          15 │      6.82% │            —³ │             —¹ │",
      "└────────┴────────┴─────────────┴─────────────┴────────────┴───────────────┴────────────────┘"
    ]);
    expect(details.join("\n")).not.toMatch(/2026-09-28|Day\b/u);
  });

  it("a section is ONE heading line over its table: sign-ups, the prior period as one row of its days, billing trials", () => {
    const detail = draw(live()).detail;
    expect(detail).toContain("Our sign-ups · Sep 28 – Oct 2 (today so far) · not final");
    expect(detail).toContain("Billing trials · Sep 28 – Oct 1 (UTC days)");
    const prior = detail.indexOf("Prior 4 days");
    expect(detail[prior + 4]).toBe("│ Sep 24 – 27 │ $171.30 │         121 │      8.06% │      $1.42 │             1 │         0 │");
    // `New trials` once per row, never as a heading over its own column.
    expect(detail.filter((line) => /New trials\b/u.test(line) && !line.startsWith("│"))).toEqual([]);
    expect(detail).toContain("│ New trials                                │                    1 │");
  });
});

// Live re-check run 3, N19: at 60 an all-dash ROAS column stayed while the
// measured Link clicks was hidden; at 140 `Results` (the count) and `Result`
// (what one result is) sat side by side.
describe("numbers: which columns a narrow table keeps, and one Results column (run-3 N19)", () => {
  const header = (lines: readonly string[], at: number) =>
    lines.slice(at).find((line) => line.startsWith("│"))!.split("│").map((cell) => cell.trim()).filter(Boolean);

  it("at 60 a column with nothing measured drops before any measured column, and is named", () => {
    const detail = draw(live(), { width: 60 }).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    expect(header(detail, at)).toContain("Link clicks");
    expect(header(detail, at)).not.toContain("ROAS");
    const hidden = detail.slice(at).join(" ").match(/\+ ([^·]+) · → to see/u)?.[1] ?? "";
    expect(hidden).toContain("ROAS");
    expect(hidden).not.toContain("Link clicks");
    // The prior period too: its all-dash ROAS never stays while measured columns are hidden.
    expect(header(detail, detail.indexOf("Prior 4 days"))).not.toContain("ROAS");
  });

  it("a measured column that never drops still never drops; a table that fits keeps its unmeasured columns", () => {
    const view = edited((body) => {
      body.legs.settled.rows[0].cells.roas = { value: 0.84 };
    });
    const detail = draw(view, { width: 60 }).detail;
    expect(header(detail, detail.indexOf("Sep 28 – Oct 1"))).toContain("ROAS");
    // A table that fits drops nothing: the all-dash ROAS is drawn, with its mark.
    const table = {
      columns: [{ label: "Spent", unit: "money" as const, dropPriority: 0 }, { label: "ROAS", unit: "ratio" as const, dropPriority: 0 }],
      rows: [{ label: "Hook A", cells: [{ value: 12.4 }, { value: null, reason: { code: "no_value", words: "no purchase value counted" } }] }],
      currency: "USD"
    };
    const notes = new FootnoteBook();
    const lines = cellTableLines(table, ctx({ width: 60 }), { notes, hidden: 0 });
    expect(lines[1]).toBe("│        │  Spent │ ROAS │");
    expect(lines[3]).toBe("│ Hook A │ $12.40 │   —¹ │");
    expect(notes.lines()).toEqual(["¹ no purchase value counted"]);
  });

  // Live run 4, N19 remainder: By day carried Clicks (all) beside Link clicks,
  // and at 60 kept Clicks (all) and CTR (link) but hid Link clicks (the two
  // tied, so the right one went first). Link clicks is the click a reader
  // judges an ad by (CTR (link), CPC (link) follow it): Clicks (all) goes first.
  it("at 60 Link clicks stays and Clicks (all) drops first, in the main table and in By day", () => {
    const view = edited((body) => {
      const add = (columns: Record<string, any>[], rows: Record<string, any>[], value: (index: number) => number) => {
        columns.splice(columns.findIndex((column) => column.key === "linkClicks"), 0,
          { key: "clicks", label: "Clicks (all)", unit: "count", factGroup: "delivery" });
        rows.forEach((row, index) => {
          row.cells.clicks = { value: value(index) };
        });
      };
      add(body.columns, body.legs.settled.rows, () => 61);
      const byDay = body.sections.find((section: Record<string, any>) => section.title === "By day").body;
      add(byDay.columns, byDay.legs.settled.rows, (index) => 12 + index);
    });
    const detail = draw(view, { width: 60 }).detail;
    for (const heading of ["Sep 28 – Oct 1", "By day"]) {
      const at = detail.indexOf(heading);
      expect(header(detail, at)).toContain("Link clicks");
      expect(header(detail, at)).not.toContain("Clicks (all)");
      expect(detail.slice(at).join(" ").match(/\+ ([^·]+) · → to see/u)?.[1] ?? "").toContain("Clicks (all)");
    }
    // With the room for both, both stay, in the app's order.
    const wide = committedTurn([view], 140);
    expect(header(wide, wide.indexOf("By day"))).toEqual(expect.arrayContaining(["Clicks (all)", "Link clicks"]));
  });

  // The same run, the campaign table: its row's status word was short (`On`),
  // so the Status column stayed and the measured Link clicks went. A status is
  // a word the row's records still show (→); the click count a rate is of is not.
  it("at 60 a short status word goes before Link clicks, after Clicks (all)", () => {
    const view = edited((body) => {
      body.legs.settled.rows[0].status = { word: "On", tone: "ok" };
    });
    const detail = draw(view, { width: 60 }).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    expect(header(detail, at)).toEqual(["Spent", "Link clicks", "CTR (link)"]);
    expect(detail.slice(at).join(" ").match(/\+ ([^·]+) · → to see/u)?.[1] ?? "").toMatch(/\bStatus\b/u);
    // With the room, the status stays beside every measure.
    const wide = committedTurn([view], 140);
    expect(header(wide, wide.indexOf("Sep 28 – Oct 1"))).toContain("Status");
  });

  it("a column dropped before a wider one that had to go too comes back when it fits", () => {
    const detail = draw(live(), { width: 60 }).detail;
    const at = detail.indexOf("Sep 28 – Oct 1");
    // The wide Status (it drops last) had to go; the measured Link clicks fits beside what is left.
    expect(header(detail, at)).toEqual(["Spent", "Link clicks", "CTR (link)"]);
  });

  it("at 140 the count and its noun are ONE column, headed by the count's label", () => {
    const view = edited((body) => {
      body.legs.settled.rows[0].cells.results = { value: 1 };
    });
    // Scrollback is one column at 140: the table has the room for both.
    const details = committedTurn([view], 140);
    const at = details.indexOf("Sep 28 – Oct 1");
    const cells = header(details, at);
    expect(cells.filter((cell) => /^Results?$/u.test(cell))).toEqual(["Results"]);
    const row = details.slice(at).find((line) => line.includes("Sample · Trials"))!;
    expect(row).toMatch(/│ +1 trial │/u);
    // Nothing names a `Result` column it hid.
    expect(details.join("\n")).not.toMatch(/\bResult\b(?!s)/u);
  });

  it("→ shows the folded column as one record line; an unmeasured count has no noun after its dash", () => {
    const records = draw(live(), { width: 60, showHiddenColumns: true }).detail;
    expect(records.filter((line) => /^\s*Results?: /u.test(line))).toEqual([expect.stringMatching(/^ {2}Results: —\S*$/u)]);
  });

  // Lane review (LG-3 MUST): the app sends the Result words in the singular
  // (`trial`), so they follow a count of exactly 1 only. Any other count is
  // drawn bare until the app sends words matched to it: never `3 trial`.
  describe("the folded noun follows only a count it is right for", () => {
    const resultsCell = (results: { value: number | null; reason?: Record<string, unknown> }) => {
      const view = edited((body) => {
        body.legs.settled.rows[0].cells.results = results;
      });
      const details = committedTurn([view], 140);
      const at = details.indexOf("Sep 28 – Oct 1");
      const row = details.slice(at).find((line) => line.includes("Sample · Trials"))!;
      const cells = row.split("│").map((cell) => cell.trim());
      const column = header(details, at).indexOf("Results");
      return cells.filter(Boolean)[column + 1];
    };

    it("1 → `1 trial`", () => {
      expect(resultsCell({ value: 1 })).toBe("1 trial");
    });

    it("3 → the bare `3`, never `3 trial`", () => {
      expect(resultsCell({ value: 3 })).toBe("3");
    });

    it("0 → the bare `0`, never `0 trial`", () => {
      expect(resultsCell({ value: 0 })).toBe("0");
    });

    it("unmeasured → the dash and its mark, with no noun (a table that fits keeps the column)", () => {
      const table = {
        columns: [{ label: "Results", unit: "count" as const, dropPriority: 0 }, { label: "Result", unit: "text" as const, dropPriority: 0 }],
        rows: [
          { label: "Hook A", cells: [{ value: null, reason: { code: "blanked", words: "numbers not confirmed" } }, { text: "trial" }] },
          { label: "Hook B", cells: [{ value: 1 }, { text: "trial" }] }
        ],
        currency: "USD"
      };
      const notes = new FootnoteBook();
      const lines = cellTableLines(table, ctx({ width: 60 }), { notes, hidden: 0 });
      expect(lines.find((line) => line.includes("Hook A"))).toBe("│ Hook A │      —¹ │");
      expect(lines.find((line) => line.includes("Hook B"))).toMatch(/│ +1 trial │$/u);
    });

    it("the record view says the same: `Results: 3`", () => {
      const view = edited((body) => {
        body.legs.settled.rows[0].cells.results = { value: 3 };
      });
      const records = draw(view, { width: 60, showHiddenColumns: true }).detail;
      expect(records.filter((line) => /^\s*Results: /u.test(line))).toEqual(["  Results: 3"]);
    });
  });
});

// Live re-check run 3, N18: the campaign's long name wrapped to 3 lines in
// its table at 60 and 100. It is cut with … to its column, one line per row,
// and shown whole on → (the records).
describe("numbers: a long row name is one line, cut with … (run-3 N18)", () => {
  const NAME = "Sample · Trials · US · 2026-09-01 — sample_b1_trial_us";
  /** A table row whose label cell has words and every other cell is blank: a wrapped name's later line. */
  const wrapped = (line: string) => {
    const cells = line.split("│").slice(1, -1).map((cell) => cell.trim());
    return line.startsWith("│") && cells.length > 1 && cells[0] !== "" && cells.slice(1).every((cell) => cell === "");
  };

  it.each([60, 100, 140])("at %i, live and committed, no table row takes a second line, and the cut name ends in …", (width) => {
    for (const [lines, split] of [[liveTurn([live()], width), true], [committedTurn([live()], width), false]] as const) {
      const details = detailsOf(lines, width, split);
      expect(details.filter(wrapped)).toEqual([]);
      const row = details.find((line) => line.startsWith("│ Sample"));
      expect(row, details.join("\n")).toBeDefined();
      if (!row!.includes(NAME)) expect(row!.split("│")[1]!.trim()).toMatch(/[^\s·—]…$/u);
    }
  });

  it("→ shows the whole name in the records", () => {
    const records = draw(live(), { width: 60, showHiddenColumns: true }).detail;
    expect(records).toContain(NAME);
  });

  it("a table that cuts a name but hides no column still offers →, and → shows the name whole", () => {
    const table = {
      columns: [{ label: "New trials", unit: "count" as const, dropPriority: 0 }],
      rows: [{ label: "New trials since spend began in this window (Sep 28)", cells: [{ value: 1 }] }],
      currency: null
    };
    const draw1 = { notes: new FootnoteBook(), hidden: 0 };
    const lines = cellTableLines(table, ctx({ width: 40 }), draw1);
    expect(lines[3]).toBe("│ New trials since spend… │          1 │");
    expect(draw1.hidden).toBe(1);
    expect(lines.some((line) => line.startsWith("+ "))).toBe(false);
    const whole = cellTableLines(table, ctx({ width: 40, showHiddenColumns: true }), { notes: new FootnoteBook(), hidden: 0 });
    expect(whole.join(" ")).toContain("New trials since spend began in this window (Sep 28)");
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
      "ROAS         —²"
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
    expect(render.footnotes).toEqual(["¹ the provider hasn't confirmed the count", "² no purchase value counted", "³ none credited yet"]);
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

  describe("`not final` reads the data's own time, never the clock", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a settled-slot leg ending on its own as-of day stays `not final` a day later, with no view as-of", () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-10-03T09:00:00Z"));
      const view = edited((body, raw) => {
        raw.asOf = null;
        const leg = body.sections[2].body.legs.settled;
        leg.asOf = "2026-10-02T15:30:00Z";
      });
      expect(draw(view).detail).toContain("Our sign-ups · Sep 28 – Oct 2 (today so far) · not final · as of 15:30");
    });

    it("no as-of at all: the adapter's `final:false` is trusted, whatever the clock says", () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-12-01T09:00:00Z"));
      const view = edited((_body, raw) => { raw.asOf = null; });
      expect(draw(view).detail).toContain("Our sign-ups · Sep 28 – Oct 2 (today so far) · not final");
    });

    it("the leg's own as-of wins over the view's: read the day after, the period is settled", () => {
      const view = edited((body) => {
        body.sections[2].body.legs.settled.asOf = "2026-10-03T08:00:00Z";
      });
      expect(draw(view).detail).toContain("Our sign-ups · Sep 28 – Oct 2 (today so far)");
    });
  });
});

describe("numbers: `→ to see` only where → works (run-2 M7)", () => {
  it("the live turn's focused view names the key; committed to scrollback it names what is hidden, in words", () => {
    const hint = (lines: readonly string[]) => lines.filter((line) => line.includes("Cost per result, Results"));
    expect(hint(liveTurn([live()], 100))).toEqual(["+ ROAS, Cost per result, Results, Impressions, CPM, CPC (link) · → to see"]);
    expect(hint(committedTurn([live()], 100))).toEqual(["+ ROAS, Cost per result, Results, Impressions, CPM, CPC (link) hidden"]);
    expect(committedTurn([live()], 100).join("\n")).not.toContain("→");
  });

  it("a view the keys are not on names what it hid in words too", () => {
    const other = edited((_body, view) => { view.title = "Another read"; });
    const lines = liveTurn([live(), other], 100);
    const hints = lines.filter((line) => line.startsWith("+ ROAS, Cost per result"));
    // The first view is not focused (the keys are on the last one).
    expect(hints).toEqual([
      "+ ROAS, Cost per result, Results, Impressions, CPM, CPC (link) hidden",
      "+ ROAS, Cost per result, Results, Impressions, CPM, CPC (link) · → to see"
    ]);
  });

  it("after → the focused table shows every column as records (records only after →)", () => {
    const detail = draw(live(), { showHiddenColumns: true }).detail.join("\n");
    expect(detail).toMatch(/Cost per result: —/u);
  });
});

describe("numbers, the Google Ads shape: dates as r4 writes them, said once (live T4)", () => {
  // Same sections, the way a Google Ads read names things: ISO dates as row
  // labels and as window labels, and a by-campaign section with a Day column.
  const google = () => edited((body) => {
    body.legs.settled.rows[0].label = "Brand search";
    body.legs.settled.window.label = "2026-09-28 to 2026-10-01";
    body.legs.today.window.label = "2026-10-02";
    const byDay = body.sections[0].body.legs.settled;
    byDay.window.label = "2026-09-28 to 2026-10-01";
    byDay.rows.forEach((row: any) => { row.label = row.id; });
    body.sections[1].body.legs.settled.window.label = "2026-09-24 to 2026-09-27";
    const byCampaign = JSON.parse(JSON.stringify(body.sections[0]));
    byCampaign.title = "By campaign";
    byCampaign.body.legs.settled.rows.forEach((row: any) => { row.label = `Campaign ${row.id.slice(-2)}`; });
    body.sections.push(byCampaign);
  });

  it.each([60, 100, 140])("at %i, live and committed, no ISO date prints", (width) => {
    for (const lines of [liveTurn([google()], width), committedTurn([google()], width)]) {
      expect(lines.join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
      expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
    }
  });

  it("dates as row labels read `Sep 28`, and a Day column that repeats them drops", () => {
    const detail = draw(google()).detail;
    const at = detail.indexOf("By day · Sep 28–Oct 1");
    expect(at).toBeGreaterThan(-1);
    expect(detail.slice(at + 4, at + 8).map((line) => line.split("│")[1]!.trim())).toEqual(["Sep 28", "Sep 29", "Sep 30", "Oct 1"]);
    expect(detail[at + 2]).not.toMatch(/\bDay\b/u);
    // The by-campaign section keeps its Day column, written as r4 writes days.
    expect(detail.join("\n")).toMatch(/│ Campaign 28 │ Sep 28 /u);
  });

  it("a window label that is only ISO dates is said once, as r4 says dates", () => {
    const detail = draw(google()).detail;
    expect(detail).toContain("Sep 28–Oct 1");
    expect(detail.join("\n")).not.toMatch(/Sep 28–Oct 1 · Sep 28–Oct 1|Sep 28 to Oct 1/u);
    expect(detail).toContain("By day · Sep 28–Oct 1");
    expect(detail.some((line) => line.startsWith("Oct 2 · not final"))).toBe(true);
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

