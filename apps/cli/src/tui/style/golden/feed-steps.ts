// R2's feed (Steps): how a fixture's steps reach the session — finished steps
// as the tool trail, running steps (r4 `run`, `bg`) as active tools.
//
// OWNED BY R2. When R2 carries start/end on the trail (instead of durations,
// spec T4) or moves where human step labels come from, it edits THIS file, not
// screen.ts.
import { patchTurnState } from "../../app/turn-store.js";
import { buildToolTrailLine } from "../../lib/text.js";
import type { Msg } from "../../types.js";
import type { R4Step, R4Turn } from "./fixtures.js";

/** Steps still running when the screen is drawn (r4 `run` and `bg`). */
export const RUNNING: ReadonlySet<R4Step["status"]> = new Set(["run", "bg"]);
/** Steps that ended badly: the trail marks them ✗. */
const FAILED: ReadonlySet<R4Step["status"]> = new Set(["fail"]);

/** The trail line one finished step leaves (today the trail carries durations, not start/end: spec T4). */
export function trailLine(step: R4Step): string {
  return buildToolTrailLine(step.label, "", FAILED.has(step.status), step.result, Math.max(0, step.end - step.start));
}

/** The messages the session holds for a fixture's turn: the question, the finished steps as the tool trail, the answer. */
export function turnMessages(turn: R4Turn): Msg[] {
  const trail = turn.steps.filter((step) => !RUNNING.has(step.status)).map(trailLine);
  return [
    { role: "user", text: turn.question },
    ...(trail.length ? [{ kind: "trail" as const, role: "system" as const, text: "", tools: trail }] : []),
    { role: "assistant", text: turn.answer }
  ];
}

/** Running steps become the turn store's active tools, started as long ago as the step has run. */
export function feedRunningSteps(turn: R4Turn, now: number): void {
  const running = turn.steps.filter((step) => RUNNING.has(step.status));
  if (!running.length) return;
  patchTurnState((state) => ({
    ...state,
    tools: running.map((step, index) => ({
      id: `r4_tool_${index}`,
      name: step.label,
      startedAt: now - Math.round((step.end - step.start) * 1000)
    }))
  }));
}
