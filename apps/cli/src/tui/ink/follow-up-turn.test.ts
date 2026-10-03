// P33-M2 (T12): from a streamed yes's receipt until its terminal frame, the
// follow-up IS the running turn. These pin the session's rules for it as pure
// steps (CI-run): typed lines wait, the bar says `esc stop` first, Esc and
// Ctrl-C stop the follow-up's own signal and nothing else, and a follow-up
// view that lands after a new line still prints, labelled, never dropped.
// Synthetic data only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { INFINITE_R4_THEME } from "../theme.js";
import {
  createFollowUpAbort,
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
