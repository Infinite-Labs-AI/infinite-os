// The one-column chat layouts (2026-10-15, `chat-layout.ts`), drawn from the
// neutral sample turns: V1 `flow` (one column, calls as compact lines, cards
// whole under the words) and V2 `flow-compact` (the same, each card folded to
// its head and a verdict line until tab). Both keep two columns for a turn that
// asks for them. The default stays today's split.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TurnStep } from "../app/turn-store.js";
import { keyBarText } from "../keys/keymap.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import { ENTRY_SESSION_PROPS } from "../style/golden/feed-chrome.js";
import type { R4ScreenFixture, R4Turn } from "../style/golden/fixtures.js";
import { loadOneColumnFixture, ONE_COLUMN_CLOCK } from "../style/golden/one-column-fixtures.js";
import { recordedViews, renderR4Screen, turnMessages } from "../style/golden/screen.js";
import { asksSideBySide, CHAT_LAYOUT_ENV, chatLayout, tabSideWords, type ChatLayout } from "./chat-layout.js";
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

function live(id: string, layout: ChatLayout, width: number, focus: ViewFocusState | null = null, turn = turnOf(id)): string[] {
  return renderLiveTurn({
    messages: turnMessages(turn), views: recordedViews(turn), focus, steps: steps(turn), nowMs: ONE_COLUMN_CLOCK,
    width, color: false, theme: resolveTheme(), layout
  }).lines.map(plain);
}

const indexOf = (lines: readonly string[], words: string) => lines.findIndex((line) => line.includes(words));

beforeAll(() => {
  vi.useFakeTimers({ now: ONE_COLUMN_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  delete process.env[CHAT_LAYOUT_ENV];
});

describe("the layout option", () => {
  it("is split unless the env asks for a flow", () => {
    expect(chatLayout({})).toBe("split");
    expect(chatLayout({ [CHAT_LAYOUT_ENV]: "flow" })).toBe("flow");
    expect(chatLayout({ [CHAT_LAYOUT_ENV]: " Flow-Compact " })).toBe("flow-compact");
    expect(chatLayout({ [CHAT_LAYOUT_ENV]: "columns" })).toBe("split");
  });

  it("asks for two columns on side-by-side words or a compare card, not on an everyday 'compared'", () => {
    const ask = (text: string) => [{ role: "user" as const, text }];
    expect(asksSideBySide(ask("show ads and funnel side by side"))).toBe(true);
    expect(asksSideBySide(ask("put it in two columns"))).toBe(true);
    expect(asksSideBySide(ask("give me a dashboard of this week"))).toBe(true);
    expect(asksSideBySide(ask("how did ads do compared to last week?"))).toBe(false);
    expect(asksSideBySide(ask("how did ads do?"), [{ kind: "compare" }])).toBe(true);
  });

  it("splits a turn in a flow only when it asks", () => {
    const plainTurn = turnMessages(turnOf("01-plain-text"));
    const sideBySide = turnOf("05-side-by-side");
    expect(turnMaySplit(plainTurn, 100, [], "split")).toBe(true);
    expect(turnMaySplit(plainTurn, 100, [], "flow")).toBe(false);
    expect(turnMaySplit(turnMessages(sideBySide), 100, recordedViews(sideBySide), "flow")).toBe(true);
    expect(turnMaySplit(turnMessages(sideBySide), 60, recordedViews(sideBySide), "flow")).toBe(false);
  });
});

describe("V1 flow", () => {
  it("reads question, calls, words, card, in one column at the whole width", () => {
    const lines = live("02-ads-card", "flow", 100);
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

  it("draws every call as one line, a failed reason included", () => {
    const lines = live("04-multi-step-job", "flow", 100);
    expect(lines).toContain("  ✗ reading Search Console · not connected");
    expect(lines).toContain("  ⟳ writing the post · step 2 of 5");
    expect(indexOf(lines, "writing the post") < indexOf(lines, "∞ I read your site")).toBe(true);
  });

  it("keeps every call in place when the turn goes to scrollback", () => {
    const turn = turnOf("04-multi-step-job");
    const lines = renderCommittedTurn({
      messages: turnMessages(turn), views: recordedViews(turn), focus: null, steps: steps(turn), width: 100,
      color: false, theme: resolveTheme(), layout: "flow"
    }).map(plain);
    expect(lines).toContain("  ✓ reading your site · 24 pages");
    expect(lines.filter((line) => line.includes("reading Search Console"))).toHaveLength(1);
    expect(indexOf(lines, "reading your site") < indexOf(lines, "∞ I read your site")).toBe(true);
  });

  it("keeps two columns for a turn that asks for them", () => {
    const lines = live("05-side-by-side", "flow", 100);
    expect(lines.some((line) => line.includes(" │ "))).toBe(true);
    expect(lines.some((line) => line.includes("Steps"))).toBe(true);
  });

  it("leaves today's default alone", () => {
    expect(live("01-plain-text", "split", 100).some((line) => line.includes("│"))).toBe(true);
  });
});

describe("V2 flow-compact", () => {
  it("folds a card to its head and a verdict made of the card's own numbers", () => {
    const lines = live("02-ads-card", "flow-compact", 100);
    const head = indexOf(lines, "▸");
    expect(lines[head]).toContain("Meta ads last week");
    expect(lines[head + 1]).toContain("Spent $412.60 · Impressions 32,700 · Link clicks 486 · 3 ad sets");
    expect(lines.some((line) => line.includes("┌"))).toBe(false);
  });

  it("prints a funnel's first and last step as counted, and a job's current step", () => {
    expect(live("03-funnel", "flow-compact", 100).join("\n")).toContain("Visits 2,400 → Paying 9 · 5 steps");
    expect(live("04-multi-step-job", "flow-compact", 100).join("\n")).toContain("Outline section 2 of 6 · 1 of 5 steps done");
  });

  it("drops the verdict's last parts rather than cut a word at a narrow width", () => {
    const lines = live("02-ads-card", "flow-compact", 60);
    const verdict = lines[indexOf(lines, "▸") + 1]!;
    expect(verdict).not.toContain("…");
    expect(displayWidth(verdict)).toBeLessThanOrEqual(60);
    expect(verdict).toContain("Spent $412.60");
  });

  it("opens every card in place once the keys are on them (tab)", () => {
    const turn = turnOf("02-ads-card");
    const engaged = { ...viewFocusAfterTurnDone(recordedViews(turn)), engaged: true };
    const lines = live("02-ads-card", "flow-compact", 100, engaged);
    expect(lines.some((line) => line.includes("▾") && line.includes("Meta ads last week"))).toBe(true);
    expect(lines.some((line) => line.includes("┌"))).toBe(true);
  });

  it("never folds a card that asks for an OK", () => {
    const turn = turnOf("02-ads-card");
    const asking = { ...turn, views: turn.views.map((view) => ({ ...view, state: "needs_yes" as const })) };
    expect(live("02-ads-card", "flow-compact", 100, null, asking).some((line) => line.includes("▸"))).toBe(false);
  });

  it("says what tab does: open cards, close cards; switch side on a two-column turn", () => {
    process.env[CHAT_LAYOUT_ENV] = "flow-compact";
    const focus = viewFocusAfterTurnDone(recordedViews(turnOf("02-ads-card")));
    expect(viewKeyHints(focus).find((hint) => hint.key === "tab")?.label).toBe("open cards");
    // Folded, its rows are not on screen: no `j k row`, no `→ columns`.
    expect(viewKeyHints(focus).map((hint) => hint.key)).toEqual(["tab"]);
    expect(viewKeyHints({ ...focus, engaged: true }).some((hint) => hint.key === "j k")).toBe(true);
    expect(viewKeyHints({ ...focus, engaged: true }).find((hint) => hint.key === "tab")?.label).toBe("close cards");
    expect(viewKeyHints(focus, focus.facts, [], true).find((hint) => hint.key === "tab")?.label).not.toBe("open cards");
    expect(tabSideWords("flow-compact", true)).toBe("switch side");
    expect(keyBarText([], { sides: true })).toContain("to card");
    expect(keyBarText([], { sides: true, twoColumns: true })).toContain("switch side");
  });
});

describe("the real session in a flow", () => {
  const screen = (fixture: R4ScreenFixture, cols: number) =>
    plain(renderR4Screen(fixture, { cols, now: ONE_COLUMN_CLOCK, homeInventory: () => { throw new Error("not drawn"); }, sessionProps: ENTRY_SESSION_PROPS })).split("\n");

  it("draws a plain answer in one column from 80 columns", () => {
    process.env[CHAT_LAYOUT_ENV] = "flow";
    const rows = screen(loadOneColumnFixture("01-plain-text"), 100);
    expect(rows.some((row) => row.includes("│"))).toBe(false);
    expect(rows.some((row) => row.startsWith("∞ Start with the headline. It is the one line every visitor reads"))).toBe(true);
  });

  it("opens V2's cards from the screen after tab", () => {
    process.env[CHAT_LAYOUT_ENV] = "flow-compact";
    const fixture = loadOneColumnFixture("02-ads-card");
    expect(screen(fixture, 100).some((row) => row.includes("┌"))).toBe(false);
    const opened = { ...fixture, turn: { ...fixture.turn!, focus: { viewEngaged: true } } };
    expect(screen(opened, 100).some((row) => row.includes("┌"))).toBe(true);
  });
});
