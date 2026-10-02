// Evaluate one synthetic golden against the real session (tier 1, spec §11d).
//
//   frame goldens (views, flows, boot): render the screen's fixture at the
//     golden's cols, then compare every applicable region on its own.
//   line regions (top bar, rule, composer, key bars, steps, cards, table): the
//     golden's rows must appear, exactly, inside the screen the region is drawn
//     in (`REGION_SCREENS`), at any row and column.
//   data regions (`region-steps`, `-chips`, `-card-width-cap`,
//     `-table-numbers-hidden-60`, `-bar-eighths`): their own assertion on
//     `data`. A golden with no rows and no data assertion FAILS, never passes
//     vacuously.
import { compareRegion, FRAME_REGIONS, goldenRegionRows, locate, type GoldenFile, type RegionResult } from "./compare.js";
import { applicableRegions, applyDecisions } from "./decisions.js";
import { loadR4Fixture, type R4ScreenFixture, type R4Step } from "./fixtures.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { screenOf } from "./goldens.js";
import { cellsOf, textOf, type Cell, type SegmentLine } from "./normalize.js";

export interface Evaluation {
  id: string;
  pass: boolean;
  regions: RegionResult[];
  /** Regions not compared, with the decision that rules them out. */
  skipped: string[];
  /** Decisions applied to the golden before comparing. */
  decisions: string[];
  /** Failures of a data assertion (data goldens only). */
  problems: string[];
}

/** Draws a fixture at a width and returns the ANSI the session prints. */
export type ScreenRenderer = (fixture: R4ScreenFixture, cols: number) => string;

/**
 * Where each line-region golden is drawn: a screen fixture at a width. The card
 * goldens are 69 wide (r4's details pane at 100 cols). Under the LAYOUT
 * decision a 100-col turn is one column (its card would be 74 wide), so a
 * 69-wide card is drawn at 69 cols, where the one column is 69 wide.
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

export class GoldenEvaluator {
  private readonly cache = new Map<string, SegmentLine[]>();

  constructor(private readonly render: ScreenRenderer) {}

  /** The screen as segment lines (cached per fixture and width). */
  screen(fixture: R4ScreenFixture, cols: number, key = `${fixture.screen}@${cols}`): SegmentLine[] {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const lines = ansiToSegmentLines(this.render(fixture, cols));
    this.cache.set(key, lines);
    return lines;
  }

  evaluate(raw: GoldenFile, id = raw.id): Evaluation {
    const { screen: screenId, cols } = screenOf(id, raw);
    const { golden, applied } = applyDecisions(raw, screenId);
    const out: Evaluation = { id, pass: false, regions: [], skipped: [], decisions: applied, problems: [] };

    if (golden.view_kind !== "region") {
      const screen = this.screen(loadR4Fixture(screenId), cols);
      const { compare, skipped } = applicableRegions(golden, FRAME_REGIONS);
      out.skipped = skipped;
      for (const region of compare) {
        const rows = goldenRegionRows(golden, region);
        if (rows.length) out.regions.push(compareRegion(screen, rows, region));
      }
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
    out.regions.push(compareRegion(screen, golden.lines, id.replace(/^region-/u, "")));
    out.pass = out.regions.every((result) => result.verdict === "MATCH");
    return out;
  }
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
  return bad.verdict === "NOT_FOUND"
    ? `${bad.region}: not found: ${JSON.stringify(diff.golden)}${diff.actual ? ` (closest ${JSON.stringify(diff.actual)})` : ""}`
    : `${bad.region} row ${diff.row} col ${diff.column}: ${diff.textEqual ? `token ${diff.goldenStyle} vs ${diff.actualStyle}` : `${JSON.stringify(diff.golden)} vs ${JSON.stringify(diff.actual)}`}`;
}
