import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, activeInkRenderer, renderToString } from "./renderer.js";

import { renderInfiniteTranscript, type InfiniteTranscriptInput } from "../app/transcript-renderer.js";
import { getTurnState } from "../app/turn-store.js";
import { parseAnsiSegments, type AnsiSegment } from "../lib/ansi-segments.js";
import { truncateCells } from "../lib/display-width.js";
import { paintSegments } from "../lib/styled-segments.js";
import { toInkColor } from "../style/sgr.js";
import { colorEnabled, resolveTheme, type Theme } from "../theme.js";
import { composerLine } from "./composer-line.js";
import { formatBusyNote, isInfiniteTurnBusy } from "./status-indicator.js";
import { BOOT_BODY_ROWS, TOP_BAR_ROWS, bootBodyLines, ruleLine, topBarLines, type TopBarData } from "./top-bar.js";
import {
  DEFAULT_COMPOSER_ROWS,
  DEFAULT_KEY_BAR_ROWS,
  liveBodyRows,
  livePageHint,
  liveWindow,
  type CommittedEntry,
  type LiveWindow
} from "./transcript-static.js";

// The session's frame (terminal-r4, D1): finished turns sit in the terminal's
// scrollback as their question and answer, a thin rule between turns, and no
// top bar of their own. The live region at the bottom is the top bar and its
// rule, the latest turn (or, before the first one, the boot frame: an empty
// answer area and the Steps rule), then — when this component owns the
// composer — a rule and the composer row. The interactive session draws its
// own rule, composer and key bar under it.

export interface InkTranscriptAppProps {
  busy?: boolean;
  columns?: number;
  /**
   * Finished turns, printed ONCE through Ink's `<Static>` into the terminal's
   * scrollback (see transcript-static.ts), a thin rule between them. Never
   * counted by `inkTranscriptRowCount`: the composer's cursor row is relative
   * to the live frame only. Must only ever grow.
   */
  committed?: readonly CommittedEntry[];
  /**
   * The latest turn as pre-rendered lines. Drawn live (before `transcript`'s own
   * lines) and counted, capped by the live-region budget like the rest.
   */
  latest?: CommittedEntry | null;
  /**
   * Terminal height. When set, the live lines are capped at
   * `liveRegionCap(rows, composerRows, keyBarRows)` and paged; undefined = no cap.
   */
  rows?: number;
  /**
   * Rows the live frame draws outside this component, other than the key bar:
   * the composer and its rule, any overlay, the first-run inventory. Default
   * DEFAULT_COMPOSER_ROWS.
   */
  composerRows?: number;
  /** Rows of the key bar under the composer. Default DEFAULT_KEY_BAR_ROWS. */
  keyBarRows?: number;
  /**
   * First visible live line when the live region is paged; `null`/undefined =
   * follow the tail. Clamped, so a stale offset after a resize is safe.
   */
  livePage?: number | null;
  /**
   * Whether space pages the live region right now (false while a write card or
   * picker owns space). Only the hint text changes; the row count does not.
   */
  livePageSpace?: boolean;
  nowMs?: number;
  /**
   * Draw the boot frame (an empty answer area and the Steps rule, D4) while
   * nothing is live. Must be passed identically to the live render and to
   * `inkTranscriptRowCount` so the composer's native-cursor row stays exact.
   * Off, an empty live region is one blank row.
   */
  bootFrame?: boolean;
  prompt?: {
    placeholder?: string;
    text?: string;
  };
  /** Draw the rule and the composer row under the live lines (the one-shot progress view). */
  showComposer?: boolean;
  theme?: Theme;
  /** The top bar's workspace and sources (D1). Without it the bar is the brand chip alone. */
  topBar?: TopBarData;
  transcript?: InfiniteTranscriptInput;
  turnStartedAt?: number;
}

/**
 * Owns the transcript's wall clock for a busy turn (a one-second tick), so
 * the live `InkTranscriptApp` render and the `inkTranscriptRowCount` height
 * prediction that positions the composer's native cursor read the *same*
 * time. If they read different clocks, an elapsed timer could draw a
 * different number of rows than the prediction assumed, parking the native
 * cursor a row off.
 */
export function useInfiniteTranscriptClock({
  busy,
  nowMs
}: {
  busy: boolean;
  nowMs?: number;
}): { clock: number } {
  const [clock, setClock] = useState(() => nowMs ?? Date.now());

  useEffect(() => {
    if (nowMs !== undefined) {
      setClock(nowMs);
      return;
    }
    if (!busy) {
      return;
    }
    const id = setInterval(() => setClock(Date.now()), 1_000);

    return () => clearInterval(id);
  }, [busy, nowMs]);

  return { clock: nowMs ?? clock };
}

export function InkTranscriptApp({
  busy: busyOverride = false,
  bootFrame = false,
  columns = 88,
  committed: committedProp = NO_COMMITTED,
  composerRows,
  keyBarRows,
  latest,
  livePage,
  livePageSpace = true,
  rows,
  nowMs,
  prompt,
  showComposer = true,
  theme,
  topBar,
  transcript,
  turnStartedAt
}: InkTranscriptAppProps) {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const busy = busyOverride || isInfiniteTurnBusy(state);
  const { clock } = useInfiniteTranscriptClock({ busy, nowMs });

  const transcriptLines = useMemo(() => renderTranscriptLines(transcript ?? { state }, {
    columns: width,
    nowMs: clock,
    theme: t
  }), [clock, state, t, transcript, width]);
  const live = useMemo(() => liveLinesWindow({
    bootFrame,
    composerRows,
    keyBarRows,
    latest,
    livePage,
    rows,
    showComposer,
    theme: t,
    transcriptLines,
    width
  }), [bootFrame, composerRows, keyBarRows, latest, livePage, rows, showComposer, t, transcriptLines, width]);
  const hint = livePageHint(live.window, { spacePages: livePageSpace });
  const header = useMemo(() => topBarLines(topBar, width, t), [t, topBar, width]);
  const rule = useMemo(() => ruleLine(width, t), [t, width]);
  // <Static> wants a mutable array type; it only reads it.
  const committed = committedProp as CommittedEntry[];

  return (
    <Box flexDirection="column" width={width}>
      {/* Finished turns: printed once, above the live frame, into scrollback,
          a thin rule between them (D1). This is the ONE rule between turns
          (and after the first-run inventory): a committed entry's own lines
          must not start with a rule of their own, or scrollback shows two
          (transcript-static.test.ts pins exactly one). */}
      <Static items={committed}>
        {(entry, index) => (
          <Box flexDirection="column" key={entry.id}>
            {index > 0 ? <AnsiLine line={ruleLine(width, t)} /> : null}
            {entry.node ?? entry.lines.map((line, lineIndex) => <AnsiLine key={`${entry.id}:${lineIndex}`} line={rowText(line)} />)}
          </Box>
        )}
      </Static>
      {/* The top bar and its rule: exactly TOP_BAR_ROWS rows, each cut to the
          width, as inkTranscriptRowCount() assumes. */}
      {header.map((line, index) => <AnsiLine key={`top:${index}`} line={line} />)}
      {live.lines.map((line, index) => <AnsiLine key={`line:${live.start + index}`} line={rowText(line)} />)}
      {hint ? <AnsiLine line={paintHint(hint, width, t)} /> : null}
      {showComposer ? (
        <>
          <AnsiLine line={rule} />
          <AnsiLine
            line={composerLine(width, t, {
              placeholder: prompt?.placeholder,
              prompt: prompt?.text?.trim() || undefined,
              note: busy ? formatBusyNote({ nowMs: clock, state, turnStartedAt }) : null
            })}
          />
        </>
      ) : null}
    </Box>
  );
}

export function renderInkTranscriptToString(
  props: InkTranscriptAppProps,
  options: { columns?: number } = {}
): string {
  return renderToString(<InkTranscriptApp {...props} columns={props.columns ?? options.columns} />, {
    columns: props.columns ?? options.columns ?? 88
  });
}

/**
 * The rows the live frame of `InkTranscriptApp` draws (committed `<Static>` rows
 * are NOT counted: Ink positions the cursor inside the live frame only), plus the
 * live window, so a caller can tell whether the latest turn can be paged.
 */
export function inkTranscriptLayout({
  bootFrame = false,
  columns = 88,
  composerRows,
  keyBarRows,
  latest,
  livePage,
  nowMs = Date.now(),
  rows,
  showComposer = true,
  theme,
  transcript
}: InkTranscriptAppProps): { rowCount: number; window: LiveWindow } {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const live = liveLinesWindow({
    bootFrame,
    composerRows,
    keyBarRows,
    latest,
    livePage,
    rows,
    showComposer,
    theme: t,
    transcriptLines: renderTranscriptLines(transcript ?? { state }, {
      columns: width,
      nowMs,
      theme: t
    }),
    width
  });
  const liveRows = live.lines.length + (livePageHint(live.window) ? 1 : 0);

  return { rowCount: TOP_BAR_ROWS + liveRows + (showComposer ? COMPOSER_FRAME_ROWS : 0), window: live.window };
}

/**
 * The rows the latest turn may take in `InkTranscriptApp`'s live region without
 * being paged: the live budget (`liveBodyRows`) minus the transcript lines drawn
 * under it. Same inputs as `inkTranscriptLayout`, without `latest`. Undefined
 * when the height is unknown (no cap).
 */
export function inkLatestTurnRows({
  columns = 88,
  composerRows = DEFAULT_COMPOSER_ROWS,
  keyBarRows = DEFAULT_KEY_BAR_ROWS,
  nowMs = Date.now(),
  rows,
  showComposer = true,
  theme,
  transcript
}: InkTranscriptAppProps): number | undefined {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const budget = liveBodyRows(rows, composerRows, keyBarRows, frameHeaderRows(showComposer), showComposer);
  if (!Number.isFinite(budget)) {
    return undefined;
  }
  const transcriptLines = renderTranscriptLines(transcript ?? { state }, { columns: width, nowMs, theme: t });
  return Math.max(2, budget - transcriptLines.length);
}

export function inkTranscriptRowCount(props: InkTranscriptAppProps): number {
  return inkTranscriptLayout(props).rowCount;
}

/**
 * Lines of a finished turn for `<Static>`: exactly what the live region drew for
 * it (same renderer, same colours), at the given width.
 */
export function renderCommittedTranscriptLines(
  transcript: InfiniteTranscriptInput,
  options: { columns: number; theme?: Theme }
): string[] {
  return renderTranscriptLines(transcript, {
    columns: clampColumns(options.columns),
    nowMs: Date.now(),
    theme: options.theme ?? resolveTheme()
  });
}

const NO_COMMITTED: readonly CommittedEntry[] = [];

/** Rows the frame draws under the live lines when it owns the composer: the rule and the composer row. */
const COMPOSER_FRAME_ROWS = 2;

/**
 * Rows the frame draws besides the live lines, its first row and an in-app
 * composer row (what `liveBodyRows` subtracts on top of its own one row and
 * composer row): the top bar's rule, and the rule over an in-app composer.
 */
function frameHeaderRows(showComposer: boolean): number {
  return TOP_BAR_ROWS - 1 + (showComposer ? COMPOSER_FRAME_ROWS - 1 : 0);
}

/**
 * The live lines (the latest turn, then the transcript) cut to the live-region
 * budget: the cap minus the top bar, its rule and an in-app composer. With no
 * live lines, the boot frame's body (when asked for) or one blank row.
 */
function liveLinesWindow({
  bootFrame,
  composerRows = DEFAULT_COMPOSER_ROWS,
  keyBarRows = DEFAULT_KEY_BAR_ROWS,
  latest,
  livePage,
  rows,
  showComposer,
  theme,
  transcriptLines,
  width
}: {
  bootFrame: boolean;
  composerRows?: number;
  keyBarRows?: number;
  latest?: CommittedEntry | null;
  livePage?: number | null;
  rows?: number;
  showComposer: boolean;
  theme: Theme;
  transcriptLines: readonly string[];
  width: number;
}): { lines: readonly string[]; start: number; window: LiveWindow } {
  const lines = latest?.lines.length ? [...latest.lines, ...transcriptLines] : transcriptLines;
  const budget = liveBodyRows(rows, composerRows, keyBarRows, frameHeaderRows(showComposer), showComposer);
  const window = liveWindow(lines, budget, livePage ?? null);
  if (window.lines.length) {
    return { lines: window.lines, start: window.start, window };
  }
  // Nothing live: the boot frame (D4) or one blank row, never paged.
  const empty = bootFrame
    ? bootBodyLines(width, theme, Number.isFinite(budget) ? budget : BOOT_BODY_ROWS)
    : [""];
  return { lines: empty, start: 0, window };
}

/**
 * A line as one terminal row: an empty line is a single space, because Ink
 * draws an empty text as no row at all, and every row is counted (the
 * composer's native-cursor row and the live budget assume it).
 */
function rowText(line: string): string {
  return line === "" ? " " : line;
}

/** The pager hint in the dim grey, cut to the width (one row). */
function paintHint(hint: string, width: number, theme: Theme): string {
  return paintSegments([["dim", truncateCells(hint, width)]], theme);
}

/**
 * One pre-rendered ANSI line as Ink-native styled segments. Every attribute
 * the renderers paint reaches the screen: colour, background (chips, the
 * selected row), bold, faint, italic, underline (links), inverse and strike.
 */
export function AnsiLine({ line }: { line: string }) {
  const segments = parseAnsiSegments(line);
  return (
    <Text wrap="truncate-end">
      {segments.length
        ? segments.map((segment, segmentIndex) => (
            <Text key={segmentIndex} {...segmentTextProps(segment)}>
              {segment.text}
            </Text>
          ))
        : // An empty Text takes no row in Ink: a blank line is one space, so it keeps its row.
          line || " "}
    </Text>
  );
}

/** Ink `Text` props for one segment, spelled for the active Ink backend. */
function segmentTextProps(segment: AnsiSegment): React.ComponentProps<typeof Text> {
  const props: Record<string, unknown> = {
    color: toInkColor(segment.color, activeInkRenderer),
    backgroundColor: toInkColor(segment.backgroundColor, activeInkRenderer),
    bold: segment.bold,
    italic: segment.italic,
    underline: segment.underline,
    inverse: segment.inverse,
    strikethrough: segment.strikethrough
  };
  if (segment.dim) {
    // Faint is `dimColor` on stock Ink, and `dim` (never together with bold) on the vendored one.
    if (activeInkRenderer === "stock") {
      props.dimColor = true;
    } else if (!segment.bold) {
      props.dim = true;
    }
  }
  return props as React.ComponentProps<typeof Text>;
}


function renderTranscriptLines(
  transcript: InfiniteTranscriptInput,
  options: {
    columns: number;
    nowMs: number;
    theme: Theme;
  }
): string[] {
  const rendered = renderInfiniteTranscript(transcript, {
    // Color is emitted as ANSI here, then parsed back into per-segment Ink
    // `<Text color=…>` props by the transcript view (see parseAnsiSegments).
    // This keeps the renderer's full palette (border/title/body/diff/tool)
    // while coloring via Ink-native props that both Ink backends honor.
    // The theme's tier decides what is painted (none at all when plain).
    color: colorEnabled(options.theme),
    columns: options.columns,
    nowMs: options.nowMs,
    theme: options.theme
  });

  return rendered ? rendered.split("\n") : [];
}

/** The width the frame draws at: the window's own (fluid, no upper cap), at least 40. */
function clampColumns(columns: number): number {
  return Math.max(40, Number.isFinite(columns) ? Math.floor(columns) : 88);
}

/** The width the transcript draws at for a terminal this wide (at least 40, no upper cap). Pre-rendered `latest` lines use it. */
export function transcriptColumns(columns: number): number {
  return clampColumns(columns);
}
