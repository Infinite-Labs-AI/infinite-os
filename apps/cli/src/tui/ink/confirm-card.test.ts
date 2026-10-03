import React from "react";
import { describe, expect, it } from "vitest";

import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { displayWidth } from "../lib/display-width.js";
import { confirmCardKeys } from "../keys/keymap.js";
import { DEFAULT_THEME } from "../theme.js";
import { ConfirmActionMenu, DECLINED_FALLBACK_CAPTION, DISMISSED_WORDS, declineFrame, dismissalSent, dismissedReceiptFrame, fallbackCardLines, fallbackCardRowCount, messagesAfterDecline, receiptViewFrame, settleConfirmOutcome } from "./confirm-card.js";
import { renderCommittedTurn, renderLiveTurn } from "../views/layout.js";
import type { TurnStep } from "../app/turn-store.js";
import { renderToString } from "./renderer.js";

const ESC = String.fromCharCode(27);
const NO_KEY_CAPS = { open: false, watch: false, retry: false } as const;
const plain = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");

function pending(over: Partial<InSessionConfirmationAction> = {}): InSessionConfirmationAction {
  return {
    turnId: "turn_1",
    confirmationHandle: "h_1",
    summary: "Pause ad Hook A",
    confirmationDetails: [{ label: "Ad", value: "Hook A" }, { label: "status", value: "on → paused" }],
    ...over
  };
}

describe("the write card for a desktop that sends no approval view (r4 card)", () => {
  it("draws the same amber card: the summary in the border, the details as rows, the keys inside", () => {
    const lines = fallbackCardLines(pending(), null, 80, DEFAULT_THEME).map(plain);
    expect(lines).toEqual([
      `┌─ Pause ad Hook A ${"─".repeat(54)}┐`,
      `│ Ad       Hook A${" ".repeat(56)}│`,
      `│ status   on → paused${" ".repeat(51)}│`,
      `│${" ".repeat(72)}│`,
      `│ [y] Confirm   [n] dismiss${" ".repeat(46)}│`,
      `│${" ".repeat(72)}│`,
      `│ [?] what it does${" ".repeat(55)}│`,
      `└${"─".repeat(72)}┘`
    ].map((line) => line.replace(/\[(\S)\]/gu, " $1 ")));
    const painted = fallbackCardLines(pending(), null, 80, DEFAULT_THEME);
    // The border is amber, the OK key on amber (pk), never the old "Approve this write? — …" line.
    expect(painted[0]!.startsWith(`${ESC}[38;2;233;180;76m┌─`)).toBe(true);
    expect(painted[4]).toContain(`${ESC}[1;38;2;10;13;17;48;2;233;180;76m y `);
    expect(painted.join("\n")).not.toContain("Approve this write? —");
  });

  it("never titles itself with the tool's name", () => {
    const lines = fallbackCardLines(
      pending({ summary: "mcp infinite app propose pause meta entity", summaryFromTool: true }),
      null,
      80,
      DEFAULT_THEME
    ).map(plain);
    expect(lines[0]!.startsWith("┌─ Approve this write? ─")).toBe(true);
    expect(lines.join("\n")).not.toContain("mcp infinite app");
  });

  it("a summary made from the tool's name is nothing to explain: no '? what it does', and ? has no text", () => {
    const fromTool = pending({ summary: "mcp infinite app propose pause meta entity", summaryFromTool: true });
    const lines = fallbackCardLines(fromTool, null, 80, DEFAULT_THEME).map(plain);
    expect(lines.join("\n")).not.toContain("what it does");
    expect(confirmCardKeys(fromTool, NO_KEY_CAPS).explainText).toBeNull();
    expect(confirmCardKeys(fromTool, NO_KEY_CAPS).ctx.explain).toBe(false);
    // A real summary still explains.
    expect(confirmCardKeys(pending(), NO_KEY_CAPS).explainText).toBe("Pause ad Hook A");
  });

  it("? opens the explanation inside the card, and the row count follows it", () => {
    const closed = fallbackCardLines(pending(), null, 80, DEFAULT_THEME);
    const open = fallbackCardLines(pending(), "Stops this ad's spend until you turn it back on.", 80, DEFAULT_THEME);
    expect(open.map(plain).join("\n")).toContain("│ Stops this ad's spend until you turn it back on.");
    expect(open.length).toBe(closed.length + 2);
    expect(fallbackCardRowCount(pending(), null, 80)).toBe(closed.length);
    expect(fallbackCardRowCount(pending(), "Stops this ad's spend until you turn it back on.", 80)).toBe(open.length);
  });

  it("fits narrow windows and is never wider than 74", () => {
    for (const width of [30, 60, 74, 120, 200]) {
      const lines = fallbackCardLines(pending(), "why", width, DEFAULT_THEME);
      expect(Math.max(...lines.map(displayWidth))).toBe(Math.min(width, 74));
    }
  });

  it("the menu prints a view card's lines through the ANSI bridge, and the fallback otherwise", () => {
    const card = { lines: ["head", "", `${ESC}[38;2;233;180;76m┌─${ESC}[39m title`] } as never;
    const withCard = plain(renderToString(React.createElement(ConfirmActionMenu, {
      card, explainText: null, pending: pending(), theme: DEFAULT_THEME, width: 80
    })));
    expect(withCard.split("\n")).toEqual(["head", "", "┌─ title"]);
    const fallback = plain(renderToString(React.createElement(ConfirmActionMenu, {
      card: null, explainText: null, pending: pending(), theme: DEFAULT_THEME, width: 80
    })));
    expect(fallback.split("\n").map((line) => line.trimEnd())).toEqual(
      fallbackCardLines(pending(), null, 80, DEFAULT_THEME).map(plain).map((line) => line.trimEnd())
    );
    expect(renderToString(React.createElement(ConfirmActionMenu, {
      card: null, explainText: null, pending: null, theme: DEFAULT_THEME, width: 80
    }))).toBe("");
  });
});

describe("the receipt a resolved card leaves on its turn", () => {
  const receipt = (over: Record<string, unknown>) => ({
    ok: true,
    view: {
      v: 1, kind: "change", tool: "propose_pause_entity", title: "Paused ad “Hook A”", state: "done", asOf: null,
      scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
      body: { target: { kind: "ad", label: "Hook A" }, rows: [{ label: "status", before: "on", after: "PAUSED" }], warnings: [] },
      outcome: "applied", receipt: { sentence: "Paused.", tone: "ok", revertible: true },
      ...over
    }
  });

  it("a settled receipt view becomes a turn view keyed to the card", () => {
    const frame = receiptViewFrame(pending(), receipt({}));
    expect(frame).toMatchObject({ type: "tool.view", stage: "tool", viewId: "receipt:h_1", name: "propose_pause_entity" });
    expect(frame?.view.state).toBe("done");
    expect(receiptViewFrame(pending(), receipt({ state: "cancelled", outcome: undefined, receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } }))?.view.state)
      .toBe("cancelled");
    // A failed confirm's error carries its view the same way.
    expect(receiptViewFrame(pending(), Object.assign(new Error("x"), receipt({ state: "expired", outcome: undefined, receipt: undefined, stateReason: { code: "expired", words: "This approval expired." } }))))
      .not.toBeNull();
  });

  it("a receipt with no approval of its own keeps the card's, so the done card still says what it did behind ? (S4, run-r2 NICE)", () => {
    const approval = { kind: "card", title: "Pause ad “Hook A”?", summary: "Sets it PAUSED on Meta, so it stops spending.", confirmLabel: "Pause", dismissLabel: "Dismiss", doneTitle: "Paused ad “Hook A”", rows: [] };
    const card = pending({ view: { ...receipt({}).view, title: "Pause ad “Hook A”?", state: "needs_yes", outcome: undefined, receipt: undefined, approval } as never });
    expect(receiptViewFrame(card, receipt({}))?.view.approval?.summary).toBe("Sets it PAUSED on Meta, so it stops spending.");
    // The app's own approval on the receipt wins; a card with no view adds nothing.
    const own = { ...approval, summary: "The app's words." };
    expect(receiptViewFrame(card, receipt({ approval: own }))?.view.approval?.summary).toBe("The app's words.");
    expect(receiptViewFrame(pending(), receipt({}))?.view.approval).toBeUndefined();
  });

  it("an unsure, partial or retryable receipt, a kind that draws none, or no view keeps the receipt lines", () => {
    expect(receiptViewFrame(pending(), receipt({ state: "outcome_unknown", outcome: "unknown", retry: "check_first" }))).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ state: "partial", outcome: "partial" }))).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ state: "failed", outcome: "not_sent", retry: "retryable", receipt: undefined, stateReason: { code: "x", words: "Not sent." } }))).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ kind: "record", body: { fields: [] } }))).toBeNull();
    expect(receiptViewFrame(pending(), { ok: true, receipt: "Page published" })).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ receipt: undefined }))).toBeNull();
  });
});

describe("n leaves the dismissed card at once (run-2 M5)", () => {
  const approval = { kind: "card", title: "Pause ad “Hook A”?", summary: "Stops its spend.", confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] };
  const cardView = {
    v: 1, kind: "change", tool: "propose_pause_entity", title: "Pause Hook A", state: "needs_yes", asOf: null,
    provenance: { source: "Ads · ad", via: "our_db" },
    scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
    body: { target: { kind: "ad", label: "Hook A" }, rows: [{ label: "Status", before: "On", after: "Paused" }], warnings: [] },
    approval
  };

  it("is the card's own view, settled as dismissed, in the receipt's place", () => {
    const frame = dismissedReceiptFrame(pending({ view: cardView as never }));
    expect(frame).toMatchObject({ type: "tool.view", viewId: "receipt:h_1", name: "propose_pause_entity" });
    expect(frame?.view.state).toBe("cancelled");
    expect(frame?.view.stateReason).toEqual({ code: "dismissed", words: DISMISSED_WORDS });
    expect(frame?.view.approval).toEqual(approval);
    // The app's settled receipt lands on the same id, so it replaces this one in place.
    expect(receiptViewFrame(pending({ view: cardView as never }), { ok: true, view: { ...cardView, state: "expired", approval: undefined, stateReason: { code: "expired", words: "This approval expired." } } })?.viewId)
      .toBe(frame?.viewId);
  });

  it("a card with no view, or of a kind that draws no receipt, waits for the app's lines", () => {
    expect(dismissedReceiptFrame(pending())).toBeNull();
    expect(dismissedReceiptFrame(pending({ view: { ...cardView, kind: "record", body: { fields: [] } } as never }))).toBeNull();
  });

  it("drawn on its turn, the dismissed card and the Steps row's `· dismissed` are in the same frame", () => {
    const frame = dismissedReceiptFrame(pending({ view: cardView as never }))!;
    const steps: TurnStep[] = [{ id: "c1", name: "mcp__app__propose_pause_entity", label: "waiting for your OK", status: "wait", startedAt: 0, endedAt: 1000, result: "pause 1 ad" }];
    const lines = renderLiveTurn({
      messages: [{ role: "user", text: "pause hook a" }, { role: "assistant", text: "Okay, left it running." }],
      views: [frame.view], focus: null, width: 100, color: false, theme: DEFAULT_THEME, steps, nowMs: 2000
    }).lines.map(plain);
    expect(lines).toContain(`✕ ${DISMISSED_WORDS}`);
    expect(lines.find((line) => line.includes("waiting for your OK"))).toMatch(/· dismissed$/u);
    expect(lines.join("\n")).not.toContain("▣");
  });
});

describe("what the app's answer does to a resolved card (CI-runnable M5 wiring)", () => {
  const approval = { kind: "card", title: "Pause ad “Hook A”?", summary: "Stops its spend.", confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] };
  const cardView = {
    v: 1, kind: "change", tool: "propose_pause_entity", title: "Pause Hook A", state: "needs_yes", asOf: null,
    scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
    body: { target: { kind: "ad", label: "Hook A" }, rows: [{ label: "Status", before: "On", after: "Paused" }], warnings: [] },
    approval
  };
  const head = pending({ view: cardView as never });
  const settled = (state: string, words: string) => ({ ok: true, view: { ...cardView, approval: undefined, state, stateReason: { code: state, words } } });
  const decline = { decision: "decline" as const, dismissed: true, onCardTurn: true, thrown: false };

  it("n leaves the dismissed frame at once, and the session records it before anything is sent", () => {
    expect(declineFrame(head, "decline")?.viewId).toBe("receipt:h_1");
    expect(declineFrame(head, "approve")).toBeNull();
    expect(declineFrame(pending(), "decline")).toBeNull();
  });

  it("a plain ok keeps the dismissed frame and prints no lines", () => {
    expect(settleConfirmOutcome(head, { ok: true }, decline)).toEqual({ type: "keep" });
    expect(settleConfirmOutcome(head, undefined, decline)).toEqual({ type: "keep" });
  });

  it("a cancelled receipt on a turn that moved on prints nothing", () => {
    expect(settleConfirmOutcome(head, settled("cancelled", DISMISSED_WORDS), { ...decline, onCardTurn: false })).toEqual({ type: "keep" });
  });

  it("a settled receipt on the card's turn replaces the frame in place, a different outcome included", () => {
    const step = settleConfirmOutcome(head, settled("expired", "This approval expired."), decline);
    expect(step.type).toBe("receipt");
    expect(step.type === "receipt" && step.frame.viewId).toBe("receipt:h_1");
    expect(step.type === "receipt" && step.frame.view.state).toBe("expired");
  });

  it("an expired receipt on a turn that moved on drops the frame and prints the app's lines", () => {
    const step = settleConfirmOutcome(head, settled("expired", "This approval expired."), { ...decline, onCardTurn: false });
    expect(step.type).toBe("drop");
    expect(step.type === "drop" && step.lines.length).toBeGreaterThan(0);
  });

  it("a thrown error drops the frame and prints the error lines", () => {
    const step = settleConfirmOutcome(head, new Error("network down"), { ...decline, thrown: true });
    expect(step.type).toBe("drop");
    expect(step.type === "drop" && step.lines.map((line) => line.text).join("\n")).toContain("network down");
  });

  it("a thrown error that carries a settled receipt replaces the frame instead", () => {
    const error = Object.assign(new Error("x"), settled("expired", "This approval expired."));
    expect(settleConfirmOutcome(head, error, { ...decline, thrown: true }).type).toBe("receipt");
    // A refused field is never a receipt.
    const refused = Object.assign(new Error("x"), { ...settled("expired", "This approval expired."), code: "field_invalid" });
    expect(settleConfirmOutcome(head, refused, { ...decline, thrown: true }).type).toBe("drop");
  });

  it("an approve with no receipt of its own prints the receipt lines", () => {
    const step = settleConfirmOutcome(head, { ok: true, receipt: "Paused." }, { decision: "approve", dismissed: false, onCardTurn: true, thrown: false });
    expect(step.type).toBe("drop");
  });
});


// Live re-check run 3, M5: after `n` the line over the card still read the
// app's pre-OK words ("Ready. It stops spending once you say OK.") where r4
// flow-pause-09 and Cmd+L say "Okay, left it running.". The app sends both
// lines with the decline (`askedCaption`, `dismissedCaption`); only the app's
// own line is swapped, never the model's words.
describe("the line over a declined card (run-3 M5)", () => {
  const ASKED = "Ready. It stops spending once you say OK.";
  const DISMISSED = "Okay, left it running.";
  const turn = (answer: string) => [
    { role: "user" as const, text: "pause hook b" },
    { role: "assistant" as const, text: answer }
  ];
  const declined = { ok: true, declined: true, askedCaption: ASKED, dismissedCaption: DISMISSED };

  it("the app's line over the card becomes the app's words after a no", () => {
    expect(messagesAfterDecline(turn(ASKED), declined)).toEqual(turn(DISMISSED));
    // Each kind says its own words (a daily budget: "Okay, kept the budget as it is.").
    expect(messagesAfterDecline(turn("Ready. It saves $10 a day once you say OK."), {
      ...declined, askedCaption: "Ready. It saves $10 a day once you say OK.", dismissedCaption: "Okay, kept the budget as it is."
    })).toEqual(turn("Okay, kept the budget as it is."));
  });

  it("never swaps the model's own words", () => {
    const own = turn("Hook B spent $12.40 with no trials. Pause it?");
    expect(messagesAfterDecline(own, declined)).toBe(own);
    // More than one answer message is the model's, even when one repeats the line.
    const twice = [...turn(ASKED), { role: "assistant" as const, text: "More words." }];
    expect(messagesAfterDecline(twice, declined)).toBe(twice);
  });

  it("a desktop that sends no words of its own: a turn that said nothing gets the neutral line; any words stay", () => {
    const plain = { ok: true, declined: true };
    expect(messagesAfterDecline(turn(""), plain)).toEqual(turn(DECLINED_FALLBACK_CAPTION));
    expect(messagesAfterDecline([{ role: "user", text: "pause hook b" }], plain)).toEqual(turn(DECLINED_FALLBACK_CAPTION));
    const asked = turn(ASKED);
    expect(messagesAfterDecline(asked, plain)).toBe(asked);
    // Neutral: it claims nothing about what still runs or spends.
    expect(DECLINED_FALLBACK_CAPTION).not.toMatch(/running|spend|paus/iu);
  });

  it("a no the app did not take, or a turn already in scrollback, changes nothing", () => {
    const asked = turn(ASKED);
    expect(messagesAfterDecline(asked, { ...declined, ok: false })).toBe(asked);
    expect(messagesAfterDecline(asked, new Error("network down"))).toBe(asked);
    expect(messagesAfterDecline(asked, undefined)).toBe(asked);
    const gone: { role: "user" | "assistant"; text: string }[] = [];
    expect(messagesAfterDecline(gone, declined)).toBe(gone);
  });

  it("the app's words are scrubbed like every app line", () => {
    const esc = String.fromCharCode(27);
    const out = messagesAfterDecline(turn(ASKED), { ...declined, dismissedCaption: `${esc}[31mOkay, left it running.${esc}[0m` });
    expect(out[1]?.text).toBe(DISMISSED);
  });
});

// Live re-check run 3, N22: `Sent to the app` was drawn the moment `n` was
// pressed and never changed. While the no is on its way the dismissed card
// says so; once the app answers it reads r4's last frame (`Sent to the app`),
// or the app's own word when its receipt carries one.
describe("the dismissed card's last line follows the app's answer (run-3 N22)", () => {
  const cardView = {
    v: 1, kind: "change", tool: "propose_pause_entity", title: "Pause Hook A", state: "needs_yes", asOf: null,
    scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
    body: { target: { kind: "ad", label: "Hook A" }, rows: [{ label: "Status", before: "On", after: "Paused" }], warnings: [] },
    approval: { kind: "card", title: "Pause ad “Hook A”?", summary: "Stops its spend.", confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] }
  };
  const head = pending({ view: cardView as never });
  const drawn = (frame: { view: unknown }) => renderLiveTurn({
    messages: [{ role: "user", text: "pause hook a" }, { role: "assistant", text: "Okay, left it running." }],
    views: [frame.view as never], focus: null, width: 100, color: false, theme: DEFAULT_THEME
  }).lines.map(plain);
  const appReceipt = (receipt: Record<string, unknown>) => ({
    ok: true, declined: true,
    view: { ...cardView, approval: undefined, state: "cancelled", receipt: { sentence: DISMISSED_WORDS, tone: "ok", revertible: false, ...receipt } }
  });

  it("while the no is on its way: `Sending to the app…`, never `Sent`", () => {
    const lines = drawn(dismissedReceiptFrame(head)!);
    expect(lines).toContain(`✕ ${DISMISSED_WORDS}`);
    expect(lines).toContain("Sending to the app…");
    expect(lines.join("\n")).not.toContain("Sent to the app");
  });

  it("the app's receipt replaces it in place: `Sent to the app`, as r4's last frame", () => {
    const step = settleConfirmOutcome(head, appReceipt({}), { decision: "decline", dismissed: true, onCardTurn: true, thrown: false });
    expect(step.type).toBe("receipt");
    const lines = drawn(step.type === "receipt" ? step.frame : { view: null });
    expect(lines).toContain("Sent to the app");
    expect(lines.join("\n")).not.toContain("Sending");
  });

  it("the app's own word, when its receipt carries one", () => {
    const step = settleConfirmOutcome(head, appReceipt({ provenanceLine: "Recorded in the app" }), { decision: "decline", dismissed: true, onCardTurn: true, thrown: false });
    const lines = drawn(step.type === "receipt" ? step.frame : { view: null });
    expect(lines).toContain("Recorded in the app");
    expect(lines.join("\n")).not.toMatch(/Sen(t|ding) to the app/u);
  });

  it("an app that took the no with no receipt of its own: the same card, now sent", () => {
    const frame = dismissedReceiptFrame(head)!;
    const sent = dismissalSent(frame);
    expect(sent.viewId).toBe(frame.viewId);
    expect(drawn(sent)).toContain("Sent to the app");
    expect(drawn(sent).join("\n")).not.toContain("Sending");
  });

  it("printed into scrollback, where nothing follows the answer, it says what was done: sent", () => {
    const lines = renderCommittedTurn({
      messages: [{ role: "user", text: "pause hook a" }], views: [dismissedReceiptFrame(head)!.view], focus: null, width: 100, color: false, theme: DEFAULT_THEME
    }).map(plain);
    expect(lines).toContain("Sent to the app");
    expect(lines.join("\n")).not.toContain("Sending");
  });
});
