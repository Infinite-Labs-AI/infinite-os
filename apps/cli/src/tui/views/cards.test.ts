// The r4 cards and receipts, token by token (terminal-r4 spec §5 "Card",
// "Receipts"; R4). Every expected row below is the synthetic r4 golden's own
// segments (`spec/terminal/goldens/synthetic/`), as `[style, text]` pairs after
// the goldens' normalization, so a drift in a border colour, a chip or a bold
// value fails here. Where the CLI deliberately differs from the golden (a key
// the terminal does not bind yet is not drawn), the test says so.
import type { AnswerViewV1 } from "@infinite-os/types";
import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { resolveKey } from "../keys/keymap.js";
import { displayWidth } from "../lib/display-width.js";
import { sgrParams } from "../style/sgr.js";
import type { Token } from "../style/tokens.js";
import { DEFAULT_THEME } from "../theme.js";
import { approvalRender, CARD_UI_START, cardKeyStep, type ApprovalRenderCtx, type CardUiState } from "./approval.js";
import { cardBox, chipRows, fieldRows, beforeAfter, paragraphIn } from "./card.js";
import { viewKeyFacts } from "./focus.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

// ── the golden segment model: ANSI → [style, text] runs (truecolor) ──

type Seg = [style: string, text: string];
interface Cell { ch: string; style: string }
interface SgrState { fg: string | null; bg: string | null; bold: boolean; underline: boolean; inverse: boolean }
const RESET: SgrState = { fg: null, bg: null, bold: false, underline: false, inverse: false };

function applySgr(state: SgrState, params: string): SgrState {
  const next = { ...state };
  const codes = params === "" ? [0] : params.split(";").map(Number);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code === 0) Object.assign(next, RESET);
    else if (code === 1) next.bold = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) next.bold = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const colour = codes.slice(i + 2, i + 5).join(",");
      if (code === 38) next.fg = colour;
      else next.bg = colour;
      i += 4;
    }
  }
  return next;
}

const STYLES: readonly (readonly Token[])[] = [
  ["dim"], ["line"], ["cyan"], ["b"], ["green"], ["amber"], ["red"], ["hatch"], ["blue"],
  ["cb"], ["ab"], ["gb"], ["rb"], ["bb"], ["inv"], ["key"], ["pk"], ["tag"], ["sel"], ["cyan", "u"]
];
const STYLE_OF = new Map(STYLES.map((tokens) => [
  JSON.stringify(applySgr(RESET, sgrParams(tokens, "truecolor"))),
  [...tokens].sort().join(" ")
]));
STYLE_OF.set(JSON.stringify(RESET), "");

const BG = new Set(["key", "pk", "inv", "tag", "sel"]);
const keeps = (style: string) => style.split(" ").some((token) => BG.has(token) || token === "u");

/** One painted line as the goldens' normalized `[style, text]` segments. */
function segs(line: string): Seg[] {
  const cells: Cell[] = [];
  let state = RESET;
  const parts = line.split(/(\u001b\[[0-9;]*m)/u);
  for (const part of parts) {
    const sgr = /^\u001b\[([0-9;]*)m$/u.exec(part);
    if (sgr) {
      state = applySgr(state, sgr[1]!);
      continue;
    }
    const style = STYLE_OF.get(JSON.stringify(state)) ?? `?${JSON.stringify(state)}`;
    for (const ch of part) cells.push({ ch, style });
  }
  // Whitespace takes no style unless both neighbours share one (chips and links keep theirs).
  const foldable = (i: number) => /^\s$/u.test(cells[i]!.ch) && !keeps(cells[i]!.style);
  for (let i = 0; i < cells.length;) {
    if (!foldable(i)) { i += 1; continue; }
    let end = i;
    while (end < cells.length && foldable(end)) end += 1;
    const before = i > 0 ? cells[i - 1]!.style : null;
    const after = end < cells.length ? cells[end]!.style : null;
    for (let k = i; k < end; k += 1) cells[k]!.style = before !== null && before === after ? before : "";
    i = end;
  }
  const out: Seg[] = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last[0] === cell.style) last[1] += cell.ch;
    else out.push([cell.style, cell.ch]);
  }
  while (out.length) {
    const last = out[out.length - 1]!;
    if (keeps(last[0])) break;
    const trimmed = last[1].replace(/\s+$/u, "");
    if (trimmed === last[1]) break;
    if (trimmed) { last[1] = trimmed; break; }
    out.pop();
  }
  return out;
}

const box = (width: number, tone: string): { blank: Seg[]; bottom: Seg[] } => ({
  blank: [[tone, `│${" ".repeat(width - 2)}│`]],
  bottom: [[tone, `└${"─".repeat(width - 2)}┘`]]
});
/** `│ <segments><pad> │` in `tone`, padded to `width` the way the goldens fold it. */
function row(width: number, tone: string, ...content: Seg[]): Seg[] {
  const used = content.reduce((n, [, text]) => n + [...text].length, 0);
  const lead: Seg[] = [[tone, "│"], ["", " "]];
  const pad = " ".repeat(width - 4 - used + 1);
  const merged: Seg[] = [...lead];
  for (const seg of [...content, ["", pad] as Seg]) {
    const last = merged[merged.length - 1]!;
    if (last[0] === seg[0]) last[1] += seg[1];
    else merged.push([...seg]);
  }
  merged.push([tone, "│"]);
  return merged;
}

// ── synthetic views (the r4 flows' data, as in the public goldens) ──

const theme = DEFAULT_THEME;
const NO_CAPS = { open: false, watch: false, retry: false } as const;
const OPEN = { open: true, watch: false, retry: false } as const;
const press = (input: string, key: Partial<Key> = {}) => ({ input, key: key as Key });

function viewCtx(over: Partial<ViewRenderCtx> = {}): ViewRenderCtx {
  return {
    width: 100, color: true, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
    showHiddenColumns: false, caps: NO_CAPS, timeZone: "UTC", ...over
  };
}

function cardCtx(over: Partial<ApprovalRenderCtx> = {}): ApprovalRenderCtx {
  return { ...viewCtx(), ui: CARD_UI_START, fieldsCapable: true, ...over };
}

function decode(raw: Record<string, unknown>): AnswerViewV1 {
  const view = decodeAnswerView({ v: 1, asOf: null, scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], ...raw });
  if (!view) throw new Error("synthetic view does not decode");
  return view;
}

const PAUSE_BODY = {
  target: { kind: "ad", id: "ad_demo_b", label: "Demo B · sample copy" },
  rows: [{ label: "status", before: "on", after: "PAUSED" }],
  effect: "Stops spending",
  warnings: []
};
const PAUSE_APPROVAL = {
  kind: "card", turnId: "turn_r4", handle: "h_pause",
  title: "Pause ad “Demo B · sample copy”?",
  summary: "Stops this ad's spend until you turn it back on.",
  confirmLabel: "Pause", dismissLabel: "Dismiss",
  doneTitle: "Paused ad “Demo B · sample copy”",
  rows: [{ label: "Ad", value: "Demo B · sample copy" }],
  expiresAt: "2026-10-01T10:59:00Z"
};

function pause(over: Record<string, unknown> = {}): AnswerViewV1 {
  return decode({
    kind: "change", tool: "propose_pause_entity", title: "Pause Demo B", state: "needs_yes",
    provenance: { source: "Meta · ad", via: "our_db" },
    appLink: { place: "ads.meta", label: "open in Meta Ads", params: { ad: "ad_demo_b" } },
    body: PAUSE_BODY, approval: PAUSE_APPROVAL, ...over
  });
}

/** The card's rows: from its top border to its bottom border. */
function cardRows(lines: readonly string[]): string[] {
  const top = lines.findIndex((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").startsWith("┌"));
  const bottom = lines.findIndex((line, index) => index > top && line.replace(/\u001b\[[0-9;]*m/gu, "").startsWith("└"));
  return top >= 0 && bottom > top ? lines.slice(top, bottom + 1) : [];
}

// ── the parts ──

describe("card parts (r4 boxed(), lbl(), K(), PK())", () => {
  it("a box is light and square, its title bold white inside the border, the border in the tone", () => {
    const lines = cardBox("Pause ad", ["x"], 20, "amber", { color: true, theme });
    expect(lines.map(segs)).toEqual([
      [["amber", "┌─"], ["", " "], ["b", "Pause ad"], ["", " "], ["amber", "───────┐"]],
      [["amber", "│"], ["", " x                "], ["amber", "│"]],
      [["amber", "└──────────────────┘"]]
    ]);
    expect(lines.every((line) => displayWidth(line) === 20)).toBe(true);
  });

  it("a title too long for the border is cut so the box always closes: ` ─┐` stays (run-r2 MUST 3)", () => {
    const fits = cardBox("Paused ad “Demo B” · Agent proposed · You approved", [], 60, "green", { color: true, theme })[0]!;
    expect(segs(fits)).toEqual([["green", "┌─"], ["", " "], ["b", "Paused ad “Demo B” · Agent proposed · You approved"], ["", " "], ["green", "─────┐"]]);
    const long = "Paused ad “Demo B · sample copy” · Agent proposed · You approved";
    // At 60 the title passes the border: it is cut within the card width less 6, at a word's end
    // (a separator left at the cut goes with it), and ends in "…", then its rule and `┐`.
    expect(segs(cardBox(long, [], 60, "green", { color: true, theme })[0]!))
      .toEqual([["green", "┌─"], ["", " "], ["b", "Paused ad “Demo B · sample copy” · Agent proposed …"], ["", " "], ["green", "────┐"]]);
    // At 69 the title fits but its rule would not: it is cut, at a word's end, so the corner still shows.
    expect(segs(cardBox(long, [], 69, "green", { color: true, theme })[0]!))
      .toEqual([["green", "┌─"], ["", " "], ["b", "Paused ad “Demo B · sample copy” · Agent proposed · You …"], ["", " "], ["green", "───────┐"]]);
    for (const width of [20, 40, 60, 69, 74]) {
      const top = cardBox(long, [], width, "green", { color: true, theme })[0]!;
      expect(displayWidth(top)).toBe(width);
      expect(top.replace(/\u001b\[[0-9;]*m/gu, "").endsWith("─┐"), `${width}`).toBe(true);
    }
  });

  it("a 90-char title on a 74-wide card still ends its top row with ┐ (live S4 receipt, run-r2 MUST 3)", () => {
    const title = `Paused ad “${"Founder story, 30s · ".repeat(3)}” · Proposed by the agent · approved by You`.slice(0, 90);
    expect([...title].length).toBe(90);
    const [top, , bottom] = cardBox(title, ["x"], 74, "green", { color: false, theme });
    expect(displayWidth(top!)).toBe(74);
    expect(top!.endsWith(" ─┐")).toBe(true);
    expect(top!.startsWith("┌─ Paused ad")).toBe(true);
    expect(displayWidth(bottom!)).toBe(74);
  });

  it("field rows pad a dim label to 9, and before → after reads on, a dim arrow, PAUSED in bold", () => {
    const [line] = fieldRows([{ label: "status", value: beforeAfter("on", "PAUSED", { color: true, theme }) }], 65, { color: true, theme });
    expect(segs(line!)).toEqual([["dim", "status"], ["", "   on "], ["dim", "→"], ["", " "], ["b", "PAUSED"]]);
  });

  it("field labels pad to at most 14 (r4 9–14): a longer label sits on its own row, the value under the column (run-2 N6)", () => {
    const plain = { color: false, theme };
    expect(fieldRows([{ label: "Ad", value: "Demo A" }, { label: "Spend, last 7 days", value: "$40.00" }], 60, plain)).toEqual([
      "Ad       Demo A",
      "Spend, last 7 days",
      "         $40.00"
    ]);
    expect(fieldRows([{ label: "ad set", value: "Broad" }, { label: "trials 7d", value: "0" }], 60, plain)).toEqual([
      "ad set     Broad",
      "trials 7d  0"
    ]);
  });

  it("key chips: the OK key on amber with a bold label, the rest on grey, three spaces apart", () => {
    const [line] = chipRows([{ key: "p", label: "Pause" }, { key: "n", label: "dismiss" }], "p", 65, { color: true, theme });
    expect(segs(line!)).toEqual([["pk", " p "], ["", " "], ["b", "Pause"], ["", "   "], ["key", " n "], ["", " dismiss"]]);
    // Without colour the chips keep their width as brackets.
    expect(chipRows([{ key: "p", label: "Pause" }, { key: "n", label: "dismiss" }], "p", 65, { color: false, theme }))
      .toEqual(["[p] Pause   [n] dismiss"]);
  });

  it("chips wrap between chips, never inside one", () => {
    const rows = chipRows([{ key: "p", label: "check again (won't pause twice)" }, { key: "o", label: "open Meta Ads" }], "p", 40, { color: false, theme });
    expect(rows).toEqual(["[p] check again (won't pause twice)", "[o] open Meta Ads"]);
  });
});

// ── the approval card (region-card-needs-ok, view-06-change, flow-pause-01) ──

describe("the approval card, as r4 draws it", () => {
  it("region-card-needs-ok: an amber box, status on → PAUSED, the chips and ? what it does inside", () => {
    const view = pause({ appLink: undefined });
    const render = approvalRender(view, cardCtx({ width: 69 }));
    const { blank, bottom } = box(69, "amber");
    expect(cardRows(render.lines).map(segs)).toEqual([
      [["amber", "┌─"], ["", " "], ["b", "Pause ad “Demo B · sample copy”?"], ["", " "], ["amber", "────────────────────────────────┐"]],
      row(69, "amber", ["dim", "status"], ["", "   on "], ["dim", "→"], ["", " "], ["b", "PAUSED"]),
      blank,
      row(69, "amber", ["pk", " p "], ["", " "], ["b", "Pause"], ["", "   "], ["key", " n "], ["", " dismiss"]),
      blank,
      row(69, "amber", ["key", " ? "], ["", " "], ["dim", "what it does"]),
      bottom
    ]);
    expect(render.lines.every((line) => displayWidth(line) <= 69)).toBe(true);
  });

  it("view-06-change: at 100 columns the card is 74 wide and `o` is named after the place it opens", () => {
    const render = approvalRender(pause(), cardCtx({ width: 100, caps: OPEN }));
    const { blank, bottom } = box(74, "amber");
    expect(cardRows(render.lines).map(segs)).toEqual([
      [["amber", "┌─"], ["", " "], ["b", "Pause ad “Demo B · sample copy”?"], ["", " "], ["amber", "─────────────────────────────────────┐"]],
      row(74, "amber", ["dim", "status"], ["", "   on "], ["dim", "→"], ["", " "], ["b", "PAUSED"]),
      blank,
      row(74, "amber", ["pk", " p "], ["", " "], ["b", "Pause"], ["", "   "], ["key", " n "], ["", " dismiss   "], ["key", " o "], ["", " open in Meta Ads"]),
      blank,
      row(74, "amber", ["key", " ? "], ["", " "], ["dim", "what it does"]),
      bottom
    ]);
  });

  it("the head and the source line sit above the card, then a blank row (flow-pause-01)", () => {
    const render = approvalRender(pause(), cardCtx());
    const plain = render.lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
    expect(plain[0]).toContain("Pause Demo B");
    expect(plain[0]).toContain("▣ Needs your OK");
    expect(segs(render.lines[1]!)).toEqual([["dim", "Meta · ad"]]);
    expect(plain[2]).toBe("");
    expect(plain[3]!.startsWith("┌─ Pause ad “Demo B · sample copy”? ")).toBe(true);
    // The border carries approval.title, never the tool's name.
    expect(plain.join("\n")).not.toContain("propose_pause_entity");
  });

  it("the card does not repeat what its title says: no target line, no Ad row, no effect line", () => {
    const plain = approvalRender(pause(), cardCtx()).lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
    const inside = plain.slice(plain.findIndex((line) => line.startsWith("┌")));
    expect(inside.join("\n")).not.toMatch(/│ Demo B · sample copy/u);
    expect(inside.join("\n")).not.toMatch(/│ Ad /u);
    expect(inside.join("\n")).not.toContain("Stops spending");
    expect(inside.join("\n")).not.toContain("expires");
  });

  it("? opens what it does: the summary and when it expires, inside the card", () => {
    const view = pause();
    const ui: CardUiState = cardKeyStep(resolveKey("?", {} as Key, approvalRender(view, cardCtx()).keyCtx), approvalRender(view, cardCtx()), CARD_UI_START).ui;
    const plain = approvalRender(view, cardCtx({ ui })).lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")).join("\n");
    expect(plain).toContain("│ Stops this ad's spend until you turn it back on.");
    expect(plain).toContain("│ expires Oct 1, 10:59");
  });

  it("while ? is open the chip says `? hide`, and `? what it does` again once closed (live run-4 N12)", () => {
    const view = pause({ appLink: undefined });
    const closed = approvalRender(view, cardCtx({ width: 69 }));
    const open = cardKeyStep(resolveKey("?", {} as Key, closed.keyCtx), closed, CARD_UI_START).ui;
    const opened = approvalRender(view, cardCtx({ width: 69, ui: open }));
    const rows = cardRows(opened.lines);
    expect(segs(rows[rows.length - 2]!)).toEqual(row(69, "amber", ["key", " ? "], ["", " "], ["dim", "hide"]));
    expect(opened.lines.join("\n")).not.toContain("what it does");
    const shut = cardKeyStep(resolveKey("?", {} as Key, opened.keyCtx), opened, open).ui;
    expect(approvalRender(view, cardCtx({ width: 69, ui: shut })).lines.join("\n")).toContain("what it does");
  });

  it("a generic write (target pending_write) shows the app's rows as label  value", () => {
    const view = decode({
      kind: "change", tool: "propose_thing", title: "Change to approve", state: "needs_yes",
      body: { target: { kind: "pending_write", label: "Rename the page?" }, rows: [{ label: "name", after: "Spring sale" }], warnings: [] },
      approval: { ...PAUSE_APPROVAL, title: "Rename the page?", confirmLabel: "Confirm", rows: [{ label: "name", value: "Spring sale" }] }
    });
    const plain = approvalRender(view, cardCtx()).lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
    expect(plain).toContain(`│ name     Spring sale${" ".repeat(51)}│`);
    expect(plain.join("\n")).not.toContain("set to");
  });

  it("the keys still decide only by the named OK key and n, from the chips as from the bar", () => {
    const view = pause();
    const render = approvalRender(view, cardCtx());
    const step = (input: string, key: Partial<Key> = {}) => cardKeyStep(resolveKey(input, key as Key, render.keyCtx), render, CARD_UI_START).effect;
    expect(step("p")).toEqual({ type: "confirm", decision: "approve" });
    expect(step("n")).toEqual({ type: "confirm", decision: "decline" });
    expect(step("", { return: true })).toBeNull();
    expect(step("", { escape: true })).toBeNull();
    expect(step("y")).toBeNull();
    expect(step("P")).toBeNull();
  });

  it("flow-pause-07 still running: the yes already went out, so the card offers only `p check again`, never `n dismiss` (run-r2 MUST 2)", () => {
    const view = pause({
      state: "outcome_unknown", outcome: "unknown", retry: "safe_resend",
      stateReason: { code: "still_running", words: "Meta hasn't confirmed the pause yet.", short: "Still running" },
      approval: { ...PAUSE_APPROVAL, confirmLabel: "check again (won't pause twice)" }
    });
    const render = approvalRender(view, cardCtx());
    // `?` stays (the card says what it does, inside); `n` is gone.
    expect(render.keys.map((hint) => hint.key)).toEqual(["p", "?"]);
    const plain = render.lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")).join("\n");
    expect(plain).toContain(" p  check again (won't pause twice)");
    expect(plain).not.toContain("dismiss");
    // `n` still closes the card (nothing is declined: the yes is out), so the user is never stuck on it.
    expect(cardKeyStep(resolveKey("n", {} as Key, render.keyCtx), render, CARD_UI_START).effect).toEqual({ type: "close" });
  });

  it("view-07-launch: the effect in dim first, the tree (NEW in bold green, names bold), then the chips", () => {
    const view = decode({
      kind: "launch", tool: "propose_launch_ads", title: "Launch 3 ads", state: "needs_yes",
      provenance: { source: "Meta · launch", via: "our_db" },
      appLink: { place: "ads.meta", label: "previews", params: { adset: "adset_broad" } },
      body: {
        tree: [{
          level: "campaign", name: "Sample campaign", fields: [], status: "existing",
          children: [{
            level: "adset", name: "Sample ad set", fields: [], status: "existing",
            children: ["Explained", "Your audit", "3 fixes"].map((name) => ({ level: "ad", name, fields: [], status: "new", children: [] }))
          }]
        }],
        picturesInApp: true
      },
      approval: {
        ...PAUSE_APPROVAL, handle: "h_launch", title: "Launch 3 ads into “Sample ad set”?", summary: "Creates 3 paused ads in this ad set.",
        confirmLabel: "Launch 3 ads", effect: "Lands PAUSED on Meta — nothing spends until you activate it.",
        rows: [{ label: "Ad set", value: "Sample ad set" }]
      }
    });
    const rows = cardRows(approvalRender(view, cardCtx({ caps: OPEN })).lines).map(segs);
    const { blank } = box(74, "amber");
    expect(rows.slice(1, 8)).toEqual([
      row(74, "amber", ["dim", "Lands PAUSED on Meta — nothing spends until you activate it."]),
      blank,
      row(74, "amber", ["", "Campaign  "], ["b", "Sample campaign"]),
      row(74, "amber", ["", "└ Ad set  "], ["b", "Sample ad set"]),
      row(74, "amber", ["", "  └ Ads   "], ["gb", "NEW"], ["", " "], ["b", "Explained · Your audit · 3 fixes"]),
      blank,
      // r4 says "See the Facebook previews in the app"; the terminal keeps its generic words.
      row(74, "amber", ["blue", "↗"], ["", " Pictures show in the app.  "], ["dim", "(o)"])
    ]);
    // r4 view-07 draws `o previews` here; the card's `o` chip says what the bar says (live T4, one o label):
    // `open in <place>` when the link names itself so, else `open` (views/open-target.ts openKeyLabel).
    expect(rows[9]).toEqual(row(74, "amber", ["pk", " l "], ["", " "], ["b", "Launch 3 ads"], ["", "   "], ["key", " n "], ["", " dismiss   "], ["key", " o "], ["", " open"]));
  });
});

// ── the send card and its documents (flow-email-01, flow-email-02) ──

const EMAIL = {
  kind: "launch", tool: "send_email_campaign", title: "Send win-back email", state: "needs_yes",
  provenance: { source: "Email · win-back", via: "our_db" },
  body: {
    audience: { count: 214, basis: "re-counted now", excluded: [{ reason: "left out", count: 9 }], fromLine: "Robin · Infinite" },
    documents: [
      { id: "e1", slot: "Email 1", subject: "Your trial ended. Here's what Infinite found",
        bodyText: "Hi {first name},\n\nBefore your trial ended, Infinite found 3 ads spending with no trials, and one that beat your goal by 40%.\n\nPick up where you left off: store.example/back" },
      { id: "e2", slot: "Email 2", subject: "Still here", bodyText: "The second email." },
      { id: "e3", slot: "Email 3", subject: "Last one", bodyText: "The third email." }
    ],
    picturesInApp: false
  },
  approval: {
    ...PAUSE_APPROVAL, handle: "h_send", title: "Send this to 214 people?", summary: "Enrolls 214 people in the win-back campaign.",
    confirmLabel: "Send to 214 people",
    rows: [
      { label: "subject", value: "Your trial ended. Here's what Infinite found" },
      { label: "to", value: "214 people · re-counted now · 9 left out" },
      { label: "from", value: "Robin · Infinite" },
      { label: "steps", value: "3 — View shows every one" }
    ]
  }
};

describe("the send card (r4 Send an email)", () => {
  it("flow-email-01: the app's rows with dim labels, then v view, the OK key on amber, n dismiss", () => {
    const rows = cardRows(approvalRender(decode(EMAIL), cardCtx()).lines).map(segs);
    expect(rows[2]).toEqual(row(74, "amber", ["dim", "to"], ["", "       214 people · re-counted now · 9 left out"]));
    expect(rows[4]).toEqual(row(74, "amber", ["dim", "steps"], ["", "    3 — View shows every one"]));
    expect(rows[6]).toEqual(row(74, "amber", ["key", " v "], ["", " view   "], ["pk", " s "], ["", " "], ["b", "Send to 214 people"], ["", "   "], ["key", " n "], ["", " dismiss"]));
  });

  it("a sender that is not verified still says so on a card that shows the app's rows", () => {
    const held = decode({ ...EMAIL, body: { ...EMAIL.body, audience: { ...EMAIL.body.audience, senderVerified: false } } });
    expect(approvalRender(held, cardCtx()).lines.join("\n")).toContain("The sender is not verified yet.");
  });

  it("flow-email-02: with v pressed the card gives way to the document: tabs, a ruled body, the chips", () => {
    const ui = { ...CARD_UI_START, documentOpen: true };
    const render = approvalRender(decode(EMAIL), cardCtx({ ui }));
    const lines = render.lines.map(segs);
    expect(lines[0]!.at(-1)).toEqual(["dim", "· viewing"]);
    expect(lines.slice(1)).toEqual([
      [["dim", "Email · win-back"]],
      [],
      [["inv", " 1 Email 1 "], ["", "  "], ["dim", "2 Email 2   3 Email 3"]],
      [],
      [["line", "│"], ["", " Subject: Your trial ended. Here's what Infinite found"]],
      [["line", "│"]],
      [["line", "│"], ["", " Hi {first name},"]],
      [["line", "│"]],
      [["line", "│"], ["", " Before your trial ended, Infinite found 3 ads spending with no trials,"]],
      [["line", "│"], ["", " and one that beat your goal by 40%."]],
      [["line", "│"]],
      [["line", "│"], ["", " Pick up where you left off: store.example/back"]],
      [],
      [["pk", " s "], ["", " "], ["b", "Send to 214 people"], ["", "   "], ["key", " 1-3 "], ["", " email   "], ["key", " n "], ["", " dismiss"]]
    ]);
  });
});

// ── receipts (region-card-done-green, flow-pause-02/03/06/08/09) ──

describe("receipts and settled states (r4 Pause an ad)", () => {
  const receiptView = (over: Record<string, unknown>) => pause({ approval: undefined, ...over });
  const detail = (view: AnswerViewV1, over: Partial<ViewRenderCtx> = {}) => renderView(view, viewCtx(over)).detail;

  it("done with the app's receipt: a GREEN card titled `… · Agent proposed · You approved`, the receipt in dim", () => {
    const view = pause({
      state: "done", outcome: "applied", explain: "Paused on Meta from here.",
      receipt: { sentence: "Stopped spending at 10:42", tone: "ok", revertible: true, provenanceLine: "Clears the matching Home card" }
    });
    const rows = cardRows(detail(view, { width: 69, caps: OPEN })).map(segs);
    const { blank, bottom } = box(69, "green");
    expect(rows).toEqual([
      // r4 overruns the 69-wide card by one cell here (N2); the CLI cuts the title at a word so the box closes (run-r2 MUST 3).
      [["green", "┌─"], ["", " "], ["b", "Paused ad “Demo B · sample copy” · Agent proposed · You …"], ["", " "], ["green", "───────┐"]],
      row(69, "green", ["dim", "status"], ["", "   on "], ["dim", "→"], ["", " "], ["b", "PAUSED"]),
      row(69, "green", ["dim", "Stopped spending at 10:42"]),
      row(69, "green", ["dim", "Clears the matching Home card"]),
      blank,
      // r4 also draws `t turn back on`: the terminal binds no key to a next step yet, so it draws none.
      row(69, "green", ["key", " o "], ["", " open in Meta Ads"]),
      blank,
      row(69, "green", ["key", " ? "], ["", " "], ["dim", "what it does"]),
      bottom
    ]);
  });

  it("an app receipt whose title carries its provenance (S4): a short head, the provenance once, in r4's short words (run-r2 NICE)", () => {
    const view = receiptView({
      title: "Paused ad “Ad 01” · Proposed by the agent · approved by You", state: "done", outcome: "applied",
      receipt: { sentence: "Paused “Ad 01”. Meta shows it PAUSED.", tone: "ok", revertible: false, provenanceLine: "Proposed by the agent · approved by You" }
    });
    const render = renderView(view, viewCtx());
    expect(render.head.replace(/\u001b\[[0-9;]*m/gu, "")).toBe(" Paused ad “Ad 01”  ✓ Done");
    const all = [render.head, ...render.detail].map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")).join("\n");
    // r4 flow-pause-03: `Agent proposed · You approved`, said once, in the card's title.
    expect(all).not.toContain("Proposed by the agent");
    expect(all.split("Agent proposed · You approved").length - 1).toBe(1);
    expect(all).toContain("┌─ Paused ad “Ad 01” · Agent proposed · You approved ─");
    expect(all).toContain("Paused “Ad 01”. Meta shows it PAUSED.");
    // Provenance in other words stays the app's own.
    const other = receiptView({
      title: "Paused ad “Ad 01” · Set by a rule", state: "done", outcome: "applied",
      receipt: { sentence: "Paused.", tone: "ok", revertible: false, provenanceLine: "Set by a rule" }
    });
    const otherText = renderView(other, viewCtx()).detail.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")).join("\n");
    expect(otherText).toContain("┌─ Paused ad “Ad 01” · Set by a rule ─");
  });

  it("a receipt view from the app (no approval left, the done title as its title) gets the same green card", () => {
    const view = receiptView({
      title: "Paused ad “Demo B · sample copy”", state: "done", outcome: "applied",
      receipt: { sentence: "Paused.", tone: "ok", revertible: false }
    });
    const top = segs(cardRows(detail(view))[0]!);
    expect(top[2]).toEqual(["b", "Paused ad “Demo B · sample copy” · Agent proposed · You approved"]);
    expect(top[0]).toEqual(["green", "┌─"]);
  });

  it("applying (flow-pause-02): an amber card titled with the approval's words, then ◑ Working… in cyan", () => {
    const view = pause({ state: "applying", approval: { ...PAUSE_APPROVAL, title: "Pausing ad “Demo B · sample copy”…" } });
    const rows = cardRows(detail(view)).map(segs);
    expect(rows[0]![2]).toEqual(["b", "Pausing ad “Demo B · sample copy”…"]);
    expect(rows[0]![0]).toEqual(["amber", "┌─"]);
    expect(rows).toContainEqual(row(74, "amber", ["cyan", "◑ Working…"], ["", "  "], ["dim", "· after 20 s it says it's still running"]));
    // flow-pause-02: the working card still ends with `? what it does` (the approval's summary).
    expect(rows[rows.length - 2]).toEqual(row(74, "amber", ["key", " ? "], ["", " "], ["dim", "what it does"]));
  });

  it("applying since the yes (run-2 M9): the stopwatch counts the seconds since it was sent, and r4's spacing", () => {
    const sent = Date.parse("2026-10-01T10:43:56Z");
    const view = { ...pause({ state: "applying", approval: { ...PAUSE_APPROVAL, title: "Pausing ad “Demo B · sample copy”…" } }), appliedAt: sent } as unknown as AnswerViewV1;
    const now = Date.now;
    Date.now = () => Date.parse("2026-10-01T10:44:00Z");
    try {
      const rows = cardRows(detail(view)).map(segs);
      expect(rows).toContainEqual(row(74, "amber", ["cyan", "◑ Working… 4s"], ["", "  "], ["dim", "· after 20 s it says it's still running"]));
      const working = rows.findIndex((cells) => cells.some(([, text]) => text.startsWith("◑ Working…")));
      // r4 pauseCard: the working line, then three empty rows before `? what it does`.
      expect(rows.slice(working + 1, working + 4).every((cells) => cells.every(([, text]) => !text.replace(/[│ ]/gu, "")))).toBe(true);
      expect(rows[working + 4]).toEqual(row(74, "amber", ["key", " ? "], ["", " "], ["dim", "what it does"]));
    } finally {
      Date.now = now;
    }
  });

  it("done without view.explain (flow-pause-03): `? what it does` comes from the approval's summary, and ? opens it inside", () => {
    const view = pause({
      state: "done", outcome: "applied",
      receipt: { sentence: "Stopped spending at 10:42", tone: "ok", revertible: true }
    });
    const closed = cardRows(detail(view)).map(segs);
    expect(closed[closed.length - 2]).toEqual(row(74, "green", ["key", " ? "], ["", " "], ["dim", "what it does"]));
    const open = cardRows(detail(view, { explainOpen: true })).map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
    expect(open.join("\n")).toContain("│ Stops this ad's spend until you turn it back on.");
    expect(open.length).toBe(closed.length + 2);
    // Open, the chip says `? hide` (live run-4 N12).
    expect(open[open.length - 2]).toBe(`│  ?  hide${" ".repeat(63)}│`);
    // ? works on the turn view: the focus facts offer it.
    expect(viewKeyFacts(view, renderView(view, viewCtx())).explain).toBe(true);
  });

  it("a view's own explain is not drawn twice: the shell prints it, the card only offers ?", () => {
    const view = pause({
      state: "done", outcome: "applied", explain: "Paused on Meta from here.",
      receipt: { sentence: "Stopped spending at 10:42", tone: "ok", revertible: true }
    });
    const open = renderView(view, viewCtx({ explainOpen: true })).detail.join("\n").replace(/\u001b\[[0-9;]*m/gu, "");
    expect(open.split("Paused on Meta from here.").length - 1).toBe(1);
  });

  it("a receipt with no approval and no explain offers no ?", () => {
    const view = receiptView({ title: "Paused ad", state: "done", outcome: "applied", receipt: { sentence: "Paused.", tone: "ok", revertible: false } });
    expect(cardRows(detail(view)).join("\n")).not.toContain("what it does");
    expect(viewKeyFacts(view, renderView(view, viewCtx())).explain).toBe(false);
  });

  // Live T4 (round 4): a dismissed card shows only its receipt line. r4's
  // flow-pause-09 draws a dim `Sent to the app` under it; that afterword is
  // dropped on purpose (style/golden/decisions.ts T4).
  it("dismissed (flow-pause-09): the sentence alone, no `Sent to the app`, and no rows", () => {
    const fromApp = receiptView({ state: "cancelled", receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } });
    expect(detail(fromApp).map(segs)).toEqual([
      [["dim", "✕ Dismissed — nothing was executed."]]
    ]);
    // With the words as its state reason, the shell prints the sentence; the body adds nothing.
    const withReason = receiptView({ state: "cancelled", stateReason: { code: "dismissed", words: "Dismissed — nothing was executed." } });
    const out = detail(withReason).map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
    expect(out.filter((line) => line.includes("Dismissed — nothing was executed."))).toHaveLength(1);
    expect(out).toEqual(["✕ Dismissed — nothing was executed."]);
    expect(out.join("\n")).not.toContain("Sent to the app");
    expect(out.join("\n")).not.toContain("PAUSED");
  });

  it("expired and declined cards show only their receipt line, never `Sent to the app`", () => {
    for (const state of ["expired", "cancelled"] as const) {
      const view = receiptView({ state, receipt: { sentence: "Nothing was executed.", tone: "ok", revertible: false } });
      const out = detail(view).map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
      expect(out.join("\n"), state).not.toMatch(/Sen[dt]\w* to the app/u);
    }
  });

  it("changed on Meta (flow-pause-06, failed + not_sent): no rows, and `Nothing ran.` in dim", () => {
    const view = receiptView({
      state: "failed", outcome: "not_sent",
      stateReason: { code: "changed_on_meta", words: "This changed since you looked. Meta now says PAUSED, so it's already off.", short: "Changed on Meta" }
    });
    const out = detail(view);
    expect(segs(out.at(-1)!)).toEqual([["dim", "Nothing ran."]]);
    expect(out.join("\n")).not.toContain("→");
    expect(out).toHaveLength(2);
  });

  it("expired (flow-pause-08): only the shell's sentence, no rows and no afterword", () => {
    const view = receiptView({ state: "expired", stateReason: { code: "expired", words: "This approval expired — nothing was executed. Ask again to get a fresh one." } });
    const out = detail(view).map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
    expect(out.join("\n")).not.toContain("PAUSED");
    expect(out.join("\n")).not.toContain("Nothing ran.");
  });
});

// ── launch receipts (flow-email-03…06) ──

describe("send receipts (r4 Send an email)", () => {
  const detail = (over: Record<string, unknown>, ctx: Partial<ViewRenderCtx> = {}) =>
    renderView(decode({ ...EMAIL, approval: undefined, ...over }), viewCtx(ctx)).detail;

  it("done (flow-email-03): the app's sentence word for word in bold green, wrapped to the pane, then `o`", () => {
    const sentence = "Campaign is live — 214 enrolled · 2 left out (internal people are never mailed by a campaign). Steps send on their schedule after the pre-send re-check.";
    const out = detail({
      state: "done", outcome: "applied",
      appLink: { place: "email.campaign", label: "open in Email Campaigns" },
      receipt: { sentence, tone: "ok", revertible: true }
    }, { caps: OPEN }).map(segs);
    expect(out).toEqual([
      [["gb", "✓ Campaign is live — 214 enrolled · 2 left out (internal people are never mailed by a campaign)."]],
      [["gb", "Steps send on their schedule after the pre-send re-check."]],
      [],
      [["key", " o "], ["", " open in Email Campaigns"]]
    ]);
  });

  it("blocked and already live (flow-email-04, -06) draw no tree, audience or documents", () => {
    for (const over of [
      { state: "blocked", stateReason: { code: "role_required", words: "Only a workspace owner or admin can send emails." } },
      { state: "no_change", stateReason: { code: "already_live", words: "It already went live.", short: "Already live" } }
    ]) {
      const out = detail(over).join("\n");
      expect(out).not.toContain("214 people");
      expect(out).not.toContain("Email 1");
      expect(out).not.toContain("Nothing ran.");
    }
  });

  it("not sent with a fix to point at (flow-email-05) adds no `Nothing ran.`", () => {
    const out = detail({
      state: "failed", outcome: "not_sent",
      stateReason: { code: "copy_not_approved", words: "Not sent. The email copy isn't approved yet.",
        fix: { label: "Approve it in Email Campaigns", appLink: { place: "email.campaign", label: "Email Campaigns" } } }
    }).join("\n");
    expect(out).not.toContain("Nothing ran.");
    expect(out).not.toContain("214 people");
  });
});

// ── images (view-05, flow-images-02…06) ──

const IMAGES = {
  kind: "images", tool: "generate_ad_images", title: "Make 3 creatives", state: "done",
  provenance: { source: "Creatives", via: "our_db" },
  appLink: { place: "creative.library", label: "Open in Library", params: { run: "run_r4" } },
  body: {
    runId: "run_r4", requested: 3, ready: 3, failed: 0,
    items: [
      { id: "i1", label: "Explained", status: "done" },
      { id: "i2", label: "Your audit", status: "done" },
      { id: "i3", label: "3 fixes", status: "done" }
    ],
    format: "HD", aspectRatio: "4:5", model: "Infinite's image model", madeWith: "infinite"
  },
  cost: { usd: 0.52, estimate: true, whoPays: "infinite" }
};

describe("images (r4 Images, Make creatives)", () => {
  const detail = (over: Record<string, unknown>, ctx: Partial<ViewRenderCtx> = {}) =>
    renderView(decode({ ...IMAGES, ...over }), viewCtx(ctx)).detail.map(segs);

  it("view-05: the count bold, rows ✓ in green with the ratio dim, the link cyan underlined, the cost dim", () => {
    expect(detail({}, { caps: OPEN })).toEqual([
      // All of them ready: r4's words, and where they were saved (the view's link is the Library).
      [["b", "3 creatives ready"], ["", "  "], ["dim", "· 4:5 · saved to your Library"]],
      [],
      // Each made image with its share of the run's estimate (r4 `~$0.17`).
      [["green", "✓"], ["", " 1  Explained     "], ["dim", "4:5  ~$0.17"]],
      [["green", "✓"], ["", " 2  Your audit    "], ["dim", "4:5  ~$0.17"]],
      [["green", "✓"], ["", " 3  3 fixes       "], ["dim", "4:5  ~$0.17"]],
      [],
      [["cyan u", "Open in Library ↗"], ["", "  "], ["dim", "(o)"]],
      [["dim", "Pictures can't show in a terminal."]],
      [],
      [["dim", "About $0.52 for 3, on Infinite's image model"]]
    ]);
  });

  it("making them (flow-images-02): a cyan running line, then ✓ green, ⠋ cyan, and the queued row dim", () => {
    const out = detail({
      state: "working",
      body: { ...IMAGES.body, ready: 1, items: [
        { id: "i1", label: "Explained", status: "done" },
        { id: "i2", label: "Your audit", status: "drawing" },
        { id: "i3", label: "3 fixes", status: "queued" }
      ], eta: { startedAtMs: 0, etaMs: 25000 } }
    });
    expect(out).toEqual([
      [["cyan", "⠋ Making 3 creatives · ~25 s left"]],
      [],
      [["green", "✓"], ["", " 1  Explained"]],
      [["cyan", "⠋"], ["", " 2  Your audit"]],
      // The first queued image is the next one drawn.
      [["dim", "· 3  3 fixes · next"]]
      // On Infinite's model the link waits until they are made (r4 draws it only for a Codex run).
    ]);
  });

  it("only the first queued image says next", () => {
    const out = detail({
      state: "working",
      body: { ...IMAGES.body, ready: 0, items: [
        { id: "i1", label: "Explained", status: "drawing" },
        { id: "i2", label: "Your audit", status: "queued" },
        { id: "i3", label: "3 fixes", status: "queued" }
      ] }
    });
    expect(out.slice(3, 5)).toEqual([[["dim", "· 2  Your audit · next"]], [["dim", "· 3  3 fixes"]]]);
  });

  it("with your Codex (flow-images-06): $0 to Infinite on the running line", () => {
    const out = detail({
      state: "working", cost: { usd: 0, estimate: false, whoPays: "your_chatgpt_plan" },
      body: { ...IMAGES.body, ready: 1, model: "your ChatGPT", madeWith: "your_codex", items: [{ id: "i1", label: "Fire the agency", status: "done" }] }
    });
    expect(out[0]).toEqual([["cyan", "⠋ Making 3 creatives with your ChatGPT · $0 to Infinite"]]);
  });

  it("a Codex run shows where they land while it runs (flow-images-06)", () => {
    const out = detail({
      state: "working", cost: { usd: 0, estimate: false, whoPays: "your_chatgpt_plan" },
      body: { ...IMAGES.body, ready: 1, model: "your ChatGPT", madeWith: "your_codex", items: [{ id: "i1", label: "Fire the agency", status: "done" }] }
    });
    expect(out[out.length - 1]).toEqual([["dim", "They land in your Library:"], ["", " "], ["cyan u", "Open in Library ↗"]]);
  });

  it("partial (flow-images-03): the rows, ✗ red with its reason dim, then the link", () => {
    const out = detail({
      state: "partial", appLink: { place: "creative.library", label: "Open the 2 in Library" },
      stateReason: { code: "partial", words: "2 of 3 creatives" },
      body: { ...IMAGES.body, ready: 2, failed: 1, items: [
        { id: "i1", label: "Explained", status: "done" },
        { id: "i2", label: "Your audit", status: "done" },
        { id: "i3", label: "3 fixes", status: "failed", failureWords: "blocked by the safety check" }
      ] }
    }, { caps: OPEN });
    expect(out).toContainEqual([["red", "✗"], ["", " 3  3 fixes  "], ["dim", "· blocked by the safety check"]]);
    expect(out.at(-1)).toEqual([["cyan u", "Open the 2 in Library ↗"], ["", "  "], ["dim", "(o)"]]);
    // r4: the rows follow the state's sentence directly, no blank between (run-2 M9).
    expect(out[0]).toEqual([["amber", "◐ 2 of 3 creatives"]]);
    expect(out[1]).toEqual([["green", "✓"], ["", " 1  Explained"]]);
  });

  it("done with the app's receipt (flow-images-04): its sentence in bold green, then the link", () => {
    const out = detail({ receipt: { sentence: "3 creatives ready", tone: "ok", revertible: false } });
    expect(out).toEqual([[["gb", "✓ 3 creatives ready"], ["", "  "], ["dim", "· saved to your Library"]], [], [["cyan u", "Open in Library ↗"]]]);
  });

  it("the card (flow-images-01): the app's one row is the card's sentence, with no label (run-2 M9)", () => {
    const card = decode({
      ...IMAGES, state: "needs_yes",
      approval: { kind: "card", turnId: "t", handle: "h", title: "Generate 3 ad images", summary: null, confirmLabel: "Generate · ~$0.52", dismissLabel: "Dismiss",
        rows: [{ label: "Images", value: "“Your ad account, explained” · 4:5 · HD" }] }
    });
    const lines = approvalRender(card, { ...viewCtx({ color: false }), ui: CARD_UI_START, fieldsCapable: true }).lines;
    expect(lines.some((line) => line.includes("│ “Your ad account, explained” · 4:5 · HD"))).toBe(true);
    expect(lines.some((line) => /│ Images +“/u.test(line))).toBe(false);
  });

  it("hit a limit (flow-images-05): no rows, and `Nothing was proposed.` in dim", () => {
    const out = detail({
      state: "hit_limit", body: { ...IMAGES.body, ready: 0, items: [] },
      stateReason: { code: "daily_image_cap", words: "This workspace has generated 20 of its 20 ad images today." }
    });
    expect(out.at(-1)).toEqual([["dim", "Nothing was proposed."]]);
  });
});

// ── job (view-08) ──

describe("job (r4 Job)", () => {
  it("view-08: the name bold, ✓ bold green with the detail dim, the running step's bar, todo rows dim, Lands in: a link", () => {
    const view = decode({
      kind: "job", tool: "start_blog_post", title: "Blog post", state: "background",
      provenance: { source: "Blog post", via: "our_db" },
      body: {
        jobId: "job_r4", label: "What a trial should cost on Meta", phase: "running",
        steps: [
          { id: "s1", label: "Research", state: "done", detail: "12 sources" },
          { id: "s2", label: "Outline", state: "done", detail: "7 sections" },
          { id: "s3", label: "Draft", state: "now", detail: "section 4 of 7" },
          { id: "s4", label: "Images", state: "todo" },
          { id: "s5", label: "Ready for you", state: "todo" }
        ],
        progress: { finished: 4, of: 7 }, startedAt: "2026-10-01T10:41:57Z", etaMs: 240000, runsWhere: "cloud",
        outlivesTurn: true, landsAt: { place: "content.posts", label: "Blog & AEO › Production" }, noCompletionSignal: false,
        watch: { label: "watch", ask: "how is the blog post going?" }
      }
    });
    const now = Date.now;
    Date.now = () => Date.parse("2026-10-01T10:44:00Z");
    let out: ReturnType<typeof segs>[];
    try {
      out = renderView(view, viewCtx()).detail.map(segs);
    } finally {
      Date.now = now;
    }
    expect(out.slice(0, 8)).toEqual([
      [["b", "What a trial should cost on Meta"]],
      [],
      [["gb", "✓"], ["", " Research      "], ["dim", "12 sources"]],
      [["gb", "✓"], ["", " Outline       "], ["dim", "7 sections"]],
      [["cb", "⠋"], ["", " Draft         "], ["cyan", "██████████████▉"], ["line", "░░░░░░░░░░░"], ["", "  section 4 of 7"]],
      [["dim", "· Images"]],
      [["dim", "· Ready for you"]],
      []
    ]);
    // r4: how long it has run (the clock since startedAt) leads the line (run-2 M9).
    expect(out[8]).toEqual([["dim", "2:03 so far · usually about 4 min · keeps going while you chat"]]);
    expect(out[9]).toEqual([["dim", "Lands in:"], ["", " "], ["cyan u", "Blog & AEO › Production ↗"]]);
  });

  const running = (steps: unknown[]) => decode({
    kind: "job", tool: "start_blog_post", title: "Blog post", state: "background",
    provenance: { source: "Blog post", via: "our_db" },
    body: {
      jobId: "job_r4", label: "Post", phase: "running", steps,
      progress: { finished: 4, of: 7 }, runsWhere: "cloud", outlivesTurn: true, noCompletionSignal: false
    }
  });
  const plainText = (line: string) => line.replace(/\u001b\[[0-9;]*m/gu, "");

  it("the count stays on the running step when it has no detail: after the bar", () => {
    const view = running([{ id: "s3", label: "Draft", state: "now" }]);
    const out = renderView(view, viewCtx()).detail.map(segs);
    expect(out[2]).toEqual([["cb", "⠋"], ["", " Draft         "], ["cyan", "██████████████▉"], ["line", "░░░░░░░░░░░"], ["", "  4 of 7"]]);
  });

  it("in a narrow pane the bar does not fit, and the row still says how far: detail · N of M", () => {
    const at40 = renderView(running([{ id: "s3", label: "Draft", state: "now", detail: "section 4" }]), viewCtx({ width: 40 })).detail.map(plainText);
    expect(at40).toContain("⠋ Draft         █████▊░░░░  section 4");
    const withDetail = renderView(running([{ id: "s3", label: "Draft", state: "now", detail: "section 4" }]), viewCtx({ width: 34 })).detail.map(plainText);
    expect(withDetail).toContain("⠋ Draft         section 4 · 4 of 7");
    const bare = renderView(running([{ id: "s3", label: "Draft", state: "now" }]), viewCtx({ width: 24 })).detail.map(plainText);
    expect(bare).toContain("⠋ Draft         4 of 7");
  });
});

// ── the target's path (contract revision 3), outside the r4 goldens ──

describe("the change target's path (contract revision 3) where no golden covers it", () => {
  const PATH = ["Sample campaign", "Sample ad set"];
  const PATH_WORDS = "Sample campaign › Sample ad set";
  const plainText = (line: string) => line.replace(/\u001b\[[0-9;]*m/gu, "");
  const MANAGED = {
    kind: "operation_managed", title: "Pause this ad?", summary: "Stops its spend.",
    confirmLabel: "Pause", dismissLabel: "Dismiss", ask: "Yes, pause it"
  };
  const plain = (approval: Record<string, unknown> | undefined) => decode({
    kind: "change", tool: "propose_pause_entity", title: "Pause Demo B", state: "needs_yes",
    provenance: { source: "Meta · ad", via: "our_db" },
    body: { ...PAUSE_BODY, target: { kind: "ad", label: "Demo B", path: PATH } },
    ...(approval ? { approval } : {})
  });

  for (const [name, approval] of [["an operation_managed approval", MANAGED], ["no approval", undefined]] as const) {
    for (const cols of [60, 100, 140]) {
      it(`a plain change (${name}) at ${cols}: the row under the bold target is the path, one dim run, nothing wider than ${cols}`, () => {
        const lines = renderView(plain(approval), viewCtx({ width: cols })).detail;
        const at = lines.findIndex((line) => JSON.stringify(segs(line)) === JSON.stringify([["b", "Demo B"]]));
        expect(at).toBeGreaterThanOrEqual(0);
        expect(segs(lines[at + 1]!)).toEqual([["dim", PATH_WORDS]]);
        expect(lines.filter((line) => plainText(line).includes(PATH_WORDS))).toHaveLength(1);
        for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
      });
    }
  }

  const cardWith = (target: Record<string, unknown>, rows: unknown[]) => decode({
    kind: "change", tool: "propose_pause_entity", title: "Pause Demo B", state: "needs_yes",
    provenance: { source: "Meta · ad", via: "our_db" },
    body: { ...PAUSE_BODY, target: { ...target, path: PATH }, rows },
    approval: { kind: "card", turnId: "turn_r4", handle: "h_pause", title: "Pause ad?", summary: null,
      confirmLabel: "Pause", dismissLabel: "Dismiss", expiresAt: "2026-10-01T10:59:00Z" }
  });

  for (const [name, view] of [
    ["no rows", () => cardWith({ kind: "ad", label: "Demo B" }, [])],
    ["a pending_write target", () => cardWith({ kind: "pending_write", label: "Demo B" }, [{ label: "status", after: "PAUSED" }])]
  ] as const) {
    for (const cols of [60, 100, 140]) {
      it(`a waiting card with ${name} at ${cols} draws the path exactly once`, () => {
        const lines = approvalRender(view(), cardCtx({ width: cols })).lines.map(plainText);
        expect(lines.join("\n").split(PATH_WORDS).length - 1).toBe(1);
      });
    }
  }
});

// Wave 3 r2 / term-split-80 (W3-ap-pause): a change card says its target's
// name ONCE, in the card's border title (r4 flow-pause-*). The head is the
// action and the kind (`Pause ad`) when the view's title is the action and the
// whole name; the border cuts a long name at a word or name-part end with `…`;
// the body starts with the path and the rows; the whole name is behind `?`.
// Never a name broken mid-word in the card.
describe("a long name is said once, in the card's title (W3-ap-pause)", () => {
  const LONG = "sample_video_long-name_for_the_head_test_alpha_bravo_x";
  const plainText = (line: string) => line.replace(/\u001b\[[0-9;]*m/gu, "");
  const longPause = (over: Record<string, unknown> = {}) => pause({
    title: `Pause ${LONG}`,
    body: { ...PAUSE_BODY, target: { kind: "ad", id: "ad_demo_long", label: LONG, path: ["Sample campaign", "Sample ad set"] } },
    approval: { ...PAUSE_APPROVAL, title: `Pause ad “${LONG}”?`, rows: [{ label: "Ad", value: LONG }], summary: null },
    ...over
  });
  const NAME_PART = /sample_video|long-name|alpha_bravo/u;

  for (const cols of [51, 60, 69, 100]) {
    it(`at ${cols}: the head is the action and the kind; the name is in the card once, cut at a part's end`, () => {
      const render = approvalRender(longPause(), cardCtx({ width: cols, caps: OPEN }));
      expect(plainText(render.head)).toBe(" Pause ad  ▣ Needs your OK");
      const lines = render.lines.map(plainText);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
      expect(lines.filter((line) => NAME_PART.test(line)), lines.join("\n")).toHaveLength(1);
      const top = lines.find((line) => line.startsWith("┌─ "))!;
      const shown = /┌─ Pause ad “(.+?)(?:”\?)? ─+┐$/u.exec(top)![1]!;
      if (shown.endsWith("…")) {
        const kept = shown.slice(0, -1);
        expect(LONG.startsWith(kept), shown).toBe(true);
        // Cut where a name part ends: the next character was a separator.
        expect("_-".includes(LONG[kept.length]!), shown).toBe(true);
      } else {
        expect(shown).toBe(LONG);
      }
      // The body starts with the path, then the rows.
      const inside = cardRows(render.lines).slice(1).map((line) => plainText(line).replace(/^│ ?| ?│$/gu, "").trim());
      expect(inside[0]).toBe("Sample campaign › Sample ad set");
      expect(inside[1]).toMatch(/^status +on → PAUSED$/u);
    });
  }

  for (const cols of [51, 60]) {
    it(`at ${cols} the whole name is behind ?, never broken mid-word`, () => {
      const lines = approvalRender(longPause(), cardCtx({ width: cols, caps: OPEN, ui: { ...CARD_UI_START, explainOpen: true } })).lines.map(plainText);
      const inCard = lines.map((line) => line.replace(/^│ ?| ?│$/gu, "").trim());
      expect(inCard.join(" ")).toContain(LONG.slice(0, 20));
      // Each wrapped piece of the name ends at a part's end (a separator), never mid-part.
      const pieces = inCard.filter((line) => NAME_PART.test(line) && !line.startsWith("┌"));
      expect(pieces.join("").replace(/^Pause ad “|”\?$/gu, "")).toContain(LONG);
      for (const piece of pieces.slice(0, -1)) expect(/[_\-\s]$/u.test(piece) || /[“]$/u.test(piece), piece).toBe(true);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    });
  }

  it("where the border holds the whole title, the name is still said once", () => {
    const lines = approvalRender(longPause(), cardCtx({ width: 140, caps: OPEN })).lines.map(plainText);
    expect(lines.join("\n").split(LONG).length - 1).toBe(1);
  });

  it("a short name keeps r4's head (flow-pause-01): the view's title is not the action and the whole name", () => {
    const head = plainText(approvalRender(pause(), cardCtx({ width: 140 })).head);
    expect(head).toBe(" Pause Demo B  ▣ Needs your OK");
  });

  it("a head with no room for the whole title is cut at a word's end", () => {
    const view = pause({ title: "Pause the sample ad with a long plain title for the head here" });
    const head = plainText(approvalRender(view, cardCtx({ width: 51 })).head);
    expect(displayWidth(head)).toBeLessThanOrEqual(51);
    expect(head).toBe(" Pause the sample ad with a long …  ▣ Needs your OK");
  });
});

// Wave 3 r2 (W3-chg-xpub): an operation_managed approval says where its OK is
// given, never a key that does nothing: here, once the view is engaged (tab,
// then its key), or in the app when the view says it finishes there.
describe("an operation_managed approval says where its OK is given (W3-chg-xpub)", () => {
  const plainText = (line: string) => line.replace(/\u001b\[[0-9;]*m/gu, "");
  const publish = (approval: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => decode({
    kind: "change", tool: "publish_sample_post", title: "Publish sample post", state: "needs_yes",
    provenance: { source: "Sample network", via: "server" },
    body: { target: { kind: "post", label: "Sample post" }, rows: [{ label: "Status", before: "Draft", after: "Published" }], warnings: [] },
    approval: {
      kind: "operation_managed", title: "Publish “Sample post”?", summary: "This draft goes live.",
      confirmLabel: "Publish", dismissLabel: "Dismiss", rows: [], ask: "Yes, publish the sample post now.", ...approval
    },
    ...extra
  });
  const out = (view: AnswerViewV1, over: Partial<ViewRenderCtx> = {}) => {
    const render = renderView(view, viewCtx({ color: false, ...over }));
    return [render.head, ...render.detail].map(plainText);
  };

  for (const cols of [60, 100, 140]) {
    it(`at rest it says the OK is here, behind tab, with the key that sends it (${cols} columns)`, () => {
      const lines = out(publish(), { width: cols });
      expect(lines).toContain("OK it here: tab, then p (Publish)");
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    });
  }

  it("the key it names is the key that sends the ask", () => {
    const render = renderView(publish(), viewCtx({ color: false }));
    expect(render.approvalAsk).toEqual({ key: "p", label: "Publish", ask: "Yes, publish the sample post now." });
  });

  it("engaged, the key bar has the key, so the line drops `tab`", () => {
    expect(out(publish(), { engaged: true })).toContain("OK it here: p (Publish)");
  });

  it("in scrollback, or with the keys on another view, it names no key", () => {
    for (const over of [{ scrollback: true }, { keysElsewhere: true }]) {
      expect(out(publish(), over).join("\n")).not.toMatch(/OK it here/u);
    }
  });

  it("a view that finishes in the app says so in the app's own words", () => {
    const view = publish({ finishInApp: { words: "Finish it in Sample drafts", appLink: { place: "sample.drafts", label: "Sample drafts" } } });
    const lines = out(view);
    expect(lines).toContain("Finish it in Sample drafts");
    expect(lines.join("\n")).not.toMatch(/OK it here|↗/u);
    const open = out(publish(
      { finishInApp: { words: "Finish it in Sample drafts", appLink: { place: "sample.drafts", label: "Sample drafts" } } },
      { appLink: { place: "sample.drafts", label: "Sample drafts" } }
    ), { caps: OPEN });
    expect(open).toContain("Finish it in Sample drafts ↗  (o)");
  });

  it("an ask that is a command offers no key and no line", () => {
    expect(out(publish({ ask: "/publish" })).join("\n")).not.toMatch(/OK it here/u);
  });
});

// Review of 4b5acc2 (2026-10-03): a name never breaks mid-word anywhere in a
// card, so the two paths that wrap card text (a field row's value and a card
// paragraph) each get a test that goes red on a plain hard wrap.
describe("a long name in a card's rows and paragraphs breaks only after one of its parts", () => {
  const NAME = "sample_video_confession_ads-manager_na_dark_captions_v3";
  const plainText = (line: string) => line.replace(/\u001b\[[0-9;]*m/gu, "");
  const strip = (line: string) => plainText(line).replace(/^│ ?| ?│$/gu, "").trim();
  /** Each line that ends inside the name ends right after a separator; the pieces join back into the whole name. */
  function expectWholeParts(lines: readonly string[]) {
    const words = lines.map(strip).filter(Boolean);
    for (const line of words) {
      const last = line.split(/\s+/u).at(-1)!;
      if (NAME.includes(last) && !NAME.endsWith(last)) {
        expect(/[_./-]$/u.test(last), `${last} (in ${JSON.stringify(words)})`).toBe(true);
      }
    }
    expect(words.join(" ").replace(/([_./-]) /gu, "$1")).toContain(NAME);
  }

  for (const width of [12, 24, 30, 41]) {
    it(`a field row's value at ${width} columns`, () => {
      const lines = fieldRows([{ label: "Ad", value: NAME }], width, { color: true, theme });
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
      expectWholeParts(lines.map((line) => plainText(line).replace(/^Ad\s*/u, "")));
    });

    it(`a card paragraph at ${width} columns`, () => {
      const lines = paragraphIn(`Also stops ${NAME} today.`, width, "dim", { color: true, theme });
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
      expectWholeParts(lines);
    });
  }

  for (const cols of [51, 60]) {
    it(`a waiting card's warning at ${cols}: inside the box, the name breaks only at its parts`, () => {
      const view = pause({ body: { ...PAUSE_BODY, warnings: [`Also stops ${NAME} today.`] } });
      const box = cardRows(approvalRender(view, cardCtx({ width: cols, caps: OPEN })).lines);
      for (const line of box) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
      const warning = box.map(strip).filter((line) => line.startsWith("! Also") || /^[a-z0-9_.\/-]+( today\.)?$/u.test(line));
      expect(warning.length, box.map(plainText).join("\n")).toBeGreaterThan(1);
      expectWholeParts(warning.map((line) => line.replace(/^! /u, "")));
    });
  }
});
