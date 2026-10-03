// T12 (P3.3) in the session: `o` opens a place through the app (never a
// browser), the view keys follow what the app negotiated, and a streamed yes
// shows the receipt, then the agent's follow-up answer, in the same turn.
// Structural guards run on CI; the fake-TTY flows are skipped there.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { describe, expect, it, vi } from "vitest";

import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { resetTurnState } from "../app/turn-store.js";
import { runInkInteractiveSession, type ConfirmStreamHooks, type InkInteractiveLineResult } from "./interactive-session.js";

const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
const indexSource = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf8");
const stripAnsi = (value: string) => value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

describe("T12 wiring (CI-runnable)", () => {
  it("the view keys take the app's negotiated caps, never a fixed none", () => {
    // The third argument is the turn's card (the polish lane's lookup fold); the caps stay the app's.
    expect(source.match(/viewFocusAfterTurnDone\(views\.map\(\(frame\) => frame\.view\), viewCaps\(\)(?:, [^;]+)?\) : null/gu)?.length).toBe(3);
    expect(source).not.toMatch(/viewFocusAfterTurnDone\([^;]*NO_KEY_CAPS/u);
    expect(indexSource).toContain("appCaps: () => runner.caps(),");
  });

  it("`o` goes to the app's /v1/open, never a browser or a URL", () => {
    expect(source).toContain("openAppPlace(next.effect.target);");
    expect(source).toContain("openAppPlace(headConfirmAction?.view ? cardOpenLink(headConfirmAction.view) : null);");
    expect(source).toContain("void onOpenAppLink(target).then(");
    expect(indexSource).toContain("onOpenAppLink: (target) => runner.openPlace(target),");
    const handler = source.slice(source.indexOf("const openAppPlace"), source.indexOf("const handleCardAction"));
    expect(handler).not.toMatch(/openExternal|xdg-open|spawn|exec|\.url\b/u);
  });

  it("a streamed receipt settles the card once, before the follow-up; the follow-up goes on the card's turn", () => {
    const handler = source.slice(source.indexOf("const resolveConfirmAction"), source.indexOf("const openAppPlace"));
    // Every receipt goes to onAnswer (createFollowUpStream, CI-tested in follow-up-turn.test.ts), which settles once.
    expect(handler).toContain("const followUpStream = createFollowUpStream(followUpAbort, {\n      onReceipt: onAnswer,");
    expect(handler).toContain("if (answered) return;");
    // The order of what happens when the call ends is confirm-stream.ts `confirmStreamSteps` (unit-tested there);
    // the session runs every step it returns, and each step does its one thing.
    expect(handler).toContain("const result = await onConfirmAction?.(head, decision, fields, streamHooks);\n        runSteps({ type: \"resolved\", result }, endFollowUp());");
    expect(handler).toMatch(/\} catch \(error\) \{\s+runSteps\(\{ type: "rejected", error \}, endFollowUp\(\)\);/u);
    // P33-M2: whether the card's turn is still live goes into the steps, so an off-turn follow-up prints labelled.
    expect(handler).toContain("const options = { answered, confirmFieldsCapable: head.confirmFieldsCapable === true, onCardTurn: onCardTurn(), label, stopped, width: transcriptColumns(columns) };");
    expect(handler).toContain("for (const step of confirmStreamSteps(end, options)) {");
    expect(handler).toMatch(/case "settle":\s+if \(step\.thrown\) \{\s+if \(settle\(step\.outcome, true\) && !refusedField\(step\.outcome\)\) afterReceipt\(step\.outcome\);\s+\} else onAnswer\(step\.outcome\);\s+break;/u);
    expect(handler).toMatch(/case "message":\s+appendMessages\(\[\{ role: "assistant", text: step\.text \}\]\);\s+break;/u);
    expect(handler).toMatch(/case "lines":\s+appendLines\(step\.lines\);\s+break;/u);
    expect(handler).toMatch(/case "queue":\s+setPendingConfirmActions\(\(current\) => \[\.\.\.current, \.\.\.step\.pending\]\);\s+break;/u);
    // The follow-up's views land on the card's own turn; off it they print labelled, never dropped.
    expect(handler).toMatch(/onView: \(frame\) => \{\s+if \(!onCardTurn\(\)\) \{\s+[^}]*offTurnViewLines\(frame\.view, label,/u);
    // The client streams only a card that carried a view, and only from an app that can
    // (confirmThroughRunner, driven with a fake runner in follow-up-turn.test.ts).
    expect(indexSource).toContain("confirmThroughRunner(runner, { action, decision, fields, stream, turnSignal: turnAbort.signal }),");
  });
});

describe("P33-M2 / S3 wiring (CI-runnable)", () => {
  const handler = source.slice(source.indexOf("const resolveConfirmAction"), source.indexOf("const openAppPlace"));

  it("the follow-up runs on its own controller, armed for Esc only once the receipt came", () => {
    // Backstop only: the arming rule itself is CI-tested on createFollowUpStream (follow-up-turn.test.ts),
    // and the session hands the confirm exactly the hooks that builder made.
    expect(handler).toContain("const followUp = followUpStream.controller;");
    expect(handler).toContain("const streamHooks: ConfirmStreamHooks = followUpStream.hooks;");
    expect(handler).not.toMatch(/followUpAbort\.arm\(/u);
    // Esc / Ctrl-C reach it through the composer's stop, which stops a running turn first.
    expect(source).toContain("const [stopAbort] = useState<TurnAbort>(() => runningTurnAbort(turnAbort, followUpAbort));");
    expect(source).toContain("turnAbort={stopAbort}");
    expect(source).toContain("busy={busy || followUpRunning}");
    // The confirm's signal is the follow-up's own, linked to the session's (confirmThroughRunner, CI-tested).
    expect(indexSource).toContain("turnSignal: turnAbort.signal");
  });

  it("typed lines wait while the follow-up runs; the bar says esc stop first; the kept strip hides", () => {
    expect(source).toContain("if (lineWaits({ busy, followUpRunning })) {");
    expect(source).toContain("return runningBarHints(hints, followUpRunning && turnStoppable);");
    expect(source).toContain("const liveKeptSteps = !busy && !followUpRunning && !turnSteps.length ? keptSteps : null;");
    expect(source).toContain(": followUps ? followUpNote(followUps.startedAt, clock) : null),");
  });

  it("the follow-up's Steps and image drafts go on the card's turn only", () => {
    expect(handler).toMatch(/onStep: \(event\) => \{\s+if \(onCardTurn\(\)\) turnController\.recordProgressEvent\(event\);/u);
    expect(handler).toMatch(/onCreativeDraft: \(frame\) => \{\s+if \(onCardTurn\(\)\) recordCreativeDraft\(frame\);/u);
    // Where index.ts sends each follow-up frame is confirmThroughRunner's job, driven with a fake runner in follow-up-turn.test.ts.
    expect(indexSource).toContain("onConfirmAction: (action, decision, fields, stream) =>\n        confirmThroughRunner(runner,");
  });
});

const RECEIPT_VIEW = {
  v: 1, kind: "change", tool: "propose_pause_entity", title: "Paused ad 01", state: "done", asOf: null,
  scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
  body: { target: { kind: "ad", label: "Ad 01" }, rows: [{ label: "status", before: "on", after: "PAUSED" }], warnings: [] },
  outcome: "applied", receipt: { sentence: "Stopped spending at 10:42", tone: "ok", revertible: true }
};
const CARD = {
  turnId: "t1",
  confirmationHandle: "h1",
  summary: "Pause ad 01",
  confirmationDetails: [],
  view: {
    ...RECEIPT_VIEW, title: "Pause ad", state: "needs_yes", outcome: undefined, receipt: undefined,
    approval: { kind: "card", title: "Pause ad 01?", summary: "Stops spend.", confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] }
  }
} as unknown as InSessionConfirmationAction;

describe("T12 in the session (fake TTY, skipped on CI)", () => {
  it.skipIf(process.env.CI === "true")(
    "a streamed yes shows the receipt, then the agent's follow-up answer, in the same turn",
    { timeout: 30_000 },
    async () => {
      const follow = deferred<unknown>();
      let hooks: ConfirmStreamHooks | undefined;
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
        onConfirmAction: (_action, _decision, _fields, stream) => {
          hooks = stream;
          return follow.promise;
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "p");
      await waitFor(() => hooks !== undefined, 4_000, lastFrame);
      const receipt = { ok: true, view: RECEIPT_VIEW };
      hooks!.onReceipt(receipt);
      // The receipt is on the turn before the follow-up has said anything.
      await waitFor(() => lastFrame().includes("Stopped spending at 10:42"), 4_000, lastFrame);
      expect(lastFrame()).not.toContain("It stopped spending. Want the ad set paused too?");
      follow.resolve({ ...receipt, followUp: { turnId: "t2", message: "It stopped spending. Want the ad set paused too?", actionCalls: [] } });
      await waitFor(() => lastFrame().includes("It stopped spending. Want the ad set paused too?"), 4_000, lastFrame);
      // Same turn: the question, the receipt and the follow-up are on screen together, the receipt once.
      expect(lastFrame()).toContain("pause it");
      expect(lastFrame().split("Stopped spending at 10:42").length - 1).toBe(1);
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a follow-up that fails after the receipt keeps the receipt done and adds its error",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
        onConfirmAction: async (_action, _decision, _fields, stream) => {
          const receipt = { ok: true, view: RECEIPT_VIEW };
          stream?.onReceipt(receipt);
          return { ...receipt, followUpError: { code: "turn_failed", message: "The follow-up could not finish." } };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "p");
      await waitFor(() => lastFrame().includes("The follow-up stopped: The follow-up could not finish."), 4_000, lastFrame);
      expect(lastFrame()).toContain("Stopped spending at 10:42");
      expect(lastFrame()).not.toMatch(/Not sent|Not done|nothing ran/iu);
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a streamed error with no receipt (field_invalid) is not done, and the card stays live",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
        onConfirmAction: async (_action, decision) => {
          if (decision === "decline") return { ok: true };
          throw Object.assign(new Error("That budget must be at least 1."), { code: "field_invalid", nothingRan: true });
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "p");
      await waitFor(() => lastFrame().includes("Not sent: That budget must be at least 1."), 4_000, lastFrame);
      // The card is back in front for a corrected answer, never a receipt.
      expect(lastFrame()).toContain("Pause ad 01?");
      expect(lastFrame()).not.toContain("Stopped spending at 10:42");
      // The live card still takes its keys: `n` is a real decline.
      await sendKeys(input, "n");
      await waitFor(() => !lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "`o` on a view asks the app to open its place and says what the app did",
    { timeout: 30_000 },
    async () => {
      const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../views/__fixtures__/images-done.json", import.meta.url)), "utf8"));
      const frame = { type: "tool.view", stage: "tool", message: "", viewId: "img", name: raw.tool, view: decodeAnswerView(raw)! } as ToolViewFrameV1;
      const opened: unknown[] = [];
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI",
        appCaps: () => ({ open: true, watch: true, retry: false }),
        onOpenAppLink: async (target) => {
          opened.push(target);
          return { ok: true, status: "opened" };
        },
        async onSubmitLine(_line, _progress, _signal, onView): Promise<InkInteractiveLineResult> {
          onView?.(frame);
          return { messages: [{ role: "assistant", text: "Here they are." }] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "show the images\r");
      await waitFor(() => lastFrame().includes("Here they are."), 4_000, lastFrame);
      await sendKeys(input, "\t");
      await waitFor(() => lastFrame().includes("Open in Library"), 4_000, lastFrame);
      await sendKeys(input, "o");
      await waitFor(() => opened.length === 1, 4_000, lastFrame);
      expect(opened).toEqual([{ place: "creative.library", params: { ids: "img_1,img_2,img_3" } }]);
      await waitFor(() => lastFrame().includes("Opened in the app."), 4_000, lastFrame);
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );
});

describe("P33-M2 / S3 in the session (fake TTY, skipped on CI)", () => {
  async function openCardAndReceipt(extra: { onSubmit?: (line: string) => Promise<InkInteractiveLineResult> } = {}) {
    const follow = deferred<unknown>();
    let hooks: ConfirmStreamHooks | undefined;
    const submitted: string[] = [];
    const input = ttyInput();
    const output = ttyOutput();
    const session = runInkInteractiveSession({
      columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI", turnStoppable: true,
      onConfirmAction: (_action, _decision, _fields, stream) => {
        hooks = stream;
        return follow.promise;
      },
      async onSubmitLine(line): Promise<InkInteractiveLineResult> {
        submitted.push(line);
        if (submitted.length === 1) return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
        return extra.onSubmit ? extra.onSubmit(line) : { messages: [{ role: "assistant", text: `SECOND-ANSWER to ${line}` }] };
      }
    });
    output.columns = 100;
    const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
    await waitFor(() => output.text().includes("Ask Infinite"));
    await sendKeys(input, "pause it\r");
    await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
    await sendKeys(input, "p");
    await waitFor(() => hooks !== undefined, 4_000, lastFrame);
    hooks!.onReceipt({ ok: true, view: RECEIPT_VIEW });
    await waitFor(() => lastFrame().includes("Stopped spending at 10:42"), 4_000, lastFrame);
    const keyBar = () => lastFrame().trimEnd().split("\n").at(-1) ?? "";
    return { follow, hooks: () => hooks!, submitted, input, output, session, lastFrame, keyBar };
  }

  it.skipIf(process.env.CI === "true")(
    "a line typed between the receipt and done waits; the bar says esc stop first; the answer stays on its own turn",
    { timeout: 30_000 },
    async () => {
      const run = await openCardAndReceipt();
      await waitFor(() => run.lastFrame().includes("following up"), 4_000, run.lastFrame);
      expect(run.keyBar().trim().startsWith("esc  stop")).toBe(true);
      await sendKeys(run.input, "how is campaign two doing\r");
      await waitFor(() => run.lastFrame().includes('queued: "how is campaign two doing"'), 4_000, run.lastFrame);
      expect(run.submitted).toEqual(["pause it"]);
      run.follow.resolve({ ok: true, view: RECEIPT_VIEW, followUp: { turnId: "t2", message: "FOLLOWUP-ANSWER:\n\n- one\n- two", actionCalls: [] } });
      await waitFor(() => run.submitted.length === 2, 4_000, run.lastFrame);
      await waitFor(() => run.lastFrame().includes("SECOND-ANSWER to how is campaign two doing"), 4_000, run.lastFrame);
      // R-S2: the follow-up answered the card's turn, with its bullets, before the second question was
      // asked; read from everything drawn (the static scrollback included), so a dropped answer fails.
      const all = stripAnsi(run.output.text());
      const queuedAt = all.indexOf('queued: "how is campaign two doing"');
      const answerAt = all.indexOf("FOLLOWUP-ANSWER");
      const echoAt = all.indexOf("❯ how is campaign two doing", queuedAt);
      const secondAt = all.indexOf("SECOND-ANSWER");
      expect(queuedAt).toBeGreaterThan(-1);
      expect(answerAt).toBeGreaterThan(queuedAt);
      expect(all.slice(answerAt)).toMatch(/• one[\s\S]*• two/u);
      expect(echoAt).toBeGreaterThan(answerAt);
      expect(secondAt).toBeGreaterThan(echoAt);
      // Drawn as the card's turn's answer, never labelled as an off-turn follow-up.
      expect(all).not.toContain("↳ The follow-up to");
      await sendKeys(run.input, "/exit\r");
      await run.session;
      resetTurnState();
    }
  );

  // R-S1: before the receipt the yes's request is never stopped: a write that may already have gone
  // must never turn into an unknown outcome. Esc with nothing running and Ctrl-C / Esc on another
  // turn leave the confirm's signal alone; only after the receipt does Esc reach it.
  it.skipIf(process.env.CI === "true")(
    "before the receipt, Esc and Ctrl-C never abort the yes's request, even while another turn runs",
    { timeout: 30_000 },
    async () => {
      const follow = deferred<unknown>();
      let hooks: ConfirmStreamHooks | undefined;
      const turnSignals: AbortSignal[] = [];
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI", turnStoppable: true,
        onConfirmAction: (_action, _decision, _fields, stream) => {
          hooks = stream;
          return follow.promise;
        },
        async onSubmitLine(_line, _progress, signal): Promise<InkInteractiveLineResult> {
          turnSignals.push(signal!);
          if (turnSignals.length === 1) return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
          await new Promise<void>((done) => signal!.addEventListener("abort", () => done(), { once: true }));
          return { messages: [] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "p");
      await waitFor(() => hooks !== undefined, 4_000, lastFrame);
      const signal = hooks!.signal;
      // Nothing running yet: Esc stops nothing.
      await sendKeys(input, "\u001b");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signal.aborted).toBe(false);
      // Another turn running: Ctrl-C stops that turn, then Esc stops the next one; the yes stays live.
      await sendKeys(input, "how is campaign two doing\r");
      await waitFor(() => turnSignals.length === 2, 4_000, lastFrame);
      await sendKeys(input, "\u0003");
      await waitFor(() => turnSignals[1]!.aborted, 4_000, lastFrame);
      expect(signal.aborted).toBe(false);
      await sendKeys(input, "and campaign three\r");
      await waitFor(() => turnSignals.length === 3, 4_000, lastFrame);
      await sendKeys(input, "\u001b");
      await waitFor(() => turnSignals[2]!.aborted, 4_000, lastFrame);
      expect(signal.aborted).toBe(false);
      // The receipt arms the stop: now Esc reaches the follow-up's own signal.
      hooks!.onReceipt({ ok: true, view: RECEIPT_VIEW });
      await waitFor(() => lastFrame().includes("following up"), 4_000, lastFrame);
      await sendKeys(input, "\u001b");
      await waitFor(() => signal.aborted, 4_000, lastFrame);
      follow.resolve({ ok: true, view: RECEIPT_VIEW, followUpError: { code: "desktop_turn_detached", message: "detached" } });
      await waitFor(() => lastFrame().includes("Stopped the follow-up."), 4_000, lastFrame);
      await sendKeys(input, "/exit\r");
      await session;
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "before the receipt, Ctrl-C with nothing running quits as before and never aborts the yes's request",
    { timeout: 30_000 },
    async () => {
      let hooks: ConfirmStreamHooks | undefined;
      const input = ttyInput();
      const output = ttyOutput();
      const session = runInkInteractiveSession({
        columns: 100, errorOutput: ttyOutput(), input, output, title: "Infinite TUI", turnStoppable: true,
        onConfirmAction: (_action, _decision, _fields, stream) => {
          hooks = stream;
          return deferred<unknown>().promise;
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [{ role: "assistant", text: "Ready." }], pendingConfirmations: [CARD] };
        }
      });
      output.columns = 100;
      const lastFrame = () => stripAnsi(output.text().split(`${String.fromCharCode(27)}[?2026h`).at(-1) ?? "");
      await waitFor(() => output.text().includes("Ask Infinite"));
      await sendKeys(input, "pause it\r");
      await waitFor(() => lastFrame().includes("Pause ad 01?"), 4_000, lastFrame);
      await sendKeys(input, "p");
      await waitFor(() => hooks !== undefined, 4_000, lastFrame);
      // An armed stop would swallow this Ctrl-C (and abort the yes); unarmed, it quits.
      await sendKeys(input, "\u0003");
      const ended = await Promise.race([session.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 3_000))]);
      expect(ended, lastFrame()).toBe(true);
      expect(hooks!.signal.aborted).toBe(false);
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "Esc stops only the follow-up's own signal; the receipt stays done",
    { timeout: 30_000 },
    async () => {
      const run = await openCardAndReceipt();
      const signal = run.hooks().signal;
      expect(signal.aborted).toBe(false);
      await sendKeys(run.input, "\u001b");
      await waitFor(() => signal.aborted, 4_000, run.lastFrame);
      run.follow.resolve({ ok: true, view: RECEIPT_VIEW, followUpError: { code: "desktop_turn_detached", message: "detached" } });
      await waitFor(() => run.lastFrame().includes("Stopped the follow-up."), 4_000, run.lastFrame);
      expect(run.lastFrame()).toContain("Stopped spending at 10:42");
      expect(run.lastFrame()).not.toMatch(/Not sent|Not done|following up/u);
      expect(run.keyBar()).not.toContain("esc");
      await sendKeys(run.input, "/exit\r");
      await run.session;
      resetTurnState();
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a follow-up's tool.start becomes a Steps row and its creative.draft a draft line, on the card's turn",
    { timeout: 30_000 },
    async () => {
      const run = await openCardAndReceipt();
      run.hooks().onStep({ type: "tool.start", stage: "tool", message: "", toolId: "c9", name: "list_ad_sets", context: "", words: { label: "checking the ad set" } } as never);
      run.hooks().onCreativeDraft({ type: "creative.draft", runId: "run_9", status: "running", count: 3, format: "png", aspectRatio: "4:5", quality: "high" });
      await waitFor(() => run.lastFrame().includes("checking the ad set"), 4_000, run.lastFrame);
      await waitFor(() => /3 images|image/iu.test(run.lastFrame()), 4_000, run.lastFrame);
      run.follow.resolve({ ok: true, view: RECEIPT_VIEW, followUp: { turnId: "t2", message: "Done.", actionCalls: [] } });
      await waitFor(() => !run.lastFrame().includes("following up"), 4_000, run.lastFrame);
      await sendKeys(run.input, "/exit\r");
      await run.session;
      resetTurnState();
    }
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  stream.rows = 40;
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
