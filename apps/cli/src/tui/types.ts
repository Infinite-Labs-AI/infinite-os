export interface ActiveTool {
  context?: string;
  id: string;
  latestPreview?: string;
  name: string;
  progressCount?: number;
  startedAt?: number;
  updatedAt?: number;
}

export interface TodoItem {
  content: string;
  id: string;
  status: "cancelled" | "completed" | "in_progress" | "pending";
}

export interface ActivityItem {
  id: number;
  text: string;
  tone: "error" | "info" | "warn";
}

export type SubagentStatus = "completed" | "error" | "failed" | "interrupted" | "queued" | "running" | "timeout";

export interface SubagentOutputEntry {
  isError: boolean;
  preview: string;
  tool: string;
}

export interface SubagentProgress {
  apiCalls?: number;
  costUsd?: number;
  depth: number;
  durationSeconds?: number;
  filesRead?: string[];
  filesWritten?: string[];
  id: string;
  index: number;
  inputTokens?: number;
  iteration?: number;
  model?: string;
  notes: string[];
  outputTail?: SubagentOutputEntry[];
  outputTokens?: number;
  parentId: null | string;
  reasoningTokens?: number;
  startedAt?: number;
  status: SubagentStatus;
  summary?: string;
  taskCount: number;
  thinking: string[];
  toolCount: number;
  tools: string[];
  toolsets?: string[];
}

export interface SubagentAggregate {
  activeCount: number;
  costUsd: number;
  descendantCount: number;
  filesTouched: number;
  hotness: number;
  inputTokens: number;
  maxDepthFromHere: number;
  outputTokens: number;
  totalDuration: number;
  totalTools: number;
}

export interface SubagentNode {
  aggregate: SubagentAggregate;
  children: SubagentNode[];
  item: SubagentProgress;
}

export interface Msg {
  kind?: "diff" | "intro" | "panel" | "slash" | "trail";
  role: Role;
  text: string;
  /**
   * Per-message agent label (e.g. `Infinite — Acme`), frozen when the message
   * is created so switching projects mid-session never relabels earlier answers.
   */
  title?: string;
  thinking?: string;
  thinkingTokens?: number;
  toolTokens?: number;
  tools?: string[];
  subagents?: SubagentProgress[];
  todos?: TodoItem[];
  todoIncomplete?: boolean;
  todoCollapsedByDefault?: boolean;
}

export type Role = "assistant" | "system" | "tool" | "user";
export type DetailsMode = "hidden" | "collapsed" | "expanded";
export type ThinkingMode = "collapsed" | "truncated" | "full";
export type SectionName = "thinking" | "tools" | "subagents" | "activity";
export type SectionVisibility = Partial<Record<SectionName, DetailsMode>>;
