// The one-column default (2026-10-15, `chat-layout.ts`, River's V1), drawn
// from the neutral sample turns: one column at every width, each call as one
// compact line, the answer's words whole and each card under them at the
// whole width. Two columns only for a turn that asks for them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { TurnStep } from "../app/turn-store.js";
import { keyBarText } from "../keys/keymap.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import { ENTRY_SESSION_PROPS } from "../style/golden/feed-chrome.js";
import { loadR4Fixture, type R4ScreenFixture, type R4Turn } from "../style/golden/fixtures.js";
import { loadOneColumnFixture, ONE_COLUMN_CLOCK } from "../style/golden/one-column-fixtures.js";
import { recordedViews, renderR4Screen, turnMessages } from "../style/golden/screen.js";
import { asksSideBySide, tabSideWords } from "./chat-layout.js";
import { viewFocusAfterTurnDone, viewKeyHints, type ViewFocusState } from "./focus.js";
import { renderCommittedTurn, renderLiveTurn, turnMaySplit } from "./layout.js";

const plain = (line: string) =>
  line.replace(/\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "").replace(/\u001b\[[0-9;:?]*[A-Za-z]/gu, "");

function steps(turn: R4Turn): TurnStep[] {
  return turn.steps.map((step, index) => ({
    id: `s${index}`, name: `step_${index}`, label: step.label, status: step.status,
    startedAt: ONE_COLUMN_CLOCK + step.start * 1000, endedAt: ONE_COLUMN_CLOCK + step.end * 1000, result: step.result
  }));
}

function turnOf(id: string): R4Turn {
  return loadOneColumnFixture(id).turn!;
}

function live(id: string, width: number, focus: ViewFocusState | null = null, turn = turnOf(id)): string[] {
  return renderLiveTurn({
    messages: turnMessages(turn), views: recordedViews(turn), focus, steps: steps(turn), nowMs: ONE_COLUMN_CLOCK,
    width, color: false, theme: resolveTheme()
  }).lines.map(plain);
}

const indexOf = (lines: readonly string[], words: string) => lines.findIndex((line) => line.includes(words));

beforeAll(() => {
  vi.useFakeTimers({ now: ONE_COLUMN_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("when a turn is two columns", () => {
  it("asks for two columns on side-by-side words or a compare card, not on an everyday 'compared'", () => {
    const ask = (text: string) => [{ role: "user" as const, text }];
    expect(asksSideBySide(ask("show ads and funnel side by side"))).toBe(true);
    expect(asksSideBySide(ask("put it in two columns"))).toBe(true);
    expect(asksSideBySide(ask("open a split view"))).toBe(true);
    expect(asksSideBySide(ask("give me a dashboard of this week"))).toBe(true);
    expect(asksSideBySide(ask("lay my dashboards out"))).toBe(true);
    expect(asksSideBySide(ask("how did ads do compared to last week?"))).toBe(false);
    expect(asksSideBySide(ask("compare my ad sets"))).toBe(false);
    expect(asksSideBySide(ask("how did ads do?"), [{ kind: "compare" }])).toBe(true);
  });

  it("splits only a turn that asks, from 80 columns", () => {
    const plainTurn = turnMessages(turnOf("01-plain-text"));
    const sideBySide = turnOf("05-side-by-side");
    expect(turnMaySplit(plainTurn, 100)).toBe(false);
    expect(turnMaySplit(plainTurn, 160)).toBe(false);
    expect(turnMaySplit(turnMessages(sideBySide), 100, recordedViews(sideBySide))).toBe(true);
    expect(turnMaySplit(turnMessages(sideBySide), 80, recordedViews(sideBySide))).toBe(true);
    expect(turnMaySplit(turnMessages(sideBySide), 79, recordedViews(sideBySide))).toBe(false);
  });

  it("never splits a turn with nothing for the right pane, whatever the question says", () => {
    // "dashboard" in passing (a Shopify dashboard), with a plain answer: no view, no card.
    const turn = { ...turnOf("01-plain-text"), question: "why does my Shopify dashboard show different revenue than Stripe?" };
    expect(turnMaySplit(turnMessages(turn), 100)).toBe(false);
    // A waiting card is something for the pane.
    expect(turnMaySplit(turnMessages(turn), 100, [], true)).toBe(true);
    for (const width of [80, 100, 160]) {
      const lines = live("01-plain-text", width, null, turn);
      expect(lines.some((line) => line.includes("│")), `c${width}`).toBe(false);
      expect(lines.some((line) => line.includes("Steps") || line.includes("steps only")), `c${width}`).toBe(false);
      // The answer runs the whole width, not a 28-column pane.
      expect(lines.some((line) => line.startsWith("∞ ") && displayWidth(line) > 40), `c${width}`).toBe(true);
    }
  });
});

describe("one column (the default)", () => {
  it("reads question, calls, words, card, in one column at the whole width", () => {
    const lines = live("02-ads-card", 100);
    // The words run the whole width (a split's answer pane is 28 columns at 100).
    expect(lines.some((line) => line.startsWith("∞ You spent $412.60 on 3 ad sets last week for 486 link clicks."))).toBe(true);
    const question = indexOf(lines, "❯ how did my meta ads do last week?");
    const call = indexOf(lines, "✓ checking your Meta ads · 3 ad sets");
    const words = indexOf(lines, "∞ You spent $412.60");
    const card = indexOf(lines, "Meta ads last week");
    expect([question, call, words, card].every((at) => at >= 0)).toBe(true);
    expect(question < call && call < words && words < card).toBe(true);
    // The words show whole (no caption gate), with no rule and no Steps strip.
    expect(lines.join("\n")).toContain("cheapest clicks");
    expect(lines.some((line) => line.includes("more (?)") || line.includes("Steps") || /^─+$/u.test(line))).toBe(false);
    // The card's table has the whole width: Impressions is not hidden.
    expect(lines.some((line) => line.includes("Impressions"))).toBe(true);
    expect(lines.every((line) => displayWidth(line) <= 100)).toBe(true);
  });

  it("draws a plain answer in one column at any width, with no pane separator", () => {
    for (const width of [60, 80, 100, 160]) {
      const lines = live("01-plain-text", width);
      expect(lines.some((line) => line.includes("│")), `c${width}`).toBe(false);
      expect(lines.some((line) => line.includes("steps only")), `c${width}`).toBe(false);
    }
  });

  it("draws a quiet view with no `steps only` head and no sentence pointing at a strip", () => {
    const turn = loadR4Fixture("view-12-quiet").turn!;
    const rendered = renderLiveTurn({
      messages: turnMessages(turn), views: recordedViews(turn), focus: viewFocusAfterTurnDone(recordedViews(turn)),
      steps: steps(turn), nowMs: ONE_COLUMN_CLOCK, width: 100, color: false, theme: resolveTheme()
    });
    const lines = rendered.lines.map(plain);
    expect(lines.some((line) => line.includes("steps only") || line.includes("Below is what I read"))).toBe(false);
    // Nothing takes a card's place, so the key bar offers no `tab to card`.
    expect(rendered.details).toBe(false);
    // Asked side by side, r4's view-12 draws it in the details pane, as before.
    const asked = { ...turn, question: `${turn.question}, side by side` };
    const wide = renderLiveTurn({
      messages: turnMessages(asked), views: recordedViews(asked), focus: viewFocusAfterTurnDone(recordedViews(asked)),
      steps: steps(asked), nowMs: ONE_COLUMN_CLOCK, width: 100, color: false, theme: resolveTheme()
    }).lines.map(plain);
    expect(wide.some((line) => line.includes("│ steps only") || line.endsWith("steps only"))).toBe(true);
  });

  it("draws every call as one line, a failed reason included", () => {
    const lines = live("04-multi-step-job", 100);
    expect(lines).toContain("  ✗ reading Search Console · not connected");
    expect(lines).toContain("  ⟳ writing the post · step 2 of 5");
    expect(indexOf(lines, "writing the post") < indexOf(lines, "∞ I read your site")).toBe(true);
  });

  it("keeps every call in place when the turn goes to scrollback", () => {
    const turn = turnOf("04-multi-step-job");
    const lines = renderCommittedTurn({
      messages: turnMessages(turn), views: recordedViews(turn), focus: null, steps: steps(turn), width: 100,
      color: false, theme: resolveTheme()
    }).map(plain);
    expect(lines).toContain("  ✓ reading your site · 24 pages");
    expect(lines.filter((line) => line.includes("reading Search Console"))).toHaveLength(1);
    expect(indexOf(lines, "reading your site") < indexOf(lines, "∞ I read your site")).toBe(true);
  });

  it("prints a turn that was two columns live as one column in scrollback", () => {
    const turn = turnOf("05-side-by-side");
    const lines = renderCommittedTurn({
      messages: turnMessages(turn), views: recordedViews(turn), focus: null, steps: steps(turn), width: 100,
      color: false, theme: resolveTheme()
    }).map(plain);
    // The question has nothing beside it (a table's own `│` cells are not a pane separator).
    expect(lines.find((line) => line.startsWith("❯ "))).not.toContain("│");
    expect(lines.some((line) => line.includes("Steps"))).toBe(false);
  });

  it("says what tab does: to card, back to chat; switch side on a two-column turn", () => {
    const focus = viewFocusAfterTurnDone(recordedViews(turnOf("02-ads-card")));
    expect(viewKeyHints(focus).find((hint) => hint.key === "tab")?.label).toBe("to card");
    expect(viewKeyHints({ ...focus, engaged: true }).find((hint) => hint.key === "tab")?.label).toBe("back to chat");
    expect(viewKeyHints({ ...focus, engaged: true }, focus.facts, [], true).find((hint) => hint.key === "tab")?.label).toBe("switch side");
    expect(tabSideWords()).toBe("to card");
    expect(tabSideWords(true)).toBe("switch side");
    expect(keyBarText([], { sides: true })).toContain("to card");
    expect(keyBarText([], { sides: true, twoColumns: true })).toContain("switch side");
  });
});

describe("two columns, when the turn asks", () => {
  it("keeps today's split: the answer pane, the separator and the Steps strip", () => {
    const lines = live("05-side-by-side", 100);
    expect(lines.find((line) => line.startsWith("❯ "))).toContain(" │ ");
    expect(lines.some((line) => line.includes("Steps"))).toBe(true);
  });

  it("is one column below 80 columns even when it asks", () => {
    const lines = live("05-side-by-side", 60);
    expect(lines.find((line) => line.startsWith("❯ "))).not.toContain("│");
    expect(lines.some((line) => line.includes("Steps"))).toBe(false);
  });
});

describe("the real session", () => {
  const screen = (fixture: R4ScreenFixture, cols: number) =>
    plain(renderR4Screen(fixture, { cols, now: ONE_COLUMN_CLOCK, homeInventory: () => { throw new Error("not drawn"); }, sessionProps: ENTRY_SESSION_PROPS })).split("\n");

  it("draws a plain answer in one column from 80 columns", () => {
    const rows = screen(loadOneColumnFixture("01-plain-text"), 100);
    expect(rows.some((row) => row.includes("│"))).toBe(false);
    expect(rows.some((row) => row.startsWith("∞ Start with the headline. It is the one line every visitor reads"))).toBe(true);
  });

  it("draws a side-by-side ask in two columns", () => {
    const rows = screen(loadOneColumnFixture("05-side-by-side"), 100);
    expect(rows.find((row) => row.startsWith("❯ "))).toContain(" │ ");
  });
});
