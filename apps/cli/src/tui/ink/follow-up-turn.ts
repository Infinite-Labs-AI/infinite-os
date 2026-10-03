// The streamed follow-up after a yes (T12, confirm.stream.v1), as the running
// turn (P33-M2). From the card's receipt until the stream's terminal frame the
// agent is still working on the card's turn, so the session treats it like a
// running turn: a typed line waits in the queue, the composer says it is
// following up, the key bar's first hint is `esc stop` (DECISIONS D6), and Esc
// or Ctrl-C stop it. The follow-up has its own AbortController: stopping it
// ends only the follow-up. The write already went before the receipt and is
// never re-decided; before the receipt nothing here is armed, so Esc never
// touches a yes on its way. Pure (no Ink), so every rule is CI-run.
import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import type { AnswerViewV1, ApprovalFieldAnswerV1, CreativeDraftFrameV1, ToolViewFrameV1 } from "@infinite-os/types";

import type { InSessionConfirmationAction, InSessionConfirmationClient } from "../../desktop/confirm-in-session.js";
import { followUpFrameRoute, followUpLabel } from "../../desktop/confirm-stream.js";
import type { KeyHint } from "../keys/keymap.js";
import type { Theme } from "../theme.js";
import { renderCommittedTurn } from "../views/layout.js";
import { formatWholeElapsed } from "./status-indicator.js";
import { linkAbortSignals, TURN_STOPPED, type TurnAbort, type TurnStopReason } from "./turn-abort.js";

/** What a streamed confirm hands the session before it resolves (T12). */
export interface ConfirmStreamHooks {
  /**
   * The follow-up's own signal (P33-M2): aborted only by Esc / Ctrl-C after
   * the receipt, so a stop ends only the follow-up, never the write.
   */
  signal: AbortSignal;
  /** The card's receipt (a plain confirm's answer), before the follow-up. */
  onReceipt(result: unknown): void;
  /** A view from the agent's follow-up, for the card's own turn. */
  onView(frame: ToolViewFrameV1): void;
  /** A follow-up call's start, progress or end, for the card's turn's Steps (P33-S3). */
  onStep(event: ChatProgressEvent): void;
  /** A follow-up's image draft in progress (`drawing 2 of 3`), as on a normal turn (P33-S3). */
  onCreativeDraft(frame: CreativeDraftFrameV1): void;
}

/** The follow-ups running now (one per streamed yes whose receipt came), each on its own controller. */
export interface FollowUpAbort {
  /** The receipt arrived: Esc and Ctrl-C now stop this follow-up. */
  arm(controller: AbortController): void;
  /** Stop every running follow-up. Returns whether one was running. */
  stop(reason: TurnStopReason): boolean;
  /** Whether a follow-up is running (armed, not stopped, not ended). */
  active(): boolean;
  /** Disarm when its call ends. Returns whether the user stopped it. */
  end(controller: AbortController): boolean;
}

export function createFollowUpAbort(): FollowUpAbort {
  const running = new Set<AbortController>();
  return {
    arm(controller) {
      if (!controller.signal.aborted) running.add(controller);
    },
    stop() {
      const live = [...running].filter((controller) => !controller.signal.aborted);
      running.clear();
      for (const controller of live) controller.abort(new Error(TURN_STOPPED));
      return live.length > 0;
    },
    active() {
      return [...running].some((controller) => !controller.signal.aborted);
    },
    end(controller) {
      running.delete(controller);
      return controller.signal.aborted
        && controller.signal.reason instanceof Error
        && controller.signal.reason.message === TURN_STOPPED;
    }
  };
}

/**
 * The stop Esc and Ctrl-C use: the running turn first, else the running
 * follow-up. One key stops one thing; Ctrl-C quits only when neither runs.
 */
export function runningTurnAbort(turn: TurnAbort, followUp: FollowUpAbort): TurnAbort {
  return {
    start: () => turn.start(),
    stop: (reason) => turn.stop(reason) || followUp.stop(reason),
    active: () => turn.active() || followUp.active(),
    end: (signal) => turn.end(signal)
  };
}

/** One streamed yes's follow-up: its own controller, and the hooks the confirm call gets. */
export interface FollowUpStream {
  controller: AbortController;
  hooks: ConfirmStreamHooks;
  /** Whether the receipt came, so the follow-up is running (its stop armed). */
  armed(): boolean;
}

/**
 * The hooks for one streamed yes (R-S1). The follow-up's stop is armed by
 * the receipt and never before it: until the receipt, Esc and Ctrl-C never
 * touch the yes's request, so a write that may already have gone never turns
 * into an unknown outcome. Every receipt goes to `onReceipt` (the session
 * settles the card once); the first one arms the stop and calls `onArmed`.
 */
export function createFollowUpStream(
  abort: FollowUpAbort,
  parts: Omit<ConfirmStreamHooks, "signal"> & { onArmed(): void }
): FollowUpStream {
  const controller = new AbortController();
  let armed = false;
  return {
    controller,
    armed: () => armed,
    hooks: {
      signal: controller.signal,
      onReceipt: (result) => {
        parts.onReceipt(result);
        if (armed) return;
        armed = true;
        abort.arm(controller);
        parts.onArmed();
      },
      onView: (frame) => parts.onView(frame),
      onStep: (event) => parts.onStep(event),
      onCreativeDraft: (frame) => parts.onCreativeDraft(frame)
    }
  };
}

/** The narrow runner a card's confirm goes through (the desktop session runner). */
export interface ConfirmRunner {
  confirm: InSessionConfirmationClient["confirm"];
  /** Whether the last turn's app can stream a card's confirm (confirm.stream.v1 with views). */
  streamCapable(): boolean;
}

/**
 * A card's confirm through the runner (R-S4, index.ts). A card with a view
 * streams its confirm when the app can (confirm.stream.v1): the receipt
 * first, then the follow-up's frames where a normal turn's go (P33-S3): its
 * views, its calls' Steps rows, its image drafts. A streamed confirm runs on
 * the follow-up's own signal linked to the session's (P33-M2), let go when
 * the call ends. Anything else confirms plainly on the session's signal.
 */
export function confirmThroughRunner(
  runner: ConfirmRunner,
  input: {
    action: InSessionConfirmationAction;
    decision: "approve" | "decline";
    fields?: Record<string, ApprovalFieldAnswerV1>;
    stream?: ConfirmStreamHooks;
    turnSignal: AbortSignal;
  }
): Promise<unknown> {
  const { action, decision, fields, stream, turnSignal } = input;
  const streamed = stream && action.view && runner.streamCapable() ? stream : null;
  const linked = streamed ? linkAbortSignals([turnSignal, streamed.signal]) : null;
  return runner.confirm({
    turnId: action.turnId,
    confirmationHandle: action.confirmationHandle,
    decision,
    ...(fields && Object.keys(fields).length ? { fields } : {}),
    signal: linked?.signal ?? turnSignal,
    ...(streamed
      ? {
          stream: true,
          onReceipt: (receipt) => streamed.onReceipt(receipt),
          onProgress: (frame) => {
            const route = followUpFrameRoute(frame);
            if (route?.type === "view") streamed.onView(route.frame);
            else if (route?.type === "draft") streamed.onCreativeDraft(route.frame);
            else if (route?.type === "step") streamed.onStep(route.event);
          }
        }
      : {})
  }).finally(() => linked?.dispose());
}

/** Whether a submitted line waits in the queue: while a turn or a streamed follow-up runs. */
export function lineWaits(state: { busy: boolean; followUpRunning: boolean }): boolean {
  return state.busy || state.followUpRunning;
}

const STOP_HINT: KeyHint = { key: "esc", label: "stop" };

/** The bar while something stoppable runs: `esc stop` first, shown once (D6). */
export function runningBarHints(hints: readonly KeyHint[], running: boolean): readonly KeyHint[] {
  if (!running) return hints;
  return [STOP_HINT, ...hints.filter((hint) => hint.key !== STOP_HINT.key)];
}

/** The composer's note while the follow-up runs (`❯ Ask Infinite… (following up 3s)`). */
export function followUpNote(startedAt: number, nowMs: number): string {
  return `following up ${formatWholeElapsed(nowMs - startedAt)}`;
}

/**
 * A follow-up view that arrived after a new line took the card's turn up:
 * printed under the live turn as plain lines labelled with whose follow-up it
 * is (never on the new question's views, never dropped).
 */
export function offTurnViewLines(view: AnswerViewV1, summary: string, width: number, theme: Theme): string[] {
  const body = renderCommittedTurn({ messages: [], views: [view], focus: null, width: Math.max(8, width - 2), color: false, theme });
  return [`↳ ${followUpLabel(summary)}:`, ...body.map((line) => (line ? `  ${line}` : ""))];
}
