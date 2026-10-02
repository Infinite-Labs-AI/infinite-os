import type { CreativeDraftFrameV1, ToolViewFrameV1 } from "@infinite-os/types";

import { isTodoDone } from "../lib/live-progress.js";
import type { ActiveTool, ActivityItem, Msg, SubagentProgress, TodoItem } from "../types.js";

const buildTurnState = (): TurnState => ({
  activity: [],
  outcome: "",
  reasoning: "",
  reasoningActive: false,
  reasoningStreaming: false,
  subagents: [],
  reasoningTokens: 0,
  streamPendingTools: [],
  streamSegments: [],
  streaming: "",
  todoCollapsed: false,
  todos: [],
  toolTokens: 0,
  tools: [],
  turnTrail: [],
  views: [],
  drafts: [],
  steps: []
});

let turnState = buildTurnState();
const listeners = new Set<() => void>();

export const getTurnState = () => turnState;

export const subscribeTurnState = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const setTurnState = (next: TurnState) => {
  turnState = next;

  for (const listener of listeners) {
    listener();
  }
};

export const patchTurnState = (next: Partial<TurnState> | ((state: TurnState) => TurnState)) =>
  setTurnState(typeof next === "function" ? next(turnState) : { ...turnState, ...next });

export const toggleTodoCollapsed = () => patchTurnState((state) => ({ ...state, todoCollapsed: !state.todoCollapsed }));

export const archiveDoneTodos = () => archiveTodosAtTurnEnd();

export const archiveTodosAtTurnEnd = () => {
  const state = getTurnState();

  if (!state.todos.length) {
    return [];
  }

  const done = isTodoDone(state.todos);

  const msg: Msg = {
    kind: "trail",
    role: "system",
    text: "",
    todos: state.todos,
    ...(done ? { todoCollapsedByDefault: true } : { todoIncomplete: true })
  };

  patchTurnState({ todoCollapsed: false, todos: [] });

  return [msg];
};

export const resetTurnState = () => setTurnState(buildTurnState());

/** The most views one turn keeps; the bridge already caps a turn's view bytes, this caps the count. */
export const MAX_TURN_VIEWS = 64;

/**
 * Record a `tool.view` frame for the latest turn. A frame with a known `viewId`
 * replaces that view in place (a job updating); a new one is appended, up to
 * `MAX_TURN_VIEWS`. The turn controller's per-turn reset leaves views alone:
 * they stay with the latest turn until the next line is submitted, then
 * `clearTurnViews()` runs as the turn commits to scrollback.
 */
export const recordTurnView = (frame: ToolViewFrameV1) =>
  patchTurnState((state) => {
    const index = state.views.findIndex((view) => view.viewId === frame.viewId);
    if (index >= 0) {
      const views = state.views.slice();
      views[index] = frame;
      return { ...state, views };
    }
    return state.views.length >= MAX_TURN_VIEWS ? state : { ...state, views: [...state.views, frame] };
  });

export const clearTurnViews = () =>
  patchTurnState((state) =>
    state.views.length || state.drafts.length || state.steps.length ? { ...state, views: [], drafts: [], steps: [] } : state
  );

/**
 * A step's status, r4's Steps glyphs (terminal-r4 `frame()`): `ok` ✓, `wait` ▣
 * (waiting for the user's OK), `run` ⠋, `fail` ✗, `unk` ? (no outcome came
 * back), `off` · (nothing to do), `bg` ⟳ (left running in the background),
 * `part` ◐, `old` ⧗, and `stopped` (the user stopped the turn while it ran).
 */
export type StepStatus = "ok" | "wait" | "run" | "fail" | "unk" | "off" | "bg" | "part" | "old" | "stopped";

/** One tool call of the latest turn, for the Steps strip: one per call, with when it ran. */
export interface TurnStep {
  /** The call's id (one row per call, even when a tool is called twice). */
  id: string;
  /** The tool's name as the transport sent it (`get_report`, `mcp__app__get_report`). */
  name: string;
  /** What the row says. */
  label: string;
  status: StepStatus;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; null while it runs. */
  endedAt: number | null;
  /** The call's one-line result, scrubbed ("" when none came back). */
  result: string;
}

/** The most steps one turn keeps. */
export const MAX_TURN_STEPS = 64;

/**
 * Start a step (a `tool.start`). A call id already known keeps its row and
 * restarts it; new ids append, up to `MAX_TURN_STEPS`. Steps stay with the
 * latest turn until it commits (`clearTurnViews`), like its views.
 */
export const recordStepStart = (step: Omit<TurnStep, "status" | "endedAt" | "result">) =>
  patchTurnState((state) => {
    const next: TurnStep = { ...step, status: "run", endedAt: null, result: "" };
    const index = state.steps.findIndex((item) => item.id === step.id);
    if (index >= 0) {
      const steps = state.steps.slice();
      steps[index] = next;
      return { ...state, steps };
    }
    return state.steps.length >= MAX_TURN_STEPS ? state : { ...state, steps: [...state.steps, next] };
  });

/**
 * End a step (a `tool.complete`). A completion with no start seen first gets
 * its own row, started `durationMs` before it ended.
 */
export const recordStepEnd = (end: {
  id: string;
  name: string;
  label: string;
  status: StepStatus;
  result: string;
  endedAt: number;
  durationMs?: number;
}) =>
  patchTurnState((state) => {
    // The call's own row, even one a stop or the turn's end already closed: a late result still lands on it.
    let index = state.steps.length - 1;
    while (index >= 0 && state.steps[index]!.id !== end.id) index -= 1;
    if (index >= 0) {
      const steps = state.steps.slice();
      steps[index] = { ...steps[index]!, status: end.status, result: end.result, endedAt: end.endedAt };
      return { ...state, steps };
    }
    if (state.steps.length >= MAX_TURN_STEPS) {
      return state;
    }
    const startedAt = end.endedAt - Math.max(0, end.durationMs ?? 0);
    return {
      ...state,
      steps: [...state.steps, { id: end.id, name: end.name, label: end.label, status: end.status, result: end.result, startedAt, endedAt: end.endedAt }]
    };
  });

/** Close every step still running with `status` (a stop, or a turn that ended without the call's result), saying so. */
export const closeRunningSteps = (status: StepStatus, at: number) =>
  patchTurnState((state) =>
    state.steps.some((step) => step.endedAt === null)
      ? {
          ...state,
          steps: state.steps.map((step) =>
            step.endedAt === null ? { ...step, status, endedAt: at, result: status === "stopped" ? "stopped" : "no result came back" } : step
          )
        }
      : state
  );

/** The most image-draft runs one turn tracks. */
export const MAX_TURN_DRAFTS = 8;

/**
 * Record a `creative.draft` frame for the latest turn: one entry per `runId`,
 * the newest frame of a run replacing the last. Cleared with the views when
 * the turn commits (`clearTurnViews`).
 */
export const recordCreativeDraft = (frame: CreativeDraftFrameV1) =>
  patchTurnState((state) => {
    const index = state.drafts.findIndex((draft) => draft.runId === frame.runId);
    if (index >= 0) {
      const drafts = state.drafts.slice();
      drafts[index] = frame;
      return { ...state, drafts };
    }
    return state.drafts.length >= MAX_TURN_DRAFTS ? state : { ...state, drafts: [...state.drafts, frame] };
  });

export interface TurnState {
  activity: ActivityItem[];
  outcome: string;
  reasoning: string;
  reasoningActive: boolean;
  reasoningStreaming: boolean;
  subagents: SubagentProgress[];
  reasoningTokens: number;
  streamPendingTools: string[];
  streamSegments: Msg[];
  streaming: string;
  todoCollapsed: boolean;
  todos: TodoItem[];
  toolTokens: number;
  tools: ActiveTool[];
  turnTrail: string[];
  /** The latest turn's answer views (`tool.view` frames), in arrival order. */
  views: readonly ToolViewFrameV1[];
  /** The latest turn's image drafts in progress (`creative.draft` frames), one per run. */
  drafts: readonly CreativeDraftFrameV1[];
  /** The latest turn's tool calls for the Steps strip, one per call, with start and end (r4 Gantt). */
  steps: readonly TurnStep[];
}
