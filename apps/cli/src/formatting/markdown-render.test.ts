import { describe, expect, it } from "vitest";
import { displayWidth, stripAnsi } from "../tui/lib/display-width.js";
import { resolveTheme } from "../tui/theme.js";
import { parseInline, wrapSpans } from "./markdown-inline.js";
import { renderMarkdown } from "./markdown-render.js";

const theme = resolveTheme({});

describe("renderMarkdown", () => {
  it("measures visible width, so emphasis across a wrap never leaks markers", () => {
    const lines = renderMarkdown("This is **a long bold phrase that crosses the wrap** end.", { width: 24, color: false, theme });
    expect(lines.join("\n")).not.toContain("**");
    expect(lines.every((l) => displayWidth(l) <= 24)).toBe(true);
  });

  it("renders headings, lists, fences and tables", () => {
    const out = renderMarkdown("# Spend\n\n- one\n  - two\n1. first\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|--:|\n| x | 12 |", { width: 60, color: false, theme }).join("\n");
    expect(out).toMatch(/^Spend$/m);
    expect(out).toMatch(/^• one$/m); expect(out).toMatch(/^  ◦ two$/m); expect(out).toMatch(/^1\. first$/m);
    expect(out).toContain("  const a = 1;");   // code: indented, no wrap reflow, no ``` fences
    expect(out).toContain("┌");                 // tables go through renderTable
  });

  it("keeps a code line whole by hard-breaking with a continuation mark", () => {
    const out = renderMarkdown("```\n" + "x".repeat(50) + "\n```", { width: 30, color: false, theme });
    expect(out.some((l) => l.endsWith("↩"))).toBe(true);
  });

  it("styles before wrapping: with color on, the visible text matches the plain render and every line fits", () => {
    const text = "Plain **bold words that run long** then *italic* and `code` and ~~gone~~ and [the docs](https://example.com/docs) end.";
    const plain = renderMarkdown(text, { width: 28, color: false, theme });
    const colored = renderMarkdown(text, { width: 28, color: true, theme });
    expect(colored.map(stripAnsi)).toEqual(plain);
    expect(colored.every((l) => displayWidth(l) <= 28)).toBe(true);
    expect(colored.join("")).toContain("\u001b[1m");
    expect(colored.join("")).toContain("\u001b[3m");
    expect(colored.join("")).toContain("\u001b[9m");
    expect(plain.join("\n")).not.toMatch(/[*`~]/);
  });

  it("renders a link as its text with ↗ and never prints the URL", () => {
    const out = renderMarkdown("Read [the docs](https://example.com/docs) now.", { width: 60, color: false, theme }).join("\n");
    expect(out).toBe("Read the docs ↗ now.");
  });

  it("keeps source line breaks inside a paragraph and blank lines between blocks", () => {
    const out = renderMarkdown("Spend: $10.00\nClicks: 40\n\nDone.", { width: 60, color: false, theme });
    expect(out).toEqual(["Spend: $10.00", "Clicks: 40", "", "Done."]);
  });

  it("indents wrapped list text under the item, not under the bullet", () => {
    const out = renderMarkdown("- alpha beta gamma delta epsilon zeta", { width: 16, color: false, theme });
    expect(out[0]).toMatch(/^• alpha/);
    expect(out.slice(1).every((l) => l.startsWith("  ") && !l.startsWith("   "))).toBe(true);
    expect(out.every((l) => displayWidth(l) <= 16)).toBe(true);
  });

  it("numbers ordered items as written and nests a bullet under them", () => {
    const out = renderMarkdown("1. first\n2. second\n   - inner", { width: 40, color: false, theme });
    expect(out).toEqual(["1. first", "2. second", "  ◦ inner"]);
  });

  it("renders quotes with a bar and rules as a line", () => {
    const out = renderMarkdown("> quoted words\n\n---\n\nafter", { width: 20, color: false, theme });
    expect(out[0]).toBe("│ quoted words");
    expect(out).toContain("─".repeat(20));
    expect(out.at(-1)).toBe("after");
  });

  it("colors a level-1 heading with the primary color and keeps lower headings bold only", () => {
    const out = renderMarkdown("# Top\n\n## Next", { width: 40, color: true, theme });
    expect(out[0]).toContain("\u001b[1m");
    expect(out[0]).toContain("\u001b[38;2;0;213;255m");
    expect(stripAnsi(out[0] ?? "")).toBe("Top");
    expect(out[2]).toContain("\u001b[1m");
    expect(out[2]).not.toContain("\u001b[38;2;0;213;255m");
  });

  it("scrubs terminal control and bidi characters out of every text node, code included", () => {
    const out = renderMarkdown("Hi \u001b]0;title\u0007there ‮evil\n\n```\nrm\u001b[2J -rf\n```", { width: 60, color: false, theme }).join("\n");
    expect(out).not.toMatch(/[\u001b\u0007‮]/);
    expect(out).toContain("Hi");
    expect(out).toContain("evil");
  });

  it("strips inline markup inside table cells and right-aligns a --: column", () => {
    const out = renderMarkdown("| Name | Clicks |\n|---|--:|\n| **Hook A** | 40 |\n| Hook B | 1,000 |", { width: 60, color: false, theme });
    expect(out.join("\n")).not.toContain("**");
    expect(out.find((l) => l.includes("Hook A"))).toBe("│ Hook A │     40 │");
  });

  it("names the columns a narrow table had to hide", () => {
    const out = renderMarkdown(
      "| Name | One | Two | Three |\n|---|---|---|---|\n| Ad set 01 | 10 | 20 | 30 |",
      { width: 24, color: false, theme }
    );
    expect(out.join("\n")).toContain("+ Three, Two");
    expect(out.every((l) => displayWidth(l) <= 24)).toBe(true);
  });

  it("never prints image URLs", () => {
    const out = renderMarkdown("See ![chart](https://example.com/c.png) here.", { width: 60, color: false, theme }).join("\n");
    expect(out).not.toContain("http");
    expect(out).toContain("chart");
  });

  it("keeps literal underscores inside words", () => {
    expect(renderMarkdown("call run_breakdown_query now", { width: 60, color: false, theme })).toEqual(["call run_breakdown_query now"]);
  });

  it("returns one empty line for empty input", () => {
    expect(renderMarkdown("", { width: 40, color: false, theme })).toEqual([""]);
  });
});

describe("parseInline and wrapSpans", () => {
  it("parses nested emphasis, code and links into spans", () => {
    expect(parseInline("a **b *c*** `d` [e](u)")).toEqual([
      { text: "a " },
      { text: "b ", bold: true },
      { text: "c", bold: true, italic: true },
      { text: " " },
      { text: "d", code: true },
      { text: " " },
      { text: "e", link: "u" }
    ]);
  });

  it("wraps on visible width and carries the indent", () => {
    const lines = wrapSpans([{ text: "one two " }, { text: "three", bold: true }, { text: " four" }], 10, { first: "• ", rest: "  " });
    expect(lines.map((line) => line.map((span) => span.text).join(""))).toEqual(["• one two", "  three", "  four"]);
    expect(lines[1]?.find((span) => span.text === "three")?.bold).toBe(true);
  });
});
