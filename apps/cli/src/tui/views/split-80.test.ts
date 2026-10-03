import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import { getTurnState, resetTurnState } from "../app/turn-store.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { cardBox } from "./card.js";
import { isQuestionTurn, layoutTurn, paneWidths, renderCommittedTurn, renderLiveTurn, SPLIT_MIN_COLUMNS, turnMaySplit } from "./layout.js";
import { cutAtWord } from "./primitives.js";
import type { ViewRender } from "./types.js";

// The current turn sits side by side exactly where terminal-r4's `frame()`
// does: from 80 columns (`const wide=W>=80`), with r4's pane widths
// (`lw=max(26,min(40,floor(W*0.28)))`, `rw=W-lw-3`). When wide it always
// splits: a turn with nothing for the details pane shows r4's dim `steps only`
// there. Two protections r4 has no case for stay: an answer whose own table
// cannot draw whole in the answer pane keeps one column, and a turn committed
// to scrollback is one column. Synthetic data only.
const theme = INFINITE_R4_THEME;
const view = (over: Partial<ViewRender> = {}): ViewRender => ({
  head: " Rows  ✓ Ready", source: "Demo · up to Sep 30", detail: ["row one", "row two"], footnotes: [], keys: [], okKey: null, rowCount: 0, ...over
});
const messages: Msg[] = [
  { role: "user", text: "how is the week going?" },
  { role: "assistant", text: "Steady: the same pace as last week." }
];

/** r4 `frame()`'s pane widths. */
const r4Panes = (width: number) => {
  const left = Math.max(26, Math.min(40, Math.floor(width * 0.28)));
  return { wide: width >= 80, left, right: width - left - 3 };
};

describe("the split threshold is r4's: 80 columns", () => {
  it("is 80", () => {
    expect(SPLIT_MIN_COLUMNS).toBe(80);
  });

  it("79 is one column, 80 is side by side", () => {
    expect(paneWidths(79)).toEqual({ wide: false, left: 79, right: 79 });
    expect(layoutTurn(["∞ a"], view(), [], 79).some((line) => line.includes(" │ "))).toBe(false);
    expect(paneWidths(80).wide).toBe(true);
    expect(layoutTurn(["∞ a"], view(), [], 80).some((line) => line.includes(" │ "))).toBe(true);
  });

  it.each([80, 100, 120, 160])("at %i the panes are r4's widths", (width) => {
    expect(paneWidths(width)).toEqual(r4Panes(width));
  });

  it("at 80 the answer pane is 26 and the details pane 51; at 100, 28 and 69", () => {
    expect(paneWidths(80)).toEqual({ wide: true, left: 26, right: 51 });
    expect(paneWidths(100)).toEqual({ wide: true, left: 28, right: 69 });
  });

  it("a live turn with a view splits at 80 and stays one column at 79", () => {
    const at = (width: number) => renderLiveTurn({ messages, views: [], focus: null, width, color: false, theme, details: ["┌─ card ─┐"] }).lines;
    expect(at(80)[0]).toBe(`❯ how is the week going?${" ".repeat(2)} │ ┌─ card ─┐`);
    expect(at(79).some((line) => line.includes(" │ "))).toBe(false);
  });
});

describe("a turn with nothing for the details pane: r4's `steps only`", () => {
  const read = [{ id: "c1", name: "read_sample", label: "reading the sample", status: "ok" as const, startedAt: 0, endedAt: 400, result: "read" }];

  it.each([80, 100, 160])("at %i the answer is the left pane and the details pane says `steps only`, dim", (width) => {
    const { left } = r4Panes(width);
    const drawn = renderLiveTurn({ messages, views: [], focus: null, steps: read, width, color: true, theme });
    expect(r4Segments(drawn.lines[0]!).slice(-3)).toEqual(seg(["│", "line"], [" ", ""], ["steps only", "dim"]));
    const plain = renderLiveTurn({ messages, views: [], focus: null, steps: read, width, color: false, theme }).lines;
    expect(plain[0]).toBe(`❯ how is the week going?${" ".repeat(left - 24)} │ steps only`);
    // Every row of the body carries the separator, and no line is wider than the window.
    const body = drawn.lines.slice(0, drawn.lines.findIndex((line) => line.includes("Steps")));
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((line) => line.includes("│"))).toBe(true);
    // Nothing on the right to switch to: the key bar keeps `tab switch side` off.
    expect(drawn.details).toBe(false);
  });

  it("says nothing else: no scenario sentence, no source row", () => {
    const lines = renderLiveTurn({ messages, views: [], focus: null, steps: read, width: 100, color: false, theme }).lines;
    const body = lines.slice(0, lines.findIndex((line) => line.startsWith("─ Steps")));
    const right = body.map((line) => line.slice(31).trimEnd()).filter(Boolean);
    expect(right).toEqual(["steps only"]);
  });

  it.each([80, 100, 160])("at %i a finished turn with no Steps keeps the split, its details pane empty: no `steps only` pointing at nothing", (width) => {
    const { left } = r4Panes(width);
    const drawn = renderLiveTurn({ messages, views: [], focus: null, width, color: false, theme });
    expect(drawn.lines.join("\n")).not.toContain("steps only");
    expect(drawn.lines.some((line) => line.startsWith("─ Steps"))).toBe(false);
    // Still two columns: every row ends at the separator, the answer in the left pane.
    expect(drawn.lines[0]).toBe(`❯ how is the week going?${" ".repeat(left - 24)} │`);
    expect(drawn.lines.every((line) => line.endsWith(" │"))).toBe(true);
    expect(drawn.details).toBe(false);
  });

  it("a running turn with no Steps yet says `steps only` (its calls are on the way)", () => {
    resetTurnState();
    const working = getTurnState();
    const lines = renderLiveTurn({ messages: messages.slice(0, 1), views: [], focus: null, width: 80, color: false, theme, working, nowMs: 0 }).lines;
    expect(lines[0]!.slice(26)).toBe(" │ steps only");
  });

  it("the Steps strip stays under both panes, at the whole width", () => {
    const steps = [{ id: "c1", name: "read_sample", label: "reading the sample", status: "ok" as const, startedAt: 0, endedAt: 400, result: "read" }];
    const lines = renderLiveTurn({ messages, views: [], focus: null, steps, width: 80, color: false, theme }).lines;
    const at = lines.findIndex((line) => line.startsWith("─ Steps"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at]).toHaveLength(80);
    expect(lines.slice(0, at).every((line) => line.includes("│"))).toBe(true);
  });

  it("a turn of quiet calls only (no head) shows `steps only` too, its call lines in the Steps", () => {
    const quiet = { v: 1, kind: "quiet", tool: "read_playbook", title: "", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], body: { stepLine: "read the playbook" } } as const;
    const lines = renderLiveTurn({ messages, views: [quiet as never], focus: null, width: 100, color: false, theme }).lines;
    expect(lines[0]!.slice(28)).toBe(" │ steps only");
  });

  it("stays one column at 79", () => {
    const lines = renderLiveTurn({ messages, views: [], focus: null, width: 79, color: false, theme }).lines;
    expect(lines.some((line) => line.includes("│") || line.includes("steps only"))).toBe(false);
  });

  it("a turn with no answer lines (a kept Steps strip) draws no pane", () => {
    const steps = [{ id: "c1", name: "read_sample", label: "reading the sample", status: "ok" as const, startedAt: 0, endedAt: 400, result: "read" }];
    const lines = renderLiveTurn({ messages: [], views: [], focus: null, steps, width: 100, color: false, theme }).lines;
    expect(lines.some((line) => line.includes("│") || line.includes("steps only"))).toBe(false);
  });

  it("in scrollback it is one column, with no `steps only`", () => {
    const lines = renderCommittedTurn({ messages, views: [], focus: null, width: 160, color: false, theme });
    expect(lines).toEqual(["❯ how is the week going?", "", "∞ Steady: the same pace as last week."]);
  });
});

describe("a question stays a question turn when it stops or fails (it never jumps to one column)", () => {
  const partial: Msg[] = [
    { role: "user", text: "how is the week going?" },
    { role: "assistant", text: "Steady so far: the same", partial: true }
  ];
  const note = (text: string): Msg => ({ kind: "slash", role: "system", text, turnNote: true });

  it("a question is a question turn", () => {
    expect(isQuestionTurn(partial)).toBe(true);
  });

  it.each([
    ["its stop line", "■ Stopped. Anything already running in the app may still finish."],
    ["its error line", "error: the app did not answer"],
    ["a line queued behind it", "queued: \"and last week?\""]
  ])("with %s after it, it is still a question turn", (_name, text) => {
    expect(isQuestionTurn([...partial, note(text)])).toBe(true);
    // Stopped before any answer came: the question and the stop line.
    expect(isQuestionTurn([partial[0]!, note(text)])).toBe(true);
  });

  it("a stopped question draws side by side at 80 with the stop line in the answer pane", () => {
    const stopped = [...partial, note("■ Stopped. Anything already running in the app may still finish.")];
    const lines = renderLiveTurn({ messages: stopped, views: [], focus: null, width: 80, color: false, theme }).lines;
    expect(lines.every((line) => line.slice(26).startsWith(" │"))).toBe(true);
    expect(lines.join("\n")).toContain("■ Stopped.");
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("a command's output is not a question turn: a `/` line, or a typed command answered by command lines", () => {
    expect(isQuestionTurn([{ role: "user", text: "/help" }, { kind: "slash", role: "system", text: "Commands: /connect" }])).toBe(false);
    expect(isQuestionTurn([{ role: "user", text: "sync demo" }, { kind: "slash", role: "system", text: "Synced demo." }])).toBe(false);
    expect(isQuestionTurn([{ role: "user", text: "connect demo" }, { kind: "slash", role: "system", text: "Type confirm to continue." }])).toBe(false);
  });

  it("an intro or a panel is never a question turn", () => {
    expect(isQuestionTurn([{ kind: "intro", role: "system", text: "Welcome" }, ...partial])).toBe(false);
    expect(isQuestionTurn([...partial, { kind: "panel", role: "system", text: "Projects" }])).toBe(false);
  });
});

describe("an answer whose own table cannot draw whole in the answer pane keeps one column", () => {
  const table: Msg[] = [
    { role: "user", text: "the ads?" },
    { role: "assistant", text: "Two ran.\n\n| Ad | Spend | Clicks | Note |\n| --- | ---: | ---: | --- |\n| Spring sample | $12.00 | 30 | steady all week |\n| Autumn sample | $8.00 | 20 | new this week |" }
  ];

  it.each([80, 100, 120])("at %i: no split, no `steps only`, the table bordered at the whole width", (width) => {
    expect(turnMaySplit(table, width)).toBe(false);
    const lines = renderLiveTurn({ messages: table, views: [], focus: null, width, color: false, theme }).lines;
    expect(lines.some((line) => line.includes(" │ steps only") || line.includes("steps only"))).toBe(false);
    // The table is bordered and whole: every column's head on one row.
    expect(lines.some((line) => line.trimStart().startsWith("┌"))).toBe(true);
    expect(lines.some((line) => /│ Ad +│ +Spend │ Clicks │ Note +│/u.test(line))).toBe(true);
    expect(lines.every((line) => line.length <= width)).toBe(true);
  });

  it("with a card, the card follows under the answer at the whole width", () => {
    const lines = renderLiveTurn({ messages: table, views: [], focus: null, width: 100, color: false, theme, details: ["┌─ card ─┐"] }).lines;
    expect(lines).toContain("┌─ card ─┐");
  });

  it("a table small enough for the answer pane keeps the split", () => {
    const small: Msg[] = [{ role: "user", text: "two?" }, { role: "assistant", text: "| A | B |\n| --- | --- |\n| 1 | 2 |" }];
    expect(turnMaySplit(small, 80)).toBe(true);
  });
});

describe("a long name in a narrow details pane is cut at a word's end, with …", () => {
  it("cuts back to the last word when that keeps most of the room", () => {
    expect(cutAtWord("Hook B · founder POV", 18)).toBe("Hook B · founder …");
    expect(cutAtWord("Paused ad “Hook B · founder POV” · Agent proposed · You approved", 45)).toBe("Paused ad “Hook B · founder POV” · Agent …");
    // A separator left at the cut goes with it.
    expect(cutAtWord("Paused ad “Demo” · Agent proposed · You approved", 37)).toBe("Paused ad “Demo” · Agent proposed …");
  });

  it("keeps a name that fits, and cuts mid-word only when no word ends near", () => {
    expect(cutAtWord("Hook B", 18)).toBe("Hook B");
    expect(cutAtWord("Supercalifragilisticexpialidocious", 12)).toBe("Supercalifr…");
    expect(cutAtWord("ab Supercalifragilistic", 12)).toBe("ab Supercal…");
  });

  it("a card's title in its top border ends at a word, and the box still closes", () => {
    const [top] = cardBox("Paused ad “Hook B · founder POV” · Agent proposed · You approved", ["x"], 51, "amber", { color: false, theme });
    expect(top).toBe(`┌─ Paused ad “Hook B · founder POV” · Agent … ${"─".repeat(4)}┐`);
    expect(top).toHaveLength(51);
  });
});

describe("a record's history wraps in a narrow details pane instead of cutting its words", () => {
  it("at 80 the who and where follow on the next row, under the words", () => {
    const record = decodeAnswerView({
      v: 1, kind: "record", tool: "read_ad", title: "Ad · Sample", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
      body: { fields: [{ label: "status", value: { kind: "text", text: "on" } }],
        history: [{ at: "2026-09-24T09:12:00Z", from: null, to: "on", who: "Robin", source: "in the app" }] }
    });
    if (!record) throw new Error("record fixture does not decode");
    const lines = renderLiveTurn({ messages, views: [record], focus: null, width: 80, color: false, theme, timeZone: "UTC" }).lines
      .map((line) => line.slice(29).trimEnd());
    const at = lines.findIndex((line) => line.startsWith("Sep 24 09:12  created and turned on"));
    expect(at, lines.join("\n")).toBeGreaterThan(-1);
    expect(lines.slice(at, at + 2).join(" ").replace(/\s+/gu, " ")).toContain("created and turned on · by Robin (in the app)");
    expect(lines.some((line) => line.includes("…"))).toBe(false);
  });
});
