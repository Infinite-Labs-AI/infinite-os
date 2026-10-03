// Live re-check run 3, M5: after `n` the terminal kept the line the app put
// over the card ("Ready. It stops spending once you say OK.") above the
// dismissed card, where r4 flow-pause-09 (and Cmd+L after Dismiss) say
// "Okay, left it running.". Here the dismissed frame is built the way the
// session builds it when the app answers the no: the card of
// flow-pause-01 (Needs your OK), the decline's answer as /v1/confirm sends it
// (the receipt view plus the app's two lines), through `settleConfirmOutcome`
// and `messagesAfterDecline`. That frame must BE r4's dismissed golden at 60,
// 100 and 160 columns, and say the app's words at 140.
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

import type { InSessionConfirmationAction } from "../../../desktop/confirm-in-session.js";
import { homeInventoryData } from "../../../index.js";
import { DISMISSED_WORDS, messagesAfterDecline, settleConfirmOutcome } from "../../ink/confirm-card.js";
import { ansiToSegmentLines } from "./ansi-to-segments.js";
import { firstProblem, GoldenEvaluator } from "./evaluate.js";
import { ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import { loadR4Fixture, type R4ScreenFixture } from "./fixtures.js";
import { loadGolden } from "./goldens.js";
import { textOf } from "./normalize.js";
import { renderR4Screen, turnMessages } from "./screen.js";

const FIXED_CLOCK = Date.parse("2026-10-01T10:44:00Z");
const ASKED_SCREEN = "flow-pause-01-needs-your-ok";
const DISMISSED_SCREEN = "flow-pause-09-dismissed";
const LEFT_RUNNING = "Okay, left it running.";

/** The card the user said no to, as the session holds it (screen.ts draws a waiting card the same way). */
function askedCard(): { head: InSessionConfirmationAction; answer: string; question: string } {
  const turn = loadR4Fixture(ASKED_SCREEN).turn!;
  const view = turn.views[turn.pending!]!;
  const approval = view.approval!;
  if (approval.kind !== "card") throw new Error("flow-pause-01 waits on a card");
  return {
    head: {
      turnId: approval.turnId ?? "turn_r4",
      confirmationHandle: approval.handle ?? "h_r4_0",
      summary: approval.title,
      confirmationDetails: approval.rows,
      confirmFieldsCapable: true,
      view
    },
    answer: turn.answer,
    question: turn.question
  };
}

/** What /v1/confirm answers to that `n`: the card's envelope settled as dismissed, and the app's two lines. */
function declineAnswer(head: InSessionConfirmationAction, answer: string) {
  const { approval: _question, ...envelope } = head.view!;
  void _question;
  return {
    ok: true,
    declined: true,
    askedCaption: answer,
    dismissedCaption: LEFT_RUNNING,
    view: { ...envelope, state: "cancelled", receipt: { sentence: DISMISSED_WORDS, tone: "ok", revertible: false } } as AnswerViewV1
  };
}

/** flow-pause-09's chrome and Steps, with the answer and the view the decline path leaves. */
function dismissedThroughTheLivePath(screen: R4ScreenFixture): R4ScreenFixture {
  const { head, answer, question } = askedCard();
  const outcome = declineAnswer(head, answer);
  const step = settleConfirmOutcome(head, outcome, { decision: "decline", dismissed: true, onCardTurn: true, thrown: false });
  if (step.type !== "receipt") throw new Error(`the decline left ${step.type}, not its receipt`);
  const messages = messagesAfterDecline(turnMessages({ question, answer, views: [], steps: [] }), outcome);
  const said = messages.filter((message) => message.role === "assistant").map((message) => message.text).join("\n");
  return { ...screen, turn: { ...screen.turn!, question, answer: said, views: [step.frame.view] } };
}

const draw = (fixture: R4ScreenFixture, cols: number) => renderR4Screen(dismissedThroughTheLivePath(fixture), {
  cols, now: FIXED_CLOCK, homeInventory: homeInventoryData, sessionProps: ENTRY_SESSION_PROPS
});
const evaluator = new GoldenEvaluator(draw);

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

describe("after n, the line over the dismissed card is the app's words after a no (run-3 M5)", () => {
  it("the card's turn starts on the app's pre-OK line (the state M5 left on screen)", () => {
    expect(askedCard().answer).toBe("Ready. It stops spending once you say OK.");
  });

  for (const cols of [60, 100, 160]) {
    it(`matches r4 ${DISMISSED_SCREEN} at ${cols} columns`, () => {
      const evaluation = evaluator.evaluate(loadGolden(`${DISMISSED_SCREEN}--c${cols}`));
      expect(evaluation.pass, firstProblem(evaluation)).toBe(true);
    });
  }

  for (const cols of [60, 100, 140]) {
    it(`at ${cols} columns the line reads "${LEFT_RUNNING}" in the same frame as the dismissed card`, () => {
      const lines = ansiToSegmentLines(draw(loadR4Fixture(DISMISSED_SCREEN), cols)).map((line) => textOf(line).trimEnd());
      // From 120 columns the card sits right of the answer (`│`), on the same rows.
      const caption = lines.findIndex((line) => line.split("│")[0]!.trimEnd() === `∞ ${LEFT_RUNNING}`);
      const card = lines.findIndex((line) => line.includes(`✕ ${DISMISSED_WORDS}`));
      expect(caption, lines.join("\n")).toBeGreaterThan(-1);
      expect(card, lines.join("\n")).toBeGreaterThan(-1);
      expect(lines.some((line) => line.includes("│")), `${cols} columns is drawn ${cols >= 120 ? "side by side" : "in one column"}`)
        .toBe(cols >= 120);
      expect(lines.join("\n")).not.toContain("once you say OK");
    });
  }
});
