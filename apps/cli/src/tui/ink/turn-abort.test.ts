import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTurnAbort, ctrlCAction, TURN_STOPPED, turnStoppedLine } from "./turn-abort.js";

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

describe("turn abort wiring (structural, CI-run)", () => {
  const session = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
  const index = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf8");

  it("ctrl-c keeps the wizard guard first, then stops a running turn before it would exit", () => {
    const block = session.slice(session.indexOf('if (key.ctrl && input === "c")'));
    const cancel = block.indexOf("onConnectCancel()");
    const stop = block.indexOf("ctrlCAction(turnAbort)");
    const exit = block.indexOf("app.exit()");
    expect(cancel).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(cancel);
    expect(exit).toBeGreaterThan(stop);
  });

  it("esc while busy stops the turn and nothing else", () => {
    expect(session).toMatch(/if \(busy && key\.escape && turnStoppable\) \{\s*turnAbort\.stop\("esc"\);\s*return;\s*\}/);
  });

  it("each turn gets its own signal, and a stopped turn prints the stop line", () => {
    expect(session).toContain("const signal = turnAbort.start();");
    expect(session).toContain("}, signal);");
    expect(session).toContain("turnStoppedLine(signal.aborted ? signal.reason : error)");
    expect(session).toContain("turnAbort.end(signal);");
    expect(session).toContain('"esc to stop"');
  });

  it("the desktop session opts in and passes the turn's signal to the runner", () => {
    expect(index).toContain("turnStoppable: true,");
    expect(index).toContain("AbortSignal.any([turnAbort.signal, signal])");
  });
});
