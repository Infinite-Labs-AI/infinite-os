import { describe, expect, it } from "vitest";
import { displayWidth, stripAnsi } from "../tui/lib/display-width.js";
import { ansiFg, INFINITE_R4_THEME, resolveTheme } from "../tui/theme.js";
import { r4Segments, seg } from "./r4-segments.test-util.js";
import { holdOpenMarkers, parseInline, wrapSpans } from "./markdown-inline.js";
import { renderMarkdown } from "./markdown-render.js";
import { stripInlineMarkup } from "./markdown.js";

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

  it("draws headings in r4's b, code in cyan, links cyan underlined with ↗, bullets and the code wrap mark dim", () => {
    const r4 = INFINITE_R4_THEME;
    const [top, , next] = renderMarkdown("# Top\n\n## Next", { width: 40, color: true, theme: r4 });
    expect(r4Segments(top!)).toEqual(seg(["Top", "b"]));
    expect(r4Segments(next!)).toEqual(seg(["Next", "b"]));
    expect(r4Segments(renderMarkdown("Run `npm test` or read [the docs](https://example.com/docs).", { width: 60, color: true, theme: r4 })[0]!)).toEqual(
      seg(["Run ", ""], ["npm test", "cyan"], [" or read ", ""], ["the docs ↗", "cyan u"], [".", ""])
    );
    expect(r4Segments(renderMarkdown("- one\n  - two", { width: 40, color: true, theme: r4 })[1]!)).toEqual(seg(["  ", ""], ["◦", "dim"], [" two", ""]));
    expect(r4Segments(renderMarkdown("> said\n\n---", { width: 6, color: true, theme: r4 })[0]!)).toEqual(seg(["│", "line"], [" said", ""]));
    const code = renderMarkdown("```\n" + "x".repeat(20) + "\n```", { width: 12, color: true, theme: r4 });
    expect(r4Segments(code[0]!)).toEqual(seg(["  ", ""], ["x".repeat(9), "cyan"], ["↩", "dim"]));
  });

  it("keeps the caller's colour after a styled span (a dim note stays dim)", () => {
    const r4 = INFINITE_R4_THEME;
    const [line] = renderMarkdown("see `x` now", { width: 40, color: true, theme: r4, role: "muted" });
    expect(line).toContain(`\u001b[39m${ansiFg(r4, "muted")}`);
  });

  it("sets a last Total row apart: a rule above it and bold, like the views' tables (N9)", () => {
    const out = renderMarkdown("| Ad | Spend |\n|---|--:|\n| Hook A | $1.00 |\n| Hook B | $2.00 |\n| Total | $3.00 |", { width: 40, color: false, theme });
    expect(out).toEqual([
      "┌────────┬───────┐",
      "│ Ad     │ Spend │",
      "├────────┼───────┤",
      "│ Hook A │ $1.00 │",
      "│ Hook B │ $2.00 │",
      "├────────┼───────┤",
      "│ Total  │ $3.00 │",
      "└────────┴───────┘"
    ]);
    const colored = renderMarkdown("| Ad | Spend |\n|---|--:|\n| Hook A | $1.00 |\n| Total | $1.00 |", { width: 40, color: true, theme: INFINITE_R4_THEME });
    expect(r4Segments(colored[5]!)).toEqual(seg(["│", "line"], [" ", ""], ["Total", "b"], ["  ", ""], ["│", "line"], [" ", ""], ["$1.00", "b"], [" ", ""], ["│", "line"]));
  });

  it("never promises a wider window it cannot name: a hidden column says how many more columns it needs (M3)", () => {
    const out = renderMarkdown(
      "| Name | One | Two | Three |\n|---|---|---|---|\n| Ad set 01 | 10 | 20 | 30 |",
      { width: 24, color: false, theme }
    );
    expect(out.slice(-2)).toEqual(["+ Three, Two · widen by", "9 cols to see"]);
    const wide = renderMarkdown(
      "| Name | One | Two | Three |\n|---|---|---|---|\n| Ad set 01 | 10 | 20 | 30 |",
      { width: 32, color: false, theme }
    );
    const wider = renderMarkdown(
      "| Name | One | Two | Three |\n|---|---|---|---|\n| Ad set 01 | 10 | 20 | 30 |",
      { width: 26, color: false, theme }
    );
    expect(wider.slice(-2)).toEqual(["+ Three · widen by 7 cols", "to see"]);
    expect(wide.at(-1)).toBe("+ Three · widen by 1 col to see");
    expect(wide.join("\n")).not.toContain("widen the window");
    const roomy = renderMarkdown(
      "| Name | One | Two | Three |\n|---|---|---|---|\n| Ad set 01 | 10 | 20 | 30 |",
      { width: 160, color: false, theme }
    );
    expect(roomy.join("\n")).not.toContain("+ ");
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
    expect(out).not.toContain("↗");
    expect(parseInline("![c](https://x/c.png)")[0]?.link).toBeUndefined();
    expect(stripInlineMarkup("see ![c](https://x/c.png)")).toBe("see c");
  });

  it("plain mode keeps text exactly as written: no markdown, only scrub and wrap", () => {
    expect(renderMarkdown("- a __init__.py *x*", { width: 40, color: false, theme, plain: true })).toEqual(["- a __init__.py *x*"]);
    expect(renderMarkdown("# comment\n\n+ added\nC:\\Users\\me\\_file", { width: 40, color: false, theme, plain: true })).toEqual([
      "# comment",
      "",
      "+ added",
      "C:\\Users\\me\\_file"
    ]);
    expect(renderMarkdown("x\u001b]0;t\u0007y", { width: 40, color: false, theme, plain: true })).toEqual(["xy"]);
    expect(renderMarkdown("  indented   a    b", { width: 40, color: false, theme, plain: true })).toEqual(["  indented   a    b"]);
    expect(renderMarkdown("    one two three four", { width: 12, color: false, theme, plain: true })).toEqual(["    one two", "    three", "    four"]);
    const wrapped = renderMarkdown("src/__init__.py src/__main__.py src/a_b_c.py", { width: 16, color: true, theme, plain: true });
    expect(wrapped.every((l) => displayWidth(l) <= 16)).toBe(true);
    expect(wrapped.map(stripAnsi).join(" ")).toBe("src/__init__.py src/__main__.py src/a_b_c.py");
  });

  it("keeps a body row of single-hyphen cells in a table without a header divider", () => {
    const out = renderMarkdown("| A | B |\n| x | 1 |\n| - | - |", { width: 40, color: false, theme });
    const body = out.filter((l) => l.startsWith("│"));
    expect(body).toHaveLength(3); // header + 2 body rows
    expect(body[2]?.replace(/\s+/g, " ")).toBe("│ - │ - │");
  });

  it("never ends a table border with a full reset inside a colored line", () => {
    const out = renderMarkdown("| A | B |\n|---|--:|\n| x | 12 |", { width: 40, color: true, theme, role: "muted" });
    expect(out.some((l) => l.includes("┌"))).toBe(true);
    expect(out.every((l) => !l.includes("\u001b[0m"))).toBe(true);
  });

  it.each([1, 2, 3, 4, 5])("keeps every line within width %i for a mixed document", (width) => {
    const doc = "# Head\n\n- one two\n  - nested item\n1. first\n\n> quoted words\n\n```\nconst value = 1;\n```\n\n| A | B |\n|---|---|\n| x | 1 |";
    for (const color of [false, true]) {
      const out = renderMarkdown(doc, { width, color, theme });
      expect(out.filter((l) => displayWidth(l) > width)).toEqual([]);
    }
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

describe("pathological model text (wave-1 adversarial review)", () => {
  it("a 5,000-deep quote does not overflow the stack, and every line still fits", () => {
    const out = renderMarkdown(`${">".repeat(5000)} deep`, { width: 40, color: false, theme });
    expect(out.every((l) => displayWidth(l) <= 40)).toBe(true);
    expect(out.join("\n")).toContain("deep");
  });

  it("past the nesting cap the remaining > print as text under the bars", () => {
    const out = renderMarkdown(`${">".repeat(12)} deep`, { width: 80, color: false, theme });
    expect(out).toHaveLength(1);
    const bars = (out[0]!.match(/│/g) ?? []).length;
    expect(bars).toBeLessThanOrEqual(8);
    expect(out[0]).toContain(`${">".repeat(12 - bars)} deep`);
  });

  it("nested quotes under the cap still render as bars", () => {
    expect(renderMarkdown(">> two", { width: 40, color: false, theme })).toEqual(["│ │ two"]);
  });

  it("20,000 unmatched ** openers render in linear time", () => {
    const text = "**a ".repeat(20000);
    const started = performance.now();
    const out = renderMarkdown(text, { width: 80, color: false, theme });
    const elapsed = performance.now() - started;
    expect(out.every((l) => displayWidth(l) <= 80)).toBe(true);
    expect(out.join("")).toContain("**a");
    expect(elapsed).toBeLessThan(500);
  });

  it("70 KB of unmatched ** between words renders in linear time", () => {
    const text = "x ** y ".repeat(10000);
    const started = performance.now();
    renderMarkdown(text, { width: 80, color: false, theme });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("70 KB of unmatched [ and 10,000 unclosed [x]( render in linear time", () => {
    for (const text of ["[".repeat(70000), "[x](".repeat(10000)]) {
      const started = performance.now();
      const out = renderMarkdown(text, { width: 80, color: false, theme });
      expect(performance.now() - started).toBeLessThan(500);
      expect(out.every((l) => displayWidth(l) <= 80)).toBe(true);
    }
  });

  it("5,000 nested link labels do not overflow the stack", () => {
    const out = renderMarkdown(`${"[".repeat(5000)}x${"](u)".repeat(5000)}`, { width: 80, color: false, theme });
    expect(out.every((l) => displayWidth(l) <= 80)).toBe(true);
  });

  it("links keep their label and URL after the linear index", () => {
    const out = renderMarkdown("see [the (docs)](https://e.x/a_(b)) and [x](\nnope) [y](z", { width: 120, color: false, theme });
    expect(out.join("\n")).toContain("the (docs)");
    expect(out.join("\n")).toContain("[y](z");
  });

  it("memoized closer lookup keeps emphasis results unchanged", () => {
    const out = renderMarkdown("a **b c **d e **f** g *h* _i_ ~~j~~", { width: 80, color: false, theme });
    // Pinned against the pre-memo implementation's output.
    expect(out).toEqual(["a b c **d e **f g h i j"]);
  });
});

// Eval M4: a half-received span never prints its markers, while streaming or after a stop.
describe("holdOpenMarkers", () => {
  it.each([
    ["**Cold brew car", "Cold brew car"],
    ["Try **Cold brew car", "Try Cold brew car"],
    ["Try **Cold brew carousel**", "Try **Cold brew carousel**"],
    ["**Cold brew car*", "Cold brew car*"],
    ["See `npm te", "See npm te"],
    ["See `npm test` now", "See `npm test` now"],
    ["an _italic wor", "an italic wor"],
    ["snake_case and 5*3 and 5 * 3", "snake_case and 5*3 and 5 * 3"],
    ["ends with **", "ends with "],
    ["~~gone", "gone"],
    ["Read [the docs](https://exa", "Read the docs"],
    ["Read [the docs]", "Read the docs"],
    ["Read [the do", "Read the do"],
    ["done **one**.\n\n**Two is still", "done **one**.\n\nTwo is still"],
    ["**early unclosed stays\n\nlater para", "**early unclosed stays\n\nlater para"],
    ["```\nconst a = **b\n", "```\nconst a = **b\n"],
    // A marker inside a URL, a path or after = : . @ # is text, never an opener.
    ["see https://x.com/_foo and **bold", "see https://x.com/_foo and bold"],
    ["open src/_drafts/*.md and _ital", "open src/_drafts/*.md and ital"],
    ["set key=_val, user@_x, #_tag and a.b_c", "set key=_val, user@_x, #_tag and a.b_c"],
    ["see ftp://host/~~x/__y", "see ftp://host/~~x/__y"]
  ])("%j → %j", (partial, held) => {
    expect(holdOpenMarkers(partial)).toBe(held);
  });

  it("renders a held partial without a literal marker", () => {
    expect(renderMarkdown(holdOpenMarkers("Try **Cold brew car"), { width: 60, color: false, theme })).toEqual(["Try Cold brew car"]);
  });
});
