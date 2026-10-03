// T10: the "things" views — list, record, document, link and quiet. Every rule
// here is pinned by a CI-run pure test (the PTY tests are CI-skipped).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Key } from "ink";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { r4Segments } from "../../formatting/r4-segments.test-util.js";
import { stripAnsi } from "../lib/text.js";
import { ansiFg, INFINITE_R4_THEME, resolveTheme } from "../theme.js";
import { DEFAULT_COMPOSER_ROWS, DEFAULT_KEY_BAR_ROWS, liveBodyRows } from "../ink/transcript-static.js";
import type { Msg } from "../types.js";
import { clipboardSequence, copyTargets } from "./clipboard.js";
import { documentPageLines } from "./document.js";
import { focusedViewCtx, resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts, viewKeyHints, type ViewFocusState } from "./focus.js";
import { renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { hasKindRenderer, renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function fixture(name: string): AnswerViewV1 {
  const view = decodeAnswerView(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")));
  if (!view) throw new Error(`fixture ${name} does not decode`);
  return view;
}

function view(raw: Record<string, unknown>): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, tool: "read_item", title: "Item", state: "ready", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], ...raw
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

/** A fixture with fields replaced (a shallow merge, and of `body` too). */
function withBody(name: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}): AnswerViewV1 {
  const base = JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as Record<string, unknown>;
  return view({ ...base, ...extra, body: { ...(base.body as Record<string, unknown>), ...body } });
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 72, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});

const draw = (v: AnswerViewV1, overrides: Partial<ViewRenderCtx> = {}): ViewRender => renderView(v, ctx(overrides));
const allLines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail, ...render.footnotes];
const text = (render: ViewRender): string => allLines(render).join("\n");

function press(input: string, key: Partial<Key> = {}): [string, Partial<Key>] {
  return [input, key];
}

/** Press keys in order, re-reading the view's facts from a fresh render each time (as the session does). */
function pressAll(v: AnswerViewV1, presses: [string, Partial<Key>][], width = 72): ViewFocusState {
  let state = viewFocusAfterTurnDone(v);
  for (const [input, key] of presses) {
    const render = renderView(v, ctx({ width, selected: state.selected, tab: state.tab, page: state.page }));
    state = resolveViewKey(input, state, key, viewKeyFacts(v, render));
  }
  return state;
}

describe("the registry draws the five things kinds", () => {
  it("list, record, document, link and quiet have renderers", () => {
    for (const kind of ["list", "record", "document", "link", "quiet"] as const) {
      expect(hasKindRenderer(kind), kind).toBe(true);
    }
  });
});

describe("list (r4 view-02 row grammar, run-2 M8)", () => {
  const withCurrency = () => withBody("list-rows", { currency: "USD" });

  it("no column-header row: each cell carries its unit (money with its currency, a count with its noun)", () => {
    const render = draw(withCurrency(), { width: 80 });
    expect(render.detail.some((line) => /Spend\s+Trials/u.test(line))).toBe(false);
    const hookA = render.detail.find((line) => line.includes("Hook A"))!;
    expect(hookA).toContain("$100.00");
    expect(hookA).toMatch(/3 trials$/u);
    expect(render.detail.find((line) => line.includes("Hook C"))).toMatch(/1 trial$/u);
    // A null is still a dash with its footnote, never 0 and never "— trials".
    expect(render.detail.find((line) => line.includes("Hook C"))).toContain("—¹");
  });

  it("the selected row's details are one dim line under the rows (r4 `Hook B · since Sep 24 · …`)", () => {
    const v = withBody("list-rows", {
      rows: [
        { id: "ad_1", title: "Hook A", cells: {} },
        { id: "ad_2", title: "Hook B", cells: {}, detail: [{ label: "since", value: { text: "Hook B · since Sep 24 · Broad" } }, { label: "budget", value: { text: "$30/day" } }] }
      ]
    });
    const render = draw(v, { selected: 1 });
    expect(render.detail.at(-1)).toBe("Hook B · since Sep 24 · Broad · budget $30/day");
  });
});

describe("list: r4 view-02 (run-r2 MUST 1)", () => {
  // r4's three ads, synthetic: Hook B is the flagged row and its `0 trials` the bad cell.
  const hooks = (over: Record<string, unknown> = {}) => withBody("list-rows", {
    currency: "USD",
    columns: [{ key: "spend", label: "Spend 7d", unit: "money" }, { key: "ctr", label: "CTR", unit: "percent" }, { key: "trials", label: "Trials", unit: "count" }],
    rows: [
      { id: "ad_a", title: "Hook A · demo loop", status: { word: "on", tone: "ok" }, cells: { spend: { value: 18.2 }, ctr: { value: 1.32 }, trials: { value: 3 } } },
      { id: "ad_c", title: "Hook C · pricing", status: { word: "on", tone: "ok" }, cells: { spend: { value: 15.75 }, ctr: { value: 1.05 }, trials: { value: 1 } } },
      { id: "ad_b", title: "Hook B · founder POV", status: { word: "on", tone: "ok" }, cells: { spend: { value: 12.4 }, ctr: { value: 0.41 }, trials: { value: 0, tone: "bad" } },
        detail: [{ label: "since", value: { text: "Hook B · since Sep 24 · Broad · US · 25–54" } }] }
    ],
    ...over
  });

  it("opens on the row the view names (`body.selected`), so its details show without a key press", () => {
    const v = hooks({ selected: "ad_b" });
    const opening = viewFocusAfterTurnDone(v);
    expect(opening.selected).toBe(2);
    const detail = draw(v, { width: 100, selected: opening.selected }).detail;
    expect(detail.filter((line) => line.startsWith("▸"))).toEqual([expect.stringContaining("Hook B · founder POV")]);
    expect(detail).toContain("Hook B · since Sep 24 · Broad · US · 25–54");
    // No `selected`, or one naming no row: the first row, as before.
    expect(viewFocusAfterTurnDone(hooks()).selected).toBe(0);
    expect(viewFocusAfterTurnDone(hooks({ selected: "nope" })).selected).toBe(0);
  });

  it("pads cells to r4's widths: money right in 8, a percent right in 6, a count with its noun left", () => {
    const rows = draw(hooks({ selected: "ad_b" }), { width: 100, selected: 2 }).detail.filter((line) => /^(?:  |▸ )● /u.test(line));
    expect(rows).toEqual([
      "  ● on  Hook A · demo loop      $18.20   1.32%  3 trials",
      "  ● on  Hook C · pricing        $15.75   1.05%  1 trial",
      expect.stringMatching(/^▸ ● on  Hook B · founder POV    \$12\.40   0\.41%  0 trials\s*$/u)
    ]);
  });

  it("a cell the view marks `tone: \"bad\"` is amber (r4 `0 trials`), on the selection too", () => {
    const painted = draw(hooks({ selected: "ad_b" }), { width: 100, selected: 2, color: true, theme: INFINITE_R4_THEME }).detail.map(r4Segments);
    const hookB = painted.find((row) => row.some((part) => part.text.includes("Hook B")))!;
    expect(hookB.find((part) => part.text.includes("0 trials"))?.style).toBe("amber sel");
    const unselected = draw(hooks({ selected: "ad_b" }), { width: 100, selected: 0, color: true, theme: INFINITE_R4_THEME }).detail.map(r4Segments);
    const plainB = unselected.find((row) => row.some((part) => part.text.includes("Hook B")))!;
    expect(plainB.find((part) => part.text.includes("0 trials"))?.style).toBe("amber");
    const hookA = unselected.find((row) => row.some((part) => part.text.includes("Hook A")))!;
    expect(hookA.some((part) => part.style.includes("amber"))).toBe(false);
  });
});

describe("list", () => {
  it("status comes first (`● on`), then the title, then the cells", () => {
    const render = draw(fixture("list-rows"));
    const hookA = render.detail.find((line) => line.includes("Hook A"))!;
    expect(hookA.slice(2).startsWith("● on")).toBe(true);
    expect(hookA.indexOf("● on")).toBeLessThan(hookA.indexOf("Hook A"));
    // ListBodyV1 carries no currency (contract v1), so money prints as an amount.
    expect(hookA).toContain("100.00");
    expect(render.detail.find((line) => line.includes("Hook C"))).toContain("● off");
  });

  it("a null cell is a dash with a footnote, never 0", () => {
    const render = draw(fixture("list-rows"));
    const hookC = render.detail.find((line) => line.includes("Hook C"))!;
    expect(hookC).toContain("—¹");
    expect(hookC).not.toMatch(/\$0\.00/u);
    expect(render.footnotes).toEqual(["¹ not synced yet"]);
  });

  it("the selected row gets ▸, and j/k move it", () => {
    const v = fixture("list-rows");
    const marked = (render: ViewRender) => render.detail.filter((line) => line.startsWith("▸")).map((line) => line.includes("Hook B") ? "B" : line.includes("Hook A") ? "A" : "C");
    expect(marked(draw(v))).toEqual(["A"]);
    expect(marked(draw(v, { selected: 1 }))).toEqual(["B"]);
    const down = pressAll(v, [press("j")]);
    expect(down.selected).toBe(1);
    expect(marked(draw(v, { selected: down.selected }))).toEqual(["B"]);
    expect(pressAll(v, [press("j"), press("k")]).selected).toBe(0);
    expect(draw(v).rowCount).toBe(3);
  });

  it("enter on a row sends the row's next ask as a NEW turn, never a tool call", () => {
    const v = withBody("list-rows", {}, { next: [{ label: "Pause Hook B", ask: "pause hook b" }] });
    const render = draw(v, { selected: 3 });
    expect(render.rowCount).toBe(4);
    expect(render.rowAsks).toEqual([null, null, null, "pause hook b"]);
    expect(render.detail.find((line) => line.startsWith("▸"))).toContain("→ Pause Hook B");
    const onNext = pressAll(v, [press("j"), press("j"), press("j"), press("", { return: true })]);
    expect(onNext.effect).toEqual({ type: "ask", text: "pause hook b" });
    // A data row with no ask of its own: Enter sends nothing.
    const onRow = pressAll(v, [press("j"), press("", { return: true })]);
    expect(onRow.effect).toBeNull();
  });

  it("the selected row's details print below the rows", () => {
    const v = view({
      kind: "list",
      body: {
        layout: "rows", columns: [], total: 2, shown: 2,
        rows: [
          { id: "ad_1", title: "Hook A", cells: {} },
          { id: "ad_2", title: "Hook B", cells: {}, detail: [{ label: "Audience", value: { text: "Broad · 25–54" } }] }
        ]
      }
    });
    expect(text(draw(v))).not.toContain("Broad · 25–54");
    expect(draw(v, { selected: 1 }).detail.some((line) => line.includes("Audience") && line.includes("Broad · 25–54"))).toBe(true);
  });

  it("a log row with `who: null` prints `who: unknown`", () => {
    const render = draw(fixture("list-log"));
    const unknown = render.detail.find((line) => line.includes("Hook B status"))!;
    expect(unknown).toContain("on → paused");
    expect(unknown).toContain("who: unknown");
    expect(render.detail.find((line) => line.includes("Ad set 01 budget"))).toContain("by Sam");
    expect(render.detail.find((line) => line.includes("Ad set 01 budget"))).toContain("Jan 15, 09:12");
    // Too narrow for one line: the change and who move to the next line, never cut off.
    const narrow = draw(fixture("list-log"), { width: 40 });
    expect(narrow.detail.some((line) => line.includes("who: unknown"))).toBe(true);
    expect(narrow.detail.some((line) => line.includes("by Sam"))).toBe(true);
    for (const line of narrow.detail) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("`omitted` and `emptyWords` print verbatim", () => {
    expect(text(draw(fixture("list-log")))).toContain("4 not shown · older than 30 days");
    const empty = view({
      kind: "list", state: "nothing_found",
      body: { layout: "rows", columns: [], rows: [], total: 0, shown: 0, emptyWords: "No ads match “paused, last 7 days”.", filterWords: "paused · last 7 days" }
    });
    const drawn = draw(empty);
    expect(drawn.detail).toContain("No ads match “paused, last 7 days”.");
    expect(drawn.detail).toContain("paused · last 7 days");
    expect(drawn.rowCount).toBe(0);
  });

  it("groups print their label and reason, and their rows are selectable in order", () => {
    const v = view({
      kind: "list",
      body: {
        layout: "groups", columns: [], rows: [], total: 3, shown: 3,
        groups: [
          { label: "Needs you", reason: "spending with no trials", rows: [{ id: "ad_1", title: "Hook A", cells: {} }] },
          { label: "Fine", rows: [{ id: "ad_2", title: "Hook B", cells: {} }, { id: "ad_3", title: "Hook C", cells: {} }] }
        ]
      }
    });
    const render = draw(v, { selected: 2 });
    expect(render.rowCount).toBe(3);
    expect(render.detail).toContain("Needs you · spending with no trials");
    expect(render.detail.find((line) => line.startsWith("▸"))).toContain("Hook C");
  });

  it("columns that do not fit drop from the right and → shows them as records", () => {
    const v = fixture("list-rows");
    const narrow = draw(v, { width: 24 });
    expect(narrow.hiddenColumns).toBeGreaterThan(0);
    expect(narrow.detail.some((line) => line.includes("→ to see"))).toBe(true);
    const shown = draw(v, { width: 24, showHiddenColumns: true });
    expect(shown.detail.some((line) => line.includes("Trials") && line.includes("3"))).toBe(true);
    for (const line of [...narrow.detail, ...shown.detail]) expect(line.length).toBeLessThanOrEqual(24);
  });

  it("c copies the selected row's copy text once the view is engaged", () => {
    const v = view({
      kind: "list",
      body: {
        layout: "rows", columns: [], total: 2, shown: 2,
        rows: [{ id: "ad_1", title: "Hook A", cells: {} }, { id: "ad_2", title: "Hook B", cells: {}, copy: "ad_2" }]
      }
    });
    expect(draw(v).rowCopies).toEqual([null, "ad_2"]);
    const onB = pressAll(v, [press("j")]);
    expect(viewKeyHints(onB).map((hint) => hint.key)).toContain("c");
    expect(pressAll(v, [press("j"), press("c")]).effect).toEqual({ type: "copy", text: "ad_2" });
    // On a row with nothing to copy, c is not offered and types.
    const onA = pressAll(v, [press("j"), press("k")]);
    expect(viewKeyHints(onA).map((hint) => hint.key)).not.toContain("c");
    expect(resolveViewKey("c", onA).handled).toBe(false);
  });
});

describe("record", () => {
  it("a field keeps its value's own spacing: `0.41%  (account 1.10%)` (r4 view-03, run-r2 NICE)", () => {
    const v = view({ kind: "record", body: { fields: [{ label: "CTR 7d", value: { text: "0.41%  (account 1.10%)" } }] } });
    expect(draw(v, { width: 80 }).detail).toContain("CTR 7d        0.41%  (account 1.10%)");
  });


  it("prints its fields, a null as a dash with a footnote, and no picture", () => {
    const render = draw(fixture("record-ad"));
    const out = text(render);
    expect(render.detail.find((line) => line.includes("Campaign"))).toContain("Demo trials");
    expect(render.detail.find((line) => line.includes("Spend 7d"))).toContain("100.00");
    expect(render.detail.find((line) => line.includes("Trials 7d"))).toContain("—¹");
    expect(render.footnotes).toEqual(["¹ not synced yet"]);
    expect(out).not.toContain("asset_1");
  });

  it("history prints each change, and `who: null` is `who: unknown`", () => {
    const render = draw(fixture("record-ad"));
    expect(render.detail).toContain("History");
    expect(render.detail.find((line) => line.includes("Jan 10"))).toContain("by Sam");
    expect(render.detail.find((line) => line.includes("Jan 12"))).toContain("who: unknown");
    expect(render.detail.find((line) => line.includes("Jan 12"))).toContain("on → paused");
  });

  it("its next steps are selectable rows Enter sends as a new turn", () => {
    const v = fixture("record-ad");
    const render = draw(v);
    expect(render.rowAsks).toEqual(["pause hook b"]);
    // r4 `Next: pause it`; the selection shows once the view is engaged.
    expect(render.detail.at(-1)).toBe("Next: Pause it");
    expect(draw(v, { engaged: true }).detail.find((line) => line.startsWith("▸"))).toContain("Next: Pause it");
    expect(pressAll(v, [press("", { tab: true }), press("", { return: true })]).effect).toEqual({ type: "ask", text: "pause hook b" });
  });

  it("a rule prints its schedule words verbatim", () => {
    const v = view({
      kind: "record",
      body: {
        fields: [],
        rule: { summary: "Spend over $100 in a day", channel: "email", schedule: "every hour", nextRunAt: null, checkEveryMinutes: 60, desktopRequired: true, version: 2 }
      }
    });
    const out = text(draw(v));
    expect(out).toContain("Spend over $100 in a day");
    expect(out).toContain("every hour");
    expect(out).toContain("email");
  });
});

describe("document", () => {
  it("r4 view-04: the body wraps inside min(pane, 76) − 2, its gutter included, and its own keys sit under it (run-2 M9)", () => {
    const long = "Before your trial ended, Infinite found 3 ads spending with no trials, and one that beat your goal by 40%.";
    const v = withBody("document-versions", { sections: [{ text: long, format: "plain" }, { text: "A second note.", format: "plain" }] });
    const render = draw(v, { width: 100 });
    const ruled = render.detail.filter((line) => line.startsWith("│"));
    expect(ruled.every((line) => line.length <= 74)).toBe(true);
    expect(ruled[0]).toBe("│ Before your trial ended, Infinite found 3 ads spending with no trials,");
    expect(render.detail.at(-1)).toBe("[1-2] email");
    expect(render.detail.at(-2)).toBe("");
  });

  it("1–9 tabs come from `versions`", () => {
    const v = fixture("document-versions");
    const first = draw(v);
    expect(first.tabs).toBe(2);
    expect(first.detail[0]).toContain("[1 Email 1]");
    expect(first.detail[0]).toContain("2 Email 2");
    expect(text(first)).toContain("Your trial ended");
    expect(text(first)).not.toContain("A second note");
    const second = draw(v, { tab: 1 });
    expect(second.detail[0]).toContain("[2 Email 2]");
    expect(text(second)).toContain("A second note");
    expect(text(second)).not.toContain("Three things");
    expect(pressAll(v, [press("2")]).tab).toBe(1);
  });

  it("a section with format markdown goes through renderMarkdown", () => {
    const out = text(draw(fixture("document-versions")));
    expect(out).toContain("Three things");
    expect(out).not.toContain("**");
    expect(out).toMatch(/• one/u);
  });

  it("an untrusted section is prefixed `from outside ·`", () => {
    const render = draw(fixture("document-versions"), { tab: 1 });
    const marked = render.detail.find((line) => line.includes("from outside ·"))!;
    expect(marked).toContain("Reply from a reader");
    expect(render.detail.filter((line) => line.includes("from outside ·"))).toHaveLength(1);
    // A whole untrusted view marks every section.
    const all = withBody("document-versions", { versions: undefined }, { untrusted: true });
    expect(draw(all).detail.filter((line) => line.includes("from outside ·"))).toHaveLength(3);
  });

  it("space pages by width × rows", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the body.`).join("\n");
    const v = view({ kind: "document", body: { meta: [], sections: [{ text: long, format: "plain" }] } });
    const rows = 20;
    // One of the rows is the `page N of M` line.
    const per = documentPageLines(rows) - 1;
    const first = draw(v, { rows });
    expect(first.pages).toBe(Math.ceil(60 / per));
    expect(text(first)).toContain("Line 1 of");
    expect(text(first)).not.toContain(`Line ${per + 1} of`);
    const second = draw(v, { rows, page: 1 });
    expect(text(second)).toContain(`Line ${per + 1} of`);
    expect(text(second)).not.toContain("Line 1 of");
    // A narrower window wraps into more lines, so more pages. Past r4's reading
    // measure (76 columns) a wider pane changes nothing: the text stays 74 wide.
    const wrapped = Array.from({ length: 60 }, () => "word ".repeat(17).trim()).join("\n");
    const at = (width: number) => draw(view({ kind: "document", body: { meta: [], sections: [{ text: wrapped, format: "plain" }] } }), { rows, width });
    expect(at(40).pages!).toBeGreaterThan(at(76).pages!);
    expect(at(120).pages).toBe(at(76).pages);
    expect(at(120).detail.every((line) => line.length <= 76)).toBe(true);
    // space moves to the next page.
    let state = viewFocusAfterTurnDone(v);
    expect(state.focus).toBe("document");
    state = resolveViewKey(" ", state, {}, viewKeyFacts(v, draw(v, { rows })));
    expect(state.page).toBe(1);
  });

  it("versions past 9 are named, never dropped silently", () => {
    const versions = Array.from({ length: 11 }, (_, i) => ({ id: `e${i + 1}`, label: `E${i + 1}`, sectionIndexes: [0] }));
    const render = draw(view({ kind: "document", body: { meta: [], sections: [{ text: "Hello.", format: "plain" }], versions } }), { width: 100 });
    expect(render.tabs).toBe(9);
    expect(render.detail[0]).toContain("9 E9");
    expect(render.detail[0]).not.toContain("10 E10");
    expect(render.detail[1]).toBe("+ 2 more not shown");
    // Nine or fewer: no such line.
    expect(text(draw(fixture("document-versions")))).not.toContain("more not shown");
  });

  it("prints its meta and the truncation of a long body", () => {
    const v = withBody("document-versions", { truncated: { shownChars: 2000, totalChars: 9000, editable: false } });
    const out = text(draw(v));
    expect(out).toMatch(/From\s+Demo Team/u);
    expect(out).toContain("2,000 of 9,000 characters");
  });
});

describe("link", () => {
  it("the minted URL renders on one line, with the `c` key chip and copy beside it once the view is engaged", () => {
    const fresh = draw(fixture("link-minted"));
    const bare = fresh.detail.find((l) => /https:\/\/go\.example\.com\/abc1/u.test(l))!;
    // Unengaged, `c` types (the first letter of a message), so the body offers no `c`.
    expect(bare).not.toContain("copy");
    expect(fresh.copyText).toBe("https://go.example.com/abc1");
    const render = draw(fixture("link-minted"), { engaged: true });
    const line = render.detail.find((l) => /https:\/\/go\.example\.com\/abc1/u.test(l))!;
    // The chip prints as same-width brackets without colour.
    expect(line).toMatch(/https:\/\/go\.example\.com\/abc1\s+\[c\] copy$/u);
    expect(render.copyText).toBe("https://go.example.com/abc1");
    expect(text(render)).toMatch(/source\s+forum/u);
    expect(text(render)).toMatch(/to\s+https:\/\/example\.com\/landing/u);
    // Too narrow for both: the URL is cut, the copy key stays on the line, and c copies it whole.
    const narrow = draw(fixture("link-minted"), { width: 30, engaged: true });
    const cut = narrow.detail.find((l) => l.includes("[c] copy"))!;
    expect(cut.length).toBeLessThanOrEqual(30);
    expect(cut).toContain("…");
    expect(narrow.copyText).toBe("https://go.example.com/abc1");
  });

  it("warnings print in amber", () => {
    const render = draw(fixture("link-minted"), { color: true });
    const warning = render.detail.find((line) => line.includes("reports start counting tomorrow"))!;
    expect(warning).toContain(ansiFg(theme, "warning"));
  });

  it("c copies the link once the view is engaged, and the bar offers it", () => {
    const v = fixture("link-minted");
    const s0 = viewFocusAfterTurnDone(v);
    // Unengaged, c is the first letter of a message.
    expect(resolveViewKey("c", s0).handled).toBe(false);
    const engaged = resolveViewKey("", s0, { tab: true });
    expect(viewKeyHints(engaged)).toContainEqual({ key: "c", label: "copy" });
    // The body's `c copy` follows the same rule as the key (focusedViewCtx carries it).
    expect(focusedViewCtx(s0, { width: 80, color: false, theme }).engaged).toBe(false);
    expect(focusedViewCtx(engaged, { width: 80, color: false, theme }).engaged).toBe(true);
    expect(resolveViewKey("c", engaged).effect).toEqual({ type: "copy", text: "https://go.example.com/abc1" });
  });

  it("a link not minted yet has nothing to copy", () => {
    const render = draw(withBody("link-minted", { minted: false, shortUrl: undefined }));
    expect(render.copyText).toBeUndefined();
    expect(text(render)).not.toContain("c copy");
  });

  it("an app place is a link with (o) only when the session can open the app", () => {
    const v = view({
      kind: "link",
      body: { target: "app_place", minted: false, opened: false, warnings: [], appPlace: { place: "library", label: "Library", selectionCount: 3 } }
    });
    expect(text(draw(v))).toContain("Library · 3 selected");
    expect(text(draw(v))).not.toMatch(/↗|\(o\)/u);
    expect(text(draw(v, { caps: { open: true, watch: false, retry: false } }))).toContain("Library · 3 selected ↗  (o)");
  });
});

describe("quiet", () => {
  it("prints only stepLine", () => {
    const render = draw(fixture("quiet-steps"));
    expect(render.detail).toEqual(["read the writing playbook"]);
    expect(render.footnotes).toEqual([]);
    expect(render.rowCount).toBe(0);
  });
});

describe("a document page fits the live region", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the body.`).join("\n");
  const doc = view({
    kind: "document", title: "Win-back sequence",
    body: {
      meta: [{ label: "From", value: "Demo Team" }, { label: "To", value: "Trial users" }, { label: "Subject", value: "Your trial ended" }],
      sections: [{ text: long, format: "plain" }, { text: "The second email.", format: "plain" }],
      versions: [{ id: "e1", label: "Email 1", sectionIndexes: [0] }, { id: "e2", label: "Email 2", sectionIndexes: [1] }]
    }
  });
  const messages: Msg[] = [
    { role: "user", text: "show me the win-back emails" },
    { kind: "trail", role: "system", text: "", tools: ["Read Draft(\"win-back\") (0.4s) :: 2 emails ✓"] },
    { role: "assistant", text: "Here are both emails." }
  ];
  // The rows the session gives the latest turn: the live cap minus the top rule and one status row.
  const budgetAt = (rows: number) => liveBodyRows(rows, DEFAULT_COMPOSER_ROWS, DEFAULT_KEY_BAR_ROWS, 1, false);

  // Under 120 columns the answer, a rule and the steps stack on top of the view;
  // at 24 rows that chrome alone is taller than the live region, so they start at 30.
  for (const [width, rowsList] of [[120, [24, 30, 40]], [100, [30, 40]], [60, [30, 40]]] as const) {
    for (const rows of rowsList) {
      it(`every page fits and every body line is reachable (${width} × ${rows})`, () => {
        const budget = budgetAt(rows);
        const base = viewFocusAfterTurnDone(doc);
        const turn = (page: number) => renderLiveTurn({ messages, views: [doc], focus: { ...base, page }, width, color: false, theme, rows: budget });
        const pages = turn(0).focused!.render.pages ?? 1;
        expect(pages).toBeGreaterThan(1);
        const seen = new Set<number>();
        for (let page = 0; page < pages; page += 1) {
          const lines = turn(page).lines;
          expect(lines.length, `page ${page + 1} of ${pages}`).toBeLessThanOrEqual(budget);
          for (const line of lines) {
            const match = /Line (\d+) of the body/u.exec(line);
            if (match) seen.add(Number(match[1]));
          }
        }
        expect(seen.size).toBe(60);
      });
    }
  }

  it("without a known height a page is the default size", () => {
    const render = draw(doc);
    expect(render.pages).toBe(Math.ceil(60 / documentPageLines(undefined)));
  });
});

describe("quiet in a turn (r4 view-12 `steps only`, run-2 M7)", () => {
  const messages: Msg[] = [
    { role: "user", text: "write the trial email" },
    { role: "assistant", text: "Here is a draft: Paying forty dollars per trial is the line to beat this week." }
  ];

  it("a quiet view takes the details pane under a dim `steps only` head, never its title, source or state words", () => {
    const quiet = withBody("quiet-steps", {}, { title: "Read playbook", provenance: { source: "Playbooks", via: "our_db" } });
    // Below 120: the answer, a blank and a rule, then `steps only`, a blank source row, a blank, the line.
    const narrow = renderLiveTurn({ messages, views: [quiet], focus: null, width: 100, color: false, theme }).lines;
    const answer = narrow.findIndex((line) => line.startsWith("∞ Here is a draft"));
    expect(narrow.slice(answer + 1, answer + 6)).toEqual(["", "─".repeat(100), "steps only", "", ""]);
    expect(narrow[answer + 6]).toBe("read the writing playbook");
    // From 120: side by side, `steps only` on the question's row.
    const wide = renderLiveTurn({ messages, views: [quiet], focus: null, width: 160, color: false, theme }).lines;
    expect(wide[0]).toMatch(/^❯ write the trial email +│ steps only$/u);
    expect(wide.some((line) => /│ read the writing playbook$/u.test(line))).toBe(true);
    const out = [...narrow, ...wide].join("\n");
    expect(out).not.toContain("Ready");
    expect(out).not.toContain("Playbooks");
    expect(out).not.toContain("Read playbook");
    const render = draw(quiet);
    expect(render.quiet).toBe(true);
    expect(render.head).toBe("steps only");
    expect(render.source).toBe("");
  });

  it("the head is dim", () => {
    const render = draw(fixture("quiet-steps"), { color: true, theme: INFINITE_R4_THEME });
    expect(r4Segments(render.head)).toEqual([{ text: "steps only", style: "dim" }]);
  });

  it("a quiet view next to a list prints nothing: the list takes the details pane (run-2 M6, no stray `steps only`)", () => {
    for (const width of [100, 120]) {
      const lines = renderLiveTurn({ messages, views: [fixture("quiet-steps"), fixture("list-rows")], focus: null, width, color: false, theme }).lines;
      expect(lines.some((line) => line.includes("Ads running"))).toBe(true);
      expect(lines.join("\n")).not.toMatch(/steps only|read the writing playbook/u);
    }
  });

  it("committed to scrollback, a quiet view prints nothing, even alone (no Steps go with it there)", () => {
    const lines = renderCommittedTurn({ messages, views: [fixture("quiet-steps")], focus: null, width: 100, color: false, theme });
    expect(lines.join("\n")).not.toMatch(/steps only|read the writing playbook/u);
    expect(lines.some((line) => line.startsWith("∞ Here is a draft"))).toBe(true);
  });

  it("a failed quiet call draws nothing of its own: no tool-name head, no developer error; its Steps row says it in words (run-2 M6)", () => {
    // The shape of the app's generic failure view: the tool's name as its title and step line, a developer's error as its reason.
    const failed = withBody("quiet-steps", { stepLine: "Read Subscription Metrics", degraded: true }, {
      tool: "read_subscription_metrics", title: "Read Subscription Metrics", state: "failed",
      stateReason: { code: "invalid_input", words: "Use a half-open UTC day window { start, end } as YYYY-MM-DD, start before end" }
    });
    const steps = [{ id: "c1", name: "mcp__sample_app__read_subscription_metrics", label: "checking subscriptions", status: "fail" as const, startedAt: 0, endedAt: 500, result: "Use a half-open UTC day window { start, end } as YYYY-MM-DD, start before end" }];
    for (const width of [60, 100, 160]) {
      const live = renderLiveTurn({ messages, views: [failed], focus: null, width, color: false, theme, steps }).lines;
      const committed = renderCommittedTurn({ messages, views: [failed], focus: null, width, color: false, theme, steps });
      for (const lines of [live, committed]) {
        const out = lines.join("\n");
        expect(out).not.toMatch(/Read Subscription Metrics|steps only|half-open|YYYY|\{ start/u);
        expect(out).toMatch(/checking subscriptions +(?:━+ +)?✗ couldn't/u);
      }
    }
  });

  it("a quiet view never prints a caveat, an explanation or a state reason", () => {
    const v = withBody("quiet-steps", {}, { caveats: ["a caveat"], explain: "what it does", state: "partial", stateReason: { code: "x", words: "partial" } });
    const render = draw(v, { explainOpen: true });
    expect(render.detail).toEqual(["read the writing playbook"]);
  });
});

describe("scrub sweep: no escape or bidi character reaches the TTY", () => {
  const ESC = "\u001b[2J\u001b]52;c;aGk=\u0007\u001b[8m\u001b[31m";
  const BIDI = "‮⁦‏";
  const dirty = (s: string) => `${s}${ESC}${BIDI}`;

  const views = buildViews(dirty);
  const cleanViews = buildViews((s) => s);

  function buildViews(dirty: (s: string) => string): AnswerViewV1[] {
    return [
      view({
        kind: "list", title: dirty("List"), next: [{ label: dirty("Next"), ask: dirty("ask") }],
        body: {
          layout: "rows", filterWords: dirty("filter"), emptyWords: dirty("empty"), total: 1, shown: 1,
          omitted: { count: 1, reason: dirty("omitted") },
          columns: [{ key: "a", label: dirty("Col"), unit: "text" }],
          rows: [{
            id: "r1", title: dirty("Row"), status: { word: dirty("on"), tone: "ok" }, url: dirty("https://example.com"), copy: dirty("copy"),
            cells: { a: { text: dirty("cell") } }, detail: [{ label: dirty("Detail"), value: { text: dirty("value") } }],
            appLink: { place: "p", label: dirty("Open") }
          }]
        }
      }),
      view({
        kind: "list",
        body: {
          layout: "log", columns: [], total: 1, shown: 1,
          rows: [{ id: "r1", title: dirty("Row"), cells: {}, from: dirty("a"), to: dirty("b"), at: dirty("2026-01-15T10:00:00Z"), who: dirty("who") }],
          groups: [{ label: dirty("Group"), reason: dirty("why"), rows: [{ id: "r2", title: dirty("Grouped"), cells: {} }] }]
        }
      }),
      view({
        kind: "record", next: [{ label: dirty("Next"), ask: dirty("ask") }],
        body: {
          fields: [{ label: dirty("Field"), value: { text: dirty("value") } }, { label: dirty("Null"), value: { value: null, reason: { code: "x", words: dirty("why") } } }],
          history: [{ at: dirty("when"), from: dirty("a"), to: dirty("b"), who: dirty("who"), source: dirty("src") }],
          rule: { summary: dirty("rule"), channel: dirty("email"), schedule: dirty("hourly"), nextRunAt: dirty("soon"), checkEveryMinutes: 5, desktopRequired: true, version: 1 }
        }
      }),
      view({
        kind: "document",
        body: {
          meta: [{ label: dirty("Subject"), value: dirty("Hello") }],
          sections: [
            { heading: dirty("Heading"), text: dirty("**md** text"), format: "markdown", untrusted: true },
            { text: dirty("plain\ntext"), format: "plain" },
            { text: dirty("const a = 1;"), format: "code", language: dirty("ts") },
            { text: dirty("stripped"), format: "html_stripped" }
          ],
          versions: [{ id: "v1", label: dirty("Version"), sectionIndexes: [0, 1, 2, 3] }],
          liveUrl: dirty("https://example.com/live")
        }
      }),
      view({
        kind: "link",
        body: {
          target: "url", minted: true, opened: false, url: dirty("https://example.com"), shortUrl: dirty("https://s.example.com"),
          finalUrl: dirty("https://example.com/final"), utm: { source: dirty("src"), medium: dirty("med") }, ga4Channel: dirty("Social"),
          warnings: [dirty("warn")]
        }
      }),
      view({
        kind: "link",
        body: { target: "local_file", minted: false, opened: true, warnings: [], file: { name: dirty("report.csv"), path: dirty("/tmp/report.csv"), app: dirty("Numbers") } }
      }),
      view({
        kind: "link",
        body: { target: "app_place", minted: false, opened: false, warnings: [dirty("warn")], appPlace: { place: "library", label: dirty("Library"), selectionCount: 2 } }
      }),
      view({
        kind: "list",
        body: {
          layout: "files", total: 1, shown: 1,
          columns: [{ key: "size", label: dirty("Size"), unit: "text" }],
          rows: [{ id: "f1", title: dirty("report.csv"), cells: { size: { text: dirty("2 KB") } }, copy: dirty("/tmp/report.csv") }]
        }
      }),
      view({ kind: "quiet", body: { stepLine: dirty("step"), degraded: true } })
    ];
  }

  it("every line from all five renderers is free of ESC, C1 and bidi controls", () => {
    for (const v of views) {
      for (const overrides of [{}, { selected: 1 }, { showHiddenColumns: true }, { width: 30 }]) {
        const render = draw(v, overrides);
        for (const line of [...allLines(render), ...(render.rowAsks ?? []).map(String), ...(render.rowCopies ?? []).map(String), render.copyText ?? ""]) {
          expect(line, `${v.kind}: ${JSON.stringify(line)}`).not.toMatch(/[\u001b\u0007\u0080-\u009f؜‎‏‪-‮⁦-⁩]/u);
        }
      }
    }
  });

  it("with colour on, the only escapes are the renderer's own colours", () => {
    // The renderer's own codes: whatever it emits for the same view built from clean strings.
    const SGR = /\u001b\[[0-9;]*m/gu;
    views.forEach((v, index) => {
      for (const overrides of [{ color: true }, { color: true, selected: 1 }, { color: true, width: 30 }]) {
        const own = new Set(allLines(draw(cleanViews[index]!, overrides)).flatMap((line) => line.match(SGR) ?? []));
        for (const line of allLines(draw(v, overrides))) {
          const rest = line.replace(SGR, (code) => (own.has(code) ? "" : code));
          expect(rest, `${v.kind}: ${JSON.stringify(line)}`).not.toMatch(/[\u001b\u0007\u0080-\u009f‪-‮⁦-⁩]/u);
        }
      }
    });
  });
});

describe("clipboard", () => {
  it("copies through OSC 52 with the text base64-encoded", () => {
    expect(clipboardSequence("https://go.example.com/abc1")).toBe(
      `\u001b]52;c;${Buffer.from("https://go.example.com/abc1").toString("base64")}\u0007`
    );
  });

  it("a local Mac also copies through pbcopy (Terminal.app ignores OSC 52); SSH and other systems use OSC 52 only", () => {
    expect(copyTargets({}, "darwin")).toEqual({ osc52: true, pbcopy: true });
    expect(copyTargets({ SSH_TTY: "/dev/ttys001" }, "darwin")).toEqual({ osc52: true, pbcopy: false });
    expect(copyTargets({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "darwin")).toEqual({ osc52: true, pbcopy: false });
    expect(copyTargets({}, "linux")).toEqual({ osc52: true, pbcopy: false });
    expect(copyTargets({}, "win32")).toEqual({ osc52: true, pbcopy: false });
  });

  it("never copies an escape: the text is scrubbed before it is encoded", () => {
    const sequence = clipboardSequence("a\u001b]0;x\u0007b");
    const payload = sequence.slice("\u001b]52;c;".length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("ab");
  });
});

// Contract revision 3: a list may name its row-name column (`nameLabel`) and a
// record may carry its own status (r4 view-02 / view-03; Cmd+L r2 draws the
// same words as the list head cell and the record's head chip).
describe("rev 3: a list's name column head and a record's own status", () => {
  /** Two money columns: not r4's self-describing row grammar, so the header row draws. */
  const headed = (body: Record<string, unknown> = {}) => withBody("list-rows", {
    columns: [{ key: "spend", label: "Spend", unit: "money" }, { key: "cpc", label: "CPC", unit: "money" }, { key: "trials", label: "Trials", unit: "count" }],
    ...body
  });

  it("the name column's head reads nameLabel, over the row titles", () => {
    const render = draw(headed({ nameLabel: "Ad" }));
    const header = render.detail[0]!;
    const firstRow = render.detail[1]!;
    expect(header.indexOf("Ad")).toBe(firstRow.indexOf("Hook A"));
    expect(header).toMatch(/Spend/u);
    // The value columns' heads stay where they were without it.
    const without = draw(headed()).detail[0]!;
    expect(without.slice(without.indexOf("Spend") - 2)).toBe(header.slice(header.indexOf("Spend") - 2));
    expect(without.trimStart().startsWith("Spend")).toBe(true);
  });

  it("a short-name list widens its name column to fit the head, as a value column fits its label", () => {
    const rows = ["US", "EU", "UK"].map((title, index) => ({
      id: `c_${index}`, title, status: { word: "on", tone: "ok" },
      cells: { spend: { value: 100 + index }, cpc: { value: 1.5 }, trials: { value: index } }
    }));
    for (const width of [60, 100]) {
      const render = draw(headed({ nameLabel: "Campaign", rows }), { width });
      const header = render.detail[0]!;
      const firstRow = render.detail[1]!;
      expect(header, `@${width}`).toContain("Campaign");
      expect(header, `@${width}`).not.toContain("…");
      expect(header.indexOf("Campaign"), `@${width}`).toBe(firstRow.indexOf("US"));
      // Each value head still ends over its own right-aligned column.
      const firstCell = /US\s+(\S+)/u.exec(firstRow)!;
      expect(header.indexOf("Spend") + "Spend".length, `@${width}`).toBe(firstCell.index + firstCell[0].length);
    }
    // The same rule keeps "Ad set" whole over an ad set named "Broad".
    const broad = [{ id: "s_1", title: "Broad", cells: { spend: { value: 10 }, cpc: { value: 1 }, trials: { value: 1 } } }];
    expect(draw(headed({ nameLabel: "Ad set", rows: broad })).detail[0]).toContain("Ad set");
  });

  it("a long nameLabel is cut only where the pane cannot fit it, never pushing a line past the pane", () => {
    const label = "Ad name as the host words it in a header far longer than any pane has room for at all";
    for (const width of [48, 60, 100, 140]) {
      const render = draw(headed({ nameLabel: label }), { width });
      const header = render.detail[0]!;
      expect(header, `@${width}`).toContain("…");
      expect(header, `@${width}`).toMatch(/Spend/u);
      expect(allLines(render).filter((line) => line.length > width), `@${width}`).toEqual([]);
    }
    // With room, a mid-length head is drawn whole.
    expect(draw(headed({ nameLabel: "Ad name as the host words it" }), { width: 100 }).detail[0]).toContain("Ad name as the host words it");
  });

  it("a self-describing list draws no head, so nameLabel never widens its name column", () => {
    const rows = ["US", "EU"].map((title, index) => ({ id: `c_${index}`, title, cells: { spend: { value: 10 }, trials: { value: index } } }));
    expect(draw(withBody("list-rows", { nameLabel: "Campaign name", rows, currency: "USD" })).detail)
      .toEqual(draw(withBody("list-rows", { rows, currency: "USD" })).detail);
  });

  it("r4's self-describing rows keep no header row, with or without nameLabel", () => {
    expect(draw(withBody("list-rows", { nameLabel: "Ad", currency: "USD" })).detail).toEqual(draw(withBody("list-rows", { currency: "USD" })).detail);
  });

  it("the record's head line shows its status word first, the way a list row does", () => {
    const render = draw(withBody("record-ad", { title: "Ad “Hook B · founder POV”", status: { word: "Paused", tone: "muted" } }));
    expect(render.detail[0]).toBe("● Paused  Ad “Hook B · founder POV”");
    expect(render.detail[1]).toBe("");
    // Without a title the status still shows, on its own line.
    expect(draw(withBody("record-ad", { status: { word: "Active", tone: "ok" } })).detail.slice(0, 2)).toEqual(["● Active", ""]);
  });

  it("the status word is drawn in its tone", () => {
    const ok = draw(withBody("record-ad", { title: "Ad “Hook B”", status: { word: "Active", tone: "ok" } }), { color: true }).detail[0]!;
    expect(ok).toContain(ansiFg(theme, "success"));
    expect(stripAnsi(ok)).toBe("● Active  Ad “Hook B”");
    const bad = draw(withBody("record-ad", { title: "Ad “Hook B”", status: { word: "Rejected", tone: "bad" } }), { color: true }).detail[0]!;
    expect(bad).toContain(ansiFg(theme, "error"));
  });

  it("a status with a tone the contract does not name never draws", () => {
    const render = draw(withBody("record-ad", { title: "Ad “Hook B”", status: { word: "Loud", tone: "neon" } }));
    expect(render.detail[0]).toBe("Ad “Hook B”");
    expect(text(render)).not.toContain("Loud");
  });

  it("renderer withholds a status with an unknown tone even when the view skipped the decoder", () => {
    const base = JSON.parse(readFileSync(`${FIXTURES}record-ad.json`, "utf8")) as Record<string, unknown>;
    const raw = {
      ...base,
      body: { ...(base.body as Record<string, unknown>), title: "Ad “Hook B”", status: { word: "Loud", tone: "neon" } }
    } as unknown as AnswerViewV1;
    const render = draw(raw);
    expect(render.detail[0]).toBe("Ad “Hook B”");
    expect(text(render)).not.toContain("Loud");
  });

  it("a record without status draws as before", () => {
    expect(draw(withBody("record-ad", { title: "Ad “Hook B”" })).detail[0]).toBe("Ad “Hook B”");
  });

  it("a long title with a status wraps under the title, never wider than the pane", () => {
    const title = "Ad “Hook B · founder POV · a much longer name than the pane holds at sixty”";
    for (const width of [48, 60, 100, 140]) {
      const render = draw(withBody("record-ad", { title, status: { word: "Paused", tone: "muted" } }), { width });
      expect(render.detail[0]!.startsWith("● Paused  Ad “Hook B")).toBe(true);
      expect(allLines(render).filter((line) => line.length > width), `@${width}`).toEqual([]);
      const words = render.detail.slice(0, render.detail.indexOf("")).map((line, index) => (index === 0 ? line.slice(10) : line.trimStart())).join(" ");
      expect(words).toBe(title);
    }
  });
});
