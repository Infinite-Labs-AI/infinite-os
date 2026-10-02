// The r4 golden test (terminal-r4 spec §11d, tier 1): every synthetic golden,
// rendered through the REAL interactive session from its fixture, compared row
// by row and token by token.
//
// THE RATCHET. `__goldens__/expected-fail.json` lists the goldens the CLI does
// not match yet, each with the lane expected to flip it. CI stays green while
// the restyle lanes land, and:
//   - a golden NOT on the list must match: a regression fails CI;
//   - a golden ON the list that now matches ALSO fails CI, until it is removed
//     from the list, so a pass can never silently regress later.
// After a restyle change, `GOLDEN_RATCHET=update pnpm exec vitest run <this file>`
// removes every newly passing id from the list (it never adds one). The run
// prints the pass count either way.
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Pin what the session reads from the environment: truecolor through Ink
  // (chalk reads FORCE_COLOR when it loads), UTC times, no NO_COLOR.
  process.env.FORCE_COLOR = "3";
  process.env.COLORTERM = "truecolor";
  process.env.TERM = "xterm-256color";
  process.env.TZ = "UTC";
  process.env.INFINITE_COLOR = "truecolor";
  delete process.env.NO_COLOR;
  delete process.env.INFINITE_THEME;
  delete process.env.INFINITE_PLAIN_OUTPUT;
});

import { decodeAnswerView } from "../../../desktop/answer-view-decode.js";
import { homeInventoryData } from "../../../index.js";
import { resolveTheme } from "../../theme.js";
import { transcriptColumns } from "../../ink/transcript-app.js";
import { renderLiveTurn } from "../../views/layout.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { firstProblem, GoldenEvaluator, REGION_SCREENS, type Evaluation } from "./evaluate.js";
import { loadR4Fixture, r4FixtureIds } from "./fixtures.js";
import { GOLDENS_DIR, goldenIds, loadGolden, screenOf } from "./goldens.js";
import { cellsOf, textOf } from "./normalize.js";
import { recordedViews, renderR4Screen, turnMessages } from "./screen.js";

/** The wall clock every screen is drawn at (the r4 data's "now": Oct 1, 10:44 UTC). */
export const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const RATCHET_FILE = `${GOLDENS_DIR}expected-fail.json`;
const ratchet: Record<string, string> = JSON.parse(readFileSync(RATCHET_FILE, "utf8")).expectedFail;
const ids = goldenIds();
const results = new Map<string, Evaluation>();
/** Bridge checks (`bridge/<screen>`): the screens whose turn the session draws through `renderLiveTurn`. */
const BRIDGE_COLS = 160;
const bridgeIds = r4FixtureIds()
  .filter((screen) => {
    const turn = loadR4Fixture(screen).turn;
    return turn !== null && recordedViews(turn).length > 0;
  })
  .map((screen) => `bridge/${screen}`);
const bridgePass = new Map<string, boolean>();

const evaluator = new GoldenEvaluator((fixture, cols) =>
  renderR4Screen(fixture, { cols, now: FIXED_CLOCK, homeInventory: homeInventoryData })
);

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  const passing = ids.filter((id) => results.get(id)?.pass);
  const bridges = bridgeIds.filter((id) => bridgePass.get(id));
  const newly = [...passing, ...bridges].filter((id) => id in ratchet);
  console.log(`r4 goldens: ${passing.length} of ${ids.length} match (tier 1, truecolor); Ink bridge: ${bridges.length} of ${bridgeIds.length} screens lossless${newly.length ? `; newly matching: ${newly.join(", ")}` : ""}`);
  if (process.env.GOLDEN_RATCHET === "update" && newly.length) {
    const next = Object.fromEntries(Object.entries(ratchet).filter(([id]) => !newly.includes(id)));
    writeFileSync(RATCHET_FILE, `${JSON.stringify({ ...JSON.parse(readFileSync(RATCHET_FILE, "utf8")), expectedFail: next }, null, 1)}\n`);
    console.log(`expected-fail.json: removed ${newly.length}`);
  }
});

describe("r4 goldens: fixtures and ratchet are complete", () => {
  it("every golden screen has a fixture whose views decode", () => {
    const screens = new Set(ids.map((id) => screenOf(id, loadGolden(id)).screen).filter((screen) => !screen.startsWith("region-")));
    expect([...screens].filter((screen) => !r4FixtureIds().includes(screen))).toEqual([]);
    for (const screen of r4FixtureIds()) {
      for (const view of loadR4Fixture(screen).turn?.views ?? []) {
        expect(decodeAnswerView(view), `${screen}: ${view.kind} view`).not.toBeNull();
      }
    }
  });

  it("every region golden is drawn somewhere or has its own data assertion", () => {
    const regions = ids.filter((id) => id.startsWith("region-"));
    const data = regions.filter((id) => loadGolden(id).data !== undefined);
    expect(data.sort()).toEqual(["region-bar-eighths", "region-card-width-cap", "region-chips", "region-steps", "region-table-numbers-hidden-60"]);
    expect(regions.filter((id) => !data.includes(id) && !REGION_SCREENS[id])).toEqual([]);
  });

  it("the expected-fail list names only real goldens and bridge checks, each with a reason", () => {
    expect(Object.keys(ratchet).filter((id) => !ids.includes(id) && !bridgeIds.includes(id))).toEqual([]);
    expect(Object.entries(ratchet).filter(([, why]) => !why.trim())).toEqual([]);
  });
});

describe("r4 goldens (tier 1)", () => {
  for (const id of ids) {
    it(id, () => {
      const evaluation = evaluator.evaluate(loadGolden(id), id);
      results.set(id, evaluation);
      if (id in ratchet) {
        // Expected to fail until its lane lands. Matching now is a ratchet step: take it off the list.
        if (process.env.GOLDEN_RATCHET === "update") return;
        expect(
          evaluation.pass,
          `${id} now MATCHES: remove it from __goldens__/expected-fail.json (GOLDEN_RATCHET=update does it)`
        ).toBe(false);
        return;
      }
      expect(evaluation.pass, `${id}: ${firstProblem(evaluation)}`).toBe(true);
    });
  }
});

// The Ink bridge (spec §11d "bridge smoke test"): the session prints a turn's
// pre-rendered ANSI lines through `AnsiLine`. Every row the pure renderer draws
// must reach the screen with the same text AND the same tokens, so a dropped
// background, underline, inverse or faint (the bridge bug class) fails here
// even before any golden can match.
describe("Ink bridge: the session prints renderLiveTurn's rows unchanged", () => {
  for (const id of bridgeIds) {
    it(id, () => {
      const fixture = loadR4Fixture(id.slice("bridge/".length));
      const turn = fixture.turn!;
      const pure = ansiToSegmentLines(renderLiveTurn({
        messages: turnMessages(turn),
        views: recordedViews(turn),
        focus: null,
        width: transcriptColumns(BRIDGE_COLS),
        color: true,
        theme: resolveTheme()
      }).lines);
      const screen = evaluator.screen(fixture, BRIDGE_COLS);
      const key = (line: (typeof pure)[number]) => JSON.stringify(cellsOf(line));
      const onScreen = new Set(screen.map(key));
      const lost = pure.filter((line) => textOf(line).trim() && !onScreen.has(key(line)));
      bridgePass.set(id, lost.length === 0);
      const first = lost[0];
      const twin = first ? screen.find((line) => textOf(line) === textOf(first)) : undefined;
      if (id in ratchet) {
        if (process.env.GOLDEN_RATCHET === "update") return;
        expect(lost.length > 0, `${id} is now lossless: remove it from __goldens__/expected-fail.json`).toBe(true);
        return;
      }
      expect(lost, first ? `${id}: ${JSON.stringify(first)} reached the screen as ${JSON.stringify(twin ?? "nothing")}` : id).toEqual([]);
    });
  }
});
