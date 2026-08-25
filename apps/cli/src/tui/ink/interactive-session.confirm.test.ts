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
  it("gates the y/N branch inside the SINGLE useInput owner (only y/Y approves)", () => {
    // The write gate must live in the one useInput owner, before the plain
    // composer, and only an explicit y/Y approves — everything else declines or
    // is swallowed (mirrors the readline handler's semantics).
    const block = source.slice(
      source.indexOf("if (confirmActionActive) {"),
      source.indexOf("if (selectionActive) {")
    );
    expect(block).toContain('input === "y" || input === "Y"');
    expect(block).toContain("onConfirmActionApprove()");
    expect(block).toContain('input === "n" || input === "N" || key.return || key.escape');
    expect(block).toContain("onConfirmActionDecline()");
  });

  it("dequeues the head BEFORE acting so a single-use handle can't double-resolve", () => {
    const handler = source.slice(
      source.indexOf("const resolveConfirmAction"),
      source.indexOf("useEffect(() => {\n    // Don't drain")
    );
    // Dequeue precedes the branch that calls onConfirmAction.
    expect(handler.indexOf("setPendingConfirmActions((current) => current.slice(1))"))
      .toBeLessThan(handler.indexOf("onConfirmAction?.(head"));
    expect(handler).toContain('onConfirmAction?.(head, "approve")');
  });

  it("scrubs the un-redacted summary through terminalText before rendering/echoing", () => {
    // Both the declined transcript line and the overlay render run the summary
    // through terminalText (the details are redacted upstream → rendered verbatim).
    expect(source).toContain("terminalText(head.summary");
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
    "y approves → calls onConfirmAction(approve) and renders the JSON result",
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
          return { ok: true, published: "rev_42" };
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
      expect(output.text()).toContain("[y] approve");

      await sendKeys(input, "y");
      await waitFor(() => confirmed.length === 1, 4_000, output.text);
      // The JSON result lands in the transcript.
      await waitFor(() => output.text().includes('"published": "rev_42"'), 4_000, output.text);

      expect(confirmed).toEqual([{ handle: "h1", decision: "approve" }]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "n declines → calls nothing and appends a declined note",
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
      await waitFor(() => output.text().includes("Confirmation declined"), 4_000, output.text);
      // Decline calls the client NOTHING.
      expect(confirmed).toEqual([]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "bare Enter declines (safe default), like the readline handler",
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
      await waitFor(() => output.text().includes("Confirmation declined"), 4_000, output.text);
      expect(confirmed).toEqual([]);

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
