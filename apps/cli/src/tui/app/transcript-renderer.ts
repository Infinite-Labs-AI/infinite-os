// The transcript as terminal lines, in the r4 look (terminal-r4 `frame()`): one
// column at the window's full width, no box and no gutter.
//
//   ❯ the question
//
//   ∞ the answer (markdown; while it streams, a span not closed yet prints
//     as plain words)
//
//   ─ Steps ──────────────────────────────────────────
//     checking your campaigns    ━━━━━━━━━━━━━━   ✓ 3 ads
//
// While a turn runs and has not answered yet, the answer's place holds the
// working line (terminal-r4: a braille spinner and `Working…` in cyan, then
// what the turn says it is doing, dim):
//
//   ⠋ Working…  · checking the catalog
//
// Each turn (a user message and what follows it) ends with its Steps strip:
// one row per tool call, never the raw tool id or its arguments. The live
// turn's strip comes from the turn store's steps (start and end per call);
// a turn known only by its messages lays its trail end to end.
import { renderMarkdown } from "../../formatting/markdown-render.js";
import { renderStatusFooter } from "../../formatting/renderer.js";
import { answerLines, noteLines, questionLines, type ColumnStyle } from "./answer-column.js";
import { ansi, resolveTheme, type AnsiRole, type Theme } from "../theme.js";
import type { Msg, SubagentNode, SubagentProgress, ThinkingMode, TodoItem } from "../types.js";
import type { TurnState, TurnStep } from "./turn-store.js";
import { displayWidth, truncateCells } from "../lib/display-width.js";
import { countPendingTodos, isTodoDone } from "../lib/live-progress.js";
import { buildSubagentTree, formatSubagentSummary, subagentSparkline, treeTotals, widthByDepth } from "../lib/subagent-tree.js";
import { compactPreview, thinkingPreview } from "../lib/text.js";
import { bareToolName, friendlyStepLabel, stepProgressWords, stepsFromTrail, stepStripLines } from "../views/steps.js";

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
  /**
   * The session's own word that a turn is running (from the moment the line is
   * sent, before any frame came back): the working line is drawn at once.
   * Without it, the turn's own progress (a running call, a status) says so.
   */
  busy?: boolean;
  color?: boolean;
  columns?: number;
  nowMs?: number;
  theme?: Theme;
  thinkingMode?: ThinkingMode;
}

interface RenderContext extends ColumnStyle {
  agentTitle?: string;
  busy: boolean;
  columns: number;
  nowMs: number;
  thinkingMode: ThinkingMode;
}

/** The narrowest the transcript draws at; there is no widest (the window decides). */
const MIN_COLUMNS = 20;

export function renderInfiniteTranscript(
  input: InfiniteTranscriptInput,
  options: InfiniteTranscriptOptions = {}
): string {
  const theme = options.theme ?? resolveTheme();
  const ctx: RenderContext = {
    agentTitle: input.agentTitle,
    busy: options.busy ?? false,
    color: options.color ?? false,
    columns: fluidColumns(options.columns ?? 88),
    nowMs: options.nowMs ?? Date.now(),
    theme,
    thinkingMode: options.thinkingMode ?? "truncated"
  };
  const turns = splitTurns(input.messages ?? []);
  const lines: string[] = [];

  turns.forEach((turn, index) => {
    const live = index === turns.length - 1 ? input.state : undefined;
    pushBlock(lines, renderTurn(turn, live, ctx));
  });
  if (!turns.length && input.state) {
    pushBlock(lines, renderTurn([], input.state, ctx));
  }

  if (input.footer?.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(...renderFooterRows(input.footer, ctx));
  }

  return trimBlankEdges(lines).join("\n");
}

/** Messages split into turns: each user message starts one. */
function splitTurns(messages: readonly Msg[]): Msg[][] {
  const turns: Msg[][] = [];
  for (const msg of messages) {
    if (msg.role === "user" || !turns.length) {
      turns.push([]);
    }
    turns.at(-1)!.push(msg);
  }
  return turns;
}

export interface TurnBodyOptions extends ColumnStyle {
  /** The column's width (the whole window in one column, the answer pane when split). */
  columns: number;
  thinkingMode?: ThinkingMode;
}

/**
 * A turn's messages as the answer column draws them, without the Steps strip:
 * the question, the answer with its project label, diffs, and the trail's
 * thinking, todos, subagents and notes. The ONE per-message renderer: the
 * transcript, the live turn beside its views and a turn committed to
 * scrollback all draw through it, so none of them drops what the others show.
 */
export function renderTurnBody(messages: readonly Msg[], options: TurnBodyOptions): string[] {
  return renderMessages(messages, {
    busy: false,
    color: options.color,
    theme: options.theme,
    columns: Math.max(1, Math.floor(options.columns)),
    nowMs: 0,
    thinkingMode: options.thinkingMode ?? "truncated"
  }).lines;
}

/** Messages in order, one blank row between blocks; a new question starts a new answer (its `∞` mark). */
function renderMessages(messages: readonly Msg[], ctx: RenderContext): { lines: string[]; answered: boolean } {
  const lines: string[] = [];
  let answered = false;
  for (const msg of messages) {
    if (msg.role === "user") {
      answered = false;
    }
    const block = renderMessage(msg, ctx, answered);
    answered ||= msg.role === "assistant" && Boolean(msg.text.trim());
    pushBlock(lines, block);
  }
  return { lines, answered };
}

/** One turn: its messages, then (for the live turn) what is arriving, then its Steps. */
function renderTurn(messages: readonly Msg[], state: TurnState | undefined, ctx: RenderContext): string[] {
  const all = state ? [...messages, ...state.streamSegments] : [...messages];
  const { lines, answered } = renderMessages(all, ctx);

  if (state) {
    if (state.reasoning.trim() && !state.streamSegments.some((msg) => msg.thinking?.trim())) {
      pushBlock(lines, renderThinking(state.reasoning, state.reasoningTokens, ctx));
    }
    if (state.todos.length) {
      pushBlock(lines, renderTodos(state.todos, ctx));
    }
    if (state.subagents.length) {
      pushBlock(lines, renderSubagents(state.subagents, ctx));
    }
    if (state.streaming.trim()) {
      pushBlock(lines, answerLines(state.streaming, ctx.columns, ctx, {
        partial: true,
        mark: !answered,
        label: answered ? undefined : agentLabel(ctx.agentTitle, ctx)
      }));
    } else {
      // No answer yet: the working line holds its place, with what the turn
      // says it is doing. A warning or an error keeps its own line and tone.
      const last = state.activity.at(-1);
      const working = !answered && !isBesideTurn(state) && (ctx.busy || turnShowsWork(state));
      if (working) {
        pushBlock(lines, [workingLine(last?.tone === "info" ? last.text : "", ctx)]);
      }
      if (last && !(working && last.tone === "info")) {
        const note = noteLines(`• ${last.text}`, ctx.columns, ctx, last.tone === "error" ? "error" : last.tone === "warn" ? "warning" : "muted");
        if (working) {
          lines.push(...note);
        } else {
          pushBlock(lines, note);
        }
      }
    }
  }

  pushBlock(lines, stepStripLines(turnSteps(all, state, ctx), {
    width: ctx.columns,
    color: ctx.color,
    theme: ctx.theme,
    nowMs: ctx.nowMs,
    views: state?.views.map((frame) => frame.view)
  }));
  return lines;
}

/**
 * The turn's own progress says it is working: a call still running, thinking
 * or a subagent under way, or a status it reported. (A stopped turn's calls
 * are closed, so it does not.)
 */
function turnShowsWork(state: TurnState): boolean {
  return Boolean(
    state.steps.some((step) => step.endedAt === null) ||
    state.reasoningActive ||
    state.reasoningStreaming ||
    state.activity.length ||
    state.subagents.some((subagent) => subagent.status === "running")
  );
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_MS = 80;

/**
 * The working line (terminal-r4 `⠋ Working…`): a braille spinner frame and
 * `Working…` in cyan, then what the turn says it is doing, dim. One row, cut
 * to the width. Every glyph is one column wide.
 */
function workingLine(detail: string, ctx: RenderContext): string {
  const frame = SPINNER[Math.floor(Math.max(0, ctx.nowMs) / SPINNER_MS) % SPINNER.length]!;
  const words = `${frame} Working…`;
  const room = ctx.columns - displayWidth(words);
  const said = compactPreview(detail, 96);
  const tail = said && room > 6 ? truncateCells(`  · ${said}`, room) : "";
  return fit(`${paint(words, "primary", ctx)}${tail ? paint(tail, "muted", ctx) : ""}`, ctx);
}

/**
 * A running turn's messages as its drawn layout shows them (the turn beside
 * its views while it works, r4 "working"): what is already in the transcript,
 * the finished segments, and the answer still arriving (held open: a span not
 * closed yet prints as plain words), labelled with the live project.
 */
export function workingTurnMessages(messages: readonly Msg[], state: TurnState, agentTitle?: string): Msg[] {
  const streaming = state.streaming.trim()
    ? [{ role: "assistant" as const, text: state.streaming, partial: true, ...(agentTitle ? { title: agentTitle } : {}) }]
    : [];
  return [...messages, ...state.streamSegments, ...streaming];
}

/** A running turn's Steps as its drawn layout shows them: a running call's result is its latest progress. */
export function workingTurnSteps(messages: readonly Msg[], state: TurnState, nowMs: number): TurnStep[] {
  return turnSteps(messages, state, { nowMs });
}

/** A turn state for the transcript UNDER a turn drawn with its views: that turn says it is working itself. */
export interface BesideTurnState extends TurnState {
  readonly beside: true;
}

function isBesideTurn(state: TurnState): boolean {
  return (state as Partial<BesideTurnState>).beside === true;
}

/**
 * The turn state the transcript keeps beside a running turn drawn with its
 * views: what the drawn turn already shows (its segments, the answer arriving,
 * its calls and Steps) is taken out, so nothing prints twice; thinking, todos,
 * subagents and the latest activity stay under it.
 */
export function besideWorkingTurn(state: TurnState): BesideTurnState {
  const segmentsThink = state.streamSegments.some((msg) => msg.thinking?.trim());
  return {
    ...state,
    beside: true,
    steps: [],
    streamSegments: [],
    streaming: "",
    streamPendingTools: [],
    tools: [],
    reasoning: segmentsThink ? "" : state.reasoning,
    activity: state.streaming.trim() ? [] : state.activity
  };
}

/**
 * The turn's calls: the turn store's (one per call, with start and end; a
 * running one shows its latest progress as its result) when it has any, else
 * the tool trail laid end to end, with the calls still running after it. A
 * running call says "running" until it reports progress.
 */
function turnSteps(messages: readonly Msg[], state: TurnState | undefined, ctx: Pick<RenderContext, "nowMs">): TurnStep[] {
  if (state?.steps.length) {
    return state.steps.map((step) => {
      if (step.endedAt !== null) {
        return step;
      }
      // Its latest progress when that is words (`1 of 3`); never its arguments or JSON.
      const now = stepProgressWords(state.tools.find((item) => item.id === step.id)?.latestPreview);
      return { ...step, result: now || step.result || viewProgress(step.name, state.views) || "running" };
    });
  }
  const pending: Msg[] = state?.streamPendingTools.length ? [{ kind: "trail", role: "system", text: "", tools: state.streamPendingTools }] : [];
  const done = stepsFromTrail([...messages, ...pending]);
  const end = done.reduce((latest, step) => Math.max(latest, step.endedAt ?? step.startedAt), 0);
  const running: TurnStep[] = (state?.tools ?? []).map((tool) => ({
    id: tool.id,
    name: tool.name,
    label: tool.label ?? friendlyStepLabel(tool.name),
    status: "run",
    startedAt: end,
    endedAt: end + (tool.startedAt === undefined ? 0 : Math.max(0, ctx.nowMs - tool.startedAt)),
    result: stepProgressWords(tool.latestPreview) || "running"
  }));
  return [...done, ...running];
}

/**
 * How far a running call is, from the latest view it drew (matched by bare
 * tool name): an images run's `1 of 3`, a job's `step 3 of 5`. The view's own
 * numbers, read as they are; null when it has none.
 */
function viewProgress(name: string, frames: TurnState["views"]): string | null {
  const bare = bareToolName(name);
  const view = [...frames].reverse().find((frame) => bareToolName(frame.view.tool) === bare)?.view;
  if (!view) return null;
  const body = view.body as unknown as Record<string, unknown>;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
  if (view.kind === "images") {
    const ready = count(body.ready);
    const requested = count(body.requested);
    return ready !== null && requested ? `${ready} of ${requested}` : null;
  }
  if (view.kind === "job") {
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const at = steps.findIndex((item) => typeof item === "object" && item !== null && (item as { state?: unknown }).state === "now");
    if (at >= 0) return `step ${at + 1} of ${steps.length}`;
    const progress = typeof body.progress === "object" && body.progress !== null ? body.progress as Record<string, unknown> : null;
    const finished = count(progress?.finished);
    const of = count(progress?.of);
    return finished !== null && of ? `${finished} of ${of}` : null;
  }
  return null;
}

function renderMessage(msg: Msg, ctx: RenderContext, answered: boolean): string[] {
  if (msg.role === "assistant") {
    if (!msg.text.trim()) {
      return [];
    }
    return answerLines(msg.text, ctx.columns, ctx, {
      partial: msg.partial,
      mark: !answered,
      label: answered ? undefined : agentLabel(msg.title, ctx)
    });
  }

  if (msg.role === "user") {
    return msg.text.trim() ? questionLines(msg.text, ctx.columns, ctx) : [];
  }

  if (msg.kind === "trail") {
    // The trail's tools are the Steps strip; the rest of the trail prints here.
    const lines: string[] = [];
    pushBlock(lines, renderThinking(msg.thinking ?? "", msg.thinkingTokens, ctx));
    if (msg.todos?.length) pushBlock(lines, renderTodos(msg.todos, ctx, msg.todoCollapsedByDefault));
    if (msg.subagents?.length) pushBlock(lines, renderSubagents(msg.subagents, ctx));
    if (msg.text.trim()) pushBlock(lines, noteLines(msg.text, ctx.columns, ctx, "muted", { markdown: true }));
    return lines;
  }

  if (msg.kind === "diff") {
    return renderDiff(msg.text, ctx);
  }

  if (!msg.text.trim()) {
    return [];
  }

  // Tool output is shown as the tool returned it; only model-written text is markdown.
  if (msg.role === "tool") {
    return noteLines(msg.text, ctx.columns, ctx);
  }
  return renderMarkdown(msg.text, { width: Math.max(1, ctx.columns - 2), color: ctx.color, theme: ctx.theme }).map((line) =>
    fit(`  ${line}`, ctx)
  );
}

/** The answering project's label, when it says more than the brand name. */
function agentLabel(title: string | undefined, ctx: RenderContext): string | undefined {
  const label = title?.trim();
  return label && label !== ctx.theme.brand.name ? label : undefined;
}

function renderThinking(reasoning: string, tokens: number | undefined, ctx: RenderContext): string[] {
  const preview = thinkingPreview(reasoning, ctx.thinkingMode);
  if (!preview) {
    return [];
  }
  const tokenLabel = tokens ? ` · ${tokens} tok` : "";
  return [
    fit(paint(`thinking${tokenLabel}`, "muted", ctx), ctx),
    ...renderMarkdown(preview, { width: Math.max(1, ctx.columns - 2), color: false, theme: ctx.theme, plain: true }).map((line) =>
      fit(`  ${paint(line, "muted", ctx)}`, ctx)
    )
  ];
}

function renderTodos(todos: readonly TodoItem[], ctx: RenderContext, collapsed = false): string[] {
  const pending = countPendingTodos(todos);
  const done = isTodoDone(todos);
  const label = done ? "todo complete" : `${pending} todo${pending === 1 ? "" : "s"} left`;

  if (collapsed && done) {
    return [fit(`${paint("✓", "success", ctx)} ${paint(label, "muted", ctx)}`, ctx)];
  }

  return [
    fit(`${paint(done ? "✓" : "◑", done ? "success" : "primary", ctx)} ${paint(label, "muted", ctx)}`, ctx),
    ...todos.map((todo) =>
      fit(`  ${paint(todoMark(todo.status), todoTone(todo.status), ctx)} ${todo.status === "completed" ? paint(todo.content, "muted", ctx) : todo.content}`, ctx)
    )
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
    fit(paint(`◇ subagents ${summary}${spark ? ` ${spark}` : ""}`, totals.activeCount ? "primary" : "muted", ctx), ctx),
    ...tree.slice(0, 16).flatMap((node, index) => renderSubagentNode(node, "", index === tree.length - 1, ctx)),
    ...(tree.length > 16 ? [fit(paint(`  └─ … ${tree.length - 16} more roots`, "muted", ctx), ctx)] : [])
  ];
}

function renderSubagentNode(node: SubagentNode, prefix: string, last: boolean, ctx: RenderContext): string[] {
  const item = node.item;
  const connector = last ? "└─" : "├─";
  const label = compactPreview(item.summary || item.notes[0] || item.id, 56);
  const meta = [
    item.model,
    item.taskCount ? `${item.taskCount} task${item.taskCount === 1 ? "" : "s"}` : undefined,
    node.aggregate.totalTools ? `${node.aggregate.totalTools} tool${node.aggregate.totalTools === 1 ? "" : "s"}` : undefined,
    node.aggregate.totalDuration ? `${Math.round(node.aggregate.totalDuration)}s` : undefined
  ].filter((part): part is string => Boolean(part));
  const { glyph, tone } = subagentStatus(item.status);
  const lines = [
    fit(`${paint(`  ${prefix}${connector}`, "line", ctx)} ${paint(glyph, tone, ctx)} ${label}${meta.length ? paint(` (${meta.join(", ")})`, "muted", ctx) : ""}`, ctx)
  ];

  for (const output of (item.outputTail ?? []).slice(-2)) {
    const outputPrefix = `${prefix}${last ? "  " : "│ "}  `;
    lines.push(fit(paint(`  ${outputPrefix}${output.tool}: ${compactPreview(output.preview, 72)}`, output.isError ? "error" : "muted", ctx), ctx));
  }

  const childPrefix = `${prefix}${last ? "  " : "│ "}`;
  lines.push(...node.children.slice(0, 8).flatMap((child, index) =>
    renderSubagentNode(child, childPrefix, index === node.children.length - 1, ctx)
  ));

  if (node.children.length > 8) {
    lines.push(fit(paint(`  ${childPrefix}└─ … ${node.children.length - 8} more`, "muted", ctx), ctx));
  }

  return lines;
}

function subagentStatus(status: SubagentProgress["status"]): { glyph: string; tone: AnsiRole } {
  if (status === "completed") return { glyph: "✓", tone: "success" };
  if (status === "running") return { glyph: "⠋", tone: "primary" };
  if (status === "queued") return { glyph: "·", tone: "muted" };
  return { glyph: "✗", tone: "error" };
}

function renderDiff(text: string, ctx: RenderContext): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rendered = lines.slice(0, 80).map((line) => renderDiffLine(line, ctx));
  const omitted = lines.length > 80 ? [fit(paint(`  … omitted ${lines.length - 80} diff lines`, "muted", ctx), ctx)] : [];

  return [fit(paint("Δ diff", "primary", ctx), ctx), ...rendered, ...omitted];
}

function renderDiffLine(line: string, ctx: RenderContext): string {
  if (!line) {
    return fit(paint("  │", "line", ctx), ctx);
  }
  const role = diffLineRole(line);
  const prefix = role === "success" ? "  + " : role === "error" ? "  - " : line.startsWith("@@") ? "  @ " : "  │ ";
  const body = line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line;
  return fit(paint(`${prefix}${body}`, role, ctx), ctx);
}

function diffLineRole(line: string): AnsiRole {
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

function paint(text: string, role: AnsiRole, ctx: RenderContext): string {
  return ctx.color && text ? ansi(ctx.theme, role, text) : text;
}

/** Every line fits the window (a last resort: the renderers lay out to the width first). */
function fit(line: string, ctx: RenderContext): string {
  return displayWidth(line) <= ctx.columns ? line : truncateCells(line, ctx.columns);
}

function todoMark(status: TodoItem["status"]): string {
  if (status === "completed") {
    return "✓";
  }
  if (status === "cancelled") {
    return "✕";
  }
  if (status === "in_progress") {
    return "◑";
  }
  return "·";
}

function todoTone(status: TodoItem["status"]): AnsiRole {
  if (status === "completed") {
    return "success";
  }
  if (status === "in_progress") {
    return "primary";
  }
  return "muted";
}

/** Append a block, one blank row after whatever came before it. */
function pushBlock(lines: string[], block: readonly string[]): void {
  if (!block.length) {
    return;
  }
  if (lines.length && lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push(...block);
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

/** The transcript draws at the window's width: no cap (r4 uses the full width; eval M3). */
export function fluidColumns(columns: number): number {
  return Math.max(MIN_COLUMNS, Number.isFinite(columns) ? Math.floor(columns) : 88);
}
