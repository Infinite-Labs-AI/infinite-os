// Evaluate one synthetic golden against the real session (tier 1, spec §11d).
//
//   frame goldens (views, flows, boot): render the screen's fixture at the
//     golden's cols, then compare every applicable region on its own; the
//     rules sit next to their chrome, the chrome is drawn once (D1) and the
//     screen holds nothing else (D4: an `extra` row is a DIFF), see
//     `compareFrame`.
//   line regions (top bar, rule, composer, key bars, steps, cards, table): the
//     golden's rows must appear, exactly, inside the screen the region is drawn
//     in (`REGION_SCREENS`), at any row and column.
//   data regions (`region-steps`, `-chips`, `-card-width-cap`,
//     `-table-numbers-hidden-60`, `-bar-eighths`): their own assertion on
//     `data`. A golden with no rows and no data assertion FAILS, never passes
//     vacuously.
import { compareRegion, FRAME_REGIONS, goldenRegionRows, isBlankPadRow, locate, maskText, type GoldenFile, type RegionName, type RegionResult } from "./compare.js";
import { applyDecisions } from "./decisions.js";
import { loadR4Fixture, type R4ScreenFixture, type R4Step } from "./fixtures.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { screenOf } from "./goldens.js";
import { cellsOf, textOf, type Cell, type SegmentLine } from "./normalize.js";

export interface Evaluation {
  id: string;
  pass: boolean;
  regions: RegionResult[];
  /** Decisions applied to the golden before comparing. */
  decisions: string[];
  /** Failures of a data assertion (data goldens only). */
  problems: string[];
}

/** Draws a fixture at a width and returns the ANSI the session prints. */
export type ScreenRenderer = (fixture: R4ScreenFixture, cols: number) => string;

/**
 * Where each line-region golden is drawn: a screen fixture at a width. The card
 * goldens are 69 wide (r4's details pane at 100 cols, as drawn). They are
 * drawn at 69 cols, where the one column is 69 wide, so a card r4 draws wider
 * than its pane (N2) is not cut by the 100-col frame.
 */
export const REGION_SCREENS: Readonly<Record<string, { screen: string; cols: number }>> = {
  "region-topbar-ok": { screen: "boot", cols: 100 },
  "region-topbar-narrow-60": { screen: "boot", cols: 60 },
  "region-topbar-not-connected": { screen: "flow-numbers-05-not-connected", cols: 100 },
  "region-rule": { screen: "boot", cols: 100 },
  "region-composer-idle": { screen: "boot", cols: 100 },
  "region-composer-busy": { screen: "flow-pause-02-working", cols: 100 },
  "region-keybar-numbers": { screen: "view-01-numbers", cols: 100 },
  "region-keybar-busy": { screen: "flow-pause-02-working", cols: 100 },
  "region-keybar-approval-pause": { screen: "flow-pause-01-needs-your-ok", cols: 100 },
  "region-keybar-approval-email": { screen: "flow-email-01-needs-your-ok", cols: 100 },
  "region-keybar-done-pause": { screen: "flow-pause-03-done", cols: 100 },
  "region-keybar-quiet": { screen: "view-12-quiet", cols: 100 },
  "region-steps-two": { screen: "view-06-change", cols: 100 },
  "region-card-needs-ok": { screen: "flow-pause-01-needs-your-ok", cols: 69 },
  "region-card-done-green": { screen: "flow-pause-03-done", cols: 69 },
  "region-table-numbers-100": { screen: "view-01-numbers", cols: 100 }
};

/** Line regions as wide as the window: found at column 0 only (a card or a table may sit inside a pane). */
const FULL_WIDTH_REGION = /^region-(topbar|rule|composer|keybar|steps)/u;

/** The colour tiers tier 1 renders at. At `256` the CLI must not print truecolor SGR (`38;2`/`48;2`). */
export type EvaluatorTier = "truecolor" | "256";

/** True when an ANSI string paints with a 24-bit colour anywhere (an SGR `38;2;…` or `48;2;…`). */
export function hasTruecolorSgr(ansi: string): boolean {
  for (const match of ansi.matchAll(/\u001b\[([\d;:]*)m/gu)) {
    const codes = match[1]!.split(/[;:]/u).map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      if (codes[i] !== 38 && codes[i] !== 48) continue;
      if (codes[i + 1] === 2) return true;
      i += codes[i + 1] === 5 ? 2 : 1;
    }
  }
  return false;
}

export class GoldenEvaluator {
  private readonly cache = new Map<string, { lines: SegmentLine[]; ansi: string }>();
  /** Screens drawn for the evaluation in progress (the tier check reads their ANSI). */
  private touched = new Set<string>();

  constructor(private readonly render: ScreenRenderer, readonly tier: EvaluatorTier = "truecolor") {}

  /** The screen as segment lines (cached per fixture and width). */
  screen(fixture: R4ScreenFixture, cols: number, key = `${fixture.screen}@${cols}`): SegmentLine[] {
    this.touched.add(key);
    const hit = this.cache.get(key);
    if (hit) return hit.lines;
    const ansi = this.render(fixture, cols);
    const lines = ansiToSegmentLines(ansi);
    this.cache.set(key, { lines, ansi });
    return lines;
  }

  evaluate(raw: GoldenFile, id = raw.id): Evaluation {
    this.touched = new Set();
    const out = this.evaluateCells(raw, id);
    if (this.tier === "256") {
      const truecolor = [...this.touched].filter((key) => hasTruecolorSgr(this.cache.get(key)?.ansi ?? ""));
      if (truecolor.length) {
        out.problems.unshift(`256 tier: the CLI painted truecolor SGR (38;2 / 48;2) on ${truecolor.join(", ")}`);
        out.pass = false;
      }
    }
    return out;
  }

  private evaluateCells(raw: GoldenFile, id: string): Evaluation {
    const { screen: screenId, cols } = screenOf(id, raw);
    const { golden, applied } = applyDecisions(raw, screenId);
    const out: Evaluation = { id, pass: false, regions: [], decisions: applied, problems: [] };

    if (golden.view_kind !== "region") {
      const screen = this.screen(loadR4Fixture(screenId), cols);
      out.regions = compareFrame(screen, golden, FRAME_REGIONS);
      out.pass = out.regions.length > 0 && out.regions.every((result) => result.verdict === "MATCH");
      return out;
    }

    const data = DATA_CHECKS[id];
    if (data) {
      out.problems = data(golden, this);
      out.pass = out.problems.length === 0;
      return out;
    }
    const where = REGION_SCREENS[id];
    if (!where || !golden.lines.length) {
      out.problems.push(where ? "golden has no rows and no data assertion" : `no screen is mapped for ${id} (REGION_SCREENS)`);
      return out;
    }
    const screen = this.screen(loadR4Fixture(where.screen), where.cols);
    out.regions.push(compareRegion(screen, golden.lines, id.replace(/^region-/u, ""), { anchored: FULL_WIDTH_REGION.test(id) }));
    out.pass = out.regions.every((result) => result.verdict === "MATCH");
    return out;
  }
}

// ── frame goldens ───────────────────────────────────────────────────────────────────────────────

/** Regions drawn once per screen: the chrome. A second copy is a D1 failure (no top bar, composer or key bar per turn). */
const ONCE: readonly RegionName[] = ["topbar", "composer", "keybar"];

/**
 * Compare a frame golden with a whole screen. Each region is located on its own
 * (T7, D1), the two rules are ANCHORED to their neighbours (rule_top right under
 * the top bar, rule_bottom right above the composer: one rule row cannot stand
 * for both), the chrome must appear exactly once (D1), and the screen must hold
 * nothing else: every non-blank row no region covers is an `extra` DIFF (D4: no
 * wordmark or inventory at boot; no stray spinner or per-turn rows). Blank pad
 * rows (`│` only) are T6's padding and never count as extra.
 */
export function compareFrame(screen: readonly SegmentLine[], golden: GoldenFile, regions: readonly RegionName[]): RegionResult[] {
  const byRegion = new Map<RegionName, RegionResult>();
  for (const region of regions) {
    if (region === "rule_top" || region === "rule_bottom") continue;
    const rows = goldenRegionRows(golden, region);
    // A frame is full width: every region starts at column 0 (never a row's tail).
    if (rows.length) byRegion.set(region, compareRegion(screen, rows, region, { anchored: true }));
  }
  const anchors: Record<"rule_top" | "rule_bottom", { from: RegionName; offset: number }> = {
    rule_top: { from: "topbar", offset: 1 },
    rule_bottom: { from: "composer", offset: -1 }
  };
  for (const rule of ["rule_top", "rule_bottom"] as const) {
    const rows = regions.includes(rule) ? goldenRegionRows(golden, rule) : [];
    if (!rows.length) continue;
    const neighbour = byRegion.get(anchors[rule].from)?.locatedAt;
    const at = neighbour && neighbour.row + anchors[rule].offset >= 0 ? { row: neighbour.row + anchors[rule].offset, col: 0 } : null;
    byRegion.set(rule, compareRegion(screen, rows, rule, { at }));
  }
  const results = regions.flatMap((region) => byRegion.get(region) ?? []);

  // D1: the chrome is drawn once.
  for (const region of ONCE) {
    const first = goldenRegionRows(golden, region)[0];
    if (!first || !byRegion.has(region)) continue;
    const want = maskText(textOf(first));
    const rows = screen.flatMap((line, row) => (maskText(textOf(line)) === want ? [row] : []));
    if (rows.length > 1) {
      results.push({
        region: `D1: ${region} drawn ${rows.length} times`, verdict: "DIFF", goldenRows: 1, locatedAt: { row: rows[1]!, col: 0 },
        diffs: [{ row: rows[1]!, golden: "", actual: textOf(screen[rows[1]!]!), textEqual: false, column: 0 }]
      });
    }
  }

  // Coverage: nothing on screen but the frame.
  const covered = new Set<number>();
  for (const result of byRegion.values()) {
    if (!result.locatedAt) continue;
    for (let row = result.locatedAt.row; row < result.locatedAt.row + result.goldenRows; row += 1) covered.add(row);
  }
  screen.forEach((line, row) => {
    const text = textOf(line);
    if (covered.has(row) || !text.trim() || isBlankPadRow(line)) return;
    results.push({
      region: "extra", verdict: "DIFF", goldenRows: 0, locatedAt: { row, col: 0 },
      diffs: [{ row, golden: "", actual: text, textEqual: false, column: 0 }]
    });
  });
  return results;
}

// ── data goldens ────────────────────────────────────────────────────────────────────────────────

type DataCheck = (golden: GoldenFile, evaluator: GoldenEvaluator) => string[];

const SESSION_ONLY = (screen: string): R4ScreenFixture => ({ ...loadR4Fixture("boot"), screen });

function sameCells(a: readonly Cell[], b: readonly Cell[]): boolean {
  return a.length === b.length && a.every((cell, i) => cell.ch === b[i]!.ch && cell.style === b[i]!.style);
}

/** True when `needle` (cells) appears contiguously in some row of `screen`. */
function containsCells(screen: readonly SegmentLine[], needle: SegmentLine): boolean {
  const want = cellsOf(needle);
  return screen.some((line) => {
    const cells = cellsOf(line);
    for (let i = 0; i + want.length <= cells.length; i += 1) {
      if (sameCells(cells.slice(i, i + want.length), want)) return true;
    }
    return false;
  });
}

const show = (line: SegmentLine | undefined) => JSON.stringify(line ?? []);

const DATA_CHECKS: Readonly<Record<string, DataCheck>> = {
  /** One Steps row per status, at 100 cols: the header and the row, exactly. */
  "region-steps": (golden, evaluator) => {
    const cases = golden.data as { status: R4Step["status"]; header: SegmentLine; line: SegmentLine }[];
    const problems: string[] = [];
    for (const item of cases) {
      const fixture: R4ScreenFixture = {
        ...SESSION_ONLY(`region-steps-${item.status}`),
        turn: {
          question: "q", answer: "a", views: [],
          steps: [{ label: "checking your campaigns", start: 0, end: 1, result: "result", status: item.status }]
        }
      };
      const screen = evaluator.screen(fixture, golden.cols);
      const at = screen.findIndex((line) => textOf(line) === textOf(item.header));
      if (at < 0) {
        problems.push(`${item.status}: no Steps header ${show(item.header)}`);
        continue;
      }
      const header = compareRegion(screen, [item.header], "steps_header", { at: { row: at, col: 0 } });
      const row = compareRegion(screen, [item.line], "steps", { at: { row: at + 1, col: 0 } });
      for (const result of [header, row]) {
        if (result.verdict !== "MATCH") problems.push(`${item.status} ${result.region}: want ${JSON.stringify(result.diffs[0]?.golden)} got ${JSON.stringify(result.diffs[0]?.actual)}${result.diffs[0]?.textEqual ? ` (token ${result.diffs[0].goldenStyle} vs ${result.diffs[0].actualStyle})` : ""}`);
      }
    }
    return problems;
  },

  /** Each chip, as its exact cells, somewhere on the screen that draws it. */
  "region-chips": (golden, evaluator) => {
    const chips = golden.data as Record<"K" | "PK" | "inv" | "tag", SegmentLine>;
    const where: Record<keyof typeof chips, { screen: string; cols: number }> = {
      K: { screen: "flow-pause-01-needs-your-ok", cols: 100 },
      PK: { screen: "flow-pause-01-needs-your-ok", cols: 100 },
      inv: { screen: "boot", cols: 100 },
      tag: { screen: "view-06-change", cols: 160 }
    };
    return (Object.keys(where) as (keyof typeof chips)[]).flatMap((name) => {
      const screen = evaluator.screen(loadR4Fixture(where[name].screen), where[name].cols);
      return containsCells(screen, chips[name]) ? [] : [`${name}: ${show(chips[name])} is not on ${where[name].screen}@${where[name].cols}`];
    });
  },

  /** A card is at most 74 cols wide, even when the details pane is 133 wide (176 cols). */
  "region-card-width-cap": (golden, evaluator) => {
    const cap = (golden.data as { at_details_w_133: number }).at_details_w_133;
    const screen = evaluator.screen(loadR4Fixture("flow-pause-01-needs-your-ok"), 176);
    const top = screen.map(textOf).find((text) => /┌─ Pause ad/u.test(text));
    if (!top) return ["no card top border (┌─ Pause ad …) at 176 cols"];
    const from = top.indexOf("┌");
    const to = top.indexOf("┐", from);
    const width = to < 0 ? -1 : [...top.slice(from, to + 1)].length;
    return width === cap ? [] : [`card is ${width} cols wide at 176 cols; want ${cap}`];
  },

  /** At 60 cols the ads table drops Impressions and says so: `+ Impressions · → to see`. */
  "region-table-numbers-hidden-60": (golden, evaluator) => {
    const data = golden.data as { lines: SegmentLine[]; hidden: string[] };
    const screen = evaluator.screen(loadR4Fixture("view-01-numbers"), golden.cols);
    const table = compareRegion(screen, data.lines, "table");
    const problems = table.verdict === "MATCH" ? [] : [`table: ${table.verdict} at row ${table.diffs[0]?.row}: want ${JSON.stringify(table.diffs[0]?.golden)} got ${JSON.stringify(table.diffs[0]?.actual)}`];
    const hint: SegmentLine = [{ text: `+ ${data.hidden.join(", ")} · → to see`, style: "dim" }];
    const at = table.locatedAt ?? locate(screen, data.lines);
    const below = at ? compareRegion(screen, [hint], "hidden hint", { at: { row: at.row + data.lines.length, col: at.col } }) : null;
    if (!below || below.verdict !== "MATCH") problems.push(`hint: want ${show(hint)} right under the table`);
    return problems;
  },

  /** The job's progress bar in eighths: `█…▍` in cyan, then `░` in line, 20 cols in all (details pane 60). */
  "region-bar-eighths": (_golden, evaluator) => {
    const cases = _golden.data as { frac: number; w: number; text: string }[];
    const ratio: Record<string, [number, number]> = { "0": [0, 1], "0.1": [1, 10], "0.25": [1, 4], "0.5": [1, 2], "0.99": [99, 100], "1": [1, 1] };
    const problems: string[] = [];
    for (const item of cases) {
      const [finished, of] = Math.abs(item.frac - 4 / 7) < 1e-9 ? [4, 7] : ratio[String(item.frac)] ?? [Math.round(item.frac * 1000), 1000];
      const base = loadR4Fixture("view-08-job");
      const view = structuredClone(base.turn!.views[0]!);
      if (view.kind === "job") view.body.progress = { finished, of };
      const fixture: R4ScreenFixture = { ...base, screen: `region-bar-${item.frac}`, turn: { ...base.turn!, views: [view] } };
      const screen = evaluator.screen(fixture, 60);
      const row = screen.find((line) => /Draft/u.test(textOf(line)));
      const cells = row ? cellsOf(row) : [];
      const bar = cells.filter((cell) => /[█▏▎▍▌▋▊▉]/u.test(cell.ch));
      const rest = cells.filter((cell) => cell.ch === "░");
      const text = bar.map((cell) => cell.ch).join("");
      if (text !== item.text) problems.push(`${item.frac}: bar ${JSON.stringify(text)}; want ${JSON.stringify(item.text)}`);
      else if (bar.some((cell) => cell.style !== "cyan") || rest.some((cell) => cell.style !== "line")) problems.push(`${item.frac}: bar not cyan + line`);
      else if (bar.length + rest.length !== item.w) problems.push(`${item.frac}: bar + remainder is ${bar.length + rest.length} cols; want ${item.w}`);
    }
    return problems;
  }
};

/** One line for a failing golden: its first region diff or data problem. */
export function firstProblem(evaluation: Evaluation): string {
  if (evaluation.problems.length) return evaluation.problems[0]!;
  const bad = evaluation.regions.find((result) => result.verdict !== "MATCH");
  if (!bad) return "no region compared";
  const diff = bad.diffs[0];
  if (!diff) return `${bad.region}: ${bad.verdict}`;
  if (bad.region === "extra" || bad.region.startsWith("D1:")) return `${bad.region === "extra" ? "extra row" : bad.region} at screen row ${diff.row}: ${JSON.stringify(diff.actual)}`;
  return bad.verdict === "NOT_FOUND"
    ? `${bad.region}: not found: ${JSON.stringify(diff.golden)}${diff.actual ? ` (closest ${JSON.stringify(diff.actual)})` : ""}`
    : `${bad.region} row ${diff.row} col ${diff.column}: ${diff.textEqual ? `token ${diff.goldenStyle} vs ${diff.actualStyle}` : `${JSON.stringify(diff.golden)} vs ${JSON.stringify(diff.actual)}`}`;
}
