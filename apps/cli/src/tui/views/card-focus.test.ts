// A write card waiting for its answer under a tall view (live check 2,
// W3L2-M2): the details pane is cut to the window, and the card is the pane's
// last details. The pane opens on the card, so its title, rows and keys are on
// screen while its OK key is offered; scrolled off, the layout says so
// (`cardShown: false`) and the session takes the OK key off the bar. Synthetic
// data only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { TurnStep } from "../app/turn-store.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { viewFocusAfterTurnDone } from "./focus.js";
import { detailsPaneWidth, renderLiveTurn, rowsBesideCard } from "./layout.js";

const theme = INFINITE_R4_THEME;
const fixture = (name: string) => {
  const view = decodeAnswerView(JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), "utf8")));
  if (!view) throw new Error(`${name} does not decode`);
  return view;
};
/** A list of `count` sample ads (none of them the card's ad), so nothing folds into the card. */
const tallList = (count = 65) => {
  const list = fixture("list-rows") as Extract<ReturnType<typeof fixture>, { kind: "list" }>;
  const template = list.body.rows[0]!;
  const rows = Array.from({ length: count }, (_unused, index) => ({
    ...template, id: `row_${index + 1}`, title: `Sample row ${String(index + 1).padStart(2, "0")}`
  }));
  return { ...list, title: "Sample ads", body: { ...list.body, rows, shown: rows.length, total: rows.length } };
};
const steps: TurnStep[] = [
  { id: "c1", name: "list_sample_entities", label: "checking your campaigns", status: "ok", startedAt: 0, endedAt: 500, result: "65 ads" },
  { id: "c2", name: "propose_pause_entity", label: "waiting for your OK", status: "wait", startedAt: 500, endedAt: 600, result: "pause 1 ad" }
];
const turn: Msg[] = [{ role: "user", text: "pause my worst ad" }, { role: "assistant", text: "Ready. It stops spending once you say OK." }];
/** A stand-in card: its title, a row, its keys. */
const card = ["┌─ Pause ad “Demo A”? ─┐", "│ status   on → paused │", "│  p  Pause    n  dismiss │", "└──────────────────────┘"];

const draw = (width: number, rows: number, extra: Partial<Parameters<typeof renderLiveTurn>[0]> = {}) => {
  const views = [fixture("numbers-ads"), tallList()];
  return renderLiveTurn({
    messages: turn, views, focus: viewFocusAfterTurnDone(views, undefined, [fixture("change-pause-card")]), width, color: false, theme,
    details: card, statusViews: [fixture("change-pause-card")], steps, nowMs: 600, rows, ...extra
  });
};

describe("a waiting card under a tall view opens on screen (W3L2-M2)", () => {
  // The rows the live region gives the turn at 80x24, 100x40 and 140x44.
  for (const [width, rows] of [[80, 17], [100, 33], [140, 37]] as const) {
    it(`at ${width} columns, ${rows} rows: the pane opens on the whole card, the views above it`, () => {
      const drawn = draw(width, rows);
      const text = drawn.lines.join("\n");
      expect(drawn.lines.length).toBeLessThanOrEqual(rows);
      // The whole card: its title, its row and its keys.
      for (const line of card) expect(text).toContain(line);
      expect(drawn.cardShown).toBe(true);
      // The pane is cut above the card and says so; nothing is cut below it.
      expect(drawn.pane).not.toBeNull();
      expect(drawn.pane!.below).toBe(0);
      expect(drawn.pane!.above).toBeGreaterThan(0);
      expect(text).toMatch(/↑ \d+ above · ↑ PgUp/u);
      expect(text).not.toMatch(/more · tab, then ↓/u);
      // The question stays beside it.
      expect(drawn.lines[0]).toMatch(/^❯ pause my worst ad/u);
    });

    it(`at ${width} columns, ${rows} rows: scrolled to the top, the card is off screen and the layout says so`, () => {
      const drawn = draw(width, rows, { cardScroll: 0 });
      const text = drawn.lines.join("\n");
      expect(text).not.toContain(card[0]);
      expect(drawn.cardShown).toBe(false);
      expect(drawn.pane!.above).toBe(0);
      expect(text).toMatch(/↓ \d+ more · ↓ PgDn/u);
    });

    it(`at ${width} columns, ${rows} rows: one row up from the card, its foot is cut and it no longer counts as on screen`, () => {
      const opened = draw(width, rows);
      const drawn = draw(width, rows, { cardScroll: opened.pane!.above - 1 });
      expect(drawn.lines.join("\n")).toContain(card[0]);
      expect(drawn.lines.join("\n")).not.toContain(card[card.length - 1]);
      expect(drawn.cardShown).toBe(false);
      // Back down: on screen again.
      expect(draw(width, rows, { cardScroll: opened.pane!.above }).cardShown).toBe(true);
    });
  }

  it("a card taller than the pane opens at its title row, and counts as on screen there", () => {
    const tall = [card[0]!, ...Array.from({ length: 40 }, (_unused, index) => `│ row ${index} │`), card[3]!];
    const drawn = draw(100, 33, { details: tall });
    expect(drawn.lines.join("\n")).toContain(card[0]);
    expect(drawn.cardShown).toBe(true);
  });

  it("a turn that fits draws the card whole and counts it on screen; with no card the layout says nothing", () => {
    const views = [fixture("numbers-ads")];
    const fits = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 140, color: false, theme, details: card, steps, nowMs: 600 });
    expect(fits.pane).toBeNull();
    expect(fits.cardShown).toBe(true);
    const none = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 140, color: false, theme, steps, nowMs: 600, rows: 30 });
    expect(none.cardShown).toBeNull();
  });

  it("from 80 columns the card's row budget does not count the views above it (they scroll away above the card)", () => {
    const views = [fixture("numbers-ads"), tallList()];
    for (const width of [80, 100, 140]) {
      const beside = rowsBesideCard({ messages: turn, views, focus: null, steps, width, color: false, theme, statusViews: [fixture("change-pause-card")] });
      // The Steps (header + 2 rows), the blank pane row over them, and the pane's `↑ N above` line.
      expect(beside, String(width)).toBe(5);
      expect(detailsPaneWidth(width)).toBeGreaterThan(40);
    }
  });
});
