import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import { formatElapsedSeconds, formatInteractiveProgress } from "./progress.js";
import { turnController } from "../tui/app/turn-controller.js";
import { renderInfiniteAppChrome, type InfiniteAppChromeInput } from "../tui/app/app-chrome.js";
import { getTurnState, subscribeTurnState } from "../tui/app/turn-store.js";
import { LongRunToolCharmTicker } from "../tui/app/long-run-tool-charms.js";
import { canUseInkProgressReporter, InkTranscriptProgressReporter } from "../tui/ink/progress-reporter.js";
import { padEndCells } from "../tui/lib/display-width.js";
import { compactPreview, toolTrailLabel } from "../tui/lib/text.js";
import { ansi, resolveTheme, type Theme } from "../tui/theme.js";
import type { Msg } from "../tui/types.js";
import { readMarkdownTableBlock, renderMarkdownTableBlock } from "./markdown.js";

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
        color: Boolean(this.stream.isTTY && !process.env.NO_COLOR),
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
        color: Boolean(this.stream.isTTY && !process.env.NO_COLOR),
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

function frameWidth(stream: ProgressStream): number {
  return Math.max(40, Math.min(160, stream.columns ?? 88));
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
      this.stream.write(`${formatInteractiveProgress(event, event.durationMs)}\n`);
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
      const label = toolTrailLabel(activeTool.name);
      const context = compactPreview(activeTool.latestPreview ?? activeTool.context ?? "", 72);
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

class StreamingAssistantFrame {
  private readonly stream: ProgressStream;
  private readonly theme: Theme;
  private opened = false;
  private atLineStart = true;
  private readonly color: boolean;
  private readonly contentWidth: number;
  private lineBuffer = "";
  private pendingLines: string[] = [];
  private readonly width: number;

  constructor(stream: ProgressStream, theme: Theme) {
    this.stream = stream;
    this.theme = theme;
    this.color = Boolean(stream.isTTY && !process.env.NO_COLOR);
    this.width = Math.max(36, Math.min(100, (stream.columns ?? 88) - 2));
    this.contentWidth = this.width - 4;
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
      this.completeLine(this.lineBuffer);
      this.lineBuffer = "";
    }
    this.flushPendingLines(true);
    this.writeBorder(`╰${"─".repeat(this.width - 2)}╯\n`);
    this.opened = false;
    this.atLineStart = true;
    this.pendingLines = [];
  }

  private open(): void {
    if (this.opened) {
      return;
    }
    const title = ` ${this.theme.brand.name} `;
    const top = `╭─${title}${"─".repeat(Math.max(0, this.width - title.length - 3))}╮`;
    this.writeBorder(`${top}\n`);
    this.opened = true;
    this.atLineStart = true;
  }

  private writeBorder(value: string): void {
    this.stream.write(ansi(this.theme, "primary", value, this.color));
  }

  private completeLine(line: string): void {
    this.pendingLines.push(line);
    this.flushPendingLines(false);
  }

  private flushPendingLines(final: boolean): void {
    while (this.pendingLines.length > 0) {
      const block = readMarkdownTableBlock(this.pendingLines, { final });
      if (block === "hold") {
        return;
      }
      if (block) {
        for (const renderedLine of renderMarkdownTableBlock(block, this.contentWidth)) {
          this.writeContentLine(renderedLine);
        }
        this.pendingLines.splice(0, block.rawCount);
        continue;
      }
      this.writeContentLine(this.pendingLines.shift() ?? "");
    }
  }

  private writeContentLine(line: string): void {
    if (this.atLineStart) {
      this.writeBorder("│ ");
      this.atLineStart = false;
    }
    this.stream.write(ansi(this.theme, "text", line, this.color));
    this.stream.write("\n");
    this.atLineStart = true;
  }
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
      return `drafting ${event.name}...`;
    }
    if (event.type === "tool.start") {
      return event.context || event.message;
    }
    if (event.type === "tool.progress") {
      return event.preview || event.message;
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
