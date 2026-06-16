import type { ChatProgressEvent } from "@infinite-os/llm-controller";

import { renderInfiniteAppChrome, type InfiniteAppChromeInput, type InfiniteAppChromeOptions } from "../app/app-chrome.js";
import { getTurnState, subscribeTurnState, type TurnState } from "../app/turn-store.js";
import { InfiniteTurnController, turnController } from "../app/turn-controller.js";

export interface InfiniteTranscriptRuntimeOptions {
  controller?: InfiniteTurnController;
  prompt?: InfiniteAppChromeInput["prompt"];
  status?: readonly string[] | (() => readonly string[]);
  title?: string;
}

export interface InfiniteTranscriptRuntime {
  record(event: ChatProgressEvent): unknown;
  render(options?: InfiniteAppChromeOptions): string;
  reset(): void;
  snapshot(): TurnState;
  subscribe(listener: (state: TurnState) => void, options?: { emitCurrent?: boolean }): () => void;
}

export function createInfiniteTranscriptRuntime(
  options: InfiniteTranscriptRuntimeOptions = {}
): InfiniteTranscriptRuntime {
  const controller = options.controller ?? turnController;
  const status = () => typeof options.status === "function" ? options.status() : options.status ?? [];

  return {
    record(event) {
      return controller.recordProgressEvent(event);
    },
    render(renderOptions = {}) {
      return renderInfiniteAppChrome(
        {
          prompt: options.prompt,
          status: status(),
          title: options.title,
          transcript: {
            state: getTurnState()
          }
        },
        renderOptions
      );
    },
    reset() {
      controller.fullReset();
    },
    snapshot() {
      return getTurnState();
    },
    subscribe(listener, subscribeOptions = {}) {
      if (subscribeOptions.emitCurrent) {
        listener(getTurnState());
      }
      return subscribeTurnState(() => listener(getTurnState()));
    }
  };
}
