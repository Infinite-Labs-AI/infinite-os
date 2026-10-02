import React from "react";
import { describe, expect, it } from "vitest";

import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { displayWidth } from "../lib/display-width.js";
import { confirmCardKeys } from "../keys/keymap.js";
import { DEFAULT_THEME } from "../theme.js";
import { ConfirmActionMenu, fallbackCardLines, fallbackCardRowCount, receiptViewFrame } from "./confirm-card.js";
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

  it("an unsure, partial or retryable receipt, a kind that draws none, or no view keeps the receipt lines", () => {
    expect(receiptViewFrame(pending(), receipt({ state: "outcome_unknown", outcome: "unknown", retry: "check_first" }))).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ state: "partial", outcome: "partial" }))).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ state: "failed", outcome: "not_sent", retry: "retryable", receipt: undefined, stateReason: { code: "x", words: "Not sent." } }))).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ kind: "record", body: { fields: [] } }))).toBeNull();
    expect(receiptViewFrame(pending(), { ok: true, receipt: "Page published" })).toBeNull();
    expect(receiptViewFrame(pending(), receipt({ receipt: undefined }))).toBeNull();
  });
});
