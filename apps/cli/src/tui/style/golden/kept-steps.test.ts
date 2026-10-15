// Live run 4, N12: a finished numbers turn too tall for the window went whole
// into scrollback and took its Steps strip with it. Since the one-column
// default (River, 2026-10-15, V1) a turn's calls are lines of the turn itself:
// a turn that goes up takes every call line with it, in place, and the frame
// under it is the chrome alone. r4's two-column turn, asked for, keeps its
// split and its Steps strip in a window too short for it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pinnedEnv = vi.hoisted(() => {
  // The same pins as golden.test.ts: truecolor through Ink, UTC times, no NO_COLOR.
  const pins: Record<string, string | undefined> = {
    FORCE_COLOR: "3", COLORTERM: "truecolor", TERM: "xterm-256color", TZ: "UTC", INFINITE_COLOR: "truecolor",
    NO_COLOR: undefined, INFINITE_THEME: undefined, INFINITE_PLAIN_OUTPUT: undefined
  };
  const saved = Object.fromEntries(Object.keys(pins).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(pins)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return saved;
});

import type { ToolViewFrameV1 } from "@infinite-os/types";

import { patchTurnState, recordTurnView, resetTurnState } from "../../app/turn-store.js";
import { renderInkInteractiveSessionToString } from "../../ink/interactive-session.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { compareRegion, goldenRegionRows, type RegionName } from "./compare.js";
import { askingSideBySide } from "./evaluate.js";
import { chromeProps, ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import { feedSteps, turnMessages } from "./feed-steps.js";
import { loadR4Fixture } from "./fixtures.js";
import { loadGolden } from "./goldens.js";
import { textOf } from "./normalize.js";

const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const SCREEN = "flow-numbers-01-ready";
/** A window the turn does not fit, at every width tested. */
const ROWS = 16;
/** The chrome every frame keeps, as its golden draws it. */
const CHROME: readonly RegionName[] = ["topbar", "rule_bottom", "composer"];

function drawShort(cols: number, sideBySide = false): string {
  const fixture = sideBySide ? askingSideBySide(loadR4Fixture(SCREEN)) : loadR4Fixture(SCREEN);
  const turn = fixture.turn!;
  resetTurnState();
  turn.views.forEach((view, index) => {
    recordTurnView({ type: "tool.view", stage: "tool", message: view.title, viewId: `r4_${index}`, name: view.tool, view } as ToolViewFrameV1);
  });
  feedSteps(turn, FIXED_CLOCK);
  return renderInkInteractiveSessionToString({
    columns: cols,
    rows: ROWS,
    onSubmitLine: async () => ({ messages: [] }),
    ...chromeProps(fixture, ENTRY_SESSION_PROPS, () => { throw new Error("no inventory on a returning user's screen"); }),
    initialMessages: turnMessages(turn)
  });
}

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  resetTurnState();
  for (const [key, value] of Object.entries(pinnedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a finished turn that went up whole takes its call lines with it (live run-4 N12, one column)", () => {
  for (const cols of [60, 100, 160]) {
    it(`flow-numbers-01 at ${cols} columns in a ${ROWS}-row window`, () => {
      const lines = ansiToSegmentLines(drawShort(cols));
      const text = lines.map((line) => textOf(line).trimEnd());
      // The turn did go up: nothing is paged, and its call is in scrollback once, above its answer.
      expect(text.some((line) => /more lines|lines above/u.test(line))).toBe(false);
      const call = text.filter((line) => line === "  ✓ checking Google Ads · 3 campaigns");
      expect(call).toHaveLength(1);
      expect(text.indexOf(call[0]!)).toBeLessThan(text.findIndex((line) => line.startsWith("∞ ")));
      const golden = loadGolden(`${SCREEN}--c${cols}`);
      const top = text.lastIndexOf(text.find((line) => line.startsWith(" ∞ Infinite"))!);
      const frame = lines.slice(top);
      for (const region of CHROME) {
        const result = compareRegion(frame, goldenRegionRows(golden, region), region, { anchored: true });
        expect(result.verdict, `${region}: ${JSON.stringify(result.diffs[0] ?? null)}`).toBe("MATCH");
      }
      // Top bar, its rule (the rule over the composer too), composer, key bar: the frame and nothing else (no Steps strip).
      expect(frame.map((line) => textOf(line).trimEnd()).filter(Boolean)).toHaveLength(4);
    });
  }
});

describe("every call goes up with its turn, in place, never paged", () => {
  const answer = Array.from({ length: 60 }, (_, index) => `answer line ${index}`).join("\n");
  const drawSteps = (count: number, failAt: number | null) => {
    resetTurnState();
    patchTurnState((state) => ({
      ...state,
      steps: Array.from({ length: count }, (_, index) => ({
        id: `c${index}`,
        name: `tool_${index}`,
        label: `checking source ${index}`,
        status: index === failAt ? "fail" as const : "ok" as const,
        startedAt: FIXED_CLOCK - 20_000 + index * 500,
        endedAt: FIXED_CLOCK - 19_000 + index * 500,
        result: index === failAt ? "could not reach it" : `${index} rows`
      }))
    }));
    return ansiToSegmentLines(renderInkInteractiveSessionToString({
      columns: 80,
      rows: ROWS,
      onSubmitLine: async () => ({ messages: [] }),
      initialMessages: [{ role: "user", text: "check every source" }, { role: "assistant", text: answer }]
    })).map((line) => textOf(line).trimEnd());
  };

  it.each([[20, 7], [4, null]] as const)("%i calls (failed: %s) in a 16-row window: no pager, each call once, above the answer; no strip in the frame", (count, failAt) => {
    const text = drawSteps(count, failAt);
    expect(text.some((line) => /lines above|PgUp|more lines/u.test(line))).toBe(false);
    const answerAt = text.findIndex((line) => line.includes("answer line 0"));
    for (let index = 0; index < count; index += 1) {
      const rows = text.filter((line) => line.includes(`checking source ${index} `));
      expect(rows, String(index)).toHaveLength(1);
      expect(text.indexOf(rows[0]!)).toBeLessThan(answerAt);
    }
    if (failAt !== null) expect(text).toContain(`  ✗ checking source ${failAt} · could not reach it`);
    const frame = text.slice(text.map((line) => line.startsWith(" ∞ Infinite")).lastIndexOf(true));
    expect(frame.some((line) => line.startsWith("─ Steps") || line.includes("checking source "))).toBe(false);
  });
});

// A turn that asks for two columns, taller than the window, stays live in its
// two panes (layout decision, 2026-10-03), held to the window, its details pane
// cut with `↓ N more`, and r4's frame (top bar, Steps, rule, composer) is whole
// around it.
describe("asked side by side, from 80 columns a turn too tall for the window stays split, the frame whole around it", () => {
  for (const cols of [100, 160]) {
    it(`flow-numbers-01 at ${cols} columns in a ${ROWS}-row window`, () => {
      const lines = ansiToSegmentLines(drawShort(cols, true));
      const text = lines.map((line) => textOf(line).trimEnd());
      expect(text.some((line) => /more lines|lines above/u.test(line))).toBe(false);
      const top = text.findIndex((line) => line.startsWith(" ∞ Infinite"));
      const frame = lines.slice(top);
      expect(text.length - top).toBeLessThanOrEqual(ROWS);
      expect(text[top + 2]).toMatch(/^❯ google ads since launch\?,[a-z ]* +│ /u);
      expect(text.some((line) => /│ ↓ \d+ more · tab, then ↓$/u.test(line))).toBe(true);
      expect(text.filter((line) => line.startsWith("─ Steps"))).toHaveLength(1);
      expect(text.some((line) => /^ {2}checking Google Ads +━+ ✓ 3 campaigns$/u.test(line))).toBe(true);
      const golden = loadGolden(`${SCREEN}--c${cols}`);
      for (const region of CHROME) {
        const result = compareRegion(frame, goldenRegionRows(golden, region), region, { anchored: true });
        expect(result.verdict, `${region}: ${JSON.stringify(result.diffs[0] ?? null)}`).toBe("MATCH");
      }
    });
  }
});
