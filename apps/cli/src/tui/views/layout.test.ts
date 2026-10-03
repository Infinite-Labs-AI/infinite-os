import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import type { TurnStep } from "../app/turn-store.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { viewFocusAfterTurnDone } from "./focus.js";
import { answerCarriesTable, detailsPaneWidth, layoutTurn, renderCommittedTurn, renderLiveTurn, turnMaySplit } from "./layout.js";
import type { ViewRender } from "./types.js";

// The r4 frame body (terminal-r4 `frame()`): side by side from 80 columns, as
// r4 draws it, one column below. Synthetic data only.
const theme = INFINITE_R4_THEME;
const view = (over: Partial<ViewRender> = {}): ViewRender => ({
  head: " Ads running  ✓ Ready", source: "Demo · up to Sep 30", detail: ["row one", "row two"], footnotes: [], keys: [], okKey: null, rowCount: 0, ...over
});
const messages: Msg[] = [
  { role: "user", text: "which ads are on?" },
  { role: "assistant", text: "Two are on, and both are spending at their usual pace this week." }
];

describe("the frame body", () => {
  it("one column below 80: answer, a blank, a line rule, the details, a blank, then the Steps", () => {
    const lines = layoutTurn(["❯ q", "", "∞ a"], view(), ["  step"], 79);
    expect(lines).toEqual(["❯ q", "", "∞ a", "", "─".repeat(79), " Ads running  ✓ Ready", "Demo · up to Sep 30", "", "row one", "row two", "", `─ Steps ${"─".repeat(71)}`, "  step"]);
  });

  it("side by side from 120: the answer pane padded to 33, the separator in line, an empty details row ends at the bar", () => {
    const lines = layoutTurn(["❯ q", "", "∞ a", "  more", "  and more", "  last"], view(), [], 120, { color: true, theme });
    expect(r4Segments(lines[0]!)).toEqual(seg([`❯ q${" ".repeat(31)}`, ""], ["│", "line"], ["  Ads running  ✓ Ready", ""]));
    expect(r4Segments(lines[2]!)).toEqual(seg([`∞ a${" ".repeat(31)}`, ""], ["│", "line"]));
    expect(r4Segments(lines[5]!)).toEqual(seg([`  last${" ".repeat(28)}`, ""], ["│", "line"]));
  });

  it("wraps the answer pane at its width less one (r4 `wrap(…, lw − 1)`)", () => {
    const lines = renderLiveTurn({ messages, views: [], focus: null, width: 160, color: false, theme, details: ["┌─ card ─┐"] }).lines;
    const left = lines.map((line) => line.slice(0, 40).trimEnd());
    expect(left[0]).toBe("❯ which ads are on?");
    expect(left[2]).toBe("∞ Two are on, and both are spending at");
    expect(left.every((line) => line.length <= 39)).toBe(true);
  });
});

// A finished turn that misses the live region by a row or two is drawn without
// its blank rows around the details, so it stays live (its Steps and its keys
// with it) where it would otherwise go to scrollback. The session asks for it.
describe("the compact frame body (a finished turn that just misses the window)", () => {
  it("one column: no blank over the rule, under the details' head or over the Steps; nothing else changes", () => {
    const lines = layoutTurn(["❯ q", "", "∞ a"], view(), ["  step"], 79, null, { compact: true });
    expect(lines).toEqual(["❯ q", "", "∞ a", "─".repeat(79), " Ads running  ✓ Ready", "Demo · up to Sep 30", "row one", "row two", `─ Steps ${"─".repeat(71)}`, "  step"]);
    // Three rows fewer than the r4 frame body.
    expect(layoutTurn(["❯ q", "", "∞ a"], view(), ["  step"], 79)).toHaveLength(lines.length + 3);
  });

  it("side by side: only the blank under the details' head goes", () => {
    const wide = layoutTurn(["❯ q", "", "∞ a"], view(), [], 120, null, { compact: true });
    expect(wide.map((line) => line.slice(33).trimEnd())).toEqual([" │  Ads running  ✓ Ready", " │ Demo · up to Sep 30", " │ row one", " │ row two"]);
  });

  it("renderLiveTurn draws it on request, with the same views, keys and Steps", () => {
    const steps: TurnStep[] = [{ id: "c1", name: "list_sample_rows", label: "listing sample rows", status: "ok", startedAt: 0, endedAt: 500, result: "2 rows" }];
    const input = { messages, views: [], focus: null, steps, width: 79, color: false, theme, details: ["┌─ card ─┐", "└────────┘"] };
    const roomy = renderLiveTurn(input);
    const tight = renderLiveTurn({ ...input, compact: true });
    expect(tight.lines.filter((line) => line.trim())).toEqual(roomy.lines.filter((line) => line.trim()));
    expect(roomy.lines.length - tight.lines.length).toBe(2);
    expect(tight.details).toBe(true);
    // The blank between the question and the answer is the answer column's own: it stays.
    expect(tight.lines.slice(0, 3)).toEqual(["❯ which ads are on?", "", "∞ Two are on, and both are spending at their usual pace this week."]);
  });
});

describe("what takes the details pane", () => {
  it("a pending card handed in sits right of the answer from 80, under it below", () => {
    const card = ["┌─ Pause ad? ─┐", "│ status      │", "└─────────────┘"];
    expect(detailsPaneWidth(160)).toBe(117);
    expect(detailsPaneWidth(100)).toBe(69);
    expect(detailsPaneWidth(79)).toBe(79);
    const wide = renderLiveTurn({ messages, views: [], focus: null, width: 160, color: false, theme, details: card }).lines;
    expect(wide[0]).toBe(`❯ which ads are on?${" ".repeat(21)} │ ┌─ Pause ad? ─┐`);
    const narrow = renderLiveTurn({ messages, views: [], focus: null, width: 79, color: false, theme, details: card }).lines;
    expect(narrow.slice(-3)).toEqual(card);
    expect(narrow.some((line) => line.includes(" │ "))).toBe(false);
  });

  it("a quiet view with a head (r4 `steps only`) is a details pane; without one it prints with the Steps", () => {
    const headed = view({ head: "steps only", source: "", detail: ["The draft is in the answer."], quiet: true });
    const wide = layoutTurn(["∞ a"], headed, [], 120);
    expect(wide.slice(0, 4).map((line) => line.slice(33))).toEqual([" │ steps only", " │", " │", " │ The draft is in the answer."]);
    const bare = layoutTurn(["∞ a"], view({ head: "", source: null, detail: ["read the playbook"], quiet: true }), [], 120);
    expect(bare).toEqual(["∞ a", `─ Steps ${"─".repeat(112)}`, "  read the playbook"]);
  });
});

describe("a committed turn in scrollback is the question and the answer (D1, run-2 M3)", () => {
  const steps: Msg[] = [
    { role: "user", text: "site traffic" },
    { kind: "trail", role: "system", text: "", tools: ["checking GA4 (0.4s) :: 3 pages ✓"] },
    { role: "assistant", text: "Up 12% on the week." }
  ];

  it("keeps no Steps strip, live or quiet, at any width", () => {
    for (const width of [60, 100, 160]) {
      const lines = renderCommittedTurn({ messages: steps, views: [], focus: null, width, color: false, theme });
      expect(lines.some((line) => line.includes("Steps"))).toBe(false);
      expect(lines.some((line) => line.includes("checking GA4"))).toBe(false);
      expect(lines).toEqual(["❯ site traffic", "", "∞ Up 12% on the week."]);
    }
  });

  it("keeps its details, one column, under the answer", () => {
    const listing = decodeAnswerView({
      v: 1, kind: "quiet", tool: "read_playbook", title: "", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], body: { stepLine: "read the playbook" }
    });
    const lines = renderCommittedTurn({ messages: steps, views: listing ? [listing] : [], focus: null, width: 160, color: false, theme });
    expect(lines.some((line) => line.includes("Steps"))).toBe(false);
    expect(lines.some((line) => line.includes(" │ "))).toBe(false);
  });

  it("the live turn keeps its Steps strip", () => {
    const lines = renderLiveTurn({ messages: steps, views: [], focus: null, width: 100, color: false, theme }).lines;
    expect(lines.some((line) => line.startsWith("─ Steps"))).toBe(true);
  });
});

describe("a committed turn keeps the calls that did not end clean (a failed step never disappears)", () => {
  const turn: Msg[] = [{ role: "user", text: "site traffic" }, { role: "assistant", text: "Up 12% on the week." }];
  const steps: TurnStep[] = [
    { id: "c1", name: "mcp__sample_app__get_sample_rows", label: "reading the last 200 days", status: "ok", startedAt: 0, endedAt: 300, result: "200 days" },
    { id: "c2", name: "mcp__sample_app__get_sample_rows", label: "reading today", status: "fail", startedAt: 340, endedAt: 640, result: "not synced yet" }
  ];

  it("the failed call's row follows the answer, a blank row apart; the clean call and the Steps header are gone", () => {
    for (const width of [60, 100, 160]) {
      const lines = renderCommittedTurn({ messages: turn, views: [], focus: null, steps, width, color: false, theme });
      expect(lines).toEqual(["❯ site traffic", "", "∞ Up 12% on the week.", "", "  reading today ✗ not synced yet"]);
    }
  });

  it("the row follows the details when the turn has a view", () => {
    const listing = decodeAnswerView({
      v: 1, kind: "quiet", tool: "read_playbook", title: "Playbook", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], body: { stepLine: "read the playbook" }
    });
    const lines = renderCommittedTurn({ messages: turn, views: listing ? [listing] : [], focus: null, steps, width: 100, color: false, theme });
    expect(lines.slice(-2)).toEqual(["", "  reading today ✗ not synced yet"]);
    expect(lines.some((line) => line.includes("Steps"))).toBe(false);
    expect(lines.some((line) => line.includes("reading the last 200 days"))).toBe(false);
  });

  it("reads the calls from the tool trail when the turn store has none", () => {
    const trail: Msg[] = [
      turn[0]!,
      { kind: "trail", role: "system", text: "", tools: ["checking GA4 (0.4s) :: 3 pages ✓", "Pause Entity(\"Demo B\") (1.0s) :: refused ✗"] },
      turn[1]!
    ];
    const lines = renderCommittedTurn({ messages: trail, views: [], focus: null, width: 100, color: false, theme });
    expect(lines).toEqual(["❯ site traffic", "", "∞ Up 12% on the week.", "", "  pausing entity ✗ refused"]);
  });

  it("prints none while the calls stay live with a waiting card (they print when that turn is committed)", () => {
    const lines = renderCommittedTurn({ messages: turn, views: [], focus: null, steps, width: 100, color: false, theme, stepsStayLive: true });
    expect(lines).toEqual(["❯ site traffic", "", "∞ Up 12% on the week."]);
  });

  it("the live turn still draws every call in its Steps strip", () => {
    const lines = renderLiveTurn({ messages: turn, views: [], focus: null, steps, width: 100, color: false, theme, details: ["card"] }).lines;
    expect(lines.some((line) => /reading the last 200 days\s+━+\s+✓ 200 days/u.test(line))).toBe(true);
    expect(lines.some((line) => /reading today\s+━+\s+✗ not synced yet/u.test(line))).toBe(true);
  });
});

describe("a committed turn keeps every message the transcript draws (one renderer for both)", () => {
  const turn: Msg[] = [
    { role: "user", text: "fix the import" },
    { kind: "trail", role: "system", text: "", todos: [{ id: "t1", content: "Check the import path", status: "in_progress" }] },
    { role: "assistant", title: "Infinite — Acme", text: "Changed one line." },
    { kind: "diff", role: "tool", text: "--- a/x.ts\n+++ b/x.ts\n-old line\n+new line" }
  ];

  it("keeps the project label, the diff's colours and the trail's todos", () => {
    const lines = renderCommittedTurn({ messages: turn, views: [], focus: null, width: 80, color: true, theme });
    const segments = lines.map((line) => r4Segments(line));
    const has = (text: string, style: string) => segments.some((row) => row.some((part) => part.text.includes(text) && part.style === style));
    expect(has("Infinite — Acme", "dim")).toBe(true);
    expect(has("- old line", "red")).toBe(true);
    expect(has("+ new line", "green")).toBe(true);
    expect(lines.some((line) => line.includes("Check the import path"))).toBe(true);
  });

  it("draws the same answer column live", () => {
    // From 80 columns the answer is the left pane, `steps only` right of it.
    const lines = renderLiveTurn({ messages: turn, views: [], focus: null, width: 80, color: false, theme }).lines
      .map((line) => line.split(" │")[0]!.trimEnd());
    expect(lines).toContain("Δ diff");
    expect(lines.some((line) => line.includes("Check the import path"))).toBe(true);
    expect(lines.some((line) => line.includes("Infinite — Acme"))).toBe(true);
  });
});

describe("an answer table that drops columns says so in one wording, live or in scrollback", () => {
  const rows = (note: string) => [
    "| Campaign | Spend | Clicks | Note | CTR |",
    "| --- | ---: | ---: | --- | ---: |",
    `| Spring | $1,200 | 3,400 | ${note} | 2.1% |`,
    "| Autumn | $800 | 1,900 | Steady | 1.4% |"
  ].join("\n");
  const turn = (note: string): Msg[] => [{ role: "user", text: "how are they doing?" }, { role: "assistant", text: rows(note) }];
  const wide = turn("Ran longer");
  // A Note so long the table needs more than 119 columns.
  const wider = turn("Ran longer than planned this week because the budget was raised twice and then once more");
  const fits = turn("Ran longer than planned this week because the budget was raised twice");
  const card = ["┌─ card ─┐"];
  const hint = /^ {2}\+ .+ hidden · needs \d+ more cols?$/u;

  it.each([160, 200])("at %i a turn with a card and a table answer is one column, so every column shows and there is no hint", (width) => {
    const lines = renderLiveTurn({ messages: wide, views: [], focus: null, width, color: false, theme, details: card }).lines;
    expect(lines.some((line) => /hidden|widen|needs/u.test(line))).toBe(false);
    expect(lines.some((line) => /│ Campaign │\s+Spend │\s+Clicks │ Note\s+│\s+CTR │/u.test(line))).toBe(true);
  });

  it("the live turn, with or without details, and the committed turn print the same line for the same table", () => {
    const withCard = renderLiveTurn({ messages: fits, views: [], focus: null, width: 100, color: false, theme, details: card }).lines;
    const alone = renderLiveTurn({ messages: fits, views: [], focus: null, width: 100, color: false, theme }).lines;
    const committed = renderCommittedTurn({ messages: fits, views: [], focus: null, width: 100, color: false, theme });
    for (const lines of [withCard, alone, committed]) {
      expect(lines).toContain("  + CTR, Note hidden · needs 12 more cols");
      expect(lines.filter((line) => hint.test(line))).toHaveLength(1);
      expect(lines.some((line) => /widen|to see/u.test(line))).toBe(false);
    }
    // A table that needs even more says how many, in the same words.
    const far = renderLiveTurn({ messages: wider, views: [], focus: null, width: 100, color: false, theme, details: card }).lines;
    expect(far.filter((line) => hint.test(line))).toHaveLength(1);
  });
});

describe("an answer with a table of its own takes the whole width (the split is for a view or a card)", () => {
  // Six columns, as a model writes them: about 100 columns wide as a bordered table.
  const table = [
    "| Ad | Spend | Purchases | ROAS | CPA | Note |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    "| Spring demo, hook 3 | $1,284.50 | 42 | 3.41 | $30.58 | Strongest hook; watch for fatigue next week |",
    "| Founder story, 30s | $612.00 | 1 | 0.29 | $612.00 | One purchase so far: the pause candidate |",
    "| Demo item carousel | $123.45 | 19 | 2.12 | $12.34 | Steady |"
  ].join("\n");
  const withTable: Msg[] = [
    { role: "user", text: "how did the ads do?" },
    { role: "assistant", text: `Spend is up on the week.\n\n${table}\n\nTwo ads carry most of it.` }
  ];
  const prose: Msg[] = [{ role: "user", text: "how did the ads do?" }, { role: "assistant", text: "Spend is up on the week. Two ads carry most of it." }];
  const card = ["┌─ Pause ad? ─┐", "│ status      │", "└─────────────┘"];
  const header = /│ Ad\s+│\s+Spend │\s+Purchases │\s+ROAS │\s+CPA │ Note\s+│/u;

  it.each([120, 140, 159])("at %i the table stays a bordered table with every column, and the card follows under the answer", (width) => {
    const lines = renderLiveTurn({ messages: withTable, views: [], focus: null, width, color: false, theme, details: card }).lines;
    // One column: no pane separator beside the answer, the card under a rule.
    expect(lines[0]).toBe("❯ how did the ads do?");
    expect(lines.some((line) => line.includes(" │ ┌─ Pause ad? ─┐"))).toBe(false);
    const rule = lines.indexOf("─".repeat(width));
    expect(rule).toBeGreaterThan(0);
    expect(lines.slice(rule + 1, rule + 4)).toEqual(card);
    // A bordered table, all six columns on one header row; never `label: value` stacks, nothing dropped.
    expect(lines.some((line) => header.test(line))).toBe(true);
    expect(lines.filter((line) => /^ {2}┌[─┬]+┐$/u.test(line))).toHaveLength(1);
    expect(lines.some((line) => /^\s*(Ad|Spend|Purchases|ROAS|CPA|Note): /u.test(line))).toBe(false);
    expect(lines.some((line) => /^\s*\+ .*(hidden|widen|needs)/u.test(line))).toBe(false);
    expect(lines.every((line) => line.length <= width)).toBe(true);
  });

  it.each([120, 140, 159])("at %i an answer with no table still sits left of its card", (width) => {
    const lines = renderLiveTurn({ messages: prose, views: [], focus: null, width, color: false, theme, details: card }).lines;
    expect(lines[0]).toMatch(/^❯ how did the ads do\? + │ ┌─ Pause ad\? ─┐$/u);
    expect(lines.includes("─".repeat(width))).toBe(false);
  });

  it.each([120, 140, 159])("at %i a table answer with nothing for the right pane is the whole width too", (width) => {
    const lines = renderLiveTurn({ messages: withTable, views: [], focus: null, width, color: false, theme }).lines;
    expect(lines.some((line) => header.test(line))).toBe(true);
    expect(lines.some((line) => line.includes(" │ ") && !line.trimStart().startsWith("│"))).toBe(false);
  });

  it("a view takes the whole width under a table answer, at the width a one-column turn gives it", () => {
    const body = { sections: [{ text: "The draft.", format: "plain" }] };
    const doc = decodeAnswerView({
      v: 1, kind: "document", tool: "read_draft", title: "Win-back sequence", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], body
    });
    if (!doc) throw new Error("document fixture does not decode");
    const lines = renderLiveTurn({ messages: withTable, views: [doc], focus: null, width: 140, color: false, theme }).lines;
    const rule = lines.indexOf("─".repeat(140));
    expect(lines.some((line) => header.test(line))).toBe(true);
    expect(lines.findIndex((line) => line.includes("Win-back sequence"))).toBeGreaterThan(rule);
    expect(turnMaySplit(withTable, 140)).toBe(false);
    expect(detailsPaneWidth(140, turnMaySplit(withTable, 140))).toBe(140);
    expect(turnMaySplit(prose, 140)).toBe(true);
    expect(turnMaySplit(prose, 80)).toBe(true);
    expect(turnMaySplit(prose, 79)).toBe(false);
  });

  it("only the answer's own markdown counts: the question, a tool's output and a diff never do; a table still arriving does", () => {
    const user: Msg[] = [{ role: "user", text: table }, { role: "assistant", text: "Noted." }];
    const tool: Msg[] = [{ role: "user", text: "q" }, { role: "tool", text: table }, { role: "system", kind: "diff", text: table }];
    expect(answerCarriesTable(user)).toBe(false);
    expect(answerCarriesTable(tool)).toBe(false);
    expect(answerCarriesTable(withTable)).toBe(true);
    // Arriving: it counts from the row the renderer first draws as a table (the same lexer decides both).
    expect(answerCarriesTable([{ role: "assistant", text: "Here:\n\nAd | Spend", partial: true }])).toBe(false);
    expect(answerCarriesTable([{ role: "assistant", text: "Here:\n\nAd | Spend\n--- | ---:\nSpring | $1", partial: true }])).toBe(true);
    expect(answerCarriesTable([{ role: "assistant", text: "Here:\n\n| Ad | Spend |\n| --- | ---: |\n| Spring | $1", partial: true }])).toBe(true);
    // A table inside a quote is drawn as a table too.
    expect(answerCarriesTable([{ role: "assistant", text: "> | Ad | Spend |\n> | --- | ---: |\n> | Spring | $1 |" }])).toBe(true);
    // A pipe in prose or code is not a table.
    expect(answerCarriesTable([{ role: "assistant", text: "Run `a | b` then:\n\n```\n| not | a table |\n| --- | --- |\n```" }])).toBe(false);
  });
});

describe("a committed document carries every page", () => {
  const body = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the body.`).join("\n");
  const doc = decodeAnswerView({
    v: 1, kind: "document", tool: "read_draft", title: "Win-back sequence", state: "ready", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { sections: [{ text: body, format: "plain" }] }
  });

  it("prints all of the body, with no page line no key can act on, even when the live turn was on page 2", () => {
    if (!doc) throw new Error("document fixture does not decode");
    const focus = { ...viewFocusAfterTurnDone([doc]), page: 1 };
    const live = renderLiveTurn({ messages, views: [doc], focus: null, width: 120, color: false, theme, rows: 30 }).lines;
    expect(live.some((line) => /page 1 of \d+/u.test(line))).toBe(true);
    const lines = renderCommittedTurn({ messages, views: [doc], focus, width: 120, color: false, theme });
    for (let i = 1; i <= 60; i += 1) {
      expect(lines.some((line) => line.includes(`Line ${i} of the body.`))).toBe(true);
    }
    expect(lines.some((line) => /page \d+ of \d+/u.test(line))).toBe(false);
  });

  it("the live turn says when a view pages inside itself: such a turn is not whole on screen", () => {
    if (!doc) throw new Error("document fixture does not decode");
    expect(renderLiveTurn({ messages, views: [doc], focus: null, width: 120, color: false, theme, rows: 30 }).paged).toBe(true);
    expect(renderLiveTurn({ messages, views: [doc], focus: null, width: 120, color: false, theme, rows: 30, compact: true }).paged).toBe(true);
    expect(renderLiveTurn({ messages, views: [], focus: null, width: 120, color: false, theme, rows: 30, details: ["card"] }).paged).toBe(false);
  });

  it("prints every version of a document, in order, under one head (scrollback has no key to switch them)", () => {
    const versions = decodeAnswerView({
      v: 1, kind: "document", tool: "read_draft", title: "Win-back sequence", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
      body: {
        sections: [{ text: "The first email.", format: "plain" }, { text: "The second email.", format: "plain" }, { text: "The third email.", format: "plain" }],
        versions: [
          { id: "e1", label: "Email 1", sectionIndexes: [0] },
          { id: "e2", label: "Email 2", sectionIndexes: [1] },
          { id: "e3", label: "Email 3", sectionIndexes: [2] }
        ]
      }
    });
    if (!versions) throw new Error("document fixture does not decode");
    // Live, one version is open at a time (its tab key switches).
    const live = renderLiveTurn({ messages, views: [versions], focus: viewFocusAfterTurnDone([versions]), width: 100, color: false, theme, rows: 40 }).lines;
    expect(live.some((line) => line.includes("The first email."))).toBe(true);
    expect(live.some((line) => line.includes("The second email."))).toBe(false);
    // Committed, with the second one open: all three print, first to last, and the head once.
    const focus = { ...viewFocusAfterTurnDone([versions]), tab: 1 };
    const lines = renderCommittedTurn({ messages, views: [versions], focus, width: 100, color: false, theme });
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at("The first email.")).toBeGreaterThan(0);
    expect(at("The second email.")).toBeGreaterThan(at("The first email."));
    expect(at("The third email.")).toBeGreaterThan(at("The second email."));
    expect(lines.filter((line) => line.includes("Win-back sequence"))).toHaveLength(1);
    // Each version is under its own tab bar, the open tab bracketed.
    expect(lines.filter((line) => line.includes("[1 Email 1]"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("[2 Email 2]"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("[3 Email 3]"))).toHaveLength(1);
  });
});

describe("a committed turn hides nothing behind a key (scrollback has none)", () => {
  const fixture = (name: string) => {
    const view = decodeAnswerView(JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), "utf8")));
    if (!view) throw new Error(`${name} fixture does not decode`);
    return view;
  };
  const keyWords = /→ to see|m for more/u;

  it("a numbers view that drops a column at 60: live it names the key, committed it keeps r4's table and names what it hid in words (run-2 M7)", () => {
    const ads = fixture("numbers-ads");
    const live = renderLiveTurn({ messages, views: [ads], focus: viewFocusAfterTurnDone([ads]), width: 60, color: false, theme }).lines;
    expect(live).toContain("+ Impressions · → to see");
    expect(live.some((line) => /Impressions: \d/u.test(line))).toBe(false);
    // A turn still running has no view keys yet: → does nothing there, so the hint says it in words.
    expect(renderLiveTurn({ messages, views: [ads], focus: null, width: 60, color: false, theme }).lines).toContain("+ Impressions hidden");
    const lines = renderCommittedTurn({ messages, views: [ads], focus: null, width: 60, color: false, theme });
    expect(lines.some((line) => keyWords.test(line))).toBe(false);
    // ONE bordered table, never label: value records, and the hidden column named.
    expect(lines.some((line) => /Impressions: [\d,]+/u.test(line))).toBe(false);
    expect(lines.filter((line) => line.startsWith("┌"))).toHaveLength(1);
    expect(lines).toContain("+ Impressions hidden");
    for (const kept of ["Spend", "Clicks", "CTR", "Conv", "CPC", "Ad set 01", "Ad set 03", "$40.00"]) {
      expect(lines.some((line) => line.includes(kept))).toBe(true);
    }
    expect(lines.every((line) => line.length <= 60)).toBe(true);
  });

  it("at a width where every column fits, the committed table is the live table", () => {
    const ads = fixture("numbers-ads");
    const lines = renderCommittedTurn({ messages, views: [ads], focus: null, width: 100, color: false, theme });
    expect(lines.some((line) => /│\s+Impressions │/u.test(line))).toBe(true);
    expect(lines.some((line) => keyWords.test(line))).toBe(false);
  });

  it.each([60, 80])("a truncated view at %i says what it shows, never `m for more`", (width) => {
    const tall = fixture("numbers-tall");
    const live = renderLiveTurn({ messages, views: [tall], focus: null, width, color: false, theme }).lines;
    // From 80 columns it is in the details pane, right of the answer.
    expect(live.some((line) => line.endsWith("40 of 100 · First 40 by spend · m for more"))).toBe(true);
    const lines = renderCommittedTurn({ messages, views: [tall], focus: null, width, color: false, theme });
    expect(lines).toContain("40 of 100 · First 40 by spend");
    expect(lines.some((line) => keyWords.test(line))).toBe(false);
  });

  it("a compare view's dropped columns print too", () => {
    const lines = renderCommittedTurn({ messages, views: [fixture("compare-test")], focus: null, width: 40, color: false, theme });
    expect(lines.some((line) => keyWords.test(line))).toBe(false);
    expect(lines.some((line) => line.trim() === "Relative: +33.33%")).toBe(true);
    expect(lines.some((line) => line.trim() === "vs: A Current")).toBe(true);
  });

  it("each printed document version has no tab key line under it", () => {
    const versions = fixture("document-versions");
    const live = renderLiveTurn({ messages, views: [versions], focus: viewFocusAfterTurnDone([versions]), width: 60, color: false, theme, rows: 40 }).lines;
    expect(live).toContain("[1-2] email");
    const lines = renderCommittedTurn({ messages, views: [versions], focus: null, width: 60, color: false, theme });
    expect(lines.some((line) => line.includes("[1-2]"))).toBe(false);
    expect(lines.some((line) => line.includes("Your trial ended"))).toBe(true);
    expect(lines.some((line) => line.includes("Still there?"))).toBe(true);
  });
});

describe("a table that draws whole in the answer pane keeps the split", () => {
  const small: Msg[] = [
    { role: "user", text: "which won?" },
    { role: "assistant", text: "Two ran.\n\n| Ad | Spend |\n| --- | ---: |\n| Spring | $120 |\n| Autumn | $80 |" }
  ];
  const card = ["┌─ card ─┐"];

  it.each([160, 200])("at %i a two-column table sits in the answer pane, bordered, left of the card", (width) => {
    expect(turnMaySplit(small, width)).toBe(true);
    const lines = renderLiveTurn({ messages: small, views: [], focus: null, width, color: false, theme, details: card }).lines;
    expect(lines[0]).toMatch(/^❯ which won\? + │ ┌─ card ─┐$/u);
    expect(lines.some((line) => /│ Ad\s+│\s+Spend │/u.test(line))).toBe(true);
    expect(lines.some((line) => /hidden|needs|Ad: /u.test(line))).toBe(false);
    expect(lines.includes("─".repeat(width))).toBe(false);
  });

  it("a table too wide for the pane keeps the whole width, quoted or not", () => {
    const wideTable = "| Ad | Spend | Purchases | ROAS | CPA |\n| --- | ---: | ---: | ---: | ---: |\n| Spring demo, hook 3 | $1,284.50 | 42 | 3.41 | $30.58 |";
    expect(turnMaySplit([{ role: "assistant", text: wideTable }], 160)).toBe(false);
    expect(turnMaySplit([{ role: "assistant", text: wideTable.split("\n").map((line) => `> ${line}`).join("\n") }], 160)).toBe(false);
  });
});

// Live run 4, N11: before a pause card the turn looked the ad up, and that
// lookup (a list whose one row IS the card's ad) printed above the card as
// its own view. r4 draws the card alone: the lookup is its Steps row.
describe("a lookup of the card's own target folds into its Steps row (live run-4 N11)", () => {
  const fixture = (name: string) => {
    const view = decodeAnswerView(JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), "utf8")));
    if (!view) throw new Error(`${name} does not decode`);
    return view;
  };
  /** The list-rows fixture cut to the rows given (ad_1 is the pause card's ad). */
  const lookup = (ids: readonly string[]) => {
    const list = fixture("list-rows") as Extract<ReturnType<typeof fixture>, { kind: "list" }>;
    const rows = list.body.rows.filter((row) => ids.includes(row.id));
    return { ...list, title: "Sample ads", body: { ...list.body, rows, shown: rows.length, total: rows.length } };
  };
  const steps: TurnStep[] = [
    { id: "c1", name: "list_sample_entities", label: "checking your campaigns", status: "ok", startedAt: 0, endedAt: 500, result: "1 ad" },
    { id: "c2", name: "propose_pause_entity", label: "waiting for your OK", status: "wait", startedAt: 500, endedAt: 600, result: "pause 1 ad" }
  ];
  const card = ["┌─ Pause ad “Demo A”? ─┐", "│  p  Pause    n  dismiss │", "└──────────────────────┘"];
  const turn: Msg[] = [{ role: "user", text: "pause demo a" }, { role: "assistant", text: "Ready. It stops spending once you say OK." }];

  it.each([60, 100, 160])("at %i, with the card waiting: the card and the Steps, never the lookup's head or row", (width) => {
    const views = [lookup(["ad_1"])];
    const drawn = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width, color: false, theme, details: card, statusViews: [fixture("change-pause-card")], steps, nowMs: 600 });
    const text = drawn.lines.join("\n");
    expect(text).not.toContain("Sample ads");
    expect(drawn.lines.some((line) => /│\s*Demo A\b|^\s*▸?\s*●?\s*on\s+Demo A/u.test(line))).toBe(false);
    expect(text).toContain("┌─ Pause ad “Demo A”? ─┐");
    expect(drawn.lines.some((line) => /checking your campaigns\s+━+\s+✓ 1 ad/u.test(line))).toBe(true);
    // The keys are the card's: the folded list offers none.
    expect(drawn.focused).toBeNull();
  });

  it("a lookup that shows more than the card's target stays a view of its own", () => {
    const views = [lookup(["ad_1", "ad_2", "ad_3"])];
    const drawn = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 100, color: false, theme, details: card, statusViews: [fixture("change-pause-card")], steps, nowMs: 600 });
    expect(drawn.lines.join("\n")).toContain("Sample ads");
    expect(drawn.focused).not.toBeNull();
  });

  it("with no card in the turn the same one-row list is drawn", () => {
    const views = [lookup(["ad_1"])];
    const drawn = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 100, color: false, theme, steps: steps.slice(0, 1), nowMs: 600 });
    expect(drawn.lines.join("\n")).toContain("Sample ads");
  });

  it("after n: the dismissed card on the turn folds it too, live and in scrollback", () => {
    const views = [lookup(["ad_1"]), fixture("receipt-dismissed")];
    const live = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 100, color: false, theme, steps, nowMs: 600 }).lines.join("\n");
    expect(live).not.toContain("Sample ads");
    expect(live).toContain("Dismissed");
    const committed = renderCommittedTurn({ messages: turn, views, focus: null, width: 100, color: false, theme, steps }).join("\n");
    expect(committed).not.toContain("Sample ads");
    expect(committed).toContain("Dismissed");
  });

  // Lane review SHOULD: a card whose target has no id must not fold by name
  // a list that holds two different things under that name: a wrong pick on
  // a Meta write stays visible.
  const noIdCard = () => {
    const card = fixture("change-pause-card") as Extract<ReturnType<typeof fixture>, { kind: "change" }>;
    const { id: _id, ...target } = card.body.target as Record<string, unknown>;
    return { ...card, body: { ...card.body, target } } as unknown as ReturnType<typeof fixture>;
  };
  const sameNamed = () => {
    const list = lookup(["ad_1", "ad_2"]);
    return { ...list, body: { ...list.body, rows: list.body.rows.map((row) => ({ ...row, title: "Demo A" })) } };
  };

  it("two same-named rows with different ids and a card target with no id: the list is drawn", () => {
    const views = [sameNamed()];
    const drawn = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 100, color: false, theme, details: card, statusViews: [noIdCard()], steps, nowMs: 600 });
    expect(drawn.lines.join("\n")).toContain("Sample ads");
  });

  it("a one-row list and a card target with no id still fold by name", () => {
    const views = [lookup(["ad_1"])];
    const drawn = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 100, color: false, theme, details: card, statusViews: [noIdCard()], steps, nowMs: 600 });
    expect(drawn.lines.join("\n")).not.toContain("Sample ads");
  });

  it("a card target with an id never folds a row by name alone", () => {
    const list = lookup(["ad_1"]);
    const views = [{ ...list, body: { ...list.body, rows: list.body.rows.map((row) => ({ ...row, id: "ad_9" })) } }];
    const drawn = renderLiveTurn({ messages: turn, views, focus: viewFocusAfterTurnDone(views), width: 100, color: false, theme, details: card, statusViews: [fixture("change-pause-card")], steps, nowMs: 600 });
    expect(drawn.lines.join("\n")).toContain("Sample ads");
  });

  // Lane review SHOULD: the keys go to a view that is drawn, never to a folded lookup.
  it("a numbers view, then the folded lookup, with the card waiting: the keys are the numbers view's", () => {
    const views = [fixture("numbers-ads"), lookup(["ad_1"])];
    const statusViews = [fixture("change-pause-card")];
    const focus = viewFocusAfterTurnDone(views, undefined, statusViews);
    expect(focus.viewIndex).toBe(0);
    const drawn = renderLiveTurn({ messages: turn, views, focus, width: 100, color: false, theme, details: card, statusViews, steps, nowMs: 600 });
    expect(drawn.lines.join("\n")).not.toContain("Sample ads");
    expect(drawn.focused).not.toBeNull();
    // With no focus yet (a turn still running), the drawn focus is the numbers view's too.
    expect(renderLiveTurn({ messages: turn, views, focus: null, width: 100, color: false, theme, details: card, statusViews, steps, nowMs: 600 }).focused).not.toBeNull();
  });

  it("a card still waiting when its turn goes up folds the lookup out of scrollback too", () => {
    const views = [lookup(["ad_1"])];
    const committed = renderCommittedTurn({ messages: turn, views, statusViews: [fixture("change-pause-card")], focus: null, width: 100, color: false, theme, steps, stepsStayLive: true }).join("\n");
    expect(committed).not.toContain("Sample ads");
    expect(committed).toContain("Ready. It stops spending once you say OK.");
  });
});
