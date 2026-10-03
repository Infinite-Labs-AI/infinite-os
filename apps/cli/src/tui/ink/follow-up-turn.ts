// The streamed follow-up after a yes (T12, confirm.stream.v1), as the running
// turn (P33-M2). From the card's receipt until the stream's terminal frame the
// agent is still working on the card's turn, so the session treats it like a
// running turn: a typed line waits in the queue, the composer says it is
// following up, the key bar's first hint is `esc stop` (DECISIONS D6), and Esc
// or Ctrl-C stop it. The follow-up has its own AbortController: stopping it
// ends only the follow-up. The write already went before the receipt and is
// never re-decided; before the receipt nothing here is armed, so Esc never
// touches a yes on its way. Pure (no Ink), so every rule is CI-run.
import type { AnswerViewV1 } from "@infinite-os/types";

import { followUpLabel } from "../../desktop/confirm-stream.js";
import type { KeyHint } from "../keys/keymap.js";
import type { Theme } from "../theme.js";
import { renderCommittedTurn } from "../views/layout.js";
import { formatWholeElapsed } from "./status-indicator.js";
import { TURN_STOPPED, type TurnAbort, type TurnStopReason } from "./turn-abort.js";

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
