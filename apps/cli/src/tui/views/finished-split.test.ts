// Live L8 (round 4): a FINISHED turn taller than the window went whole to
// scrollback: the bar dropped to `/ commands`, Tab did nothing, `o` typed an
// `o`, and the split was lost. From 80 columns the last finished turn now
// keeps the split and its keys until the next question: both panes are held
// to the window, the answer pane like the details pane (its own `↓ N more` /
// `↑ N above` line). Tab switches the keys between the two sides, ↓/↑
// (PgDn/PgUp) scroll the focused side only, `o` opens the view's place from
// either side (after tab), Esc leaves. Synthetic data only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { TurnStep } from "../app/turn-store.js";
import { stripAnsi } from "../lib/display-width.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { answerOnlyFacts, resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts, viewKeyHints, type ViewFocusState } from "./focus.js";
import { paneWidths, renderLiveTurn, type LiveTurnRender } from "./layout.js";

const theme = INFINITE_R4_THEME;
const CAPS = { open: true, watch: false, retry: false };
const TURN_ROWS = 30;
const steps: TurnStep[] = [
  { id: "s1", name: "list_sources", label: "checking your sources", status: "ok", startedAt: 0, endedAt: 500, result: "6 sources" }
];
const longAnswer: Msg[] = [
  { role: "user", text: "how are my sources?" },
  { role: "assistant", text: Array.from({ length: 40 }, (_unused, index) => `Line ${index + 1} of the answer.`).join("\n\n") }
];

function fixture(name: string, patch: Record<string, unknown> = {}): AnswerViewV1 {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), "utf8"));
  const view = decodeAnswerView({ ...raw, ...patch });
  if (!view) throw new Error(`${name} does not decode`);
  return view;
}

/** The list_sources health view (synthetic), with a place `o` opens. */
const health = () => fixture("health-connections", { tool: "list_sources", appLink: { place: "settings.connections", label: "Open in Connections" } });
/** The get_meta_performance composite (synthetic), with a place `o` opens. */
const meta = () => fixture("meta-level-campaigns", { appLink: { place: "ads.meta", label: "Open in Meta Ads" } });

const plain = (lines: readonly string[]) => lines.map(stripAnsi);
const stepsHeaderAt = (lines: readonly string[]) => lines.findIndex((line) => /^─ Steps /u.test(line));

function draw(view: AnswerViewV1, width: number, focus: ViewFocusState | null, rows = TURN_ROWS): LiveTurnRender {
  return renderLiveTurn({ messages: longAnswer, views: [view], focus, width, color: false, theme, caps: CAPS, rows, steps });
}

/** The facts the session hands `resolveViewKey`: the focused view's, with both panes. */
function factsOf(drawn: LiveTurnRender) {
  return drawn.focused!.facts;
}

describe("a finished tall turn keeps the split, both panes held to the window (live L8)", () => {
  for (const width of [80, 100, 140]) {
    const panes = paneWidths(width);
    const leftOf = (line: string) => line.slice(0, panes.left).trimEnd();
    for (const [name, make] of [["list_sources health", health], ["get_meta_performance composite", meta]] as const) {
      it(`${name} at ${width}: fits the rows, keeps the separator, the answer pane says what is below`, () => {
        const drawn = draw(make(), width, null);
        const lines = plain(drawn.lines);
        expect(lines.length).toBeLessThanOrEqual(TURN_ROWS);
        const header = stepsHeaderAt(lines);
        expect(header).toBeGreaterThan(4);
        for (const line of lines.slice(0, header)) expect(line.slice(panes.left, panes.left + 2), line).toBe(" │");
        expect(lines[0]).toMatch(/^❯ how are my sources\?/u);
        expect(drawn.answerPane).not.toBeNull();
        expect(drawn.answerPane!.above).toBe(0);
        expect(lines.some((line) => /^↓ \d+ more · tab, then ↓/u.test(leftOf(line)))).toBe(true);
        expect(factsOf(drawn).answerPane).toEqual({ above: 0, below: drawn.answerPane!.below, page: drawn.answerPane!.shown });
      });

      it(`${name} at ${width}: ↓ on the answer side scrolls the answer pane only`, () => {
        const view = make();
        const start = viewFocusAfterTurnDone([view], CAPS);
        const before = draw(view, width, start);
        // At rest tab goes to the view (River: tab first, then o); tab again to the answer.
        const onView = resolveViewKey("", start, { tab: true }, factsOf(before));
        expect(onView.engaged).toBe(true);
        expect(onView.answerFocus ?? false).toBe(false);
        const onAnswer = resolveViewKey("", onView, { tab: true }, factsOf(draw(view, width, onView)));
        expect(onAnswer.answerFocus).toBe(true);
        expect(onAnswer.handled).toBe(true);
        const scrolled = resolveViewKey("", onAnswer, { downArrow: true }, factsOf(draw(view, width, onAnswer)));
        expect(scrolled.handled).toBe(true);
        expect(scrolled.answerScroll).toBe(1);
        expect(scrolled.paneScroll ?? 0).toBe(onAnswer.paneScroll ?? 0);
        const a = plain(draw(view, width, onAnswer).lines);
        const b = plain(draw(view, width, scrolled).lines);
        const header = stepsHeaderAt(a);
        // The answer pane moved on a line; the details pane did not move.
        expect(leftOf(b[1]!)).toBe(leftOf(a[2]!));
        for (let row = 0; row < header; row += 1) expect(b[row]!.slice(panes.left + 3), `row ${row}`).toBe(a[row]!.slice(panes.left + 3));
        // Once the keys are on it, the answer's more line names the keys themselves.
        expect(b.some((line) => /^↓ \d+ more · ↓ PgDn/u.test(leftOf(line)))).toBe(true);
      });

      it(`${name} at ${width}: o opens the view's place from the answer side; tab goes back to the view; Esc leaves`, () => {
        const view = make();
        const onView = resolveViewKey("", viewFocusAfterTurnDone([view], CAPS), { tab: true }, factsOf(draw(view, width, null)));
        const onAnswer = resolveViewKey("", onView, { tab: true }, factsOf(draw(view, width, onView)));
        const facts = factsOf(draw(view, width, onAnswer));
        expect(resolveViewKey("o", onAnswer, {}, facts).effect).toEqual({ type: "open", target: facts.open!.target });
        const back = resolveViewKey("", onAnswer, { tab: true }, facts);
        expect(back.answerFocus).toBe(false);
        expect(back.engaged).toBe(true);
        expect(back.focus).not.toBe("composer");
        const left = resolveViewKey("", onAnswer, { escape: true }, facts);
        expect(left.focus).toBe("composer");
        expect(left.answerFocus).toBe(false);
        const leftView = resolveViewKey("", back, { escape: true }, facts);
        expect(leftView.focus).toBe("composer");
        // A letter on the answer side starts a message.
        expect(resolveViewKey("w", onAnswer, {}, facts).focus).toBe("composer");
      });

      it(`${name} at ${width}: the bar says tab switch side · ↑ ↓ scroll · o open on the answer side`, () => {
        const view = make();
        const onView = resolveViewKey("", viewFocusAfterTurnDone([view], CAPS), { tab: true }, factsOf(draw(view, width, null)));
        const onAnswer = resolveViewKey("", onView, { tab: true }, factsOf(draw(view, width, onView)));
        const bar = viewKeyHints(onAnswer, factsOf(draw(view, width, onAnswer))).map((hint) => `${hint.key} ${hint.label}`);
        expect(bar).toContain("↑ ↓ scroll");
        expect(bar).toContain("tab switch side");
        expect(bar.find((hint) => hint.startsWith("o "))).toMatch(/^o open( in .+)?$/u);
      });
    }
  }

  it("scrolled to its end, the answer pane shows the last line and says what is above", () => {
    const view = health();
    const first = draw(view, 100, null);
    const end = { ...viewFocusAfterTurnDone([view], CAPS), answerFocus: true, engaged: true, answerScroll: 999 };
    const lines = plain(draw(view, 100, end).lines);
    const left = lines.map((line) => line.slice(0, paneWidths(100).left).trim());
    expect(left).toContain("Line 40 of the answer.");
    expect(left.some((line) => line === `↑ ${first.answerPane!.below + 1} above · ↑ PgUp` || /^↑ \d+ above · ↑ PgUp$/u.test(line))).toBe(true);
  });

  it("a turn with no view keys but a cut answer: tab puts the keys on the answer, ↓ scrolls it", () => {
    const drawn = renderLiveTurn({ messages: longAnswer, views: [], focus: null, width: 100, color: false, theme, rows: TURN_ROWS, steps });
    expect(drawn.answerPane).not.toBeNull();
    const facts = answerOnlyFacts({ above: 0, below: drawn.answerPane!.below, page: drawn.answerPane!.shown });
    const start = viewFocusAfterTurnDone([], CAPS);
    expect(viewKeyHints(start, facts).map((hint) => `${hint.key} ${hint.label}`)).toEqual(["tab switch side"]);
    const onAnswer = resolveViewKey("", start, { tab: true }, facts);
    expect(onAnswer.answerFocus).toBe(true);
    expect(resolveViewKey("", onAnswer, { downArrow: true }, facts).answerScroll).toBe(1);
  });

  it("while it runs, the answer still keeps its newest lines (no more line)", () => {
    const lines = plain(renderLiveTurn({ messages: longAnswer, views: [health()], focus: null, width: 100, color: false, theme, rows: TURN_ROWS, steps, running: true }).lines);
    const left = lines.slice(0, stepsHeaderAt(lines)).map((line) => line.slice(0, 28).trim()).filter(Boolean);
    expect(left.at(-1)).toBe("Line 40 of the answer.");
    expect(left.some((line) => /more ·/u.test(line))).toBe(false);
  });

  it("a facts check: the composite's focused facts carry its open place", () => {
    const view = meta();
    const drawn = draw(view, 100, null);
    expect(viewKeyFacts(view, drawn.focused!.render).open?.target).toEqual({ place: "ads.meta" });
  });
});
