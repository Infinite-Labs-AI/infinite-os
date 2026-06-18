import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stdin as defaultInput, stderr as defaultErrorOutput, stdout as defaultOutput } from "node:process";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The composer value renders in `<Text wrap="wrap">` (see InkLineInput), and Ink's
// wrap="wrap" word-wraps via `wrapAnsi(text, width, { trim: false, hard: true })`
// (ink/build/wrap-text.js). The native-cursor row prediction MUST use the SAME
// wrap so it never lands a row off the line the user is typing on — char-by-char
// width accumulation (a different, tighter packing) drifts from Ink's word-wrap.
import wrapAnsi from "wrap-ansi";
import { Box, Text, render, renderToString, useApp, useCursor, useInput, useStdin, useStdout } from "./renderer.js";

import type { ChatProgressEvent } from "@infinite-os/llm-controller";

// Type-only import (erased at build, no runtime cycle): the in-chat /connect
// wizard descriptor + decision are owned by index.ts (which owns the registry /
// copy / dispatch helpers). The TUI only renders them and drives raw-mode input.
import type {
  ConnectSetupDescriptor,
  ConnectWizardDecision,
  ConnectWizardField
} from "../../index.js";

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
  // In-chat /connect wizard (#20). Given a submitted line, decides whether it is a
  // token-provider connect (returns a `wizard` descriptor the TUI renders as a
  // masked field loop), a deferred provider (returns a `note` line to show), or
  // nothing of interest (`none`/undefined → normal routing). Owned by index.ts so
  // the registry/copy/dispatch helpers stay there; the TUI only renders + collects.
  connectWizard?: (line: string) => ConnectWizardDecision | undefined;
  // Build the leading-slash `/connect <provider> <name> <json>` dispatch line on
  // final confirm (index.ts's `buildConnectDispatchLine`, which owns normalization
  // + JSON.stringify). Kept on the index.ts side so the secret normalization isn't
  // duplicated in the TUI.
  buildConnectDispatch?: (
    provider: string,
    connectionName: string,
    collected: Record<string, string>
  ) => string;
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
  connectWizard,
  buildConnectDispatch,
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
  // In-chat /connect wizard (#20). `pendingFieldPrompt` drives the masked field
  // loop. `collected` holds committed field values IN MEMORY ONLY — including the
  // secret; it never flows to the transcript or input history. For a `choices`
  // field (the PostHog region step) `choiceIndex` tracks the highlighted option.
  const [pendingFieldPrompt, setPendingFieldPrompt] = useState<{
    descriptor: ConnectSetupDescriptor;
    index: number;
    collected: Record<string, string>;
    choiceIndex: number;
  } | null>(null);
  // The ACTIVE field's in-progress value lives ONLY here (a ref), never in
  // `inputValue` / the composer `value` / `submitLine` — so a secret keystroke is
  // never echoed or persisted. `activeFieldTick` forces a re-render on each
  // keystroke so the masked bullet count (or the plain value) updates. Zeroized on
  // commit / cancel / unmount.
  const activeFieldValueRef = useRef("");
  const [activeFieldTick, setActiveFieldTick] = useState(0);
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
    homeBanner: true,
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

  // ── In-chat /connect wizard (#20) ───────────────────────────────────────────
  // The final "Connect <Provider> / Cancel" step. Kept SEPARATE from
  // `pendingSelection` so its accept handler (`acceptConnectConfirm` below) NEVER
  // calls `rememberInputLine`/`appendMessages` on the secret-bearing dispatch line.
  const [pendingConnectConfirm, setPendingConnectConfirm] = useState<{
    descriptor: ConnectSetupDescriptor;
    collected: Record<string, string>;
    selectedIndex: number;
  } | null>(null);

  const fieldPromptActive = Boolean(pendingFieldPrompt);
  const currentConnectField: ConnectWizardField | null =
    pendingFieldPrompt?.descriptor.fields[pendingFieldPrompt.index] ?? null;

  // Zeroize the secret-bearing wizard state. Overwrite the ref's string before
  // dropping it, clear the field prompt + the final confirm, and reset the tick.
  // Called on cancel, on completion, and on Ctrl-C.
  const zeroizeConnectWizard = useCallback(() => {
    activeFieldValueRef.current = "";
    setActiveFieldTick(0);
    setPendingFieldPrompt(null);
    setPendingConnectConfirm(null);
  }, []);

  // Arm the masked field loop for a token provider. No transcript echo of the raw
  // `/connect <provider>` line beyond the user line already appended by the caller.
  const startConnectWizard = useCallback((descriptor: ConnectSetupDescriptor) => {
    activeFieldValueRef.current = "";
    setActiveFieldTick(0);
    setPendingConnectConfirm(null);
    if (descriptor.fields.length === 0) {
      // Defensive: a descriptor with no fields can't collect anything. Bail with a
      // note rather than dead-ending in an empty wizard.
      appendMessages([{
        kind: "slash",
        role: "system",
        text: `Nothing to collect for ${descriptor.label}. Run \`infinite connect ${descriptor.provider}\` in your terminal.`
      }]);
      return;
    }
    setPendingFieldPrompt({ descriptor, index: 0, collected: {}, choiceIndex: 0 });
    appendMessages([{
      kind: "slash",
      role: "system",
      text: `Connecting ${descriptor.label} — ${descriptor.description}. Docs: ${descriptor.docsUrl}`
    }]);
  }, [appendMessages]);

  const cancelConnectWizard = useCallback(() => {
    const label = pendingFieldPrompt?.descriptor.label ?? pendingConnectConfirm?.descriptor.label;
    zeroizeConnectWizard();
    appendMessages([{
      kind: "slash",
      role: "system",
      text: label ? `Cancelled connecting ${label}.` : "Cancelled connecting."
    }]);
  }, [appendMessages, pendingConnectConfirm, pendingFieldPrompt, zeroizeConnectWizard]);

  // Move to the next field, or to the final Connect/Cancel confirm after the last.
  // `collected` is threaded forward by value so the secret stays in memory only.
  const advanceConnectWizard = useCallback((collected: Record<string, string>) => {
    setPendingFieldPrompt((current) => {
      if (!current) {
        return null;
      }
      const nextIndex = current.index + 1;
      if (nextIndex >= current.descriptor.fields.length) {
        // All fields collected → arm the final confirm; leave the field loop.
        setPendingConnectConfirm({ descriptor: current.descriptor, collected, selectedIndex: 0 });
        return null;
      }
      return { ...current, index: nextIndex, collected, choiceIndex: 0 };
    });
    activeFieldValueRef.current = "";
    setActiveFieldTick(0);
  }, []);

  // Commit a free-text field on Enter. Secret fields append a REDACTED system line
  // and skip `rememberInputLine` (no disk history); non-secret fields echo a normal
  // labelled line. The raw value moves from the transient ref into `collected`.
  const commitConnectField = useCallback(() => {
    if (!pendingFieldPrompt || !currentConnectField || currentConnectField.choices) {
      return;
    }
    const field = currentConnectField;
    const raw = activeFieldValueRef.current;
    const value = field.secret ? raw : raw.trim();
    if (field.required && !value) {
      appendMessages([{
        kind: "slash",
        role: "system",
        text: `${field.label} is required.`
      }]);
      return;
    }
    const collected = { ...pendingFieldPrompt.collected, [field.key]: value };
    if (field.secret) {
      // Redacted echo only — never the raw key, and never to input history.
      appendMessages([{
        kind: "slash",
        role: "system",
        text: `${field.label}: ${"•".repeat(Math.min(Math.max(value.length, 1), 24))} (hidden)`
      }]);
    } else if (value) {
      appendMessages([{ kind: "slash", role: "system", text: `${field.label}: ${value}` }]);
    } else {
      appendMessages([{ kind: "slash", role: "system", text: `${field.label}: (skipped)` }]);
    }
    advanceConnectWizard(collected);
  }, [advanceConnectWizard, appendMessages, currentConnectField, pendingFieldPrompt]);

  // Commit a fixed-choice field (the PostHog region step) on Enter. Stores the
  // option's `value` (e.g. `eu.posthog.com`); echoes the readable label.
  const commitConnectChoice = useCallback(() => {
    if (!pendingFieldPrompt || !currentConnectField?.choices) {
      return;
    }
    const field = currentConnectField;
    const choice = field.choices?.[pendingFieldPrompt.choiceIndex];
    if (!choice) {
      return;
    }
    const collected = { ...pendingFieldPrompt.collected, [field.key]: choice.value };
    appendMessages([{ kind: "slash", role: "system", text: `${field.label}: ${choice.label}` }]);
    advanceConnectWizard(collected);
  }, [advanceConnectWizard, appendMessages, currentConnectField, pendingFieldPrompt]);

  const moveConnectChoice = useCallback((direction: "next" | "previous") => {
    setPendingFieldPrompt((current) => {
      const choices = current?.descriptor.fields[current.index]?.choices;
      if (!current || !choices || choices.length <= 1) {
        return current;
      }
      const delta = direction === "next" ? 1 : -1;
      const choiceIndex = (current.choiceIndex + delta + choices.length) % choices.length;
      return { ...current, choiceIndex };
    });
  }, []);

  // Keystroke handlers for the ACTIVE free-text field. They mutate ONLY the ref
  // (never `inputValue`/the composer/`submitLine`), then bump the tick to re-render
  // the masked/plain row. Secrets therefore never enter any echoed/persisted path.
  const appendConnectFieldKey = useCallback((text: string) => {
    if (!currentConnectField || currentConnectField.choices) {
      return;
    }
    activeFieldValueRef.current += text;
    setActiveFieldTick((tick) => tick + 1);
  }, [currentConnectField]);

  const backspaceConnectField = useCallback(() => {
    if (!currentConnectField || currentConnectField.choices) {
      return;
    }
    activeFieldValueRef.current = activeFieldValueRef.current.slice(0, -1);
    setActiveFieldTick((tick) => tick + 1);
  }, [currentConnectField]);

  const moveConnectConfirm = useCallback((direction: "next" | "previous") => {
    setPendingConnectConfirm((current) => {
      if (!current) {
        return current;
      }
      // Two options: Connect / Cancel.
      const delta = direction === "next" ? 1 : -1;
      const selectedIndex = (current.selectedIndex + delta + 2) % 2;
      return { ...current, selectedIndex };
    });
  }, []);

  // The DEDICATED final-confirm handler (binding revision). On "Connect" it builds
  // the leading-slash dispatch line from `collected` (in memory) and dispatches it
  // via `submitExecutableLine` WITHOUT `rememberInputLine` (no disk history) and
  // WITHOUT echoing the secret-bearing line to the transcript. On "Cancel" it
  // zeroizes. Either way the wizard state is cleared (secret dropped).
  const acceptConnectConfirm = useCallback(() => {
    if (!pendingConnectConfirm) {
      return;
    }
    const { descriptor, collected, selectedIndex } = pendingConnectConfirm;
    if (selectedIndex !== 0) {
      cancelConnectWizard();
      return;
    }
    // Build the leading-slash dispatch line from `collected` (in memory) via the
    // caller-provided builder (index.ts's `buildConnectDispatchLine`, which owns the
    // normalization + JSON.stringify). The line starts with `/` so it routes
    // runCommand → POST /sources/connect, never the LLM. Zeroize the wizard state
    // FIRST (drops the secret from component state), then dispatch the snapshotted
    // line WITHOUT `rememberInputLine` (no disk history) and WITHOUT echoing it to
    // the transcript.
    const line = buildConnectDispatch
      ? buildConnectDispatch(descriptor.provider, descriptor.connectionName, collected)
      : `/connect ${descriptor.provider} ${descriptor.connectionName} ${JSON.stringify({ mode: "live", ...collected })}`;
    zeroizeConnectWizard();
    appendMessages([{
      kind: "slash",
      role: "system",
      text: `Connecting ${descriptor.label}…`
    }]);
    void submitExecutableLine(line);
  }, [appendMessages, buildConnectDispatch, cancelConnectWizard, pendingConnectConfirm, submitExecutableLine, zeroizeConnectWizard]);

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

    // In-chat /connect wizard (#20): intercept BEFORE the operator confirm gate and
    // the LLM. For a token provider this arms the masked field loop (replacing the
    // heavy "Type confirm" gate with the wizard's own Connect/Cancel step); for a
    // deferred provider it shows a one-line note (no field loop, no LLM). `none`
    // falls through to the normal routing (so `/connect <provider> {json}` and the
    // oauth subcommands keep working). The raw `/connect <provider>` user line is
    // already echoed above; no secret is in it.
    const connectDecision = connectWizard?.(line);
    if (connectDecision && connectDecision.kind === "wizard") {
      startConnectWizard(connectDecision.descriptor);
      return;
    }
    if (connectDecision && connectDecision.kind === "note") {
      appendMessages([{ kind: "slash", role: "system", text: connectDecision.text }]);
      return;
    }

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
  }, [appendMessages, connectWizard, pendingOperatorLine, requiresConfirmation, requiresSelection, startConnectWizard, submitExecutableLine]);

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
    // Don't drain a queued line while a /connect wizard is active — its keystrokes
    // are routed to the field buffer, and a drained line must not pre-empt it.
    if (
      busy ||
      pendingOperatorLine ||
      pendingSelection ||
      pendingFieldPrompt ||
      pendingConnectConfirm ||
      queuedLines.length === 0
    ) {
      return;
    }

    const [nextLine, ...remainingLines] = queuedLines;
    if (!nextLine) {
      setQueuedLines(remainingLines);
      return;
    }

    setQueuedLines(remainingLines);
    runSubmittedLine(nextLine);
  }, [busy, pendingConnectConfirm, pendingFieldPrompt, pendingOperatorLine, pendingSelection, queuedLines, runSubmittedLine]);

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

  // The composer row shows the ACTIVE wizard field's value when a free-text field
  // is being collected: masked (bullets ×length) for secret fields, plain for the
  // rest. Reads the transient ref (never `inputValue`), so a secret keystroke is
  // never the composer `value`. `activeFieldTick` is in the deps so the bullet
  // count updates per keystroke. Choice fields render in `ConnectWizard`, not here.
  const activeFieldComposer = useMemo(() => {
    if (!fieldPromptActive || !currentConnectField || currentConnectField.choices) {
      return null;
    }
    const raw = activeFieldValueRef.current;
    return {
      label: currentConnectField.label,
      secret: currentConnectField.secret,
      display: currentConnectField.secret ? "•".repeat(raw.length) : raw
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldPromptActive, currentConnectField, activeFieldTick]);

  const connectComposerValue = activeFieldComposer ? activeFieldComposer.display : inputValue;
  const connectPlaceholder = activeFieldComposer
    ? activeFieldComposer.secret
      ? "type the secret (hidden), Enter to continue, Ctrl-C to cancel"
      : "type a value, Enter to continue, Ctrl-C to cancel"
    : pendingConnectConfirm
      ? "choose with up/down, Enter to select"
      : pendingSelection
        ? "choose with up/down, Enter to select"
        : pendingOperatorLine
          ? "type confirm to continue, anything else to cancel"
          : promptPlaceholder;

  return (
    <Box flexDirection="column" width={columns}>
      <InkTranscriptApp
        busy={busy}
        columns={columns}
        homeBanner
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
      <ConnectWizard
        active={fieldPromptActive ? pendingFieldPrompt : null}
        maskedValue={activeFieldComposer && activeFieldComposer.secret ? activeFieldComposer.display : undefined}
        theme={t}
        width={columns}
      />
      <ConnectConfirmMenu
        pending={pendingConnectConfirm}
        theme={t}
        width={columns}
      />
      <InkLineInput
        busy={busy}
        completionActive={completions.length > 0}
        completionRows={completions.length}
        cursor={inputCursor}
        connectConfirmActive={Boolean(pendingConnectConfirm)}
        fieldPromptActive={fieldPromptActive}
        fieldChoiceActive={Boolean(currentConnectField?.choices)}
        onChange={setComposerState}
        onCompletionAccept={acceptCompletion}
        onCompletionNext={() => selectCompletion("next")}
        onCompletionPrevious={() => selectCompletion("previous")}
        onConnectConfirmAccept={acceptConnectConfirm}
        onConnectConfirmNext={() => moveConnectConfirm("next")}
        onConnectConfirmPrevious={() => moveConnectConfirm("previous")}
        onConnectCancel={cancelConnectWizard}
        onFieldKey={appendConnectFieldKey}
        onFieldBackspace={backspaceConnectField}
        onFieldCommit={commitConnectField}
        onChoiceCommit={commitConnectChoice}
        onChoiceNext={() => moveConnectChoice("next")}
        onChoicePrevious={() => moveConnectChoice("previous")}
        onHistoryNewer={() => navigateHistory("newer")}
        onHistoryOlder={() => navigateHistory("older")}
        onSelectionAccept={acceptPendingSelection}
        onSelectionNext={() => selectPendingOption("next")}
        onSelectionPrevious={() => selectPendingOption("previous")}
        onSubmit={submitLine}
        pendingConfirmation={Boolean(pendingOperatorLine)}
        placeholder={connectPlaceholder}
        row={composerRow}
        selectionActive={Boolean(pendingSelection)}
        theme={t}
        value={activeFieldComposer ? connectComposerValue : inputValue}
        valueIsMasked={Boolean(activeFieldComposer)}
        selection={activeFieldComposer ? null : inputSelection}
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

  // Mirror Ink's `<Text wrap="wrap">` exactly: word-wrap each explicit (`\n`-split)
  // logical line with the same wrap-ansi call Ink uses. wrap-ansi with
  // { trim: false, hard: true } only INSERTS line breaks and preserves every other
  // character, so within a single logical line `subs.join("") === logical` — letting
  // us map the original cursor offset onto the wrapped rows by cumulative length.
  const logicalLines = value.split("\n");
  let displayRow = 0;
  let valueOffset = 0;

  for (let li = 0; li < logicalLines.length; li++) {
    const logical = logicalLines[li] ?? "";
    const subs = wrapAnsi(logical, width, { trim: false, hard: true }).split("\n");

    for (let si = 0; si < subs.length; si++) {
      const sub = subs[si] ?? "";
      const rowStart = valueOffset;
      const rowEnd = valueOffset + sub.length;
      const lastSubOfLine = si === subs.length - 1;
      // Place the cursor on this row when its offset is strictly inside the row, OR
      // exactly at the row's end AND this is the line's final wrapped row. At a SOFT
      // wrap boundary (end of a non-final sub) the offset belongs to the next word,
      // so we fall through to start that next row at column 0 — matching where Ink
      // continues the text. The explicit-`\n` boundary is handled by `lastSubOfLine`
      // (the offset before a real newline stays at the end of the current line).
      if (position < rowEnd || (position === rowEnd && lastSubOfLine)) {
        // Column uses displayWidth (the TUI's width source everywhere else); for
        // plain text it agrees with the string-width wrap-ansi used for the rows, so
        // the caret is exact. They diverge only for wide/emoji glyphs (e.g. ZWJ
        // sequences), where the caret column — and, at a width boundary, the
        // deferred-wrap row below — can be approximate. That is the pre-existing
        // displayWidth-vs-terminal-width gap, not the row drift this fix targets.
        let column = displayWidth(sub.slice(0, position - rowStart));
        let line = displayRow;
        // A cursor exactly at the end of a width-filled row shows at the start of the
        // next (deferred wrap) — preserves the long-standing exact-boundary behavior.
        if (column >= width) {
          line += 1;
          column = 0;
        }
        return { column, line };
      }
      valueOffset = rowEnd;
      displayRow += 1;
    }

    // Step over the explicit newline separating logical lines (not after the last).
    if (li < logicalLines.length - 1) {
      valueOffset += 1;
    }
  }

  // Cursor past the rendered content (defensive): park it on the last row.
  return { column: 0, line: Math.max(0, displayRow - 1) };
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

/**
 * Predict whether ink will take its fullscreen write branch for the current frame.
 *
 * ink@6.8 (`ink.js`) renders `outputToRender = isFullscreen ? output : output + "\n"`
 * where `isFullscreen = stdout.isTTY && outputHeight >= stdout.rows` and `outputHeight`
 * is the frame's LOGICAL line count. Its cursor helper (`cursor-helpers.js`) then parks
 * the native cursor with `cursorUp(visibleLineCount − y)` under the documented assumption
 * that the cursor sits "just after the last output line" — which only holds when that
 * trailing "\n" is written. In the fullscreen branch the bare `output` leaves the cursor
 * ON the last line, so the native cursor lands one row ABOVE the composer (a cursor-only
 * re-render compounds it to two). The defect is width-independent; a tall transcript (e.g.
 * a `/sync all` dump that pushes the frame to the terminal height) is what trips it.
 *
 * We can't change ink's branch, so we predict the same condition and suppress the native
 * cursor (falling back to the in-text caret, which renders on the correct row regardless).
 * `rowsAboveComposer` is `inkTranscriptRowCount({ showComposer: false })` (verified to equal
 * the rendered rows above the composer), `composerRows` is the composer's OWN wrapped row
 * span (NOT the literal 1 that `inkTranscriptRowCount` reserves), and `rowsBelowComposer`
 * covers anything ink counts in `outputHeight` after the composer (the completion menu —
 * the other overlays already force the native cursor off). Their sum mirrors ink's
 * `outputHeight`; the `− 1` keeps the gate biased to trip no later than ink's actual flip.
 */
export function wouldTriggerInkFullscreen({
  rowsAboveComposer,
  composerRows,
  rowsBelowComposer = 0,
  terminalRows
}: {
  rowsAboveComposer: number;
  composerRows: number;
  rowsBelowComposer?: number;
  terminalRows: number | undefined;
}): boolean {
  if (typeof terminalRows !== "number" || terminalRows <= 0) {
    return false;
  }
  return rowsAboveComposer + composerRows + rowsBelowComposer >= terminalRows - 1;
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
  completionRows,
  connectConfirmActive,
  cursor,
  fieldChoiceActive,
  fieldPromptActive,
  onChange,
  onChoiceCommit,
  onChoiceNext,
  onChoicePrevious,
  onCompletionAccept,
  onCompletionNext,
  onCompletionPrevious,
  onConnectCancel,
  onConnectConfirmAccept,
  onConnectConfirmNext,
  onConnectConfirmPrevious,
  onFieldBackspace,
  onFieldCommit,
  onFieldKey,
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
  valueIsMasked,
  width
}: {
  busy: boolean;
  completionActive: boolean;
  completionRows: number;
  connectConfirmActive: boolean;
  cursor: number;
  fieldChoiceActive: boolean;
  fieldPromptActive: boolean;
  onChange(state: ComposerEditState): void;
  onChoiceCommit(): void;
  onChoiceNext(): void;
  onChoicePrevious(): void;
  onCompletionAccept(): void;
  onCompletionNext(): boolean;
  onCompletionPrevious(): boolean;
  onConnectCancel(): void;
  onConnectConfirmAccept(): void;
  onConnectConfirmNext(): void;
  onConnectConfirmPrevious(): void;
  onFieldBackspace(): void;
  onFieldCommit(): void;
  onFieldKey(text: string): void;
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
  valueIsMasked?: boolean;
  width: number;
}) {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const forwardDelete = useForwardDeleteSignal();
  useInput((input, key) => {
    const editState = { cursor, selection, value };
    // In-chat /connect wizard (#20): Ctrl-C cancels the WIZARD ONLY (zeroizing the
    // secret) and must be guarded BEFORE the session-wide `app.exit()` below — a
    // bare Ctrl-C mid-wizard must not quit the whole session.
    if (key.ctrl && input === "c") {
      if (fieldPromptActive || connectConfirmActive) {
        onConnectCancel();
        return;
      }
      app.exit();
      return;
    }
    // Field-collection loop: every printable keystroke is routed to the wizard's
    // transient buffer (NEVER `inputValue`/the composer/submit), so a secret never
    // flows through any echoed/persisted path. Choice fields (the PostHog region
    // step) navigate with up/down + Enter; free-text fields type + Enter to commit.
    if (fieldPromptActive) {
      if (fieldChoiceActive) {
        if (key.return) {
          onChoiceCommit();
          return;
        }
        if (key.upArrow) {
          onChoicePrevious();
          return;
        }
        if (key.downArrow) {
          onChoiceNext();
          return;
        }
        return;
      }
      if (key.return) {
        onFieldCommit();
        return;
      }
      if (key.backspace || key.delete) {
        onFieldBackspace();
        return;
      }
      // Printable keys only (mirrors the composer's printable guard below). No
      // ctrl/meta chords reach the field buffer.
      if (input && !key.ctrl && !key.meta) {
        onFieldKey(input);
      }
      return;
    }
    // Final "Connect <Provider> / Cancel" step — a dedicated yes/no overlay whose
    // accept handler dispatches WITHOUT remembering or echoing the secret line.
    if (connectConfirmActive) {
      if (key.return) {
        onConnectConfirmAccept();
        return;
      }
      if (key.upArrow) {
        onConnectConfirmPrevious();
        return;
      }
      if (key.downArrow) {
        onConnectConfirmNext();
        return;
      }
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

  // In-chat /connect wizard (#20): a free-text field row uses a `?`-style prompt
  // and never the native cursor (the rendered `value` is already the masked bullets
  // string for secret fields, so there is no raw value to position a cursor in).
  const fieldRowActive = fieldPromptActive && !fieldChoiceActive;
  const overlayActive = selectionActive || connectConfirmActive || fieldRowActive;
  const label = pendingConfirmation ? "!" : overlayActive ? "?" : theme.brand.prompt;
  const promptWidth = displayWidth(`${label} `);
  const inputWidth = Math.max(1, width - promptWidth);
  // When the frame is tall enough to trip ink's fullscreen write branch, ink parks the
  // native cursor a row above the composer (see wouldTriggerInkFullscreen). Suppress the
  // native cursor there and let renderComposerValueWithCursor draw the in-text caret.
  // An open completion menu renders BELOW the composer and counts toward ink's outputHeight
  // (the other overlays already force the native cursor off), so include its rows here.
  const composerRows = composerCursorLayout(value, value.length, inputWidth).line + 1;
  const inkFullscreen = wouldTriggerInkFullscreen({
    rowsAboveComposer: row,
    composerRows,
    rowsBelowComposer: completionRows,
    terminalRows: stdout?.rows
  });
  const nativeCursor =
    !busy && !overlayActive && !valueIsMasked && !composerSelectedRange(value, selection)
    && Boolean(stdout?.isTTY) && !inkFullscreen;
  setCursorPosition(nativeCursor
    ? composerNativeCursorPosition({ cursor, label, row, value, width })
    : undefined);

  const content = fieldRowActive
    // Masked or plain field value with a trailing cursor — `value` already carries
    // bullets for a secret field, so the raw secret is never in the render tree.
    ? (value ? `${value}|` : placeholder)
    : value
      ? renderComposerValueWithCursor(value, cursor, selection, { nativeCursor })
      : placeholder;
  const color = value ? theme.color.text : theme.color.muted;

  return (
    <Box width={width}>
      <Text color={pendingConfirmation || overlayActive ? theme.color.warning : theme.color.primaryBright}>{label} </Text>
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

// In-chat /connect wizard (#20): the header + current-field overlay. Purely
// presentational — all key handling stays in the single `useInput` owner. For a
// secret free-text field the masked bullets render in the composer row below (this
// shows the guidance + a redacted hint); for a choice field (the PostHog region
// step) the options render here with a `>` cursor.
function ConnectWizard({
  active,
  maskedValue,
  theme,
  width
}: {
  active: { descriptor: ConnectSetupDescriptor; index: number; choiceIndex: number } | null;
  maskedValue?: string;
  theme: Theme;
  width: number;
}) {
  if (!active) {
    return null;
  }
  const field = active.descriptor.fields[active.index];
  if (!field) {
    return null;
  }
  const stepLine = `Step ${active.index + 1} of ${active.descriptor.fields.length} · ${field.label}${field.secret ? "  (hidden)" : ""}`;
  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.color.primaryBright}>
        {truncateCells(`Connect ${active.descriptor.label} — ${active.descriptor.description}`, width)}
      </Text>
      <Text color={theme.color.muted}>{truncateCells(`docs: ${active.descriptor.docsUrl}`, width)}</Text>
      <Text color={theme.color.text}>{truncateCells(stepLine, width)}</Text>
      {field.guidance ? (
        <Text color={theme.color.muted} wrap="wrap">{field.guidance}</Text>
      ) : null}
      {field.choices ? (
        field.choices.map((choice, index) => {
          const selected = index === active.choiceIndex;
          const marker = selected ? ">" : " ";
          const detail = choice.description ? ` — ${choice.description}` : "";
          return (
            <Text key={`${choice.value}-${index}`} color={selected ? theme.color.primaryBright : theme.color.text}>
              {truncateCells(`${marker} ${choice.label}${detail}`, width)}
            </Text>
          );
        })
      ) : field.secret && maskedValue ? (
        <Text color={theme.color.muted}>{truncateCells(`entered: ${maskedValue}`, width)}</Text>
      ) : null}
    </Box>
  );
}

// The final "Connect <Provider> / Cancel" overlay. Its accept handler
// (`acceptConnectConfirm`) is the dedicated, secret-safe dispatcher — this is purely
// presentational. No `option.line` carries the secret (unlike `SelectionMenu`).
function ConnectConfirmMenu({
  pending,
  theme,
  width
}: {
  pending: { descriptor: ConnectSetupDescriptor; selectedIndex: number } | null;
  theme: Theme;
  width: number;
}) {
  if (!pending) {
    return null;
  }
  const options = [`Connect ${pending.descriptor.label}`, "Cancel"];
  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.color.primaryBright}>
        {truncateCells(`Connect ${pending.descriptor.label} as "${pending.descriptor.connectionName}"?`, width)}
      </Text>
      {options.map((label, index) => {
        const selected = index === pending.selectedIndex;
        const marker = selected ? ">" : " ";
        return (
          <Text key={`${label}-${index}`} color={selected ? theme.color.primaryBright : theme.color.text}>
            {truncateCells(`${marker} ${label}`, width)}
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
