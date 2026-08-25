import { stdin as input, stderr as errorOutput } from "node:process";
import React from "react";
import { render, type Instance } from "./renderer.js";

import type { ChatProgressEvent } from "@infinite-os/llm-controller";

import { turnController } from "../app/turn-controller.js";
import { getTurnState, subscribeTurnState } from "../app/turn-store.js";
import type { InfiniteAppChromeInput } from "../app/app-chrome.js";
import type { Theme } from "../theme.js";
import type { Msg } from "../types.js";
import { InkTranscriptApp } from "./transcript-app.js";

interface InkProgressStream {
  columns?: number;
  isTTY?: boolean;
  rows?: number;
  write(chunk: string): boolean;
}

export interface InkTranscriptReporterOptions {
  markAssistantStreamed?: () => void;
  now?: () => number;
  prompt?: InfiniteAppChromeInput["prompt"];
  status?: readonly string[] | (() => readonly string[]);
  theme?: Theme;
  title?: string;
}

export function canUseInkProgressReporter(stream: InkProgressStream): boolean {
  const candidate = stream as Partial<NodeJS.WriteStream>;

  return Boolean(
    stream.isTTY &&
    typeof candidate.write === "function" &&
    typeof candidate.on === "function" &&
    typeof candidate.once === "function" &&
    typeof candidate.removeListener === "function"
  );
}

export class InkTranscriptProgressReporter {
  private readonly instance: Instance;
  private readonly now?: () => number;
  private readonly options: InkTranscriptReporterOptions;
  private recordingProgress = false;
  private readonly stream: NodeJS.WriteStream;
  private readonly turnStartedAt: number;
  private readonly unsubscribe: () => void;

  constructor(stream: InkProgressStream, options: InkTranscriptReporterOptions = {}) {
    this.stream = stream as NodeJS.WriteStream;
    this.options = options;
    this.now = options.now;
    this.turnStartedAt = this.now?.() ?? Date.now();
    this.instance = render(this.node({ state: getTurnState() }), {
      exitOnCtrlC: false,
      maxFps: 30,
      patchConsole: false,
      stderr: errorOutput,
      stdin: input,
      stdout: this.stream
    });
    this.unsubscribe = subscribeTurnState(() => {
      if (!this.recordingProgress) {
        this.renderState();
      }
    });
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
        this.options.markAssistantStreamed?.();
      }
      if (event.type === "message.complete" && isMessageCompleteResult(result)) {
        this.renderMessages(result.finalMessages);
      } else if (event.type !== "message.complete") {
        this.renderState();
      }
      return;
    }
    this.renderState();
  }

  stop(): void {
    this.unsubscribe();
    this.instance.unmount();
    turnController.reset();
  }

  private renderState(): void {
    this.instance.rerender(this.node({ state: getTurnState() }));
  }

  private renderMessages(messages: readonly Msg[]): void {
    this.instance.rerender(this.node({ messages }));
  }

  private node(transcript: InfiniteAppChromeInput["transcript"]): React.ReactNode {
    return (
      <InkTranscriptApp
        columns={this.stream.columns}
        nowMs={this.now?.()}
        prompt={this.options.prompt ?? { placeholder: "Thinking, reasoning, or running tools." }}
        status={this.status()}
        theme={this.options.theme}
        title={this.options.title}
        transcript={transcript}
        turnStartedAt={this.turnStartedAt}
      />
    );
  }

  private status(): readonly string[] {
    const status = this.options.status;
    return typeof status === "function" ? status() : status ?? [];
  }
}

function isMessageProgressEvent(event: ChatProgressEvent): event is Extract<ChatProgressEvent, { type: `message.${string}` }> {
  return "type" in event && event.type.startsWith("message.");
}

function isMessageCompleteResult(value: unknown): value is { finalMessages: readonly Msg[]; finalText: string } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { finalMessages?: unknown }).finalMessages));
}
