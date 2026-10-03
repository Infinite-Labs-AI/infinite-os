// Live run 4, N12: a finished numbers turn too tall for the window went whole
// into scrollback and took its Steps strip with it, so the frame under it was
// the top bar and the composer alone. r4 keeps the strip under the turn on
// screen (flow-numbers-01: `checking Google Ads ━ ✓ 3 campaigns` over the
// composer). Here r4's own flow-numbers-01 turn is drawn in a window too short
// for it: the frame's top bar, Steps header, Steps row, bottom rule and
// composer must still BE r4's (the key bar is the composer's: the view and its
// keys went up with the turn).
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
import { chromeProps, ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import { feedSteps, turnMessages } from "./feed-steps.js";
import { loadR4Fixture } from "./fixtures.js";
import { loadGolden } from "./goldens.js";
import { textOf } from "./normalize.js";

const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const SCREEN = "flow-numbers-01-ready";
/** A window the turn does not fit, at every width tested. */
const ROWS = 16;
const KEPT: readonly RegionName[] = ["topbar", "steps_header", "steps", "rule_bottom", "composer"];

function drawShort(cols: number): string {
  const fixture = loadR4Fixture(SCREEN);
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

describe("a finished turn that went up whole keeps r4's Steps strip in the frame (live run-4 N12)", () => {
  for (const cols of [60, 100, 160]) {
    it(`flow-numbers-01 at ${cols} columns in a ${ROWS}-row window`, () => {
      const lines = ansiToSegmentLines(drawShort(cols));
      const text = lines.map((line) => textOf(line).trimEnd());
      // The turn did go up: the frame starts under the turn, and nothing is paged.
      expect(text.some((line) => /more lines|lines above/u.test(line))).toBe(false);
      const golden = loadGolden(`${SCREEN}--c${cols}`);
      const frame = lines.slice(text.lastIndexOf(text.find((line) => line.startsWith(" ∞ Infinite"))!));
      for (const region of KEPT) {
        const result = compareRegion(frame, goldenRegionRows(golden, region), region, { anchored: true });
        expect(result.verdict, `${region}: ${JSON.stringify(result.diffs[0] ?? null)}`).toBe("MATCH");
      }
      // Top bar, rule, Steps, rule, composer, key bar: the frame and nothing else.
      expect(frame.map((line) => textOf(line).trimEnd()).filter(Boolean)).toHaveLength(7);
    });
  }
});

// Lane review MUST: a kept strip taller than the resting frame would page
// under a finished turn (`▲ 13 lines above · PgUp`) and lose its `─ Steps`
// header, though a finished turn never pages. Such a strip goes up with the
// turn, as before: only its calls that did not end clean print, under the
// answer, once.
describe("a Steps strip too tall for the resting frame goes up with the turn, never paged", () => {
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

  it("20 calls, one failed, in a 16-row window: no pager, and the failed row once, under the answer", () => {
    const text = drawSteps(20, 7);
    expect(text.some((line) => /lines above|PgUp|more lines/u.test(line))).toBe(false);
    const failed = text.filter((line) => line.includes("checking source 7 "));
    expect(failed).toHaveLength(1);
    expect(text.indexOf(failed[0]!)).toBeGreaterThan(text.findIndex((line) => line.includes("answer line 59")));
    // A clean call of a strip that went up is not printed.
    expect(text.some((line) => line.includes("checking source 3 "))).toBe(false);
  });

  it("4 clean calls still keep their strip in the frame, under its header", () => {
    const text = drawSteps(4, null);
    expect(text.some((line) => /lines above|PgUp|more lines/u.test(line))).toBe(false);
    const frame = text.slice(text.map((line) => line.startsWith(" ∞ Infinite")).lastIndexOf(true));
    expect(frame.some((line) => line.startsWith("─ Steps"))).toBe(true);
    expect(frame.filter((line) => line.includes("checking source "))).toHaveLength(4);
  });
});
