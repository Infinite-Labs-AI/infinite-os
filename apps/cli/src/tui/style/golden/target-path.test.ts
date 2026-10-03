// Answer view contract revision 3: a change target may carry its parents
// (`target.path`, outermost first) and its picture by archive reference
// (`target.creativeRef`). Cmd+L draws the picture and the path in every pause
// state (cmdl-r2 `pauseObj`); the terminal draws no picture, ever, and prints
// the path as ONE dim line under the target, in every state.
//
// Each r4 pause screen (`flow-pause-01…09`) is drawn through the REAL session
// twice, at 60, 100 and 140 columns: as r4's fixture has it (no path: a
// revision 2 view, which must still draw exactly its golden), and with a path
// and a picture added to its change views. The second screen must be the
// first plus exactly one row: the path, dim. Synthetic names only.
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

import type { AnswerViewV1 } from "@infinite-os/types";

import { decodeAnswerView } from "../../../desktop/answer-view-decode.js";
import { homeInventoryData } from "../../../index.js";
import { displayWidth } from "../../lib/display-width.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import { loadR4Fixture, r4FixtureIds, type R4ScreenFixture } from "./fixtures.js";
import { textOf, type SegmentLine } from "./normalize.js";
import { renderR4Screen } from "./screen.js";

const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const PATH = ["Spring trials", "Broad · US · 25-54"];
const PATH_WORDS = "Spring trials › Broad · US · 25-54";
const PICTURE = { archiveAssetId: "asset_synthetic_0042" };
const PAUSE_SCREENS = r4FixtureIds().filter((screen) => screen.startsWith("flow-pause-"));

/** The fixture with every change view's target given `extra`, decoded the way the bridge decodes it. */
function withTarget(fixture: R4ScreenFixture, extra: Record<string, unknown>): R4ScreenFixture {
  const turn = fixture.turn!;
  const views = turn.views.map((view) => {
    if (view.kind !== "change") return view;
    const raw = { ...view, body: { ...view.body, target: { ...view.body.target, ...extra } } };
    const decoded = decodeAnswerView(raw);
    if (!decoded) throw new Error(`${fixture.screen}: the revision 3 view does not decode`);
    return decoded;
  });
  return { ...fixture, turn: { ...turn, views: views as AnswerViewV1[] } };
}

function screen(fixture: R4ScreenFixture, cols: number): SegmentLine[] {
  return ansiToSegmentLines(renderR4Screen(fixture, { cols, now: FIXED_CLOCK, homeInventory: homeInventoryData, sessionProps: ENTRY_SESSION_PROPS }));
}

const rows = (lines: readonly SegmentLine[]) => lines.map((line) => textOf(line).trimEnd());

/**
 * A screen's rows as its panes. From 120 columns the answer sits left of the
 * details (`│`), on the same rows, so a row added to the details also moves
 * the answer's rows: there the details pane (right of `│`, its trailing blank
 * rows dropped) and the answer pane (its words only) are compared apart. In
 * one column, every row is the details pane.
 */
function panes(lines: readonly SegmentLine[]): { outer: string[]; answer: string[]; details: string[] } {
  const all = rows(lines);
  const first = all.findIndex((row) => row.startsWith("❯ ") && row.includes("│"));
  if (first < 0) return { outer: [], answer: [], details: all };
  const sep = Array.from(all[first]!).indexOf("│");
  const end = all.findIndex((row, index) => index > first && row.startsWith("─ Steps"));
  const region = all.slice(first, end).map((row) => Array.from(row));
  const details = region.map((row) => row.slice(sep + 1).join("").trimEnd());
  while (details.length && !details[details.length - 1]) details.pop();
  return {
    outer: [...all.slice(0, first), ...all.slice(end)],
    answer: region.map((row) => row.slice(0, sep).join("").trim()).filter(Boolean),
    details
  };
}

/** The one row `after` adds to `before`'s details pane (every other row unchanged), or a failure. */
function addedRow(before: readonly SegmentLine[], after: readonly SegmentLine[]): string {
  const was = panes(before);
  const now = panes(after);
  const shown = now.details.join("\n");
  expect(now.outer, shown).toEqual(was.outer);
  expect(now.answer, shown).toEqual(was.answer);
  const index = now.details.findIndex((row, at) => row !== was.details[at]);
  expect(index, shown).toBeGreaterThan(-1);
  expect([...now.details.slice(0, index), ...now.details.slice(index + 1)], shown).toEqual(was.details);
  return now.details[index]!;
}

/** The style of the screen's run that carries `words`. */
function styleOf(lines: readonly SegmentLine[], words: string): string[] {
  return lines.flatMap((line) => line.filter((segment) => segment.text.includes(words)).map((segment) => segment.style));
}

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(pinnedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a change target's path: one dim line under the target, in every pause state (contract revision 3)", () => {
  it("covers all nine r4 pause screens", () => {
    expect(PAUSE_SCREENS).toHaveLength(9);
  });

  for (const id of PAUSE_SCREENS) {
    for (const cols of [60, 100, 140]) {
      it(`${id} at ${cols} columns: the screen plus one dim path row, and no picture`, () => {
        const fixture = loadR4Fixture(id);
        const after = screen(withTarget(fixture, { path: PATH, creativeRef: PICTURE }), cols);
        // Exactly one row more in the details, every other row unchanged, and it is the path.
        const row = addedRow(screen(fixture, cols), after);
        expect(row.replace(/[│┊]/gu, "").trim()).toBe(PATH_WORDS);
        // In r4's dim, as one run.
        expect(styleOf(after, PATH_WORDS)).toEqual(["dim"]);
        // The picture is Cmd+L's: its reference never reaches the terminal.
        expect(rows(after).join("\n")).not.toContain(PICTURE.archiveAssetId);
      });
    }
  }

  for (const id of PAUSE_SCREENS) {
    it(`${id}: a picture without a path draws exactly the revision 2 screen`, () => {
      const fixture = loadR4Fixture(id);
      expect(rows(screen(withTarget(fixture, { creativeRef: PICTURE }), 100))).toEqual(rows(screen(fixture, 100)));
    });
  }

  for (const cols of [60, 100, 140]) {
    it(`a long path stays one line at ${cols} columns, cut with …`, () => {
      const long = ["A campaign whose name runs on and on past any card", "An ad set named for every audience it reaches at once", "Hook B"];
      const fixture = loadR4Fixture("flow-pause-01-needs-your-ok");
      const after = screen(withTarget(fixture, { path: long }), cols);
      const row = addedRow(screen(fixture, cols), after);
      expect(row.replace(/[│┊]/gu, "").trim()).toMatch(/^A campaign whose name .*…$/u);
      expect(rows(after).every((line) => displayWidth(line) <= cols)).toBe(true);
    });
  }
});
