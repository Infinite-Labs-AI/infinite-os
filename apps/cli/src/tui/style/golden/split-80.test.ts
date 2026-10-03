// Every r4 screen at 80 columns, drawn through the REAL session: the turn sits
// side by side from 80 columns (r4 `frame()`: wide=W>=80), so the details pane
// is 51 columns wide, its narrowest. Every view kind and every card must stay
// legible there: no row wider than the window, every box closed on both sides,
// the Steps strip and the key bar inside the window. Synthetic data only.
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

import { homeInventoryData } from "../../../index.js";
import { displayWidth } from "../../lib/display-width.js";
import { paneWidths } from "../../views/layout.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import { loadR4Fixture, r4FixtureIds } from "./fixtures.js";
import { textOf } from "./normalize.js";
import { renderR4Screen } from "./screen.js";

const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const COLS = 80;
const { left, right } = paneWidths(COLS);
const SCREENS = r4FixtureIds();

function rows(screen: string): string[] {
  const ansi = renderR4Screen(loadR4Fixture(screen), { cols: COLS, now: FIXED_CLOCK, homeInventory: homeInventoryData, sessionProps: ENTRY_SESSION_PROPS });
  return ansiToSegmentLines(ansi).map((line) => textOf(line).trimEnd());
}

/** The body's rows (between the top rule and the Steps strip, or the rule over the composer). */
function body(all: readonly string[]): string[] {
  const end = all.findIndex((row, index) => index > 1 && (row.startsWith("─ Steps") || /^─+$/u.test(row)));
  return all.slice(2, end);
}

/** The details pane of a split row: right of ` │ ` (an empty pane row ends at the bar). */
function detailsOf(row: string): string {
  return Array.from(row).slice(left + 3).join("");
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

describe("every r4 screen at 80 columns: side by side, every view and card legible in the 51-column pane", () => {
  it("covers every view kind and every flow (41 screens)", () => {
    expect(SCREENS).toHaveLength(41);
    expect(left).toBe(26);
    expect(right).toBe(51);
  });

  for (const screen of SCREENS) {
    it(`${screen}: no row wider than 80, the body split at r4's pane, every box closed`, () => {
      const all = rows(screen);
      const shown = all.join("\n");
      for (const row of all) expect(displayWidth(row), `${row}\n\n${shown}`).toBeLessThanOrEqual(COLS);
      const turn = body(all);
      expect(turn.length, shown).toBeGreaterThan(0);
      // Every body row carries the separator at r4's column: the answer pane is 26 wide.
      for (const row of turn) expect(Array.from(row)[left + 1], `${row}\n\n${shown}`).toBe("│");
      // Boxes in the details pane (cards and tables) close on both sides, top to bottom, every row as wide as the top.
      const pane = turn.map(detailsOf);
      let open = 0;
      for (const row of pane) {
        if (row.startsWith("┌")) {
          expect(row, shown).toMatch(/─┐$/u);
          expect(displayWidth(row), shown).toBeLessThanOrEqual(right);
          open = displayWidth(row);
        } else if (open) {
          expect(row, shown).toMatch(row.startsWith("└") ? /^└[─┴]+┘$/u : /^[│├].*[│┤]$/u);
          expect(displayWidth(row), `${row}\n\n${shown}`).toBe(open);
          if (row.startsWith("└")) open = 0;
        }
      }
      expect(open, shown).toBe(0);
      // The Steps strip and the key bar fit the window (checked above), and the strip spans it.
      const steps = all.find((row) => row.startsWith("─ Steps"));
      if (steps) expect(displayWidth(steps)).toBe(COLS);
    });
  }

  it("a card is as wide as the pane (51), never wider", () => {
    // A card's top border carries its title (`┌─ Title ──┐`); a table's top is `┌───┬`.
    const tops = SCREENS.flatMap((screen) => body(rows(screen)).map(detailsOf).filter((row) => row.startsWith("┌─ ")));
    expect(tops.length).toBeGreaterThan(5);
    for (const top of tops) expect(displayWidth(top), top).toBe(right);
  });
});
