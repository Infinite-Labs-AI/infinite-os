import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  renderInkInteractiveSessionToString,
  runInkInteractiveSession,
  type InkInteractiveLineResult
} from "./interactive-session.js";
import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { resetTurnState } from "../app/turn-store.js";

const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
const cardSource = readFileSync(fileURLToPath(new URL("./confirm-card.tsx", import.meta.url)), "utf8");

// A representative (already-redacted) pending write confirmation, mirroring what
// `desktop-turn-source.parsePendingConfirmations` surfaces from a `done` frame.
const PENDING: InSessionConfirmationAction = {
  turnId: "t1",
  confirmationHandle: "h1",
  summary: "Publish landing page to production",
  confirmationDetails: [
    { label: "domain", value: "acme.example.com" },
    { label: "revision", value: "rev_42" }
  ]
};

const stripAnsi = (value: string) => value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

describe("Ink in-session write confirmation (Plan 2) — structural guards (CI-runnable)", () => {
  it("gates the card inside the SINGLE useInput owner through the keymap", () => {
    // The write gate must live in the one useInput owner, before the plain
    // composer. The keymap (keymap.ts, pinned by keymap.test.ts) decides: only
    // the card's named OK key approves, only n dismisses (a real "no" that
    // reaches the app), ? explains; Enter and Escape are swallowed with every
    // other key. No hard-coded letter survives here.
    const block = source.slice(
      source.indexOf("if (confirmActionActive) {"),
      source.indexOf("if (selectionActive) {")
    );
    expect(block).toContain("resolveKey(input, key, confirmKeys)");
    expect(block).toContain('if (action.type === "ok") {\n        onConfirmActionApprove();');
    expect(block).toContain('} else if (action.type === "dismiss") {\n        onConfirmActionDecline();');
    expect(block).toContain('} else if (action.type === "explain") {\n        onConfirmActionExplain();');
    expect(block).not.toMatch(/input === "[a-zA-Z]"/);
    expect(block).not.toContain("key.return");
    expect(block).not.toContain("key.escape");
  });

  it("names the OK key from the approval view, draws the key bar LAST (under the composer), and counts its row", () => {
    expect(source).toContain("confirmCardKeys(headConfirmAction, NO_KEY_CAPS)");
    // The bar's row feeds the live-region cap's key-bar slot; it is under the
    // composer, so never in the composer-row prediction (the rule over it is).
    expect(source).toContain("const keyBarRows = keyBarRowCount(keyHints, columns);");
    // Twice: the turn's row budget and the live layout.
    expect(source.match(/^\s+keyBarRows: barRows,$/gm)?.length).toBe(2);
    expect(source).toContain("reserved: number, barRows: number) => inkTranscriptLayout({");
    expect(source).toContain("=> layoutAt(latest, shown, reservedRows, keyBarRows);");
    expect(source).toContain("keyBarRows={keyBarRows}");
    // The rule over the composer is counted only when it is drawn (`composerRuleRows`).
    expect(source).toContain("const composerRow = homeInventoryRows + liveLayout.rowCount + draftLines.length + composerRuleRows;");
    expect(source.indexOf("<KeyBar hints={keyHints}")).toBeGreaterThan(source.indexOf("<InkLineInput"));
    expect(source.indexOf("<KeyBar hints={keyHints}")).toBeGreaterThan(source.indexOf("<CompletionMenu"));
    expect(source).toContain("{composerRuleRows ? <AnsiLine line={ruleLine(columns, t)} /> : null}");
    expect(source.indexOf("<AnsiLine line={ruleLine(columns, t)} />")).toBeGreaterThan(source.indexOf("<ConfirmActionMenu"));
    expect(source.indexOf("<AnsiLine line={ruleLine(columns, t)} />")).toBeLessThan(source.indexOf("<InkLineInput"));
    // The old fixed affordance is gone: the bar shows only what works now.
    expect(source).not.toContain("[y] approve");
  });

  it("closes the explanation whenever the head card changes, whoever changed the queue", () => {
    // Keyed to the head card itself, so a new card never opens with an earlier
    // card's explanation expanded (r4: the explanation stays behind ?), nor with
    // its open document, page or field answers. (A card brought back opens with
    // only the answers its own entry carries: cardUiStart(entry).)
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\n\s+setExplainOpen\(false\);\n\s+setCardUi\(cardUiStart\(headConfirmAction\)\);\n\s+\}, \[headConfirmAction\]\);/u
    );
  });

  it("shows esc stop in the key bar while a stoppable turn runs and no card is pending", () => {
    expect(source).toContain(
      'keyBarHints({ focus: "composer", busy: busy && turnStoppable, okKey: null, caps: NO_KEY_CAPS })'
    );
  });

  it("dequeues the head BEFORE acting so a single-use handle can't double-resolve", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    // Dequeue precedes the branch that calls onConfirmAction.
    expect(handler.indexOf("setPendingConfirmActions((current) => current.slice(1))"))
      .toBeLessThan(handler.indexOf("onConfirmAction?.(head"));
    // Both decisions reach the app: a decline is a real "no", not a local note.
    // T12: plus the stream's hooks (the receipt, then the follow-up), the same one call.
    expect(handler).toContain("onConfirmAction?.(head, decision, fields, streamHooks)");
    expect(handler).not.toContain('if (decision === "decline")');
  });

  it("prints receipt lines, never the JSON result; a settled receipt view goes on the turn instead", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    // Both the answer and a thrown error settle through the one pure step
    // (confirm-card.tsx settleConfirmOutcome: receipt view on the turn, keep, or lines).
    expect(handler).toContain("settleConfirmOutcome(head, outcome, { decision, dismissed: dismissed !== null, onCardTurn: onCardTurn(), thrown })");
    expect(handler).toContain("if (settle(result, false)) afterReceipt(result);");
    expect(handler).toContain("if (settle(error, true) && !refusedField(error)) afterReceipt(error);");
    expect(handler).toContain("recordTurnView(step.frame);");
    expect(handler).toContain("appendLines(step.lines);");
    expect(cardSource).toContain("confirmResultLines(outcome, opts.decision)");
    expect(cardSource).toContain("confirmErrorLines(outcome)");
    expect(handler).not.toContain("JSON.stringify");
  });

  it("n records the dismissed card BEFORE the decline is sent (run-2 M5, CI-visible)", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    expect(handler).toContain("const dismissed = declineFrame(head, decision);");
    expect(handler).toMatch(/if \(dismissed\) \{\s+recordTurnView\(dismissed\);/u);
    expect(handler.indexOf("recordTurnView(dismissed)")).toBeGreaterThan(-1);
    expect(handler.indexOf("recordTurnView(dismissed)")).toBeLessThan(handler.indexOf("onConfirmAction?.(head"));
    // The decline is sent once: one call to the app in the handler.
    expect(handler.split("onConfirmAction?.(").length - 1).toBe(1);
  });

  it("a no the app took swaps the line over the card on the card's turn only (run-3 M5, CI-visible)", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    expect(handler).toContain('if (decision === "decline" && onCardTurn()) setHistory((current) => messagesAfterDecline(current, outcome));');
    // With the dismissed receipt it answered with, or when it kept the dismissed card; never on a thrown answer.
    expect(handler).toMatch(/recordTurnView\(step\.frame\);\s+refocusCardTurn\(\);\s+if \(!thrown && step\.frame\.view\.state === "cancelled"\) captionDeclined\(outcome\);/u);
    expect(handler).toMatch(/if \(step\.type === "keep"\) \{\s+if \(!thrown\) \{[^}]*captionDeclined\(outcome\);/u);
  });

  it("a card that carries the app's captions changes the line at the key, and puts it back when the no did not land (M5 review, CI-visible)", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    // At the key: the swap comes before the decline is sent, with the dismissed card.
    expect(handler).toContain("const early = decision === \"decline\" && dismissed && onCardTurn() ? head.captions ?? null : null;");
    expect(handler.indexOf("if (early) setHistory(")).toBeGreaterThan(-1);
    expect(handler.indexOf("if (early) setHistory(")).toBeLessThan(handler.indexOf("onConfirmAction?.(head"));
    // Put back when the app did not take the no: a failure's lines, a thrown answer, or another receipt.
    expect(handler.split("restoreCaption();").length - 1).toBe(3);
  });

  it("the keys move to the card's frame on its turn, so the bar shows only keys that work now (run-3 N20, CI-visible)", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    expect(handler).toContain("setViewFocus(views.length ? viewFocusAfterTurnDone(views.map((frame) => frame.view), viewCaps()) : null);");
    expect(handler).toMatch(/const refocusCardTurn = \(\) => \{\s+if \(!onCardTurn\(\)\) return;/u);
    // After the dismissed (or working) frame, after the app's receipt, and when the frame is taken off.
    expect(handler).toContain("if (working || dismissed) refocusCardTurn();");
    // T12: a streamed follow-up's views move the keys too, on the card's turn only.
    expect(handler.split("refocusCardTurn();").length - 1).toBe(4);
  });

  it("a no the app took with no receipt of its own leaves the dismissed card, now sent (run-3 N22, CI-visible)", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    expect(handler).toContain("if (dismissed && onCardTurn()) recordTurnView(dismissalSent(dismissed));");
  });

  it("scrubs the un-redacted summary through terminalText before rendering", () => {
    // The card (confirm-card.tsx) runs the summary through terminalText; the
    // details are redacted upstream and scrubbed again as they become rows;
    // receipts are scrubbed by confirmResultLines.
    expect(source).toMatch(/import \{ fallbackCardLines, [^}]+ \} from "\.\/confirm-card\.js";/u);
    expect(source).not.toContain("function ConfirmActionMenu(");
    expect(cardSource).toContain("terminalText(pending.summary)");
    expect(cardSource).toContain("label: terminalText(detail.label), value: terminalText(detail.value)");
  });

  it("blocks the queued-line drain while a confirmation is pending", () => {
    const drain = source.slice(
      source.indexOf("useEffect(() => {\n    // Don't drain"),
      source.indexOf("const submitLine = useCallback")
    );
    expect(drain).toContain("pendingConfirmActions.length > 0");
    // A confirm still in flight holds the queue too: its receipt belongs to this turn.
    expect(drain).toContain("confirmsInFlight > 0");
  });

  it("records a receipt view only on the turn its card came from", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction = useCallback"),
      source.indexOf("const handleCardAction = useCallback")
    );
    expect(handler).toContain("const seqAtResolve = commitSeq.current;");
    expect(handler).toContain("commitSeq.current === seqAtResolve");
  });

  it("keeps r4's ❯ prompt while a write card waits (its keys are in the key bar); an operator confirm shows `!`", () => {
    expect(source).toContain('const label = pendingConfirmation ? "!" : pickerActive ? "?" : theme.brand.prompt;');
    expect(source).toContain("|| confirmActionActive;"); // folded into overlayActive (native cursor off)
    // D6 and r4: the card's keys are said once, in the key bar, never in the placeholder.
    expect(source).not.toContain("`press ${confirmKeys.ctx.okKey} to");
  });

  it("renders the confirmation summary + redacted details via initial messages (no PTY)", () => {
    // The overlay renders from internal state (needs a driven turn); prove at
    // least the transcript can carry the redacted detail lines without leaking.
    const rendered = renderInkInteractiveSessionToString(
      {
        columns: 80,
        onSubmitLine: async () => ({}),
        title: "Infinite TUI",
        initialMessages: [
          { kind: "slash", role: "system", text: "domain: acme.example.com" }
        ]
      },
      { columns: 80 }
    );
    expect(rendered).toContain("acme.example.com");
  });
});

describe("Ink in-session write confirmation (Plan 2) — live PTY flow (skipped on CI)", () => {
  // Same fake-PTY limitation as the sibling connect/busy PTY tests: never ticks on
  // headless CI, runs in milliseconds locally, and is the primary functional proof.

  it.skipIf(process.env.CI === "true")(
    "y approves → calls onConfirmAction(approve) and renders the receipt, not JSON",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const confirmed: Array<{ handle: string; decision: string }> = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (action, decision) => {
          confirmed.push({ handle: action.confirmationHandle, decision });
          return { ok: true, published: "rev_42", receipt: "Page published" };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [{ role: "assistant", text: "done" }], pendingConfirmations: [PENDING] };
        }
      });

      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "publish it\r");
      // The card: the summary in its border, the redacted details as rows, the keys inside.
      await waitFor(() => output.text().includes("Publish landing page to production"), 4_000, output.text);
      expect(output.text()).toContain("acme.example.com");
      expect(output.text()).not.toContain("Approve this write?");
      // Old desktop (no approval view): the bar names y Confirm and n dismiss.
      expect(stripAnsi(output.text())).toContain(" y  Confirm    n  dismiss");

      await sendKeys(input, "y");
      await waitFor(() => confirmed.length === 1, 4_000, output.text);
      // The receipt lands in the transcript; the JSON never does.
      await waitFor(() => output.text().includes("✓ Page published"), 4_000, output.text);
      expect(output.text()).not.toContain('"published"');

      expect(confirmed).toEqual([{ handle: "h1", decision: "approve" }]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "n declines → sends a real decline and prints the dismissed receipt",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const confirmed: string[] = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (action, decision) => {
          confirmed.push(decision);
          return { ok: true };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [PENDING] };
        }
      });

      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "publish it\r");
      await waitFor(() => output.text().includes("Publish landing page to production"), 4_000, output.text);

      await sendKeys(input, "n");
      await waitFor(() => output.text().includes("✕ Dismissed — nothing was executed."), 4_000, output.text);
      // The decline reaches the app.
      expect(confirmed).toEqual(["decline"]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "bare Enter and Esc never decline: the card stays and nothing is sent",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const confirmed: string[] = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (_action, decision) => {
          confirmed.push(decision);
          return {};
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [PENDING] };
        }
      });

      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "publish it\r");
      await waitFor(() => output.text().includes("Publish landing page to production"), 4_000, output.text);

      await sendKeys(input, "\r");
      await sendKeys(input, "\x1b");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(confirmed).toEqual([]);
      expect(output.text()).not.toContain("Dismissed");
      // Still pending: the card's own n is what declines.
      await sendKeys(input, "n");
      await waitFor(() => confirmed.length === 1, 4_000, output.text);
      expect(confirmed).toEqual(["decline"]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a view names the OK key: p pauses, y does nothing, ? shows the explanation",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const confirmed: string[] = [];
      const withView = {
        ...PENDING,
        view: {
          v: 1, kind: "change", tool: "propose_pause_meta_entity", title: "Pause ad", state: "needs_yes", asOf: null,
          scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
          approval: { kind: "card", title: "Pause ad 01?", summary: "Stops spend on Ad 01 until you turn it back on.",
            confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] },
          body: { target: { kind: "ad", label: "Ad 01" }, rows: [], warnings: [] }
        }
      } as unknown as InSessionConfirmationAction;

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (_action, decision) => {
          confirmed.push(decision);
          return { ok: true, receipt: "Paused ad 01" };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [withView] };
        }
      });

      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => stripAnsi(output.text()).includes(" p  pause    n  dismiss    tab  switch side"), 4_000, output.text);
      expect(output.text()).not.toContain("Stops spend on Ad 01");

      await sendKeys(input, "y");
      await sendKeys(input, "\r");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(confirmed).toEqual([]);

      await sendKeys(input, "?");
      await waitFor(() => output.text().includes("Stops spend on Ad 01"), 4_000, output.text);

      await sendKeys(input, "p");
      await waitFor(() => output.text().includes("✓ Paused ad 01"), 4_000, output.text);
      expect(confirmed).toEqual(["approve"]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );
});

describe("receipts on the turn (r4 receipts; fake TTY, skipped on CI)", () => {
  const RECEIPT_VIEW = {
    v: 1, kind: "change", tool: "propose_pause_meta_entity", title: "Paused ad 01", state: "done", asOf: null,
    scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
    body: { target: { kind: "ad", label: "Ad 01" }, rows: [{ label: "status", before: "on", after: "PAUSED" }], warnings: [] },
    outcome: "applied", receipt: { sentence: "Stopped spending at 10:42", tone: "ok", revertible: true }
  };
  const CARD = {
    ...PENDING,
    view: {
      ...RECEIPT_VIEW, title: "Pause ad", state: "needs_yes", outcome: undefined, receipt: undefined,
      approval: { kind: "card", title: "Pause ad 01?", summary: "Stops spend.", confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] }
    }
  } as unknown as InSessionConfirmationAction;

  async function answer(key: string, result: unknown) {
    const input = ttyInput();
    const output = ttyOutput();
    const session = runInkInteractiveSession({
      columns: 80,
      errorOutput: ttyOutput(),
      input,
      output,
      title: "Infinite TUI",
      onConfirmAction: async () => result,
      async onSubmitLine(): Promise<InkInteractiveLineResult> {
        return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
      }
    });
    await waitFor(() => output.text().includes("Ask Infinite"));
    await sendKeys(input, "pause it\r");
    await waitFor(() => output.text().includes("Pause ad 01?"), 4_000, output.text);
    const before = output.text().length;
    await sendKeys(input, key);
    return { input, output, session, before };
  }

  it.skipIf(process.env.CI === "true")(
    "a done receipt view is drawn on the turn as the green card, not as a receipt line",
    { timeout: 30_000 },
    async () => {
      const { input, output, session, before } = await answer("p", { ok: true, view: RECEIPT_VIEW });
      await waitFor(() => output.text().slice(before).includes("Agent proposed · You approved"), 4_000, output.text);
      expect(output.text().slice(before)).toContain("Stopped spending at 10:42");
      expect(output.text()).not.toContain("✓ Stopped spending at 10:42");
      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a dismissal the app took reads ✕ Dismissed — nothing was executed., then Sent to the app",
    { timeout: 30_000 },
    async () => {
      const dismissed = { ...RECEIPT_VIEW, title: "Pause ad", state: "cancelled", outcome: undefined,
        receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } };
      const { input, output, session, before } = await answer("n", { ok: true, view: dismissed });
      await waitFor(() => output.text().slice(before).includes("Sent to the app"), 4_000, output.text);
      expect(output.text().slice(before)).toContain("✕ Dismissed — nothing was executed.");
      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  // Live re-check run 3, M5: the line over the card was the app's pre-OK
  // words ("Ready. It stops spending once you say OK.") and stayed after `n`.
  // The app's answer to the no carries its words after a no; the line becomes
  // them when the app's dismissed receipt lands.
  for (const columns of [60, 100, 140]) {
    it.skipIf(process.env.CI === "true")(
      `n, then the app's no: the line over the card reads Okay, left it running. (${columns} columns)`,
      { timeout: 30_000 },
      async () => {
        const ASKED = "Ready. It stops spending once you say OK.";
        const dismissed = { ...RECEIPT_VIEW, title: "Pause ad", state: "cancelled", outcome: undefined,
          receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } };
        const input = ttyInput();
        const output = ttyOutput();
        output.columns = columns;
        output.rows = 40;
        const session = runInkInteractiveSession({
          columns,
          errorOutput: ttyOutput(),
          input,
          output,
          title: "Infinite TUI",
          onConfirmAction: async () => ({ ok: true, declined: true, askedCaption: ASKED, dismissedCaption: "Okay, left it running.", view: dismissed }),
          async onSubmitLine(): Promise<InkInteractiveLineResult> {
            return { messages: [{ role: "assistant", text: ASKED }], pendingConfirmations: [CARD] };
          }
        });
        await waitFor(() => output.text().includes("Ask Infinite"));
        await sendKeys(input, "pause it\r");
        // From 120 columns the answer is the left pane (40 columns): the line wraps after "spending".
        await waitFor(() => stripAnsi(output.text()).includes("Ready. It stops spending"), 4_000, output.text);
        const before = output.text().length;
        await sendKeys(input, "n");
        await waitFor(() => stripAnsi(output.text().slice(before)).includes("Okay, left it running."), 4_000, () => stripAnsi(output.text().slice(before)));
        const after = stripAnsi(output.text().slice(before));
        expect(after).toContain("Dismissed — nothing was executed.");
        // Nothing redraws the pre-OK line once the app's words are on screen.
        expect(after.slice(after.indexOf("Okay, left it running."))).not.toContain("Ready. It stops spending");
        await sendKeys(input, "/exit\r");
        await session;
        resetTurnState();
      }
    );
  }

  // Lane review (M5): with the captions on the card, the line changes in the
  // frame `n` is pressed in, beside the dismissed card, before the app answers.
  for (const columns of [60, 100, 140]) {
    it.skipIf(process.env.CI === "true")(
      `n on a card with the app's captions: Okay, left it running. in the key's frame (${columns} columns)`,
      { timeout: 30_000 },
      async () => {
        const ASKED = "Ready. It stops spending once you say OK.";
        const dismissed = { ...RECEIPT_VIEW, title: "Pause ad", state: "cancelled", outcome: undefined,
          receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } };
        const confirm = deferred<unknown>();
        const input = ttyInput();
        const output = ttyOutput();
        output.columns = columns;
        output.rows = 40;
        const session = runInkInteractiveSession({
          columns, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
          onConfirmAction: () => confirm.promise,
          async onSubmitLine(): Promise<InkInteractiveLineResult> {
            return {
              messages: [{ role: "assistant", text: ASKED }],
              pendingConfirmations: [{ ...CARD, captions: { asked: ASKED, dismissed: "Okay, left it running." } }]
            };
          }
        });
        const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
        await waitFor(() => output.text().includes("Ask Infinite"));
        await sendKeys(input, "pause it\r");
        await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
        await sendKeys(input, "n");
        // The app has not answered: the new line and the dismissed card are in one frame.
        await waitFor(() => lastFrame().includes("Sending to the app…"), 4_000, lastFrame);
        expect(lastFrame()).toContain("Okay, left it running.");
        expect(lastFrame()).not.toContain("Ready. It stops spending");
        confirm.resolve({ ok: true, declined: true, askedCaption: ASKED, dismissedCaption: "Okay, left it running.", view: dismissed });
        await waitFor(() => lastFrame().includes("Sent to the app"), 4_000, lastFrame);
        expect(lastFrame()).toContain("Okay, left it running.");
        expect(lastFrame()).not.toContain("Ready. It stops spending");
        await sendKeys(input, "/exit\r");
        await session;
        resetTurnState();
      }
    );
  }

  it.skipIf(process.env.CI === "true")(
    "a no that did not land puts the app's line over the card back",
    { timeout: 30_000 },
    async () => {
      const ASKED = "Ready. It stops spending once you say OK.";
      const confirm = deferred<unknown>();
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
        onConfirmAction: () => confirm.promise,
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return {
            messages: [{ role: "assistant", text: ASKED }],
            pendingConfirmations: [{ ...CARD, captions: { asked: ASKED, dismissed: "Okay, left it running." } }]
          };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "n");
      await waitFor(() => lastFrame().includes("Okay, left it running."), 4_000, lastFrame);
      confirm.reject(Object.assign(new Error("Desktop is not reachable."), { code: "desktop_unreachable" }));
      await waitFor(() => lastFrame().includes("Ready. It stops spending"), 4_000, lastFrame);
      expect(lastFrame()).not.toContain("Okay, left it running.");
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  // Live re-check run 3, N22: `Sent to the app` was drawn at `n` and never
  // changed. In flight it says `Sending to the app…`; the app's answer makes it
  // `Sent to the app`, with a receipt of its own or without one.
  for (const [what, answer] of [
    ["the app's dismissed receipt", "receipt"],
    ["a plain ok", "plain"]
  ] as const) {
    it.skipIf(process.env.CI === "true")(
      `n: Sending to the app… until the app answers, then Sent to the app (${what})`,
      { timeout: 30_000 },
      async () => {
        const dismissed = { ...RECEIPT_VIEW, title: "Pause ad", state: "cancelled", outcome: undefined,
          receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } };
        const confirm = deferred<unknown>();
        const input = ttyInput();
        const output = ttyOutput();
        const session = runInkInteractiveSession({
          columns: 80, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
          onConfirmAction: () => confirm.promise,
          async onSubmitLine(): Promise<InkInteractiveLineResult> {
            return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
          }
        });
        const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
        await waitFor(() => output.text().includes("Ask Infinite"));
        await sendKeys(input, "pause it\r");
        await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
        await sendKeys(input, "n");
        await waitFor(() => lastFrame().includes("Sending to the app…"), 4_000, lastFrame);
        expect(lastFrame()).not.toContain("Sent to the app");
        // Live run-4 N22: until the app answers, the receipt's sentence is not claimed.
        expect(lastFrame()).not.toContain("Dismissed — nothing was executed.");
        confirm.resolve(answer === "receipt" ? { ok: true, declined: true, view: dismissed } : { ok: true });
        await waitFor(() => lastFrame().includes("Sent to the app"), 4_000, lastFrame);
        expect(lastFrame()).not.toContain("Sending");
        expect(lastFrame()).toContain("Dismissed — nothing was executed.");
        await sendKeys(input, "/exit\r");
        await session;
        resetTurnState();
      }
    );
  }

  // Live re-check run 3, N20: after `n` the bar kept `? what it does` (the
  // list view's, above the card) where r4's dismissed frame offers only
  // `tab switch side  / commands`: the keys stay on the newest view, the
  // dismissed card, which has none.
  it.skipIf(process.env.CI === "true")(
    "after n the key bar is r4's dismissed bar: no ? what it does, while in flight and after the app's answer",
    { timeout: 30_000 },
    async () => {
      const list = {
        type: "tool.view", stage: "tool", message: "Ads", viewId: "list_1", name: "list_items",
        view: {
          v: 1, kind: "list", tool: "list_items", title: "Ads", state: "ready", asOf: null,
          explain: "Our stored copy of the account.",
          scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
          body: { layout: "rows", columns: [], rows: [{ id: "ad_1", title: "Ad 01", status: { word: "on", tone: "ok" }, cells: {} }] }
        }
      };
      const dismissed = { ...RECEIPT_VIEW, title: "Pause ad", state: "cancelled", outcome: undefined,
        receipt: { sentence: "Dismissed — nothing was executed.", tone: "ok", revertible: false } };
      const confirm = deferred<unknown>();
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: () => confirm.promise,
        async onSubmitLine(_line, _progress, _signal, onView): Promise<InkInteractiveLineResult> {
          onView?.(list as never);
          return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      expect(lastFrame()).toContain("what it does");
      await sendKeys(input, "n");
      await waitFor(() => lastFrame().includes("Sending to the app…"), 4_000, lastFrame);
      expect(lastFrame()).not.toContain("what it does");
      expect(lastFrame()).toMatch(/tab\s+switch side\s+\/\s+commands/u);
      confirm.resolve({ ok: true, declined: true, view: dismissed });
      await waitFor(() => lastFrame().includes("Dismissed — nothing was executed."), 4_000, lastFrame);
      expect(lastFrame()).not.toContain("what it does");
      expect(lastFrame()).not.toContain("what it does");
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  // A receipt belongs to the turn its card came from: a line queued while that
  // turn was busy waits for the confirm, and a line typed while the confirm is
  // in flight starts a new turn that the receipt never lands on.
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }

  it.skipIf(process.env.CI === "true")(
    "a line queued during the busy turn waits for the confirm, so the receipt lands on the card's turn",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const firstTurn = deferred<InkInteractiveLineResult>();
      const confirm = deferred<unknown>();
      const asked: { line: string; at: number }[] = [];
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: () => confirm.promise,
        async onSubmitLine(line): Promise<InkInteractiveLineResult> {
          asked.push({ line, at: output.text().length });
          if (asked.length === 1) return firstTurn.promise;
          return { messages: [{ role: "assistant", text: "Second answer." }] };
        }
      });
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => asked.length === 1);
      // Typed while the first turn is busy: queued.
      await sendKeys(input, "and the budget?\r");
      firstTurn.resolve({ messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] });
      await waitFor(() => output.text().includes("Pause ad 01?"), 4_000, output.text);
      await sendKeys(input, "p");
      // The card has left the queue but its confirm is still out: the queued line waits.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(asked.map((entry) => entry.line)).toEqual(["pause it"]);
      confirm.resolve({ ok: true, view: RECEIPT_VIEW });
      await waitFor(() => asked.length === 2, 4_000, output.text);
      await waitFor(() => output.text().includes("Second answer."), 4_000, output.text);
      // The green receipt card was drawn before the second question was asked, on turn A.
      const second = asked[1]!;
      expect(second.line).toBe("and the budget?");
      expect(output.text().slice(0, second.at)).toContain("Agent proposed · You approved");
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a line typed while the confirm is in flight starts a new turn; the receipt prints as lines, never as a card on it",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const confirm = deferred<unknown>();
      let calls = 0;
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: () => confirm.promise,
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          calls += 1;
          if (calls === 1) return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
          return { messages: [{ role: "assistant", text: "Second answer." }] };
        }
      });
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => output.text().includes("Pause ad 01?"), 4_000, output.text);
      await sendKeys(input, "p");
      await sendKeys(input, "and the budget?\r");
      await waitFor(() => output.text().includes("Second answer."), 4_000, output.text);
      const before = output.text().length;
      confirm.resolve({ ok: true, view: RECEIPT_VIEW });
      await waitFor(() => output.text().slice(before).includes("Stopped spending at 10:42"), 4_000, output.text);
      expect(output.text()).not.toContain("Agent proposed · You approved");
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );
});

function ttyInput() {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (enabled: boolean) => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.ref = vi.fn();
  stream.setRawMode = vi.fn();
  stream.unref = vi.fn();
  return stream;
}

function ttyOutput() {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = 80;
  stream.rows = 24;
  stream.isTTY = true;
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  stream.text = () => chunks.join("");
  return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000, debug?: () => string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), debug?.()).toBe(true);
}

async function sendKeys(input: NodeJS.WritableStream, keys: string) {
  for (const key of keys) {
    input.write(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
