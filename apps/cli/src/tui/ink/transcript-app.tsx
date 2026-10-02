import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, activeInkRenderer, renderToString } from "./renderer.js";

import { renderStatusFooter } from "../../formatting/renderer.js";
import { renderInfiniteTranscript, type InfiniteTranscriptInput } from "../app/transcript-renderer.js";
import { getTurnState, type TurnState } from "../app/turn-store.js";
import { parseAnsiSegments, type AnsiSegment } from "../lib/ansi-segments.js";
import { displayWidth, padEndCells, truncateCells } from "../lib/display-width.js";
import { toInkColor } from "../style/sgr.js";
import { colorEnabled, resolveTheme, type Theme } from "../theme.js";
import { ROCKET_BANNER_ROWS, RocketBanner } from "./rocket-banner.js";
import {
  DEFAULT_COMPOSER_ROWS,
  DEFAULT_KEY_BAR_ROWS,
  liveBodyRows,
  livePageHint,
  liveWindow,
  type CommittedEntry,
  type LiveWindow
} from "./transcript-static.js";
import {
  FACE_TICK_MS,
  formatInfiniteBusyIndicator,
  infiniteBusySpinnerIntervalMs,
  isInfiniteTurnBusy
} from "./status-indicator.js";

export interface InkTranscriptAppProps {
  busy?: boolean;
  columns?: number;
  /**
   * Finished turns, printed ONCE through Ink's `<Static>` into the terminal's
   * scrollback (see transcript-static.ts). Never counted by
   * `inkTranscriptRowCount`: the composer's cursor row is relative to the live
   * frame only. Must only ever grow.
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
   * the composer, any overlay, the home inventory. Default DEFAULT_COMPOSER_ROWS.
   */
  composerRows?: number;
  /** Rows of the key bar above the composer. Default DEFAULT_KEY_BAR_ROWS. */
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
  indicatorTick?: number;
  nowMs?: number;
  /**
   * Render the home-screen rocket mascot (fixed `ROCKET_BANNER_ROWS` tall) in
   * the empty-transcript state instead of a blank row. Must be passed
   * identically to the live render and to `inkTranscriptRowCount` so the
   * composer's native-cursor row prediction stays exact.
   */
  homeBanner?: boolean;
  prompt?: {
    placeholder?: string;
    text?: string;
  };
  showComposer?: boolean;
  status?: readonly string[];
  spinnerTick?: number;
  theme?: Theme;
  title?: string;
  transcript?: InfiniteTranscriptInput;
  turnStartedAt?: number;
}

/**
 * Owns the animated transcript clock (wall-clock + face/spinner ticks) for a
 * busy turn. Extracted so the live `InkTranscriptApp` render and the
 * `inkTranscriptRowCount` height prediction that positions the composer's
 * native cursor can be driven by the *same* tick/time values. If they animate
 * independently, the busy indicator (or a tool's elapsed timer) can occupy a
 * different number of rows in the render than the prediction assumed, parking
 * the native cursor a row off — on the status line instead of the composer.
 */
export function useInfiniteTranscriptClock({
  busy,
  indicatorTick,
  nowMs,
  spinnerTick: spinnerTickOverride,
  state
}: {
  busy: boolean;
  indicatorTick?: number;
  nowMs?: number;
  spinnerTick?: number;
  state: TurnState;
}): { clock: number; labelTick: number; spinnerTick: number } {
  const [labelTick, setLabelTick] = useState(0);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const displayLabelTick = indicatorTick ?? labelTick;
  const displaySpinnerTick = spinnerTickOverride ?? spinnerTick;
  const spinnerIntervalMs = useMemo(
    () => infiniteBusySpinnerIntervalMs(state, displayLabelTick),
    [displayLabelTick, state]
  );

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

  useEffect(() => {
    if (!busy || indicatorTick !== undefined) {
      return;
    }
    const id = setInterval(() => setLabelTick((value) => value + 1), FACE_TICK_MS);

    return () => clearInterval(id);
  }, [busy, indicatorTick]);

  useEffect(() => {
    if (!busy || spinnerTickOverride !== undefined) {
      return;
    }
    const id = setInterval(() => setSpinnerTick((value) => value + 1), spinnerIntervalMs);

    return () => clearInterval(id);
  }, [busy, spinnerIntervalMs, spinnerTickOverride]);

  return {
    clock: nowMs ?? clock,
    labelTick: displayLabelTick,
    spinnerTick: displaySpinnerTick
  };
}

export function InkTranscriptApp({
  busy: busyOverride = false,
  columns = 88,
  committed: committedProp = NO_COMMITTED,
  composerRows,
  homeBanner = false,
  keyBarRows,
  latest,
  livePage,
  livePageSpace = true,
  rows,
  indicatorTick,
  nowMs,
  prompt,
  showComposer = true,
  status = [],
  spinnerTick: spinnerTickOverride,
  theme,
  title,
  transcript,
  turnStartedAt
}: InkTranscriptAppProps) {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const busy = busyOverride || isInfiniteTurnBusy(state);
  const { clock, labelTick: displayLabelTick, spinnerTick: displaySpinnerTick } = useInfiniteTranscriptClock({
    busy,
    indicatorTick,
    nowMs,
    spinnerTick: spinnerTickOverride,
    state
  });

  const transcriptLines = useMemo(() => renderTranscriptLines(transcript ?? { state }, {
    columns: width,
    nowMs: clock,
    theme: t
  }), [clock, state, t, transcript, width]);
  const statusRows = statusRowStrings({
    busy,
    columns: width,
    labelTick: displayLabelTick,
    nowMs: clock,
    spinnerTick: displaySpinnerTick,
    state,
    status,
    theme: t,
    turnStartedAt
  });
  const live = useMemo(() => liveLinesWindow({
    composerRows,
    keyBarRows,
    latest,
    livePage,
    rows,
    showComposer,
    statusRowCount: statusRows.length,
    transcriptLines
  }), [composerRows, keyBarRows, latest, livePage, rows, showComposer, statusRows.length, transcriptLines]);
  const hint = livePageHint(live, { spacePages: livePageSpace });
  // <Static> wants a mutable array type; it only reads it.
  const committed = committedProp as CommittedEntry[];

  return (
    <Box flexDirection="column" width={width}>
      {/* Finished turns: printed once, above the live frame, into scrollback. */}
      <Static items={committed}>
        {(entry) => (
          <Box flexDirection="column" key={entry.id}>
            {entry.node ?? entry.lines.map((line, index) => <AnsiLine key={`${entry.id}:${index}`} line={line} />)}
          </Box>
        )}
      </Static>
      {/* truncate-end keeps the top rule to EXACTLY one terminal row — matching the
          literal `1` inkTranscriptRowCount() assumes for it. Without this, a label
          whose Ink string-width exceeds the repo's displayWidth (emoji-presentation
          glyphs like ♾️/✅ in the brand icon or agent title) — or a title long enough
          to overflow `columns` — word-wraps the rule to 2 rows, so the predicted
          composer row (and thus the native cursor) lands one row above the input. */}
      <Text color={t.color.primary} wrap="truncate-end">{topRule(title ?? t.brand.name, t, width)}</Text>
      {live.lines.length ? (
        <>
          {live.lines.map((line, index) => <AnsiLine key={`line:${live.start + index}`} line={line} />)}
          {hint ? (
            <Text color={t.color.muted} wrap="truncate-end">{truncateCells(hint, width)}</Text>
          ) : null}
        </>
      ) : homeBanner ? (
        // Empty transcript on the interactive home screen: the rocket mascot
        // (fixed ROCKET_BANNER_ROWS tall). It replaces the old welcome line —
        // the input composer's placeholder already shows "Type a message, …",
        // so the banner doesn't repeat the hint.
        <RocketBanner />
      ) : (
        // Empty transcript elsewhere (progress renders, non-home): a single
        // BLANK row — exactly one row so it matches inkTranscriptRowCount()'s
        // reservation and the predicted composer/native-cursor row.
        <Text wrap="truncate-end">{" "}</Text>
      )}
      {statusRows.map((row, index) => (
        <Text color={t.color.muted} key={`status:${index}`} wrap="truncate-end">
          {row}
        </Text>
      ))}
      {showComposer ? (
        <Text color={t.color.primaryBright} wrap="truncate-end">
          {composerLine(prompt, t, width)}
        </Text>
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
  busy: busyOverride = false,
  columns = 88,
  composerRows,
  homeBanner = false,
  indicatorTick = 0,
  keyBarRows,
  latest,
  livePage,
  nowMs = Date.now(),
  rows,
  showComposer = true,
  spinnerTick = 0,
  status = [],
  theme,
  transcript,
  turnStartedAt
}: InkTranscriptAppProps): { rowCount: number; window: LiveWindow } {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const busy = busyOverride || isInfiniteTurnBusy(state);
  const statusRows = statusRowStrings({
    busy,
    columns: width,
    labelTick: indicatorTick,
    nowMs,
    spinnerTick,
    state,
    status,
    theme: t,
    turnStartedAt
  }).length;
  const live = liveLinesWindow({
    composerRows,
    keyBarRows,
    latest,
    livePage,
    rows,
    showComposer,
    statusRowCount: statusRows,
    transcriptLines: renderTranscriptLines(transcript ?? { state }, {
      columns: width,
      nowMs,
      theme: t
    })
  });
  // Mirror the empty-transcript render branch exactly: the home banner renders
  // ROCKET_BANNER_ROWS rows, everything else falls back to a single blank row.
  const liveRows = live.lines.length > 0
    ? live.lines.length + (livePageHint(live) ? 1 : 0)
    : homeBanner ? ROCKET_BANNER_ROWS : 1;

  return { rowCount: 1 + liveRows + statusRows + (showComposer ? 1 : 0), window: live };
}

/**
 * The rows the latest turn may take in `InkTranscriptApp`'s live region without
 * being paged: the live budget (`liveBodyRows`) minus the transcript lines drawn
 * under it. Same inputs as `inkTranscriptLayout`, without `latest`. Undefined
 * when the height is unknown (no cap).
 */
export function inkLatestTurnRows({
  busy: busyOverride = false,
  columns = 88,
  composerRows = DEFAULT_COMPOSER_ROWS,
  indicatorTick = 0,
  keyBarRows = DEFAULT_KEY_BAR_ROWS,
  nowMs = Date.now(),
  rows,
  showComposer = true,
  spinnerTick = 0,
  status = [],
  theme,
  transcript,
  turnStartedAt
}: InkTranscriptAppProps): number | undefined {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const busy = busyOverride || isInfiniteTurnBusy(state);
  const statusRows = statusRowStrings({
    busy,
    columns: width,
    labelTick: indicatorTick,
    nowMs,
    spinnerTick,
    state,
    status,
    theme: t,
    turnStartedAt
  }).length;
  const budget = liveBodyRows(rows, composerRows, keyBarRows, statusRows, showComposer);
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

/**
 * The live lines (the latest turn, then the transcript) cut to the live-region
 * budget: the cap minus the top rule, the status rows and an in-app composer row.
 */
function liveLinesWindow({
  composerRows = DEFAULT_COMPOSER_ROWS,
  keyBarRows = DEFAULT_KEY_BAR_ROWS,
  latest,
  livePage,
  rows,
  showComposer,
  statusRowCount,
  transcriptLines
}: {
  composerRows?: number;
  keyBarRows?: number;
  latest?: CommittedEntry | null;
  livePage?: number | null;
  rows?: number;
  showComposer: boolean;
  statusRowCount: number;
  transcriptLines: readonly string[];
}): LiveWindow {
  const lines = latest?.lines.length ? [...latest.lines, ...transcriptLines] : transcriptLines;
  const budget = liveBodyRows(rows, composerRows, keyBarRows, statusRowCount, showComposer);
  return liveWindow(lines, budget, livePage ?? null);
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
        : line}
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

function statusRowStrings({
  busy,
  columns,
  labelTick,
  nowMs,
  spinnerTick,
  state,
  status,
  theme,
  turnStartedAt
}: {
  busy: boolean;
  columns: number;
  labelTick: number;
  nowMs: number;
  spinnerTick: number;
  state: TurnState;
  status: readonly string[];
  theme: Theme;
  turnStartedAt?: number;
}): string[] {
  const parts = busy
    ? [formatInfiniteBusyIndicator({ labelTick, nowMs, spinnerTick, state, turnStartedAt }), ...status]
    : status;

  return parts.length
    ? groupStatusParts(parts, columns).map((row) => renderStatusFooter(row, {
      color: false,
      columns,
      theme
    }))
    : ["─".repeat(columns)];
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

function topRule(title: string, theme: Theme, columns: number): string {
  const label = ` ${theme.brand.icon} ${title} `;
  const right = Math.max(0, columns - displayWidth(label));

  return `${label}${"─".repeat(right)}`;
}

function composerLine(prompt: InkTranscriptAppProps["prompt"], theme: Theme, columns: number): string {
  const promptText = prompt?.text?.trim() || theme.brand.prompt;
  const placeholder = prompt?.placeholder ?? theme.brand.welcome;

  return padEndCells(truncateCells(`${promptText} ${placeholder}`.trimEnd(), columns), columns);
}

function groupStatusParts(parts: readonly string[], columns: number): string[][] {
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

function clampColumns(columns: number): number {
  return Math.max(20, Number.isFinite(columns) ? Math.floor(columns) : 88);
}

/** The width the transcript draws at for a terminal this wide (the whole window, at least 20). Pre-rendered `latest` lines use it. */
export function transcriptColumns(columns: number): number {
  return clampColumns(columns);
}
