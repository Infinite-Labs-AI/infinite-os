// Live run 4, N11: before the pause card the turn looked the ad up, and that
// lookup (a list whose one row IS the card's ad) printed above the card as its
// own view, where r4 draws the card alone and the lookup as its Steps row
// (`checking your campaigns ✓ 1 ad`). Here r4's own pause screens are drawn
// with such a lookup recorded on the turn before the card (synthetic: the list
// names only the fixture's own ad), and each must still BE its r4 golden.
// A lookup that lists more than the card's ad stays a view (the frame differs).
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

import { homeInventoryData } from "../../../index.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { firstProblem, GoldenEvaluator } from "./evaluate.js";
import { ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import type { R4ScreenFixture } from "./fixtures.js";
import { loadR4Fixture } from "./fixtures.js";
import { loadGolden } from "./goldens.js";
import { textOf } from "./normalize.js";
import { renderR4Screen } from "./screen.js";

const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const LOOKUP_TITLE = "Sample ads";

/** The lookup the turn made before its card: a list of `rows` (the card's own ad, unless more are named). */
function lookup(target: { id: string; label: string }, extra: readonly string[] = []): AnswerViewV1 {
  const row = (id: string, title: string) => ({ id, title, status: { word: "On", tone: "ok" as const }, cells: { delivery: { text: "On" } } });
  const rows = [row(target.id, target.label), ...extra.map((title, index) => row(`ad_other_${index}`, title))];
  return {
    v: 1, kind: "list", tool: "list_sample_entities", title: LOOKUP_TITLE, state: "ready", asOf: null,
    provenance: { source: "Sample · stored copy", via: "our_db" },
    scope: { workspaceName: "Demo workspace", crossWorkspace: false }, caveats: [],
    body: { layout: "rows", columns: [{ key: "delivery", label: "Delivery", unit: "text" }], rows, total: rows.length, shown: rows.length }
  };
}

/** The r4 screen with the lookup recorded first: its card (waiting or answered) follows it. */
function withLookup(screen: R4ScreenFixture, extra: readonly string[] = []): R4ScreenFixture {
  const turn = screen.turn!;
  const card = turn.views.find((view) => view.kind === "change")!;
  if (card.kind !== "change" || !card.body.target.id) throw new Error(`${screen.screen} has no change card with a target id`);
  const target = { id: card.body.target.id, label: card.body.target.label };
  return {
    ...screen,
    turn: { ...turn, views: [lookup(target, extra), ...turn.views], ...(turn.pending !== undefined ? { pending: turn.pending + 1 } : {}) }
  };
}

const draw = (extra: readonly string[]) => (fixture: R4ScreenFixture, cols: number) => renderR4Screen(withLookup(fixture, extra), {
  cols, now: FIXED_CLOCK, homeInventory: homeInventoryData, sessionProps: ENTRY_SESSION_PROPS
});
const folded = new GoldenEvaluator(draw([]));

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

describe("a lookup of the card's own ad is its Steps row, never a view above the card (live run-4 N11)", () => {
  // The frames that match r4 on their own (flow-pause-01 at 60 waits on an r4 key-bar artifact).
  for (const id of ["flow-pause-01-needs-your-ok--c100", "flow-pause-01-needs-your-ok--c160",
    "flow-pause-09-dismissed--c60", "flow-pause-09-dismissed--c100", "flow-pause-09-dismissed--c160"]) {
    it(`with the lookup on the turn, ${id} is still r4's frame`, () => {
      const evaluation = folded.evaluate(loadGolden(id));
      expect(evaluation.pass, firstProblem(evaluation)).toBe(true);
    });
  }

  it("a lookup that lists another ad too stays a view, above the card", () => {
    const screen = loadR4Fixture("flow-pause-01-needs-your-ok");
    const lines = ansiToSegmentLines(draw(["Demo C · demo"])(screen, 100)).map((line) => textOf(line));
    const head = lines.findIndex((line) => line.includes(LOOKUP_TITLE));
    expect(head).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.startsWith("┌─ Pause ad"))).toBeGreaterThan(head);
  });
});
