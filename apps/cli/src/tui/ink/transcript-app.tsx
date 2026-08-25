import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, renderToString } from "./renderer.js";

import { renderStatusFooter } from "../../formatting/renderer.js";
import { renderInfiniteTranscript, type InfiniteTranscriptInput } from "../app/transcript-renderer.js";
import { getTurnState, type TurnState } from "../app/turn-store.js";
import { parseAnsiSegments } from "../lib/ansi-segments.js";
import { displayWidth, padEndCells, truncateCells } from "../lib/display-width.js";
import { resolveTheme, type Theme } from "../theme.js";
import { ROCKET_BANNER_ROWS, RocketBanner } from "./rocket-banner.js";
import {
  FACE_TICK_MS,
  formatInfiniteBusyIndicator,
  infiniteBusySpinnerIntervalMs,
  isInfiniteTurnBusy
} from "./status-indicator.js";

export interface InkTranscriptAppProps {
  busy?: boolean;
  columns?: number;
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
  homeBanner = false,
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

  return (
    <Box flexDirection="column" width={width}>
      {/* truncate-end keeps the top rule to EXACTLY one terminal row — matching the
          literal `1` inkTranscriptRowCount() assumes for it. Without this, a label
          whose Ink string-width exceeds the repo's displayWidth (emoji-presentation
          glyphs like ♾️/✅ in the brand icon or agent title) — or a title long enough
          to overflow `columns` — word-wraps the rule to 2 rows, so the predicted
          composer row (and thus the native cursor) lands one row above the input. */}
      <Text color={t.color.primary} wrap="truncate-end">{topRule(title ?? t.brand.name, t, width)}</Text>
      {transcriptLines.length ? (
        transcriptLines.map((line, index) => {
          const segments = parseAnsiSegments(line);
          return (
            <Text key={`line:${index}`} wrap="truncate-end">
              {segments.length
                ? segments.map((segment, segmentIndex) => (
                    <Text
                      key={segmentIndex}
                      color={segment.color}
                      bold={segment.bold}
                      italic={segment.italic}
                      strikethrough={segment.strikethrough}
                    >
                      {segment.text}
                    </Text>
                  ))
                : line}
            </Text>
          );
        })
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
      <InkStatusRule
        busy={busy}
        columns={width}
        nowMs={clock}
        state={state}
        status={status}
        theme={t}
        labelTick={displayLabelTick}
        spinnerTick={displaySpinnerTick}
        turnStartedAt={turnStartedAt}
      />
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

export function inkTranscriptRowCount({
  busy: busyOverride = false,
  columns = 88,
  homeBanner = false,
  indicatorTick = 0,
  nowMs = Date.now(),
  showComposer = true,
  spinnerTick = 0,
  status = [],
  theme,
  transcript,
  turnStartedAt
}: InkTranscriptAppProps): number {
  const t = theme ?? resolveTheme();
  const width = clampColumns(columns);
  const state = transcript?.state ?? getTurnState();
  const busy = busyOverride || isInfiniteTurnBusy(state);
  // Mirror the empty-transcript render branch exactly: the home banner renders
  // ROCKET_BANNER_ROWS rows, everything else falls back to a single blank row.
  const lineCount = renderTranscriptLines(transcript ?? { state }, {
    columns: width,
    nowMs,
    theme: t
  }).length;
  const transcriptRows = lineCount > 0 ? lineCount : homeBanner ? ROCKET_BANNER_ROWS : 1;
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

  return 1 + transcriptRows + statusRows + (showComposer ? 1 : 0);
}

function InkStatusRule({
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
}) {
  const rows = statusRowStrings({
    busy,
    columns,
    labelTick,
    nowMs,
    spinnerTick,
    state,
    status,
    theme,
    turnStartedAt
  });

  return (
    <>
      {rows.map((row, index) => (
        <Text color={theme.color.muted} key={`status:${index}`} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </>
  );
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
    color: true,
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
  return Math.max(40, Math.min(160, Number.isFinite(columns) ? Math.floor(columns) : 88));
}
