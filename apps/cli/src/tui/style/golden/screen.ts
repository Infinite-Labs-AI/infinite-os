// THE SEAM between an r4 fixture and the real CLI: draw one screen exactly the
// way the interactive session draws it, and return the ANSI it prints.
//
// It renders the REAL session (`renderInkInteractiveSessionToString`, the same
// React tree `infinite` mounts), fed the way a turn feeds it: the turn store gets
// the views (`recordTurnView`), a waiting approval becomes a write card
// (`initialPendingConfirmations`), the steps become the tool trail, a running
// step is an active tool, and the boot screen gets the home inventory the entry
// point builds (`homeInventoryData`). So every byte compared is a byte the
// session prints, through the Ink bridge (`AnsiLine`) included.
//
// When a restyle lane changes HOW the session is fed (R1: the top bar's
// workspace and connections, the busy composer note; R2: step start/end on the
// trail instead of durations), it updates this file in the same PR, so the
// goldens keep measuring the session and not a re-implementation of it.
import type { ToolViewFrameV1 } from "@infinite-os/types";

import type { InSessionConfirmationAction } from "../../../desktop/confirm-in-session.js";
import { patchTurnState, recordTurnView, resetTurnState } from "../../app/turn-store.js";
import { renderInkInteractiveSessionToString, type HomeInventoryData } from "../../ink/interactive-session.js";
import { buildToolTrailLine } from "../../lib/text.js";
import type { Msg } from "../../types.js";
import type { R4ScreenFixture, R4Step } from "./fixtures.js";

/** Steps still running when the screen is drawn (r4 `run` and `bg`). */
const RUNNING: ReadonlySet<R4Step["status"]> = new Set(["run", "bg"]);
/** Steps that ended badly: the trail marks them ✗. */
const FAILED: ReadonlySet<R4Step["status"]> = new Set(["fail"]);

export interface ScreenOptions {
  cols: number;
  /** Fixed wall clock for the render (ms). */
  now: number;
  /** The entry point's home inventory builder (`index.ts` `homeInventoryData`), injected so this module stays light. */
  homeInventory: (workspace: string | undefined, connections: HomeInventoryData["connections"]) => HomeInventoryData;
}

/** The trail line one finished step leaves (today the trail carries durations, not start/end: spec T4). */
function trailLine(step: R4Step): string {
  return buildToolTrailLine(step.label, "", FAILED.has(step.status), step.result, Math.max(0, step.end - step.start));
}

export function renderR4Screen(fixture: R4ScreenFixture, options: ScreenOptions): string {
  resetTurnState();
  const connections = fixture.session.connections.map((connection) => ({
    label: connection.name,
    ...(connection.status === "connected" ? {} : { degraded: true })
  }));
  const turn = fixture.turn;
  if (!turn) {
    return renderInkInteractiveSessionToString({
      columns: options.cols,
      homeInventory: options.homeInventory(fixture.session.workspace, connections),
      onSubmitLine: async () => ({ messages: [] }),
      promptPlaceholder: "Type a message, /help, or /exit."
    });
  }

  const pending: InSessionConfirmationAction[] = [];
  turn.views.forEach((view, index) => {
    if (index === turn.pending && view.approval?.kind === "card") {
      pending.push({
        turnId: view.approval.turnId ?? "turn_r4",
        confirmationHandle: view.approval.handle ?? `h_r4_${index}`,
        summary: view.approval.title,
        confirmationDetails: view.approval.rows,
        confirmFieldsCapable: true,
        view
      });
      return;
    }
    const frame: ToolViewFrameV1 = { type: "tool.view", stage: "tool", message: view.title, viewId: `r4_${index}`, name: view.tool, view };
    recordTurnView(frame);
  });

  const running = turn.steps.filter((step) => RUNNING.has(step.status));
  if (running.length) {
    patchTurnState((state) => ({
      ...state,
      tools: running.map((step, index) => ({
        id: `r4_tool_${index}`,
        name: step.label,
        startedAt: options.now - Math.round((step.end - step.start) * 1000)
      }))
    }));
  }

  const trail = turn.steps.filter((step) => !RUNNING.has(step.status)).map(trailLine);
  const messages: Msg[] = [
    { role: "user", text: turn.question },
    ...(trail.length ? [{ kind: "trail" as const, role: "system" as const, text: "", tools: trail }] : []),
    { role: "assistant", text: turn.answer }
  ];
  return renderInkInteractiveSessionToString({
    columns: options.cols,
    initialMessages: messages,
    initialPendingConfirmations: pending,
    onSubmitLine: async () => ({ messages: [] }),
    promptPlaceholder: "Type a message, /help, or /exit."
  });
}
