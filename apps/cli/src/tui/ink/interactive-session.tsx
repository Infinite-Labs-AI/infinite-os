import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stdin as defaultInput, stderr as defaultErrorOutput, stdout as defaultOutput } from "node:process";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// The composer value renders in `<Text wrap="wrap">` (see InkLineInput), and Ink's
// wrap="wrap" word-wraps via `wrapAnsi(text, width, { trim: false, hard: true })`
// (ink/build/wrap-text.js). The native-cursor row prediction MUST use the SAME
// wrap so it never lands a row off the line the user is typing on — char-by-char
// width accumulation (a different, tighter packing) drifts from Ink's word-wrap.
import wrapAnsi from "wrap-ansi";
import { Box, Text, render, renderToString, useApp, useCursor, useInput, useStdin, useStdout } from "./renderer.js";

import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import type { ApprovalFieldAnswerV1, CreativeDraftFrameV1, ToolViewFrameV1 } from "@infinite-os/types";
import type { Key } from "ink";

// Type-only import (erased at build, no runtime cycle): the in-chat /connect
// wizard descriptor + decision are owned by index.ts (which owns the registry /
// copy / dispatch helpers). The TUI only renders them and drives raw-mode input.
import type {
  ConnectSetupDescriptor,
  ConnectWizardDecision,
  ConnectWizardField
} from "../../index.js";

// The in-session write-confirmation action (redacted upstream) + the summary
// sanitizer. The Ink confirmation overlay (FIX B) is the DEFAULT TTY surface's
// write gate; it mirrors the readline handler's terminal-injection defense by
// scrubbing the (un-redacted) summary through `terminalText` before rendering.
// The cloud-brain entry threads `pendingConfirmations` + `onConfirmAction` in;
// the LOCAL interactive path never returns them, so this stays fully dormant.
import {
  requeueConfirmation,
  terminalText,
  type InSessionConfirmationAction
} from "../../desktop/confirm-in-session.js";
import { confirmErrorLines, confirmResultLines, type ConfirmLine } from "../../desktop/confirm-result-lines.js";

import { turnController } from "../app/turn-controller.js";
import {
  clearTurnViews,
  getTurnState,
  recordCreativeDraft,
  recordTurnView,
  subscribeTurnState,
  type TurnState
} from "../app/turn-store.js";
import { TYPING_IDLE_MS } from "../config/timing.js";
import { displayWidth, truncateCells } from "../lib/display-width.js";
import { detectTerminalBackground } from "../style/background.js";
import { drawsToTerminal, syncInkColorLevel } from "../style/ink-level.js";
import { colorEnabled, resolveTheme, themeInkStyle, type Theme } from "../theme.js";
import type { Msg } from "../types.js";
import {
  HomeInventory,
  homeInventoryRowCount,
  type HomeInventoryCommand,
  type HomeInventoryConnection,
  type HomeInventoryTool
} from "./home-inventory.js";
import { formatBusyNote, isInfiniteTurnBusy } from "./status-indicator.js";
import { createTurnAbort, ctrlCAction, turnStoppedLine, type TurnAbort } from "./turn-abort.js";
import { confirmCardKeys, keyBarHints, keyBarRowCount, resolveKey, type KeyAction, type KeyContext } from "../keys/keymap.js";
import { KeyBar } from "./key-bar.js";
import { COMPOSER_PLACEHOLDER, composerPlaceholderText } from "./composer-line.js";
import { ruleLine, type TopBarData } from "./top-bar.js";
import {
  AnsiLine,
  inkLatestTurnRows,
  inkTranscriptLayout,
  InkTranscriptApp,
  renderCommittedTranscriptLines,
  transcriptColumns,
  useInfiniteTranscriptClock
} from "./transcript-app.js";
import {
  commitOnSubmit,
  DEFAULT_COMPOSER_ROWS,
  DEFAULT_KEY_BAR_ROWS,
  livePageKey,
  MIN_LIVE_REGION_ROWS,
  pageLiveWindow,
  type CommittedEntry,
  type LivePageDirection
} from "./transcript-static.js";
import { useTerminalColumns, useTerminalRows } from "./terminal-columns.js";
import { resolveViewKey, turnAsk, viewFocusAfterTurnDone, viewKeyHints, type ViewFocusState } from "../views/focus.js";
import { clipboardSequence, copyTargets, copyThroughPbcopy } from "../views/clipboard.js";
import { renderLiveTurn, type LiveTurnRender } from "../views/layout.js";
import {
  approvalRender,
  cancelCardField,
  CARD_UI_START,
  cardKeyStep,
  cardUiStart,
  commitCardField,
  receiptDetailLines,
  resendView,
  type ApprovalRender,
  type CardUiState
} from "../views/approval.js";
import { creativeDraftLine } from "../views/images.js";

/**
 * The first-run inventory shown above the boot frame on the empty home screen
 * (the big wordmark + Tools / Commands / Connected + welcome), only on the
 * first-ever run (D4: every later boot is the r4 frame alone). Supplied by the
 * CLI (`index.ts`) so the registry / curated lists / live source fetch stay
 * there; the TUI only renders it. Absent (`undefined`) = no inventory.
 */
export interface HomeInventoryData {
  tools: readonly HomeInventoryTool[];
  commands: readonly HomeInventoryCommand[];
  /** `undefined` = the terminal cannot list them (see `connectionsNote`). */
  connections?: readonly HomeInventoryConnection[];
  /** Why `connections` is undefined, in a few words (the daemon is down, the read failed); absent = no Connected row. */
  connectionsNote?: string;
  version?: string;
  workspace?: string;
}

const HISTORY_LIMIT = 120;
const INPUT_HISTORY_LIMIT = 1000;
// No app-link, watch or retry keys yet (T12 adds `o`; T11 adds `w`/`r`).
const NO_KEY_CAPS: KeyContext["caps"] = { open: false, watch: false, retry: false };
const BRACKETED_PASTE_MARKER_RE = /\x1b?\[20[01]~/g;
const INVERSE_OFF = "\u001b[27m";
const INVERSE_ON = "\u001b[7m";
const ESC = "\u001b";
const BLINKING_BLOCK_CURSOR = `${ESC}[1 q`;
const STEADY_BLOCK_CURSOR = `${ESC}[2 q`;
const DEFAULT_CURSOR_STYLE = `${ESC}[0 q`;
const FWD_DEL_RE = new RegExp(`${ESC}\\[3(?:[~$^]|;)`);
const PRINTABLE_INPUT_RE = /^[ -~\u00a0-\uffff]+$/;
const TAB_PATH_RE = /((?:["']?(?:[A-Za-z]:[\\/]|\.{1,2}\/|~\/|\/|@|[^"'`\s]+\/))[^\s]*)$/;
const QUEUED_PREVIEW_LIMIT = 50;
/** The rule over the composer (terminal-r4: `─` across, then `❯ Ask Infinite…`). */
const COMPOSER_RULE_ROWS = 1;

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
  // The (already-redacted) write actions a cloud-brain turn's terminal frame
  // surfaced as `requires_confirmation`. When present, the component arms the
  // in-session `ConfirmActionMenu` write gate (y/N) AFTER the turn's answer is
  // rendered; on approve it drives `onConfirmAction`. Mirrors the plain-path
  // `pendingConfirmations` loop in `runDesktopInteractive`. The LOCAL path never
  // sets this, so the gate stays dormant for it. (Plan 2)
  pendingConfirmations?: readonly InSessionConfirmationAction[];
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
  /**
   * Test-only width override. When absent, the session draws at the live
   * terminal width and redraws on every resize (`useTerminalColumns`).
   */
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
  /**
   * The first-run inventory (big wordmark + Tools / Commands / Connected +
   * welcome) shown ONCE on the empty home screen, above the boot frame. The CLI
   * passes it only on the first-ever run (D4). Omitted = the boot frame alone.
   */
  homeInventory?: HomeInventoryData;
  initialInputCursor?: number;
  initialInputSelection?: ComposerSelection | null;
  initialInputValue?: string;
  initialInputHistory?: readonly string[];
  initialMessages?: readonly Msg[];
  /** Write cards already waiting when the session opens (tests draw a card with it). */
  initialPendingConfirmations?: readonly InSessionConfirmationAction[];
  onRememberInput?: (line: string) => void;
  /**
   * Run one submitted line. `signal` aborts when the user stops the turn (Esc,
   * or Ctrl-C while a turn runs); only honoured when `turnStoppable` is set.
   * `onView` takes each answer view (`tool.view` frame) the turn produces; the
   * finished turn then draws them beside its answer (terminal-r4 layout).
   * `onCreativeDraft` takes each image-draft frame, drawn as one progress line
   * per run ("Drawing 3 images · ~25 s"); never a picture or an image URL.
   */
  onSubmitLine(
    line: string,
    onProgress: (event: ChatProgressEvent) => void,
    signal: AbortSignal,
    onView?: (frame: ToolViewFrameV1) => void,
    onCreativeDraft?: (frame: CreativeDraftFrameV1) => void
  ): Promise<InkInteractiveLineResult>;
  /**
   * Resolve an in-session write confirmation surfaced by a turn's
   * `pendingConfirmations`. Calls the Desktop client's `confirm(...)` for the
   * decision (approve or a real decline) and resolves with its raw result,
   * which the session prints as receipt lines (`confirmResultLines`). Only the cloud-brain entry wires this; the LOCAL interactive path
   * never returns `pendingConfirmations`, so it is never invoked there. (Plan 2)
   * `fields` carries the card's answered fields (a daily budget), sent only to
   * a Desktop that takes them (`confirmFieldsCapable` on the card).
   */
  onConfirmAction?(
    action: InSessionConfirmationAction,
    decision: "approve" | "decline",
    fields?: Record<string, ApprovalFieldAnswerV1>
  ): Promise<unknown>;
  /**
   * The running turn's own short reason, said in the composer's note in place
   * of the generic `working · 4s` (terminal-r4 `❯ Ask Infinite… (the pause
   * finishes either way)`). Read on every render; shown only while a turn runs.
   */
  busyNote?: string | (() => string | undefined);
  /** The composer's placeholder. Default `Ask Infinite…` (terminal-r4). */
  promptPlaceholder?: string;
  requiresConfirmation?: (line: string) => string | undefined;
  requiresSelection?: (line: string) => InkInteractiveSelectionPrompt | undefined;
  /**
   * Test-only height override. When absent, the live region is capped by the live
   * terminal height (`useTerminalRows`; no cap when the output is not a TTY).
   * `null` = no cap.
   */
  rows?: number | null;
  /** Not drawn: the r4 frame has no status line (the composer carries the busy note). */
  status?: readonly string[] | (() => readonly string[]);
  theme?: Theme;
  /** Not drawn: the r4 top bar shows the brand chip. */
  title?: string;
  /**
   * The top bar's workspace and sources (D1), read on every render so a
   * `/project use` shows at once. Absent = the brand chip alone.
   */
  topBar?: TopBarData | (() => TopBarData | undefined);
  /**
   * The caller honours `onSubmitLine`'s abort signal, so Esc stops the running
   * turn and Ctrl-C stops it instead of quitting. Off (the local path, whose
   * turns cannot be aborted): Esc does nothing and Ctrl-C quits, as before.
   */
  turnStoppable?: boolean;
}

export interface InkInteractiveSessionRunOptions extends InkInteractiveSessionAppProps {
  errorOutput?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function runInkInteractiveSession(options: InkInteractiveSessionRunOptions): Promise<void> {
  // No `columns` fallback to `output.columns` here: that froze the width at launch.
  // The app follows the live width itself; `options.columns` stays a test override.
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const onTerminal = drawsToTerminal(input) && drawsToTerminal(output);
  // Before Ink mounts: a light profile gets the 16 tier (OSC 11 probe, SPEC §3.2).
  if (onTerminal && !options.theme) {
    await detectTerminalBackground(process.env, input, output);
  }
  // On a real terminal, Ink's chalk paints at our tier, not the level it sniffed.
  const restoreColorLevel = onTerminal ? syncInkColorLevel((options.theme ?? resolveTheme()).tier) : () => {};
  try {
    const instance = render(
      <InkInteractiveSessionApp {...options} />,
      {
        exitOnCtrlC: false,
        patchConsole: false,
        stderr: options.errorOutput ?? defaultErrorOutput,
        stdin: input,
        stdout: output
      }
    );

    await instance.waitUntilExit();
  } finally {
    restoreColorLevel();
  }
}

export function renderInkInteractiveSessionToString(
  props: InkInteractiveSessionAppProps,
  options: { columns?: number } = {}
): string {
  // A string render has no terminal to follow, so it always pins a width (88 by
  // default) instead of reading whatever stream `useStdout` falls back to.
  // Likewise no live height: uncapped unless the caller pins `rows`.
  const columns = props.columns ?? options.columns ?? 88;
  return renderToString(<InkInteractiveSessionApp {...props} columns={columns} rows={props.rows ?? null} />, { columns });
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
  columns: columnsOverride,
  connectWizard,
  buildConnectDispatch,
  getAgentTitle,
  getCompletions,
  homeInventory,
  initialInputCursor,
  initialInputSelection,
  initialInputValue = "",
  initialInputHistory = [],
  initialMessages = [],
  initialPendingConfirmations = [],
  onRememberInput,
  onSubmitLine,
  onConfirmAction,
  busyNote,
  promptPlaceholder = COMPOSER_PLACEHOLDER,
  requiresConfirmation,
  requiresSelection,
  rows: rowsOverride,
  theme,
  topBar,
  turnStoppable = false
}: InkInteractiveSessionAppProps) {
  const app = useApp();
  const { stdout: sessionStdout } = useStdout();
  const t = theme ?? resolveTheme();
  // One turn-abort per session: each turn arms a fresh signal (Esc / Ctrl-C
  // stop it) and disarms it when the turn settles.
  const [turnAbort] = useState<TurnAbort>(() => createTurnAbort());
  const liveColumns = useTerminalColumns(88);
  const columns = columnsOverride ?? liveColumns;
  const liveRows = useTerminalRows();
  const rows = rowsOverride === undefined ? liveRows : rowsOverride ?? undefined;
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
  // `history` holds only the LIVE latest turn. Finished turns move to
  // `committed` (printed once through <Static>) when the next line is submitted;
  // see transcript-static.ts.
  const [history, setHistory] = useState<readonly Msg[]>(initialMessages);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [committed, setCommitted] = useState<readonly CommittedEntry[]>([]);
  const [homeCommitted, setHomeCommitted] = useState(false);
  const turnSeq = useRef(0);
  // First visible line of a paged live turn; null = follow the tail.
  const [liveOffset, setLiveOffset] = useState<number | null>(null);
  const [pendingOperatorLine, setPendingOperatorLine] = useState<string | null>(null);
  // FIFO of cloud-brain write confirmations awaiting a y/N decision. The head is
  // rendered by `ConfirmActionMenu`; resolving it (approve → `onConfirmAction`,
  // decline → a note) shifts the head. A non-empty queue BLOCKS the next line the
  // same way `pendingSelection` / `pendingOperatorLine` do (see the drain gate).
  // Stays empty for the LOCAL path (which never surfaces `pendingConfirmations`).
  const [pendingConfirmActions, setPendingConfirmActions] = useState<
    readonly InSessionConfirmationAction[]
  >(initialPendingConfirmations);
  // `?` on the head card toggles its explanation (the terminal can't hover).
  const [explainOpen, setExplainOpen] = useState(false);
  // A head card WITH an approval view keeps its own key state (views/approval.ts):
  // `?`, the open document, its tab and page, and the field answers so far.
  const [cardUi, setCardUi] = useState<CardUiState>(CARD_UI_START);
  // The latest finished turn's answer views keep their keys (j/k, 1–9, →, m, ?)
  // until the next line is submitted (views/focus.ts). The views themselves live
  // in the turn store (`turnState.views`), cleared when the turn commits.
  const [viewFocus, setViewFocus] = useState<ViewFocusState | null>(null);
  const viewFocusRef = useRef(viewFocus);
  viewFocusRef.current = viewFocus;
  // The rows the live turn was last drawn to, so the turn commits to scrollback
  // with the same document pages the user was reading.
  const liveTurnRowsRef = useRef<number | undefined>(undefined);
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
    // New lines in the live turn (a receipt, a note) are shown: follow the tail.
    setLiveOffset(null);
  }, []);

  const topBarData = typeof topBar === "function" ? topBar() : topBar;
  // Live label for the in-flight answer; completed messages carry their own
  // frozen `title` (stamped at submit) so a mid-session `/project use` never
  // relabels earlier answers.
  const agentTitle = getAgentTitle?.();
  // The latest turn stays live (its keys still act on it) until the NEXT line is
  // submitted; only then is it printed once into scrollback through <Static>, at
  // the current width. The home inventory goes with the first commit.
  const commitLatestTurn = useCallback((line: string) => {
    if (!line.trim()) {
      return;
    }
    const turn = historyRef.current;
    const views = getTurnState().views;
    // A turn with answer views commits in the same two-pane layout it was shown in.
    const latest: CommittedEntry | null = turn.length || views.length
      ? {
          id: `turn:${++turnSeq.current}`,
          lines: views.length
            ? renderLiveTurn({
                messages: turn,
                views: views.map((frame) => frame.view),
                focus: viewFocusRef.current,
                width: transcriptColumns(columns),
                color: colorEnabled(t),
                theme: t,
                rows: liveTurnRowsRef.current
              }).lines
            : renderCommittedTranscriptLines({ agentTitle, messages: turn }, { columns, theme: t })
        }
      : null;
    const home: CommittedEntry | null = homeInventory && !homeCommitted && turn.length === 0
      ? {
          id: "home",
          lines: [],
          node: (
            <HomeInventory
              columns={columns}
              commands={homeInventory.commands}
              connections={homeInventory.connections}
              connectionsNote={homeInventory.connectionsNote}
              theme={t}
              tools={homeInventory.tools}
              version={homeInventory.version}
              workspace={homeInventory.workspace}
            />
          )
        }
      : null;
    setCommitted((current) => commitOnSubmit({ committed: home ? [...current, home] : current, latest }, line).committed);
    setHomeCommitted(true);
    historyRef.current = [];
    setHistory([]);
    clearTurnViews();
    setViewFocus(null);
    setLiveOffset(null);
  }, [agentTitle, columns, homeCommitted, homeInventory, t]);

  // Every way out of the session (/exit, /quit, a result's `exit`, idle Ctrl-C)
  // commits the live turn to <Static> first, uncapped, at the current width, and
  // only unmounts in the effect after that render: Ink's final frame holds just
  // the visible page, so quitting straight away would lose the rest of the answer.
  const [exitRequested, setExitRequested] = useState(false);
  const requestExit = useCallback(() => {
    commitLatestTurn("/exit");
    setExitRequested(true);
  }, [commitLatestTurn]);
  useEffect(() => {
    if (exitRequested) {
      app.exit();
    }
    // `committed` and `exitRequested` change in the same batched render, so by
    // the time this runs Ink has already written the Static flush.
  }, [app, exitRequested]);

  const transcript = useMemo(() => ({
    agentTitle,
    messages: history,
    state: turnState
  }), [agentTitle, history, turnState]);
  // A finished turn with answer views is drawn in the r4 layout (answer left,
  // details right, Steps below) as the live region's latest lines, at the
  // transcript's width; the transcript then carries only the idle turn state.
  // While a turn runs its views collect in the turn store and the transcript
  // renders as it always has.
  //
  // The turn is drawn to the rows the live region has for it (`turnRowsAt`,
  // below, once the composer and the key bar are counted), so a document's
  // page fits on screen. `renderTurnAt` draws it at a given row count, cached
  // for this set of inputs.
  const turnViews = turnState.views;
  const renderTurnAt = useMemo(() => {
    if (busy || !turnViews.length) {
      return null;
    }
    const cache = new Map<number | undefined, LiveTurnRender>();
    return (turnRows: number | undefined): LiveTurnRender => {
      const hit = cache.get(turnRows);
      if (hit) {
        return hit;
      }
      const drawn = renderLiveTurn({
        messages: history,
        views: turnViews.map((frame) => frame.view),
        focus: viewFocus,
        width: transcriptColumns(columns),
        color: colorEnabled(t),
        theme: t,
        rows: turnRows
      });
      cache.set(turnRows, drawn);
      return drawn;
    };
  }, [busy, columns, history, t, turnViews, viewFocus]);
  const idleTranscript = useMemo(
    () => ({ agentTitle, messages: [], state: turnState }),
    [agentTitle, turnState]
  );
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
  const { clock } = useInfiniteTranscriptClock({ busy: transcriptBusy });
  // The composer's note while a turn runs (terminal-r4 `❯ Ask Infinite… (note)`):
  // that it is working and for how long, then any line queued behind it. No
  // status line and no session id (r4 has neither).
  // A turn that gives its own short reason says that instead of `working`.
  const busyReason = transcriptBusy
    ? (typeof busyNote === "function" ? busyNote() : busyNote)?.trim() || null
    : null;
  const composerNote = [
    busyReason ?? (busy ? formatBusyNote({ nowMs: clock, state: turnState, turnStartedAt: busyStartedAt }) : null),
    ...formatQueuedStatus(queuedLines)
  ].filter((part): part is string => Boolean(part)).join(" · ");
  // The head card's keys: its named OK key, `n`, and `?` (keymap.ts owns the rules).
  // `o`/`w`/`r` stay off until app links, watch and retry land (T12, T11).
  const headConfirmAction = pendingConfirmActions[0] ?? null;
  const confirmKeys = useMemo(
    () => headConfirmAction ? confirmCardKeys(headConfirmAction, NO_KEY_CAPS) : null,
    [headConfirmAction]
  );
  // A new head card (from any queue writer) always opens with its explanation
  // closed: the explanation stays behind `?`.
  // A card brought back opens with the answers it sent; a card whose answer
  // the app refused opens with the app's words under its field.
  // A layout effect, so the reset lands in the same task as the frame that
  // shows the card: a key pressed on the card the moment it appears (`v`)
  // is never undone by a late reset.
  useLayoutEffect(() => {
    setExplainOpen(false);
    setCardUi(cardUiStart(headConfirmAction));
  }, [headConfirmAction]);
  // The head card drawn from its approval view (an old desktop sends none: the
  // summary + details card and `y Confirm` stay). Its key context is the one the
  // keymap resolves with, so the bar and the keys agree by construction.
  // Image drafts in progress this turn, one line per run ("Drawing 3 images ·
  // ~25 s"), above the card and the composer. Never a picture or a URL.
  const draftLines = useMemo(
    () => turnState.drafts.map((draft) => creativeDraftLine(draft, clock)),
    [clock, turnState.drafts]
  );
  // The home inventory shows ONCE, on the empty home screen (no transcript yet)
  // and only when the CLI supplied its data. The first submitted line commits it
  // into scrollback with the first turn (`commitLatestTurn`), so it never repeats.
  const showHomeInventory = Boolean(homeInventory) && !homeCommitted && history.length === 0;
  // The card's row budget: the window less everything else the frame draws
  // (the home inventory, the composer, the drafts, the key bar, the live
  // region's floor and the 2-row margin `liveRegionCap` keeps). A taller card
  // pages its middle, so the frame never reaches the window height and Ink
  // never takes its fullscreen path (which clears the user's scrollback).
  const cardRowsAround = rows
    ? (showHomeInventory ? homeInventoryRowCount(columns, homeInventory) : 0)
      + COMPOSER_RULE_ROWS
      + Math.max(DEFAULT_COMPOSER_ROWS, composerRowsFor(inputValue, columns, t))
      + draftLines.length
      + 2
      + MIN_LIVE_REGION_ROWS
    : null;
  const headCard = useMemo<ApprovalRender | null>(() => {
    if (!headConfirmAction?.view || !isPlainRecord(headConfirmAction.view.approval)) {
      return null;
    }
    const view = headConfirmAction.view;
    const drawAt = (keyBarRows: number) => approvalRender(view, {
      width: columns,
      color: colorEnabled(t),
      theme: t,
      selected: 0,
      tab: cardUi.tab,
      page: cardUi.page,
      explainOpen: cardUi.explainOpen,
      showHiddenColumns: false,
      caps: NO_KEY_CAPS,
      ui: cardUi,
      fieldsCapable: headConfirmAction.confirmFieldsCapable === true,
      ...(headConfirmAction.sentFields ? { sentFields: headConfirmAction.sentFields } : {}),
      pageRows: rows ? Math.max(4, Math.floor(rows / 3)) : undefined,
      ...(rows && cardRowsAround !== null
        ? { maxRows: Math.max(CARD_MIN_ROWS, rows - cardRowsAround - keyBarRows) }
        : {})
    });
    // The bar's hints come from the drawn card ("space next page"), so draw,
    // count the bar, and draw again when its height differs from the guess.
    let drawn = drawAt(DEFAULT_KEY_BAR_ROWS);
    const barRows = keyBarRowCount(drawn.keys, columns);
    if (barRows > DEFAULT_KEY_BAR_ROWS) {
      drawn = drawAt(barRows);
    }
    return drawn;
  }, [cardRowsAround, cardUi, columns, headConfirmAction, rows, t]);
  const cardKeyCtx = headCard ? headCard.keyCtx : confirmKeys?.ctx ?? null;
  // While a card field is being typed, the composer takes the keys (Enter sets
  // the value, Esc cancels it); the card itself takes none.
  const cardFieldActive = Boolean(headCard && cardUi.fieldEntry);
  // With no card, the latest turn's views offer their keys while the composer is
  // empty (views/focus.ts: only what works on the focused view). Otherwise the
  // bar is the composer's: `esc stop` while a stoppable turn runs (the only key
  // that works then), nothing when idle.
  const keyHintsFor = (turn: LiveTurnRender | null) => {
    const viewHints = turn?.focused && viewFocus && !confirmKeys && inputValue.length === 0
      && !pendingSelection && !pendingOperatorLine && !pendingFieldPrompt
      ? viewKeyHints(viewFocus, turn.focused.facts, turn.focused.render.keys)
      : [];
    return headCard
      ? headCard.keys
      : confirmKeys
        ? keyBarHints(confirmKeys.ctx)
        : viewHints.length
          ? viewHints
          : keyBarHints({ focus: "composer", busy: busy && turnStoppable, okKey: null, caps: NO_KEY_CAPS });
  };
  // The home inventory shows ONCE, on the empty home screen (no transcript yet)
  // and only when the CLI supplied its data. The first submitted line commits it
  // into scrollback with the first turn (`commitLatestTurn`), so it never repeats.
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
    const signal = turnAbort.start();

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
      }, signal, recordTurnView, recordCreativeDraft);

      if (result.exit) {
        requestExit();
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
      // A cloud-brain turn may surface `requires_confirmation` write actions
      // (already redacted upstream). Arm the in-session y/N gate AFTER the
      // answer is rendered; the drain gate holds the next line until the queue
      // empties. Absent (LOCAL path / no writes) this is a no-op.
      if (result.pendingConfirmations && result.pendingConfirmations.length > 0) {
        setPendingConfirmActions(result.pendingConfirmations);
      }
    } catch (error) {
      // A stopped turn rejects with whatever the transport makes of the abort
      // (the desktop client maps it to a "detached" error), so read the stop
      // from the signal's reason, not from the rejection.
      const stoppedLine = turnStoppedLine(signal.aborted ? signal.reason : error);
      if (stoppedLine) {
        // Keep what the stopped turn already showed (its partial answer and
        // tool trail, running tools marked stopped) before reset() clears it:
        // the stop line says app work may still finish, so the user must still
        // see which tools were running.
        const partial = turnController.stoppedTranscript();
        if (partial.length) {
          appendMessages(stampAgentTitle(partial, turnTitle));
        }
      }
      appendMessages([{
        kind: "slash",
        role: "system",
        text: stoppedLine ?? `error: ${error instanceof Error ? error.message : String(error)}`
      }]);
    } finally {
      turnAbort.end(signal);
      turnController.reset();
      setBusy(false);
      setBusyStartedAt(undefined);
      // A finished turn opens at its top; a tall one is paged from there.
      setLiveOffset(0);
      // Its views stay live and take their keys until the next line is submitted.
      const views = getTurnState().views;
      setViewFocus(views.length ? viewFocusAfterTurnDone(views.map((frame) => frame.view), NO_KEY_CAPS) : null);
    }
  }, [appendMessages, getAgentTitle, onSubmitLine, requestExit, turnAbort]);

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
        text: `Nothing to collect for ${descriptor.label}. Run \`infinite local connect ${descriptor.provider}\` in your terminal.`
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
    commitLatestTurn(line);
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
  }, [appendMessages, commitLatestTurn, connectWizard, pendingOperatorLine, requiresConfirmation, requiresSelection, startConnectWizard, submitExecutableLine]);

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

  // Resolve the head write confirmation. Dequeue FIRST (dismisses the overlay and
  // guards against a double-resolve of the same single-use handle), then send the
  // decision through `onConfirmAction` (the Desktop `client.confirm`): a decline
  // is a real "no" that reaches the app's ledger, not a local note. Either way
  // the transcript gets receipt lines (the app's receipt sentence, scrubbed),
  // never JSON; a confirm that throws gets its error lines instead.
  const resolveConfirmAction = useCallback((
    decision: "approve" | "decline",
    fields?: Record<string, ApprovalFieldAnswerV1>
  ) => {
    const head = pendingConfirmActions[0];
    if (!head) {
      return;
    }
    setPendingConfirmActions((current) => current.slice(1));
    const appendLines = (lines: readonly ConfirmLine[]) =>
      appendMessages(lines.map((line) => ({ kind: "slash", role: "system", text: line.text }) as Msg));
    // An answer the app refused before anything ran (`field_invalid`): the card
    // comes back in front with the app's words, for a corrected value.
    const refusedField = (outcome: unknown): boolean => {
      const message = decision === "approve" ? fieldInvalidMessage(outcome) : null;
      if (message === null) return false;
      setPendingConfirmActions((current) => requeueConfirmation(current, withoutSent(head, message), "front"));
      return true;
    };
    // Not sure it happened: when the app says a resend is safe (it dedupes) or
    // nothing ran for certain (the handle is live again), the card comes back
    // behind the card the user is on, offering OK again (`safe_resend`) or `r`
    // (`retryable`) with exactly the answers this approve sent. Otherwise a
    // receipt that is not all done shows its object (a launch's ✓/✗/? items).
    const afterReceipt = (outcome: unknown) => {
      const resend = decision === "approve" ? resendView(head.view, outcome) : null;
      if (resend) {
        const back: InSessionConfirmationAction = { ...withoutSent(head), view: resend, ...(fields ? { sentFields: fields } : {}) };
        setPendingConfirmActions((current) => requeueConfirmation(current, back, "behind_head"));
        return;
      }
      const detail = receiptDetailLines(outcome, {
        width: Math.max(8, columns - 4),
        color: false,
        theme: t,
        selected: 0,
        tab: 0,
        page: 0,
        explainOpen: false,
        showHiddenColumns: false,
        caps: NO_KEY_CAPS
      });
      if (detail.length) {
        appendMessages(detail.map((text) => ({ kind: "slash", role: "system", text: `  ${text}` }) as Msg));
      }
    };
    void (async () => {
      try {
        const result = await onConfirmAction?.(head, decision, fields);
        if (refusedField(result)) {
          appendLines(confirmErrorLines(Object.assign(new Error(fieldInvalidMessage(result) ?? ""), { code: "field_invalid" })));
          return;
        }
        appendLines(confirmResultLines(result, decision));
        afterReceipt(result);
      } catch (error) {
        appendLines(confirmErrorLines(error));
        if (!refusedField(error)) afterReceipt(error);
      }
    })();
  }, [appendMessages, columns, onConfirmAction, pendingConfirmActions, t]);

  // One key on the head card, already resolved by the keymap. With an approval
  // view the card's own step decides (views/approval.ts); an old desktop's card
  // knows only OK, `n` and `?`.
  const handleCardAction = useCallback((action: KeyAction) => {
    if (!headCard) {
      if (action.type === "ok") {
        resolveConfirmAction("approve");
      } else if (action.type === "dismiss") {
        resolveConfirmAction("decline");
      } else if (action.type === "explain") {
        setExplainOpen((open) => !open);
      }
      return;
    }
    const step = cardKeyStep(action, headCard, cardUi);
    setCardUi(step.ui);
    if (step.effect?.type === "confirm") {
      resolveConfirmAction(step.effect.decision, step.effect.fields);
    } else if (step.effect?.type === "close") {
      // A card already answered (not sure it happened): `n` only closes it here.
      // The app was told once; nothing more is sent.
      setPendingConfirmActions((current) => current.slice(1));
      appendMessages([{ kind: "slash", role: "system", text: "Closed — nothing more was sent." }]);
    }
  }, [appendMessages, cardUi, headCard, resolveConfirmAction]);

  // Enter while a card field is open sets its value (never approves); a value
  // that does not fit keeps the field open with a hint.
  const commitCardFieldValue = useCallback((value: string) => {
    setCardUi((ui) => commitCardField(ui, value).ui);
    setInputValue("");
    setInputCursor(0);
    setInputSelection(null);
  }, []);

  useEffect(() => {
    // Don't drain a queued line while a /connect wizard is active — its keystrokes
    // are routed to the field buffer, and a drained line must not pre-empt it.
    if (
      busy ||
      pendingOperatorLine ||
      pendingSelection ||
      pendingFieldPrompt ||
      pendingConnectConfirm ||
      pendingConfirmActions.length > 0 ||
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
  }, [busy, pendingConfirmActions, pendingConnectConfirm, pendingFieldPrompt, pendingOperatorLine, pendingSelection, queuedLines, runSubmittedLine]);

  const submitLine = useCallback((rawLine: string) => {
    if (cardFieldActive) {
      // The line is the card field's value, not a message (and never history).
      commitCardFieldValue(rawLine);
      return;
    }
    const line = rawLine.trim();
    setInputValue("");
    setInputCursor(0);
    setInputSelection(null);

    if (!line) {
      return;
    }
    if (line === "/exit" || line === "/quit") {
      requestExit();
      return;
    }

    if (busy) {
      queueBusyLine(line);
      return;
    }

    rememberInputLine(line);
    runSubmittedLine(line);
  }, [busy, cardFieldActive, commitCardFieldValue, queueBusyLine, rememberInputLine, requestExit, runSubmittedLine]);

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
  // The placeholder is `Ask Infinite…` (with the busy note while a turn runs).
  // A card's keys and `esc stop` live in the key bar only (D6: never twice);
  // the pickers, the /connect fields and the operator confirm keep the words
  // that say how to answer them.
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
          : composerPlaceholderText(promptPlaceholder, composerNote);

  // The live frame's row budget. The home inventory renders ABOVE the transcript,
  // so its rows go into the composer's native-cursor row prediction (the PR #27
  // invariant: predicted composer row == live rendered row count); committed
  // <Static> rows never do. Everything the frame draws besides the transcript is
  // reserved out of the live-region cap, so the frame never fills the window.
  const homeInventoryRows = showHomeInventory ? homeInventoryRowCount(columns, homeInventory) : 0;
  // The key bar is the LAST row, under the composer (one row: it is cut, never
  // wrapped). Its row goes to the live-region cap through its own `keyBarRows`
  // slot; it is below the composer, so never into the composer-row prediction.
  // The rule over the composer is reserved with the composer.
  const composerText = activeFieldComposer ? activeFieldComposer.display : inputValue;
  const reservedRows = homeInventoryRows
    + COMPOSER_RULE_ROWS
    + Math.max(DEFAULT_COMPOSER_ROWS, composerRowsFor(composerText || connectPlaceholder, columns, t))
    + liveOverlayRows({
      confirmAction: pendingConfirmActions[0] ?? null,
      confirmCardRows: headCard ? headCard.lines.length : null,
      confirmExplain: explainOpen ? confirmKeys?.explainText ?? null : null,
      draftRows: draftLines.length,
      connectConfirm: Boolean(pendingConnectConfirm),
      field: fieldPromptActive && pendingFieldPrompt ? pendingFieldPrompt : null,
      selection: pendingSelection?.prompt ?? null,
      width: columns
    })
    + completions.length;
  // The rows the latest turn may take: the live budget (the same count the
  // live window pages with) less the key bar. The key bar's hints come from the
  // drawn turn (a document's `space next page`), so draw, count the bar, and
  // draw again when the bar's height differs from the guess.
  const turnRowsAt = (barRows: number) => inkLatestTurnRows({
    busy,
    columns,
    composerRows: reservedRows,
    keyBarRows: barRows,
    nowMs: clock,
    rows,
    showComposer: false,
    theme: t,
    transcript: idleTranscript,
    turnStartedAt: busyStartedAt
  });
  let liveTurn: LiveTurnRender | null = null;
  let liveTurnRows: number | undefined;
  if (renderTurnAt) {
    let barRows = DEFAULT_KEY_BAR_ROWS;
    for (let pass = 0; pass < 3; pass += 1) {
      liveTurnRows = turnRowsAt(barRows);
      liveTurn = renderTurnAt(liveTurnRows);
      const drawnBarRows = keyBarRowCount(keyHintsFor(liveTurn), columns);
      if (drawnBarRows === barRows) {
        break;
      }
      barRows = drawnBarRows;
    }
  }
  liveTurnRowsRef.current = liveTurnRows;
  const keyHints = keyHintsFor(liveTurn);
  const keyBarRows = keyBarRowCount(keyHints, columns);
  const liveLatest = useMemo<CommittedEntry | null>(
    () => liveTurn ? { id: "live-turn", lines: liveTurn.lines } : null,
    [liveTurn]
  );
  const liveTranscript = liveTurn ? idleTranscript : transcript;
  const liveLayout = inkTranscriptLayout({
    bootFrame: true,
    busy,
    columns,
    composerRows: reservedRows,
    keyBarRows,
    latest: liveLatest,
    livePage: liveOffset,
    nowMs: clock,
    rows,
    showComposer: false,
    theme: t,
    topBar: topBarData,
    transcript: liveTranscript,
    turnStartedAt: busyStartedAt
  });
  // Rows above the composer: the first-run inventory, the live frame (top bar,
  // rule, latest turn), any image-draft lines, and the rule over the composer.
  const composerRow = homeInventoryRows + liveLayout.rowCount + draftLines.length + COMPOSER_RULE_ROWS;
  const pageLive = (direction: LivePageDirection) => setLiveOffset(pageLiveWindow(liveLayout.window, direction));
  // One key on the latest turn's views (only reached with an empty composer and
  // no card or picker open). `false` = the key goes on to the composer.
  const handleViewKey = (input: string, key: Key): boolean => {
    if (!viewFocus || !liveTurn?.focused) {
      return false;
    }
    const facts = { ...liveTurn.focused.facts, livePageNext: liveLayout.window.hiddenBelow > 0 };
    const next = resolveViewKey(input, viewFocus, key, facts);
    setViewFocus(next);
    if (next.effect?.type === "ask") {
      // `next` and `more` are NEW user turns, never direct tool calls and never
      // slash commands (`turnAsk` drops an ask that starts with `/`).
      const ask = turnAsk(next.effect.text);
      if (ask) submitLine(ask);
    } else if (next.effect?.type === "type") {
      // A key that acted on the view started a message after all: the composer
      // (empty here) takes it and the key just pressed, in order.
      const typed = `${next.effect.text}${input}`;
      setComposerState({ value: typed, cursor: typed.length });
      return true;
    } else if (next.effect?.type === "page_live") {
      pageLive("next");
    } else if (next.effect?.type === "copy") {
      const targets = copyTargets(process.env, process.platform);
      if (targets.osc52 && sessionStdout?.isTTY) {
        // `c`: an OSC 52 clipboard write (zero width, so Ink's frame is untouched).
        sessionStdout.write(clipboardSequence(next.effect.text));
      }
      if (targets.pbcopy) {
        // A local Mac: Terminal.app ignores OSC 52, so the system tool copies too.
        copyThroughPbcopy(next.effect.text);
      }
    }
    return next.handled;
  };

  // terminal-r4's frame, top to bottom (D1): [first-run inventory] · top bar ·
  // rule · the latest turn (or the boot frame) · the card and other overlays ·
  // rule · composer · completions · the key bar, LAST.
  return (
    <Box flexDirection="column" width={columns}>
      {showHomeInventory && homeInventory ? (
        <HomeInventory
          columns={columns}
          commands={homeInventory.commands}
          connections={homeInventory.connections}
          connectionsNote={homeInventory.connectionsNote}
          theme={t}
          tools={homeInventory.tools}
          version={homeInventory.version}
          workspace={homeInventory.workspace}
        />
      ) : null}
      <InkTranscriptApp
        bootFrame
        busy={busy}
        columns={columns}
        committed={committed}
        composerRows={reservedRows}
        keyBarRows={keyBarRows}
        latest={liveLatest}
        livePage={liveOffset}
        livePageSpace={pendingConfirmActions.length === 0 && !pendingSelection && !pendingOperatorLine}
        nowMs={clock}
        rows={rows}
        showComposer={false}
        theme={t}
        topBar={topBarData}
        transcript={liveTranscript}
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
      <CreativeDraftLines lines={draftLines} theme={t} width={columns} />
      <ConfirmActionMenu
        card={headCard}
        explainText={explainOpen ? confirmKeys?.explainText ?? null : null}
        pending={headConfirmAction}
        theme={t}
        width={columns}
      />
      <AnsiLine line={ruleLine(columns, t)} />
      <InkLineInput
        busy={busy}
        completionActive={completions.length > 0}
        rowsBelow={completions.length + keyBarRows}
        cursor={inputCursor}
        cardFieldActive={cardFieldActive}
        confirmActionActive={pendingConfirmActions.length > 0 && !cardFieldActive}
        confirmKeys={cardKeyCtx}
        onCardFieldCancel={() => setCardUi((ui) => cancelCardField(ui))}
        onConfirmActionApprove={() => handleCardAction({ type: "ok" })}
        onConfirmActionDecline={() => handleCardAction({ type: "dismiss" })}
        onConfirmActionExplain={() => handleCardAction({ type: "explain" })}
        onConfirmCardKey={handleCardAction}
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
        onExit={requestExit}
        onFieldKey={appendConnectFieldKey}
        onFieldBackspace={backspaceConnectField}
        onFieldCommit={commitConnectField}
        onChoiceCommit={commitConnectChoice}
        onChoiceNext={() => moveConnectChoice("next")}
        onChoicePrevious={() => moveConnectChoice("previous")}
        onHistoryNewer={() => navigateHistory("newer")}
        onHistoryOlder={() => navigateHistory("older")}
        livePaging={{ next: liveLayout.window.hiddenBelow > 0, previous: liveLayout.window.hiddenAbove > 0 }}
        onLivePage={pageLive}
        onSelectionAccept={acceptPendingSelection}
        onSelectionNext={() => selectPendingOption("next")}
        onSelectionPrevious={() => selectPendingOption("previous")}
        onSubmit={submitLine}
        onViewKey={handleViewKey}
        pendingConfirmation={Boolean(pendingOperatorLine)}
        placeholder={connectPlaceholder}
        row={composerRow}
        selectionActive={Boolean(pendingSelection)}
        theme={t}
        turnAbort={turnAbort}
        turnStoppable={turnStoppable}
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
      <KeyBar hints={keyHints} theme={t} width={columns} />
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

export function createActivityAwareCursorBlink(
  write: (sequence: string) => void,
  idleMs = TYPING_IDLE_MS
): { activity(): void; dispose(): void } {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let steady = false;
  let disposed = false;

  return {
    activity() {
      if (disposed) return;
      if (!steady) {
        write(STEADY_BLOCK_CURSOR);
        steady = true;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        steady = false;
        write(BLINKING_BLOCK_CURSOR);
      }, idleMs);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      write(DEFAULT_CURSOR_STYLE);
    }
  };
}

function useActivityAwareCursorBlink(stdout: NodeJS.WriteStream | undefined): () => void {
  const controller = useRef<ReturnType<typeof createActivityAwareCursorBlink> | null>(null);

  useEffect(() => {
    if (!stdout?.isTTY) return;
    const next = createActivityAwareCursorBlink((sequence) => stdout.write(sequence));
    controller.current = next;
    return () => {
      controller.current = null;
      next.dispose();
    };
  }, [stdout]);

  return useCallback(() => controller.current?.activity(), []);
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
  rowsBelow,
  confirmActionActive,
  confirmKeys,
  connectConfirmActive,
  cursor,
  fieldChoiceActive,
  fieldPromptActive,
  livePaging,
  onChange,
  cardFieldActive = false,
  onCardFieldCancel,
  onConfirmActionApprove,
  onConfirmActionDecline,
  onConfirmActionExplain,
  onConfirmCardKey,
  onChoiceCommit,
  onChoiceNext,
  onChoicePrevious,
  onCompletionAccept,
  onCompletionNext,
  onCompletionPrevious,
  onConnectCancel,
  onExit,
  onConnectConfirmAccept,
  onConnectConfirmNext,
  onConnectConfirmPrevious,
  onFieldBackspace,
  onFieldCommit,
  onFieldKey,
  onHistoryNewer,
  onHistoryOlder,
  onLivePage,
  onSelectionAccept,
  onSelectionNext,
  onSelectionPrevious,
  onSubmit,
  onViewKey,
  pendingConfirmation,
  placeholder,
  row,
  selection,
  selectionActive,
  theme,
  turnAbort,
  turnStoppable,
  value,
  valueIsMasked,
  width
}: {
  busy: boolean;
  completionActive: boolean;
  /** Rows drawn under the composer: an open completion menu, then the key bar. */
  rowsBelow: number;
  confirmActionActive: boolean;
  confirmKeys: KeyContext | null;
  connectConfirmActive: boolean;
  cursor: number;
  fieldChoiceActive: boolean;
  fieldPromptActive: boolean;
  /** Whether the live latest turn has hidden lines below / above (T4 paging). */
  livePaging: { next: boolean; previous: boolean };
  onChange(state: ComposerEditState): void;
  /** A card field is being typed: the composer takes the keys, Enter sets it, Esc cancels it. */
  cardFieldActive?: boolean;
  onCardFieldCancel?(): void;
  onConfirmActionApprove(): void;
  onConfirmActionDecline(): void;
  onConfirmActionExplain(): void;
  /** Any other card key the keymap resolved (v, 1–9, space, r, e, c); never approves or declines. */
  onConfirmCardKey?(action: KeyAction): void;
  onChoiceCommit(): void;
  onChoiceNext(): void;
  onChoicePrevious(): void;
  onCompletionAccept(): void;
  onCompletionNext(): boolean;
  onCompletionPrevious(): boolean;
  onConnectCancel(): void;
  /** Quit the session; commits the live turn to scrollback first. */
  onExit(): void;
  onConnectConfirmAccept(): void;
  onConnectConfirmNext(): void;
  onConnectConfirmPrevious(): void;
  onFieldBackspace(): void;
  onFieldCommit(): void;
  onFieldKey(text: string): void;
  onHistoryNewer(): void;
  onHistoryOlder(): void;
  onLivePage(direction: LivePageDirection): void;
  onSelectionAccept(): void;
  onSelectionNext(): void;
  onSelectionPrevious(): void;
  onSubmit(value: string): void;
  /** A key for the latest turn's views; returns whether it acted (else the composer takes it). */
  onViewKey?(input: string, key: Key): boolean;
  pendingConfirmation: boolean;
  placeholder: string;
  row: number;
  selection?: ComposerSelection | null;
  selectionActive: boolean;
  theme: Theme;
  turnAbort: TurnAbort;
  turnStoppable: boolean;
  value: string;
  valueIsMasked?: boolean;
  width: number;
}) {
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const forwardDelete = useForwardDeleteSignal();
  const markCursorActivity = useActivityAwareCursorBlink(stdout);
  // The composer's edit state as of the last key, so keys that arrive before
  // React re-renders compose (none is lost); each render resets it to the props.
  const editRef = useRef<ComposerEditState>({ cursor, selection, value });
  editRef.current = { cursor, selection, value };
  const change = (next: ComposerEditState) => {
    editRef.current = next;
    onChange(next);
  };
  // One stable subscription that always runs THIS render's handler. Ink
  // re-subscribes `useInput` in an effect, after the frame is already on
  // screen, so a key pressed in between used to reach an older render's
  // handler: `v` on a card that had just appeared typed into the composer.
  const handleInputRef = useRef<(input: string, key: Key) => void>(() => {});
  handleInputRef.current = (input, key) => {
    markCursorActivity();
    const editState = editRef.current;
    const value = editState.value;
    // In-chat /connect wizard (#20): Ctrl-C cancels the WIZARD ONLY (zeroizing the
    // secret) and must be guarded BEFORE the session-wide `onExit()` below — a
    // bare Ctrl-C mid-wizard must not quit the whole session.
    if (key.ctrl && input === "c") {
      if (fieldPromptActive || connectConfirmActive) {
        onConnectCancel();
        return;
      }
      // A running turn is stopped, not the session: Ctrl-C quits only when no
      // turn is running.
      if (turnStoppable && ctrlCAction(turnAbort) === "stopped") {
        return;
      }
      onExit();
      return;
    }
    // Esc stops the running turn. It never approves or declines anything.
    if (busy && key.escape && turnStoppable) {
      turnAbort.stop("esc");
      return;
    }
    // Esc in a card's field closes the field (the card stays; nothing is sent).
    // Enter sets the field through `onSubmit`; every other key types.
    if (cardFieldActive && key.escape) {
      onCardFieldCancel?.();
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
    // The latest turn's views take the keys they use (views/focus.ts) while the
    // composer is empty and no card, picker or operator confirm is open. Any
    // other key falls through: a printable one types (and focus moves to the
    // composer), space and PgDn still page the live region below.
    if (
      onViewKey &&
      !busy &&
      value.length === 0 &&
      !confirmActionActive &&
      !cardFieldActive &&
      !selectionActive &&
      !pendingConfirmation &&
      onViewKey(input, key)
    ) {
      return;
    }
    // Page a tall live turn (transcript-static.ts): PgDn/PgUp always, space only on
    // an empty prompt in composer focus. Ahead of the write gate so a long answer
    // stays readable while its card waits; a paging key never approves or declines
    // anything, and space stays with an open card or picker (T7/T11 bind it there).
    const page = livePageKey(input, key, {
      composerEmpty: value.length === 0 && !confirmActionActive && !cardFieldActive && !selectionActive && !pendingConfirmation,
      canPageNext: livePaging.next,
      canPagePrevious: livePaging.previous
    });
    if (page) {
      onLivePage(page);
      return;
    }
    // In-session write gate (cloud brain, Plan 2) for a `requires_confirmation`
    // action. The keymap decides: ONLY the card's named OK key (`p` for Pause, `y`
    // on an old desktop) approves, ONLY `n` dismisses (a real "no" sent to the
    // app), and `?` toggles the explanation. Enter, Escape and every other key are
    // swallowed, so a stray keystroke can neither approve a write nor send a
    // decline. Guarded BEFORE the plain composer so no keystroke leaks into the
    // input line.
    if (confirmActionActive) {
      const action = confirmKeys ? resolveKey(input, key, confirmKeys) : { type: "none" as const };
      if (action.type === "ok") {
        onConfirmActionApprove();
      } else if (action.type === "dismiss") {
        onConfirmActionDecline();
      } else if (action.type === "explain") {
        onConfirmActionExplain();
      } else if (action.type !== "none") {
        onConfirmCardKey?.(action);
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
      change(applyComposerEdit(editState, { type: "insert-newline" }));
      return;
    }
    const keyWithPosition = key as typeof key & { end?: boolean; home?: boolean };
    if (keyWithPosition.home || (key.ctrl && input === "a")) {
      change(applyComposerEdit(editState, { type: "move-start" }));
      return;
    }
    if (keyWithPosition.end || (key.ctrl && input === "e")) {
      change(applyComposerEdit(editState, { type: "move-end" }));
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
        change(next);
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
        change(next);
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
      change(applyComposerEdit(editState, { type }));
      return;
    }
    if (key.rightArrow || (key.ctrl && input === "f")) {
      const word = key.meta || key.ctrl;
      const type = key.shift
        ? word ? "move-word-right-select" : "move-right-select"
        : word ? "move-word-right" : "move-right";
      change(applyComposerEdit(editState, { type }));
      return;
    }
    if (key.meta && input === "b") {
      change(applyComposerEdit(editState, { type: "move-word-left" }));
      return;
    }
    if (key.meta && input === "f") {
      change(applyComposerEdit(editState, { type: "move-word-right" }));
      return;
    }
    if (key.backspace) {
      change(applyComposerEdit(editState, { type: "backspace" }));
      return;
    }
    if (key.delete) {
      change(applyComposerEdit(editState, { type: forwardDelete.current ? "delete-forward" : "backspace" }));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const action = input.length > 1 || input.includes("\n") || input.includes("[200~") || input.includes("[201~")
        ? { text: input, type: "insert-paste" as const }
        : { text: input, type: "insert" as const };
      change(applyComposerEdit(editState, action));
    }
  };
  useInput(useCallback((input: string, key: Key) => handleInputRef.current(input, key), []));

  // In-chat /connect wizard (#20): a free-text field row uses a `?`-style prompt
  // and never the native cursor (the rendered `value` is already the masked bullets
  // string for secret fields, so there is no raw value to position a cursor in).
  const fieldRowActive = fieldPromptActive && !fieldChoiceActive;
  const overlayActive = selectionActive || connectConfirmActive || fieldRowActive || confirmActionActive;
  // The prompt is r4's cyan `❯`, with a write card open too (its keys are in the
  // key bar). An operator confirm shows a `!` and the pickers and /connect
  // fields a `?`, in amber: those rows take a typed answer, not a message.
  const pickerActive = selectionActive || connectConfirmActive || fieldRowActive;
  const label = pendingConfirmation ? "!" : pickerActive ? "?" : theme.brand.prompt;
  const promptWidth = displayWidth(`${label} `);
  const inputWidth = Math.max(1, width - promptWidth);
  // When the frame is tall enough to trip ink's fullscreen write branch, ink parks the
  // native cursor a row above the composer (see wouldTriggerInkFullscreen). Suppress the
  // native cursor there and let renderComposerValueWithCursor draw the in-text caret.
  // An open completion menu and the key bar render BELOW the composer and count toward
  // ink's outputHeight (the other overlays already force the native cursor off).
  const composerRows = composerCursorLayout(value, value.length, inputWidth).line + 1;
  const inkFullscreen = wouldTriggerInkFullscreen({
    rowsAboveComposer: row,
    composerRows,
    rowsBelowComposer: rowsBelow,
    terminalRows: stdout?.rows
  });
  const nativeCursor =
    !busy && !overlayActive && !valueIsMasked && !composerSelectedRange(value, selection)
    && Boolean(stdout?.isTTY) && !inkFullscreen;
  setCursorPosition(nativeCursor
    ? composerNativeCursorPosition({ cursor, label, row, value, width })
    : undefined);

  // An empty composer shows its placeholder on one row, cut to the width
  // (terminal-r4: `❯ Ask Infinite…` in dim, the busy note in brackets).
  const content = fieldRowActive
    // Masked or plain field value with a trailing cursor — `value` already carries
    // bullets for a secret field, so the raw secret is never in the render tree.
    ? (value ? `${value}|` : truncateCells(placeholder, inputWidth))
    : value
      ? renderComposerValueWithCursor(value, cursor, selection, { nativeCursor })
      : truncateCells(placeholder, inputWidth);
  const look = themeInkStyle(theme, value ? "text" : "muted");

  return (
    <Box width={width}>
      <Text {...themeInkStyle(theme, pendingConfirmation || pickerActive ? "warning" : "primary")}>{label} </Text>
      <Box width={inputWidth}>
        <Text {...look} wrap="wrap">{content}</Text>
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

// The in-session write gate (cloud brain, Plan 2). Purely presentational — all
// key handling stays in the single `useInput` owner. Renders the head pending
// confirmation: the summary (scrubbed through `terminalText` — it is NOT covered
// by the upstream redaction contract, and its `<Text>` child reaches the raw
// terminal) then each already-redacted `label: value` detail VERBATIM (mirroring
// the readline card's `renderConfirmationCard`), then the `?` explanation when it
// is open. The keys (named OK key, `n dismiss`, `?`) live in the `KeyBar` below.
function ConfirmActionMenu({
  card,
  explainText,
  pending,
  theme,
  width
}: {
  /** The card drawn from its approval view (views/approval.ts), else null (an old desktop). */
  card: ApprovalRender | null;
  /** The scrubbed `?` text when the explanation is open, else null. */
  explainText: string | null;
  pending: InSessionConfirmationAction | null;
  theme: Theme;
  width: number;
}) {
  if (!pending) {
    return null;
  }
  if (card) {
    // Every line is already scrubbed, coloured and laid out to `width`.
    return (
      <Box flexDirection="column" width={width}>
        {card.lines.map((line, index) => (
          <Text key={`card-${index}`} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.color.warning}>
        {truncateCells(`Approve this write? — ${terminalText(pending.summary, "action")}`, width)}
      </Text>
      {pending.confirmationDetails.map((detail, index) => (
        <Text color={theme.color.muted} key={`${detail.label}-${index}`}>
          {truncateCells(`  ${detail.label}: ${detail.value}`, width)}
        </Text>
      ))}
      {explainText ? (
        <Text color={theme.color.text} wrap="wrap">{`? ${explainText}`}</Text>
      ) : null}
    </Box>
  );
}

// Image drafts in progress (`creative.draft`), one line per run. Text only.
function CreativeDraftLines({ lines, theme, width }: { lines: readonly string[]; theme: Theme; width: number }) {
  if (!lines.length) {
    return null;
  }
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, index) => (
        <Text color={line.startsWith("✗") ? theme.color.error : theme.color.primary} key={`draft-${index}`} wrap="truncate-end">
          {truncateCells(line, width)}
        </Text>
      ))}
    </Box>
  );
}

/** The app's words when it refused a card's answer before anything ran (`field_invalid`). */
function fieldInvalidMessage(outcome: unknown): string | null {
  if (!isPlainRecord(outcome) || outcome.code !== "field_invalid") return null;
  return typeof outcome.message === "string" ? outcome.message : "";
}

/** A queue entry with no carried answers; with `fieldError`, the app's words for the field. */
function withoutSent(entry: InSessionConfirmationAction, fieldError?: string): InSessionConfirmationAction {
  const { sentFields: _sent, fieldError: _error, ...rest } = entry;
  return { ...rest, ...(fieldError ? { fieldError } : {}) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Rows the composer row may take for `text` (its value, or the placeholder): the
 * same word-wrap Ink uses, at the widest prompt label. Feeds the live-region cap.
 */
function composerRowsFor(text: string, columns: number, theme: Theme): number {
  const labelWidth = Math.max(displayWidth(`${theme.brand.prompt} `), displayWidth("! "));
  return composerCursorLayout(text, text.length, Math.max(1, columns - labelWidth)).line + 1;
}

/** A card never pages below this many rows, however small the window. */
const CARD_MIN_ROWS = 6;

/**
 * Rows the overlays between the transcript and the composer draw right now
 * (selection, /connect wizard, Connect/Cancel, write gate) — reserved out of the
 * live-region cap. Mirrors the overlay components below; an overestimate only
 * shows fewer live lines, an underestimate could fill the window.
 */
function liveOverlayRows({
  confirmAction,
  confirmCardRows,
  confirmExplain,
  connectConfirm,
  draftRows,
  field,
  selection,
  width
}: {
  confirmAction: InSessionConfirmationAction | null;
  /** Rows of a card drawn from its approval view (head + frame), else null. */
  confirmCardRows: number | null;
  /** The open `?` explanation under the write card, else null. */
  confirmExplain: string | null;
  connectConfirm: boolean;
  /** Image-draft progress lines. */
  draftRows: number;
  field: { descriptor: ConnectSetupDescriptor; index: number } | null;
  selection: InkInteractiveSelectionPrompt | null;
  width: number;
}): number {
  let rows = 0;
  if (selection) {
    rows += 1 + (selection.description ? 1 : 0) + selection.options.length;
  }
  const current = field?.descriptor.fields[field.index];
  if (current) {
    const guidance = current.guidance
      ? wrapAnsi(current.guidance, Math.max(1, width), { trim: false, hard: true }).split("\n").length
      : 0;
    rows += 3 + guidance + (current.choices ? current.choices.length : current.secret ? 1 : 0);
  }
  if (connectConfirm) {
    rows += 3;
  }
  rows += draftRows;
  if (confirmAction && confirmCardRows !== null) {
    rows += confirmCardRows;
  } else if (confirmAction) {
    // Summary + details; the key hints moved to the KeyBar (counted by the caller).
    rows += 1 + confirmAction.confirmationDetails.length;
    if (confirmExplain) {
      rows += wrapAnsi(`? ${confirmExplain}`, Math.max(1, width), { trim: false, hard: true }).split("\n").length;
    }
  }
  return rows;
}

function isMessageCompleteResult(value: unknown): value is { finalMessages: readonly Msg[]; finalText: string } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { finalMessages?: unknown }).finalMessages));
}
