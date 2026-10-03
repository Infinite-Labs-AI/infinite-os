// The golden harness's own model: SGR → tokens → segments, normalization, and
// region location/diff. The round trip below is the property every golden test
// depends on (spec §11d): painting a golden with the palette and reading it back
// gives the golden, exactly, at the truecolor and 256 tiers.
import { describe, expect, it } from "vitest";

import { ansiLineToCells, ansiToSegmentLines, applySgr, RESET_STATE, tokenOf } from "./ansi-to-segments.js";
import { compareRegion, formatRegionResults, goldenRegionRows, locate, paintGoldenLines } from "./compare.js";
import { firstProblem, GoldenEvaluator, hasTruecolorSgr } from "./evaluate.js";
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

  it("a nested reset inside a chip keeps the chip; specific resets end only their attribute", () => {
    expect(tokenOf(applySgr(applySgr(RESET_STATE, "4;1;38;2;10;13;17;48;2;233;180;76"), "24"))).toBe("pk");
    expect(tokenOf(applySgr(applySgr(RESET_STATE, "4;38;2;86;200;232"), "24"))).toBe("cyan");
    expect(tokenOf(applySgr(applySgr(RESET_STATE, "1;38;2;233;180;76"), "22"))).toBe("amber");
  });

  it("a chip's foreground and weight are the palette's, or the diff names them", () => {
    // key and tag: #ffffff (tag bold); pk and inv: #0a0d11 bold. 256-tier equivalents count.
    expect(cells(`${ESC}[38;2;255;255;255;48;2;42;52;64mx`)[0]?.style).toBe("key");
    expect(cells(`${ESC}[38;5;231;48;5;237mx`)[0]?.style).toBe("key");
    expect(cells(`${ESC}[38;2;160;160;160;48;2;42;52;64mx`)[0]?.style).toBe("?chipfg#a0a0a0 key");
    expect(cells(`${ESC}[48;2;42;52;64mx`)[0]?.style).toBe("?chipfgdefault key");
    expect(cells(`${ESC}[1;38;2;255;255;255;48;2;86;200;232mx`)[0]?.style).toBe("?chipfg#ffffff inv");
    expect(cells(`${ESC}[38;2;10;13;17;48;2;233;180;76mx`)[0]?.style).toBe("?chipbold pk");
    expect(cells(`${ESC}[38;2;255;255;255;48;2;34;48;59mx`)[0]?.style).toBe("?chipbold tag");
    // A blank cell shows no foreground or weight: only its background counts.
    expect(cells(`${ESC}[48;2;42;52;64m ${ESC}[38;2;255;255;255mp${ESC}[39m `).map((cell) => cell.style)).toEqual(["key", "key", "key"]);
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
    // r4's two-pane form at 100 cols: the 69-wide card sits in the details pane, after the answer column and " │ ".
    const card = loadGolden("region-card-needs-ok").lines;
    const pane = (line: SegmentLine): SegmentLine => [{ text: " ".repeat(28), style: "" }, { text: " │ ", style: "line" }, ...line];
    const twoPane = ansiToSegmentLines(paintGoldenLines([...screen.slice(0, 5), ...card.map(pane)], sgr("truecolor")));
    expect(locate(twoPane, card)).toEqual({ row: 5, col: 31 });
    expect(compareRegion(twoPane, card, "card").verdict).toBe("MATCH");
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
  // The card regions are drawn at 69 cols (r4's details pane at 100): no eval frame holds a 69-wide card any more
  // (LAYOUT: --c100 is one column), so at 69 the renderer prints the card region itself.
  const CARD_AT_69: Readonly<Record<string, string>> = {
    "flow-pause-01-needs-your-ok": "region-card-needs-ok",
    "flow-pause-03-done": "region-card-done-green"
  };
  const painted = new GoldenEvaluator((fixture, cols) => {
    const golden = loadGolden(cols === 69 ? CARD_AT_69[fixture.screen]! : `${fixture.screen}--c${cols}`);
    return paintGoldenLines(golden.lines, sgr("truecolor")).join("\n");
  });
  const DECIDED = new Set([
    "flow-pause-02-working--c60", "flow-pause-02-working--c100", "flow-pause-02-working--c160",
    "flow-images-02-making-them--c60", "flow-images-02-making-them--c100", "flow-images-02-making-them--c160",
    "flow-images-06-with-your-codex--c60", "flow-images-06-with-your-codex--c100", "flow-images-06-with-your-codex--c160",
    "flow-images-07-cmd-l-only--c60", "flow-images-07-cmd-l-only--c100", "flow-images-07-cmd-l-only--c160", "region-keybar-busy",
    // T4: r4 draws `Sent to the app` under the dismissed card; the decision drops it.
    "flow-pause-09-dismissed--c60", "flow-pause-09-dismissed--c100", "flow-pause-09-dismissed--c160"
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

  // The frame must hold ONLY the r4 frame (D4: no wordmark or inventory at boot; D1: no top bar per turn; no
  // stray spinner rows). A painted golden with anything else on screen must FAIL.
  const paintedWith = (edit: (lines: string[]) => string[]) =>
    new GoldenEvaluator((fixture, cols) => edit(paintGoldenLines(loadGolden(`${fixture.screen}--c${cols}`).lines, sgr("truecolor"))).join("\n"));
  const plain = (text: string) => `${ESC}[0m${text}${ESC}[0m`;

  it("fails a boot screen that still prints the wordmark and the inventory above the frame (D4)", () => {
    const extra = paintedWith((lines) => [plain("INFINITE"), plain("Tools   connect · sync"), ...lines]);
    for (const id of ["boot--c100", "boot--c160", "boot--c60"]) {
      const result = extra.evaluate(loadGolden(id), id);
      expect(result.pass, id).toBe(false);
      // The two rows above the frame are extra (and, under TAB, so is r4's own boot bar, which this renderer prints as drawn).
      expect(result.regions.filter((region) => region.region === "extra").map((region) => region.diffs[0]?.actual).slice(0, 2)).toEqual(["INFINITE", "Tools   connect · sync"]);
    }
  });

  it("fails a frame that draws its top bar twice (D1: no top bar per turn)", () => {
    const twice = paintedWith((lines) => [...lines.slice(0, 2), ...lines]);
    for (const id of ["boot--c100", "view-06-change--c160", "view-06-change--c100"]) {
      const result = twice.evaluate(loadGolden(id), id);
      expect(result.pass, id).toBe(false);
      expect(result.regions.some((region) => /^D1: topbar drawn 2 times$/u.test(region.region)), id).toBe(true);
    }
  });

  it("fails a frame with a stray spinner row, at every width", () => {
    const junk = paintedWith((lines) => [...lines.slice(0, -2), plain("⠀ (｡•́︿•̀｡) running…"), ...lines.slice(-2)]);
    for (const id of ["boot--c100", "view-06-change--c160", "view-06-change--c100", "view-06-change--c60"]) {
      expect(junk.evaluate(loadGolden(id), id).pass, id).toBe(false);
    }
  });

  it("a full-width region is found at column 0 only: a longer key bar never matches as its tail (run-r2 MUST 2)", () => {
    // flow-numbers-02's bar is ` tab  switch side    /  commands`; ` j k  row    tab …` ends with it but is another bar.
    const golden = loadGolden("flow-numbers-02-not-measured--c100");
    const bar = golden.regions!.keybar![0];
    const chip = paintGoldenLines([[{ text: " j k ", style: "key" }, { text: " row    ", style: "" }]], sgr("truecolor"))[0]!;
    const result = paintedWith((lines) => lines.map((line, i) => (i === bar ? `${chip}${line}` : line))).evaluate(golden);
    expect(result.pass).toBe(false);
    expect(result.regions.find((region) => region.region === "keybar")?.verdict).not.toBe("MATCH");
    // The same holds for a key-bar region golden, found on the screen it is drawn on.
    const quiet = paintedWith((lines) => lines.map((line, i) => (i === lines.length - 1 ? `${plain("x  ")}${line}` : line)));
    expect(quiet.evaluate(loadGolden("region-keybar-quiet")).pass).toBe(false);
  });

  it("one rule row cannot stand for both rules: rule_bottom sits right above the composer", () => {
    const noBottomRule = paintedWith((lines) => lines.filter((_, i) => i !== lines.length - 3));
    const result = noBottomRule.evaluate(loadGolden("view-06-change--c160"));
    expect(result.pass).toBe(false);
    expect(result.regions.find((region) => region.region === "rule_bottom")?.verdict).toBe("DIFF");
    expect(result.regions.find((region) => region.region === "rule_top")?.verdict).toBe("MATCH");
  });

  it("at the 256 tier, a screen painted in 256 colours matches and one painted in truecolor fails", () => {
    const at = (tier: "truecolor" | "256") =>
      new GoldenEvaluator((fixture, cols) => paintGoldenLines(loadGolden(`${fixture.screen}--c${cols}`).lines, sgr(tier)).join("\n"), "256");
    expect(at("256").evaluate(loadGolden("view-06-change--c160")).pass).toBe(true);
    const truecolor = at("truecolor").evaluate(loadGolden("view-06-change--c160"));
    expect(truecolor.pass).toBe(false);
    expect(firstProblem(truecolor)).toMatch(/^256 tier: the CLI painted truecolor SGR/u);
    expect(hasTruecolorSgr(`${ESC}[1;38;5;232;48;5;179mx`)).toBe(false);
    expect(hasTruecolorSgr(`${ESC}[0;48;2;1;2;3mx`)).toBe(true);
    expect(hasTruecolorSgr(`${ESC}[38:2:1:2:3mx`)).toBe(true);
  });

  it("the 100-col body is compared: the --c100 goldens are r4 drawn side by side (r4 splits at 80)", () => {
    const golden = loadGolden("view-06-change--c100");
    expect(golden.layout).toMatchObject({ wide: true, answer_w: 28, details_w: 69 });
    expect(painted.evaluate(golden).regions.find((region) => region.region === "body")?.verdict).toBe("MATCH");
    const answerRow = golden.lines.findIndex((line) => textOf(line).startsWith("∞ Ready."));
    const edited = paintedWith((lines) => lines.map((line, i) => (i === answerRow ? plain("∞ Ready.") : line))).evaluate(golden);
    expect(edited.pass).toBe(false);
    expect(edited.regions.find((region) => region.region === "body")?.verdict).toBe("DIFF");
  });
});
