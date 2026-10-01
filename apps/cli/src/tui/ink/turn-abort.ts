/**
 * Turn control for the interactive session: Esc stops the running turn, and
 * Ctrl-C stops a running turn instead of killing the session (it exits only
 * when no turn is running).
 *
 * Pure and Ink-free so it runs in CI (the PTY-driven Ink tests are CI-skipped).
 * The session owns one instance: `start()` arms a fresh signal per turn and
 * `end(signal)` disarms it when that turn settles. Stopping aborts the signal
 * with a `TURN_STOPPED` reason; the desktop client turns that abort into a
 * dropped `/v1/turn` request, and the bridge stops the app turn on disconnect.
 */

export const TURN_STOPPED = "turn_stopped";

const STOPPED_LINE = "■ Stopped. Anything already running in the app may still finish.";

export type TurnStopReason = "esc" | "ctrl_c";

export interface TurnAbort {
  /** Arm a fresh signal for a new turn. */
  start(): AbortSignal;
  /** Abort the running turn. Returns whether one was running. */
  stop(reason: TurnStopReason): boolean;
  /** Whether a turn is running (started, not stopped, not ended). */
  active(): boolean;
  /** Disarm after the turn settles. Ignores a signal from an older turn. */
  end(signal?: AbortSignal): void;
}

export function createTurnAbort(): TurnAbort {
  let current: AbortController | null = null;
  return {
    start() {
      current = new AbortController();
      return current.signal;
    },
    stop(_reason) {
      const running = current;
      current = null;
      if (!running || running.signal.aborted) {
        return false;
      }
      running.abort(new Error(TURN_STOPPED));
      return true;
    },
    active() {
      return current !== null && !current.signal.aborted;
    },
    end(signal) {
      if (!current) return;
      if (signal && current.signal !== signal) return;
      current = null;
    }
  };
}

/** The stop line for a `TURN_STOPPED` rejection, otherwise `null`. */
export function turnStoppedLine(error: unknown): string | null {
  return error instanceof Error && error.message === TURN_STOPPED ? STOPPED_LINE : null;
}

/** Ctrl-C: stop a running turn, or exit when none is running. */
export function ctrlCAction(turnAbort: TurnAbort): "stopped" | "exit" {
  return turnAbort.stop("ctrl_c") ? "stopped" : "exit";
}

/**
 * One signal that aborts when any input aborts, carrying that input's reason.
 * A local stand-in for `AbortSignal.any`, which needs Node 20.3 while the CLI's
 * engines allow 20.0. `dispose()` detaches from the inputs once the caller is
 * done, so a long-lived (session) input does not collect a listener per turn.
 */
export function linkAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const detach: Array<() => void> = [];
  const dispose = () => {
    for (const off of detach.splice(0)) off();
  };
  for (const input of signals) {
    if (input.aborted) {
      dispose();
      controller.abort(input.reason);
      return { signal: controller.signal, dispose };
    }
    const onAbort = () => {
      dispose();
      controller.abort(input.reason);
    };
    input.addEventListener("abort", onAbort, { once: true });
    detach.push(() => input.removeEventListener("abort", onAbort));
  }
  return { signal: controller.signal, dispose };
}
