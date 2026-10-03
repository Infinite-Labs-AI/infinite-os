import type { TurnState } from "../app/turn-store.js";

// What a running turn shows outside its Steps and its working line
// (terminal-r4): only the composer's note, `❯ Ask Infinite… (4s)`. The
// transcript's `⠋ Working…` line already says the turn is working, so the note
// carries the time alone and never says the word a second time. The rotating
// faces, verbs and spinners of the old status line are not in r4: what runs
// shows in the Steps strip.

export function isInfiniteTurnBusy(state: TurnState): boolean {
  return Boolean(
    state.tools.length ||
    state.reasoningActive ||
    state.reasoningStreaming ||
    state.streaming.trim() ||
    state.subagents.some((subagent) => subagent.status === "running")
  );
}

/**
 * The composer's note while a turn runs (terminal-r4 `❯ Ask Infinite… (note)`):
 * how long it has run, in whole seconds (`4s`, `2:03`). No start time, no
 * note: the working line already says the turn is working.
 */
export function formatBusyNote({
  nowMs,
  state,
  turnStartedAt
}: {
  nowMs: number;
  state: TurnState;
  turnStartedAt?: number;
}): string {
  const startedAt = turnStartedAt ?? state.tools[0]?.startedAt;
  return startedAt === undefined ? "" : formatWholeElapsed(nowMs - startedAt);
}

/** `4s` under a minute, then `2:03`. */
export function formatWholeElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
