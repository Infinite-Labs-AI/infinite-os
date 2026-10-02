import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTurnAbort, ctrlCAction, linkAbortSignals, TURN_STOPPED, turnStoppedLine } from "./turn-abort.js";

describe("turn abort", () => {
  it("stop() aborts only the running turn and reports whether one was running", () => {
    const t = createTurnAbort();
    expect(t.stop("esc")).toBe(false);
    const s = t.start(); expect(t.stop("esc")).toBe(true);
    expect(s.aborted).toBe(true); expect((s.reason as Error).message).toBe(TURN_STOPPED);
    expect(t.start().aborted).toBe(false);
  });

  it("a TURN_STOPPED rejection prints the stop line; other errors do not", () => {
    expect(turnStoppedLine(new Error(TURN_STOPPED))).toBe("■ Stopped. Anything already running in the app may still finish.");
    expect(turnStoppedLine(new Error("boom"))).toBeNull();
  });

  it("ctrl-c stops a running turn, and exits when none is running", () => {
    const t = createTurnAbort(); expect(ctrlCAction(t)).toBe("exit");
    t.start(); expect(ctrlCAction(t)).toBe("stopped"); expect(t.active()).toBe(false);
  });

  it("a finished turn is no longer active, so ctrl-c exits again", () => {
    const t = createTurnAbort();
    const s = t.start();
    t.end(s);
    expect(t.active()).toBe(false);
    expect(s.aborted).toBe(false);
    expect(ctrlCAction(t)).toBe("exit");
  });

  it("ending an older turn never clears a newer one", () => {
    const t = createTurnAbort();
    const first = t.start();
    t.start();
    t.end(first);
    expect(t.active()).toBe(true);
  });

  it("starting a new turn aborts nothing", () => {
    const t = createTurnAbort();
    const first = t.start();
    t.start();
    expect(first.aborted).toBe(false);
  });
});

describe("linkAbortSignals (Node 20.0-20.2 lack AbortSignal.any)", () => {
  it("never calls AbortSignal.any", () => {
    const original = (AbortSignal as { any?: unknown }).any;
    (AbortSignal as { any?: unknown }).any = undefined;
    try {
      const a = new AbortController();
      const linked = linkAbortSignals([a.signal, new AbortController().signal]);
      a.abort(new Error(TURN_STOPPED));
      expect(linked.signal.aborted).toBe(true);
      expect((linked.signal.reason as Error).message).toBe(TURN_STOPPED);
      linked.dispose();
    } finally {
      (AbortSignal as { any?: unknown }).any = original;
    }
  });

  it("aborts when either input aborts, with that input's reason", () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkAbortSignals([a.signal, b.signal]);
    expect(linked.signal.aborted).toBe(false);
    b.abort(new Error("second"));
    expect(linked.signal.aborted).toBe(true);
    expect((linked.signal.reason as Error).message).toBe("second");
    a.abort(new Error("first"));
    expect((linked.signal.reason as Error).message).toBe("second");
  });

  it("is already aborted when an input already is", () => {
    const a = new AbortController();
    a.abort(new Error("early"));
    const linked = linkAbortSignals([new AbortController().signal, a.signal]);
    expect(linked.signal.aborted).toBe(true);
    expect((linked.signal.reason as Error).message).toBe("early");
  });

  it("dispose() detaches from the inputs, so a long-lived session signal does not collect listeners", () => {
    const session = new AbortController();
    const linked = linkAbortSignals([session.signal, new AbortController().signal]);
    linked.dispose();
    session.abort(new Error("later"));
    expect(linked.signal.aborted).toBe(false);
  });
});

describe("turn abort wiring (structural, CI-run)", () => {
  const session = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
  const index = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf8");

  it("ctrl-c keeps the wizard guard first, then stops a running turn before it would exit", () => {
    const block = session.slice(session.indexOf('if (key.ctrl && input === "c")'));
    const cancel = block.indexOf("onConnectCancel()");
    const stop = block.indexOf("ctrlCAction(turnAbort)");
    // Idle Ctrl-C exits through `onExit()` (requestExit commits the live turn to scrollback first).
    const exit = block.indexOf("onExit()");
    expect(cancel).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(cancel);
    expect(exit).toBeGreaterThan(stop);
  });

  it("esc while busy stops the turn and nothing else", () => {
    expect(session).toMatch(/if \(busy && key\.escape && turnStoppable\) \{\s*turnAbort\.stop\("esc"\);\s*return;\s*\}/);
  });

  it("each turn gets its own signal, and a stopped turn prints the stop line", () => {
    expect(session).toContain("const signal = turnAbort.start();");
    // The turn's own signal must be onSubmitLine's third argument, not just any `, signal)`.
    const callStart = session.indexOf("const result = await onSubmitLine(line,");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = session.indexOf("if (result.exit)", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    expect(session.slice(callStart, callEnd).trimEnd()).toMatch(/\}, signal\);$/);
    expect(session).toContain("turnStoppedLine(signal.aborted ? signal.reason : error)");
    expect(session).toContain("turnAbort.end(signal);");
    expect(session).toContain('"esc to stop"');
  });

  it("a stopped turn keeps its partial answer and tool trail: committed before the stop line and before reset", () => {
    const catchBlock = session.slice(session.indexOf("const stoppedLine = turnStoppedLine("));
    const keep = catchBlock.indexOf("turnController.stoppedTranscript()");
    const stopLine = catchBlock.indexOf("text: stoppedLine ??");
    const reset = catchBlock.indexOf("turnController.reset();");
    expect(keep).toBeGreaterThan(-1);
    expect(stopLine).toBeGreaterThan(keep);
    expect(reset).toBeGreaterThan(stopLine);
  });

  it("the desktop session opts in and passes the turn's signal to the runner", () => {
    expect(index).toContain("turnStoppable: true,");
    expect(index).toContain("linkAbortSignals([turnAbort.signal, signal])");
    expect(index).toContain("linked.dispose()");
    expect(index).not.toContain("AbortSignal.any(");
  });
});
