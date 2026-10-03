// The caption gate (round 4, the same rule in both renderers): an answer
// that comes with a view shows at most 2 sentences above it; the rest is
// folded, never dropped, rewritten or summarised. These are the shared test
// vectors V1-V7 (synthetic), pinned exactly, and the proposed V8 (a table or a
// fenced block is one sentence); the other renderer pins the same.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/display-width.js";
import { DEFAULT_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { captionGate, gateAnswerMessages, sentenceEnds } from "./caption-gate.js";
import { paneWidths, renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { paint } from "./primitives.js";

const V1 = "Spend is up 12% this week. I would not scale this yet: trials are not confirmed. Today is still open, so treat it separately.";
const V2 = "It spent $12.34 at a 1.5x lift. The test is not a winner yet.";
const V3 = "Clicks rose, e.g. on Sep 29–30 vs. the prior week. Next: keep it running. Check again Oct 9.";
const V4 = "Here is a draft:\n\nSubject: Quick check-in\nHi Ada,\nJust checking in. Is anything unclear?\nBest,\nSam";
const V5 = "- One\n- Two\n- Three";
const V7 = "Opened example.com/a.b and read v1.2. Done.";

describe("the caption gate's shared vectors (V1-V7)", () => {
  it("V1: three sentences show 2 and fold 1", () => {
    expect(captionGate(V1)).toEqual({
      shown: "Spend is up 12% this week. I would not scale this yet: trials are not confirmed.",
      rest: "Today is still open, so treat it separately."
    });
  });

  it("V2: money and a decimal are no break: 2 sentences, no fold", () => {
    expect(sentenceEnds(V2)).toHaveLength(2);
    expect(captionGate(V2)).toEqual({ shown: V2, rest: null });
  });

  it("V3: e.g., vs. and a range are no break: shows 2, folds 1", () => {
    expect(captionGate(V3)).toEqual({
      shown: "Clicks rose, e.g. on Sep 29–30 vs. the prior week. Next: keep it running.",
      rest: "Check again Oct 9."
    });
  });

  it("V4: a line break before a non-empty line ends one: the draft's first two lines show, the rest folds", () => {
    expect(captionGate(V4)).toEqual({
      shown: "Here is a draft:\n\nSubject: Quick check-in",
      rest: "Hi Ada,\nJust checking in. Is anything unclear?\nBest,\nSam"
    });
  });

  it("V5: every list item is one: shows 2 items, folds 1", () => {
    expect(captionGate(V5)).toEqual({ shown: "- One\n- Two", rest: "- Three" });
  });

  it("V7: dots inside a file name, a host and a version are no break: 2, no fold", () => {
    expect(sentenceEnds(V7)).toHaveLength(2);
    expect(captionGate(V7)).toEqual({ shown: V7, rest: null });
  });

  it("nothing is dropped: shown + rest hold every word of the text, in order", () => {
    for (const text of [V1, V2, V3, V4, V5, V7]) {
      const { shown, rest } = captionGate(text);
      expect(`${shown} ${rest ?? ""}`.split(/\s+/u).filter(Boolean)).toEqual(text.split(/\s+/u).filter(Boolean));
      expect(text.startsWith(shown)).toBe(true);
    }
  });

  it("more cases that are no break: etc., a.m., p.m., i.e. and an initial", () => {
    expect(sentenceEnds("It ran at 9 a.m. Monday and 5 p.m. Tuesday, i.e. twice, with Ada B. Sample etc. Then it stopped.")).toHaveLength(1);
  });

  it("a markdown table is one, never cut between its rows", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    expect(captionGate(`${table}\nFirst note. Second note.`)).toEqual({ shown: `${table}\nFirst note.`, rest: "Second note." });
    expect(captionGate(table)).toEqual({ shown: table, rest: null });
  });

  // V8 (proposed shared vector, S4): a table and a fenced block each count as ONE sentence.
  // The Cmd+L renderer pins the same text and the same split, so both renderers fold alike.
  const V8 = "Here are the rows:\n\n| Ad | Spend |\n| --- | --- |\n| Sample A | $10 |\n| Sample B | $20 |\n\nSample B spent more. Check again tomorrow.";
  const V8_FENCE = "Run this:\n\n```\nstep one. step two.\nstep three.\n```\n\nIt only reads. Nothing changes.";

  it("V8: a table is one sentence: the intro and the whole table show, the rest folds", () => {
    expect(captionGate(V8)).toEqual({
      shown: "Here are the rows:\n\n| Ad | Spend |\n| --- | --- |\n| Sample A | $10 |\n| Sample B | $20 |",
      rest: "Sample B spent more. Check again tomorrow."
    });
  });

  it("V8 (fence): a fenced block is one sentence, its inner full stops are no break", () => {
    expect(captionGate(V8_FENCE)).toEqual({
      shown: "Run this:\n\n```\nstep one. step two.\nstep three.\n```",
      rest: "It only reads. Nothing changes."
    });
  });

  it("a sentence closed inside markdown ends at its closing marker", () => {
    expect(captionGate("**Spend is up.** Trials are flat. Today is open.")).toEqual({
      shown: "**Spend is up.** Trials are flat.",
      rest: "Today is open."
    });
  });
});

describe("the gate over a turn's messages", () => {
  const turn = (text: string): Msg[] => [{ role: "user", text: "how is it going?" }, { role: "assistant", text }];

  it("V1 in a turn: the answer keeps 2 sentences; the question is never counted", () => {
    const gated = gateAnswerMessages(turn(V1));
    expect(gated.messages[0]).toEqual({ role: "user", text: "how is it going?" });
    expect(gated.messages[1]!.text).toBe("Spend is up 12% this week. I would not scale this yet: trials are not confirmed.");
    expect(gated.rest).toBe("Today is still open, so treat it separately.");
  });

  it("sentences count across the turn's answers: a later answer folds whole", () => {
    const gated = gateAnswerMessages([
      { role: "user", text: "q" },
      { role: "assistant", text: "One. Two." },
      { role: "assistant", text: "Three. Four." }
    ]);
    expect(gated.messages.map((msg) => msg.text)).toEqual(["q", "One. Two.", ""]);
    expect(gated.rest).toBe("Three. Four.");
  });

  it("V2 in a turn: nothing to fold", () => {
    const gated = gateAnswerMessages(turn(V2));
    expect(gated.rest).toBeNull();
    expect(gated.messages[1]!.text).toBe(V2);
  });
});

// The gate as the terminal draws it: two sentences above the view, then a dim
// `… more (?)` line (the left pane when split, above the view in one column);
// `?` opens the rest in the live turn; scrollback prints the rest under the view.
describe("the caption gate in the terminal's turn", () => {
  const numbers = (): AnswerViewV1 => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./__fixtures__/meta-level-campaigns.json", import.meta.url)), "utf8"));
    const view = decodeAnswerView(raw);
    if (!view) throw new Error("fixture does not decode");
    return view;
  };
  const v1Turn: Msg[] = [{ role: "user", text: "how is spend?" }, { role: "assistant", text: V1 }];
  const FOLDED = "Today is still open, so treat it separately.";
  // The answer's words: the left pane's when split (from 80), else every row's.
  const words = (lines: readonly string[], width = 79) => {
    const panes = paneWidths(width);
    return lines.map(stripAnsi).map((line) => (panes.wide ? line.slice(0, panes.left) : line)).join(" ").replace(/\s+/gu, " ");
  };
  const dim = (line: string) => paint(stripAnsi(line), "dim", { color: true, theme: DEFAULT_THEME });

  for (const width of [79, 100, 140]) {
    it(`at ${width}: two sentences and a dim \`… more (?)\` above the view; ? opens the rest`, () => {
      const closed = renderLiveTurn({ messages: v1Turn, views: [numbers()], focus: null, width, color: true, theme: DEFAULT_THEME, rows: 40 });
      expect(closed.folded).toBe(true);
      const text = words(closed.lines, width);
      expect(text).toContain("Spend is up 12% this week. I would not scale this yet: trials are not confirmed.");
      expect(text).not.toContain(FOLDED);
      const foldRow = closed.lines.find((line) => stripAnsi(line).includes("… more (?)"))!;
      expect(foldRow).toBeDefined();
      expect(foldRow).toContain(dim("  … more (?)"));
      const open = renderLiveTurn({ messages: v1Turn, views: [numbers()], focus: null, width, color: false, theme: DEFAULT_THEME, rows: 40, captionOpen: true });
      expect(open.folded).toBe(false);
      expect(words(open.lines, width)).toContain(FOLDED);
      expect(open.lines.some((line) => line.includes("… more (?)"))).toBe(false);
    });
  }

  it("committed to scrollback: two sentences above the view, the folded rest under it, dim, every word kept", () => {
    const lines = renderCommittedTurn({ messages: v1Turn, views: [numbers()], focus: null, width: 100, color: true, theme: DEFAULT_THEME });
    const plainLines = lines.map(stripAnsi);
    const head = plainLines.findIndex((line) => line.includes("Ads by campaign"));
    const rest = plainLines.findIndex((line) => line.includes("Today is still open"));
    expect(head).toBeGreaterThan(0);
    expect(rest).toBeGreaterThan(head);
    expect(plainLines.slice(0, head).join(" ")).toContain("trials are not confirmed.");
    expect(lines[rest]).toBe(dim(lines[rest]!));
    expect(plainLines.some((line) => line.includes("… more (?)"))).toBe(false);
    expect(words(lines).split(FOLDED).length - 1).toBe(1);
  });

  it("V6: the same text in a turn with no view is never touched, and has no fold line", () => {
    for (const width of [79, 100]) {
      const drawn = renderLiveTurn({ messages: v1Turn, views: [], focus: null, width, color: false, theme: DEFAULT_THEME, rows: 40 });
      expect(drawn.folded).toBe(false);
      expect(words(drawn.lines, width)).toContain(FOLDED);
      expect(drawn.lines.some((line) => line.includes("more (?)"))).toBe(false);
    }
    const committed = renderCommittedTurn({ messages: v1Turn, views: [], focus: null, width: 100, color: false, theme: DEFAULT_THEME });
    expect(words(committed)).toContain(V1);
  });
});
