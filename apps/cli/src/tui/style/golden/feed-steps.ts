// R2's feed (Steps): how a fixture's steps reach the session — as the turn
// store's calls, one per call, with their start and end on the turn's clock
// (the Gantt is exact, spec T4), the way `tool.start` / `tool.complete`
// frames record them (turn-controller.ts `recordStepStart` / `recordStepEnd`).
//
// A step's status reaches the store the way it would live:
//   - a call still running (r4 `run`) is running, and an active tool whose
//     latest progress is the step's result ("1 of 3");
//   - ok and fail are what the call itself said;
//   - every other status (wait, unk, off, part, old, bg) is what the VIEW
//     the call drew says (needs_yes → ▣, outdated → ⧗, …): the call is named
//     after that view's tool and ended ok, so the session derives the status
//     from the view (`refineStepStatus`). When no view of the turn stands for
//     it, the call says it itself, as a transport status would
//     (`requires_confirmation` → ▣, `queued` → ⟳, …).
//
// OWNED BY R2. When R2 moves where step labels or times come from, it edits
// THIS file, not screen.ts.
import { patchTurnState, type TurnStep } from "../../app/turn-store.js";
import type { Msg } from "../../types.js";
import { stepStatusForView } from "../../views/steps.js";
import type { R4Step, R4Turn } from "./fixtures.js";

/** Steps still running when the screen is drawn (r4 `run`). */
export const RUNNING: ReadonlySet<R4Step["status"]> = new Set(["run"]);

/** The messages the session holds for a fixture's turn: the question and the answer (the calls are in the turn store). */
export function turnMessages(turn: R4Turn): Msg[] {
  return [
    { role: "user", text: turn.question },
    { role: "assistant", text: turn.answer }
  ];
}

/** The one view of the turn whose state stands for `status`, if exactly one does. */
function viewFor(turn: R4Turn, status: R4Step["status"]) {
  const matches = turn.views.filter((view) => stepStatusForView(view) === status);
  return matches.length === 1 ? matches[0]! : null;
}

/** The turn's calls into the turn store (and its running calls as active tools), on a clock that ends now. */
export function feedSteps(turn: R4Turn, now: number): void {
  if (!turn.steps.length) return;
  const span = Math.max(...turn.steps.map((step) => step.end));
  const at = (seconds: number) => now - Math.round((span - seconds) * 1000);
  const steps: TurnStep[] = turn.steps.map((step, index) => {
    const id = `r4_step_${index}`;
    if (RUNNING.has(step.status)) {
      return { id, name: step.label, label: step.label, status: "run", startedAt: at(step.start), endedAt: null, result: "" };
    }
    const own = step.status === "ok" || step.status === "fail";
    const view = own ? null : viewFor(turn, step.status);
    return {
      id,
      name: view ? view.tool : step.label,
      label: step.label,
      status: own ? step.status : view ? "ok" : step.status,
      startedAt: at(step.start),
      endedAt: at(step.end),
      result: step.result
    };
  });
  const running = turn.steps.flatMap((step, index) => (RUNNING.has(step.status) ? [{ step, index }] : []));
  patchTurnState((state) => ({
    ...state,
    steps,
    tools: running.map(({ step, index }) => ({
      id: `r4_step_${index}`,
      name: step.label,
      startedAt: at(step.start),
      latestPreview: step.result
    }))
  }));
}

/** screen.ts (no lane edits it) calls the feed by its first name. */
export { feedSteps as feedRunningSteps };
