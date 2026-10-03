import React from "react";
import { describe, expect, it } from "vitest";

import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { displayWidth } from "../lib/display-width.js";
import { confirmCardKeys } from "../keys/keymap.js";
import { DEFAULT_THEME } from "../theme.js";
import { ConfirmActionMenu, DISMISSED_WORDS, declineFrame, dismissedReceiptFrame, fallbackCardLines, fallbackCardRowCount, receiptViewFrame, settleConfirmOutcome } from "./confirm-card.js";
import { renderLiveTurn } from "../views/layout.js";
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

