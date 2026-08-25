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
  turnTrail: []
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
}
