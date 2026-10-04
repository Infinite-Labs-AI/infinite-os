import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import { scrubTerminalControls } from "../desktop/confirm-in-session.js";
import { formatElapsedSeconds, formatInteractiveProgress } from "./progress.js";
import { turnController } from "../tui/app/turn-controller.js";
import { renderInfiniteAppChrome, type InfiniteAppChromeInput } from "../tui/app/app-chrome.js";
import { clearTurnSteps, getTurnState, subscribeTurnState } from "../tui/app/turn-store.js";
import { LongRunToolCharmTicker } from "../tui/app/long-run-tool-charms.js";
import { canUseInkProgressReporter, InkTranscriptProgressReporter } from "../tui/ink/progress-reporter.js";
import { padEndCells } from "../tui/lib/display-width.js";
import { stepWordsOf } from "../desktop/step-words.js";
import { compactPreview } from "../tui/lib/text.js";
import { friendlyStepLabel, stepProgressWords } from "../tui/views/steps.js";
import { ansi, colorEnabled, resolveTheme, type Theme } from "../tui/theme.js";
import type { Msg } from "../tui/types.js";
import { readMarkdownTableBlock } from "./markdown.js";
import { holdOpenMarkers } from "./markdown-inline.js";
import { renderCodeLines, renderMarkdown } from "./markdown-render.js";

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;
export type AssistantStreamSurface = "none" | "raw" | "transcript";
let assistantStreamSurface: AssistantStreamSurface = "none";

interface ProgressStream {
  columns?: number;
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface InteractiveProgressReporter {
  progress(event: ChatProgressEvent): void;
  stop(): void;
}

interface TranscriptProgressOptions {
  prompt?: InfiniteAppChromeInput["prompt"];
  status?: readonly string[] | (() => readonly string[]);
  theme?: Theme;
  title?: string;
}

export function consumeAssistantStreamSurface(): AssistantStreamSurface {
  const surface = assistantStreamSurface;
  assistantStreamSurface = "none";
  return surface;
}

export function consumeAssistantStreamedOutput(): boolean {
  return consumeAssistantStreamSurface() !== "none";
}

export function createInteractiveProgressReporter(
  stream: ProgressStream,
  options: {
    animate?: boolean;
    now?: () => number;
    renderSurface?: "alternate" | "ink" | "raw" | "transcript";
    theme?: Theme;
    transcript?: TranscriptProgressOptions;
  } = {}
): InteractiveProgressReporter {
  const theme = options.theme ?? resolveTheme();
  // A reporter is one turn: its Steps strip starts empty (the session's turns commit theirs first).
  clearTurnSteps();
  if (options.renderSurface === "ink" && canUseInkProgressReporter(stream)) {
    return new InkTranscriptProgressReporter(stream, {
      ...options.transcript,
      markAssistantStreamed: () => {
        assistantStreamSurface = "transcript";
      },
      now: options.now,
      theme
    });
  }
  if (options.renderSurface === "alternate" || options.renderSurface === "ink") {
    return new AlternateScreenTranscriptReporter(stream, options.now, { ...options.transcript, theme });
  }
  if (options.renderSurface === "transcript") {
    return new TranscriptProgressReporter(stream, options.now, { ...options.transcript, theme });
  }
  const animate = options.animate ?? shouldAnimateProgress(stream);
  if (!animate) {
    const startedAt = options.now?.() ?? Date.now();
    return {
      progress(event) {
        turnController.recordProgressEvent(event);
        if (isMessageProgressEvent(event)) {
          return;
        }
        stream.write(`${formatInteractiveProgress(event, (options.now?.() ?? Date.now()) - startedAt)}\n`);
      },
      stop() {
        turnController.reset();
        // Durable progress mode has no transient row to clear.
      }
    };
  }
  return new RawTerminalProgressReporter(stream, options.now, theme);
}

class TranscriptProgressReporter implements InteractiveProgressReporter {
  private readonly liveFrame?: LiveTranscriptFrame;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly stream: ProgressStream;
  private recordingProgress = false;
  private readonly unsubscribe?: () => void;

  constructor(
    stream: ProgressStream,
    now: (() => number) | undefined,
    transcript: TranscriptProgressOptions | undefined
  ) {
    this.stream = stream;
    this.now = now ?? Date.now;
    this.startedAt = this.now();
    this.liveFrame = stream.isTTY ? new LiveTranscriptFrame(stream, transcript) : undefined;
    this.unsubscribe = this.liveFrame
      ? subscribeTurnState(() => {
        if (!this.recordingProgress) {
          this.liveFrame?.render();
        }
      })
      : undefined;
  }

  progress(event: ChatProgressEvent): void {
    let result: unknown;
    this.recordingProgress = true;
    try {
      result = turnController.recordProgressEvent(event);
    } finally {
      this.recordingProgress = false;
    }
    if (isMessageProgressEvent(event)) {
      if ((event.type === "message.delta" || event.type === "message.complete") && event.text) {
        assistantStreamSurface = "transcript";
      }
      if (event.type === "message.complete" && isMessageCompleteResult(result)) {
        this.liveFrame?.renderMessages(result.finalMessages);
      } else if (event.type !== "message.complete") {
        this.liveFrame?.render();
      }
      return;
    }
    if (this.liveFrame) {
      this.liveFrame.render();
      return;
    }
    this.stream.write(`${formatInteractiveProgress(event, this.now() - this.startedAt)}\n`);
  }

  stop(): void {
    this.unsubscribe?.();
    this.liveFrame?.clear();
    turnController.reset();
  }
}

class LiveTranscriptFrame {
  private readonly stream: ProgressStream;
  private readonly transcript: TranscriptProgressOptions | undefined;
  private lastLineCount = 0;

  constructor(stream: ProgressStream, transcript: TranscriptProgressOptions | undefined) {
    this.stream = stream;
    this.transcript = transcript;
  }

  render(): void {
    this.renderTranscript({ state: getTurnState() });
  }

  renderMessages(messages: readonly Msg[]): void {
    this.renderTranscript({ messages });
  }

  private renderTranscript(transcript: InfiniteAppChromeInput["transcript"]): void {
    const rendered = renderInfiniteAppChrome(
      {
        prompt: this.transcript?.prompt ?? { placeholder: "Thinking, reasoning, or running tools." },
        status: this.status(),
        title: this.transcript?.title,
        transcript
      },
      {
        color: streamColor(this.stream, this.transcript?.theme),
        columns: this.stream.columns,
        theme: this.transcript?.theme
      }
    );

    this.writeFrame(rendered.split("\n"));
  }

  clear(): void {
    if (!this.lastLineCount) {
      return;
    }

    const width = frameWidth(this.stream);
    const blank = " ".repeat(width);
    const lines = Array.from({ length: this.lastLineCount }, () => blank);
    this.stream.write(`${this.rewind()}${lines.join("\n")}${this.rewind()}`);
    this.lastLineCount = 0;
  }

  private status(): readonly string[] {
    const status = this.transcript?.status;
    return typeof status === "function" ? status() : status ?? [];
  }

  private writeFrame(lines: string[]): void {
    const previousCount = this.lastLineCount;
    const width = frameWidth(this.stream);
    const rowCount = Math.max(previousCount, lines.length);
    const padded = Array.from({ length: rowCount }, (_, index) =>
      padEndCells(lines[index] ?? "", width)
    );
    const prefix = previousCount ? this.rewind(previousCount) : "";

    this.stream.write(`${prefix}${padded.join("\n")}`);
    this.lastLineCount = lines.length;
  }

  private rewind(lineCount = this.lastLineCount): string {
    if (lineCount <= 1) {
      return "\r";
    }
    return `\r\x1b[${lineCount - 1}A`;
  }
}

class AlternateScreenTranscriptReporter implements InteractiveProgressReporter {
  private readonly liveFrame?: AlternateScreenTranscriptFrame;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly stream: ProgressStream;
  private recordingProgress = false;
  private readonly unsubscribe?: () => void;

  constructor(
    stream: ProgressStream,
    now: (() => number) | undefined,
    transcript: TranscriptProgressOptions | undefined
  ) {
    this.stream = stream;
    this.now = now ?? Date.now;
    this.startedAt = this.now();
    this.liveFrame = stream.isTTY ? new AlternateScreenTranscriptFrame(stream, transcript) : undefined;
    this.unsubscribe = this.liveFrame
      ? subscribeTurnState(() => {
        if (!this.recordingProgress) {
          this.liveFrame?.render();
        }
      })
      : undefined;
  }

  progress(event: ChatProgressEvent): void {
    let result: unknown;
    this.recordingProgress = true;
    try {
      result = turnController.recordProgressEvent(event);
    } finally {
      this.recordingProgress = false;
    }
    if (isMessageProgressEvent(event)) {
      if ((event.type === "message.delta" || event.type === "message.complete") && event.text) {
        assistantStreamSurface = "transcript";
      }
      if (event.type === "message.complete" && isMessageCompleteResult(result)) {
        this.liveFrame?.renderMessages(result.finalMessages);
      } else if (event.type !== "message.complete") {
        this.liveFrame?.render();
      }
      return;
    }
    if (this.liveFrame) {
      this.liveFrame.render();
      return;
    }
    this.stream.write(`${formatInteractiveProgress(event, this.now() - this.startedAt)}\n`);
  }

  stop(): void {
    this.unsubscribe?.();
    this.liveFrame?.close();
    turnController.reset();
  }
}

class AlternateScreenTranscriptFrame {
  private readonly stream: ProgressStream;
  private readonly transcript: TranscriptProgressOptions | undefined;
  private opened = false;

  constructor(stream: ProgressStream, transcript: TranscriptProgressOptions | undefined) {
    this.stream = stream;
    this.transcript = transcript;
  }

  render(): void {
    this.renderTranscript({ state: getTurnState() });
  }

  renderMessages(messages: readonly Msg[]): void {
    this.renderTranscript({ messages });
  }

  private renderTranscript(transcript: InfiniteAppChromeInput["transcript"]): void {
    this.open();
    const rendered = renderInfiniteAppChrome(
      {
        prompt: this.transcript?.prompt ?? { placeholder: "Thinking, reasoning, or running tools." },
        status: this.status(),
        title: this.transcript?.title,
        transcript
      },
      {
        color: streamColor(this.stream, this.transcript?.theme),
        columns: this.stream.columns,
        theme: this.transcript?.theme
      }
    );
    const width = frameWidth(this.stream);
    const lines = rendered.split("\n").map((line) => padEndCells(line, width));
    this.stream.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
  }

  close(): void {
    if (!this.opened) {
      return;
    }
    this.stream.write("\x1b[?25h\x1b[?1049l");
    this.opened = false;
  }

  private open(): void {
    if (this.opened) {
      return;
    }
    this.stream.write("\x1b[?1049h\x1b[?25l");
    this.opened = true;
  }

  private status(): readonly string[] {
    const status = this.transcript?.status;
    return typeof status === "function" ? status() : status ?? [];
  }
}

/** The live frame uses the whole window (no cap: eval M3). */
function frameWidth(stream: ProgressStream): number {
  return Math.max(20, stream.columns ?? 88);
}

/** Paint only on a terminal, and only what its colour tier paints (NO_COLOR keeps bold; dumb gets none). */
function streamColor(stream: ProgressStream, theme: Theme | undefined): boolean {
  return Boolean(stream.isTTY) && colorEnabled(theme ?? resolveTheme(process.env, stream));
}

export function shouldAnimateProgress(stream: ProgressStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    stream.isTTY &&
    !env.CI &&
    !env.NO_COLOR &&
    env.INFINITE_NO_ANIMATION !== "1" &&
    env.INFINITE_NO_ANIMATION !== "true"
  );
}

class RawTerminalProgressReporter implements InteractiveProgressReporter {
  private readonly now: () => number;
  private readonly stream: ProgressStream;
  private current = "";
  private frameIndex = 0;
  private readonly assistantFrame: StreamingAssistantFrame;
  private readonly longRunCharms = new LongRunToolCharmTicker();
  private lastLineLength = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(stream: ProgressStream, now: (() => number) | undefined, theme: Theme) {
    this.stream = stream;
    this.now = now ?? Date.now;
    this.assistantFrame = new StreamingAssistantFrame(stream, theme);
  }

  progress(event: ChatProgressEvent): void {
    turnController.recordProgressEvent(event);
    if (isMessageProgressEvent(event)) {
      if (event.type === "message.delta") {
        this.clearTransientRow();
        this.assistantFrame.writeDelta(event.text);
        assistantStreamSurface = "raw";
      }
      if (event.type === "message.complete") {
        this.clearTransientRow();
        this.assistantFrame.close();
      }
      return;
    }
    if ("type" in event && event.type === "tool.complete") {
      this.clearTransientRow();
      // `elapsedMs` is unused by the tool.complete branch — that line's timing
      // comes from `event.durationMs`, which an untimed transport omits. Passing
      // 0 states the argument is inert here rather than inventing an elapsed.
      this.stream.write(`${formatInteractiveProgress(event, 0)}\n`);
      return;
    }
    this.current = liveMessage(event);
    if (!this.timer) {
      this.startedAt = this.now();
      this.timer = setInterval(() => this.render(), TICK_MS);
    }
    this.render();
  }

  stop(): void {
    this.clearTransientRow();
    this.assistantFrame.close();
    turnController.reset();
  }

  private clearTransientRow(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearLine();
    this.current = "";
    this.frameIndex = 0;
    this.longRunCharms.reset();
    this.startedAt = 0;
  }

  private render(): void {
    const message = this.liveStateMessage();
    if (!message) {
      return;
    }
    this.longRunCharms.tick(getTurnState().tools, this.now(), turnController);
    const frame = DEFAULT_FRAMES[this.frameIndex % DEFAULT_FRAMES.length];
    const elapsed = formatElapsedSeconds(this.now() - this.startedAt);
    const line = `  ${frame} ${message}  ${elapsed}`;
    const pad = " ".repeat(Math.max(0, this.lastLineLength - line.length));
    this.stream.write(`\r${line}${pad}`);
    this.lastLineLength = line.length;
    this.frameIndex += 1;
  }

  private clearLine(): void {
    if (this.lastLineLength <= 0) {
      return;
    }
    this.stream.write(`\r${" ".repeat(Math.max(this.lastLineLength + 4, 40))}\r`);
    this.lastLineLength = 0;
  }

  private liveStateMessage(): string {
    const state = getTurnState();
    const activeTool = state.tools.at(-1);

    if (activeTool) {
      // The call's own label (the app's words, else generic words), and how far
      // it is only when that reads as words: never the raw tool id or its arguments.
      const label = activeTool.label ?? friendlyStepLabel(activeTool.name);
      const context = stepProgressWords(activeTool.latestPreview ?? activeTool.context);
      return context ? `${label} · ${context}` : label;
    }

    if (state.reasoningStreaming && state.reasoning.trim()) {
      return compactPreview(state.reasoning, 72);
    }

    const activity = state.activity.at(-1)?.text;
    if (activity) {
      return activity;
    }

    const trail = state.turnTrail.at(-1);
    if (trail) {
      return trail;
    }

    return this.current;
  }
}

/**
 * The answer as it streams on the plain one-shot path, in the r4 look: `∞` and
 * the answer's lines hung under it, at the window's width, no box. Each line
 * prints once it is complete, through the markdown renderer (so `**` never
 * shows); a markdown table prints once its block is whole.
 */
class StreamingAssistantFrame {
  private readonly stream: ProgressStream;
  private readonly theme: Theme;
  private opened = false;
  private first = true;
  private readonly color: boolean;
  private readonly contentWidth: number;
  private lineBuffer = "";
  private pendingLines: string[] = [];
  /**
   * The open code fence while a code block streams (null outside one). Each
   * line arrives alone, so markdown cannot see the block: a line inside it
   * prints as code, never through the markdown renderer (which would take a
   * `# comment` for a heading and `__init__` for bold).
   */
  private fence: CodeFence | null = null;

  constructor(stream: ProgressStream, theme: Theme) {
    this.stream = stream;
    this.theme = theme;
    this.color = streamColor(stream, theme);
    // r4 wraps at the width less one, with a two-column prefix.
    this.contentWidth = Math.max(1, frameWidth(stream) - 3);
  }

  writeDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.open();
    for (const char of delta.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
      if (char === "\n") {
        this.completeLine(this.lineBuffer);
        this.lineBuffer = "";
        continue;
      }
      this.lineBuffer += char;
    }
  }

  close(): void {
    if (!this.opened) {
      return;
    }
    if (this.lineBuffer.length > 0) {
      // The answer ended without a newline: its last line may have a span it
      // never closed (code keeps its markers: they are text there).
      this.completeLine(this.fence ? this.lineBuffer : holdOpenMarkers(this.lineBuffer));
      this.lineBuffer = "";
    }
    this.flushPendingLines(true);
    this.opened = false;
    this.first = true;
    this.pendingLines = [];
    this.fence = null;
  }

  private open(): void {
    this.opened = true;
  }

  private completeLine(line: string): void {
    this.pendingLines.push(line);
    this.flushPendingLines(false);
  }

  private flushPendingLines(final: boolean): void {
    while (this.pendingLines.length > 0) {
      const next = this.pendingLines[0]!;
      if (this.fence) {
        // Inside a code block: the closing fence ends it; every other line is code.
        if (closesFence(next, this.fence)) {
          this.fence = null;
        } else {
          this.writeCodeLine(next);
        }
        this.pendingLines.shift();
        continue;
      }
      const opened = openingFence(next);
      if (opened) {
        this.fence = opened;
        this.pendingLines.shift();
        continue;
      }
      const block = readMarkdownTableBlock(this.pendingLines, { final });
      if (block === "hold") {
        return;
      }
      if (block) {
        // The whole table at once, through the answer's own table (r4 renderTable).
        const table = block.rawLines.map(scrubTerminalControls).join("\n");
        this.writeRendered(renderMarkdown(table, { width: this.contentWidth, color: this.color, theme: this.theme }));
        this.pendingLines.splice(0, block.rawCount);
        continue;
      }
      this.writeContentLine(this.pendingLines.shift() ?? "", true);
    }
  }

  /** One line of a code block, drawn as the answer draws code (cyan, indented, wrapped with ↩). */
  private writeCodeLine(line: string): void {
    this.writeRendered(renderCodeLines([line], { width: this.contentWidth, color: this.color, theme: this.theme }));
  }

  private writeContentLine(line: string, markdown: boolean): void {
    // Model text goes straight to the TTY: strip control and bidi characters first.
    const clean = scrubTerminalControls(line);
    const rendered = markdown && clean.trim()
      ? renderMarkdown(clean, { width: this.contentWidth, color: this.color, theme: this.theme })
      : [clean];
    this.writeRendered(rendered);
  }

  private writeRendered(rendered: readonly string[]): void {
    for (const text of rendered) {
      const prefix = this.first && text.trim() ? `${ansi(this.theme, "primary", "∞", this.color)} ` : "  ";
      if (text.trim()) {
        this.first = false;
      }
      this.stream.write(`${prefix}${text}`.trimEnd());
      this.stream.write("\n");
    }
  }
}

interface CodeFence {
  char: "`" | "~";
  size: number;
}

/** A line that opens a fenced code block (CommonMark: 3+ backticks or tildes, up to 3 spaces in). */
function openingFence(line: string): CodeFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  if (!match) {
    return null;
  }
  const run = match[1]!;
  // A backtick fence's info string has no backtick (else it is inline code).
  if (run[0] === "`" && line.slice(match[0].length).includes("`")) {
    return null;
  }
  return { char: run[0] as CodeFence["char"], size: run.length };
}

/** A line that closes `fence`: the same character, at least as many, nothing after but spaces. */
function closesFence(line: string, fence: CodeFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line);
  return Boolean(match && match[1]![0] === fence.char && match[1]!.length >= fence.size);
}

function isMessageProgressEvent(event: ChatProgressEvent): event is Extract<ChatProgressEvent, { type: `message.${string}` }> {
  return "type" in event && event.type.startsWith("message.");
}

function isMessageCompleteResult(value: unknown): value is { finalMessages: readonly Msg[]; finalText: string } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { finalMessages?: unknown }).finalMessages));
}

function liveMessage(event: ChatProgressEvent): string {
  if ("type" in event) {
    if (event.type === "tool.generating") {
      // The step's own words (run-2 M6), never `drafting <tool words>`.
      return stepWordsOf(event)?.label ?? friendlyStepLabel(event.name);
    }
    if (event.type === "tool.start") {
      return stepWordsOf(event)?.label ?? (stepProgressWords(event.context) || friendlyStepLabel(event.name));
    }
    if (event.type === "tool.progress") {
      return stepProgressWords(event.preview) || friendlyStepLabel(event.name);
    }
    if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
      return event.text.replace(/\s+/g, " ").trim() || "thinking";
    }
    if (event.type === "subagent.start" || event.type === "subagent.progress" || event.type === "subagent.complete") {
      return event.subagent.summary || event.message;
    }
    return event.message;
  }
  return event.message.replace(/\.$/, "");
}
