// The measure and thing views against round 4's look (restyle lane R3).
//
// Each expectation is a line of the synthetic r4 goldens (synthetic data only:
// infinite-os is public), written as `{style}text` segments: the renderer's
// truecolor output is read back into r4 tokens and normalised the way the
// golden comparator does (`golden_compare.py` `token_of` + `normalize`), so a
// wrong colour, weight, background or underline fails here, not only wrong text.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

// ── truecolor ANSI → r4 tokens ──

const FG: Record<string, string> = {
  "6d7986": "dim", "3a4653": "line", "56c8e8": "cyan", ffffff: "white", "6fd08c": "green",
  e9b44c: "amber", ef6b73: "red", "46525e": "hatch", "7aa7ff": "blue"
};
const BOLD: Record<string, string> = { cyan: "cb", amber: "ab", green: "gb", red: "rb", blue: "bb", white: "b" };
const BG: Record<string, string> = { "56c8e8": "inv", "2a3440": "key", e9b44c: "pk", "22303b": "tag", "1b2f3a": "sel" };
/** A chip's own foreground and weight (anything else is named next to the chip). */
const CHIP: Record<string, { fg: string; bold: boolean }> = {
  inv: { fg: "0a0d11", bold: true }, key: { fg: "ffffff", bold: false }, pk: { fg: "0a0d11", bold: true }, tag: { fg: "ffffff", bold: true }
};
const BG_TOKENS = new Set(["inv", "key", "pk", "tag", "sel"]);

interface Cell { ch: string; style: string }
interface Pen { fg: string; bg: string; bold: boolean; underline: boolean; inverse: boolean }

const hex = (r: string, g: string, b: string) => [r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("");

function tokenOf(pen: Pen, ch: string): string {
  const tokens = new Set<string>();
  let fg = pen.fg;
  let bold = pen.bold;
  if (pen.bg) {
    const bg = BG[pen.bg] ?? `?bg${pen.bg}`;
    tokens.add(bg);
    const chip = CHIP[bg];
    if (chip) {
      if (!/\s/u.test(ch)) {
        if (fg !== chip.fg) tokens.add(`?chipfg${fg || "default"}`);
        if (bold !== chip.bold) tokens.add("?chipbold");
      }
      fg = "";
      bold = false;
    }
  }
  if (pen.inverse) tokens.add("inverse");
  if (pen.underline) tokens.add("u");
  if (fg) {
    const base = FG[fg];
    tokens.add(base === undefined ? `?${fg}` : bold ? BOLD[base] ?? `${base}+bold` : base);
  } else if (bold) {
    tokens.add("bold");
  }
  return [...tokens].sort().join(" ");
}

function cellsOf(line: string): Cell[] {
  const pen: Pen = { fg: "", bg: "", bold: false, underline: false, inverse: false };
  const cells: Cell[] = [];
  const parts = line.split(/(\u001b\[[0-9;]*m)/u);
  for (const part of parts) {
    const sgr = /^\u001b\[([0-9;]*)m$/u.exec(part);
    if (!sgr) {
      for (const ch of part) cells.push({ ch, style: tokenOf(pen, ch) });
      continue;
    }
    const params = (sgr[1] || "0").split(";");
    for (let i = 0; i < params.length; i += 1) {
      const p = params[i];
      if (p === "0") Object.assign(pen, { fg: "", bg: "", bold: false, underline: false, inverse: false });
      else if (p === "1") pen.bold = true;
      else if (p === "22") pen.bold = false;
      else if (p === "4") pen.underline = true;
      else if (p === "24") pen.underline = false;
      else if (p === "7") pen.inverse = true;
      else if (p === "27") pen.inverse = false;
      else if (p === "39") pen.fg = "";
      else if (p === "49") pen.bg = "";
      else if ((p === "38" || p === "48") && params[i + 1] === "2") {
        const value = hex(params[i + 2]!, params[i + 3]!, params[i + 4]!);
        if (p === "38") pen.fg = value; else pen.bg = value;
        i += 4;
      } else {
        throw new Error(`unexpected SGR ${p} in ${JSON.stringify(line)}`);
      }
    }
  }
  return cells;
}

/** One line as golden segments, printed `{style}text` (unstyled text bare). */
function seg(line: string): string {
  const cells = cellsOf(line);
  const hasBg = (style: string) => style.split(" ").some((t) => BG_TOKENS.has(t) || t.startsWith("?bg") || t === "inverse");
  const blank = (i: number) => /\s/u.test(cells[i]!.ch) && !hasBg(cells[i]!.style) && !cells[i]!.style.split(" ").includes("u");
  for (let i = 0; i < cells.length;) {
    if (!blank(i)) { i += 1; continue; }
    let j = i;
    while (j < cells.length && blank(j)) j += 1;
    const prev = i > 0 ? cells[i - 1]!.style : null;
    const next = j < cells.length ? cells[j]!.style : null;
    const style = prev !== null && prev === next ? prev : "";
    for (let k = i; k < j; k += 1) cells[k]!.style = style;
    i = j;
  }
  const out: Cell[] = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last.style === cell.style) last.ch += cell.ch;
    else out.push({ ...cell });
  }
  while (out.length) {
    const last = out[out.length - 1]!;
    if (hasBg(last.style)) break;
    const trimmed = last.ch.trimEnd();
    if (trimmed === last.ch) break;
    if (trimmed) { last.ch = trimmed; break; }
    out.pop();
  }
  return out.map((cell) => (cell.style ? `{${cell.style}}` : "") + cell.ch).join("");
}

// ── fixtures ──

const theme = resolveTheme({ COLORTERM: "truecolor" }, { isTTY: true });

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: true, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: true, watch: false, retry: false }, timeZone: "UTC", ...overrides
});

function view(overrides: Record<string, unknown>): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "numbers", tool: "read_ads", title: "Google Ads since launch", state: "ready", asOf: "2026-09-30",
    provenance: { source: "Google Ads", via: "our_db" },
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { layout: "table", currency: "USD", columns: [] }, ...overrides
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

/** The details pane as r4 stacks it: head, source, a blank row, the detail. */
function pane(render: ReturnType<typeof renderView>): string[] {
  return [render.head, ...(render.source ? [render.source] : []), "", ...render.detail].map(seg);
}

describe("the head and the source line (r4)", () => {
  it("the title is a tag chip, the state follows in its tone, the source is dim", () => {
    const render = renderView(view({}), ctx());
    expect(pane(render).slice(0, 2)).toEqual([
      "{tag} Google Ads since launch  {green}✓ Ready",
      "{dim}Google Ads · up to Sep 30"
    ]);
  });

  it("needs-you heads are bold amber (view-11)", () => {
    const render = renderView(view({ kind: "link", title: "Tracked link", state: "needs_yes", body: { target: "url", minted: false, opened: false, warnings: [] } }), ctx());
    expect(seg(render.head)).toBe("{tag} Tracked link  {ab}▣ Needs your OK");
  });

  it("a state reason's short words head the view (flow-numbers-02, flow-images-07)", () => {
    expect(seg(renderView(view({ state: "not_measured", stateReason: { code: "nm", words: "Conversion value is not tracked.", short: "1 not measured" } }), ctx()).head))
      .toBe("{tag} Google Ads since launch  {dim}— 1 not measured");
    expect(seg(renderView(view({ title: "Make 3 creatives", state: "cmdl_only", stateReason: { code: "q", words: "Quick drafts start only in Cmd+L.", short: "Cmd+L only" } }), ctx()).head))
      .toBe("{tag} Make 3 creatives  {bb}⌘ Cmd+L only");
  });

  it("a head too narrow for the chip keeps the state in its tone (it never turns plain)", () => {
    const narrow = renderView(view({ kind: "link", title: "Tracked link", state: "needs_yes", body: { target: "url", minted: false, opened: false, warnings: [] } }), ctx({ width: 18 }));
    expect(seg(narrow.head)).toBe("{ab}▣ Needs your OK");
  });

  it("without colour the chip prints as same-width brackets", () => {
    expect(renderView(view({}), ctx({ color: false })).head).toBe("[Google Ads since launch] ✓ Ready");
  });
});

describe("the state reason (flow-numbers-03…06)", () => {
  it("the sentence leads with the state's glyph, in the state's tone", () => {
    const partial = renderView(view({ state: "partial", stateReason: { code: "p", words: "1 of 2 days in · Sep 30 not in yet" } }), ctx());
    expect(pane(partial)).toEqual([
      "{tag} Google Ads since launch  {amber}◐ Partial",
      "{dim}Google Ads · up to Sep 30",
      "",
      "{amber}◐ 1 of 2 days in · Sep 30 not in yet"
    ]);
    const old = renderView(view({ state: "out_of_date", stateReason: { code: "o", words: "Last synced Sep 30 11:15 UTC (24 h ago) · up to Sep 29 · today's 11:15 sync hasn't landed" } }), ctx());
    expect(pane(old).slice(3)).toEqual([
      "{amber}⧗ Last synced Sep 30 11:15 UTC (24 h ago) · up to Sep 29 · today's 11:15 sync hasn't landed"
    ]);
    const none = renderView(view({ state: "nothing_found", stateReason: { code: "n", words: "No spend Sep 24–28 · 3 campaigns checked" } }), ctx());
    expect(pane(none)).toEqual([
      "{tag} Google Ads since launch  {dim}∅ Nothing found",
      "{dim}Google Ads · up to Sep 30",
      "",
      "{dim}∅ No spend Sep 24–28 · 3 campaigns checked"
    ]);
  });

  it("a fix the app can open is a link, then where it opens (flow-numbers-05)", () => {
    const render = renderView(view({
      state: "not_connected",
      stateReason: { code: "nc", words: "Google Ads isn't connected", fix: { label: "Connect it in the app", appLink: { place: "connections", label: "Connections" } } }
    }), ctx());
    expect(pane(render).slice(3)).toEqual([
      "{amber}⊘ Google Ads isn't connected",
      "",
      "{cyan u}Connect it in the app ↗  {dim}(o) · Connections"
    ]);
  });

  it("the needs-you sentence is amber, not bold; a sentence that already leads with the glyph keeps one", () => {
    const render = renderView(view({ state: "needs_yes", stateReason: { code: "y", words: "▣ Waiting for your OK." } }), ctx());
    expect(render.detail.map(seg)).toEqual(["{amber}▣ Waiting for your OK."]);
  });
});

// ── the thing views (view-02 list, view-03 record, view-04 document) ──

function thing(kind: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}): AnswerViewV1 {
  return view({ kind, title: "Thing", provenance: undefined, asOf: null, body, ...extra });
}

describe("list (view-02)", () => {
  const list = () => thing("list", {
    layout: "rows", total: 3, shown: 3,
    columns: [{ key: "spend", label: "", unit: "money" }, { key: "ctr", label: "" }, { key: "trials", label: "" }],
    rows: [
      { id: "a", title: "Ad set 01 · demo loop", status: { word: "on", tone: "ok" }, cells: { spend: { value: 18.2 }, ctr: { text: "1.32%" }, trials: { text: "3 trials" } } },
      { id: "b", title: "Ad set 02 · founder", status: { word: "on", tone: "ok" }, cells: { spend: { value: 12.4 }, ctr: { text: "0.41%" }, trials: { text: "0 trials" } },
        detail: [{ label: "", value: { text: "Ad set 02 · since Sep 24 · Broad" } }] }
    ]
  });

  it("status first in its tone; the selected row is ▸ on the selection background, its title bold, padded to the pane", () => {
    const render = renderView(list(), ctx({ selected: 1, width: 60 }));
    expect(render.detail.map(seg)).toEqual([
      "  {green}● on  Ad set 01 · demo loop  18.20  1.32%  3 trials",
      `{cb sel}▸ {green sel}● on  {b sel}Ad set 02 · founder  {sel}  12.40  0.41%  0 trials${" ".repeat(7)}`,
      "",
      "{dim}Ad set 02 · since Sep 24 · Broad"
    ]);
    expect(displayWidth(render.detail[1]!)).toBe(60);
  });

  it("without colour the selected row is only the ▸ marker, never padded", () => {
    const render = renderView(list(), ctx({ selected: 1, width: 60, color: false }));
    expect(render.detail[1]).toBe("▸ ● on  Ad set 02 · founder    12.40  0.41%  0 trials");
  });
});

describe("record (view-03)", () => {
  it("dim labels padded so values line up 14 in, a bold History, dim times", () => {
    const render = renderView(thing("record", {
      fields: [{ label: "campaign", value: { text: "Demo trials" } }, { label: "spend 7d", value: { value: 12.4 }, unit: "money" }],
      history: [{ at: "2026-09-24T09:12:00Z", from: null, to: "on", who: "Robin" }]
    }), ctx());
    expect(render.detail.map(seg)).toEqual([
      "{dim}campaign      Demo trials",
      "{dim}spend 7d      12.40",
      "",
      "{b}History",
      "{dim}Sep 24, 09:12  — → on · by Robin"
    ]);
    expect(render.detail[0]!.replace(/\u001b\[[0-9;]*m/gu, "").indexOf("Demo")).toBe(14);
  });

  it("a next step is a selectable row: ▸, a dim arrow, the words bold on the selection", () => {
    const render = renderView(thing("record", { fields: [] }, { next: [{ label: "Pause it", ask: "pause it" }] }), ctx({ width: 30 }));
    expect(render.detail.map(seg)).toEqual([`{cb sel}▸ {dim sel}→ {b sel}Pause it{sel}${" ".repeat(18)}`]);
  });
});

describe("document (view-04)", () => {
  const doc = () => thing("document", {
    meta: [{ label: "Subject", value: "Your trial ended" }],
    sections: [{ text: "Hi {first name},\n\nBefore your trial ended.", format: "plain" }, { text: "Two", format: "plain" }],
    versions: [{ id: "1", label: "Email 1", sectionIndexes: [0] }, { id: "2", label: "Email 2", sectionIndexes: [1] }]
  });

  it("the open tab is the brand chip, the rest dim; the body hangs off a │ in the rule colour", () => {
    expect(renderView(doc(), ctx()).detail.map(seg)).toEqual([
      "{inv} 1 Email 1   {dim}2 Email 2",
      "",
      "{dim}Subject  Your trial ended",
      "",
      "{line}│ Hi {first name},",
      "{line}│",
      "{line}│ Before your trial ended."
    ]);
  });

  it("without colour the open tab is bracketed", () => {
    expect(renderView(doc(), ctx({ color: false })).detail[0]).toBe("[1 Email 1]  2 Email 2");
  });
});

describe("link (view-11 body)", () => {
  it("a minted link is bold, with the c key chip once engaged; an app place is a cyan underlined link", () => {
    const minted = renderView(thing("link", { target: "url", minted: true, opened: false, warnings: [], shortUrl: "go.example.com/rdt" }), ctx({ engaged: true }));
    expect(seg(minted.detail[0]!)).toBe("{b}go.example.com/rdt  {key} c  copy");
    const place = renderView(thing("link", { target: "app_place", minted: false, opened: false, warnings: [], appPlace: { place: "library", label: "Library" } }), ctx());
    expect(seg(place.detail[0]!)).toBe("{cyan u}Library ↗  {dim}(o)");
  });
});

// ── the measure views (view-01 numbers, view-09 compare, view-10 health, flow-numbers-03) ──

describe("health (view-10)", () => {
  it("glyph in tone, name plain, bad words amber, freshness dim; the fix after the rows as a link", () => {
    const item = (name: string, dataThrough: string) => ({ id: name, name, state: "ok", dataThrough });
    const render = renderView(thing("health", {
      items: [
        item("GA4", "2026-09-30"), item("Google Ads", "2026-09-30"),
        { id: "s", name: "Shopify", state: "not_connected", blocker: "sign-in expired", dataThrough: "2026-09-28",
          fix: { label: "Reconnect Shopify", appLink: { place: "connections", label: "Connections, in the app" } } }
      ]
    }), ctx());
    expect(render.detail.map(seg)).toEqual([
      "{green}✓ GA4         connected        {dim}up to Sep 30",
      "{green}✓ Google Ads  connected        {dim}up to Sep 30",
      "{amber}⊘ Shopify     {amber}sign-in expired  {dim}up to Sep 28",
      "",
      "{dim}Fix it: {cyan u}Reconnect Shopify ↗  {dim}(o) · Connections, in the app"
    ]);
  });
});

describe("compare (view-09)", () => {
  it("the server's verdict: the grade glyph in tone, the sentence bold white, what is unmet dim", () => {
    const render = renderView(thing("compare", {
      window: { from: "2026-09-24", to: "2026-09-30", tz: "UTC", label: "" },
      arms: [], metricRows: [], differences: [],
      verdict: { sentence: "No winner yet", grade: "inconclusive", unmet: ["Day 6 of 14 · check again Oct 9"], namesWinner: false }
    }), ctx());
    expect(render.detail.map(seg).slice(-2)).toEqual(["{amber}◌ {b}No winner yet", "{dim}Day 6 of 14 · check again Oct 9"]);
  });
});

describe("numbers: the day strip (view-01, flow-numbers-03)", () => {
  const days = (statuses: string[], from = 24) => statuses.map((status, index) => ({ date: `2026-09-${from + index}`, status }));
  const numbers = (settledDays: { date: string; status: string }[], todayTo: string | null) => view({
    body: {
      layout: "table", currency: "USD", columns: [],
      legs: {
        settled: { window: { from: "2026-09-24", to: "2026-09-30", tz: "UTC", label: "" }, final: true, asOf: null, rows: [],
          coverage: { requestedDays: settledDays.length, measuredDays: 0, days: settledDays } },
        ...(todayTo ? { today: { window: { from: todayTo, to: todayTo, tz: "UTC", label: "" }, final: false, asOf: "2026-10-01T10:40:00Z", rows: [] } } : {})
      }
    }
  });

  it("Days bold, dates dim, a zero day dim, a measured day cyan, today amber; the legend hangs under the strip", () => {
    const render = renderView(numbers(days(["zero", "zero", "zero", "zero", "zero", "measured", "measured"]), "2026-10-01"), ctx());
    const strip = render.detail.map(seg).filter((line) => line.startsWith("{b}Days") || line.startsWith("     "));
    expect(strip).toEqual([
      "{b}Days {dim}Sep 24 ·····{cyan}██{amber}◌ {dim}Oct 1",
      "     {dim}0 of 7 days measured   · zero   █ measured   ◌ today"
    ]);
  });

  it("a day not synced yet is the hatch ░, never a zero (flow-numbers-03)", () => {
    const render = renderView(numbers(days(["measured", "not_synced"], 29), null), ctx());
    expect(render.detail.map(seg)).toContain("{b}Days {dim}Sep 29 {cyan}█{hatch}░ {dim}Sep 30");
  });
});
