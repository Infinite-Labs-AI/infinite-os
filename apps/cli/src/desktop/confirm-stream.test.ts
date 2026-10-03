// T12 (P3.3): what the session does with a streamed confirm's parts (the
// receipt, the follow-up, an error) and with `o`'s answer. Pure, CI-run.
// Synthetic data only.
import { describe, expect, it } from "vitest";

import { appOpenLines } from "./app-open.js";
import { confirmErrorLines } from "./confirm-result-lines.js";
import { confirmStreamSteps, followUpOutcome, followUpViewFrame } from "./confirm-stream.js";

function receiptView(overrides: Record<string, unknown> = {}) {
  return {
    v: 1, kind: "change", tool: "pause_entity", title: "Pause", state: "done", asOf: null,
    scope: { workspaceName: "Example Co", crossWorkspace: false }, caveats: [],
    receipt: { sentence: "Paused ad “Hook B”", tone: "ok", revertible: true },
    body: { target: { kind: "ad", label: "Hook B" }, rows: [], warnings: [] },
    ...overrides
  };
}

describe("the follow-up after a streamed yes", () => {
  it("is the agent's answer, in the same turn as the receipt", () => {
    const outcome = followUpOutcome({ ok: true, followUp: { turnId: "turn-2", message: "It stopped spending.", actionCalls: [] } }, { confirmFieldsCapable: true });
    expect(outcome).toEqual({ message: "It stopped spending.", pending: [], errorLines: [] });
  });

  it("brings any new card the follow-up proposed, scoped to its own turn", () => {
    const outcome = followUpOutcome({
      ok: true,
      followUp: {
        turnId: "turn-2",
        message: "Want the ad set paused too?",
        actionCalls: [{ actionId: "pause_adset", requiresConfirmation: true, confirmationHandle: "h-2", summary: "Pause the ad set?" }]
      }
    }, { confirmFieldsCapable: false });
    expect(outcome.pending).toEqual([
      expect.objectContaining({ turnId: "turn-2", confirmationHandle: "h-2", summary: "Pause the ad set?", confirmFieldsCapable: false })
    ]);
  });

  it("a follow-up error after the receipt adds its words and never undoes the receipt", () => {
    const outcome = followUpOutcome({ ok: true, view: receiptView(), followUpError: { code: "turn_failed", message: "The follow-up could not finish." } }, { confirmFieldsCapable: true });
    expect(outcome.message).toBe("");
    expect(outcome.errorLines).toEqual([{ tone: "warn", text: "! The follow-up stopped: The follow-up could not finish." }]);
    expect(outcome.errorLines.map((line) => line.text).join("\n")).not.toMatch(/not done|nothing ran|✗/iu);
  });

  it("a plain confirm (no stream) has no follow-up", () => {
    expect(followUpOutcome({ ok: true, view: receiptView() }, { confirmFieldsCapable: true })).toEqual({ message: "", pending: [], errorLines: [] });
    expect(followUpOutcome(undefined, { confirmFieldsCapable: true })).toEqual({ message: "", pending: [], errorLines: [] });
  });

  it("the follow-up's answer is scrubbed of terminal controls", () => {
    const esc = String.fromCharCode(27);
    const outcome = followUpOutcome({ ok: true, followUp: { message: `${esc}[31mDone.${esc}[0m`, actionCalls: [] } }, { confirmFieldsCapable: true });
    expect(outcome.message).toBe("Done.");
  });

  it("only a follow-up's decoded view frames go on the turn", () => {
    const frame = { protocolVersion: 1 as const, requestId: "r", sequence: 2, kind: "progress" as const, data: { type: "tool.view", stage: "tool", message: "", viewId: "v1", name: "read_ads", view: receiptView({ state: "ready", receipt: undefined }) } };
    expect(followUpViewFrame(frame)?.viewId).toBe("v1");
    expect(followUpViewFrame({ ...frame, data: { type: "message.delta", text: "x" } })).toBeNull();
    expect(followUpViewFrame({ ...frame, data: { type: "tool.view", view: { kind: "carousel" } } })).toBeNull();
  });
});

describe("the session's ordered steps when a confirm ends (confirmStreamSteps)", () => {
  const FOLLOW = {
    ok: true,
    view: receiptView(),
    followUp: {
      turnId: "turn-2",
      message: "It stopped spending. Want the ad set paused too?",
      actionCalls: [{ actionId: "pause_adset", requiresConfirmation: true, confirmationHandle: "h-2", summary: "Pause the ad set?" }]
    }
  };

  it("a streamed yes: the receipt settled once (already, by the stream), then the follow-up answer, then its card", () => {
    const steps = confirmStreamSteps({ type: "resolved", result: FOLLOW }, { answered: true, confirmFieldsCapable: true });
    expect(steps.map((step) => step.type)).toEqual(["message", "queue"]);
    expect(steps[0]).toEqual({ type: "message", text: "It stopped spending. Want the ad set paused too?" });
    expect(steps[1]).toMatchObject({ type: "queue", pending: [expect.objectContaining({ turnId: "turn-2", confirmationHandle: "h-2" })] });
  });

  it("a receipt not yet drawn by the stream is settled first, then the follow-up, in the same turn", () => {
    const steps = confirmStreamSteps({ type: "resolved", result: FOLLOW }, { answered: false, confirmFieldsCapable: true });
    expect(steps.map((step) => step.type)).toEqual(["settle", "message", "queue"]);
    expect(steps[0]).toEqual({ type: "settle", outcome: FOLLOW, thrown: false });
  });

  it("a plain confirm with no follow-up only settles its receipt", () => {
    const plain = { ok: true, view: receiptView() };
    expect(confirmStreamSteps({ type: "resolved", result: plain }, { answered: false, confirmFieldsCapable: true }))
      .toEqual([{ type: "settle", outcome: plain, thrown: false }]);
  });

  it("a follow-up that answered and then failed: its answer, then its error words, never a re-settle", () => {
    const result = { ...FOLLOW, followUp: { ...FOLLOW.followUp, actionCalls: [] }, followUpError: { code: "turn_failed", message: "The follow-up could not finish." } };
    const steps = confirmStreamSteps({ type: "resolved", result }, { answered: true, confirmFieldsCapable: true });
    expect(steps).toEqual([
      { type: "message", text: "It stopped spending. Want the ad set paused too?" },
      { type: "lines", lines: [{ tone: "warn", text: "! The follow-up stopped: The follow-up could not finish." }] }
    ]);
  });

  it("a throw after the receipt adds only the follow-up's error words: the receipt stays done", () => {
    const steps = confirmStreamSteps({ type: "rejected", error: new Error("The stream closed.") }, { answered: true, confirmFieldsCapable: true });
    expect(steps).toEqual([{ type: "lines", lines: [{ tone: "warn", text: "! The follow-up stopped: The stream closed." }] }]);
  });

  it("a throw with no receipt settles the card from the error (field_invalid keeps it live there), nothing else", () => {
    const error = Object.assign(new Error("That budget must be at least 1."), { code: "field_invalid", nothingRan: true });
    expect(confirmStreamSteps({ type: "rejected", error }, { answered: false, confirmFieldsCapable: true }))
      .toEqual([{ type: "settle", outcome: error, thrown: true }]);
  });
});

describe("a streamed error with no receipt is not done", () => {
  it("renders as not done, never as a receipt", () => {
    const error = Object.assign(new Error("That budget must be at least 1."), { code: "field_invalid", nothingRan: true });
    const lines = confirmErrorLines(error);
    expect(lines).toEqual([{ tone: "bad", text: "✗ Not done: That budget must be at least 1." }]);
  });

  it("without the app's words it still says nothing ran", () => {
    const error = Object.assign(new Error(""), { code: "confirmation_not_found", nothingRan: true });
    expect(confirmErrorLines(error)).toEqual([{ tone: "bad", text: "✗ Not done: nothing ran." }]);
  });

  it("an error the bridge cannot vouch for keeps T6's words", () => {
    const error = Object.assign(new Error("Check it in the app before trying again."), { code: "receipt_unavailable" });
    expect(confirmErrorLines(error)[0]?.text).not.toContain("Not done");
  });
});

describe("what `o` says after the app answers", () => {
  it.each([
    ["opened", "↗ Opened in the app."],
    ["wrong_workspace", "! That place is in another workspace. Switch to it in the app first."],
    ["signed_out", "! Sign in to the app first."],
    ["unavailable", "! The app can't open that place right now."]
  ])("%s", (status, words) => {
    expect(appOpenLines({ ok: status === "opened", status })).toEqual([words]);
  });

  it("an error prints its own (scrubbed) words, never a browser fallback", () => {
    const error = Object.assign(new Error("Opening places from the terminal needs a newer Infinite Desktop. Update Desktop and try again."), { code: "desktop_update_required" });
    expect(appOpenLines(error)).toEqual(["! Opening places from the terminal needs a newer Infinite Desktop. Update Desktop and try again."]);
    expect(appOpenLines(new Error(""))).toEqual(["! The app can't open that place right now."]);
  });
});
