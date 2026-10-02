// T10: the "things" views — list, record, document, link and quiet. Every rule
// here is pinned by a CI-run pure test (the PTY tests are CI-skipped).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Key } from "ink";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { ansiFg, resolveTheme } from "../theme.js";
import { clipboardSequence } from "./clipboard.js";
import { documentPageLines } from "./document.js";
import { resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts, viewKeyHints, type ViewFocusState } from "./focus.js";
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
    expect(render.detail.find((line) => line.startsWith("▸"))).toContain("→ Pause it");
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
    const per = documentPageLines(rows);
    const first = draw(v, { rows });
    expect(first.pages).toBe(Math.ceil(60 / per));
    expect(text(first)).toContain("Line 1 of");
    expect(text(first)).not.toContain(`Line ${per + 1} of`);
    const second = draw(v, { rows, page: 1 });
    expect(text(second)).toContain(`Line ${per + 1} of`);
    expect(text(second)).not.toContain("Line 1 of");
    // A narrower window wraps into more lines, so more pages.
    const wrapped = Array.from({ length: 60 }, () => "word ".repeat(12).trim()).join("\n");
    const wide = draw(view({ kind: "document", body: { meta: [], sections: [{ text: wrapped, format: "plain" }] } }), { rows, width: 120 });
    const narrow = draw(view({ kind: "document", body: { meta: [], sections: [{ text: wrapped, format: "plain" }] } }), { rows, width: 40 });
    expect(narrow.pages!).toBeGreaterThan(wide.pages!);
    // space moves to the next page.
    let state = viewFocusAfterTurnDone(v);
    expect(state.focus).toBe("document");
    state = resolveViewKey(" ", state, {}, viewKeyFacts(v, draw(v, { rows })));
    expect(state.page).toBe(1);
  });

  it("prints its meta and the truncation of a long body", () => {
    const v = withBody("document-versions", { truncated: { shownChars: 2000, totalChars: 9000, editable: false } });
    const out = text(draw(v));
    expect(out).toMatch(/From\s+Demo Team/u);
    expect(out).toContain("2,000 of 9,000 characters");
  });
});

describe("link", () => {
  it("the minted URL renders on one line with `c copy`", () => {
    const render = draw(fixture("link-minted"));
    const line = render.detail.find((l) => l.includes("https://go.example.com/abc1"))!;
    expect(line).toMatch(/https:\/\/go\.example\.com\/abc1\s+c copy$/u);
    expect(render.copyText).toBe("https://go.example.com/abc1");
    expect(text(render)).toMatch(/source\s+forum/u);
    expect(text(render)).toMatch(/to\s+https:\/\/example\.com\/landing/u);
    // Too narrow for both: the URL is cut, the copy key stays on the line, and c copies it whole.
    const narrow = draw(fixture("link-minted"), { width: 30 });
    const cut = narrow.detail.find((l) => l.includes("c copy"))!;
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
    expect(resolveViewKey("c", engaged).effect).toEqual({ type: "copy", text: "https://go.example.com/abc1" });
  });

  it("a link not minted yet has nothing to copy", () => {
    const render = draw(withBody("link-minted", { minted: false, shortUrl: undefined }));
    expect(render.copyText).toBeUndefined();
    expect(text(render)).not.toContain("c copy");
  });

  it("an app place prints its label, with (o) only when the session can open the app", () => {
    const v = view({
      kind: "link",
      body: { target: "app_place", minted: false, opened: false, warnings: [], appPlace: { place: "library", label: "Library", selectionCount: 3 } }
    });
    expect(text(draw(v))).toContain("↗ Library · 3 selected");
    expect(text(draw(v))).not.toContain("(o)");
    expect(text(draw(v, { caps: { open: true, watch: false, retry: false } }))).toContain("↗ Library · 3 selected (o)");
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

describe("scrub sweep: no escape or bidi character reaches the TTY", () => {
  const ESC = "\u001b[2J\u001b]52;c;aGk=\u0007";
  const BIDI = "‮⁦‏";
  const dirty = (s: string) => `${s}${ESC}${BIDI}`;

  const views: AnswerViewV1[] = [
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
    view({ kind: "quiet", body: { stepLine: dirty("step"), degraded: true } })
  ];

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
    for (const v of views) {
      const render = draw(v, { color: true });
      for (const line of allLines(render)) {
        expect(stripAnsi(line)).not.toMatch(/[\u001b\u0007‪-‮⁦-⁩]/u);
      }
    }
  });
});

describe("clipboard", () => {
  it("copies through OSC 52 with the text base64-encoded", () => {
    expect(clipboardSequence("https://go.example.com/abc1")).toBe(
      `\u001b]52;c;${Buffer.from("https://go.example.com/abc1").toString("base64")}\u0007`
    );
  });

  it("never copies an escape: the text is scrubbed before it is encoded", () => {
    const sequence = clipboardSequence("a\u001b]0;x\u0007b");
    const payload = sequence.slice("\u001b]52;c;".length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("ab");
  });
});
