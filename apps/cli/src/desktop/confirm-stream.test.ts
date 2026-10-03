// T12 (P3.3): what the session does with a streamed confirm's parts (the
// receipt, the follow-up, an error) and with `o`'s answer. Pure, CI-run.
// Synthetic data only.
import { describe, expect, it } from "vitest";

import { appOpenLines } from "./app-open.js";
import { confirmErrorLines } from "./confirm-result-lines.js";
import { confirmStreamSteps, followUpFrameRoute, followUpOutcome, followUpViewFrame } from "./confirm-stream.js";
import { displayWidth } from "../tui/lib/display-width.js";
import { INFINITE_R4_THEME } from "../tui/theme.js";
import { renderCommittedTurn } from "../tui/views/layout.js";

function receiptView(overrides: Record<string, unknown> = {}) {
  return {
    v: 1, kind: "change", tool: "pause_entity", title: "Pause", state: "done", asOf: null,
    scope: { workspaceName: "Example Co", crossWorkspace: false }, caveats: [],
    receipt: { sentence: "Paused ad “Demo B”", tone: "ok", revertible: true },
    body: { target: { kind: "ad", label: "Demo B" }, rows: [], warnings: [] },
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

  // P33-M1: the answer is prose for the markdown renderer, never one collapsed line.
  it("keeps every line break, and still drops ESC, OSC and bidi controls", () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const message = `${esc}]8;;https://x.test${bel}Paused.${esc}]8;;${bel} Here is what changed:\r\n\n- Ad one: ${esc}[1mpaused${esc}[0m\n- Ad two:‮ still on\n`;
    const outcome = followUpOutcome({ ok: true, followUp: { message, actionCalls: [] } }, { confirmFieldsCapable: true });
    expect(outcome.message.split("\n")).toEqual(["Paused. Here is what changed:", "", "- Ad one: paused", "- Ad two:  still on"]);
    expect(outcome.message).not.toMatch(/[\u001b\u0007‮\r]/u);
  });

  it("draws a list and a table exactly as a normal turn's answer draws the same text", () => {
    const text = "Paused. Here is what changed:\n\n- Ad one: paused\n- Ad two: still on\n\n| Ad | Spend |\n|---|---|\n| Ad one | $12 |\n| Ad two | $30 |\n\nWant the ad set paused too?";
    const follow = followUpOutcome({ ok: true, followUp: { message: text, actionCalls: [] } }, { confirmFieldsCapable: true });
    const draw = (answer: string) => renderCommittedTurn({
      messages: [{ role: "user", text: "pause demo b" }, { role: "assistant", text: answer }],
      views: [], focus: null, width: 100, color: false, theme: INFINITE_R4_THEME
    });
    const followUpLines = draw(follow.message);
    expect(followUpLines).toEqual(draw(text));
    expect(followUpLines.filter((line) => line.includes("•"))).toHaveLength(2);
    expect(followUpLines.some((line) => line.includes("┌"))).toBe(true);
    expect(followUpLines.some((line) => /│ Ad one │\s+\$12 │/u.test(line))).toBe(true);
  });

  it("only a follow-up's decoded view frames go on the turn", () => {
    const frame = { protocolVersion: 1 as const, requestId: "r", sequence: 2, kind: "progress" as const, data: { type: "tool.view", stage: "tool", message: "", viewId: "v1", name: "read_ads", view: receiptView({ state: "ready", receipt: undefined }) } };
    expect(followUpViewFrame(frame)?.viewId).toBe("v1");
    expect(followUpViewFrame({ ...frame, data: { type: "message.delta", text: "x" } })).toBeNull();
    expect(followUpViewFrame({ ...frame, data: { type: "tool.view", view: { kind: "carousel" } } })).toBeNull();
  });
});

// P33-S3: the follow-up's frames go where a normal turn's go (its views, its Steps, its drafts).
describe("where a follow-up's progress frames go (followUpFrameRoute)", () => {
  const base = { protocolVersion: 1 as const, requestId: "r", sequence: 3, kind: "progress" as const };

  it("a call's start and end become Steps events, with the app's step words decoded", () => {
    const start = followUpFrameRoute({ ...base, data: { type: "tool.start", stage: "tool", message: "", toolId: "c1", name: "list_ads", context: "", words: { label: "checking your ad set" } } });
    expect(start).toMatchObject({ type: "step", event: { type: "tool.start", toolId: "c1", name: "list_ads", words: { label: "checking your ad set" } } });
    const done = followUpFrameRoute({ ...base, data: { type: "tool.complete", stage: "tool", message: "", toolId: "c1", name: "list_ads", status: "ok" } });
    expect(done).toMatchObject({ type: "step", event: { type: "tool.complete", toolId: "c1" } });
    expect(followUpFrameRoute({ ...base, data: { type: "tool.progress", stage: "tool", message: "2 of 3", toolId: "c1", name: "list_ads" } }))
      .toMatchObject({ type: "step", event: { type: "tool.progress" } });
  });

  it("an image draft goes to the draft lines, rebuilt from its allowlist (no brief, no URL)", () => {
    const route = followUpFrameRoute({ ...base, data: {
      type: "creative.draft", runId: "run_1", status: "running", count: 3, format: "png", aspectRatio: "4:5", quality: "high",
      brief: "secret brief", imageUrl: "https://x.test/a.png"
    } });
    expect(route?.type).toBe("draft");
    expect(JSON.stringify(route)).not.toMatch(/secret brief|https:/u);
  });

  it("a view goes to the turn's views; streamed text and unknown frames are dropped", () => {
    expect(followUpFrameRoute({ ...base, data: { type: "tool.view", stage: "tool", message: "", viewId: "v1", name: "read_ads", view: receiptView({ state: "ready", receipt: undefined }) } })?.type).toBe("view");
    expect(followUpFrameRoute({ ...base, data: { type: "message.delta", stage: "message", message: "x", text: "x" } })).toBeNull();
    expect(followUpFrameRoute({ ...base, data: { delta: "x" } })).toBeNull();
    expect(followUpFrameRoute({ ...base, data: { type: "creative.draft", runId: "" } })).toBeNull();
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

  // P33-M2: a follow-up that ends after the card's turn went up never answers another question.
  it("off the card's turn, the follow-up's answer is labelled lines, never an assistant message", () => {
    const result = { ...FOLLOW, followUp: { ...FOLLOW.followUp, message: "It stopped spending.\n\n- Ad one: paused", actionCalls: [] } };
    const steps = confirmStreamSteps({ type: "resolved", result }, { answered: true, confirmFieldsCapable: true, onCardTurn: false, label: "Pause ad 01" });
    expect(steps.map((step) => step.type)).toEqual(["lines"]);
    const lines = steps[0]!.type === "lines" ? steps[0]!.lines.map((line) => line.text) : [];
    expect(lines).toEqual(["↳ The follow-up to “Pause ad 01”:", "  It stopped spending.", "", "  • Ad one: paused"]);
    expect(steps.some((step) => step.type === "message")).toBe(false);
  });

  // R-S3: off its turn the answer is still drawn by the markdown renderer, never printed as raw markdown.
  it("off the card's turn, a list and a table draw as the rendered list and table under the label", () => {
    const text = "Paused. Here is what changed:\n\n- Ad one: **paused**\n- Ad two: still on\n\n| Ad | Spend |\n|---|---|\n| Ad one | $12 |\n| Ad two | $30 |";
    const result = { ...FOLLOW, followUp: { ...FOLLOW.followUp, message: text, actionCalls: [] } };
    for (const width of [60, 100, 140]) {
      const steps = confirmStreamSteps({ type: "resolved", result }, { answered: true, confirmFieldsCapable: true, onCardTurn: false, label: "Pause ad 01", width });
      expect(steps.map((step) => step.type)).toEqual(["lines"]);
      const lines = steps[0]!.type === "lines" ? steps[0]!.lines.map((line) => line.text) : [];
      expect(lines[0]).toBe("↳ The follow-up to “Pause ad 01”:");
      const body = lines.slice(1);
      expect(body.filter((line) => line.includes("•"))).toHaveLength(2);
      expect(body.some((line) => line.includes("┌"))).toBe(true);
      expect(body.some((line) => /│ Ad one │\s+\$12 │/u.test(line))).toBe(true);
      expect(body.join("\n")).not.toMatch(/\|---|\| Ad \||^ {2}- |\*\*/mu);
      // Indented under the label, never wider than the transcript.
      for (const line of body) {
        if (line) expect(line.startsWith("  ")).toBe(true);
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("off the card's turn, a card the follow-up proposed is queued only after a line says whose it is", () => {
    const steps = confirmStreamSteps({ type: "resolved", result: FOLLOW }, { answered: true, confirmFieldsCapable: true, onCardTurn: false, label: "Pause ad 01" });
    expect(steps.map((step) => step.type)).toEqual(["lines", "lines", "queue"]);
    const said = steps[1]!.type === "lines" ? steps[1]!.lines.map((line) => line.text) : [];
    expect(said).toEqual(["↳ The follow-up to “Pause ad 01” asks for your OK on a new card."]);
    expect(steps[2]).toMatchObject({ type: "queue", pending: [expect.objectContaining({ confirmationHandle: "h-2" })] });
  });

  it("off the card's turn, the follow-up's error words say whose follow-up stopped", () => {
    const steps = confirmStreamSteps({ type: "rejected", error: new Error("The stream closed.") }, { answered: true, confirmFieldsCapable: true, onCardTurn: false, label: "Pause ad 01" });
    expect(steps).toEqual([{ type: "lines", lines: [
      { tone: "muted", text: "↳ The follow-up to “Pause ad 01”:" },
      { tone: "warn", text: "! The follow-up stopped: The stream closed." }
    ] }]);
  });

  it("on the card's turn (the default) nothing is labelled", () => {
    const steps = confirmStreamSteps({ type: "resolved", result: FOLLOW }, { answered: true, confirmFieldsCapable: true, onCardTurn: true, label: "Pause ad 01" });
    expect(steps.map((step) => step.type)).toEqual(["message", "queue"]);
  });

  it("a follow-up the user stopped (Esc) says so, and never re-decides the change", () => {
    const stopped = { ok: true, view: receiptView(), followUpError: { code: "desktop_turn_detached", message: "The request was detached." } };
    const steps = confirmStreamSteps({ type: "resolved", result: stopped }, { answered: true, confirmFieldsCapable: true, stopped: true });
    expect(steps).toEqual([{ type: "lines", lines: [{ tone: "muted", text: "■ Stopped the follow-up. Anything already running in the app may still finish." }] }]);
    expect(steps.some((step) => step.type === "settle")).toBe(false);
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
