import { describe, expect, it } from "vitest";
import { displayWidth, stripAnsi } from "../tui/lib/display-width.js";
import { ansiFg, resolveTheme } from "../tui/theme.js";
import { looksNumeric, renderTable } from "./table.js";

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

  it("truncates a cell at half the width with an ellipsis", () => {
    const t = renderTable(
      { columns: [{ label: "Name" }, { label: "Spend" }], rows: [["Ad set with a very long synthetic name", "$1.00"]] },
      { width: 30, color: false, theme: resolveTheme() }
    );
    expect(t.fallback).toBeNull();
    expect(t.lines.join("\n")).toContain("…");
    expect(t.lines.every((l) => displayWidth(l) <= 30)).toBe(true);
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
    const plain = renderTable(input, { width: 40, color: false, theme: resolveTheme() });
    const colored = renderTable(input, { width: 40, color: true, theme: resolveTheme() });
    expect(colored.lines.map(stripAnsi)).toEqual(plain.lines);
    expect(colored.lines.join("")).toContain("\u001b[1m");
    expect(plain.lines.join("")).not.toMatch(/[\u001b‮]/);
  });

  it("paints borders back to the caller's role instead of a full reset", () => {
    const theme = resolveTheme();
    const input = { columns: [{ label: "Name" }, { label: "Spend" }], rows: [["Hook", "$1.00"]], total: ["Total", "$1.00"] };
    const text = renderTable(input, { width: 40, color: true, theme, role: "text" });
    expect(text.lines.every((l) => !l.includes("\u001b[0m"))).toBe(true);
    expect(text.lines[1]).toContain(`│${ansiFg(theme, "text")}`);
    const muted = renderTable(input, { width: 40, color: true, theme, role: "muted" });
    expect(muted.lines[3]).toContain(`│${ansiFg(theme, "muted")} Hook`);
    const record = renderTable(input, { width: 6, color: true, theme, role: "text" });
    expect(record.fallback).toBe("record");
    expect(record.lines.every((l) => !l.includes("\u001b[0m"))).toBe(true);
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
