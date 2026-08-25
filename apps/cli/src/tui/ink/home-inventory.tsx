import React from "react";
import { Box, Text } from "./renderer.js";

import { INFINITE_ART, MIN_BIG_COLUMNS } from "./infinite-wordmark.js";
import { GROWTH_TAGLINE } from "./rocket-banner.js";
import { DITHER, RETRO } from "./retro-style.js";

/**
 * Every-launch home inventory: the big INFINITE wordmark + a compact capability
 * inventory (Tools / Commands / Connected) and the welcome line, modelled on
 * Hermes's startup screen. Rendered ONCE, above the transcript, in the
 * empty-transcript home state of the interactive session — NOT per message.
 *
 * The big-art (first-run) `InfiniteWelcome` is a separate, gated screen; this is
 * the home screen the session lands on after it.
 */

/** A friendly curated capability — what the OS can DO, not raw action ids. */
export interface HomeInventoryTool {
  /** Short verb-phrase shown in the Tools row (e.g. "connect", "generate ads"). */
  label: string;
}

/** A slash-command entry shown in the Commands row. */
export interface HomeInventoryCommand {
  /** Leading-slash command (e.g. "/connect"). */
  value: string;
}

/** A live (best-effort) connected source shown in the Connected row. */
export interface HomeInventoryConnection {
  /** Friendly provider label (e.g. "GA4", "X"). */
  label: string;
  /** "connected" renders a filled tick; "degraded" a hollow/warn tick. */
  degraded?: boolean;
}

export interface HomeInventoryProps {
  /** Friendly, curated capability list (NOT raw tool ids). */
  tools: readonly HomeInventoryTool[];
  /** Curated subset of the most useful slash commands. */
  commands: readonly HomeInventoryCommand[];
  /**
   * Live connected sources. `undefined` = the fetch was skipped or the daemon
   * was unreachable → the Connected row degrades to a muted note (or is hidden
   * when `hideConnectedWhenEmpty`). An empty array = reached the daemon, nothing
   * connected yet.
   */
  connections?: readonly HomeInventoryConnection[];
  /** Product version (e.g. "0.1.1"). */
  version?: string;
  /** Active workspace / project label. */
  workspace?: string;
  /** Force animation gate off in tests (only affects nothing here today — kept for symmetry). */
  columns?: number;
}

// The Connected row always renders (so the home screen is stable height): when
// `connections` is undefined we show a muted "daemon not reachable" note rather
// than dropping the row. This keeps the inventory's row count deterministic,
// which the composer's native-cursor row prediction depends on.
const CONNECTED_UNAVAILABLE_NOTE = "— daemon not reachable —";

// Fixed per-row labels (left gutter) so the three inventory rows align.
const LABEL_WIDTH = 11;

function padLabel(label: string): string {
  return label.padEnd(LABEL_WIDTH, " ");
}

// Per-art-row greyscale gradient (top-bright → bottom-dim), matching the welcome
// wordmark's static look but WITHOUT the animated scan line — the home inventory
// is a calm, persistent screen, not an animated splash.
const ART_LEVELS = [0, 1, 2, 3, 4, 5] as const;

function bigArtRow(line: string, rowIndex: number): React.ReactNode {
  const level = Math.max(0, Math.min(DITHER.length - 1, ART_LEVELS[rowIndex] ?? DITHER.length - 1));
  const { glyph, color } = DITHER[level]!;
  return (
    <Text color={color} key={`art:${rowIndex}`} wrap="truncate-end">
      {line.replace(/█/g, glyph)}
    </Text>
  );
}

/**
 * The number of terminal rows `HomeInventory` renders for a given width — used by
 * the interactive session to add this panel's height to the composer's
 * native-cursor row prediction (the PR #27 invariant: the predicted composer row
 * must equal the live rendered row count, or the native cursor parks a row off).
 *
 * Layout (top to bottom):
 *   - wordmark: 6 art rows (big) or 1 compact row (narrow)
 *   - 1 tagline/version/workspace row
 *   - 1 blank spacer row
 *   - 3 inventory rows (Tools / Commands / Connected — Connected always renders)
 *   - 1 blank spacer row
 *   - 1 welcome row
 *   - 1 trailing blank spacer row (separates the panel from the transcript rule)
 */
export function homeInventoryRowCount(columns = 88): number {
  const wordmarkRows = columns >= MIN_BIG_COLUMNS ? INFINITE_ART.length : 1;
  return wordmarkRows + 1 + 1 + 3 + 1 + 1 + 1;
}

function ToolsRow({ tools }: { tools: readonly HomeInventoryTool[] }) {
  return (
    <Text wrap="truncate-end">
      <Text color={RETRO.grey}>{padLabel("Tools")}</Text>
      <Text color={RETRO.light}>{tools.map((tool) => tool.label).join("  ·  ")}</Text>
    </Text>
  );
}

function CommandsRow({ commands }: { commands: readonly HomeInventoryCommand[] }) {
  return (
    <Text wrap="truncate-end">
      <Text color={RETRO.grey}>{padLabel("Commands")}</Text>
      <Text color={RETRO.light}>{commands.map((command) => command.value).join("   ")}</Text>
    </Text>
  );
}

function ConnectedRow({ connections }: { connections?: readonly HomeInventoryConnection[] }) {
  if (connections === undefined) {
    return (
      <Text wrap="truncate-end">
        <Text color={RETRO.grey}>{padLabel("Connected")}</Text>
        <Text color={RETRO.dim}>{CONNECTED_UNAVAILABLE_NOTE}</Text>
      </Text>
    );
  }
  if (connections.length === 0) {
    return (
      <Text wrap="truncate-end">
        <Text color={RETRO.grey}>{padLabel("Connected")}</Text>
        <Text color={RETRO.dim}>nothing connected yet — try /connect</Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={RETRO.grey}>{padLabel("Connected")}</Text>
      {connections.map((connection, index) => (
        <Text key={`conn:${index}`}>
          <Text color={connection.degraded ? RETRO.mid : RETRO.white}>
            {connection.degraded ? "◐" : "✓"}
          </Text>
          <Text color={RETRO.light}>{` ${connection.label}`}</Text>
          {index < connections.length - 1 ? <Text color={RETRO.grey}>{"   "}</Text> : null}
        </Text>
      ))}
    </Text>
  );
}

export function HomeInventory({
  tools,
  commands,
  connections,
  version,
  workspace,
  columns = 88
}: HomeInventoryProps) {
  const big = columns >= MIN_BIG_COLUMNS;
  const metaParts = [
    GROWTH_TAGLINE,
    version ? `v${version}` : undefined,
    workspace ? `workspace: ${workspace}` : undefined
  ].filter((part): part is string => Boolean(part));

  return (
    <Box flexDirection="column" width={columns}>
      {big ? (
        INFINITE_ART.map((row, index) => bigArtRow(row, index))
      ) : (
        <Text wrap="truncate-end">
          <Text color={RETRO.white}>{"∞  "}</Text>
          <Text bold color={RETRO.light}>INFINITE</Text>
        </Text>
      )}
      <Text wrap="truncate-end">
        <Text color={RETRO.grey}>{metaParts.join("  ·  ")}</Text>
      </Text>
      <Text wrap="truncate-end">{" "}</Text>
      <ToolsRow tools={tools} />
      <CommandsRow commands={commands} />
      <ConnectedRow connections={connections} />
      <Text wrap="truncate-end">{" "}</Text>
      <Text wrap="truncate-end">
        <Text color={RETRO.light}>Welcome to Infinite</Text>
        <Text color={RETRO.grey}> — type a message, /help, or /exit.</Text>
      </Text>
      <Text wrap="truncate-end">{" "}</Text>
    </Box>
  );
}
