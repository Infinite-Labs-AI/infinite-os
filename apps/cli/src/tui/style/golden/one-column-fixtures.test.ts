// The one-column sample turns replay through the REAL session (`renderR4Screen`)
// and through the scrollback renderer (`renderCommittedTurn`) at three widths.
// These checks hold for any layout: every word the turn carries is on screen
// and no row is wider than the window. They do not pin today's two columns,
// so the one-column work can change the layout without editing them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../../desktop/answer-view-decode.js";
import type { TurnStep } from "../../app/turn-store.js";
import { displayWidth } from "../../lib/display-width.js";
import { resolveTheme } from "../../theme.js";
import { renderCommittedTurn } from "../../views/layout.js";
import { ENTRY_SESSION_PROPS } from "./feed-chrome.js";
import type { R4Turn } from "./fixtures.js";
import { loadOneColumnFixture, ONE_COLUMN_CLOCK, oneColumnFixtureIds } from "./one-column-fixtures.js";
import { recordedViews, renderR4Screen, turnMessages } from "./screen.js";

const WIDTHS = [60, 100, 160] as const;
const ids = oneColumnFixtureIds();

/** The screen as plain rows: SGR and OSC 8 links taken out. */
function plainRows(output: string): string[] {
  return output
    .replace(/\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-9;:?]*[A-Za-z]/gu, "")
    .split("\n");
}

/** Words as the screen may wrap them: compare with every run of spaces squeezed out. */
function squeeze(text: string): string {
  return text.replace(/\s+/gu, "");
}

/**
 * The screen's words in reading order, whatever the layout: a row with a pane
 * separator (` │ `, or a bare `│` ending an empty details row) is read as two
 * columns, the left pane's rows first, then the right pane's.
 */
function readingText(rows: readonly string[]): string {
  const left: string[] = [];
  const right: string[] = [];
  const whole: string[] = [];
  const flush = () => {
    whole.push(...left.splice(0), ...right.splice(0));
  };
  for (const row of rows) {
    const split = /^(.*?) │(?: (.*))?$/u.exec(row);
    if (split) {
      left.push(split[1]!);
      right.push(split[2] ?? "");
    } else {
      flush();
      whole.push(row);
    }
  }
  flush();
  return squeeze(whole.join("\n"));
}

/** The fixture's steps as the turn store holds them, on the turn's own clock. */
function turnSteps(turn: R4Turn): TurnStep[] {
  return turn.steps.map((step, index) => ({
    id: `sample_${index}`,
    name: `sample_step_${index}`,
    label: step.label,
    status: step.status,
    startedAt: ONE_COLUMN_CLOCK + step.start * 1000,
    endedAt: ONE_COLUMN_CLOCK + step.end * 1000,
    result: step.result
  }));
}

beforeAll(() => {
  vi.useFakeTimers({ now: ONE_COLUMN_CLOCK, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("one-column sample turns", () => {
  it("are the sample turns (four, and one that asks for two columns), and every view decodes", () => {
    expect(ids).toEqual(["01-plain-text", "02-ads-card", "03-funnel", "04-multi-step-job", "05-side-by-side"]);
    for (const id of ids) {
      for (const view of loadOneColumnFixture(id).turn?.views ?? []) {
        expect(decodeAnswerView(view), `${id}: ${view.kind}`).not.toBeNull();
      }
    }
  });

  for (const id of ids) {
    for (const cols of WIDTHS) {
      it(`${id} at ${cols} columns: the live session shows the question, the answer's start, each view and each step, within the width`, () => {
        const fixture = loadOneColumnFixture(id);
        const turn = fixture.turn!;
        const rows = plainRows(renderR4Screen(fixture, {
          cols, now: ONE_COLUMN_CLOCK, homeInventory: () => { throw new Error("no home inventory on a returning user's screen"); }, sessionProps: ENTRY_SESSION_PROPS
        }));
        const screen = readingText(rows);
        expect(rows.filter((row) => displayWidth(row) > cols)).toEqual([]);
        expect(screen).toContain(squeeze(turn.question));
        expect(screen).toContain(squeeze(turn.answer.split(".")[0]!));
        for (const view of recordedViews(turn)) {
          expect(screen, view.title).toContain(squeeze(view.title));
        }
        for (const step of turn.steps) {
          // A step label may be cut to the label column (with `…`) at narrow widths: its first word is always there.
          expect(screen, step.label).toContain(squeeze(step.label.split(" ")[0]!));
        }
      });

      it(`${id} at ${cols} columns: scrollback prints the whole turn in one column, failed calls kept`, () => {
        const turn = loadOneColumnFixture(id).turn!;
        const rows = plainRows(renderCommittedTurn({
          messages: turnMessages(turn),
          views: recordedViews(turn),
          focus: null,
          steps: turnSteps(turn),
          width: cols,
          color: false,
          theme: resolveTheme()
        }).join("\n"));
        // Read straight down, row after row: only one column keeps the question's words together.
        const text = squeeze(rows.join("\n"));
        expect(rows.filter((row) => displayWidth(row) > cols)).toEqual([]);
        expect(text).toContain(squeeze(turn.question));
        expect(text).toContain(squeeze(turn.answer.split(".")[0]!));
        for (const step of turn.steps.filter((item) => item.status === "fail")) {
          expect(text, step.label).toContain(squeeze(step.result));
        }
      });
    }
  }
});
