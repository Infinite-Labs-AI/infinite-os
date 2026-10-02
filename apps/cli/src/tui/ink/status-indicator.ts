import type { TurnState } from "../app/turn-store.js";

// What a running turn shows outside its Steps (terminal-r4): only the
// composer's note, `❯ Ask Infinite… (working · 4s)`. The rotating faces,
// verbs and spinners of the old status line are not in r4: what runs shows
// in the Steps strip.

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
 * that it is working, and for how long in whole seconds (`working · 4s`,
 * `working · 2:03`).
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
  return startedAt === undefined ? "working" : `working · ${formatWholeElapsed(nowMs - startedAt)}`;
}

/** `4s` under a minute, then `2:03`. */
export function formatWholeElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
