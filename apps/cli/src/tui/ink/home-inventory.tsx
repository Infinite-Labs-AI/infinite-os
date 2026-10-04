import React from "react";
import { Box, Text } from "./renderer.js";

import { resolveTheme, themeInkStyle, type Theme } from "../theme.js";
import { GROWTH_TAGLINE, INFINITE_ART, MIN_BIG_COLUMNS } from "./infinite-wordmark.js";
import { DITHER } from "./retro-style.js";

/**
 * The first-run inventory: the big INFINITE wordmark + a compact capability
 * inventory (Tools / Commands / Connected) and the welcome line. Shown ONCE,
 * above the boot frame, on the first-ever run only (D4: every later boot is
 * terminal-r4's frame alone; `infinite --help` carries the same wordmark and
 * inventory). Painted in r4 tokens at the session's colour tier.
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
   * Live connected sources, when the terminal read them (an empty array =
   * read, nothing connected yet). Undefined = not read: the Connected row
   * then shows `connectionsNote`, or is left out when there is none (the
   * sources live in the Infinite app, which the terminal cannot list).
   */
  connections?: readonly HomeInventoryConnection[];
  /** Why the sources could not be read, in a few words (`daemon not reachable`). */
  connectionsNote?: string;
  /** Product version (e.g. "0.1.1"). */
  version?: string;
  /** Active workspace / project label. */
  workspace?: string;
  columns?: number;
  theme?: Theme;
}

// Fixed per-row labels (left gutter) so the inventory rows align.
const LABEL_WIDTH = 11;

function padLabel(label: string): string {
  return label.padEnd(LABEL_WIDTH, " ");
}

/** Whether the Connected row is drawn: the sources were read, or there is a reason they were not. */
function showsConnectedRow(props: Pick<HomeInventoryProps, "connections" | "connectionsNote">): boolean {
  return props.connections !== undefined || Boolean(props.connectionsNote);
}

function bigArtRow(line: string, rowIndex: number, theme: Theme): React.ReactNode {
  const level = Math.max(0, Math.min(DITHER.length - 1, rowIndex));
  const { glyph, token } = DITHER[level]!;
  return (
    <Text {...themeInkStyle(theme, token)} key={`art:${rowIndex}`} wrap="truncate-end">
      {line.replace(/█/g, glyph)}
    </Text>
  );
}

/**
 * The number of terminal rows `HomeInventory` renders for a given width (and
 * Connected row) — used by the interactive session to add this panel's height
 * to the composer's native-cursor row prediction (the PR #27 invariant: the
 * predicted composer row must equal the live rendered row count).
 *
 * Layout (top to bottom):
 *   - wordmark: 6 art rows (big) or 1 compact row (narrow)
 *   - 1 tagline/version/workspace row
 *   - 1 blank spacer row
 *   - 2 inventory rows (Tools / Commands), plus Connected when it is drawn
 *   - 1 blank spacer row
 *   - 1 welcome row
 *   - 1 trailing blank spacer row (separates the panel from the top bar)
 */
export function homeInventoryRowCount(
  columns = 88,
  connected: Pick<HomeInventoryProps, "connections" | "connectionsNote"> = { connections: [] }
): number {
  const wordmarkRows = columns >= MIN_BIG_COLUMNS ? INFINITE_ART.length : 1;
  return wordmarkRows + 1 + 1 + 2 + (showsConnectedRow(connected) ? 1 : 0) + 1 + 1 + 1;
}

function ConnectedRow({
  connections,
  connectionsNote,
  theme
}: {
  connections?: readonly HomeInventoryConnection[];
  connectionsNote?: string;
  theme: Theme;
}) {
  const label = <Text {...themeInkStyle(theme, "dim")}>{padLabel("Connected")}</Text>;
  if (connections === undefined) {
    return (
      <Text wrap="truncate-end">
        {label}
        <Text {...themeInkStyle(theme, "dim")}>{`— ${connectionsNote ?? ""} —`}</Text>
      </Text>
    );
  }
  if (connections.length === 0) {
    return (
      <Text wrap="truncate-end">
        {label}
        <Text {...themeInkStyle(theme, "dim")}>nothing connected yet — try /connect</Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      {label}
      {connections.map((connection, index) => (
        <Text key={`conn:${index}`}>
          <Text {...themeInkStyle(theme, connection.degraded ? "amber" : "green")}>
            {connection.degraded ? "◐" : "✓"}
          </Text>
          <Text>{` ${connection.label}`}</Text>
          {index < connections.length - 1 ? <Text>{"   "}</Text> : null}
        </Text>
      ))}
    </Text>
  );
}

export function HomeInventory({
  tools,
  commands,
  connections,
  connectionsNote,
  version,
  workspace,
  columns = 88,
  theme
}: HomeInventoryProps) {
  const t = theme ?? resolveTheme();
  const big = columns >= MIN_BIG_COLUMNS;
  const metaParts = [
    GROWTH_TAGLINE,
    version ? `v${version}` : undefined,
    workspace ? `workspace: ${workspace}` : undefined
  ].filter((part): part is string => Boolean(part));
  const dim = themeInkStyle(t, "dim");

  return (
    <Box flexDirection="column" width={columns}>
      {big ? (
        INFINITE_ART.map((row, index) => bigArtRow(row, index, t))
      ) : (
        <Text wrap="truncate-end">
          <Text {...themeInkStyle(t, "cyan")}>{"∞  "}</Text>
          <Text {...themeInkStyle(t, "b")}>INFINITE</Text>
        </Text>
      )}
      <Text wrap="truncate-end">
        <Text {...dim}>{metaParts.join("  ·  ")}</Text>
      </Text>
      <Text wrap="truncate-end">{" "}</Text>
      <Text wrap="truncate-end">
        <Text {...dim}>{padLabel("Tools")}</Text>
        <Text>{tools.map((tool) => tool.label).join("  ·  ")}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text {...dim}>{padLabel("Commands")}</Text>
        <Text>{commands.map((command) => command.value).join("   ")}</Text>
      </Text>
      {showsConnectedRow({ connections, connectionsNote }) ? (
        <ConnectedRow connections={connections} connectionsNote={connectionsNote} theme={t} />
      ) : null}
      <Text wrap="truncate-end">{" "}</Text>
      <Text wrap="truncate-end">
        <Text>Welcome to Infinite</Text>
        <Text {...dim}> — type a message, /help, or /exit.</Text>
      </Text>
      <Text wrap="truncate-end">{" "}</Text>
    </Box>
  );
}
