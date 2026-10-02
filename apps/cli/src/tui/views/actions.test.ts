import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1, CreativeDraftFrameV1 } from "@infinite-os/types";
import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { confirmResultLines } from "../../desktop/confirm-result-lines.js";
import { formatKeyBar, resolveKey } from "../keys/keymap.js";
import { displayWidth } from "../lib/display-width.js";
import { ansiFg, resolveTheme } from "../theme.js";
import {
  approvalRender,
  CARD_UI_START,
  cardKeyStep,
  cardUiStart,
  commitCardField,
  readFieldAnswer,
  receiptDetailLines,
  resendView,
  type ApprovalRenderCtx,
  type CardUiState
} from "./approval.js";
import { focusedViewCtx, resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts, viewKeyHints } from "./focus.js";
import { creativeDraftLine } from "./images.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

const theme = resolveTheme();
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const NO_CAPS = { open: false, watch: false, retry: false } as const;
const ALL_CAPS = { open: true, watch: true, retry: true } as const;

function fixture(name: string): AnswerViewV1 {
  const view = decodeAnswerView(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")));
  if (!view) throw new Error(`fixture ${name} does not decode`);
  return view;
}

function viewCtx(over: Partial<ViewRenderCtx> = {}): ViewRenderCtx {
  return {
    width: 72, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
    showHiddenColumns: false, caps: NO_CAPS, timeZone: "UTC", ...over
  };
}

function cardCtx(over: Partial<ApprovalRenderCtx> = {}): ApprovalRenderCtx {
  return { ...viewCtx(), ui: CARD_UI_START, fieldsCapable: true, ...over };
}

const text = (lines: readonly string[]) => lines.join("\n");
const press = (input: string, key: Partial<Key> = {}) => ({ input, key: key as Key });

/** Run keys through the card exactly as the session does: keymap → card step. */
function drive(view: AnswerViewV1, keys: { input: string; key: Key }[], over: Partial<ApprovalRenderCtx> = {}) {
  let ui: CardUiState = over.ui ?? CARD_UI_START;
  const effects: unknown[] = [];
  for (const { input, key } of keys) {
    const render = approvalRender(view, cardCtx({ ...over, ui }));
    const step = cardKeyStep(resolveKey(input, key, render.keyCtx), render, ui);
    ui = step.ui;
    if (step.effect) effects.push(step.effect);
  }
  return { ui, effects, render: approvalRender(view, cardCtx({ ...over, ui })) };
}

describe("approval card", () => {
  it("confirmLabel Pause gives the OK key p: the card's chip reads p Pause, the bar p pause   n dismiss (r4)", () => {
    const render = approvalRender(fixture("change-pause-card"), cardCtx());
    expect(render.okKey).toBe("p");
    expect(render.keyCtx.okKey).toBe("p");
    expect(formatKeyBar(render.keys)).toBe("p pause   n dismiss");
    expect(text(render.lines)).toContain("[p] Pause   [n] dismiss");
    const noExplain = approvalRender({ ...fixture("change-pause-card"), approval: { ...fixture("change-pause-card").approval!, summary: null } } as AnswerViewV1, cardCtx());
    expect(formatKeyBar(noExplain.keys)).toBe("p pause   n dismiss");
    expect(text(render.lines)).toContain("Pause ad “Hook A”?");
    expect(text(render.lines)).toContain("on → paused");
  });

  it("approval.summary stays hidden until explainOpen", () => {
    const view = fixture("change-pause-card");
    expect(text(approvalRender(view, cardCtx()).lines)).not.toContain("Stops this ad's spend");
    const { ui, render } = drive(view, [press("?")]);
    expect(ui.explainOpen).toBe(true);
    expect(text(render.lines)).toContain("Stops this ad's spend until you turn it back on.");
  });

  it("n resolves confirm({ decision: \"decline\" }), and the receipt view prints its sentence with no client words", () => {
    const { effects } = drive(fixture("change-pause-card"), [press("n")]);
    expect(effects).toEqual([{ type: "confirm", decision: "decline" }]);
    const lines = confirmResultLines({ ok: true, view: fixture("receipt-dismissed") }, "decline");
    expect(lines).toEqual([{ tone: "muted", text: "✕ Dismissed — nothing was executed." }]);
  });

  it("only the OK key approves; Enter, Esc and every other key never decide", () => {
    const view = fixture("change-pause-card");
    const { effects } = drive(view, [
      press("", { return: true }), press("", { escape: true }), press("y"), press(" "), press("v"), press("1"),
      press("e"), press("c"), press("j")
    ]);
    expect(effects).toEqual([]);
    expect(drive(view, [press("p")]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
  });
});

describe("money field", () => {
  it("a money_per_day field asks for a value before OK, then sends fields: { adSetBudget: { text: \"30\" } }", () => {
    const view = fixture("change-budget-field");
    const first = drive(view, [press("l")]);
    expect(first.effects).toEqual([]);
    expect(first.ui.fieldEntry?.key).toBe("adSetBudget");
    expect(first.render.fieldPrompt?.key).toBe("adSetBudget");
    expect(text(first.render.lines)).toMatch(/Daily budget/u);

    // Enter in the field only commits the value; it never approves.
    const committed = commitCardField(first.ui, "$30/day");
    expect(committed.error).toBeNull();
    expect(committed.ui.fieldEntry).toBeNull();
    expect(committed.ui.answers).toEqual({ adSetBudget: { text: "30" } });

    const second = drive(view, [press("l")], { ui: committed.ui });
    expect(second.effects).toEqual([{ type: "confirm", decision: "approve", fields: { adSetBudget: { text: "30" } } }]);
  });

  it("once a value is typed, the OK label shows it beside the app's verb, never a made-up verb", () => {
    const view = fixture("change-budget-field");
    expect(text(approvalRender(view, cardCtx()).lines)).toContain("[l] Lower to $30/day");
    expect(formatKeyBar(approvalRender(view, cardCtx()).keys)).toContain("l lower");
    const asked = drive(view, [press("l")]);
    // 60 is a raise: the app's "Lower to $30/day" no longer says what OK does,
    // and the terminal never rewrites it into "Lower to $60.00/day".
    const ui = commitCardField(asked.ui, "60").ui;
    const render = approvalRender(view, cardCtx({ ui }));
    expect(render.okKey).toBe("l");
    expect(text(render.lines)).toContain("[l] approve · $60.00/day");
    expect(formatKeyBar(render.keys)).toContain("l approve");
    expect(text(render.lines)).not.toContain("Lower to $30");
    expect(formatKeyBar(render.keys)).not.toContain("$30");
    expect(formatKeyBar(render.keys)).not.toContain("lower");
    expect(text(render.lines)).toContain("$40.00/day → $60.00/day");
    // A verb with no amount of its own keeps its words, with the typed value beside it.
    const create = fixture("launch-create-adset-field");
    const typed = commitCardField(drive(create, [press("y")]).ui, "30").ui;
    expect(text(approvalRender(create, cardCtx({ ui: typed })).lines)).toContain("[y] Create ad set · $30.00/day");
  });

  it("rejects a value that is not money and keeps the field open", () => {
    const view = fixture("change-budget-field");
    const { ui } = drive(view, [press("l")]);
    const bad = commitCardField(ui, "thirty");
    expect(bad.error).not.toBeNull();
    expect(bad.ui.fieldEntry?.key).toBe("adSetBudget");
    expect(readFieldAnswer(view.approval!.fields![0]!, "0")).toBeNull();
    expect(readFieldAnswer(view.approval!.fields![0]!, " 42.50 ")).toEqual({ text: "42.50" });
  });

  it("a choice field takes an option number or its label", () => {
    const field = { key: "pick", label: "Pick", input: "choice" as const, required: true,
      options: [{ value: "a", label: "Lower" }, { value: "b", label: "Raise" }] };
    expect(readFieldAnswer(field, "2")).toEqual({ choice: "b" });
    expect(readFieldAnswer(field, "lower")).toEqual({ choice: "a" });
    expect(readFieldAnswer(field, "3")).toBeNull();
  });

  it("on a desktop without confirmFieldsCapable it says to update and never sends ok without the field", () => {
    const view = fixture("change-budget-field");
    const render = approvalRender(view, cardCtx({ fieldsCapable: false }));
    expect(text(render.lines)).toContain("Update the Infinite app to set a value here");
    expect(render.okKey).toBeNull();
    expect(formatKeyBar(render.keys)).toBe("n dismiss");
    const { effects, ui } = drive(view, [press("l"), press("y"), press("", { return: true })], { fieldsCapable: false });
    expect(effects).toEqual([]);
    expect(ui.fieldEntry).toBeNull();
  });
});

describe("a money field with an option (the create-ad-set budget)", () => {
  const field = () => fixture("launch-create-adset-field").approval!.fields![0]!;

  it("typing the option's label sends fields { adSetBudget: { choice: \"meta_split\" } }", () => {
    const view = fixture("launch-create-adset-field");
    const asked = drive(view, [press("c")]);
    // `c` is copy, so "Create ad set" takes the fallback OK key `y`.
    expect(asked.effects).toEqual([]);
    const first = drive(view, [press("y")]);
    expect(first.ui.fieldEntry?.key).toBe("adSetBudget");
    const committed = commitCardField(first.ui, "let meta split the budget");
    expect(committed.error).toBeNull();
    expect(committed.ui.answers).toEqual({ adSetBudget: { choice: "meta_split" } });
    const out = text(approvalRender(view, cardCtx({ ui: committed.ui })).lines);
    expect(out).toContain("Let Meta split the budget");
    expect(out).not.toContain("meta_split");
    expect(drive(view, [press("y")], { ui: committed.ui }).effects)
      .toEqual([{ type: "confirm", decision: "approve", fields: { adSetBudget: { choice: "meta_split" } } }]);
    expect(readFieldAnswer(field(), "meta_split")).toEqual({ choice: "meta_split" });
  });

  it("typing 30 sends { text: \"30\" }, and a bare 1 stays $1/day, never option 1", () => {
    const view = fixture("launch-create-adset-field");
    const first = drive(view, [press("y")]);
    const committed = commitCardField(first.ui, "30");
    expect(drive(view, [press("y")], { ui: committed.ui }).effects)
      .toEqual([{ type: "confirm", decision: "approve", fields: { adSetBudget: { text: "30" } } }]);
    expect(readFieldAnswer(field(), "1")).toEqual({ text: "1" });
  });

  it("lists the option under the field, and the hint names it", () => {
    const view = fixture("launch-create-adset-field");
    expect(text(approvalRender(view, cardCtx()).lines)).toContain("Let Meta split the budget");
    const bad = commitCardField(drive(view, [press("y")]).ui, "thirty");
    expect(bad.error).toBe("Type an amount per day, like 30, or: Let Meta split the budget");
  });

  it("with no readable currency, the hint names only the option, and a typed amount is refused here", () => {
    const view = fixture("launch-create-adset-no-currency");
    const asked = drive(view, [press("y")]);
    const typed = commitCardField(asked.ui, "30");
    expect(typed.error).toBe("Type: Let Meta split the budget");
    expect(typed.error).not.toMatch(/amount|30/u);
    expect(typed.ui.answers).toEqual({});
    const split = commitCardField(asked.ui, "Let Meta split the budget");
    expect(split.ui.answers).toEqual({ adSetBudget: { choice: "meta_split" } });
  });
});

describe("outcome unknown", () => {
  const unknown = (retry: "retryable" | "safe_resend" | "check_first" | "never") =>
    ({
      ...fixture("change-pause-card"),
      state: "outcome_unknown",
      outcome: "unknown",
      retry,
      reconcile: { label: "Check Ads for the result", ask: "did the pause of Hook A land?" }
    }) as AnswerViewV1;
  // The desktop's only retryable shape: certain nothing ran (receipt-view failed()).
  const notSent = (base = fixture("change-pause-card")) =>
    ({ ...base, state: "failed", outcome: "not_sent", retry: "retryable" }) as AnswerViewV1;

  it("prints the reconcile.label", () => {
    expect(text(approvalRender(unknown("check_first"), cardCtx()).lines)).toContain("Check Ads for the result");
    expect(text(renderView(unknown("check_first"), viewCtx()).detail)).toContain("Check Ads for the result");
  });

  it("r is offered only on a failed, not-sent, retryable card", () => {
    for (const retry of ["safe_resend", "check_first", "never", "retryable"] as const) {
      const render = approvalRender(unknown(retry), cardCtx({ caps: ALL_CAPS }));
      expect(render.keys.map((k) => k.key), retry).not.toContain("r");
      expect(drive(unknown(retry), [press("r")], { caps: ALL_CAPS }).effects, retry).toEqual([]);
    }
    const retryable = approvalRender(notSent(), cardCtx());
    expect(retryable.keys.map((k) => k.key)).toContain("r");
    expect(drive(notSent(), [press("r")]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
  });

  it("n on a retryable card sends a real decline: the handle is live again", () => {
    expect(approvalRender(notSent(), cardCtx()).dismiss).toBe("decline");
    expect(drive(notSent(), [press("n")]).effects).toEqual([{ type: "confirm", decision: "decline" }]);
    expect(approvalRender(notSent(), cardCtx()).okKey).toBeNull();
  });

  it("after an approve, the card comes back only for safe_resend or a not-sent retryable, with its approval words", () => {
    const original = fixture("change-pause-card");
    const receipt = (view: AnswerViewV1) => ({ ok: false, view: { ...view, approval: undefined } });
    for (const view of [unknown("safe_resend"), notSent()]) {
      const back = resendView(original, receipt(view));
      expect(back?.state, view.state).toBe(view.state);
      expect(back?.approval?.confirmLabel, view.state).toBe("Pause");
    }
    // outcome_unknown + retryable contradicts itself (the desktop's cleaner rejects it): never brought back.
    for (const view of [unknown("retryable"), unknown("check_first"), unknown("never"),
      { ...notSent(), retry: "never" } as AnswerViewV1]) {
      expect(resendView(original, receipt(view)), `${view.state}/${view.retry}`).toBeNull();
    }
    expect(resendView(original, { ok: true, view: fixture("receipt-dismissed") })).toBeNull();
    expect(resendView(original, { ok: true })).toBeNull();
    expect(resendView(undefined, receipt(unknown("safe_resend")))).toBeNull();
    // A thrown confirm error carries the view the same way.
    const thrown = Object.assign(new Error("Not sent"), { code: "x", view: notSent() });
    expect(resendView(original, thrown)?.retry).toBe("retryable");
  });

  it("pressing OK again is offered only for retry === \"safe_resend\"", () => {
    const resend = approvalRender(unknown("safe_resend"), cardCtx());
    // n on a card already answered only closes it; it never sends a second answer.
    expect(drive(unknown("safe_resend"), [press("n")]).effects).toEqual([{ type: "close" }]);
    expect(resend.okKey).toBe("p");
    expect(formatKeyBar(resend.keys)).toContain("p check again");
    expect(drive(unknown("safe_resend"), [press("p")]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
    for (const view of [unknown("retryable"), unknown("check_first"), unknown("never"), notSent()]) {
      expect(approvalRender(view, cardCtx()).okKey, view.retry).toBeNull();
      expect(drive(view, [press("p")]).effects, view.retry).toEqual([]);
    }
  });

  it("a brought-back card re-sends exactly the answers the first approve sent", () => {
    const original = fixture("change-budget-field");
    const asked = drive(original, [press("l")]);
    const answered = commitCardField(asked.ui, "30").ui;
    const first = drive(original, [press("l")], { ui: answered });
    const sent = { adSetBudget: { text: "30" } };
    expect(first.effects).toEqual([{ type: "confirm", decision: "approve", fields: sent }]);

    const unsure = { ...original, state: "outcome_unknown", outcome: "unknown", retry: "safe_resend", approval: undefined };
    const back = resendView(original, { ok: false, view: unsure })!;
    expect(back).not.toBeNull();
    // The session seeds the brought-back card from its queue entry.
    const seeded = drive(back, [press("l")], { sentFields: sent, ui: cardUiStart({ sentFields: sent }) });
    expect(seeded.effects).toEqual([{ type: "confirm", decision: "approve", fields: sent }]);
    expect(text(seeded.render.lines)).toContain("$30.00/day");
    // Never from the card's own answers: a fresh ui still sends what was sent.
    expect(drive(back, [press("l")], { sentFields: sent }).effects)
      .toEqual([{ type: "confirm", decision: "approve", fields: sent }]);

    const retry = resendView(original, { ok: false, view: { ...unsure, state: "failed", outcome: "not_sent", retry: "retryable" } })!;
    expect(drive(retry, [press("r")], { sentFields: sent }).effects)
      .toEqual([{ type: "confirm", decision: "approve", fields: sent }]);
  });

  it("a card refused with field_invalid comes back with the app's words under its field", () => {
    const ui = cardUiStart({ fieldError: "Budget must be at least $1.\u001b[2J Nothing was executed." });
    const render = approvalRender(fixture("change-budget-field"), cardCtx({ ui }));
    expect(text(render.lines)).toContain("Budget must be at least $1. Nothing was executed.");
    expect(text(render.lines)).not.toMatch(/\u001b/u);
    expect(ui.answers).toEqual({});
    // OK asks for the value again.
    expect(drive(fixture("change-budget-field"), [press("l")], { ui }).ui.fieldEntry?.key).toBe("adSetBudget");
  });
});

describe("receipt detail", () => {
  it("a partial launch receipt lists each item: ✓, ✗ with its reason, ? for unknown", () => {
    const lines = receiptDetailLines({ ok: false, view: fixture("launch-results") }, viewCtx());
    const out = text(lines);
    expect(out).toMatch(/✓ Hook A/u);
    expect(out).toMatch(/✗ Hook B · Rejected by review/u);
    expect(out).toMatch(/\? Hook C/u);
    // The reconcile step is the receipt line's, not repeated here.
    expect(out).not.toContain("Check what landed");
    expect(lines.every((line) => displayWidth(line) <= 72)).toBe(true);
  });

  it("a done or dismissed receipt adds nothing", () => {
    expect(receiptDetailLines({ ok: true, view: fixture("receipt-dismissed") }, viewCtx())).toEqual([]);
    expect(receiptDetailLines({ ok: true, view: { ...fixture("launch-results"), state: "done" } }, viewCtx())).toEqual([]);
    expect(receiptDetailLines({ ok: true }, viewCtx())).toEqual([]);
  });
});

describe("images", () => {
  it("rows print as ✓ 1  Explained  4:5, plus the Library link, and never a URL", () => {
    const render = renderView(fixture("images-done"), viewCtx({ caps: ALL_CAPS }));
    const out = text(render.detail);
    expect(out).toMatch(/✓ 1 {2}Explained +4:5/u);
    expect(out).toMatch(/✓ 3 {2}3 fixes +4:5/u);
    expect(out).toContain("Open in Library ↗  (o)");
    expect(text(renderView(fixture("images-done"), viewCtx()).detail)).not.toContain("(o)");
    expect(out).toContain("About $0.50 for 3, on image-model-1");
    expect(out).not.toMatch(/http/iu);
  });

  it("an item label carrying a URL is never printed with it", () => {
    const view = fixture("images-done");
    const body = { ...(view.body as unknown as Record<string, unknown>) };
    body.items = [{ id: "img_9", label: "see https://cdn.example.com/a.png", status: "failed", failureWords: "http://x.example/y" }];
    const out = text(renderView({ ...view, body } as unknown as AnswerViewV1, viewCtx()).detail);
    expect(out).not.toMatch(/http/iu);
    expect(out).toContain("✗ 1");
  });

  it("a URL in the shell's strings (title, explain, state reason, caveats, next, receipt) is never printed", () => {
    const url = "https://cdn.example.com/img/abc.png";
    const view = {
      ...fixture("images-done"),
      title: `Images ${url}`,
      explain: `Made from ${url}`,
      state: "partial",
      stateReason: { code: "one_failed", words: `one failed: ${url}`, fix: { label: `retry ${url}`, ask: `retry ${url}` } },
      caveats: [`see ${url}`],
      next: [{ label: `open ${url}`, ask: `show me ${url}` }],
      receipt: { sentence: `Made 2 of 3: ${url}`, tone: "warn", revertible: false, provenanceLine: `from ${url}` },
      approval: { kind: "card", title: `Make images ${url}?`, summary: `uses ${url}`, confirmLabel: "Make 3 images",
        dismissLabel: "Dismiss", rows: [{ label: "source", value: url }], effect: `costs ${url}` },
      body: { ...(fixture("images-done").body as unknown as Record<string, unknown>),
        truncated: { shown: 3, total: 9, more: { label: "more", ask: `more from ${url}` } } }
    } as unknown as AnswerViewV1;
    const drawn = renderView(view, viewCtx({ explainOpen: true, caps: ALL_CAPS }));
    const all = [drawn.head, drawn.source ?? "", ...drawn.detail, ...drawn.footnotes, drawn.fixAsk ?? "", ...(drawn.rowAsks ?? []).map((ask) => ask ?? "")];
    expect(text(all)).toContain("one failed");
    expect(text(all)).not.toMatch(/https?:|cdn\.example/u);
    const card = approvalRender({ ...view, state: "needs_yes" } as AnswerViewV1, cardCtx({ ui: { ...CARD_UI_START, explainOpen: true } }));
    expect(text(card.lines)).not.toMatch(/https?:|cdn\.example/u);
    const receipt = confirmResultLines({ view }, "approve").map((line) => line.text);
    expect(text(receipt)).toContain("Made 2 of 3");
    expect(text(receipt)).not.toMatch(/https?:|cdn\.example/u);
    expect(text(receiptDetailLines({ view }, viewCtx()))).not.toMatch(/https?:|cdn\.example/u);
    const facts = viewKeyFacts(view, drawn);
    expect([facts.more, facts.fixAsk, ...facts.rowAsks].join(" ")).not.toMatch(/https?:|cdn\.example/u);
    // The host's own place (appLink) is not a printed image URL: it is kept for `o`.
    expect(text(all)).toContain("Open in Library");
  });

  it("madeWith your_codex prints $0 to Infinite, from cost.whoPays", () => {
    const out = text(renderView(fixture("images-codex"), viewCtx()).detail);
    expect(out).toContain("$0 to Infinite");
    expect(out).toMatch(/⠋ 2 {2}Hook B/u);
    expect(out).toMatch(/· 3 {2}Hook C/u);
    const paidByInfinite = { ...fixture("images-codex"), cost: { usd: 0.5, estimate: true, whoPays: "infinite" } } as AnswerViewV1;
    expect(text(renderView(paidByInfinite, viewCtx()).detail)).not.toContain("$0 to Infinite");
  });

  it("a creative.draft running frame prints Drawing 3 images · ~25 s", () => {
    const frame: CreativeDraftFrameV1 = {
      type: "creative.draft", runId: "run_1", status: "running", count: 3, format: "png", aspectRatio: "4:5",
      quality: "high", pending: [{ startedAtMs: 1_000, etaMs: 25_000 }]
    };
    expect(creativeDraftLine(frame)).toBe("Drawing 3 images · ~25 s");
    expect(creativeDraftLine(frame, 11_000)).toBe("Drawing 3 images · ~15 s");
    expect(creativeDraftLine({ ...frame, pending: [{ startedAtMs: 1_000, etaMs: null }] })).toBe("Drawing 3 images");
    expect(creativeDraftLine({ ...frame, count: 1 })).toBe("Drawing 1 image · ~25 s");
    expect(creativeDraftLine({ ...frame, status: "done" })).toBe("✓ 3 images ready");
    expect(creativeDraftLine({ ...frame, status: "error", error: { code: "x", message: "Blocked\u001b[2J by a check" } }))
      .toBe("✗ Blocked by a check");
    const leaked = creativeDraftLine({ ...frame, status: "error", error: { code: "x", message: "failed to fetch https://cdn.example.com/a.png" } });
    expect(leaked).not.toMatch(/http/iu);
    expect(leaked.startsWith("✗ ")).toBe(true);
  });
});

describe("launch", () => {
  it("a tree prints Campaign / └ Ad set / └ Ads", () => {
    const render = approvalRender(fixture("launch-tree"), cardCtx());
    const out = render.lines;
    const campaign = out.findIndex((line) => /Campaign {2}Campaign 01/u.test(line));
    expect(campaign).toBeGreaterThanOrEqual(0);
    expect(out[campaign + 1]).toMatch(/└ Ad set {2}Ad set 01/u);
    // r4: what the launch creates is marked NEW.
    expect(out[campaign + 2]).toMatch(/ {2}└ Ads {3}NEW Hook A · Hook B · Hook C/u);
    expect(render.okKey).toBe("l");
  });

  it("results.status unknown prints as ?", () => {
    const out = text(renderView(fixture("launch-results"), viewCtx()).detail);
    expect(out).toMatch(/✓ Hook A/u);
    expect(out).toMatch(/✗ Hook B · Rejected by review/u);
    expect(out).toMatch(/\? Hook C/u);
    expect(out).toContain("Check what landed");
  });
});

describe("send card with email bodies", () => {
  const send = () => fixture("launch-send-card");

  it("shows the app's rows (r4: Cmd+L's exact card), the key bar shows v view, and v opens the documents", () => {
    const render = approvalRender(send(), cardCtx());
    const out = text(render.lines);
    expect(out).toContain("│ subject  Your trial ended");
    expect(out).toContain("│ to       200 people");
    expect(formatKeyBar(render.keys)).toBe("v view   s send   n dismiss");
    expect(out).toContain("[v] view   [s] Send to 200 people   [n] dismiss");
    expect(out).not.toContain("Line 1 of the first email.");
    // With no rows from the app, the body speaks: who it reaches and each document's slot and subject.
    const noRows = { ...send(), approval: { ...send().approval!, rows: [] } } as AnswerViewV1;
    const body = text(approvalRender(noRows, cardCtx()).lines);
    expect(body).toContain("Email 1 · Your trial ended");
    expect(body).toContain("200 people · re-counted now");
    expect(body).toContain("10 left out · unsubscribed");
  });

  it("v opens the selected document's full body; 1–3 switch; space pages a long body", () => {
    const opened = drive(send(), [press("v")], { pageRows: 6 });
    expect(opened.ui.documentOpen).toBe(true);
    const page1 = text(opened.render.lines);
    expect(page1).toContain("Your trial ended");
    expect(page1).toContain("Hi {first name},");
    expect(opened.render.pages).toBeGreaterThan(1);
    expect(formatKeyBar(opened.render.keys)).toContain("1-3 email");
    expect(formatKeyBar(opened.render.keys)).toContain("space next page");

    const paged = drive(send(), [press("v"), press(" ")], { pageRows: 6 });
    expect(paged.ui.page).toBe(1);
    expect(text(paged.render.lines)).not.toContain("Hi {first name},");

    const second = drive(send(), [press("v"), press(" "), press("2")], { pageRows: 6 });
    expect(second.ui).toMatchObject({ tab: 1, page: 0 });
    expect(text(second.render.lines)).toContain("Here are three things.");

    // Every page stays inside the width, and the full body is reachable.
    let ui = opened.ui;
    const seen: string[] = [];
    for (let page = 0; page < (opened.render.pages ?? 1); page += 1) {
      const render = approvalRender(send(), cardCtx({ ui: { ...ui, page }, pageRows: 6 }));
      expect(render.lines.every((line) => line.length <= 72)).toBe(true);
      seen.push(...render.lines);
      ui = { ...ui, page };
    }
    // Wrapped body lines rejoin into the whole body: nothing is cut between pages.
    const body = seen.filter((line) => line.startsWith("│")).map((line) => line.replace(/^│ ?/u, "")).join(" ");
    expect(body).toContain("Line 1 of the first email.");
    expect(body).toContain("Line 40 of the first email.");
    expect(body).toContain("See you soon.");

    const closed = drive(send(), [press("v"), press("v")]);
    expect(closed.ui.documentOpen).toBe(false);
  });

  it("the OK key is s (Send to 200 people), and n dismisses", () => {
    expect(drive(send(), [press("s")]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
    expect(drive(send(), [press("v"), press("n")]).effects).toEqual([{ type: "confirm", decision: "decline" }]);
  });

  it("with approval.finishInApp (a withheld body), v is absent and the card prints the finishInApp.words", () => {
    const render = approvalRender(fixture("launch-send-withheld"), cardCtx());
    expect(render.keys.map((k) => k.key)).not.toContain("v");
    expect(text(render.lines)).toContain("The emails are too long to show here. Read them in the app.");
    expect(drive(fixture("launch-send-withheld"), [press("v")]).ui.documentOpen).toBe(false);
  });

  it("o is offered on a card only with caps.open and an app link, matching the (o) in its body", () => {
    const withOpen = approvalRender(fixture("launch-send-withheld"), cardCtx({ caps: { open: true, watch: false, retry: false } }));
    expect(withOpen.keys.map((k) => k.key)).toContain("o");
    expect(text(withOpen.lines)).toContain("(o)");
    const without = approvalRender(fixture("launch-send-withheld"), cardCtx());
    expect(without.keys.map((k) => k.key)).not.toContain("o");
    expect(text(without.lines)).not.toContain("(o)");
    // No app link on the card: no o even when the desktop can open things.
    const noLink = approvalRender(fixture("change-pause-card"), cardCtx({ caps: { open: true, watch: false, retry: false } }));
    expect(noLink.keys.map((k) => k.key)).not.toContain("o");
  });
});

describe("tracked-link card", () => {
  it("shows the link fields read-only; editing stays in Cmd+L", () => {
    const render = approvalRender(fixture("link-tracked-card"), cardCtx());
    const out = text(render.lines);
    expect(out).toMatch(/source +newsletter/u);
    expect(out).toMatch(/medium +email/u);
    expect(out).toMatch(/campaign +spring/u);
    expect(render.okKey).toBe("y");
    expect(render.keys.map((k) => k.key)).not.toContain("e");
    expect(formatKeyBar(render.keys)).toBe("y confirm   n dismiss");
    expect(text(render.lines)).toContain("[y] Confirm");
  });
});

describe("job", () => {
  it("a job with noCompletionSignal has no w key", () => {
    const quiet = renderView(fixture("job-no-signal"), viewCtx({ caps: ALL_CAPS }));
    expect(quiet.keys.map((k) => k.key)).not.toContain("w");
    expect(text(quiet.detail)).toContain("$ export --all");
    const watched = renderView(fixture("job-running"), viewCtx({ caps: ALL_CAPS }));
    expect(watched.keys.map((k) => k.key)).toContain("w");
    expect(renderView(fixture("job-running"), viewCtx()).keys.map((k) => k.key)).not.toContain("w");
  });

  it("steps tick off in place and say where the result lands", () => {
    const out = text(renderView(fixture("job-running"), viewCtx({ caps: ALL_CAPS })).detail);
    expect(out).toMatch(/✓ Outline/u);
    // r4: the running step carries the progress bar (1 of 3), then its detail.
    expect(out).toMatch(/⠋ Draft +█{8}▋░{17} {2}section 2/u);
    expect(out).toMatch(/· Publish/u);
    expect(out).toContain("Lands in: Posts ↗  (o)");
  });
});

describe("change", () => {
  it("rows print before → after, set to, and a null after with its reason", () => {
    const out = text(renderView(fixture("change-budget-field"), viewCtx()).detail);
    expect(out).toMatch(/daily budget +\$40\.00 → you choose/u);
    const setTo = { ...fixture("change-pause-card") } as AnswerViewV1;
    (setTo.body as { rows: unknown[] }).rows = [{ label: "name", after: "Hook A2" }];
    expect(text(renderView(setTo, viewCtx()).detail)).toMatch(/name +set to Hook A2/u);
  });
});

describe("scrub and width", () => {
  const files = readdirSync(FIXTURES).filter((name) => /^(change|launch|images|job|link|receipt)-/u.test(name));

  it("every action fixture renders inside the width, with no escape or bidi characters", () => {
    for (const name of files) {
      const view = JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as Record<string, unknown>;
      const dirty = JSON.parse(JSON.stringify(view, (_key, value) =>
        typeof value === "string" ? `${value}\u001b[2J‮` : value)) as Record<string, unknown>;
      dirty.v = 1; dirty.kind = view.kind; dirty.state = view.state;
      const decoded = decodeAnswerView(dirty);
      expect(decoded, name).not.toBeNull();
      for (const width of [40, 72, 120]) {
        const lines = [
          ...renderView(decoded!, viewCtx({ width, caps: ALL_CAPS, explainOpen: true })).detail,
          ...(decoded!.approval ? approvalRender(decoded!, cardCtx({ width, caps: ALL_CAPS, ui: { ...CARD_UI_START, explainOpen: true, documentOpen: true } })).lines : [])
        ];
        for (const line of lines) {
          expect(line, `${name} @${width}`).not.toMatch(/[\u001b‮]/u);
          expect(displayWidth(line), `${name} @${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

describe("an operation_managed approval on a view (the tool asks twice: OK sends approval.ask)", () => {
  const managed = (over: Record<string, unknown> = {}) => ({
    ...fixture("document-versions"),
    state: "needs_yes",
    approval: {
      kind: "operation_managed", title: "Publish this article?", summary: "Posts it to the demo account now.",
      confirmLabel: "Publish", dismissLabel: "Dismiss", rows: [{ label: "to", value: "@demo" }], ask: "Yes, publish it",
      ...over
    }
  }) as unknown as AnswerViewV1;
  const tab = { tab: true } as Partial<Key>;

  it("draws the approval's title and rows, with its summary behind ?", () => {
    const out = text(renderView(managed(), viewCtx()).detail);
    expect(out).toContain("Publish this article?");
    expect(out).toMatch(/to +@demo/u);
    expect(out).not.toContain("Posts it to the demo account now.");
    expect(text(renderView(managed(), viewCtx({ explainOpen: true })).detail)).toContain("Posts it to the demo account now.");
    expect(viewFocusAfterTurnDone(managed()).facts.explain).toBe(true);
  });

  it("once the view is engaged, the named OK key sends approval.ask as a new user turn, once; n closes it here", () => {
    const s0 = viewFocusAfterTurnDone(managed());
    expect(s0.facts.approve).toEqual({ key: "p", label: "Publish", ask: "Yes, publish it" });
    // Unengaged, p and n are the first letters of a message.
    expect(resolveViewKey("p", s0).effect).toBeNull();
    expect(resolveViewKey("p", s0).focus).toBe("composer");
    const engaged = resolveViewKey("", s0, tab);
    expect(viewKeyHints(engaged).slice(0, 2)).toEqual([{ key: "p", label: "Publish", ok: true }, { key: "n", label: "dismiss" }]);
    // A capital never decides.
    expect(resolveViewKey("P", engaged).effect).toBeNull();
    const yes = resolveViewKey("p", engaged);
    expect(yes.effect).toEqual({ type: "ask", text: "Yes, publish it" });
    expect(yes.approvalClosed).toBe(true);
    expect(resolveViewKey("p", yes).effect).toBeNull();
    expect(viewKeyHints(yes).map((hint) => hint.key)).not.toContain("p");

    const no = resolveViewKey("n", engaged);
    expect(no.handled).toBe(true);
    expect(no.effect).toBeNull();
    expect(no.approvalClosed).toBe(true);
    const closed = text(renderView(managed(), focusedViewCtx(no, { width: 72, color: false, theme })).detail);
    expect(closed).not.toContain("Publish this article?");
  });

  it("a card approval, a settled state, or an ask that is a command offers no OK key on a view", () => {
    expect(viewFocusAfterTurnDone(managed({ kind: "card" })).facts.approve).toBeNull();
    expect(viewFocusAfterTurnDone({ ...managed(), state: "done" } as AnswerViewV1).facts.approve).toBeNull();
    expect(viewFocusAfterTurnDone(managed({ ask: "/exit" })).facts.approve).toBeNull();
    expect(text(renderView(managed({ kind: "card" }), viewCtx()).detail)).not.toContain("Publish this article?");
  });
});

describe("the card frame (r4 card(): at most 74 wide, amber while it needs an OK)", () => {
  it("a card at 160 or 200 columns is at most 74 wide", () => {
    for (const width of [74, 120, 160, 200]) {
      for (const name of ["change-pause-card", "launch-send-card", "launch-tree"]) {
        const lines = approvalRender(fixture(name), cardCtx({ width })).lines;
        expect(Math.max(...lines.map(displayWidth)), `${name} @${width}`).toBeLessThanOrEqual(74);
      }
    }
    // Narrower than 74, the card takes the width it has.
    const narrow = approvalRender(fixture("change-pause-card"), cardCtx({ width: 50 })).lines;
    expect(Math.max(...narrow.map(displayWidth))).toBe(50);
  });

  it("the border is amber (warning) while the card is open, green (success) once done", () => {
    const top = (view: AnswerViewV1) => approvalRender(view, cardCtx({ color: true })).lines
      .find((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").startsWith("┌"))!;
    expect(top(fixture("change-pause-card")).startsWith(ansiFg(theme, "warning"))).toBe(true);
    expect(top({ ...fixture("change-pause-card"), state: "done" } as AnswerViewV1).startsWith(ansiFg(theme, "success"))).toBe(true);
    // A card brought back (not sure, or failed and live again) is still open: amber.
    expect(top({ ...fixture("change-pause-card"), state: "failed", retry: "retryable" } as AnswerViewV1).startsWith(ansiFg(theme, "warning"))).toBe(true);
  });
});

describe("a tall card fits its row budget", () => {
  /** A launch of `sets` ad sets with 3 ads each (the launch-tree shape, synthetic names). */
  function tallLaunch(sets: number): AnswerViewV1 {
    const view = fixture("launch-tree");
    const body = JSON.parse(JSON.stringify(view.body)) as { tree: { children: unknown[] }[] };
    const adSet = JSON.parse(JSON.stringify(body.tree[0]!.children[0])) as { name: string };
    body.tree[0]!.children = Array.from({ length: sets }, (_, index) => ({ ...adSet, name: `Ad set ${index + 1}` }));
    return {
      ...view,
      title: `Launch ${sets * 3} ads`,
      body,
      approval: { ...view.approval!, title: `Launch ${sets * 3} ads?`, confirmLabel: `Launch ${sets * 3} ads` }
    } as AnswerViewV1;
  }

  it("a launch of 10 ad sets × 3 ads at width 80 and maxRows 18 pages its body and keeps the head, title and effect", () => {
    const view = tallLaunch(10);
    const render = approvalRender(view, cardCtx({ width: 80, maxRows: 18 }));
    expect(render.lines.length).toBeLessThanOrEqual(18);
    const out = text(render.lines);
    expect(out).toContain("Needs your OK");
    expect(out).toContain("Launch 30 ads?");
    expect(out).toContain("Lands paused");
    expect(out).toMatch(/page 1 of \d+ · space/u);
    expect(render.pages).toBeGreaterThan(1);
    expect(render.keyCtx.card?.page).toBe(true);
    expect(formatKeyBar(render.keys)).toContain("space next page");

    // Space pages the body; every page fits, and every ad set is reachable.
    const seen = new Set<string>();
    let ui = CARD_UI_START;
    for (let page = 0; page < render.pages!; page += 1) {
      const current = approvalRender(view, cardCtx({ width: 80, maxRows: 18, ui }));
      expect(current.lines.length).toBeLessThanOrEqual(18);
      expect(text(current.lines)).toContain("Launch 30 ads?");
      expect(text(current.lines)).toContain("Lands paused");
      for (const match of text(current.lines).matchAll(/Ad set (\d+)/gu)) seen.add(match[1]!);
      const step = cardKeyStep(resolveKey(" ", {} as Key, current.keyCtx), current, ui);
      expect(step.effect).toBeNull();
      ui = step.ui;
    }
    expect(seen.size).toBe(10);
    expect(ui.page).toBe(0);
    // Space never decides, and the OK key still approves from any page.
    expect(drive(view, [press(" "), press("l")], { width: 80, maxRows: 18 }).effects)
      .toEqual([{ type: "confirm", decision: "approve" }]);
  });

  it("a card that fits draws whole, with no page line", () => {
    const render = approvalRender(fixture("launch-tree"), cardCtx({ width: 80, maxRows: 18 }));
    expect(render.pages).toBeUndefined();
    expect(text(render.lines)).not.toMatch(/page \d+ of/u);
    expect(render.keyCtx.card?.page).toBe(false);
  });

  it("an open document fits the budget too", () => {
    const render = approvalRender(fixture("launch-send-card"), cardCtx({
      width: 80, maxRows: 14, pageRows: 40, ui: { ...CARD_UI_START, documentOpen: true }
    }));
    expect(render.lines.length).toBeLessThanOrEqual(14);
    // r4 "Viewing the email": the head says so, and the document replaces the card.
    expect(text(render.lines)).toContain("Send emails");
    expect(text(render.lines)).toContain("· viewing");
    expect(text(render.lines)).toContain("[1 Email 1]");
    expect(render.pages).toBeGreaterThan(1);
  });
});
