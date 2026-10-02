// The golden harness's own model: SGR → tokens → segments, normalization, and
// region location/diff. The round trip below is the property every golden test
// depends on (spec §11d): painting a golden with the palette and reading it back
// gives the golden, exactly, at the truecolor and 256 tiers.
import { describe, expect, it } from "vitest";

import { ansiLineToCells, ansiToSegmentLines, applySgr, RESET_STATE, tokenOf } from "./ansi-to-segments.js";
import { compareRegion, formatRegionResults, goldenRegionRows, locate, paintGoldenLines } from "./compare.js";
import { firstProblem, GoldenEvaluator } from "./evaluate.js";
import { goldenIds, loadGolden } from "./goldens.js";
import { normalizeCells, textOf, type SegmentLine } from "./normalize.js";
import { PALETTE, xterm256Hex } from "./palette.js";

const ESC = "\u001b";
const sgr = (tier: "truecolor" | "256") => (token: string) => PALETTE.tokens[token]?.sgr[tier] ?? "";
const cells = (line: string) => ansiLineToCells(line).cells;

describe("SGR → r4 tokens", () => {
  it("maps every palette token back to itself at the truecolor and 256 tiers", () => {
    for (const tier of ["truecolor", "256"] as const) {
      for (const [name, token] of Object.entries(PALETTE.tokens)) {
        if (name === "" || name === "mag" || !token.sgr[tier]) continue;
        const [cell] = cells(`${ESC}[${token.sgr[tier]}mx`);
        expect(cell?.style, `${name} @ ${tier}`).toBe(name);
      }
    }
  });

  it("default fg is body text; an unknown colour names itself; faint is not dim", () => {
    expect(cells(`${ESC}[39mx`)[0]?.style).toBe("");
    expect(cells(`${ESC}[38;2;0;213;255mx`)[0]?.style).toBe("?#00d5ff");
    expect(cells(`${ESC}[2mx`)[0]?.style).toBe("faint");
    expect(cells(`${ESC}[1mx`)[0]?.style).toBe("bold");
    expect(cells(`${ESC}[36mx`)[0]?.style).toBe("?ansi:6");
  });

  it("a nested token inside a chip keeps the chip; specific resets end only their attribute", () => {
    const state = applySgr(applySgr(RESET_STATE, "38;2;255;255;255;48;2;42;52;64"), "39");
    expect(tokenOf(state)).toBe("key");
    expect(tokenOf(applySgr(applySgr(RESET_STATE, "4;38;2;86;200;232"), "24"))).toBe("cyan");
    expect(tokenOf(applySgr(applySgr(RESET_STATE, "1;38;2;233;180;76"), "22"))).toBe("amber");
  });

  it("drops cursor and OSC sequences; carries the pen across rows", () => {
    expect(textOf(normalizeCells(cells(`${ESC}[2K${ESC}]8;;https://x${ESC}\\hi${ESC}[1G`)))).toBe("hi");
    const [first, second] = ansiToSegmentLines(`${ESC}[38;2;58;70;83m──\nab${ESC}[39m`);
    expect(first).toEqual([{ text: "──", style: "line" }]);
    expect(second).toEqual([{ text: "ab", style: "line" }]);
  });

  it("xterm 256 cube and ramp", () => {
    expect(xterm256Hex(81)).toBe("#5fd7ff");
    expect(xterm256Hex(243)).toBe("#767676");
    expect(xterm256Hex(7)).toBeNull();
  });
});

describe("normalization (golden_compare.py normalize)", () => {
  const n = (spec: [string, string][]) => normalizeCells(spec.flatMap(([text, style]) => [...text].map((ch) => ({ ch, style }))));

  it("whitespace between two equal styles takes that style; otherwise none; trailing plain space is trimmed", () => {
    expect(n([["a", "dim"], ["  ", "dim"], ["b", "dim"]])).toEqual([{ text: "a  b", style: "dim" }]);
    expect(n([["a", "dim"], ["  ", "dim"], ["b", "b"]])).toEqual([
      { text: "a", style: "dim" }, { text: "  ", style: "" }, { text: "b", style: "b" }
    ]);
    expect(n([["a", ""], ["   ", "dim"]])).toEqual([{ text: "a", style: "" }]);
  });

  it("background and underline keep their spaces", () => {
    expect(n([[" p ", "pk"]])).toEqual([{ text: " p ", style: "pk" }]);
    expect(n([["x", ""], ["   ", "sel"]])).toEqual([{ text: "x", style: "" }, { text: "   ", style: "sel" }]);
    expect(n([["a ↗", "cyan u"]])).toEqual([{ text: "a ↗", style: "cyan u" }]);
  });
});

describe("every synthetic golden round-trips through paint → read back", () => {
  const ids = goldenIds();

  it("carries the whole synthetic set (144) and nothing product-only", () => {
    expect(ids.length).toBe(144);
    expect(ids.some((id) => id.startsWith("width-") || id === "keys-map")).toBe(false);
  });

  for (const tier of ["truecolor", "256"] as const) {
    it(`at ${tier}`, () => {
      const failures: string[] = [];
      for (const id of ids) {
        const golden = loadGolden(id);
        const sets: SegmentLine[][] = [golden.lines];
        const data = golden.data as { lines?: SegmentLine[] } | Array<{ header?: SegmentLine; line?: SegmentLine }> | undefined;
        if (Array.isArray(data)) sets.push(data.flatMap((row) => [row.header ?? [], row.line ?? []]));
        else if (data?.lines) sets.push(data.lines);
        for (const lines of sets) {
          const back = ansiToSegmentLines(paintGoldenLines(lines, sgr(tier)));
          const row = lines.findIndex((line, i) => JSON.stringify(line) !== JSON.stringify(back[i]));
          if (row >= 0) failures.push(`${id} row ${row}: ${JSON.stringify(lines[row])} != ${JSON.stringify(back[row])}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("region location and diff", () => {
  const golden = loadGolden("flow-pause-01-needs-your-ok--c100");
  const screen = ansiToSegmentLines(paintGoldenLines(golden.lines, sgr("truecolor")));

  it("a painted golden matches itself in every region, found wherever it sits (D1: top bar at the bottom)", () => {
    const shuffled = [...screen.slice(2), ...screen.slice(0, 2)];
    for (const region of ["topbar", "body", "steps", "composer", "keybar"] as const) {
      const rows = goldenRegionRows(golden, region);
      expect(compareRegion(shuffled, rows, region).verdict, region).toBe("MATCH");
    }
  });

  it("a component golden is found inside the details pane (column offset)", () => {
    const card = loadGolden("region-card-needs-ok").lines;
    const at = locate(screen, card);
    expect(at).toEqual({ row: 5, col: 31 });
    expect(compareRegion(screen, card, "card").verdict).toBe("MATCH");
  });

  it("names the first differing row, the token and a caret", () => {
    const repainted = screen.map((line) => line.map((segment) => (segment.style === "line" ? { ...segment, style: "?#5fbbd8" } : segment)));
    const result = compareRegion(repainted, goldenRegionRows(golden, "rule_top"), "rule_top");
    expect(result.verdict).toBe("DIFF");
    expect(formatRegionResults(golden.id, [result])).toMatch(/token "line" vs "\?#5fbbd8"/u);
    expect(compareRegion(screen, [[{ text: "nowhere on screen", style: "" }]], "x").verdict).toBe("NOT_FOUND");
  });
});

describe("the evaluator passes r4 itself (a renderer that prints the golden)", () => {
  // The renderer stands in for a CLI that draws r4 exactly: it prints the
  // golden of the screen it is asked for. Every frame and line-region golden
  // must then match, except where a binding decision changes the golden.
  const painted = new GoldenEvaluator((fixture, cols) => {
    // r4's c100 details pane is the 69-col column the card regions are drawn in.
    const golden = loadGolden(`${fixture.screen}--c${cols === 69 ? 100 : cols}`);
    return paintGoldenLines(golden.lines, sgr("truecolor")).join("\n");
  });
  const DECIDED = new Set([
    "flow-pause-02-working--c60", "flow-pause-02-working--c100", "flow-pause-02-working--c160",
    "flow-images-02-making-them--c60", "flow-images-02-making-them--c100", "flow-images-02-making-them--c160",
    "flow-images-06-with-your-codex--c60", "flow-images-06-with-your-codex--c100", "flow-images-06-with-your-codex--c160",
    "flow-images-07-cmd-l-only--c60", "flow-images-07-cmd-l-only--c160", "region-keybar-busy",
    // r4 defect, not a decision: the done card's title fills the box, so boxed() draws its top border 70 wide over
    // 69-wide rows, and the c100 frame truncates that border with "…". The region and the frame disagree.
    "region-card-done-green"
  ]);

  it("matches every frame and line-region golden; fails exactly the decided ones", () => {
    const wrong: string[] = [];
    for (const id of goldenIds()) {
      const golden = loadGolden(id);
      if (golden.data !== undefined) continue;
      const result = painted.evaluate(golden, id);
      if (result.pass === DECIDED.has(id)) wrong.push(`${id}: pass=${result.pass} ${firstProblem(result)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("the 80–119 col body is skipped by the layout decision, and says so", () => {
    const result = painted.evaluate(loadGolden("view-06-change--c100"));
    expect(result.skipped).toEqual(["body (LAYOUT: one column below 120 cols; r4 splits at 80)"]);
    expect(result.regions.map((region) => region.region)).not.toContain("body");
  });
});
