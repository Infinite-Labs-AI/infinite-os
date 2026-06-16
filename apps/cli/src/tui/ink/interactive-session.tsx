import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stdin as defaultInput, stderr as defaultErrorOutput, stdout as defaultOutput } from "node:process";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, renderToString, useApp, useCursor, useInput, useStdin, useStdout } from "./renderer.js";

import type { ChatProgressEvent } from "@infinite-os/llm-controller";

import { turnController } from "../app/turn-controller.js";
import { getTurnState, subscribeTurnState, type TurnState } from "../app/turn-store.js";
import { TYPING_IDLE_MS } from "../config/timing.js";
import { displayWidth, truncateCells } from "../lib/display-width.js";
import { resolveTheme, type Theme } from "../theme.js";
import type { Msg } from "../types.js";
import { isInfiniteTurnBusy } from "./status-indicator.js";
import { inkTranscriptRowCount, InkTranscriptApp, useInfiniteTranscriptClock } from "./transcript-app.js";

const HISTORY_LIMIT = 120;
const INPUT_HISTORY_LIMIT = 1000;
const BRACKETED_PASTE_MARKER_RE = /\x1b?\[20[01]~/g;
const INVERSE_OFF = "\u001b[27m";
const INVERSE_ON = "\u001b[7m";
const ESC = "\u001b";
const FWD_DEL_RE = new RegExp(`${ESC}\\[3(?:[~$^]|;)`);
const PRINTABLE_INPUT_RE = /^[ -~\u00a0-\uffff]+$/;
const TAB_PATH_RE = /((?:["']?(?:[A-Za-z]:[\\/]|\.{1,2}\/|~\/|\/|@|[^"'`\s]+\/))[^\s]*)$/;
const QUEUED_PREVIEW_LIMIT = 50;

export interface InkInteractiveLineResult {
  exit?: boolean;
  messages?: readonly Msg[];
  // The project this turn resolved to, when an `@name` switch (or `/project use`)
  // changed the pin. The switch happens *inside* `onSubmitLine`, after this turn's
  // title was captured — so the answer's title must be re-stamped from this, not
  // the pre-call `getAgentTitle()`. (PR4)
  project?: { id: string; name: string };
  // The layer-bridge for the PR5 picker. `index.ts` owns the env/cache but cannot
  // render Ink; this component renders the `SelectionMenu` but has no env. When the
  // `onSubmitLine` wrapper detects a pre-turn selection is required (no pin / an
  // `@unknown` / multiple distinct `@a @b`) it returns THIS variant *instead* of
  // building the runtime, and this component renders the picker (reusing the
  // existing `pendingSelection`/`SelectionMenu` path) and on a pick RE-SUBMITS
  // `@<pickedName> <originalLine>` — flowing back through the PR4 `@`-resolver to
  // set the pin and answer. No switch logic is duplicated here. (PR5)
  needsProjectSelection?: {
    options: readonly { id: string; name: string }[];
    originalLine: string;
  };
}

export interface InkInteractiveSelectionOption {
  description?: string;
  label: string;
  line: string;
}

export interface InkInteractiveSelectionPrompt {
  description?: string;
  options: readonly InkInteractiveSelectionOption[];
  question: string;
}

export interface InputHistorySnapshot {
  draft: string;
  entries: readonly string[];
  index: number | null;
}

export interface ComposerEditState {
  cursor: number;
  selection?: ComposerSelection | null;
  value: string;
}

export interface ComposerSelection {
  end: number;
  start: number;
}

export type ComposerEditAction =
  | { text: string; type: "insert" }
  | { type: "insert-newline" }
  | { text: string; type: "insert-paste" }
  | { type: "backspace" }
  | { type: "delete-forward" }
  | { type: "move-line-down" }
  | { type: "move-line-down-select" }
  | { type: "move-line-up" }
  | { type: "move-line-up-select" }
  | { type: "move-end" }
  | { type: "move-left" }
  | { type: "move-left-select" }
  | { type: "move-start" }
  | { type: "move-right" }
  | { type: "move-right-select" }
  | { type: "move-word-left" }
  | { type: "move-word-left-select" }
  | { type: "move-word-right" }
  | { type: "move-word-right-select" };

export interface CompletionSuggestion {
  description?: string;
  kind?: "path" | "slash" | "at";
  replaceFrom?: number;
  value: string;
}

export interface CompletionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  // Project list for `@name` completion. Supplied synchronously by the caller
  // (the CLI reads its in-memory project-list cache). (PR4)
  projects?: readonly { id: string; name: string }[];
}

export interface InkInteractiveSessionAppProps {
  columns?: number;
  /** Live agent label for the active project (e.g. `() => "Infinite — Acme"`). */
  getAgentTitle?: () => string | undefined;
  getCompletions?: (value: string) => readonly CompletionSuggestion[];
  initialInputCursor?: number;
  initialInputSelection?: ComposerSelection | null;
  initialInputValue?: string;
  initialInputHistory?: readonly string[];
  initialMessages?: readonly Msg[];
  onRememberInput?: (line: string) => void;
  onSubmitLine(line: string, onProgress: (event: ChatProgressEvent) => void): Promise<InkInteractiveLineResult>;
  promptPlaceholder?: string;
  requiresConfirmation?: (line: string) => string | undefined;
  requiresSelection?: (line: string) => InkInteractiveSelectionPrompt | undefined;
  status?: readonly string[] | (() => readonly string[]);
  theme?: Theme;
  title?: string;
}

export interface InkInteractiveSessionRunOptions extends InkInteractiveSessionAppProps {
  errorOutput?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function runInkInteractiveSession(options: InkInteractiveSessionRunOptions): Promise<void> {
  const instance = render(
    <InkInteractiveSessionApp {...options} columns={options.columns ?? options.output?.columns} />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: options.errorOutput ?? defaultErrorOutput,
      stdin: options.input ?? defaultInput,
      stdout: options.output ?? defaultOutput
    }
  );

  await instance.waitUntilExit();
}

export function renderInkInteractiveSessionToString(
  props: InkInteractiveSessionAppProps,
  options: { columns?: number } = {}
): string {
  return renderToString(<InkInteractiveSessionApp {...props} columns={props.columns ?? options.columns} />, {
    columns: props.columns ?? options.columns ?? 88
  });
}

/**
 * Stamp the frozen agent label onto a turn's assistant answers. Captured at
 * submit time so a later `/project use` never relabels earlier responses.
 */
function stampAgentTitle(messages: readonly Msg[], title: string | undefined): readonly Msg[] {
  if (!title) {
    return messages;
  }
  return messages.map((msg) =>
    msg.role === "assistant" && msg.title === undefined ? { ...msg, title } : msg
  );
}

/**
 * Pick the title to stamp onto a completed (non-streaming) turn's answer (PR4).
 *
 * The `@name` switch runs INSIDE `onSubmitLine`, AFTER `submitExecutableLine`
 * froze `turnTitle` from the pre-call `getAgentTitle()`. So a turn that switched
 * projects (`result.project` set) must take its label from the live, post-switch
 * label (`liveTitle`); a turn that did NOT switch keeps the frozen `turnTitle`
 * (the live label is identical anyway, but gating avoids re-stamping when the
 * live read is momentarily unavailable). Falls back to the frozen title when the
 * live label is undefined. Exported so the re-stamp decision is covered by a
 * deterministic (non-PTY) test in addition to the end-to-end PTY test.
 */
export function resolveRestampTitle(input: {
  switched: boolean;
  liveTitle: string | undefined;
  turnTitle: string | undefined;
}): string | undefined {
  return input.switched ? (input.liveTitle ?? input.turnTitle) : input.turnTitle;
}

/**
 * Build the picker prompt for a PR5 `needsProjectSelection` result. Each option's
 * `.line` is a re-submittable `@<slug> <originalLine>` (the slug is the project
 * name with whitespace stripped, mirroring the `@`-completion token, so the PR4
 * `@`-resolver matches it). On a pick the existing `acceptPendingSelection` path
 * re-dispatches that line through `onSubmitLine` → the PR4 resolver, which sets
 * the pin and answers the original question — so no switch logic lives here.
 * `.label` carries the readable project name for the menu. Exported for testing.
 */
export function buildProjectSelectionPrompt(selection: {
  options: readonly { id: string; name: string }[];
  originalLine: string;
}): InkInteractiveSelectionPrompt {
  const original = selection.originalLine.trim();
  const question = original
    ? "Which project should answer this?"
    : "Which project should this session use?";
  // Slug-collision guard: when two offered projects normalize to the SAME
  // `@`-slug, re-submitting `@<slug>` would re-trigger the ambiguous-pin gate and
  // loop the picker forever. For a colliding option, re-submit `@<id>` instead
  // (the id resolves uniquely in `resolveProjectPin`); unique slugs keep `@<slug>`.
  const slugCounts = new Map<string, number>();
  for (const project of selection.options) {
    const slug = project.name.toLowerCase().replace(/\s+/g, "");
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }
  return {
    question,
    description: "No project is pinned. Pick one — it becomes the session pin (use `@name` to switch later).",
    options: selection.options.map((project) => {
      const slug = project.name.replace(/\s+/g, "");
      const isColliding = (slugCounts.get(project.name.toLowerCase().replace(/\s+/g, "")) ?? 0) > 1;
      const token = isColliding ? project.id : slug;
      return {
        label: project.name,
        // `@<token>` switches the pin; the trailing original line is answered for it.
        line: original ? `@${token} ${original}` : `@${token}`
      };
    })
  };
}

export function InkInteractiveSessionApp({
  columns = 88,
  getAgentTitle,
  getCompletions,
  initialInputCursor,
  initialInputSelection,
  initialInputValue = "",
  initialInputHistory = [],
  initialMessages = [],
  onRememberInput,
  onSubmitLine,
  promptPlaceholder = "Type a message, /help, or /exit.",
  requiresConfirmation,
  requiresSelection,
  status = [],
  theme,
  title
}: InkInteractiveSessionAppProps) {
  const app = useApp();
  const t = theme ?? resolveTheme();
  const [busy, setBusy] = useState(false);
  const [busyStartedAt, setBusyStartedAt] = useState<number | undefined>(undefined);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [inputValue, setInputValue] = useState(initialInputValue);
  const [inputCursor, setInputCursor] = useState(() =>
    snapComposerCursor(initialInputValue, initialInputCursor ?? initialInputValue.length)
  );
  const [inputSelection, setInputSelection] = useState<ComposerSelection | null>(() =>
    normalizeComposerSelection(initialInputValue, initialInputSelection)
  );
  const [inputHistory, setInputHistory] = useState<InputHistorySnapshot>(() => ({
    draft: "",
    entries: initialInputHistory,
    index: null
  }));
  const [history, setHistory] = useState<readonly Msg[]>(initialMessages);
  const [pendingOperatorLine, setPendingOperatorLine] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    prompt: InkInteractiveSelectionPrompt;
    selectedIndex: number;
  } | null>(null);
  const [queuedLines, setQueuedLines] = useState<readonly string[]>([]);
  const [turnState, setTurnState] = useState<TurnState>(() => getTurnState());
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribeTurnState(() => setTurnState(getTurnState())), []);

  useEffect(() => {
    if (typingIdleTimer.current) {
      clearTimeout(typingIdleTimer.current);
      typingIdleTimer.current = null;
    }

    if (!inputValue) {
      turnController.relaxStreaming();
      return;
    }

    if (busy) {
      turnController.boostStreamingForTyping();
    }

    typingIdleTimer.current = setTimeout(() => {
      typingIdleTimer.current = null;
      turnController.relaxStreaming();
    }, TYPING_IDLE_MS);

    return () => {
      if (typingIdleTimer.current) {
        clearTimeout(typingIdleTimer.current);
        typingIdleTimer.current = null;
      }
    };
  }, [busy, inputValue]);

  const appendMessages = useCallback((messages: readonly Msg[]) => {
    if (!messages.length) {
      return;
    }
    setHistory((current) => [...current, ...messages].slice(-HISTORY_LIMIT));
  }, []);

  const statusParts = typeof status === "function" ? status() : status;
  // Live label for the in-flight answer; completed messages carry their own
  // frozen `title` (stamped at submit) so a mid-session `/project use` never
  // relabels earlier answers.
  const agentTitle = getAgentTitle?.();
  const transcript = useMemo(() => ({
    agentTitle,
    messages: history,
    state: turnState
  }), [agentTitle, history, turnState]);
  // Drive the transcript's animated clock here so the composer-cursor row
  // prediction below and the live <InkTranscriptApp> render share identical
  // tick/time values. Otherwise the busy indicator (or a tool's elapsed timer)
  // can wrap to a different number of rows in the render than the prediction
  // assumed, and the native cursor lands a row above the composer.
  // `transcriptBusy` only governs whether the animation timers run — the row
  // count itself is derived independently inside both consumers via
  // `isInfiniteTurnBusy(state)`, so this must stay an OR (a tool-only turn with
  // React `busy === false` still needs the indicator to animate).
  const transcriptBusy = busy || isInfiniteTurnBusy(turnState);
  const { clock, labelTick, spinnerTick } = useInfiniteTranscriptClock({
    busy: transcriptBusy,
    state: turnState
  });
  const visibleStatusParts = [
    ...(statusParts ?? []),
    busy ? "busy" : "ready",
    ...formatQueuedStatus(queuedLines)
  ];
  const composerRow = inkTranscriptRowCount({
    busy,
    columns,
    indicatorTick: labelTick,
    nowMs: clock,
    showComposer: false,
    spinnerTick,
    status: visibleStatusParts,
    theme: t,
    title,
    transcript,
    turnStartedAt: busyStartedAt
  });
  const completions = useMemo(
    () => getCompletions?.(inputValue).slice(0, 6) ?? [],
    [getCompletions, inputValue]
  );
  const selectedCompletionIndex = completions.length
    ? Math.min(completionIndex, completions.length - 1)
    : 0;

  const setComposerState = useCallback((state: ComposerEditState) => {
    const cursor = snapComposerCursor(state.value, state.cursor);
    setInputValue(state.value);
    setInputCursor(cursor);
    setInputSelection(normalizeComposerSelection(state.value, state.selection));
    setCompletionIndex(0);
    setInputHistory((current) => current.index === null ? current : { ...current, draft: "", index: null });
  }, []);

  const navigateHistory = useCallback((direction: "newer" | "older") => {
    setInputHistory((current) => {
      const next = navigateInputHistory(current, direction, inputValue);
      setInputValue(next.value);
      setInputCursor(next.value.length);
      setInputSelection(null);
      return next.history;
    });
  }, [inputValue]);

  const rememberInputLine = useCallback((line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    setInputHistory((current) => ({
      draft: "",
      entries: appendInputHistory(current.entries, trimmed),
      index: null
    }));
    onRememberInput?.(trimmed);
  }, [onRememberInput]);

  const acceptCompletion = useCallback(() => {
    const completion = completions[selectedCompletionIndex];
    if (!completion) {
      return;
    }
    const value = applyCompletionSuggestion(inputValue, completion);
    setComposerState({ cursor: value.length, value });
  }, [completions, inputValue, selectedCompletionIndex, setComposerState]);

  const selectCompletion = useCallback((direction: "next" | "previous") => {
    if (completions.length <= 1) {
      return false;
    }
    setCompletionIndex((current) =>
      direction === "next"
        ? (current + 1) % completions.length
        : (current - 1 + completions.length) % completions.length
    );
    return true;
  }, [completions.length]);

  const queueBusyLine = useCallback((line: string) => {
    rememberInputLine(line);
    setQueuedLines((current) => [...current, line]);
    appendMessages([{
      kind: "slash",
      role: "system",
      text: `queued: "${previewQueuedLine(line)}"`
    }]);
  }, [appendMessages, rememberInputLine]);

  const submitExecutableLine = useCallback(async (line: string) => {
    setBusyStartedAt(Date.now());
    setBusy(true);
    let sawFinalMessage = false;
    // Freeze the active-project label now and stamp it onto this turn's
    // answers, so switching projects later never relabels them.
    const turnTitle = getAgentTitle?.();

    try {
      const result = await onSubmitLine(line, (event) => {
        const progressResult = turnController.recordProgressEvent(event);
        if ("type" in event && event.type === "message.complete" && isMessageCompleteResult(progressResult)) {
          sawFinalMessage = true;
          // An `@name` switch inside `onSubmitLine` runs BEFORE the answer
          // streams, so the live label already reflects the resolved pin by the
          // time this fires — re-read it so a switched turn labels for the right
          // project. Falls back to the frozen title if the label is unavailable.
          //
          // Why this re-reads UNCONDITIONALLY (unlike the non-streaming branch at
          // `restampTitle` below, which gates on `result.project`): `applySessionPin`
          // mutates the label SYNCHRONOUSLY inside `onSubmitLine` — before any
          // `message.complete` event can fire — so for a NON-switched turn the live
          // label is byte-for-byte identical to the frozen `turnTitle`, making the
          // re-read a no-op rather than a relabel. We can't read `result.project`
          // here because `result` isn't resolved until after streaming finishes, so
          // gating mid-stream isn't possible anyway. Footgun guard: if a future
          // change ever mutates the label ASYNCHRONOUSLY (after this callback), this
          // unconditional re-read could mis-stamp a non-switched turn — keep label
          // mutation synchronous within `onSubmitLine`, or thread the switch result
          // through `progressResult` and gate on it like the branch below.
          appendMessages(stampAgentTitle(progressResult.finalMessages, getAgentTitle?.() ?? turnTitle));
        }
      });

      if (result.exit) {
        app.exit();
        return;
      }
      // PR5 layer-bridge: the wrapper decided a project must be picked PRE-TURN
      // (no pin / `@unknown` / multiple `@a @b`) and returned a selection instead
      // of building the runtime. Render the picker by reusing the existing
      // `pendingSelection`/`SelectionMenu` path; on a pick `acceptPendingSelection`
      // re-dispatches `@<name> <originalLine>` through the PR4 `@`-resolver, which
      // sets the pin and answers the original message. (No switch logic here.)
      if (result.needsProjectSelection && result.needsProjectSelection.options.length > 0) {
        const prompt = buildProjectSelectionPrompt(result.needsProjectSelection);
        setPendingSelection({ prompt, selectedIndex: 0 });
        if (result.messages?.length) {
          appendMessages(stampAgentTitle(result.messages, turnTitle));
        }
        return;
      }
      // Re-stamp from the resolved project (PR4): if this turn switched projects,
      // its title comes from the post-switch label, not the pre-call capture.
      // Shared seam with the deterministic test (see `resolveRestampTitle`).
      const restampTitle = resolveRestampTitle({
        switched: Boolean(result.project),
        liveTitle: getAgentTitle?.(),
        turnTitle
      });
      if (!sawFinalMessage) {
        appendMessages(stampAgentTitle(result.messages ?? [], restampTitle));
      }
    } catch (error) {
      appendMessages([{
        kind: "slash",
        role: "system",
        text: `error: ${error instanceof Error ? error.message : String(error)}`
      }]);
    } finally {
      turnController.reset();
      setBusy(false);
      setBusyStartedAt(undefined);
    }
  }, [app, appendMessages, getAgentTitle, onSubmitLine]);

  const runSubmittedLine = useCallback((line: string) => {
    if (pendingOperatorLine) {
      appendMessages([{ role: "user", text: line }]);
      if (line.toLowerCase() === "confirm") {
        const confirmedLine = pendingOperatorLine;
        setPendingOperatorLine(null);
        void submitExecutableLine(confirmedLine);
      } else {
        setPendingOperatorLine(null);
        appendMessages([{ kind: "slash", role: "system", text: "Cancelled operator action." }]);
      }
      return;
    }

    appendMessages([{ role: "user", text: line }]);
    const selection = requiresSelection?.(line);
    if (selection && selection.options.length > 0) {
      setPendingSelection({ prompt: selection, selectedIndex: 0 });
      return;
    }

    const confirmation = requiresConfirmation?.(line);
    if (confirmation) {
      setPendingOperatorLine(line);
      appendMessages([{ kind: "slash", role: "system", text: confirmation }]);
      return;
    }

    void submitExecutableLine(line);
  }, [appendMessages, pendingOperatorLine, requiresConfirmation, requiresSelection, submitExecutableLine]);

  const selectPendingOption = useCallback((direction: "next" | "previous") => {
    setPendingSelection((current) => {
      if (!current || current.prompt.options.length <= 1) {
        return current;
      }
      const delta = direction === "next" ? 1 : -1;
      const selectedIndex = (current.selectedIndex + delta + current.prompt.options.length) % current.prompt.options.length;
      return { ...current, selectedIndex };
    });
  }, []);

  const acceptPendingSelection = useCallback(() => {
    if (!pendingSelection) {
      return;
    }
    const option = pendingSelection.prompt.options[pendingSelection.selectedIndex];
    setPendingSelection(null);
    if (!option) {
      appendMessages([{ kind: "slash", role: "system", text: "Cancelled selection." }]);
      return;
    }
    rememberInputLine(option.line);
    runSubmittedLine(option.line);
  }, [appendMessages, pendingSelection, rememberInputLine, runSubmittedLine]);

  useEffect(() => {
    if (busy || pendingOperatorLine || pendingSelection || queuedLines.length === 0) {
      return;
    }

    const [nextLine, ...remainingLines] = queuedLines;
    if (!nextLine) {
      setQueuedLines(remainingLines);
      return;
    }

    setQueuedLines(remainingLines);
    runSubmittedLine(nextLine);
  }, [busy, pendingOperatorLine, pendingSelection, queuedLines, runSubmittedLine]);

  const submitLine = useCallback((rawLine: string) => {
    const line = rawLine.trim();
    setInputValue("");
    setInputCursor(0);
    setInputSelection(null);

    if (!line) {
      return;
    }
    if (line === "/exit" || line === "/quit") {
      app.exit();
      return;
    }

    if (busy) {
      queueBusyLine(line);
      return;
    }

    rememberInputLine(line);
    runSubmittedLine(line);
  }, [app, busy, queueBusyLine, rememberInputLine, runSubmittedLine]);

  return (
    <Box flexDirection="column" width={columns}>
      <InkTranscriptApp
        busy={busy}
        columns={columns}
        indicatorTick={labelTick}
        nowMs={clock}
        prompt={{ placeholder: promptPlaceholder }}
        showComposer={false}
        spinnerTick={spinnerTick}
        status={visibleStatusParts}
        theme={t}
        title={title}
        transcript={transcript}
        turnStartedAt={busyStartedAt}
      />
      <SelectionMenu
        pending={pendingSelection}
        theme={t}
        width={columns}
      />
      <InkLineInput
        busy={busy}
        completionActive={completions.length > 0}
        cursor={inputCursor}
        onChange={setComposerState}
        onCompletionAccept={acceptCompletion}
        onCompletionNext={() => selectCompletion("next")}
        onCompletionPrevious={() => selectCompletion("previous")}
        onHistoryNewer={() => navigateHistory("newer")}
        onHistoryOlder={() => navigateHistory("older")}
        onSelectionAccept={acceptPendingSelection}
        onSelectionNext={() => selectPendingOption("next")}
        onSelectionPrevious={() => selectPendingOption("previous")}
        onSubmit={submitLine}
        pendingConfirmation={Boolean(pendingOperatorLine)}
        placeholder={
          pendingSelection
            ? "choose with up/down, Enter to select"
            : pendingOperatorLine
              ? "type confirm to continue, anything else to cancel"
              : promptPlaceholder
        }
        row={composerRow}
        selectionActive={Boolean(pendingSelection)}
        theme={t}
        value={inputValue}
        selection={inputSelection}
        width={columns}
      />
      <CompletionMenu
        completions={completions}
        selectedIndex={selectedCompletionIndex}
        theme={t}
        width={columns}
      />
    </Box>
  );
}

export function appendInputHistory(
  entries: readonly string[],
  line: string,
  limit = INPUT_HISTORY_LIMIT
): readonly string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return entries;
  }
  if (entries.at(-1) === trimmed) {
    return entries;
  }

  return [...entries, trimmed].slice(-Math.max(1, limit));
}

export function previewQueuedLine(line: string, limit = QUEUED_PREVIEW_LIMIT): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

export function formatQueuedStatus(lines: readonly string[]): readonly string[] {
  if (!lines.length) {
    return [];
  }

  const extra = lines.length > 1 ? ` (+${lines.length - 1})` : "";
  return [`queued: "${previewQueuedLine(lines[0] ?? "")}"${extra}`];
}

export function isForwardDeleteInput(event: unknown): boolean {
  const raw = typeof event === "string"
    ? event
    : typeof event === "object" && event !== null
      ? (event as { keypress?: { raw?: unknown } }).keypress?.raw
      : undefined;

  return typeof raw === "string" && FWD_DEL_RE.test(raw);
}

function useForwardDeleteSignal(active = true) {
  const ref = useRef(false);
  const stdinState = useStdin() as unknown as {
    inputEmitter?: {
      prependListener(event: "input", listener: (event: unknown) => void): void;
      removeListener(event: "input", listener: (event: unknown) => void): void;
    };
    internal_eventEmitter?: {
      prependListener(event: "input", listener: (event: unknown) => void): void;
      removeListener(event: "input", listener: (event: unknown) => void): void;
    };
  };

  useEffect(() => {
    if (!active) {
      return;
    }

    const emitter = stdinState.inputEmitter ?? stdinState.internal_eventEmitter;
    if (!emitter) {
      return;
    }

    const record = (event: unknown) => {
      ref.current = isForwardDeleteInput(event);
    };

    emitter.prependListener("input", record);

    return () => {
      emitter.removeListener("input", record);
    };
  }, [active, stdinState.inputEmitter, stdinState.internal_eventEmitter]);

  return ref;
}

export function completeSlashCommands(
  value: string,
  candidates: readonly CompletionSuggestion[],
  limit = 6
): readonly CompletionSuggestion[] {
  if (!value.startsWith("/") || /\s/.test(value)) {
    return [];
  }
  const needle = value.toLowerCase();
  return candidates
    .filter((candidate) => candidate.value.toLowerCase().startsWith(needle) && candidate.value !== value)
    .slice(0, Math.max(1, limit));
}

// Match the last `@<partial>` token anywhere in the line (it runs to the next
// whitespace). Captures the `@`'s index so completion can replace from there.
const AT_COMPLETION_RE = /@([^\s@]*)$/;

// `@name` Tab-completion. Must run BEFORE path completion: `TAB_PATH_RE` treats a
// leading `@` as a path word, so without this earlier branch `@rt`+Tab would route
// to (empty) path completion. Emits a non-slash, non-path `kind` with
// `replaceFrom` at the `@` so `@rt`+Tab → `@rtk` (the whole token is replaced).
export function completeAtMentions(
  value: string,
  options: CompletionOptions = {}
): readonly CompletionSuggestion[] {
  const projects = options.projects ?? [];
  if (!projects.length) {
    return [];
  }
  const match = AT_COMPLETION_RE.exec(value);
  if (!match) {
    return [];
  }
  const partial = (match[1] ?? "").toLowerCase().replace(/\s+/g, "");
  const replaceFrom = value.length - match[0].length;
  const limit = Math.max(1, options.limit ?? 6);
  return projects
    .filter((project) => project.name.toLowerCase().replace(/\s+/g, "").startsWith(partial))
    .slice(0, limit)
    .map((project) => ({
      description: "project",
      kind: "at" as const,
      replaceFrom,
      value: `@${project.name.replace(/\s+/g, "")}`
    }));
}

export function completeInteractiveInput(
  value: string,
  slashCandidates: readonly CompletionSuggestion[],
  options: CompletionOptions = {}
): readonly CompletionSuggestion[] {
  const slashCompletions = completeSlashCommands(value, slashCandidates, options.limit);
  if (slashCompletions.length) {
    return slashCompletions;
  }

  // `@name` completion runs before path completion (see `completeAtMentions`).
  const atCompletions = completeAtMentions(value, options);
  if (atCompletions.length) {
    return atCompletions;
  }

  return completePathArguments(value, options);
}

export function applyCompletionSuggestion(value: string, completion: CompletionSuggestion): string {
  const replaceFrom = Math.max(0, Math.min(completion.replaceFrom ?? 0, value.length));
  const replacement = completion.kind === "slash" && replaceFrom > 0 && completion.value.startsWith("/")
    ? completion.value.slice(1)
    : completion.value;

  return `${value.slice(0, replaceFrom)}${replacement}`;
}

export function applyComposerEdit(
  state: ComposerEditState,
  action: ComposerEditAction
): ComposerEditState {
  const value = state.value;
  const cursor = snapComposerCursor(value, state.cursor);
  const selection = normalizeComposerSelection(value, state.selection);
  const selectedRange = composerSelectedRange(value, selection);

  switch (action.type) {
    case "insert": {
      if (!PRINTABLE_INPUT_RE.test(action.text)) {
        return { cursor, value };
      }
      return replaceComposerRange(value, cursor, action.text, selectedRange);
    }
    case "insert-newline":
      return replaceComposerRange(value, cursor, "\n", selectedRange);
    case "insert-paste": {
      const text = normalizeComposerPasteText(action.text);
      if (!text) {
        return { cursor, value };
      }

      return replaceComposerRange(value, cursor, text, selectedRange);
    }
    case "backspace": {
      if (selectedRange) {
        return deleteComposerRange(value, selectedRange);
      }
      if (cursor <= 0) {
        return { cursor, value };
      }
      const previous = previousComposerPosition(value, cursor);
      return {
        cursor: previous,
        value: `${value.slice(0, previous)}${value.slice(cursor)}`
      };
    }
    case "delete-forward": {
      if (selectedRange) {
        return deleteComposerRange(value, selectedRange);
      }
      if (cursor >= value.length) {
        return { cursor, value };
      }
      const next = nextComposerPosition(value, cursor);
      return {
        cursor,
        value: `${value.slice(0, cursor)}${value.slice(next)}`
      };
    }
    case "move-line-down":
      return moveComposerCursor(value, cursor, selection, nextComposerLinePosition(value, cursor));
    case "move-line-down-select":
      return moveComposerCursor(value, cursor, selection, nextComposerLinePosition(value, cursor), true);
    case "move-line-up":
      return moveComposerCursor(value, cursor, selection, previousComposerLinePosition(value, cursor));
    case "move-line-up-select":
      return moveComposerCursor(value, cursor, selection, previousComposerLinePosition(value, cursor), true);
    case "move-end":
      return moveComposerCursor(value, cursor, selection, value.length);
    case "move-left":
      return moveComposerCursor(value, cursor, selection, selectedRange ? selectedRange.start : previousComposerPosition(value, cursor));
    case "move-left-select":
      return moveComposerCursor(value, cursor, selection, previousComposerPosition(value, cursor), true);
    case "move-start":
      return moveComposerCursor(value, cursor, selection, 0);
    case "move-right":
      return moveComposerCursor(value, cursor, selection, selectedRange ? selectedRange.end : nextComposerPosition(value, cursor));
    case "move-right-select":
      return moveComposerCursor(value, cursor, selection, nextComposerPosition(value, cursor), true);
    case "move-word-left":
      return moveComposerCursor(value, cursor, selection, previousComposerWordPosition(value, cursor));
    case "move-word-left-select":
      return moveComposerCursor(value, cursor, selection, previousComposerWordPosition(value, cursor), true);
    case "move-word-right":
      return moveComposerCursor(value, cursor, selection, nextComposerWordPosition(value, cursor));
    case "move-word-right-select":
      return moveComposerCursor(value, cursor, selection, nextComposerWordPosition(value, cursor), true);
  }
}

function renderComposerValueWithCursor(
  value: string,
  cursor: number,
  selection?: ComposerSelection | null,
  options: { nativeCursor?: boolean } = {}
): string {
  const selectedRange = composerSelectedRange(value, normalizeComposerSelection(value, selection));
  if (selectedRange) {
    return `${value.slice(0, selectedRange.start)}${INVERSE_ON}${value.slice(selectedRange.start, selectedRange.end)}${INVERSE_OFF}${value.slice(selectedRange.end)}`;
  }

  if (options.nativeCursor) {
    return value || " ";
  }

  const position = snapComposerCursor(value, cursor);

  return `${value.slice(0, position)}|${value.slice(position)}`;
}

function replaceComposerRange(
  value: string,
  cursor: number,
  text: string,
  selectedRange: { end: number; start: number } | null
): ComposerEditState {
  const start = selectedRange?.start ?? cursor;
  const end = selectedRange?.end ?? cursor;

  return {
    cursor: start + text.length,
    value: `${value.slice(0, start)}${text}${value.slice(end)}`
  };
}

function deleteComposerRange(
  value: string,
  selectedRange: { end: number; start: number }
): ComposerEditState {
  return {
    cursor: selectedRange.start,
    value: `${value.slice(0, selectedRange.start)}${value.slice(selectedRange.end)}`
  };
}

function moveComposerCursor(
  value: string,
  cursor: number,
  selection: ComposerSelection | null,
  nextCursor: number,
  extend = false
): ComposerEditState {
  const next = snapComposerCursor(value, nextCursor);
  if (!extend) {
    return { cursor: next, value };
  }

  const anchor = selection?.start ?? cursor;
  const nextSelection = normalizeComposerSelection(value, { end: next, start: anchor });

  return nextSelection
    ? { cursor: next, selection: nextSelection, value }
    : { cursor: next, value };
}

function normalizeComposerPasteText(text: string): string {
  const cleaned = text
    .replace(BRACKETED_PASTE_MARKER_RE, "")
    .replace(/\r\n?/g, "\n");

  return /[^\n]/.test(cleaned) ? cleaned.replace(/\n+$/, "") : cleaned;
}

let composerSegmenter: Intl.Segmenter | undefined;
const composerStopCache = new Map<string, number[]>();

function composerGraphemeStops(value: string): readonly number[] {
  const cached = composerStopCache.get(value);
  if (cached) {
    return cached;
  }

  const stops = [0];
  composerSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { index } of composerSegmenter.segment(value)) {
    if (index > 0) {
      stops.push(index);
    }
  }
  if (stops.at(-1) !== value.length) {
    stops.push(value.length);
  }

  composerStopCache.set(value, stops);
  if (composerStopCache.size > 32) {
    const oldest = composerStopCache.keys().next().value;
    if (oldest !== undefined) {
      composerStopCache.delete(oldest);
    }
  }

  return stops;
}

function snapComposerCursor(value: string, cursor: number): number {
  const position = Math.max(0, Math.min(cursor, value.length));
  let snapped = 0;

  for (const stop of composerGraphemeStops(value)) {
    if (stop > position) {
      break;
    }
    snapped = stop;
  }

  return snapped;
}

function normalizeComposerSelection(
  value: string,
  selection?: ComposerSelection | null
): ComposerSelection | null {
  if (!selection) {
    return null;
  }

  const start = snapComposerCursor(value, selection.start);
  const end = snapComposerCursor(value, selection.end);

  return start === end ? null : { end, start };
}

function composerSelectedRange(
  value: string,
  selection?: ComposerSelection | null
): { end: number; start: number } | null {
  const normalized = normalizeComposerSelection(value, selection);
  if (!normalized) {
    return null;
  }

  return {
    end: Math.max(normalized.start, normalized.end),
    start: Math.min(normalized.start, normalized.end)
  };
}

function previousComposerPosition(value: string, cursor: number): number {
  const position = snapComposerCursor(value, cursor);
  let previous = 0;

  for (const stop of composerGraphemeStops(value)) {
    if (stop >= position) {
      return previous;
    }
    previous = stop;
  }

  return previous;
}

function nextComposerPosition(value: string, cursor: number): number {
  const position = snapComposerCursor(value, cursor);

  for (const stop of composerGraphemeStops(value)) {
    if (stop > position) {
      return stop;
    }
  }

  return value.length;
}

function previousComposerWordPosition(value: string, cursor: number): number {
  let index = snapComposerCursor(value, cursor) - 1;

  while (index > 0 && /\s/.test(value[index] ?? "")) {
    index--;
  }
  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  return Math.max(0, index);
}

function nextComposerWordPosition(value: string, cursor: number): number {
  let index = snapComposerCursor(value, cursor);

  while (index < value.length && !/\s/.test(value[index] ?? "")) {
    index++;
  }
  while (index < value.length && /\s/.test(value[index] ?? "")) {
    index++;
  }

  return index;
}

function composerLinePosition(value: string, cursor: number, direction: -1 | 1): number {
  const position = snapComposerCursor(value, cursor);
  const currentLineStart = value.lastIndexOf("\n", position - 1) + 1;
  const column = position - currentLineStart;

  if (direction < 0) {
    if (currentLineStart === 0) {
      return position;
    }

    const previousLineStart = value.lastIndexOf("\n", currentLineStart - 2) + 1;

    return snapComposerCursor(value, Math.min(previousLineStart + column, currentLineStart - 1));
  }

  const nextLineBreak = value.indexOf("\n", position);
  if (nextLineBreak < 0) {
    return position;
  }

  const followingLineBreak = value.indexOf("\n", nextLineBreak + 1);
  const nextLineEnd = followingLineBreak < 0 ? value.length : followingLineBreak;

  return snapComposerCursor(value, Math.min(nextLineBreak + 1 + column, nextLineEnd));
}

function previousComposerLinePosition(value: string, cursor: number): number {
  return composerLinePosition(value, cursor, -1);
}

function nextComposerLinePosition(value: string, cursor: number): number {
  return composerLinePosition(value, cursor, 1);
}

export function composerCursorLayout(
  value: string,
  cursor: number,
  columns: number
): { column: number; line: number } {
  const position = snapComposerCursor(value, cursor);
  const width = Math.max(1, columns);
  let column = 0;
  let line = 0;

  composerSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment, index } of composerSegmenter.segment(value)) {
    if (index >= position) {
      break;
    }

    if (segment === "\n") {
      line += 1;
      column = 0;
      continue;
    }

    const segmentWidth = displayWidth(segment);
    if (!segmentWidth) {
      continue;
    }

    if (column + segmentWidth > width) {
      line += 1;
      column = 0;
    }

    column += segmentWidth;
  }

  if (column >= width) {
    line += 1;
    column = 0;
  }

  return { column, line };
}

export function composerNativeCursorPosition({
  cursor,
  label,
  row,
  value,
  width
}: {
  cursor: number;
  label: string;
  row: number;
  value: string;
  width: number;
}): { x: number; y: number } {
  const promptWidth = displayWidth(`${label} `);
  const layout = composerCursorLayout(value, cursor, Math.max(1, width - promptWidth));

  return {
    x: promptWidth + layout.column,
    y: row + layout.line
  };
}

export function completePathArguments(
  value: string,
  options: CompletionOptions = {}
): readonly CompletionSuggestion[] {
  const request = pathCompletionRequestForInput(value);
  if (!request) {
    return [];
  }

  return completePathWord(request.word, request.replaceFrom, options);
}

export function pathCompletionRequestForInput(value: string): { replaceFrom: number; word: string } | null {
  const word = value.match(TAB_PATH_RE)?.[1];
  if (!word) {
    return null;
  }

  return {
    replaceFrom: value.length - word.length,
    word
  };
}

function completePathWord(
  word: string,
  replaceFrom: number,
  options: CompletionOptions
): readonly CompletionSuggestion[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const limit = Math.max(1, options.limit ?? 6);
  const parsed = parsePathCompletionWord(word);
  const searchDir = resolveCompletionDirectory(parsed.directory, cwd, env);

  if (!searchDir || !existsSync(searchDir)) {
    return [];
  }

  try {
    return readdirSync(searchDir, { withFileTypes: true })
      .filter((entry) => parsed.base ? entry.name.toLowerCase().startsWith(parsed.base.toLowerCase()) : true)
      .filter((entry) => parsed.base.startsWith(".") || !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((entry) => {
        const directory = entry.isDirectory();
        return {
          description: directory ? "directory" : "file",
          kind: "path" as const,
          replaceFrom,
          value: formatPathCompletionValue(parsed, entry.name, directory)
        };
      });
  } catch {
    return [];
  }
}

function parsePathCompletionWord(word: string): {
  base: string;
  directory: string;
  displayPrefix: string;
} {
  const quote = word.startsWith("\"") || word.startsWith("'") ? word[0] : "";
  const unquoted = quote ? word.slice(1) : word;
  const mentionPrefix = unquoted.startsWith("@") ? "@" : "";
  const pathWord = mentionPrefix ? unquoted.slice(1) : unquoted;
  const separatorIndex = Math.max(pathWord.lastIndexOf("/"), pathWord.lastIndexOf("\\"));
  const directory = separatorIndex >= 0 ? pathWord.slice(0, separatorIndex + 1) : "";
  const base = separatorIndex >= 0 ? pathWord.slice(separatorIndex + 1) : pathWord;

  return {
    base,
    directory,
    displayPrefix: `${quote}${mentionPrefix}${directory}`
  };
}

function resolveCompletionDirectory(
  directory: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): string | null {
  const rawDirectory = directory || ".";
  const home = env.HOME;
  const expanded = rawDirectory === "~" || rawDirectory.startsWith("~/")
    ? home
      ? `${home}${rawDirectory.slice(1)}`
      : null
    : rawDirectory;

  if (!expanded) {
    return null;
  }

  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function formatPathCompletionValue(
  parsed: ReturnType<typeof parsePathCompletionWord>,
  name: string,
  directory: boolean
): string {
  return `${parsed.displayPrefix}${name}${directory ? "/" : ""}`;
}

export function navigateInputHistory(
  history: InputHistorySnapshot,
  direction: "newer" | "older",
  currentValue: string
): { history: InputHistorySnapshot; value: string } {
  if (!history.entries.length) {
    return { history, value: currentValue };
  }

  if (direction === "older") {
    const index = history.index === null
      ? history.entries.length - 1
      : Math.max(0, history.index - 1);
    return {
      history: {
        draft: history.index === null ? currentValue : history.draft,
        entries: history.entries,
        index
      },
      value: history.entries[index] ?? currentValue
    };
  }

  if (history.index === null) {
    return { history, value: currentValue };
  }
  if (history.index >= history.entries.length - 1) {
    return {
      history: {
        draft: "",
        entries: history.entries,
        index: null
      },
      value: history.draft
    };
  }

  const index = history.index + 1;
  return {
    history: { ...history, index },
    value: history.entries[index] ?? currentValue
  };
}

function InkLineInput({
  busy,
  completionActive,
  cursor,
  onChange,
  onCompletionAccept,
  onCompletionNext,
  onCompletionPrevious,
  onHistoryNewer,
  onHistoryOlder,
  onSelectionAccept,
  onSelectionNext,
  onSelectionPrevious,
  onSubmit,
  pendingConfirmation,
  placeholder,
  row,
  selection,
  selectionActive,
  theme,
  value,
  width
}: {
  busy: boolean;
  completionActive: boolean;
  cursor: number;
  onChange(state: ComposerEditState): void;
  onCompletionAccept(): void;
  onCompletionNext(): boolean;
  onCompletionPrevious(): boolean;
  onHistoryNewer(): void;
  onHistoryOlder(): void;
  onSelectionAccept(): void;
  onSelectionNext(): void;
  onSelectionPrevious(): void;
  onSubmit(value: string): void;
  pendingConfirmation: boolean;
  placeholder: string;
  row: number;
  selection?: ComposerSelection | null;
  selectionActive: boolean;
  theme: Theme;
  value: string;
  width: number;
}) {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const forwardDelete = useForwardDeleteSignal();
  useInput((input, key) => {
    const editState = { cursor, selection, value };
    if (key.ctrl && input === "c") {
      app.exit();
      return;
    }
    if (selectionActive) {
      if (key.return) {
        onSelectionAccept();
        return;
      }
      if (key.upArrow) {
        onSelectionPrevious();
        return;
      }
      if (key.downArrow) {
        onSelectionNext();
        return;
      }
      return;
    }
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.ctrl && input === "j") {
      onChange(applyComposerEdit(editState, { type: "insert-newline" }));
      return;
    }
    const keyWithPosition = key as typeof key & { end?: boolean; home?: boolean };
    if (keyWithPosition.home || (key.ctrl && input === "a")) {
      onChange(applyComposerEdit(editState, { type: "move-start" }));
      return;
    }
    if (keyWithPosition.end || (key.ctrl && input === "e")) {
      onChange(applyComposerEdit(editState, { type: "move-end" }));
      return;
    }
    if (key.tab) {
      if (key.shift) {
        if (!onCompletionPrevious()) {
          onCompletionAccept();
        }
        return;
      }
      onCompletionAccept();
      return;
    }
    if (key.upArrow) {
      if (completionActive && onCompletionPrevious()) {
        return;
      }
      const next = applyComposerEdit(editState, { type: key.shift ? "move-line-up-select" : "move-line-up" });
      if (next.cursor !== editState.cursor) {
        onChange(next);
        return;
      }
      onHistoryOlder();
      return;
    }
    if (key.downArrow) {
      if (completionActive && onCompletionNext()) {
        return;
      }
      const next = applyComposerEdit(editState, { type: key.shift ? "move-line-down-select" : "move-line-down" });
      if (next.cursor !== editState.cursor) {
        onChange(next);
        return;
      }
      onHistoryNewer();
      return;
    }
    if (key.leftArrow || (key.ctrl && input === "b")) {
      const word = key.meta || key.ctrl;
      const type = key.shift
        ? word ? "move-word-left-select" : "move-left-select"
        : word ? "move-word-left" : "move-left";
      onChange(applyComposerEdit(editState, { type }));
      return;
    }
    if (key.rightArrow || (key.ctrl && input === "f")) {
      const word = key.meta || key.ctrl;
      const type = key.shift
        ? word ? "move-word-right-select" : "move-right-select"
        : word ? "move-word-right" : "move-right";
      onChange(applyComposerEdit(editState, { type }));
      return;
    }
    if (key.meta && input === "b") {
      onChange(applyComposerEdit(editState, { type: "move-word-left" }));
      return;
    }
    if (key.meta && input === "f") {
      onChange(applyComposerEdit(editState, { type: "move-word-right" }));
      return;
    }
    if (key.backspace) {
      onChange(applyComposerEdit(editState, { type: "backspace" }));
      return;
    }
    if (key.delete) {
      onChange(applyComposerEdit(editState, { type: forwardDelete.current ? "delete-forward" : "backspace" }));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const action = input.length > 1 || input.includes("\n") || input.includes("[200~") || input.includes("[201~")
        ? { text: input, type: "insert-paste" as const }
        : { text: input, type: "insert" as const };
      onChange(applyComposerEdit(editState, action));
    }
  });

  const label = pendingConfirmation ? "!" : selectionActive ? "?" : theme.brand.prompt;
  const promptWidth = displayWidth(`${label} `);
  const inputWidth = Math.max(1, width - promptWidth);
  const nativeCursor = !busy && !selectionActive && !composerSelectedRange(value, selection) && Boolean(stdout?.isTTY);
  setCursorPosition(nativeCursor
    ? composerNativeCursorPosition({ cursor, label, row, value, width })
    : undefined);

  const content = value
    ? renderComposerValueWithCursor(value, cursor, selection, { nativeCursor })
    : placeholder;
  const color = value ? theme.color.text : theme.color.muted;

  return (
    <Box width={width}>
      <Text color={pendingConfirmation || selectionActive ? theme.color.warning : theme.color.primaryBright}>{label} </Text>
      <Box width={inputWidth}>
        <Text color={color} wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}

function SelectionMenu({
  pending,
  theme,
  width
}: {
  pending: { prompt: InkInteractiveSelectionPrompt; selectedIndex: number } | null;
  theme: Theme;
  width: number;
}) {
  if (!pending) {
    return null;
  }

  const commandWidth = Math.max(
    12,
    Math.min(32, ...pending.prompt.options.map((option) => displayWidth(option.line)))
  );

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.color.primaryBright}>{truncateCells(pending.prompt.question, width)}</Text>
      {pending.prompt.description ? (
        <Text color={theme.color.muted}>{truncateCells(pending.prompt.description, width)}</Text>
      ) : null}
      {pending.prompt.options.map((option, index) => {
        const selected = index === pending.selectedIndex;
        const marker = selected ? ">" : " ";
        const command = option.line.padEnd(commandWidth);
        const detail = option.description ? ` ${option.description}` : "";
        return (
          <Text key={`${option.line}-${index}`} color={selected ? theme.color.primaryBright : theme.color.text}>
            {truncateCells(`${marker} ${command} ${option.label}${detail}`, width)}
          </Text>
        );
      })}
    </Box>
  );
}

function CompletionMenu({
  completions,
  selectedIndex,
  theme,
  width
}: {
  completions: readonly CompletionSuggestion[];
  selectedIndex: number;
  theme: Theme;
  width: number;
}) {
  if (!completions.length) {
    return null;
  }

  return (
    <Box flexDirection="column" width={width}>
      {completions.map((completion, index) => {
        const selected = index === selectedIndex;
        const marker = selected ? ">" : " ";
        const text = completion.description
          ? `${marker} ${completion.value.padEnd(14)} ${completion.description}`
          : `${marker} ${completion.value}`;
        return (
          <Text
            color={selected ? theme.color.primaryBright : theme.color.muted}
            key={`${completion.value}:${index}`}
            wrap="truncate-end"
          >
            {truncateCells(text, width)}
          </Text>
        );
      })}
    </Box>
  );
}

function isMessageCompleteResult(value: unknown): value is { finalMessages: readonly Msg[]; finalText: string } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { finalMessages?: unknown }).finalMessages));
}
