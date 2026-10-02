import { describe, expect, it } from "vitest";
import { displayWidth, stripAnsi } from "../tui/lib/display-width.js";
import { INFINITE_R4_THEME, resolveTheme } from "../tui/theme.js";
import { r4Segments, seg } from "./r4-segments.test-util.js";
import { looksNumeric, renderTable, type TableInput } from "./table.js";

// infinite-os is public: every number and name below is synthetic.
describe("renderTable", () => {
  it("draws a box, right-aligns numbers, drops highest-priority columns first", () => {
    const t = renderTable({
      columns: [{ label: "Campaign" }, { label: "Spend" }, { label: "Impressions", dropPriority: 4 },
        { label: "Clicks", dropPriority: 1 }, { label: "CTR" }, { label: "CPC", dropPriority: 3 }, { label: "Conv", dropPriority: 2 }],
      rows: [["Ad set 01", "$10.00", "3,000", "40", "1.00%", "$0.25", "0"]],
      total: ["Total", "$40.00", "9,000", "120", "1.25%", "$0.33", "0"],
    }, { width: 48, color: false, theme: resolveTheme() });
    expect(t.lines[0]).toMatch(/^┌─+┬/);
    expect(t.hidden).toEqual(["Impressions", "CPC"]);
    expect(t.lines.find((l) => l.includes("Ad set 01"))).toContain("│ $10.00 │");
    expect(t.lines.every((l) => displayWidth(l) <= 48)).toBe(true);
  });

  it("falls back to label: value rows when two columns cannot fit", () => {
    expect(renderTable({ columns: [{ label: "A" }, { label: "B" }], rows: [["x".repeat(40), "y".repeat(40)]] },
      { width: 40, color: false, theme: resolveTheme() }).fallback).toBe("record");
  });

  it("prints the record fallback as label: value lines within the width", () => {
    const t = renderTable(
      { columns: [{ label: "A" }, { label: "B" }], rows: [["x".repeat(40), "y".repeat(40)], ["short", "7"]] },
      { width: 40, color: false, theme: resolveTheme() }
    );
    expect(t.hidden).toEqual([]);
    expect(t.lines.some((l) => l.startsWith("A: x"))).toBe(true);
    expect(t.lines).toContain("A: short");
    expect(t.lines).toContain("B: 7");
    expect(t.lines.join("\n")).not.toContain("┌");
    expect(t.lines.every((l) => displayWidth(l) <= 40)).toBe(true);
  });

  it("draws a header rule, a total rule and a closed bottom", () => {
    const t = renderTable(
      { columns: [{ label: "Name" }, { label: "Clicks" }], rows: [["Hook A", "40"], ["Hook B", "1,000"]], total: ["Total", "1,040"] },
      { width: 80, color: false, theme: resolveTheme() }
    );
    expect(t.fallback).toBeNull();
    expect(t.lines).toEqual([
      "┌────────┬────────┐",
      "│ Name   │ Clicks │",
      "├────────┼────────┤",
      "│ Hook A │     40 │",
      "│ Hook B │  1,000 │",
      "├────────┼────────┤",
      "│ Total  │  1,040 │",
      "└────────┴────────┘"
    ]);
  });

  it("drops from the right when no priorities are given, never the first column", () => {
    const t = renderTable(
      { columns: [{ label: "Name" }, { label: "One" }, { label: "Two" }, { label: "Three" }], rows: [["Ad set 01", "10", "20", "30"]] },
      { width: 24, color: false, theme: resolveTheme() }
    );
    expect(t.hidden).toEqual(["Three", "Two"]);
    expect(t.lines[1]).toContain("Name");
  });

  it("drops prioritized columns before unprioritized ones, and never a column whose dropPriority is 0", () => {
    const t = renderTable(
      {
        columns: [{ label: "Name" }, { label: "Keep", dropPriority: 0 }, { label: "Spare", dropPriority: 1 }, { label: "Other" }],
        rows: [["Ad set 01", "10", "20", "30"]]
      },
      { width: 26, color: false, theme: resolveTheme() }
    );
    expect(t.hidden).toEqual(["Spare", "Other"]);
    expect(t.lines[1]).toContain("Keep");
  });

  it("never cuts a cell: a column that does not fit drops whole and is named", () => {
    const t = renderTable(
      { columns: [{ label: "Name" }, { label: "Spend" }, { label: "Note" }], rows: [["Ad set 01", "$1.00", "a long synthetic note that cannot fit"]] },
      { width: 30, color: false, theme: resolveTheme() }
    );
    expect(t.fallback).toBeNull();
    expect(t.hidden).toEqual(["Note"]);
    expect(t.lines.join("\n")).not.toContain("…");
    expect(t.lines.every((l) => displayWidth(l) <= 30)).toBe(true);
    expect(t.fullWidth).toBe(61);
  });

  it("shows a long cell whole when the width allows it (no half-width cap)", () => {
    const note = "a long synthetic note that fits a wide window";
    const t = renderTable(
      { columns: [{ label: "Name" }, { label: "Note" }], rows: [["Ad set 01", note]] },
      { width: 150, color: false, theme: resolveTheme() }
    );
    expect(t.hidden).toEqual([]);
    expect(t.lines[3]).toContain(note);
  });

  it("honours an explicit align over the numeric guess", () => {
    const t = renderTable(
      { columns: [{ label: "Code", align: "left" }, { label: "Label", align: "right" }], rows: [["7", "x"], ["1,000", "yy"]] },
      { width: 80, color: false, theme: resolveTheme() }
    );
    expect(t.lines[3]).toBe("│ 7     │     x │");
  });

  it("keeps the same visible width with color on, and scrubs control characters out of cells", () => {
    const input = {
      columns: [{ label: "Name" }, { label: "Spend" }],
      rows: [["Hook\u001b[31m A‮", "$1.00"]],
      total: ["Total", "$1.00"]
    };
    // Pinned to the r4 theme: resolveTheme() follows the runner's terminal, and a
    // CI runner without COLORTERM resolves a lower colour tier than truecolor.
    const plain = renderTable(input, { width: 40, color: false, theme: INFINITE_R4_THEME });
    const colored = renderTable(input, { width: 40, color: true, theme: INFINITE_R4_THEME });
    expect(colored.lines.map(stripAnsi)).toEqual(plain.lines);
    expect(colored.lines.join("")).toContain("\u001b[1;38;2;255;255;255m");
    expect(plain.lines.join("")).not.toMatch(/[\u001b‮]/);
  });

  it("paints each segment itself: body cells in the caller's role, never a full reset", () => {
    const theme = INFINITE_R4_THEME;
    const input = { columns: [{ label: "Name" }, { label: "Spend" }], rows: [["Hook", "$1.00"]], total: ["Total", "$1.00"] };
    const text = renderTable(input, { width: 40, color: true, theme, role: "text" });
    expect(text.lines.every((l) => !l.includes("\u001b[0m"))).toBe(true);
    expect(r4Segments(text.lines[3]!)).toEqual(seg(["│", "line"], [" Hook  ", ""], ["│", "line"], [" $1.00 ", ""], ["│", "line"]));
    const muted = renderTable(input, { width: 40, color: true, theme, role: "muted" });
    expect(r4Segments(muted.lines[3]!)).toEqual(seg(["│", "line"], [" ", ""], ["Hook", "dim"], ["  ", ""], ["│", "line"], [" ", ""], ["$1.00", "dim"], [" ", ""], ["│", "line"]));
    const record = renderTable(input, { width: 6, color: true, theme, role: "text" });
    expect(record.fallback).toBe("record");
    expect(record.lines.every((l) => !l.includes("\u001b[0m"))).toBe(true);
  });
});

// terminal-r4 `table()`, from the synthetic goldens region-table-numbers-100 and
// region-table-numbers-hidden-60 (infinite-os carries synthetic data only).
describe("renderTable: the r4 look", () => {
  const ads: TableInput = {
    columns: [
      { label: "Campaign", dropPriority: 0 }, { label: "Spend", dropPriority: 0 }, { label: "Impressions", dropPriority: 4 },
      { label: "Clicks", dropPriority: 1 }, { label: "CTR", dropPriority: 0 }, { label: "CPC", dropPriority: 3 }, { label: "Conv", dropPriority: 2 }
    ],
    rows: [
      ["Ad set 01", "$10.00", "3,000", "40", "1.33%", "$0.25", "0"],
      ["Ad set 02", "$12.50", "2,000", "30", "1.50%", "$0.42", "0"],
      ["Ad set 04", "$17.50", "4,000", "50", "1.25%", "$0.35", "0"]
    ],
    total: ["Total", "$40.00", "9,000", "120", "1.33%", "$0.33", "0"]
  };
  const B = (text: string): [string, string] => [text, "b"];
  const L: [string, string] = ["│", "line"];

  it("borders in line, header and Total bold white, numbers right-aligned (region-table-numbers-100)", () => {
    const t = renderTable(ads, { width: 69, color: true, theme: INFINITE_R4_THEME });
    expect(t.hidden).toEqual([]);
    const lines = t.lines.map(r4Segments);
    expect(lines[0]).toEqual(seg(["┌───────────┬────────┬─────────────┬────────┬───────┬───────┬──────┐", "line"]));
    expect(lines[1]).toEqual(seg(L, [" ", ""], B("Campaign"), ["  ", ""], L, ["  ", ""], B("Spend"), [" ", ""], L, [" ", ""], B("Impressions"), [" ", ""], L,
      [" ", ""], B("Clicks"), [" ", ""], L, ["   ", ""], B("CTR"), [" ", ""], L, ["   ", ""], B("CPC"), [" ", ""], L, [" ", ""], B("Conv"), [" ", ""], L));
    expect(lines[2]).toEqual(seg(["├───────────┼────────┼─────────────┼────────┼───────┼───────┼──────┤", "line"]));
    expect(lines[3]).toEqual(seg(L, [" Ad set 01 ", ""], L, [" $10.00 ", ""], L, ["       3,000 ", ""], L, ["     40 ", ""], L, [" 1.33% ", ""], L, [" $0.25 ", ""], L, ["    0 ", ""], L));
    expect(lines[6]).toEqual(seg(["├───────────┼────────┼─────────────┼────────┼───────┼───────┼──────┤", "line"]));
    expect(lines[7]).toEqual(seg(L, [" ", ""], B("Total"), ["     ", ""], L, [" ", ""], B("$40.00"), [" ", ""], L, ["       ", ""], B("9,000"), [" ", ""], L,
      ["    ", ""], B("120"), [" ", ""], L, [" ", ""], B("1.33%"), [" ", ""], L, [" ", ""], B("$0.33"), [" ", ""], L, ["    ", ""], B("0"), [" ", ""], L));
    expect(lines[8]).toEqual(seg(["└───────────┴────────┴─────────────┴────────┴───────┴───────┴──────┘", "line"]));
  });

  it("drops Impressions first at 60 columns and keeps the rest whole (region-table-numbers-hidden-60)", () => {
    const t = renderTable(ads, { width: 60, color: false, theme: INFINITE_R4_THEME });
    expect(t.hidden).toEqual(["Impressions"]);
    expect(t.lines).toEqual([
      "┌───────────┬────────┬────────┬───────┬───────┬──────┐",
      "│ Campaign  │  Spend │ Clicks │   CTR │   CPC │ Conv │",
      "├───────────┼────────┼────────┼───────┼───────┼──────┤",
      "│ Ad set 01 │ $10.00 │     40 │ 1.33% │ $0.25 │    0 │",
      "│ Ad set 02 │ $12.50 │     30 │ 1.50% │ $0.42 │    0 │",
      "│ Ad set 04 │ $17.50 │     50 │ 1.25% │ $0.35 │    0 │",
      "├───────────┼────────┼────────┼───────┼───────┼──────┤",
      "│ Total     │ $40.00 │    120 │ 1.33% │ $0.33 │    0 │",
      "└───────────┴────────┴────────┴───────┴───────┴──────┘"
    ]);
  });
});

describe("renderTable: a long row label wraps before the numbers drop (live M7)", () => {
  const name = "Sample · Trials · US · 2026-09-01 — sample_b1_trial_us";
  const wide: TableInput = {
    columns: [{ label: "" }, { label: "Spent", dropPriority: 0 }, { label: "Impressions", dropPriority: 4 },
      { label: "Link clicks", dropPriority: 1 }, { label: "CTR (link)", dropPriority: 0 }],
    rows: [[name, "$120.00", "1,000", "40", "4.00%"], ["Short one", "$8.00", "90", "3", "3.33%"]]
  };

  it("with labelMin, a label too wide for the numbers wraps on its words inside its cell, and no number drops", () => {
    const t = renderTable(wide, { width: 80, color: false, theme: resolveTheme(), labelMin: 20 });
    expect(t.hidden).toEqual([]);
    expect(t.lines).toEqual([
      "┌────────────────────────┬─────────┬─────────────┬─────────────┬────────────┐",
      "│                        │   Spent │ Impressions │ Link clicks │ CTR (link) │",
      "├────────────────────────┼─────────┼─────────────┼─────────────┼────────────┤",
      "│ Sample · Trials · US · │ $120.00 │       1,000 │          40 │      4.00% │",
      "│ 2026-09-01 —           │         │             │             │            │",
      "│ sample_b1_trial_us     │         │             │             │            │",
      "│ Short one              │   $8.00 │          90 │           3 │      3.33% │",
      "└────────────────────────┴─────────┴─────────────┴─────────────┴────────────┘"
    ]);
    expect(t.rowLines).toEqual([[3, 3], [6, 1]]);
  });

  it("narrower than the label's floor, it wraps to the floor and the lowest numbers drop", () => {
    const t = renderTable(wide, { width: 60, color: false, theme: resolveTheme(), labelMin: 20 });
    expect(t.hidden).toEqual(["Impressions", "Link clicks"]);
    expect(t.lines.every((line) => displayWidth(line) <= 60)).toBe(true);
    expect(t.lines).toContain("│ Sample · Trials · US │ $120.00 │      4.00% │");
    expect(t.lines.join("\n")).toContain("sample_b1_trial_us");
  });

  it("a table that fits as it is never wraps (the r4 goldens keep one line per row)", () => {
    const t = renderTable(wide, { width: 120, color: false, theme: resolveTheme(), labelMin: 20 });
    expect(t.lines.filter((line) => line.includes(name))).toHaveLength(1);
    expect(t.rowLines).toEqual([[3, 1], [4, 1]]);
  });

  it("without labelMin the label never wraps (markdown tables keep r4's drop rule)", () => {
    const t = renderTable(wide, { width: 100, color: false, theme: resolveTheme() });
    expect(t.lines.filter((line) => line.includes(name))).toHaveLength(1);
    expect(t.hidden).toEqual(["Impressions"]);
  });
});

describe("looksNumeric", () => {
  it.each(["$1,234.50", "1.22%", "−3", "-3", "9,790", "—", "1.2k", "0", "+4", "€12", "—¹", "2.5x"])("%s is numeric", (cell) => {
    expect(looksNumeric(cell)).toBe(true);
  });
  it.each(["Ad set 01", "Total", "", "abc 12", "12 people", "v2.1.0"])("%s is not numeric", (cell) => {
    expect(looksNumeric(cell)).toBe(false);
  });
});
