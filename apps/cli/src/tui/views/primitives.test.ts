import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Key } from "ink";
import { ANSWER_VIEW_STATES, type AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { getTurnState, recordTurnView, clearTurnViews, resetTurnState } from "../app/turn-store.js";
import { inkTranscriptRowCount } from "../ink/transcript-app.js";
import { liveRegionCap } from "../ink/transcript-static.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { resolveViewKey, viewFocusAfterTurnDone, viewKeyHints } from "./focus.js";
import { layoutTurn, paneWidths, renderLiveTurn, stepLines } from "./layout.js";
import { cellText, FootnoteBook } from "./primitives.js";
import { renderView } from "./registry.js";
import { STATE_HEAD, stateHeadFor } from "./states.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

resetTurnState();
const emptyState = getTurnState();
const theme = resolveTheme({});
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function fixture(name: string): AnswerViewV1 {
  const view = decodeAnswerView(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")));
  if (!view) throw new Error(`fixture ${name} does not decode`);
  return view;
}
const listViewFixture = () => fixture("list-rows");
const numbersFixture = () => fixture("numbers-tall");

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 60, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});

const fakeRender: ViewRender = {
  head: "Ads running  ✓ Ready", source: "Demo source · up to Jan 15, 10:40", detail: ["row one", "row two"],
  footnotes: [], keys: [], okKey: null, rowCount: 2
};

function envelope(overrides: Record<string, unknown>): AnswerViewV1 {
  const view = decodeAnswerView({
    v: 1, kind: "record", tool: "read_item", title: "Item", state: "ready", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { fields: [] }, ...overrides
  });
  if (!view) throw new Error("test envelope does not decode");
  return view;
}

function tallNumbersTurn() {
  const messages: Msg[] = [
    { role: "user", text: "spend by ad set?" },
    { role: "assistant", text: Array.from({ length: 80 }, (_, i) => `Answer line ${i}.`).join("\n\n") }
  ];
  return { id: "t1", lines: renderLiveTurn({ messages, views: [numbersFixture()], focus: null, width: 80, color: false, theme }).lines };
}

describe("state heads (the shared state-word table)", () => {
  it("covers all 24 states", () => expect(Object.keys(STATE_HEAD).sort()).toEqual([...ANSWER_VIEW_STATES].sort()));

  it("uses the shared state words", () => {
    expect(STATE_HEAD.needs_yes.words).toBe("Needs your OK");
    expect(STATE_HEAD.outcome_unknown.words).toBe("Not sure it happened");
    expect(STATE_HEAD.cancelled.words).toBe("Dismissed");
  });

  it("no_change is muted, not red", () => expect(STATE_HEAD.no_change.tone).toBe("muted"));

  it("every glyph and word is exactly the contract table", () => {
    const table = Object.fromEntries(Object.entries(STATE_HEAD).map(([state, head]) => [state, `${head.glyph} ${head.words}`]));
    expect(table).toEqual({
      working: "◑ Working", ready: "✓ Ready", nothing_found: "○ Nothing found", not_measured: "— Not measured",
      partial: "◐ Partial", out_of_date: "⧗ Out of date", not_connected: "⊘ Not connected", blocked: "⊗ Blocked",
      finish_in_app: "↗ Finish in the app", needs_yes: "▣ Needs your OK", needs_answer: "▣ Needs an answer",
      applying: "◑ Applying", done: "✓ Done", failed: "✗ Failed", cancelled: "✕ Dismissed", expired: "◷ Expired",
      outcome_unknown: "? Not sure it happened", hit_limit: "$ Hit a limit", background: "⟳ Running",
      opened_in_app: "↗ Opened in the app", preview: "◇ Preview", no_change: "· Nothing to change",
      showing_defaults: "◇ Showing defaults", cmdl_only: "⌘ Do this in Cmd+L"
    });
  });

  it("each entry sits on one line as `state: { glyph, words` so the desktop parity test can read it", () => {
    const src = readFileSync(fileURLToPath(new URL("./states.ts", import.meta.url)), "utf8");
    const found = [...src.matchAll(/^\s*(\w+): \{ glyph: "([^"]*)", words: "([^"]*)"/gmu)].map((m) => m[1]);
    expect(found.sort()).toEqual([...ANSWER_VIEW_STATES].sort());
  });

  it("a failed write that was never sent says Not sent", () => {
    expect(stateHeadFor({ state: "failed", outcome: "not_sent" })).toMatchObject({ glyph: "✗", words: "Not sent", tone: "bad" });
    expect(stateHeadFor({ state: "failed", outcome: "unknown" }).words).toBe("Failed");
  });
});

describe("cells: a null is never 0", () => {
  it("a null cell is a dash with a footnote, never 0", () => {
    const notes = new FootnoteBook();
    expect(cellText({ value: null, reason: { code: "not_synced", words: "not synced yet", show: "dash" } }, "money", "USD", notes)).toBe("—¹");
    expect(notes.lines()).toEqual(["¹ not synced yet"]);
  });

  it("words-mode reasons print in place", () =>
    expect(cellText({ value: null, reason: { code: "new", words: "New", show: "words" } }, "count", null, new FootnoteBook())).toBe("New"));

  it("the same reason shares one footnote; a new reason gets the next number", () => {
    const notes = new FootnoteBook();
    const synced = { value: null, reason: { code: "not_synced", words: "not synced yet" } };
    expect(cellText(synced, "count", null, notes)).toBe("—¹");
    expect(cellText({ text: null, reason: { code: "hidden", words: "withheld by the app" } }, "text", null, notes)).toBe("—²");
    expect(cellText(synced, "money", "USD", notes)).toBe("—¹");
    expect(notes.lines()).toEqual(["¹ not synced yet", "² withheld by the app"]);
  });

  it("a null with no reason is still a dash, never 0", () =>
    expect(cellText({ value: null }, "count", null, new FootnoteBook())).toBe("—"));

  it("formats money in major units, counts, percent points, ratios, seconds and text", () => {
    const notes = new FootnoteBook();
    expect(cellText({ value: 1234.5 }, "money", "USD", notes)).toBe("$1,234.50");
    expect(cellText({ value: 0 }, "money", "USD", notes)).toBe("$0.00");
    expect(cellText({ value: 1000 }, "count", null, notes)).toBe("1,000");
    expect(cellText({ value: 1.25 }, "percent", null, notes)).toBe("1.25%");
    expect(cellText({ value: 2.5 }, "ratio", null, notes)).toBe("2.5");
    expect(cellText({ value: 123 }, "seconds", null, notes)).toBe("2:03");
    expect(cellText({ value: 45 }, "seconds", null, notes)).toBe("45 s");
    expect(cellText({ text: "Hook A" }, "text", null, notes)).toBe("Hook A");
    expect(notes.lines()).toEqual([]);
  });

  it("scrubs terminal control and bidi characters out of cell text and reasons", () => {
    const notes = new FootnoteBook();
    expect(cellText({ text: "Hook\u001b[2J A‮" }, "text", null, notes)).toBe("Hook A");
    expect(cellText({ value: null, reason: { code: "x", words: "New\u001b]0;t\u0007", show: "words" } }, "count", null, notes)).toBe("New");
  });
});

describe("the view shell", () => {
  it("a kind with no renderer prints only the head and the state reason", () => {
    const render = renderView(envelope({
      kind: "launch", state: "blocked",
      stateReason: { code: "role", words: "Only an owner or admin can do this." },
      body: { picturesInApp: true }
    }), ctx());
    expect(render.head).toBe("Item  ⊗ Blocked");
    expect(render.detail).toEqual(["Only an owner or admin can do this."]);
  });

  it("the source line reads provenance · up to asOf", () => {
    const render = renderView(envelope({ asOf: "2026-01-15T10:40:00Z", provenance: { source: "Demo source", via: "our_db" } }), ctx());
    expect(render.source).toBe("Demo source · up to Jan 15, 10:40");
    expect(renderView(envelope({ asOf: "2026-01-15" }), ctx()).source).toBe("up to Jan 15");
    expect(renderView(envelope({}), ctx()).source).toBeNull();
  });

  it("caveats print verbatim and truncation prints shown of total · m for more", () => {
    const render = renderView(numbersFixture(), ctx({ width: 80 }));
    expect(render.detail).toContain("Synthetic numbers for tests.");
    expect(render.detail).toContain("40 of 100 · First 40 by spend · m for more");
  });

  it("a failed write that was not sent heads as Not sent", () =>
    expect(renderView(envelope({ state: "failed", outcome: "not_sent" }), ctx()).head).toBe("Item  ✗ Not sent"));

  it("the explanation stays behind ? until it is opened", () => {
    const view = envelope({ explain: "Reads the item from our copy." });
    expect(renderView(view, ctx()).detail.join("\n")).not.toContain("Reads the item");
    expect(renderView(view, ctx({ explainOpen: true })).detail.join("\n")).toContain("Reads the item from our copy.");
  });

  it("scrubs every envelope string before it reaches the TTY", () => {
    const render = renderView(envelope({
      title: "Item\u001b[2J one‮", caveats: ["careful\u001b]8;;x\u0007 now"],
      stateReason: { code: "x", words: "reason⁦ here" }, provenance: { source: "src\u0000", via: "our_db" },
      asOf: "2026-01-15"
    }), ctx());
    const all = [render.head, render.source ?? "", ...render.detail].join("\n");
    expect(all).not.toMatch(/[\u001b\u0000‮⁦]/u);
    expect(render.head).toBe("Item one  ✓ Ready");
  });

  it("malformed envelope fields degrade instead of throwing", () => {
    const view = envelope({ caveats: [7, null, "kept"], stateReason: "nope", provenance: [1], asOf: 5, explain: { a: 1 } });
    expect(() => renderView(view, ctx({ explainOpen: true }))).not.toThrow();
    expect(renderView(view, ctx()).detail).toEqual(["kept"]);
  });

  it("no shell line is wider than the pane", () => {
    const view = envelope({ title: "T".repeat(200), stateReason: { code: "x", words: "w ".repeat(200) }, caveats: ["c ".repeat(200)] });
    for (const width of [20, 48, 79]) {
      const render = renderView(view, ctx({ width }));
      expect([render.head, ...render.detail].every((line) => displayWidth(line) <= width)).toBe(true);
    }
  });
});

describe("the r4 layout", () => {
  it("stacks under 80 columns and splits at 80+", () => {
    expect(layoutTurn(["a"], fakeRender, [], 79).some((l) => l.includes(" │ "))).toBe(false);
    expect(layoutTurn(["a"], fakeRender, [], 100).some((l) => l.includes(" │ "))).toBe(true);
  });

  it("the answer pane is 28% of the width, clamped to 26–40", () => {
    expect(paneWidths(79).wide).toBe(false);
    expect(paneWidths(80)).toEqual({ wide: true, left: 26, right: 51 });
    expect(paneWidths(120)).toEqual({ wide: true, left: 33, right: 84 });
    expect(paneWidths(200)).toEqual({ wide: true, left: 40, right: 157 });
  });

  it.each([48, 79, 80, 120])("no line is wider than %i columns", (width) => {
    const long = "x".repeat(300);
    const render: ViewRender = { ...fakeRender, head: long, source: long, detail: [long, `\u001b[1m${long}\u001b[0m`], footnotes: [long] };
    const lines = layoutTurn([long, "short"], render, [long], width);
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
  });

  it("the answer sits left and the details right, head first", () => {
    const lines = layoutTurn(["❯ question", "", "∞ answer"], fakeRender, [], 100);
    expect(lines[0]).toMatch(/^❯ question\s+│ Ads running {2}✓ Ready$/u);
    expect(lines[1]).toMatch(/│ Demo source · up to Jan 15, 10:40$/u);
  });

  it("the Steps strip comes from the turn's tool trail", () => {
    const messages: Msg[] = [
      { role: "user", text: "q" },
      { kind: "trail", role: "system", text: "", tools: ["Read Items(\"week\") (0.6s) :: 3 items ✓", "Load Other :: timed out ✗"] },
      { role: "assistant", text: "a" }
    ];
    expect(stepLines(messages)).toEqual(["  ✓ Read Items(\"week\") · 3 items (0.6s)", "  ✗ Load Other · timed out"]);
    const lines = renderLiveTurn({ messages, views: [listViewFixture()], focus: null, width: 100, color: false, theme }).lines;
    const strip = lines.findIndex((line) => line.startsWith("─ Steps "));
    expect(strip).toBeGreaterThan(0);
    expect(lines.slice(strip + 1)).toEqual(["  ✓ Read Items(\"week\") · 3 items (0.6s)", "  ✗ Load Other · timed out"]);
  });

  it("the live turn shows the question and the answer left of the view", () => {
    const messages: Msg[] = [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are **on**." }];
    const text = renderLiveTurn({ messages, views: [listViewFixture()], focus: null, width: 100, color: false, theme }).lines.join("\n");
    expect(text).toContain("❯ which ads are on?");
    expect(text).toContain("∞ Two are on.");
    expect(text).toContain("│ Ads running  ✓ Ready");
    expect(text).not.toContain("**");
  });

  it("a tall view never makes the live region exceed the cap", () =>
    expect(inkTranscriptRowCount({ transcript: { state: emptyState }, columns: 80, rows: 30, latest: tallNumbersTurn() }))
      .toBeLessThanOrEqual(liveRegionCap(30, 3, 1)));
});

describe("view focus: the latest turn keeps its keys until the next submit", () => {
  const press = (input: string, key: Partial<Key> = {}) => [input, key] as const;

  it("after a turn finishes, its views stay live and j/k still move the selection", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());          // pure: the latest turn keeps focus until the next submit
    expect(resolveViewKey("j", s0).selected).toBe(1);
    expect(resolveViewKey("k", resolveViewKey("j", s0)).selected).toBe(0);
  });

  it("the selection stops at the ends", () => {
    let s = viewFocusAfterTurnDone([listViewFixture()]);
    for (const [input, key] of [press("j"), press("j"), press("j"), press("", { downArrow: true })]) s = resolveViewKey(input, s, key);
    expect(s.selected).toBe(2);
    expect(resolveViewKey("k", viewFocusAfterTurnDone(listViewFixture())).selected).toBe(0);
  });

  it("a key the view does not use types into the composer instead of being eaten", () => {
    const s = resolveViewKey("h", viewFocusAfterTurnDone(listViewFixture()));
    expect(s.handled).toBe(false);
    expect(s.focus).toBe("composer");
    // From then on even j types, until tab brings the keys back.
    expect(resolveViewKey("j", s).handled).toBe(false);
    const back = resolveViewKey("", s, { tab: true });
    expect(back.handled).toBe(true);
    expect(back.focus).toBe("rows");
  });

  it("enter, esc and ok keys never act on a view", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());
    for (const [input, key] of [press("", { return: true }), press("", { escape: true }), press("y"), press("p")]) {
      const next = resolveViewKey(input, s0, key);
      expect(next.effect).toBeNull();
      expect(next.selected).toBe(0);
    }
  });

  it("m asks for more as a new user turn when the view says how", () => {
    const s = resolveViewKey("m", viewFocusAfterTurnDone(numbersFixture()));
    expect(s.handled).toBe(true);
    expect(s.effect).toEqual({ type: "ask", text: "Show the next 40 ad sets" });
  });

  it("? toggles the explanation only when there is one", () => {
    const withExplain = viewFocusAfterTurnDone(envelope({ explain: "What it does." }));
    expect(resolveViewKey("?", withExplain).explainOpen).toBe(true);
    expect(resolveViewKey("?", resolveViewKey("?", withExplain)).explainOpen).toBe(false);
    const none = viewFocusAfterTurnDone(envelope({}));
    expect(none.focus).toBe("composer");
    expect(resolveViewKey("?", none).handled).toBe(false);
  });

  it("the key bar shows only what works on the focused view", () => {
    const list = viewFocusAfterTurnDone(listViewFixture());
    expect(viewKeyHints(list).map((h) => h.key)).toEqual(["j k", "tab"]);
    expect(viewKeyHints(viewFocusAfterTurnDone(numbersFixture())).map((h) => h.key)).toEqual(["j k", "m", "tab"]);
    expect(viewKeyHints(resolveViewKey("x", list)).map((h) => h.key)).toEqual(["tab"]);
    expect(viewKeyHints(viewFocusAfterTurnDone(envelope({})))).toEqual([]);
  });

  it("focuses the last view that is not quiet", () => {
    const quiet = envelope({ kind: "quiet", body: { stepLine: "read the playbook" } });
    expect(viewFocusAfterTurnDone([listViewFixture(), quiet]).viewIndex).toBe(0);
    expect(viewFocusAfterTurnDone([quiet]).viewIndex).toBe(0);
  });
});

describe("the turn store keeps the latest turn's views", () => {
  it("records views by viewId (a later frame replaces) and clears on commit", () => {
    resetTurnState();
    const view = listViewFixture();
    recordTurnView({ type: "tool.view", stage: "tool", message: "m", viewId: "v1", name: "list_items", view });
    recordTurnView({ type: "tool.view", stage: "tool", message: "m", viewId: "v2", name: "list_items", view });
    recordTurnView({ type: "tool.view", stage: "tool", message: "m", viewId: "v1", name: "list_items", view: { ...view, title: "Updated" } });
    expect(getTurnState().views.map((frame) => [frame.viewId, frame.view.title])).toEqual([["v1", "Updated"], ["v2", "Ads running"]]);
    clearTurnViews();
    expect(getTurnState().views).toEqual([]);
  });
});

describe("synthetic fixtures only (infinite-os is public)", () => {
  it("no fixture carries a real-looking entity id or ad account", () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(`${FIXTURES}${name}`, "utf8");
      expect(text, name).not.toMatch(/\d{12,}/u);
      expect(text, name).not.toContain("act_");
      expect(decodeAnswerView(JSON.parse(text)), name).not.toBeNull();
    }
  });
});
