import { afterEach, describe, expect, it } from "vitest";

import { InfiniteTurnController, resetTurnState } from "./turn-controller.js";

// Synthetic data only: infinite-os is public.
const toolStart = (toolId: string, name: string, context: string) =>
  ({ type: "tool.start", stage: "tool", message: name, toolId, name, context }) as const;
const toolComplete = (toolId: string, name: string) =>
  ({ type: "tool.complete", stage: "tool", message: name, toolId, name, durationMs: 1200 }) as const;
const delta = (text: string) => ({ type: "message.delta", stage: "message", message: text, text }) as const;

describe("stoppedTranscript (a turn stopped with Esc or Ctrl-C keeps what it showed)", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("keeps the streamed partial answer, finished tools, and running tools marked stopped", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent(delta("Looking at spend first. "));
    controller.recordProgressEvent(toolStart("t1", "read_spend", "last 7 days"));
    controller.recordProgressEvent(toolComplete("t1", "read_spend"));
    controller.recordProgressEvent(toolStart("t2", "pause_entity", "Hook B"));
    controller.recordProgressEvent(delta("PARTIAL-ANSWER-TEXT"));

    const messages = controller.stoppedTranscript();
    const text = messages.map((msg) => msg.text).join("\n");
    const tools = messages.flatMap((msg) => msg.tools ?? []);

    expect(text).toContain("Looking at spend first.");
    expect(text).toContain("PARTIAL-ANSWER-TEXT");
    expect(tools.some((line) => /read.?spend/i.test(line) && line.endsWith(" ✓"))).toBe(true);
    const stopped = tools.find((line) => /pause.?entity/i.test(line));
    expect(stopped).toBeDefined();
    // A stopped tool is neither done (✓) nor failed (✗): the app may still finish it.
    expect(stopped!.endsWith(" ✓") || stopped!.endsWith(" ✗")).toBe(false);
    expect(stopped).toContain("stopped");
  });

  it("is a pure snapshot: it changes nothing, so reset() still clears the turn", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent(delta("PARTIAL-ANSWER-TEXT"));
    const first = controller.stoppedTranscript();
    expect(controller.stoppedTranscript()).toEqual(first);
    controller.reset();
    expect(controller.stoppedTranscript()).toEqual([]);
  });

  it("an empty turn has nothing to keep", () => {
    expect(new InfiniteTurnController(() => 0).stoppedTranscript()).toEqual([]);
  });

  it("scrubs control sequences from a running tool's name and context", () => {
    const controller = new InfiniteTurnController(() => 0);
    controller.recordProgressEvent(toolStart("t1", "pause\u001b]0;x\u0007_entity", "Hook\u001b[2J B"));
    const line = controller.stoppedTranscript().flatMap((msg) => msg.tools ?? [])[0]!;
    expect(line).not.toMatch(/\u001b/);
  });
});
