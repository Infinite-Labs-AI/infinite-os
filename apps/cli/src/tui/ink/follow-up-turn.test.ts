// P33-M2 (T12): from a streamed yes's receipt until its terminal frame, the
// follow-up IS the running turn. These pin the session's rules for it as pure
// steps (CI-run): typed lines wait, the bar says `esc stop` first, Esc and
// Ctrl-C stop the follow-up's own signal and nothing else, and a follow-up
// view that lands after a new line still prints, labelled, never dropped.
// Synthetic data only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { InSessionConfirmationAction, InSessionConfirmationClient } from "../../desktop/confirm-in-session.js";
import { INFINITE_R4_THEME } from "../theme.js";
import {
  type ConfirmStreamHooks,
  confirmThroughRunner,
  createFollowUpAbort,
  createFollowUpStream,
  followUpNote,
  lineWaits,
  offTurnViewLines,
  runningBarHints,
  runningTurnAbort
} from "./follow-up-turn.js";
import { TURN_STOPPED, createTurnAbort, ctrlCAction } from "./turn-abort.js";

describe("a typed line while a turn or a streamed follow-up runs", () => {
  it("waits in the queue while the follow-up runs, as it does while a turn runs", () => {
    expect(lineWaits({ busy: false, followUpRunning: true })).toBe(true);
    expect(lineWaits({ busy: true, followUpRunning: false })).toBe(true);
    expect(lineWaits({ busy: false, followUpRunning: false })).toBe(false);
  });
});

describe("the follow-up's own stop (Esc / Ctrl-C)", () => {
  it("Esc aborts the confirm's own signal and nothing else", () => {
    const turn = createTurnAbort();
    const followUp = createFollowUpAbort();
    const confirm = new AbortController();
    const other = new AbortController();
    followUp.arm(confirm);
    const stop = runningTurnAbort(turn, followUp);
    expect(stop.active()).toBe(true);
    expect(stop.stop("esc")).toBe(true);
    expect(confirm.signal.aborted).toBe(true);
    expect((confirm.signal.reason as Error).message).toBe(TURN_STOPPED);
    expect(other.signal.aborted).toBe(false);
    expect(followUp.end(confirm)).toBe(true);
    expect(stop.active()).toBe(false);
  });

  it("is not armed before the receipt: Esc then stops nothing (the write's outcome is the app's)", () => {
    const followUp = createFollowUpAbort();
    const stop = runningTurnAbort(createTurnAbort(), followUp);
    expect(stop.stop("esc")).toBe(false);
    expect(ctrlCAction(stop)).toBe("exit");
  });

  it("a running turn is stopped first; the follow-up keeps running until the next stop", () => {
    const turn = createTurnAbort();
    const followUp = createFollowUpAbort();
    const confirm = new AbortController();
    followUp.arm(confirm);
    const turnSignal = turn.start();
    const stop = runningTurnAbort(turn, followUp);
    expect(stop.stop("esc")).toBe(true);
    expect(turnSignal.aborted).toBe(true);
    expect(confirm.signal.aborted).toBe(false);
    expect(ctrlCAction(stop)).toBe("stopped");
    expect(confirm.signal.aborted).toBe(true);
  });

  it("a follow-up that ended on its own was not stopped, and a later Esc does nothing to it", () => {
    const followUp = createFollowUpAbort();
    const confirm = new AbortController();
    followUp.arm(confirm);
    expect(followUp.end(confirm)).toBe(false);
    expect(followUp.stop("esc")).toBe(false);
    expect(confirm.signal.aborted).toBe(false);
  });
});

describe("the key bar and the composer while the follow-up runs", () => {
  it("`esc stop` is the first hint, once (D6)", () => {
    expect(runningBarHints([{ key: "t", label: "turn back on" }, { key: "esc", label: "stop" }], true)).toEqual([
      { key: "esc", label: "stop" },
      { key: "t", label: "turn back on" }
    ]);
    expect(runningBarHints([], true)).toEqual([{ key: "esc", label: "stop" }]);
  });

  it("not running (or not stoppable), the bar is unchanged", () => {
    const hints = [{ key: "t", label: "turn back on" }];
    expect(runningBarHints(hints, false)).toBe(hints);
  });

  it("the composer's note says it is following up, with its time", () => {
    expect(followUpNote(1_000, 4_500)).toBe("following up 3s");
    expect(followUpNote(1_000, 500)).toBe("following up 0s");
  });
});

describe("a follow-up view that lands after a new line went up", () => {
  const view = decodeAnswerView({
    v: 1, kind: "change", tool: "pause_entity", title: "Pause the ad set", state: "done", asOf: null,
    scope: { workspaceName: "Example Co", crossWorkspace: false }, caveats: [],
    receipt: { sentence: "Paused ad set “Broad”", tone: "ok", revertible: true },
    body: { target: { kind: "adset", label: "Broad" }, rows: [{ label: "status", before: "on", after: "PAUSED" }], warnings: [] }
  }) as AnswerViewV1;

  it("prints as lines labelled with whose follow-up it is, never dropped", () => {
    const lines = offTurnViewLines(view, "Pause ad 01", 100, INFINITE_R4_THEME);
    expect(lines[0]).toBe("↳ The follow-up to “Pause ad 01”:");
    expect(lines.join("\n")).toContain("Paused ad set “Broad”");
    expect(lines.slice(1).every((line) => line === "" || line.startsWith("  "))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/\u001b/u);
  });
});

// R-S1: the hooks the session hands a streamed confirm. The follow-up's stop is
// armed only by the receipt: before it, Esc and Ctrl-C never touch the yes's
// request (a write that may already have gone would turn into an unknown).
describe("the streamed confirm's hooks (createFollowUpStream)", () => {
  function parts() {
    const calls = { receipts: [] as unknown[], armed: 0, views: 0, steps: 0, drafts: 0 };
    return {
      calls,
      parts: {
        onReceipt: (result: unknown) => void calls.receipts.push(result),
        onArmed: () => void (calls.armed += 1),
        onView: () => void (calls.views += 1),
        onStep: () => void (calls.steps += 1),
        onCreativeDraft: () => void (calls.drafts += 1)
      }
    };
  }

  it("before the receipt, Esc and Ctrl-C never abort the confirm's signal", () => {
    const followUp = createFollowUpAbort();
    const turn = createTurnAbort();
    const stop = runningTurnAbort(turn, followUp);
    const { parts: p } = parts();
    const stream = createFollowUpStream(followUp, p);
    expect(stream.hooks.signal).toBe(stream.controller.signal);
    expect(stream.armed()).toBe(false);
    // Nothing running: Esc stops nothing, Ctrl-C would quit, the yes's request stays live.
    expect(stop.stop("esc")).toBe(false);
    expect(ctrlCAction(stop)).toBe("exit");
    expect(stream.hooks.signal.aborted).toBe(false);
    // Another turn running: Esc and Ctrl-C stop that turn only.
    const other = turn.start();
    expect(ctrlCAction(stop)).toBe("stopped");
    expect(other.aborted).toBe(true);
    turn.end(other);
    const next = turn.start();
    expect(stop.stop("esc")).toBe(true);
    expect(next.aborted).toBe(true);
    turn.end(next);
    expect(stream.hooks.signal.aborted).toBe(false);
  });

  it("the receipt arms the stop once; then Esc aborts the confirm's own signal", () => {
    const followUp = createFollowUpAbort();
    const stop = runningTurnAbort(createTurnAbort(), followUp);
    const { calls, parts: p } = parts();
    const stream = createFollowUpStream(followUp, p);
    stream.hooks.onReceipt({ ok: true });
    stream.hooks.onReceipt({ ok: true, again: true });
    expect(calls.receipts).toEqual([{ ok: true }, { ok: true, again: true }]);
    expect(calls.armed).toBe(1);
    expect(stream.armed()).toBe(true);
    expect(stop.active()).toBe(true);
    expect(stop.stop("esc")).toBe(true);
    expect(stream.hooks.signal.aborted).toBe(true);
    expect(followUp.end(stream.controller)).toBe(true);
  });

  it("views, Steps and drafts pass straight to the session's handlers", () => {
    const { calls, parts: p } = parts();
    const stream = createFollowUpStream(createFollowUpAbort(), p);
    stream.hooks.onView({} as never);
    stream.hooks.onStep({} as never);
    stream.hooks.onCreativeDraft({} as never);
    expect(calls).toMatchObject({ views: 1, steps: 1, drafts: 1, armed: 0 });
  });
});

// R-S4: the confirm call the CLI makes for a card (index.ts), driven with a fake runner.
describe("a card's confirm through the runner (confirmThroughRunner)", () => {
  type ConfirmInput = Parameters<InSessionConfirmationClient["confirm"]>[0];
  const progress = (data: unknown) => ({ protocolVersion: 1 as const, requestId: "r", sequence: 2, kind: "progress" as const, data });
  const VIEW = {
    v: 1, kind: "change", tool: "pause_entity", title: "Pause", state: "ready", asOf: null,
    scope: { workspaceName: "Example Co", crossWorkspace: false }, caveats: [],
    body: { target: { kind: "ad", label: "Demo B" }, rows: [], warnings: [] }
  };
  const CARD = { turnId: "t1", confirmationHandle: "h1", summary: "Pause ad 01", confirmationDetails: [], view: VIEW } as unknown as InSessionConfirmationAction;

  function fakeRunner(streamCapable = true) {
    const inputs: ConfirmInput[] = [];
    let finish!: (value: unknown) => void;
    const runner = {
      streamCapable: () => streamCapable,
      confirm: (input: ConfirmInput) => {
        inputs.push(input);
        return new Promise<unknown>((done) => {
          finish = done;
        });
      }
    };
    return { runner, inputs, finish: (value: unknown) => finish(value) };
  }

  function recordingHooks(controller = new AbortController()) {
    const got = { receipts: [] as unknown[], views: [] as unknown[], steps: [] as unknown[], drafts: [] as unknown[] };
    const hooks: ConfirmStreamHooks = {
      signal: controller.signal,
      onReceipt: (result) => void got.receipts.push(result),
      onView: (frame) => void got.views.push(frame),
      onStep: (event) => void got.steps.push(event),
      onCreativeDraft: (frame) => void got.drafts.push(frame)
    };
    return { controller, hooks, got };
  }

  it("streams a card with a view: each progress frame goes where a normal turn's goes", async () => {
    const fake = fakeRunner();
    const { hooks, got } = recordingHooks();
    const call = confirmThroughRunner(fake.runner, { action: CARD, decision: "approve", stream: hooks, turnSignal: new AbortController().signal });
    const input = fake.inputs[0]!;
    expect(input).toMatchObject({ turnId: "t1", confirmationHandle: "h1", decision: "approve", stream: true });
    input.onReceipt!({ ok: true } as never);
    input.onProgress!(progress({ type: "tool.start", stage: "tool", message: "", toolId: "c1", name: "list_ads", context: "" }) as never);
    input.onProgress!(progress({ type: "creative.draft", runId: "run_1", status: "running", count: 3, format: "png", aspectRatio: "4:5", quality: "high" }) as never);
    input.onProgress!(progress({ type: "tool.view", stage: "tool", message: "", viewId: "v1", name: "read_ads", view: VIEW }) as never);
    input.onProgress!(progress({ type: "message.delta", stage: "message", message: "x", text: "x" }) as never);
    expect(got.receipts).toEqual([{ ok: true }]);
    expect(got.steps).toEqual([expect.objectContaining({ type: "tool.start", toolId: "c1" })]);
    expect(got.drafts).toEqual([expect.objectContaining({ type: "creative.draft", runId: "run_1" })]);
    expect(got.views).toEqual([expect.objectContaining({ viewId: "v1" })]);
    fake.finish({ ok: true });
    await expect(call).resolves.toEqual({ ok: true });
  });

  it("the confirm's signal is the follow-up's own, linked to the session's, and let go when the call ends", async () => {
    const fake = fakeRunner();
    const own = recordingHooks();
    void confirmThroughRunner(fake.runner, { action: CARD, decision: "approve", stream: own.hooks, turnSignal: new AbortController().signal });
    own.controller.abort(new Error("stopped"));
    expect(fake.inputs[0]!.signal!.aborted).toBe(true);

    const session = new AbortController();
    void confirmThroughRunner(fake.runner, { action: CARD, decision: "approve", stream: recordingHooks().hooks, turnSignal: session.signal });
    session.abort(new Error("quit"));
    expect(fake.inputs[1]!.signal!.aborted).toBe(true);

    const late = recordingHooks();
    const call = confirmThroughRunner(fake.runner, { action: CARD, decision: "approve", stream: late.hooks, turnSignal: new AbortController().signal });
    fake.finish({ ok: true });
    await call;
    late.controller.abort(new Error("after"));
    expect(fake.inputs[2]!.signal!.aborted).toBe(false);
  });

  it("a card without a view, or an app that cannot stream, confirms plainly on the session's signal", () => {
    const session = new AbortController();
    const plainCard = { ...CARD, view: undefined } as InSessionConfirmationAction;
    const fake = fakeRunner();
    const noView = recordingHooks();
    void confirmThroughRunner(fake.runner, { action: plainCard, decision: "decline", stream: noView.hooks, turnSignal: session.signal });
    const old = fakeRunner(false);
    void confirmThroughRunner(old.runner, { action: CARD, decision: "approve", fields: { budget: { kind: "money", value: 5 } as never }, stream: recordingHooks().hooks, turnSignal: session.signal });
    for (const input of [fake.inputs[0]!, old.inputs[0]!]) {
      expect(input.stream).toBeUndefined();
      expect(input.onReceipt).toBeUndefined();
      expect(input.onProgress).toBeUndefined();
      expect(input.signal).toBe(session.signal);
    }
    expect(old.inputs[0]!.fields).toEqual({ budget: { kind: "money", value: 5 } });
    expect(fake.inputs[0]!).not.toHaveProperty("fields");
    noView.controller.abort();
    expect(fake.inputs[0]!.signal!.aborted).toBe(false);
  });
});
