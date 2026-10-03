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
import { sgrOpen } from "../style/sgr.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { HANDLED_KIND_KEYS, resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts, viewKeyHints } from "./focus.js";
import { layoutTurn, paneWidths, renderCommittedTurn, renderLiveTurn } from "./layout.js";
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
      working: "◑ Working", ready: "✓ Ready", nothing_found: "∅ Nothing found", not_measured: "— Not measured",
      partial: "◐ Partial", out_of_date: "⧗ Out of date", not_connected: "⊘ Not connected", blocked: "⊗ Blocked",
      finish_in_app: "↗ Finish in the app", needs_yes: "▣ Needs your OK", needs_answer: "▣ Needs an answer",
      applying: "◑ Working", done: "✓ Done", failed: "✗ Failed", cancelled: "✕ Dismissed", expired: "◷ Expired",
      outcome_unknown: "◑ Not sure it happened", hit_limit: "$ Hit a limit", background: "⟳ Running",
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

  // r4 "⧗ Changed on Meta" (amber): the write never left because the thing changed
  // under it. Hosts may send it as failed + not_sent with code changed_on_meta.
  it("a write not sent because it changed on the provider heads ⧗ amber, never ✗ red", () => {
    const changed = (short?: string) => stateHeadFor({
      state: "failed", outcome: "not_sent",
      stateReason: { code: "changed_on_meta", words: "This changed since you looked.", ...(short ? { short } : {}) } as never
    });
    expect(changed("Changed on Meta")).toEqual({ glyph: "⧗", words: "Changed on Meta", tone: "warn" });
    expect(changed()).toEqual({ glyph: "⧗", words: "Changed on Meta", tone: "warn" });
    // Any other not-sent reason keeps the red ✗ Not sent.
    expect(stateHeadFor({ state: "failed", outcome: "not_sent", stateReason: { code: "x", words: "w" } as never }))
      .toEqual({ glyph: "✗", words: "Not sent", tone: "bad" });
  });

  it("a short longer than a head's room falls back to the generic words", () => {
    const h = stateHeadFor({ state: "partial", stateReason: { code: "p", words: "w", short: "x".repeat(33) } as never });
    expect(h.words).toBe("Partial");
    expect(stateHeadFor({ state: "partial", stateReason: { code: "p", words: "w", short: "y".repeat(32) } as never }).words).toBe("y".repeat(32));
  });

  // D3 (design decision, 2026-10-02): the head is the glyph plus `stateReason.short ?? generic`, as round 4 draws it.
  it("the needs-you heads take the bold amber ask tone; Cmd+L-only takes its own bold blue", () => {
    expect(STATE_HEAD.needs_yes.tone).toBe("ask");
    expect(STATE_HEAD.needs_answer.tone).toBe("ask");
    expect(STATE_HEAD.cmdl_only.tone).toBe("cmdl_only");
  });

  it("a state reason's short words replace the generic words; the glyph and tone stay the state's", () => {
    const head = (state: string, short: unknown, extra: Record<string, unknown> = {}) => {
      const h = stateHeadFor({ state: state as never, stateReason: { code: "c", words: "w", short } as never, ...extra });
      return `${h.glyph} ${h.words}|${h.tone}`;
    };
    expect(head("not_measured", "1 not measured")).toBe("— 1 not measured|muted");
    expect(head("out_of_date", "Changed on Meta")).toBe("⧗ Changed on Meta|warn");
    expect(head("outcome_unknown", "Still running")).toBe("◑ Still running|warn");
    expect(head("no_change", "Already live")).toBe("· Already live|muted");
    expect(head("cmdl_only", "Cmd+L only")).toBe("⌘ Cmd+L only|cmdl_only");
    expect(head("failed", "Not sent", { outcome: "not_sent" })).toBe("✗ Not sent|bad");
    // Short words that are empty, not a string, or only control characters fall back to the generic words.
    expect(head("nothing_found", "")).toBe("∅ Nothing found|muted");
    expect(head("nothing_found", 7)).toBe("∅ Nothing found|muted");
    expect(head("nothing_found", "\u001b[2J")).toBe("∅ Nothing found|muted");
    // Scrubbed like every view string.
    expect(head("partial", "1 of 2\u001b[31m days")).toBe("◐ 1 of 2 days|warn");
  });

  it("running images draw the braille spinner and read Working; a job keeps ⟳ Running", () => {
    const head = (kind: string, state: string) => {
      const h = stateHeadFor({ kind: kind as never, state: state as never });
      return `${h.glyph} ${h.words}|${h.tone}`;
    };
    expect(head("images", "background")).toBe("⠋ Working|busy");
    expect(head("images", "working")).toBe("⠋ Working|busy");
    expect(head("job", "background")).toBe("⟳ Running|busy");
    expect(head("change", "working")).toBe("◑ Working|busy");
    expect(head("images", "done")).toBe("✓ Done|ok");
  });
});

describe("cells: a null is never 0", () => {
  it("a null cell is a dash with a footnote, never 0", () => {
    const notes = new FootnoteBook();
    expect(cellText({ value: null, reason: { code: "not_synced", words: "not synced yet", show: "dash" } }, "money", "USD", notes)).toBe("—¹");
    expect(notes.lines()).toEqual(["¹ not synced yet"]);
  });

  it("a text cell keeps its own spacing (r4 view-03 `0.41%  (account 1.10%)`); line breaks and controls still go", () => {
    const notes = new FootnoteBook();
    expect(cellText({ text: "0.41%  (account 1.10%)" }, "text", null, notes)).toBe("0.41%  (account 1.10%)");
    expect(cellText({ text: "  a\nb\tc \u001b[31mred\u001b[0m  " }, "text", null, notes)).toBe("a b c red");
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
    expect(cellText({ text: "Demo A" }, "text", null, notes)).toBe("Demo A");
    expect(notes.lines()).toEqual([]);
  });

  it("scrubs terminal control and bidi characters out of cell text and reasons", () => {
    const notes = new FootnoteBook();
    expect(cellText({ text: "Demo\u001b[2J A‮" }, "text", null, notes)).toBe("Demo A");
    expect(cellText({ value: null, reason: { code: "x", words: "New\u001b]0;t\u0007", show: "words" } }, "count", null, notes)).toBe("New");
  });
});

describe("the view shell", () => {
  it("a view whose body draws nothing prints only the head and the state reason", () => {
    // `launch` has a renderer since T11; a launch with nothing to launch and no
    // pictures draws no body, so only the shell lines remain.
    const render = renderView(envelope({
      kind: "launch", state: "blocked",
      stateReason: { code: "role", words: "Only an owner or admin can do this." },
      body: { picturesInApp: false }
    }), ctx());
    expect(render.head).toBe("[Item] ⊗ Blocked");
    expect(render.detail).toEqual(["⊗ Only an owner or admin can do this."]);
  });

  it("the source line reads provenance · up to a date, or · as of a time (r4 view-03 `as of 10:40`, run-2 M8)", () => {
    const render = renderView(envelope({ asOf: "2026-01-15T10:40:00Z", provenance: { source: "Demo source", via: "our_db" } }), ctx());
    expect(render.source).toBe("Demo source · as of Jan 15, 10:40");
    expect(renderView(envelope({ asOf: "2026-01-15" }), ctx()).source).toBe("up to Jan 15");
    expect(renderView(envelope({}), ctx()).source).toBeNull();
    // A time today reads the clock alone.
    const now = Date.now;
    Date.now = () => Date.parse("2026-01-15T18:00:00Z");
    try {
      expect(renderView(envelope({ asOf: "2026-01-15T10:40:00Z" }), ctx()).source).toBe("as of 10:40");
    } finally {
      Date.now = now;
    }
  });

  it("caveats print verbatim and truncation prints shown of total · m for more", () => {
    const render = renderView(numbersFixture(), ctx({ width: 80 }));
    expect(render.detail).toContain("Synthetic numbers for tests.");
    expect(render.detail).toContain("40 of 100 · First 40 by spend · m for more");
  });

  it("the head draws the title as a tag chip, then the state (r4 head)", () => {
    const head = renderView(envelope({}), ctx({ color: true })).head;
    expect(head).toContain(`${sgrOpen("tag", theme.tier)} Item `);
    expect(head.replace(/\u001b\[[0-9;]*m/gu, "")).toBe(" Item  ✓ Ready");
    expect(renderView(envelope({}), ctx()).head).toBe("[Item] ✓ Ready");
  });

  it("a state's fix prints only when a key can act on it", () => {
    const reason = (fix: Record<string, unknown>) => envelope({
      state: "not_connected", body: { fields: [] },
      stateReason: { code: "nc", words: "Meta is not connected.", fix }
    });
    const appLink = { route: "connections" };
    // An ask with no row asks is bound to Enter.
    const asks = renderView(reason({ label: "Connect Meta", ask: "connect meta" }), ctx());
    expect(asks.detail).toEqual(["⊘ Meta is not connected.", "", "→ Connect Meta"]);
    expect(asks.fixAsk).toBe("connect meta");
    // A link opens with o only when the session can open the app.
    expect(renderView(reason({ label: "Connect Meta", appLink }), ctx({ caps: { open: true, watch: false, retry: false } })).detail)
      .toEqual(["⊘ Meta is not connected.", "", "Connect Meta ↗  (o)"]);
    // Nothing can act: the line is not printed.
    expect(renderView(reason({ label: "Connect Meta", appLink }), ctx()).detail).toEqual(["⊘ Meta is not connected."]);
    expect(renderView(reason({ label: "Connect Meta" }), ctx()).detail).toEqual(["⊘ Meta is not connected."]);
    expect(renderView(reason({ label: "Connect Meta" }), ctx()).fixAsk).toBeUndefined();
  });

  it("a failed write that was not sent heads as Not sent", () =>
    expect(renderView(envelope({ state: "failed", outcome: "not_sent" }), ctx()).head).toBe("[Item] ✗ Not sent"));

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
    expect(render.head).toBe("[Item one] ✓ Ready");
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
  it("is one column under 120 columns and splits at 120+ (layout decision, 2026-10-02)", () => {
    expect(layoutTurn(["a"], fakeRender, [], 119).some((l) => l.includes(" │ "))).toBe(false);
    expect(layoutTurn(["a"], fakeRender, [], 120).some((l) => l.includes(" │ "))).toBe(true);
    expect(layoutTurn(["a"], fakeRender, [], 160, null, { split: false }).some((l) => l.includes(" │ "))).toBe(false);
  });

  it("the answer pane is 28% of the width, clamped to 26–40", () => {
    expect(paneWidths(119).wide).toBe(false);
    expect(paneWidths(120)).toEqual({ wide: true, left: 33, right: 84 });
    expect(paneWidths(160)).toEqual({ wide: true, left: 40, right: 117 });
    expect(paneWidths(200)).toEqual({ wide: true, left: 40, right: 157 });
  });

  it.each([48, 79, 80, 120])("no line is wider than %i columns", (width) => {
    const long = "x".repeat(300);
    const render: ViewRender = { ...fakeRender, head: long, source: long, detail: [long, `\u001b[1m${long}\u001b[0m`], footnotes: [long] };
    const lines = layoutTurn([long, "short"], render, [long], width);
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
  });

  it("the answer sits left and the details right, head first", () => {
    const lines = layoutTurn(["❯ question", "", "∞ answer"], fakeRender, [], 120);
    expect(lines[0]).toMatch(/^❯ question\s+│ Ads running {2}✓ Ready$/u);
    expect(lines[1]).toMatch(/│ Demo source · up to Jan 15, 10:40$/u);
  });

  it("the Steps strip comes from the turn's tool trail, laid end to end, one row per call", () => {
    const messages: Msg[] = [
      { role: "user", text: "q" },
      { kind: "trail", role: "system", text: "", tools: ["Read Items(\"week\") (0.6s) :: 3 items ✓", "Load Other :: timed out ✗"] },
      { role: "assistant", text: "a" }
    ];
    // r4 columns at 100: label 26, bar 46, then the glyph and the result. No raw tool id, no arguments.
    const rows = [
      `  ${"reading items".padEnd(26)} ${"━".repeat(46)} ✓ 3 items`,
      `  ${"loading other".padEnd(26)} ${" ".repeat(46)}━ ✗ timed out`
    ];
    const lines = renderLiveTurn({ messages, views: [listViewFixture()], focus: null, width: 100, color: false, theme }).lines;
    const strip = lines.findIndex((line) => line.startsWith("─ Steps "));
    expect(strip).toBeGreaterThan(0);
    expect(lines[strip]).toBe(`─ Steps ${"─".repeat(92)}`);
    expect(lines.slice(strip + 1)).toEqual(rows);
  });

  it("a committed turn is one column at any width, with every page, and no rule of its own", () => {
    const messages: Msg[] = [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }];
    const lines = renderCommittedTurn({ messages, views: [listViewFixture()], focus: null, width: 160, color: false, theme });
    // Scrollback draws the ONE rule between turns (D1, transcript-app.tsx).
    expect(lines.some((line) => line.includes(" │ "))).toBe(false);
    expect(lines[0]).toBe("❯ which ads are on?");
    expect(lines).toContain("∞ Two are on.");
    expect(lines.findIndex((line) => line.includes("Ads running"))).toBeGreaterThan(lines.indexOf("∞ Two are on."));
  });

  it("the live turn shows the question and the answer left of the view", () => {
    const messages: Msg[] = [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are **on**." }];
    const text = renderLiveTurn({ messages, views: [listViewFixture()], focus: null, width: 120, color: false, theme }).lines.join("\n");
    expect(text).toContain("❯ which ads are on?");
    expect(text).toContain("∞ Two are on.");
    expect(text).toContain("│ [Ads running] ✓ Ready");
    expect(text).not.toContain("**");
  });

  it("a tall view never makes the live region exceed the cap", () =>
    expect(inkTranscriptRowCount({ transcript: { state: emptyState }, columns: 80, rows: 30, latest: tallNumbersTurn() }))
      .toBeLessThanOrEqual(liveRegionCap(30, 3, 1)));

  it("a 300-row view never makes the live region exceed the cap", () => {
    const tall = { ...fakeRender, detail: Array.from({ length: 300 }, (_, i) => `row ${i}`) };
    const latest = { id: "t2", lines: layoutTurn(["a"], tall, [], 80) };
    expect(latest.lines.length).toBeGreaterThan(300);
    expect(inkTranscriptRowCount({ transcript: { state: emptyState }, columns: 80, rows: 30, latest }))
      .toBeLessThanOrEqual(liveRegionCap(30, 3, 1));
  });
});

describe("view focus: the latest turn keeps its keys until the next submit", () => {
  const press = (input: string, key: Partial<Key> = {}) => [input, key] as const;
  const hintPress = (hint: string): readonly [string, Partial<Key>] => {
    switch (hint) {
      case "j k": return press("j");
      case "enter": return press("", { return: true });
      case "tab": return press("", { tab: true });
      case "→": return press("", { rightArrow: true });
      case "space": return press(" ");
      default: return press(/^1-\d$/u.test(hint) ? "2" : hint);
    }
  };

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

  it("m asks for more as a new user turn once the view is engaged", () => {
    const s = resolveViewKey("m", resolveViewKey("j", viewFocusAfterTurnDone(numbersFixture())));
    expect(s.handled).toBe(true);
    expect(s.effect).toEqual({ type: "ask", text: "Show the next 40 ad sets" });
  });

  it("a capital letter always types: M, K and J never act on a view", () => {
    for (const input of ["M", "K", "J"]) {
      for (const s0 of [viewFocusAfterTurnDone(numbersFixture()), resolveViewKey("j", viewFocusAfterTurnDone(numbersFixture()))]) {
        const next = resolveViewKey(input, s0);
        expect(next.handled).toBe(false);
        expect(next.focus).toBe("composer");
        expect(next.effect).toBeNull();
        expect(next.selected).toBe(s0.selected);
      }
    }
  });

  it("m on a fresh turn types (\"more…\" is a message), it never sends an ask", () => {
    const next = resolveViewKey("m", viewFocusAfterTurnDone(numbersFixture()));
    expect(next.handled).toBe(false);
    expect(next.focus).toBe("composer");
    expect(next.effect).toBeNull();
  });

  it("m on a fresh tall turn types instead of paging the live region", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());
    const next = resolveViewKey("m", s0, {}, { ...s0.facts, livePageNext: true });
    expect(next.handled).toBe(false);
    expect(next.effect).toBeNull();
    const engaged = resolveViewKey("j", s0);
    expect(resolveViewKey("m", engaged, {}, { ...engaged.facts, livePageNext: true }).effect).toEqual({ type: "page_live" });
  });

  it("a key that moves nothing types: k on the first row, j on the last", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());
    const k = resolveViewKey("k", s0);
    expect(k.handled).toBe(false);
    expect(k.focus).toBe("composer");
    let last = s0;
    for (let i = 0; i < 2; i += 1) last = resolveViewKey("j", last);
    expect(last.selected).toBe(2);
    expect(resolveViewKey("j", last).handled).toBe(false);
  });

  it("before the view is engaged, up and down stay with the composer's history", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());
    expect(s0.engaged).toBe(false);
    const up = resolveViewKey("", s0, { upArrow: true });
    const down = resolveViewKey("", s0, { downArrow: true });
    expect(up.handled).toBe(false);
    expect(down.handled).toBe(false);
    expect(down.selected).toBe(0);
    // j engages the view; then the arrows move rows.
    const engaged = resolveViewKey("j", s0);
    expect(engaged.engaged).toBe(true);
    expect(resolveViewKey("", engaged, { downArrow: true }).selected).toBe(2);
    expect(resolveViewKey("", engaged, { upArrow: true }).selected).toBe(0);
  });

  it("tab engages the view without leaving it, and tab again goes to the composer", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());
    const engaged = resolveViewKey("", s0, { tab: true });
    expect(engaged.handled).toBe(true);
    expect(engaged.engaged).toBe(true);
    expect(engaged.focus).toBe("rows");
    expect(resolveViewKey("", engaged, { downArrow: true }).selected).toBe(1);
    const away = resolveViewKey("", engaged, { tab: true });
    expect(away.focus).toBe("composer");
    expect(away.engaged).toBe(false);
    const back = resolveViewKey("", away, { tab: true });
    expect(back.focus).toBe("rows");
    expect(back.engaged).toBe(true);
  });

  it("Enter sends a state's fix ask as a new turn when the view has no row asks", () => {
    const blocked = envelope({
      state: "not_connected",
      stateReason: { code: "nc", words: "Meta is not connected.", fix: { label: "Connect Meta", ask: "connect meta" } }
    });
    const s0 = viewFocusAfterTurnDone(blocked);
    expect(s0.facts.fixAsk).toBe("connect meta");
    expect(s0.focus).toBe("rows");
    // A bare Enter on a fresh turn never sends anything.
    expect(resolveViewKey("", s0, { return: true }).effect).toBeNull();
    const engaged = resolveViewKey("", s0, { tab: true });
    expect(viewKeyHints(engaged).map((h) => h.key)).toEqual(["enter", "tab"]);
    expect(resolveViewKey("", engaged, { return: true }).effect).toEqual({ type: "ask", text: "connect meta" });
  });

  it("\"just\" typed right after a list turn keeps its j: a move key that turns out to start a message is typed too", () => {
    const s0 = viewFocusAfterTurnDone(listViewFixture());
    const j = resolveViewKey("j", s0);
    expect(j.handled).toBe(true);
    expect(j.selected).toBe(1);
    const u = resolveViewKey("u", j);
    expect(u.handled).toBe(false);
    expect(u.focus).toBe("composer");
    expect(u.effect).toEqual({ type: "type", text: "j" });
    // A second view key says the first was a move: nothing is typed after it.
    const jk = resolveViewKey("k", j);
    expect(jk.handled).toBe(true);
    expect(resolveViewKey("h", jk).effect).toBeNull();
    // A tab key on a document with tabs works the same way ("10 more…").
    const doc = viewFocusAfterTurnDone(fixture("document-versions"));
    expect(doc.facts.tabs).toBeGreaterThan(1);
    const two = resolveViewKey("2", doc);
    expect(two.handled).toBe(true);
    expect(resolveViewKey("0", two).effect).toEqual({ type: "type", text: "2" });
    // Once engaged by tab, a move is a move.
    const engaged = resolveViewKey("j", resolveViewKey("", s0, { tab: true }));
    expect(resolveViewKey("u", engaged).effect).toBeNull();
  });

  it("a view's ask is a new user turn, never a command: an ask starting with / is dropped", () => {
    const view = envelope({
      state: "not_connected",
      stateReason: { code: "nc", words: "Meta is not connected.", fix: { label: "Quit", ask: "  /exit" } }
    });
    const s0 = viewFocusAfterTurnDone(view);
    expect(s0.facts.fixAsk).toBeNull();
    const engaged = resolveViewKey("", s0, { tab: true });
    expect(resolveViewKey("", engaged, { return: true }).effect).toBeNull();
    const list = listViewFixture();
    const withSlash = { ...list, next: [{ label: "Quit", ask: "/quit" }, { label: "Pause", ask: "pause Demo A" }] } as AnswerViewV1;
    const facts = viewKeyFacts(withSlash, renderView(withSlash, ctx()));
    expect(facts.rowAsks).not.toContain("/quit");
    expect(facts.rowAsks).toContain("pause Demo A");
    const more = { ...list, body: { ...(list.body as unknown as Record<string, unknown>), truncated: { shown: 3, total: 9, more: { label: "more", ask: "/exit" } } } } as AnswerViewV1;
    expect(viewKeyFacts(more, renderView(more, ctx())).more).toBeNull();
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
    const numbers = viewFocusAfterTurnDone(numbersFixture());
    expect(viewKeyHints(numbers).map((h) => h.key)).toEqual(["j k", "tab"]);
    expect(viewKeyHints(resolveViewKey("j", numbers)).map((h) => h.key)).toEqual(["j k", "m", "tab"]);
    expect(viewKeyHints(resolveViewKey("x", list)).map((h) => h.key)).toEqual(["tab"]);
    expect(viewKeyHints(viewFocusAfterTurnDone(envelope({})))).toEqual([]);
  });

  it("`j k` only where moving shows something: never on images or a job, nor on a table that is not ready (run-r2 MUST 2)", () => {
    // r4 view-05 / view-08 / flow-images-*: the rows only report progress; nothing follows the selection.
    for (const name of ["images-done", "images-codex", "job-running", "job-no-signal"]) {
      const state = viewFocusAfterTurnDone(fixture(name));
      expect(state.facts.rowCount, name).toBe(0);
      expect(viewKeyHints(state).map((h) => h.key), name).not.toContain("j k");
    }
    // r4 flow-numbers-02: a not-measured table is read, not browsed (keys: none); a ready one keeps `j k row`.
    const notMeasured = { ...numbersFixture(), state: "not_measured", stateReason: { code: "not_measured", words: "1 not measured", short: "1 not measured" } } as AnswerViewV1;
    expect(viewKeyHints(viewFocusAfterTurnDone(notMeasured)).map((h) => h.key)).not.toContain("j k");
    expect(viewKeyHints(viewFocusAfterTurnDone(numbersFixture()))[0]).toEqual({ key: "j k", label: "row" });
  });

  it("a view's own explanation is `? what it does` on the key bar, never a line inside the answer; `? hide` while open (run-2 N12)", () => {
    const explained = envelope({ explain: "What it does." });
    const drawn = renderView(explained, ctx());
    expect(drawn.detail.join("\n")).not.toContain("what it does");
    expect(renderView(envelope({}), ctx()).detail.join("\n")).not.toContain("what it does");
    const focus = viewFocusAfterTurnDone(explained);
    expect(viewKeyHints(focus)).toContainEqual({ key: "?", label: "what it does" });
    const open = resolveViewKey("?", { ...focus, focus: focus.detailsFocus, engaged: true });
    expect(open.explainOpen).toBe(true);
    expect(viewKeyHints(open)).toContainEqual({ key: "?", label: "hide" });
    // Open, the explanation shows inside the view.
    expect(renderView(explained, ctx({ explainOpen: true })).detail.join("\n")).toContain("What it does.");
  });

  it("r4's words in the bar: a table's rows are `j k row`, a document's tabs name what they are (run-2 M4)", () => {
    const numbers = viewFocusAfterTurnDone(numbersFixture());
    expect(viewKeyHints(numbers)[0]).toEqual({ key: "j k", label: "row" });
    const list = viewFocusAfterTurnDone(listViewFixture());
    expect(viewKeyHints(list)[0]).toEqual({ key: "j k", label: "move" });
    const doc = viewFocusAfterTurnDone(fixture("document-versions"));
    expect(viewKeyHints(doc).find((hint) => hint.key.startsWith("1-"))?.label).toBe("email");
  });

  it("a kind key is hinted only once the key resolver acts on it", () => {
    const list = viewFocusAfterTurnDone(listViewFixture());
    const kindKeys = [{ key: "c", label: "copy" }, { key: "v", label: "view" }, { key: "e", label: "edit" }];
    for (const hint of kindKeys) {
      expect(HANDLED_KIND_KEYS.has(hint.key)).toBe(false);
    }
    expect(viewKeyHints(list, list.facts, kindKeys).map((h) => h.key)).toEqual(["j k", "tab"]);
    expect(resolveViewKey("c", list).handled).toBe(false);
  });

  it("every key the bar shows acts when pressed", () => {
    const fresh = [viewFocusAfterTurnDone(listViewFixture()), viewFocusAfterTurnDone(numbersFixture()), viewFocusAfterTurnDone(envelope({ explain: "What it does." }))];
    for (const s0 of [...fresh, ...fresh.map((s) => resolveViewKey("", s, { tab: true }))]) {
      for (const hint of viewKeyHints(s0)) {
        const [input, key] = hintPress(hint.key);
        expect({ hint: hint.key, handled: resolveViewKey(input, s0, key).handled }).toEqual({ hint: hint.key, handled: true });
      }
    }
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
