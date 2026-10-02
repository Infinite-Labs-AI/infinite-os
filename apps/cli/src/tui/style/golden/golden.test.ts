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
//   - every id that has matched is recorded in `matchedEver`, and an id may
//     not be on both lists: hiding a regression means editing two lists, in
//     plain sight of the reviewer.
// After a restyle change, `GOLDEN_RATCHET=update pnpm exec vitest run <this file>`
// removes every newly passing id from the list and adds it to `matchedEver`
// (it never adds an expected failure). The run prints the pass counts.
//
// TIERS. Every golden is evaluated at truecolor (`<id>`) and at the 256 tier
// (`<id>@256`, INFINITE_COLOR=256 and FORCE_COLOR=2 pinned for that pass). At
// 256 the screen must also carry no truecolor SGR, so a CLI without the tier
// switch (R0) fails there honestly instead of matching on hex lookalikes.
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pinnedEnv = vi.hoisted(() => {
  // Pin what the session reads from the environment: truecolor through Ink
  // (chalk reads FORCE_COLOR when it loads), UTC times, no NO_COLOR. Restored
  // after the file, so nothing leaks into a worker's next test file.
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

import { decodeAnswerView } from "../../../desktop/answer-view-decode.js";
import { homeInventoryData } from "../../../index.js";
import { resolveTheme } from "../../theme.js";
import { transcriptColumns } from "../../ink/transcript-app.js";
import { renderLiveTurn } from "../../views/layout.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { firstProblem, GoldenEvaluator, REGION_SCREENS, type Evaluation, type EvaluatorTier } from "./evaluate.js";
import { loadR4Fixture, r4FixtureIds } from "./fixtures.js";
import { GOLDENS_DIR, goldenIds, loadGolden, screenOf } from "./goldens.js";
import { cellsOf, textOf } from "./normalize.js";
import { ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import { recordedViews, renderR4Screen, turnMessages } from "./screen.js";

/** The wall clock every screen is drawn at (the r4 data's "now": Oct 1, 10:44 UTC). */
export const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const RATCHET_FILE = `${GOLDENS_DIR}expected-fail.json`;
const ratchetFile: { expectedFail: Record<string, string>; matchedEver: string[] } = JSON.parse(readFileSync(RATCHET_FILE, "utf8"));
const ratchet = ratchetFile.expectedFail;
const matchedEver = ratchetFile.matchedEver;
const ids = goldenIds();
/** The tiers tier 1 renders at: the id suffix and the environment pinned while drawing. */
const TIERS = [
  { tier: "truecolor", suffix: "", env: { FORCE_COLOR: "3", INFINITE_COLOR: "truecolor", COLORTERM: "truecolor" } },
  { tier: "256", suffix: "@256", env: { FORCE_COLOR: "2", INFINITE_COLOR: "256", COLORTERM: undefined } }
] as const satisfies readonly { tier: EvaluatorTier; suffix: string; env: Record<string, string | undefined> }[];
const tieredIds = TIERS.flatMap(({ suffix }) => ids.map((id) => `${id}${suffix}`));
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

/** Run `draw` with `env` pinned, then put the environment back. */
function withEnv<T>(env: Record<string, string | undefined>, draw: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  set(env);
  try {
    return draw();
  } finally {
    set(saved);
  }
}

const evaluators = new Map(TIERS.map(({ tier, env }) => [tier, new GoldenEvaluator((fixture, cols) =>
  withEnv(env, () => renderR4Screen(fixture, { cols, now: FIXED_CLOCK, homeInventory: homeInventoryData, sessionProps: ENTRY_SESSION_PROPS })),
tier)]));
const evaluator = evaluators.get("truecolor")!;

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(pinnedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const passing = tieredIds.filter((id) => results.get(id)?.pass);
  const counts = TIERS.map(({ tier, suffix }) => `${passing.filter((id) => (suffix ? id.endsWith(suffix) : !id.includes("@"))).length} of ${ids.length} match (${tier})`);
  const bridges = bridgeIds.filter((id) => bridgePass.get(id));
  const newly = [...passing, ...bridges].filter((id) => id in ratchet);
  console.log(`r4 goldens, tier 1: ${counts.join("; ")}; Ink bridge: ${bridges.length} of ${bridgeIds.length} screens lossless${newly.length ? `; newly matching: ${newly.join(", ")}` : ""}`);
  const matchedNow = [...passing, ...bridges].filter((id) => !matchedEver.includes(id));
  if (process.env.GOLDEN_RATCHET === "update" && (newly.length || matchedNow.length)) {
    const next = Object.fromEntries(Object.entries(ratchet).filter(([id]) => !newly.includes(id)));
    const ever = [...new Set([...matchedEver, ...matchedNow])].sort();
    writeFileSync(RATCHET_FILE, `${JSON.stringify({ ...JSON.parse(readFileSync(RATCHET_FILE, "utf8")), expectedFail: next, matchedEver: ever }, null, 1)}\n`);
    console.log(`expected-fail.json: removed ${newly.length}; matchedEver: added ${matchedNow.length}`);
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

  it("the expected-fail list names only real goldens (per tier) and bridge checks, each with a reason", () => {
    expect(Object.keys(ratchet).filter((id) => !tieredIds.includes(id) && !bridgeIds.includes(id))).toEqual([]);
    expect(Object.entries(ratchet).filter(([, why]) => !why.trim())).toEqual([]);
  });

  it("a golden that ever matched is never expected to fail again (matchedEver)", () => {
    // Re-adding a regressed id means deleting it from matchedEver too: a reviewer sees both edits.
    expect(Object.keys(ratchet).filter((id) => matchedEver.includes(id))).toEqual([]);
    expect(matchedEver.filter((id) => !tieredIds.includes(id) && !bridgeIds.includes(id))).toEqual([]);
  });

  it("every check not expected to fail is recorded in matchedEver (GOLDEN_RATCHET=update records it)", () => {
    expect([...tieredIds, ...bridgeIds].filter((id) => !(id in ratchet) && !matchedEver.includes(id))).toEqual([]);
  });
});

describe.each(TIERS)("r4 goldens (tier 1, $tier)", ({ tier, suffix }) => {
  for (const golden of ids) {
    const id = `${golden}${suffix}`;
    it(id, () => {
      const evaluation = evaluators.get(tier)!.evaluate(loadGolden(golden), golden);
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
