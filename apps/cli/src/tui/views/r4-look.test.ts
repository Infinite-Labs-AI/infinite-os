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
