import type { ToolViewFrameV1 } from "@infinite-os/types";

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
  views: []
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
  patchTurnState((state) => (state.views.length ? { ...state, views: [] } : state));

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
}
