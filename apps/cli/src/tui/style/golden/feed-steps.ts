// The Steps feed: how a fixture's steps reach the session — as the bridge
// frames a desktop sends for them, through the REAL path: each call is a
// `tool.start` and a `tool.complete` (or, still running, a `tool.progress`)
// carrying the app's words (`step.words.v1`: the step's label, and its result
// on the complete frame), handed to a turn controller on the turn's own clock
// (so the Gantt is exact, spec T4). What the strip then draws is what the
// session draws for a live turn: label and result from the frames' words,
// status from the frame's status, one row per call id.
//
// A step's status reaches the session the way it would live:
//   - a call still running (r4 `run`) has started and reported its progress
//     ("1 of 3"), and has not completed;
//   - ok and fail are what the call itself said (`ok`, `error`);
//   - a call waiting for the person's OK says so itself, as the bridge does
//     (`requires_confirmation` → ▣), named after its card's tool when the turn
//     holds that card, so the row then follows the card;
//   - every other status is what the VIEW the call drew says (partial → ◐,
//     outdated → ⧗, …) when exactly one view of the turn stands for it: the
//     call is named after that view's tool and completes `ok`, and the session
//     derives the status from the view (`refineStepStatus`);
//   - with no such view, the call says it itself, as the transport does:
//     `unsupported` → ·, `low_coverage` → ◐, `queued` → ⟳;
//   - `unk` and `old` have no transport status (the first is a turn that ended
//     without the call's result, the second only a view says): with no view
//     standing for them the row's status is written to the turn store directly.
//
// The tool name on a frame with no view is a raw id on purpose
// (`mcp__r4__step_0`), so a golden that matches proves the label came from the
// frame's words, never from the name.
import { stepWordsOf } from "../../../desktop/step-words.js";
import { InfiniteTurnController } from "../../app/turn-controller.js";
import { patchTurnState, type StepStatus } from "../../app/turn-store.js";
import type { Msg } from "../../types.js";
import { stepStatusForView } from "../../views/steps.js";
import type { R4Step, R4Turn } from "./fixtures.js";

/** Steps still running when the screen is drawn (r4 `run`). */
export const RUNNING: ReadonlySet<R4Step["status"]> = new Set(["run"]);

/** The transport status a call reports for each r4 status it can say itself. */
const FRAME_STATUS: Partial<Record<R4Step["status"], string>> = {
  ok: "ok",
  fail: "error",
  wait: "requires_confirmation",
  off: "unsupported",
  part: "low_coverage",
  bg: "queued"
};

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

interface FeedEvent {
  at: number;
  /** At one instant: in step order, a start before its own complete. */
  order: number;
  run(): void;
}

/** The turn's calls as bridge frames into a turn controller, on a clock that ends now. */
export function feedSteps(turn: R4Turn, now: number): void {
  if (!turn.steps.length) return;
  const span = Math.max(...turn.steps.map((step) => step.end));
  const at = (seconds: number) => now - Math.round((span - seconds) * 1000);
  let clock = now;
  const controller = new InfiniteTurnController(() => clock);
  const events: FeedEvent[] = [];
  const direct: { id: string; status: StepStatus }[] = [];

  turn.steps.forEach((step, index) => {
    const toolId = `r4_step_${index}`;
    const running = RUNNING.has(step.status);
    const own = step.status === "ok" || step.status === "fail";
    const view = own || running ? null : viewFor(turn, step.status);
    // A raw tool id: the row's label must come from the frame's words.
    const name = view ? view.tool : `mcp__r4__step_${index}`;
    const frame = { stage: "tool" as const, message: name, toolId, name };
    events.push({
      at: at(step.start),
      order: index * 2,
      run: () => controller.recordProgressEvent(worded({ ...frame, type: "tool.start", context: "{\"step\":true}", words: { label: step.label } }))
    });
    if (running) {
      // Still running: its latest progress is its result so far.
      if (step.result) {
        events.push({
          at: at(step.start),
          order: index * 2 + 1,
          run: () => controller.recordProgressEvent({ ...frame, type: "tool.progress", preview: step.result })
        });
      }
      return;
    }
    // A proposal's step says it waits itself (as the bridge does), with or without its card's view.
    const status = step.status === "wait" ? FRAME_STATUS.wait : view ? "ok" : FRAME_STATUS[step.status];
    if (status === undefined) {
      direct.push({ id: toolId, status: step.status });
    }
    events.push({
      at: at(step.end),
      order: index * 2 + 1,
      run: () => controller.recordProgressEvent(worded({
        ...frame, type: "tool.complete", status: status ?? "ok", words: { label: step.label, ...(step.result ? { result: step.result } : {}) }
      }))
    });
  });

  for (const event of events.sort((a, b) => a.at - b.at || a.order - b.order)) {
    clock = event.at;
    event.run();
  }
  clock = now;
  if (direct.length) {
    patchTurnState((state) => ({
      ...state,
      steps: state.steps.map((step) => {
        const said = direct.find((item) => item.id === step.id);
        return said ? { ...step, status: said.status } : step;
      })
    }));
  }
  // A finished turn's controller is reset when its answer commits (its steps
  // stay with the turn); a turn still running keeps its live state.
  if (!turn.steps.some((step) => RUNNING.has(step.status))) {
    controller.reset();
  }
}

/** A frame as the turn source hands it on: its words decoded (the turn negotiated step.words.v1). */
function worded<T extends { words: unknown }>(frame: T): never {
  const words = stepWordsOf(frame);
  if (!words) {
    throw new Error(`r4 fixture step words do not decode: ${JSON.stringify(frame.words)}`);
  }
  return { ...frame, words } as never;
}

/** screen.ts (no lane edits it) calls the feed by its first name. */
export { feedSteps as feedRunningSteps };
