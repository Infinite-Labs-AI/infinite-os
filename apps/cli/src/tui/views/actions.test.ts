import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1, CreativeDraftFrameV1 } from "@infinite-os/types";
import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { confirmResultLines } from "../../desktop/confirm-result-lines.js";
import { formatKeyBar, resolveKey } from "../keys/keymap.js";
import { displayWidth } from "../lib/display-width.js";
import { resolveTheme } from "../theme.js";
import {
  approvalRender,
  CARD_UI_START,
  cardKeyStep,
  commitCardField,
  readFieldAnswer,
  resendView,
  type ApprovalRenderCtx,
  type CardUiState
} from "./approval.js";
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
  it("confirmLabel Pause gives the OK key p, and the bar reads p Pause   n dismiss", () => {
    const render = approvalRender(fixture("change-pause-card"), cardCtx());
    expect(render.okKey).toBe("p");
    expect(render.keyCtx.okKey).toBe("p");
    expect(formatKeyBar(render.keys).startsWith("p Pause   n dismiss")).toBe(true);
    const noExplain = approvalRender({ ...fixture("change-pause-card"), approval: { ...fixture("change-pause-card").approval!, summary: null } } as AnswerViewV1, cardCtx());
    expect(formatKeyBar(noExplain.keys)).toBe("p Pause   n dismiss");
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

describe("outcome unknown", () => {
  const unknown = (retry: "retryable" | "safe_resend" | "check_first" | "never") =>
    ({
      ...fixture("change-pause-card"),
      state: "outcome_unknown",
      outcome: "unknown",
      retry,
      reconcile: { label: "Check Ads for the result", ask: "did the pause of Hook A land?" }
    }) as AnswerViewV1;

  it("prints the reconcile.label", () => {
    expect(text(approvalRender(unknown("check_first"), cardCtx()).lines)).toContain("Check Ads for the result");
    expect(text(renderView(unknown("check_first"), viewCtx()).detail)).toContain("Check Ads for the result");
  });

  it("r is absent unless retry === \"retryable\"", () => {
    for (const retry of ["safe_resend", "check_first", "never"] as const) {
      const render = approvalRender(unknown(retry), cardCtx({ caps: ALL_CAPS }));
      expect(render.keys.map((k) => k.key), retry).not.toContain("r");
      expect(drive(unknown(retry), [press("r")], { caps: ALL_CAPS }).effects, retry).toEqual([]);
    }
    const retryable = approvalRender(unknown("retryable"), cardCtx());
    expect(retryable.keys.map((k) => k.key)).toContain("r");
    expect(drive(unknown("retryable"), [press("r")]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
  });

  it("after an approve, the card comes back only for safe_resend or retryable, with its approval words", () => {
    const original = fixture("change-pause-card");
    const receipt = (retry: string) => ({ ok: false, view: { ...unknown(retry as "never"), approval: undefined } });
    for (const retry of ["safe_resend", "retryable"]) {
      const back = resendView(original, receipt(retry));
      expect(back?.state, retry).toBe("outcome_unknown");
      expect(back?.approval?.confirmLabel, retry).toBe("Pause");
    }
    for (const retry of ["check_first", "never"]) {
      expect(resendView(original, receipt(retry)), retry).toBeNull();
    }
    expect(resendView(original, { ok: true, view: fixture("receipt-dismissed") })).toBeNull();
    expect(resendView(original, { ok: true })).toBeNull();
    expect(resendView(undefined, receipt("safe_resend"))).toBeNull();
  });

  it("pressing OK again is offered only for retry === \"safe_resend\"", () => {
    const resend = approvalRender(unknown("safe_resend"), cardCtx());
    // n on a card already answered only closes it; it never sends a second answer.
    expect(drive(unknown("safe_resend"), [press("n")]).effects).toEqual([{ type: "close" }]);
    expect(resend.okKey).toBe("p");
    expect(formatKeyBar(resend.keys)).toContain("p check again");
    expect(drive(unknown("safe_resend"), [press("p")]).effects).toEqual([{ type: "confirm", decision: "approve" }]);
    for (const retry of ["retryable", "check_first", "never"] as const) {
      expect(approvalRender(unknown(retry), cardCtx()).okKey, retry).toBeNull();
      expect(drive(unknown(retry), [press("p")]).effects, retry).toEqual([]);
    }
  });
});

describe("images", () => {
  it("rows print as ✓ 1  Explained  4:5, plus the Library link, and never a URL", () => {
    const render = renderView(fixture("images-done"), viewCtx({ caps: ALL_CAPS }));
    const out = text(render.detail);
    expect(out).toMatch(/✓ 1 {2}Explained +4:5/u);
    expect(out).toMatch(/✓ 3 {2}3 fixes +4:5/u);
    expect(out).toContain("Open in Library (o)");
    expect(text(renderView(fixture("images-done"), viewCtx()).detail)).not.toContain("(o)");
    expect(out).toContain("~$0.50");
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

  it("madeWith your_codex prints $0 to Infinite, from cost.whoPays", () => {
    const out = text(renderView(fixture("images-codex"), viewCtx()).detail);
    expect(out).toContain("$0 to Infinite");
    expect(out).toMatch(/◑ 2 {2}Hook B/u);
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
  });
});

describe("launch", () => {
  it("a tree prints Campaign / └ Ad set / └ Ads", () => {
    const render = approvalRender(fixture("launch-tree"), cardCtx());
    const out = render.lines;
    const campaign = out.findIndex((line) => /Campaign {2}Campaign 01/u.test(line));
    expect(campaign).toBeGreaterThanOrEqual(0);
    expect(out[campaign + 1]).toMatch(/└ Ad set {2}Ad set 01/u);
    expect(out[campaign + 2]).toMatch(/ {2}└ Ads {3}Hook A · Hook B · Hook C/u);
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

  it("lists each document's slot and subject, and the key bar shows v view", () => {
    const render = approvalRender(send(), cardCtx());
    const out = text(render.lines);
    expect(out).toContain("Email 1 · Your trial ended");
    expect(out).toContain("Email 2 · Three things we found");
    expect(out).toContain("Email 3 · Last note");
    expect(out).toContain("200 people · re-counted now");
    expect(out).toContain("10 left out · unsubscribed");
    expect(formatKeyBar(render.keys).startsWith("v view   s Send to 200 people   n dismiss")).toBe(true);
    expect(out).not.toContain("Line 1 of the first email.");
  });

  it("v opens the selected document's full body; 1–3 switch; space pages a long body", () => {
    const opened = drive(send(), [press("v")], { pageRows: 6 });
    expect(opened.ui.documentOpen).toBe(true);
    const page1 = text(opened.render.lines);
    expect(page1).toContain("Your trial ended");
    expect(page1).toContain("Hi {first name},");
    expect(opened.render.pages).toBeGreaterThan(1);
    expect(formatKeyBar(opened.render.keys)).toContain("1-3 switch");
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
    const inside = seen.filter((line) => line.startsWith("│ ")).map((line) => line.slice(2, -2).trimEnd());
    const body = inside.filter((line) => line.startsWith("│")).map((line) => line.replace(/^│ ?/u, "")).join(" ");
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
    expect(formatKeyBar(render.keys)).toBe("y Confirm   n dismiss");
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
    expect(out).toMatch(/◑ Draft · section 2/u);
    expect(out).toMatch(/· Publish/u);
    expect(out).toContain("1 of 3");
    expect(out).toContain("Lands in Posts (o)");
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
