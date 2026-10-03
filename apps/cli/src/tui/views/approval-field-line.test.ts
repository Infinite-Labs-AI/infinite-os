// Wave 3 r3 (io-term, W3-ap-adset): an approval field reads as ONE clear line.
// The host stops sending a detail row that repeats the field, so the card
// prints the budget once. A field the terminal cannot fill here (an app that
// cannot take answers from it, or a choice with no options to pick from)
// reads `<label>  set it in the app`, with `(o)` only when o opens the card in
// the app: never `OK asks for a value` (no OK can set it here), never options
// that cannot be typed, never a dead key. Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { formatKeyBar, resolveKey } from "../keys/keymap.js";
import { resolveTheme } from "../theme.js";
import { approvalRender, CARD_UI_START, cardKeyStep, type ApprovalRenderCtx, type CardUiState } from "./approval.js";

const theme = resolveTheme();
const BUDGET = {
  key: "adSetBudget", label: "Its budget", input: "money_per_day", required: true, currency: "USD",
  options: [{ value: "meta_split", label: "Let Meta split the budget" }], current: null
};

function createAdSet(field: Record<string, unknown> = BUDGET, extra: Record<string, unknown> = {}): AnswerViewV1 {
  const view = decodeAnswerView({
    v: 1, kind: "launch", tool: "propose_create_ad_set", title: "Create Sample ad set", state: "needs_answer", asOf: null,
    provenance: { source: "Sample · ad set", via: "our_db" }, scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    appLink: { place: "sample.place", label: "Open it" },
    approval: {
      kind: "card", turnId: "turn_1", handle: "h_1", title: "Create ad set “Sample ad set”?", summary: null,
      confirmLabel: "Create (paused)", dismissLabel: "Dismiss", effect: "Lands paused; nothing spends until you turn it on.",
      rows: [], fields: [field], expiresAt: "2026-01-15T07:00:00Z"
    },
    // The ad set's own rows, with no Budget row: the field is the one place the budget is asked.
    body: { tree: [{ level: "adset", name: "Sample ad set", fields: [{ label: "Optimizes for", value: "Sample goal" }], status: "Paused (new)", children: [] }], picturesInApp: false },
    ...extra
  });
  if (!view) throw new Error("test view does not decode");
  return view;
}

const ctx = (over: Partial<ApprovalRenderCtx> = {}): ApprovalRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false,
  caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ui: CARD_UI_START, fieldsCapable: true, ...over
});
const text = (lines: readonly string[]) => lines.join("\n");
const budgetMentions = (lines: readonly string[]) => lines.filter((line) => /\bbudget\b/iu.test(line) && !/Let Meta split|meta split/iu.test(line));
const press = (input: string): { input: string; key: Key } => ({ input, key: {} as Key });

function drive(view: AnswerViewV1, inputs: string[], over: Partial<ApprovalRenderCtx> = {}) {
  let ui: CardUiState = CARD_UI_START;
  const effects: unknown[] = [];
  for (const { input, key } of inputs.map(press)) {
    const render = approvalRender(view, ctx({ ...over, ui }));
    const step = cardKeyStep(resolveKey(input, key, render.keyCtx), render, ui);
    ui = step.ui;
    if (step.effect) effects.push(step.effect);
  }
  return { ui, effects };
}

describe("an approval field reads as one clear line (W3-ap-adset)", () => {
  it("a field the terminal can fill: the budget is said once, and OK asks for it", () => {
    const render = approvalRender(createAdSet(), ctx());
    expect(budgetMentions(render.lines)).toHaveLength(1);
    expect(text(render.lines)).toMatch(/Its budget\s+OK asks for a value/u);
    expect(render.okKey).toBe("y");
    expect(drive(createAdSet(), ["y"]).ui.fieldEntry?.key).toBe("adSetBudget");
  });

  for (const width of [60, 100, 140]) {
    it(`an app that cannot take answers from here: one line, set it in the app, no dead OK (${width} columns)`, () => {
      const render = approvalRender(createAdSet(), ctx({ width, fieldsCapable: false }));
      const out = text(render.lines);
      expect(budgetMentions(render.lines)).toHaveLength(1);
      expect(out).toMatch(/Its budget\s+set it in the app\s*│/u);
      expect(out).not.toContain("OK asks");
      expect(out).not.toContain("or: Let Meta split the budget");
      expect(out).not.toContain("(o)");
      expect(render.okKey).toBeNull();
      expect(formatKeyBar(render.keys)).toBe("n dismiss");
      for (const line of render.lines) expect(line.length).toBeLessThanOrEqual(width);
    });
  }

  it("with o opening the card in the app, the line says (o), and o opens it", () => {
    const over = { fieldsCapable: false, caps: { open: true, watch: false, retry: false } };
    const out = text(approvalRender(createAdSet(), ctx(over)).lines);
    expect(out).toMatch(/Its budget\s+set it in the app {2}\(o\)/u);
    expect(drive(createAdSet(), ["o"], over).effects).toEqual([{ type: "open" }]);
  });

  it("n is still a real decline", () => {
    expect(drive(createAdSet(), ["n"], { fieldsCapable: false }).effects).toEqual([{ type: "confirm", decision: "decline" }]);
  });

  it("a required choice with no options cannot be answered here: one line, and no OK that would ask for it", () => {
    const pick = { key: "pick", label: "Its goal", input: "choice", required: true, options: [], current: null };
    const render = approvalRender(createAdSet(pick), ctx());
    expect(text(render.lines)).toMatch(/Its goal\s+set it in the app\s*│/u);
    expect(text(render.lines)).not.toContain("OK asks");
    expect(render.okKey).toBeNull();
    expect(drive(createAdSet(pick), ["y"]).effects).toEqual([]);
  });

  it("an optional field that cannot be filled here leaves the OK alone", () => {
    const pick = { key: "pick", label: "Its goal", input: "choice", required: false, options: [], current: null };
    const render = approvalRender(createAdSet(pick), ctx());
    expect(text(render.lines)).toMatch(/Its goal\s+set it in the app\s*│/u);
    expect(render.okKey).toBe("y");
    expect(drive(createAdSet(pick), ["y"]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
  });
});
