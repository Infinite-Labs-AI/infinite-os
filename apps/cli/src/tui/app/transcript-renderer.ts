import { formatMarkdownForTerminal } from "../../formatting/markdown.js";
import { formatElapsedSeconds } from "../../formatting/progress.js";
import { renderAssistantResponsePanel, renderStatusFooter } from "../../formatting/renderer.js";
import { ansi, resolveTheme, type Theme } from "../theme.js";
import type { ActiveTool, Msg, SubagentNode, SubagentProgress, ThinkingMode, TodoItem } from "../types.js";
import type { TurnState } from "./turn-store.js";
import { displayWidth, truncateCells } from "../lib/display-width.js";
import { countPendingTodos, isTodoDone } from "../lib/live-progress.js";
import { buildSubagentTree, formatSubagentSummary, subagentSparkline, treeTotals, widthByDepth } from "../lib/subagent-tree.js";
import { compactPreview, parseToolTrailResultLine, splitToolDuration, thinkingPreview, toolTrailLabel } from "../lib/text.js";

export interface InfiniteTranscriptInput {
  /**
   * Live agent label for the in-flight answer (the currently active project).
   * Completed messages carry their own frozen `Msg.title` instead.
   */
  agentTitle?: string;
  footer?: readonly string[];
  messages?: readonly Msg[];
  state?: TurnState;
}

export interface InfiniteTranscriptOptions {
  color?: boolean;
  columns?: number;
  nowMs?: number;
  theme?: Theme;
  thinkingMode?: ThinkingMode;
}

interface RenderContext {
  agentTitle?: string;
  color: boolean;
  columns: number;
  contentWidth: number;
  nowMs: number;
  prefix: string;
  theme: Theme;
  thinkingMode: ThinkingMode;
}

type RenderRole = "error" | "muted" | "primary" | "primaryBright" | "success" | "text" | "warning";

export function renderInfiniteTranscript(
  input: InfiniteTranscriptInput,
  options: InfiniteTranscriptOptions = {}
): string {
  const theme = options.theme ?? resolveTheme();
  const columns = clampColumns(options.columns ?? 88);
  const ctx: RenderContext = {
    agentTitle: input.agentTitle,
    color: options.color ?? false,
    columns,
    contentWidth: Math.max(24, Math.min(100, columns - 4)),
    nowMs: options.nowMs ?? Date.now(),
    prefix: theme.brand.tool,
    theme,
    thinkingMode: options.thinkingMode ?? "truncated"
  };
  const lines: string[] = [];

  for (const msg of input.messages ?? []) {
    lines.push(...renderTranscriptMessage(msg, ctx));
  }

  if (input.state) {
    lines.push(...renderTurnState(input.state, ctx));
  }

  if (input.footer?.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(...renderFooterRows(input.footer, ctx));
  }

  return trimBlankEdges(lines).join("\n");
}

function renderTurnState(state: TurnState, ctx: RenderContext): string[] {
  const lines: string[] = [];

  for (const msg of state.streamSegments) {
    lines.push(...renderTranscriptMessage(msg, ctx));
  }

  if (state.reasoning.trim() && !state.streamSegments.some((msg) => msg.thinking?.trim())) {
    lines.push(...renderThinking(state.reasoning, state.reasoningTokens, ctx));
  }

  if (state.streamPendingTools.length) {
    lines.push(...renderToolShelf(state.streamPendingTools, ctx));
  } else if (state.turnTrail.length) {
    lines.push(...renderToolShelf(state.turnTrail, ctx));
  }

  if (state.tools.length) {
    lines.push(...renderActiveTools(state.tools, ctx));
  }

  if (state.todos.length) {
    lines.push(...renderTodos(state.todos, ctx));
  }

  if (state.subagents.length) {
    lines.push(...renderSubagents(state.subagents, ctx));
  }

  if (state.streaming.trim()) {
    lines.push(renderAssistantResponsePanel(state.streaming, {
      color: ctx.color,
      columns: ctx.columns,
      theme: ctx.theme,
      title: ctx.agentTitle
    }));
  }

  if (!state.streaming.trim() && state.activity.length) {
    const last = state.activity.at(-1);
    if (last) {
      lines.push(formatTrailLine(`• ${last.text}`, last.tone === "error" ? "error" : last.tone === "warn" ? "warning" : "muted", ctx));
    }
  }

  return lines;
}

function renderTranscriptMessage(msg: Msg, ctx: RenderContext): string[] {
  if (msg.role === "assistant") {
    return [renderAssistantResponsePanel(msg.text, {
      color: ctx.color,
      columns: ctx.columns,
      theme: ctx.theme,
      title: msg.title
    })];
  }

  if (msg.role === "user") {
    return [formatTrailLine(`${ctx.theme.brand.prompt} ${compactPreview(msg.text, ctx.contentWidth - 2)}`, "primaryBright", ctx)];
  }

  if (msg.kind === "trail") {
    return [
      ...renderThinking(msg.thinking ?? "", msg.thinkingTokens, ctx),
      ...(msg.tools?.length ? renderToolShelf(msg.tools, ctx) : []),
      ...(msg.todos?.length ? renderTodos(msg.todos, ctx, msg.todoCollapsedByDefault) : []),
      ...(msg.subagents?.length ? renderSubagents(msg.subagents, ctx) : []),
      ...(msg.text.trim() ? renderBodyLines(msg.text, "muted", ctx) : [])
    ];
  }

  if (msg.kind === "diff") {
    return renderDiff(msg.text, ctx);
  }

  if (msg.text.trim()) {
    return renderBodyLines(msg.text, msg.role === "tool" ? "muted" : "text", ctx);
  }

  return [];
}

function renderThinking(reasoning: string, tokens: number | undefined, ctx: RenderContext): string[] {
  const preview = thinkingPreview(reasoning, ctx.thinkingMode);

  if (!preview) {
    return [];
  }

  const tokenLabel = tokens ? ` ${tokens} tok` : "";
  return [
    formatTrailLine(`✦ thinking${tokenLabel}`, "primary", ctx),
    ...renderBodyLines(preview, "muted", ctx, "  ")
  ];
}

function renderToolShelf(tools: readonly string[], ctx: RenderContext): string[] {
  if (!tools.length) {
    return [];
  }

  return [
    formatTrailLine(`⚡ tools ${tools.length}`, "primary", ctx),
    ...tools.flatMap((tool) => renderToolTrail(tool, ctx))
  ];
}

function renderActiveTools(tools: readonly ActiveTool[], ctx: RenderContext): string[] {
  return [
    formatTrailLine(`⚡ running ${tools.length}`, "primary", ctx),
    ...tools.flatMap((tool) => renderActiveToolWidget(tool, ctx))
  ];
}

function renderActiveToolWidget(tool: ActiveTool, ctx: RenderContext): string[] {
  const label = toolTrailLabel(tool.name);
  const elapsed = tool.startedAt !== undefined
    ? formatElapsedSeconds(Math.max(0, ctx.nowMs - tool.startedAt))
    : undefined;
  const updateLabel = tool.progressCount
    ? `${tool.progressCount} update${tool.progressCount === 1 ? "" : "s"}`
    : "started";
  const meta = [elapsed, updateLabel, compactPreview(tool.id, 18)].filter(Boolean).join(" · ");
  const lines = [
    formatTrailLine(`  ⚡ ${label}${meta ? ` · ${meta}` : ""}`, "primary", ctx)
  ];

  if (tool.context?.trim()) {
    lines.push(formatTrailLine(`    input ${compactPreview(tool.context, Math.max(12, ctx.contentWidth - 12))}`, "muted", ctx));
  }

  if (tool.latestPreview?.trim() && tool.latestPreview.trim() !== tool.context?.trim()) {
    lines.push(formatTrailLine(`    now   ${compactPreview(tool.latestPreview, Math.max(12, ctx.contentWidth - 12))}`, "primaryBright", ctx));
  }

  return lines;
}

function renderTodos(todos: readonly TodoItem[], ctx: RenderContext, collapsed = false): string[] {
  const pending = countPendingTodos(todos);
  const done = isTodoDone(todos);
  const label = done ? "todo complete" : `${pending} todo${pending === 1 ? "" : "s"} left`;

  if (collapsed && done) {
    return [formatTrailLine(`✓ ${label}`, "success", ctx)];
  }

  return [
    formatTrailLine(`☑ ${label}`, done ? "success" : "primary", ctx),
    ...todos.map((todo) => formatTrailLine(`  ${todoMark(todo.status)} ${todo.content}`, todoTone(todo.status), ctx))
  ];
}

function renderSubagents(subagents: readonly SubagentProgress[], ctx: RenderContext): string[] {
  const tree = buildSubagentTree(subagents);
  if (!tree.length) {
    return [];
  }

  const totals = treeTotals(tree);
  const spark = subagentSparkline(widthByDepth(tree));
  const summary = formatSubagentSummary(totals);

  return [
    formatTrailLine(`◇ subagents ${summary}${spark ? ` ${spark}` : ""}`, totals.activeCount ? "primary" : "muted", ctx),
    ...tree.slice(0, 16).flatMap((node, index) => renderSubagentNode(node, "", index === tree.length - 1, ctx)),
    ...(tree.length > 16 ? [formatTrailLine(`  └─ … ${tree.length - 16} more roots`, "muted", ctx)] : [])
  ];
}

function renderSubagentNode(node: SubagentNode, prefix: string, last: boolean, ctx: RenderContext): string[] {
  const item = node.item;
  const connector = last ? "└─" : "├─";
  const status = subagentStatusGlyph(item.status);
  const label = compactPreview(item.summary || item.notes[0] || item.id, 56);
  const meta = [
    item.model,
    item.taskCount ? `${item.taskCount} task${item.taskCount === 1 ? "" : "s"}` : undefined,
    node.aggregate.totalTools ? `${node.aggregate.totalTools} tool${node.aggregate.totalTools === 1 ? "" : "s"}` : undefined,
    node.aggregate.totalDuration ? `${Math.round(node.aggregate.totalDuration)}s` : undefined
  ].filter((part): part is string => Boolean(part));
  const tone = item.status === "completed"
    ? "success"
    : item.status === "running" || item.status === "queued"
      ? "primary"
      : "error";
  const lines = [
    formatTrailLine(`  ${prefix}${connector} ${status} ${label}${meta.length ? ` (${meta.join(", ")})` : ""}`, tone, ctx)
  ];

  for (const output of (item.outputTail ?? []).slice(-2)) {
    const outputTone = output.isError ? "error" : "muted";
    const outputPrefix = `${prefix}${last ? "  " : "│ "}  `;
    lines.push(formatTrailLine(`  ${outputPrefix}${output.tool}: ${compactPreview(output.preview, 72)}`, outputTone, ctx));
  }

  const childPrefix = `${prefix}${last ? "  " : "│ "}`;
  lines.push(...node.children.slice(0, 8).flatMap((child, index) =>
    renderSubagentNode(child, childPrefix, index === node.children.length - 1, ctx)
  ));

  if (node.children.length > 8) {
    lines.push(formatTrailLine(`  ${childPrefix}└─ … ${node.children.length - 8} more`, "muted", ctx));
  }

  return lines;
}

function subagentStatusGlyph(status: SubagentProgress["status"]): string {
  if (status === "completed") {
    return "✓";
  }
  if (status === "running") {
    return "⚡";
  }
  if (status === "queued") {
    return "…";
  }
  return "✗";
}

function renderDiff(text: string, ctx: RenderContext): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rendered = lines
    .slice(0, 80)
    .flatMap((line) => renderDiffLine(line, ctx));
  const omitted = lines.length > 80 ? [formatTrailLine(`  … omitted ${lines.length - 80} diff lines`, "muted", ctx)] : [];

  return [
    "",
    formatTrailLine("Δ diff", "primary", ctx),
    ...rendered,
    ...omitted,
    ""
  ];
}

function renderDiffLine(line: string, ctx: RenderContext): string[] {
  if (!line) {
    return [formatTrailLine("  │", "muted", ctx)];
  }

  const role = diffLineRole(line);
  const prefix = role === "success"
    ? "  + "
    : role === "error"
      ? "  - "
      : line.startsWith("@@")
        ? "  @ "
        : "  │ ";
  const body = line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line;

  return [formatTrailLine(`${prefix}${body}`, role, ctx)];
}

function diffLineRole(line: string): RenderRole {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "primaryBright";
  }
  if (line.startsWith("+")) {
    return "success";
  }
  if (line.startsWith("-")) {
    return "error";
  }
  if (line.startsWith("@@") || line.startsWith("diff --git")) {
    return "primary";
  }
  return "muted";
}

function renderBodyLines(text: string, role: RenderRole, ctx: RenderContext, indent = ""): string[] {
  return formatMarkdownForTerminal(text, Math.max(16, ctx.contentWidth - displayWidth(indent) - 2))
    .map((line) => formatTrailLine(`${indent}${line}`, role, ctx));
}

function renderFooterRows(parts: readonly string[], ctx: RenderContext): string[] {
  const groups = groupFooterParts(parts, ctx.columns);
  return groups.map((group) => renderStatusFooter(group, {
    color: ctx.color,
    columns: ctx.columns,
    theme: ctx.theme
  }));
}

function groupFooterParts(parts: readonly string[], columns: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];

  for (const part of parts) {
    const candidate = [...current, part];
    if (current.length && displayWidth(candidate.join("  |  ")) > columns) {
      groups.push(current);
      current = [part];
    } else {
      current = candidate;
    }
  }

  if (current.length) {
    groups.push(current);
  }

  return groups;
}

function renderToolTrail(line: string, ctx: RenderContext): string[] {
  const parsed = parseToolTrailResultLine(line);

  if (!parsed) {
    return [formatTrailLine(`  ${line}`, "muted", ctx)];
  }

  const { duration, label } = splitToolDuration(parsed.call);
  const lead = `${parsed.mark} ${label}${duration}`;
  const tone = parsed.mark === "✗" ? "error" : "muted";

  if (!parsed.detail) {
    return [formatTrailLine(`  ${lead}`, tone, ctx)];
  }

  const inline = `  ${lead} · ${parsed.detail}`;
  if (displayWidth(`${ctx.prefix} ${inline}`) <= ctx.columns) {
    return [formatTrailLine(inline, tone, ctx)];
  }

  return [
    formatTrailLine(`  ${lead}`, tone, ctx),
    ...renderBodyLines(parsed.detail, tone, ctx, "    ")
  ];
}

function formatTrailLine(
  text: string,
  role: RenderRole,
  ctx: RenderContext
): string {
  return ansi(ctx.theme, role, truncateCells(`${ctx.prefix} ${text}`, ctx.columns), ctx.color);
}

function todoMark(status: TodoItem["status"]): string {
  if (status === "completed") {
    return "✓";
  }
  if (status === "cancelled") {
    return "×";
  }
  if (status === "in_progress") {
    return "…";
  }
  return "□";
}

function todoTone(status: TodoItem["status"]) {
  if (status === "completed") {
    return "success";
  }
  if (status === "cancelled") {
    return "warning";
  }
  return "muted";
}

function trimBlankEdges(lines: string[]) {
  const next = [...lines];

  while (next[0] === "") {
    next.shift();
  }

  while (next.at(-1) === "") {
    next.pop();
  }

  return next;
}

function clampColumns(columns: number): number {
  return Math.max(40, Math.min(160, Number.isFinite(columns) ? Math.floor(columns) : 88));
}
