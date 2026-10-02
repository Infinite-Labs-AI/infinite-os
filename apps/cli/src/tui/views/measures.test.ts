import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import { hasKindRenderer, renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

// Every number and name here is synthetic (infinite-os is public).
const theme = resolveTheme({});
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const OPEN = { open: true, watch: false, retry: false };

function fixture(name: string): AnswerViewV1 {
  const view = decodeAnswerView(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")));
  if (!view) throw new Error(`fixture ${name} does not decode`);
  return view;
}

/** A fixture with its body edited (a deep copy; fixtures stay as written). */
function edited(name: string, edit: (body: Record<string, any>) => void): AnswerViewV1 {
  const view = JSON.parse(JSON.stringify(fixture(name))) as AnswerViewV1;
  edit(view.body as unknown as Record<string, any>);
  return view;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 80, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});

const lines = (render: ViewRender) => [render.head, render.source ?? "", ...render.detail, ...render.footnotes];
const text = (render: ViewRender) => lines(render).join("\n");
const draw = (view: AnswerViewV1, overrides: Partial<ViewRenderCtx> = {}) => renderView(view, ctx(overrides));
/** The glyph run of the coverage strip: `Days <from> <glyphs> <to>`. */
const strip = (render: ViewRender) => /^Days \S+ \d+ (\S+) \S+ \d+$/mu.exec(render.detail.join("\n"))?.[1];

describe("measures are registered", () => {
  it("numbers, compare and health draw their bodies", () => {
    expect(hasKindRenderer("numbers")).toBe(true);
    expect(hasKindRenderer("compare")).toBe(true);
    expect(hasKindRenderer("health")).toBe(true);
  });
});

describe("numbers: legs", () => {
  it("the settled leg and the today leg render as two separate blocks", () => {
    const detail = draw(fixture("numbers-week-today")).detail;
    const settled = detail.findIndex((line) => line.startsWith("Last 7 days · Jan 8–14"));
    const today = detail.indexOf("Today · not final · as of 18:30");
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(today).toBeGreaterThan(settled);
    expect(detail[today - 1]).toBe("");
    // Two boxes: one per leg, never one table across both.
    expect(detail.filter((line) => line.startsWith("┌"))).toHaveLength(2);
    expect(detail.slice(settled, today).join("\n")).toContain("Hook A");
    expect(detail.slice(today).join("\n")).toContain("$5.00");
  });

  it("the today leg is labelled not final with the time it is as of", () => {
    expect(draw(fixture("numbers-week-today")).detail).toContain("Today · not final · as of 18:30");
    expect(draw(fixture("numbers-week-today"), { timeZone: "America/New_York" }).detail)
      .toContain("Today · not final · as of 13:30");
  });

  it("a settled leg that still holds unsettled days says not final", () => {
    const detail = draw(fixture("numbers-today-only")).detail;
    expect(detail.find((line) => line.startsWith("Today"))).toBe("Today · Jan 15 · not final · as of 18:30");
  });

  it("there is never a combined total; a Total row comes only from legs.settled.totals", () => {
    const render = draw(fixture("numbers-week-today"));
    const totals = render.detail.filter((line) => /Total/u.test(line));
    expect(totals).toHaveLength(1);
    expect(totals[0]).toContain("$100.00");
    expect(totals[0]).toContain("51");
    // The settled + today sums never appear (100 + 8 spend, 51 + 5 clicks).
    expect(text(render)).not.toContain("$108.00");
    expect(text(render)).not.toMatch(/\b56\b/u);
    // A today leg WITH rows never prints its own totals either (no today Total row).
    expect(render.detail.slice(render.detail.indexOf("Today · not final · as of 18:30")).join("\n")).not.toContain("$8.00");
  });

  it("a today leg with no rows shows its own totals under its title, never summed into the settled leg", () => {
    // The contract shape: settled rows [] + totals, today rows [] + totals.
    const render = draw(edited("numbers-week-today", (body) => {
      body.columns = body.columns.slice(0, 2);
      body.legs.settled.rows = [];
      body.legs.settled.totals = { spend: { value: 100 }, clicks: { value: 50 } };
      body.legs.today.rows = [];
      body.legs.today.totals = { spend: { value: 5 }, clicks: { value: 3 } };
      body.leaders = [];
    }));
    const today = render.detail.indexOf("Today · not final · as of 18:30");
    expect(today).toBeGreaterThan(0);
    const settled = render.detail.slice(0, today).join("\n");
    const todayBlock = render.detail.slice(today).join("\n");
    expect(render.detail[today + 1]).toMatch(/^Spend +\$5\.00$/u);
    expect(render.detail[today + 2]).toMatch(/^Clicks +3$/u);
    expect(settled).toMatch(/^Spend +\$100\.00$/mu);
    expect(todayBlock).not.toContain("$100.00");
    expect(text(render)).not.toMatch(/Total/u);
    expect(text(render)).not.toContain("$105.00");
    expect(text(render)).not.toMatch(/\b53\b/u);
    // Totals with no rows print as pairs, never as an empty table.
    expect(text(render)).not.toMatch(/[┌├└]/u);
  });

  it("no settled totals, no Total row (the renderer never adds one up)", () => {
    const render = draw(edited("numbers-week-today", (body) => { delete body.legs.settled.totals; }));
    expect(text(render)).not.toMatch(/Total/u);
    expect(text(render)).not.toContain("$100.00");
  });

  it("a null cell prints a dash with a footnote, a words reason prints in place, never 0", () => {
    const render = draw(fixture("numbers-week-today"));
    const hookC = render.detail.find((line) => line.includes("Hook C")) ?? "";
    expect(hookC).toContain("—¹");
    expect(hookC).toContain("New");
    expect(hookC).not.toMatch(/\b0\b|\$0\.00/u);
    expect(render.footnotes).toContain("¹ not synced yet");
  });
});

describe("numbers: rows", () => {
  it("j/k select the settled leg's rows: the selected row is marked ▸ in place of its border", () => {
    const first = draw(fixture("numbers-week-today"));
    expect(first.rowCount).toBe(3);
    expect(first.detail.find((line) => line.includes("Hook A"))).toMatch(/^▸ Hook A /u);
    const third = draw(fixture("numbers-week-today"), { selected: 2 });
    expect(third.detail.find((line) => line.includes("Hook C"))).toMatch(/^▸ Hook C /u);
    expect(third.detail.find((line) => line.includes("Hook A"))).toMatch(/^│ Hook A /u);
    // The today leg's rows are never marked, and every line keeps its width.
    expect(third.detail.filter((line) => line.startsWith("▸"))).toHaveLength(1);
    const widths = new Set(third.detail.filter((line) => /^[│▸┌├└]/u.test(line)).slice(0, 8).map(displayWidth));
    expect(widths.size).toBe(1);
  });

  it("shown as records, the selected row's heading is marked", () => {
    const detail = draw(fixture("numbers-ads"), { width: 48, showHiddenColumns: true, selected: 1 }).detail;
    expect(detail).toContain("▸ Ad set 02");
    expect(detail).toContain("  Ad set 01");
  });

  it("steps and kpis have no rows to select", () => {
    expect(draw(fixture("numbers-steps")).rowCount).toBe(0);
    expect(draw(edited("numbers-today-only", (body) => { body.layout = "kpis"; })).rowCount).toBe(0);
  });
});

describe("numbers: steps", () => {
  it("a step with ofPrevious and both counts measured prints n of m", () => {
    const detail = draw(fixture("numbers-steps")).detail;
    expect(detail.find((line) => line.startsWith("Registered"))).toMatch(/176 of 1,000$/u);
    expect(detail.find((line) => line.startsWith("App signup"))).toMatch(/127 of 176$/u);
    expect(detail.find((line) => line.startsWith("Visits"))).toMatch(/ 1,000$/u);
  });

  it("a steps body never prints a %", () => {
    expect(text(draw(fixture("numbers-steps")))).not.toMatch(/%/u);
    expect(text(draw(fixture("numbers-steps"), { width: 30 }))).not.toMatch(/%/u);
  });

  it("a null step prints a dash with a footnote, and the step after it prints its count alone", () => {
    const render = draw(fixture("numbers-steps"));
    expect(render.detail.find((line) => line.startsWith("Started trial"))).toMatch(/—¹$/u);
    expect(render.footnotes).toEqual(["¹ not counted before Jan 10"]);
    // Paying follows a null step: there is no "of" without both counts.
    expect(render.detail.find((line) => line.startsWith("Paying"))).toMatch(/ 4$/u);
    expect(text(render)).not.toMatch(/4 of/u);
  });
});

describe("numbers: steps beside rows and totals", () => {
  const funnel = () => JSON.parse(JSON.stringify((fixture("numbers-steps").body as any).legs.settled.steps));

  it("kpis: a settled leg with totals, no rows and steps prints both the totals and the steps", () => {
    const render = draw(edited("numbers-week-today", (body) => {
      body.layout = "kpis";
      body.legs.settled.rows = [];
      body.legs.settled.steps = funnel();
      delete body.legs.today;
    }));
    const detail = render.detail;
    const spend = detail.findIndex((line) => /^Spend +\$100\.00$/u.test(line));
    const signup = detail.findIndex((line) => /^App signup +127 of 176$/u.test(line));
    expect(spend).toBeGreaterThan(0);
    expect(signup).toBeGreaterThan(spend);
    expect(detail.slice(spend, signup)).toContain("");
    expect(text(render)).not.toMatch(/%/u);
  });

  it("table: a settled leg with totals, no rows and steps draws the totals as pairs, then the steps", () => {
    const render = draw(edited("numbers-week-today", (body) => {
      body.legs.settled.rows = [];
      body.legs.settled.steps = funnel();
      delete body.legs.today;
    }));
    const out = render.detail.join("\n");
    expect(out).toMatch(/^Spend +\$100\.00$/mu);
    expect(out).toMatch(/^App signup +127 of 176$/mu);
    expect(out).not.toMatch(/[┌├└]/u);
    expect(render.rowCount).toBe(0);
    expect(text(render)).not.toMatch(/%/u);
  });

  it("table: rows and steps both print (the table, then the steps)", () => {
    const render = draw(edited("numbers-week-today", (body) => {
      body.legs.settled.steps = funnel();
    }));
    const detail = render.detail;
    const hookA = detail.findIndex((line) => line.includes("Hook A"));
    const signup = detail.findIndex((line) => /^App signup +127 of 176$/u.test(line));
    expect(hookA).toBeGreaterThan(0);
    expect(signup).toBeGreaterThan(hookA);
    expect(detail.filter((line) => /Total/u.test(line))).toHaveLength(1);
    expect(render.rowCount).toBe(3);
    expect(text(render)).not.toMatch(/%/u);
  });

  it("layout steps stays steps-only", () => {
    const render = draw(edited("numbers-steps", (body) => {
      body.columns = [{ key: "spend", label: "Spend", unit: "money" }];
      body.legs.settled.totals = { spend: { value: 100 } };
    }));
    expect(text(render)).not.toContain("$100.00");
  });
});

describe("numbers: leaders", () => {
  it("print one line per measure, and never a winner", () => {
    const render = draw(fixture("numbers-week-today"));
    expect(render.detail).toContain("Most clicks · Hook A · 41");
    expect(render.detail).toContain("Most trials · Hook B · 2");
    expect(render.detail).toContain("Lowest cost per trial · Hook B · $20.00");
    expect(text(render)).not.toMatch(/winner/iu);
  });
});

describe("numbers: the coverage strip", () => {
  it("· zero, █ measured, ◌ today, — not measured", () => {
    expect(strip(draw(fixture("numbers-ads")))).toBe("·····██");
    expect(strip(draw(fixture("numbers-week-today")))).toBe("·—█████◌");
    const detail = draw(fixture("numbers-week-today")).detail.join("\n");
    expect(detail).toMatch(/^Days Jan 8 ·—█████◌ Jan 15$/mu);
    expect(detail).toContain("5 of 7 days measured");
  });

  it("a not_measured day is never ·", () => {
    const view = edited("numbers-ads", (body) => {
      for (const day of body.legs.settled.coverage.days) day.status = "not_measured";
    });
    expect(strip(draw(view))).toBe("———————");
  });

  it("the legend names only the marks the strip uses", () => {
    const detail = draw(fixture("numbers-ads")).detail.join("\n");
    expect(detail).toContain("· zero");
    expect(detail).toContain("█ measured");
    expect(detail).not.toContain("◌ today");
    expect(draw(fixture("numbers-week-today")).detail.join("\n")).toContain("◌ today");
  });

  it("no settled coverage, no strip (a lone today mark says nothing)", () => {
    const render = draw(edited("numbers-week-today", (body) => { delete body.legs.settled.coverage; }));
    expect(render.detail.some((line) => line.startsWith("Days"))).toBe(false);
    expect(text(render)).not.toContain("◌ today");
  });

  it("a long strip wraps inside the pane", () => {
    const view = edited("numbers-ads", (body) => {
      body.legs.settled.coverage.days = Array.from({ length: 90 }, (_, i) => ({
        date: new Date(Date.UTC(2025, 9, 17 + i)).toISOString().slice(0, 10), status: i % 3 ? "measured" : "zero"
      }));
    });
    const render = draw(view, { width: 40 });
    expect(render.detail.every((line) => displayWidth(line) <= 40)).toBe(true);
    const stripRows = render.detail.filter((line) => /^[\s·█]+$/u.test(line));
    expect(stripRows.join("").replace(/[^·█]/gu, "")).toHaveLength(90);
  });
});

describe("numbers: narrow width", () => {
  it("hidden columns print `+ … · → to see`", () => {
    const render = draw(fixture("numbers-ads"), { width: 48 });
    expect(render.detail).toContain("+ Impressions, CPC · → to see");
    expect(render.hiddenColumns).toBe(2);
    expect(render.detail.every((line) => displayWidth(line) <= 48)).toBe(true);
  });

  it("with showHiddenColumns the table switches to label: value records", () => {
    const render = draw(fixture("numbers-ads"), { width: 48, showHiddenColumns: true });
    const detail = render.detail.join("\n");
    expect(detail).not.toContain("┌");
    expect(detail).toMatch(/^▸ Ad set 01$/mu);
    expect(detail).toMatch(/^ {4}Impressions: 4,000$/mu);
    expect(detail).toMatch(/^ {4}CPC: \$0\.80$/mu);
    expect(detail).toMatch(/^ {2}Total$/mu);
    expect(detail).not.toContain("→ to see");
    // → stays bound so it can switch back.
    expect(render.hiddenColumns).toBe(2);
  });

  it("a footnote never points at a column the table dropped", () => {
    const view = edited("numbers-ads", (body) => {
      body.legs.settled.rows[0].cells.impressions = { value: null, reason: { code: "x", words: "only in the dropped column" } };
    });
    const render = draw(view, { width: 48 });
    expect(render.footnotes.join("\n")).not.toContain("only in the dropped column");
    expect(render.footnotes).toEqual(["¹ not measured: no conversion tracked"]);
    // Shown as a record, the cell draws, so its footnote prints.
    expect(draw(view, { width: 48, showHiddenColumns: true }).footnotes.join("\n")).toContain("only in the dropped column");
  });

  it("wide enough, nothing hides", () => {
    const render = draw(fixture("numbers-ads"), { width: 100 });
    expect(render.hiddenColumns ?? 0).toBe(0);
    expect(render.detail.join("\n")).toContain("Impressions");
  });
});

describe("numbers: other layouts", () => {
  it("kpis print label and value pairs", () => {
    const view = edited("numbers-today-only", (body) => {
      body.layout = "kpis";
      body.legs.settled.rows = body.legs.settled.rows.slice(0, 1);
    });
    const detail = draw(view).detail;
    expect(detail).toContain("Spend   $5.00");
    expect(detail).toContain("Clicks  4");
  });

  it("composite sections draw one level deep, with their titles", () => {
    const inner = fixture("numbers-ads").body;
    const view = edited("numbers-ads", (body) => {
      body.layout = "composite";
      delete body.legs;
      body.sections = [
        { title: "Delivery", kind: "numbers", body: { ...inner, sections: [{ title: "Too deep", kind: "numbers", body: inner }] } },
        { title: "Sources", kind: "health", body: fixture("health-connections").body }
      ];
    });
    const out = text(draw(view));
    expect(out).toMatch(/^Delivery$/mu);
    expect(out).toContain("Ad set 01");
    expect(out).toMatch(/^Sources$/mu);
    expect(out).toContain("⊘ Store");
    expect(out).not.toContain("Too deep");
  });

  it("a malformed body degrades without throwing", () => {
    const view = edited("numbers-ads", (body) => {
      body.columns = "spend";
      body.legs = { settled: { rows: [7, null, { label: 3, cells: "x" }], window: null, coverage: { days: "x" } }, today: 4 };
      body.leaders = [null, { measure: 1 }];
    });
    expect(() => draw(view)).not.toThrow();
    expect(text(draw(view))).not.toContain("could not be drawn");
  });
});

describe("compare", () => {
  it("arms print side by side, and differences with their likely range", () => {
    const detail = draw(fixture("compare-test")).detail.join("\n");
    expect(detail).toContain("A Current");
    expect(detail).toContain("B New");
    expect(detail).toContain("Likely range");
    expect(detail).toContain("-1.5% to +3.5% (95%)");
    expect(detail).toMatch(/│ +\+1% │/u);
  });

  it("the verdict line comes only from verdict.sentence", () => {
    const render = draw(fixture("compare-test"));
    expect(render.detail).toContain("◌ No clear difference yet: the likely ranges overlap.");
    expect(render.detail).toContain("Needs 14 days; has 7.");
    const silent = draw(edited("compare-test", (body) => { delete body.verdict.sentence; }));
    expect(text(silent)).not.toContain("No clear difference");
    expect(text(silent)).not.toMatch(/inconclusive|insufficient|supported/u);
  });

  it("with namesWinner false, no arm is marked", () => {
    const out = text(draw(fixture("compare-test")));
    expect(out).not.toMatch(/winner|★|▸|✓ [AB] /iu);
    // The arm rows start with the arm's own name: nothing marks one.
    const armRows = draw(fixture("compare-test")).detail.filter((line) => /^│ (A Current|B New) /u.test(line));
    expect(armRows).toHaveLength(2);
    expect(armRows.every((line) => !/[★▸✓●←]/u.test(line))).toBe(true);
    expect(text(draw(edited("compare-test", (body) => { body.verdict.namesWinner = true; })))).not.toMatch(/★|▸/u);
  });

  it("every line fits the pane", () => {
    for (const width of [30, 48, 60, 100]) {
      expect(lines(draw(fixture("compare-test"), { width })).every((line) => displayWidth(line) <= width)).toBe(true);
    }
  });

  it("the likely range survives a narrow pane (it is the last column to go)", () =>
    expect(draw(fixture("compare-test"), { width: 48 }).detail.join("\n")).toContain("Likely range"));
});

describe("health", () => {
  it("not_connected prints ⊘ and the fix label, with (o) only when the session can open the app", () => {
    const closed = draw(fixture("health-connections"));
    expect(closed.detail.find((line) => line.startsWith("⊘ Store"))).toBeDefined();
    expect(closed.detail).toContain("  → Connect the store");
    expect(text(closed)).not.toContain("(o)");
    const open = draw(fixture("health-connections"), { caps: OPEN });
    expect(open.detail).toContain("  → Connect the store (o)");
    expect(open.keys).toEqual([{ key: "o", label: "Connect the store" }]);
    expect(closed.keys).toEqual([]);
  });

  it("each item prints its glyph, name, state words and how fresh it is", () => {
    const detail = draw(fixture("health-connections")).detail;
    expect(detail.find((line) => line.startsWith("✓ Analytics"))).toMatch(/up to Jan 14$/u);
    expect(detail.find((line) => line.startsWith("✓ Payments"))).toMatch(/last OK Jan 15, 10:28$/u);
    // A server blocker replaces the generic state words.
    expect(detail.find((line) => line.startsWith("✗ Email"))).toMatch(/sign-in expired/u);
  });

  it("with two fixes to open, j/k picks which one o opens", () => {
    const view = edited("health-connections", (body) => {
      body.items[3].fix = { label: "Sign in to email", appLink: { place: "connections", label: "Connections" } };
    });
    // On a row with no fix, o opens nothing.
    expect(draw(view, { caps: OPEN }).keys).toEqual([]);
    expect(text(draw(view, { caps: OPEN }))).not.toContain("(o)");
    const first = draw(view, { caps: OPEN, selected: 2 });
    expect(first.rowCount).toBe(4);
    expect(first.detail).toContain("    → Connect the store (o)");
    expect(first.detail).toContain("    → Sign in to email");
    const last = draw(view, { caps: OPEN, selected: 3 });
    expect(last.detail).toContain("    → Connect the store");
    expect(last.detail).toContain("    → Sign in to email (o)");
    expect(last.keys).toEqual([{ key: "o", label: "Sign in to email" }]);
    expect(last.detail.find((line) => line.includes("Email"))).toMatch(/^▸ /u);
  });

  it("with fixes to select, the resume place never claims o (o stays with the selected row)", () => {
    const view = edited("health-connections", (body) => {
      body.items[3].fix = { label: "Sign in to email", appLink: { place: "connections", label: "Connections" } };
      body.resume = { appLink: { place: "onboarding", label: "Resume setup" } };
    });
    const onOk = draw(view, { caps: OPEN, selected: 1 });
    expect(onOk.keys).toEqual([]);
    expect(onOk.detail).toContain("→ Resume setup");
    expect(text(onOk)).not.toContain("(o)");
    const onFix = draw(view, { caps: OPEN, selected: 2 });
    expect(onFix.keys).toEqual([{ key: "o", label: "Connect the store" }]);
    expect(onFix.detail).toContain("→ Resume setup");
    // Nothing to select and no fix: the resume place takes o.
    const resumeOnly = draw(edited("health-connections", (body) => {
      delete body.items[2].fix;
      body.resume = { appLink: { place: "onboarding", label: "Resume setup" } };
    }), { caps: OPEN });
    expect(resumeOnly.detail).toContain("→ Resume setup (o)");
    expect(resumeOnly.keys).toEqual([{ key: "o", label: "Resume setup" }]);
  });

  it("one fix or none: nothing to select", () => expect(draw(fixture("health-connections")).rowCount).toBe(0));
});

describe("measures: scrubbed and within the pane", () => {
  it("scrubs escape and bidi characters from every body string", () => {
    const view = edited("numbers-week-today", (body) => {
      body.legs.settled.rows[0].label = "Hook\u001b[2J A‮";
      body.leaders[0].rowLabel = "Hook\u001b]8;;x\u0007 A";
      body.leaders[0].measure.label = "Most⁦ clicks";
      body.legs.settled.window.label = "Last\u0000 7 days";
    });
    const out = text(draw(view));
    expect(out).not.toMatch(/[\u001b\u0000\u0007‮⁦]/u);
    expect(out).toContain("Most clicks · Hook A · 41");
    const health = edited("health-connections", (body) => {
      body.items[2].name = "Store\u001b[31m";
      body.items[2].fix.label = "Connect⁧ it";
    });
    expect(text(draw(health, { caps: OPEN }))).not.toMatch(/[\u001b⁧]/u);
  });

  it("no line is wider than the pane, at any width", () => {
    for (const name of ["numbers-ads", "numbers-week-today", "numbers-today-only", "numbers-steps", "compare-test", "health-connections"]) {
      for (const width of [24, 30, 48, 60, 79, 100]) {
        for (const showHiddenColumns of [false, true]) {
          const render = draw(fixture(name), { width, showHiddenColumns, caps: OPEN });
          expect(lines(render).filter((line) => displayWidth(line) > width), `${name} @ ${width}`).toEqual([]);
        }
      }
    }
  });

  it("colour does not change the words", () => {
    const strip = (value: string) => value.replace(/\u001b\[[0-9;]*m/gu, "");
    for (const name of ["numbers-week-today", "numbers-steps", "compare-test", "health-connections"]) {
      const plain = draw(fixture(name), { caps: OPEN });
      const color = draw(fixture(name), { color: true, caps: OPEN });
      expect(color.detail.map(strip)).toEqual(plain.detail);
    }
  });
});
