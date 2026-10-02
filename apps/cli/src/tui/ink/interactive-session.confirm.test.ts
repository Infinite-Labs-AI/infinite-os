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

const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");

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
    expect(source).toContain("keyBarRowCount(keyHints, columns) + inkTranscriptRowCount({");
    expect(source.indexOf("<KeyBar hints={keyHints}")).toBeLessThan(source.indexOf("<InkLineInput"));
    expect(source.indexOf("<KeyBar hints={keyHints}")).toBeGreaterThan(source.indexOf("<ConfirmActionMenu"));
    // The old fixed affordance is gone: the bar shows only what works now.
    expect(source).not.toContain("[y] approve");
  });

  it("closes the explanation whenever the head card changes, whoever changed the queue", () => {
    // Keyed to the head card itself, so a new card never opens with an earlier
    // card's explanation expanded (r4: the explanation stays behind ?).
    expect(source).toMatch(
      /useEffect\(\(\) => \{\n\s+setExplainOpen\(false\);\n\s+\}, \[headConfirmAction\]\);/u
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
    expect(handler).toContain("onConfirmAction?.(head, decision)");
    expect(handler).not.toContain('if (decision === "decline")');
  });

  it("prints receipt lines, never the JSON result", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    expect(handler).toContain("confirmResultLines(result, decision)");
    expect(handler).toContain("confirmErrorLines(error)");
    expect(handler).not.toContain("JSON.stringify");
  });

  it("scrubs the un-redacted summary through terminalText before rendering", () => {
    // The overlay render runs the summary through terminalText (the details are
    // redacted upstream → rendered verbatim); receipts are scrubbed by
    // confirmResultLines.
    expect(source).toContain("terminalText(pending.summary");
    expect(source).toContain("detail.label}: ${detail.value}");
  });

  it("blocks the queued-line drain while a confirmation is pending", () => {
    const drain = source.slice(
      source.indexOf("useEffect(() => {\n    // Don't drain"),
      source.indexOf("const submitLine = useCallback")
    );
    expect(drain).toContain("pendingConfirmActions.length > 0");
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
      // The overlay renders the summary + redacted details + affordance.
      await waitFor(() => output.text().includes("Approve this write?"), 4_000, output.text);
      expect(output.text()).toContain("Publish landing page to production");
      expect(output.text()).toContain("acme.example.com");
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
      await waitFor(() => output.text().includes("Approve this write?"), 4_000, output.text);

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
      await waitFor(() => output.text().includes("Approve this write?"), 4_000, output.text);

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
