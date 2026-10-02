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

  it("names the OK key from the approval view, renders the key bar above the composer, and counts its rows", () => {
    expect(source).toContain("confirmCardKeys(headConfirmAction, NO_KEY_CAPS)");
    // The bar's real rows feed the live-region cap's key-bar slot and the composer-row prediction.
    expect(source).toContain("const keyBarRows = keyBarRowCount(keyHints, columns);");
    expect(source.match(/^\s+keyBarRows,$/gm)?.length).toBe(1);
    expect(source).toContain("keyBarRows={keyBarRows}");
    expect(source).toContain("const composerRow = homeInventoryRows + keyBarRows + liveLayout.rowCount;");
    expect(source.indexOf("<KeyBar hints={keyHints}")).toBeLessThan(source.indexOf("<InkLineInput"));
    expect(source.indexOf("<KeyBar hints={keyHints}")).toBeGreaterThan(source.indexOf("<ConfirmActionMenu"));
    // The old fixed affordance is gone: the bar shows only what works now.
    expect(source).not.toContain("[y] approve");
  });

  it("closes the explanation whenever the head card changes, whoever changed the queue", () => {
    // Keyed to the head card itself, so a new card never opens with an earlier
    // card's explanation expanded (r4: the explanation stays behind ?), nor with
    // its open document, page or field answers. (A card brought back opens with
    // only the answers its own entry carries: cardUiStart(entry).)
    expect(source).toMatch(
      /useEffect\(\(\) => \{\n\s+setExplainOpen\(false\);\n\s+setCardUi\(cardUiStart\(headConfirmAction\)\);\n\s+\}, \[headConfirmAction\]\);/u
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
    expect(handler).toContain("onConfirmAction?.(head, decision, fields)");
    expect(handler).not.toContain('if (decision === "decline")');
  });

  it("prints receipt lines, never the JSON result; a settled receipt view goes on the turn instead", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    expect(handler).toContain("confirmResultLines(result, decision)");
    expect(handler).toContain("confirmErrorLines(error)");
    expect(handler).toContain("const receipt = receiptViewFrame(head, result);");
    expect(handler).toContain("recordTurnView(receipt);");
    expect(handler).not.toContain("JSON.stringify");
  });

  it("scrubs the un-redacted summary through terminalText before rendering", () => {
    // The card (confirm-card.tsx) runs the summary through terminalText; the
    // details are redacted upstream and scrubbed again as they become rows;
    // receipts are scrubbed by confirmResultLines.
    expect(source).toMatch(/import \{ ConfirmActionMenu, [^}]+ \} from "\.\/confirm-card\.js";/u);
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

  it("shows the `!` write-gate glyph (not the `?` picker glyph) while pending", () => {
    expect(source).toContain("pendingConfirmation || confirmActionActive ? \"!\"");
    expect(source).toContain("|| confirmActionActive;"); // folded into overlayActive
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

      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "publish it\r");
      // The card: the summary in its border, the redacted details as rows, the keys inside.
      await waitFor(() => output.text().includes("Publish landing page to production"), 4_000, output.text);
      expect(output.text()).toContain("acme.example.com");
      expect(output.text()).not.toContain("Approve this write?");
      // Old desktop (no approval view): the bar names y Confirm and n dismiss.
      expect(output.text()).toContain("y Confirm   n dismiss");

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

      await waitFor(() => output.text().includes("ready"));
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

      await waitFor(() => output.text().includes("ready"));
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

      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => output.text().includes("p Pause   n dismiss   ? what it does"), 4_000, output.text);
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
    await waitFor(() => output.text().includes("ready"));
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

  // A receipt belongs to the turn its card came from: a line queued while that
  // turn was busy waits for the confirm, and a line typed while the confirm is
  // in flight starts a new turn that the receipt never lands on.
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
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
      await waitFor(() => output.text().includes("ready"));
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
      await waitFor(() => output.text().includes("ready"));
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
