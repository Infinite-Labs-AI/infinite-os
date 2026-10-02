// The session's chrome above and below the answer (terminal-r4 `frame()`):
// the top bar (` ∞ Infinite ` chip · workspace · connection dots · `through
// the Infinite app`), the thin rules, and the boot frame's empty answer area
// with its Steps rule. Pure: the session draws these lines through `AnsiLine`,
// and the golden tests call the same functions.

import { terminalText } from "../../desktop/terminal-text.js";
import type { Theme } from "../theme.js";
import {
  padSegments,
  paintSegments,
  segmentsWidth,
  truncSegments,
  type StyledSegment
} from "../lib/styled-segments.js";

/** How a source looks in the top bar: `●` connected, `⊘` broken (red) or asked for and missing (amber). */
export type TopBarSourceState = "connected" | "broken" | "missing";

export interface TopBarSource {
  label: string;
  state: TopBarSourceState;
}

export interface TopBarData {
  /** The workspace the session works in. */
  workspace?: string;
  /**
   * The workspace's sources, when the terminal knows them. Undefined draws no
   * dots: the bar never guesses what is connected.
   */
  sources?: readonly TopBarSource[];
  /** The session runs through the Infinite app: say so on the right when the whole line fits. */
  throughApp?: boolean;
}

/** Rows `topBarLines` draws: the bar and its rule. */
export const TOP_BAR_ROWS = 2;

/** Rows of empty answer area the boot frame draws above its Steps rule (r4's boot frame). */
export const BOOT_ANSWER_ROWS = 8;

/** Rows the boot frame draws between the top bar and the composer's rule: the answer area and the Steps rule. */
export const BOOT_BODY_ROWS = BOOT_ANSWER_ROWS + 1;

const BRAND_CHIP: StyledSegment = ["inv", " ∞ Infinite "];
const THROUGH_APP: StyledSegment = ["dim", "through the Infinite app "];

const SOURCE_ORDER: Readonly<Record<TopBarSourceState, number>> = { missing: 0, broken: 1, connected: 2 };

/**
 * The top bar's segments (r4 row 0): the brand chip, the workspace, then one
 * dot per source, missing and broken ones first. `through the Infinite app`
 * sits on the right only when the whole line fits; otherwise the line is cut
 * at the width (`…` on the segment that does not fit, later ones dropped).
 *
 * A missing (not connected) mark never costs a connected or a broken one its
 * place: the missing ones are drawn, in their order, only while they fit whole
 * beside every other source. A workspace with many sources never connected
 * still shows what IS connected.
 */
export function topBarSegments(data: TopBarData | undefined, width: number): StyledSegment[] {
  const workspace = data?.workspace ? terminalText(data.workspace) : "";
  const left: StyledSegment[] = [BRAND_CHIP, ["", workspace ? `  ${workspace}   ` : "  "]];
  const sources = [...(data?.sources ?? [])]
    .map((source, index) => ({ ...source, label: terminalText(source.label), index }))
    .filter((source) => source.label)
    .sort((a, b) => SOURCE_ORDER[a.state] - SOURCE_ORDER[b.state] || a.index - b.index);
  const total = Math.max(1, Math.floor(width));
  const segment = (source: { label: string; state: TopBarSourceState }): StyledSegment =>
    source.state === "connected"
      ? ["green", `● ${source.label} `]
      : [source.state === "missing" ? "amber" : "red", `⊘ ${source.label} `];
  const kept = sources.filter((source) => source.state !== "missing").map(segment);
  let room = total - segmentsWidth(left) - segmentsWidth(kept);
  for (const source of sources.filter((item) => item.state === "missing")) {
    const mark = segment(source);
    room -= segmentsWidth([mark]);
    if (room < 0) break;
    left.push(mark);
  }
  left.push(...kept);
  if (data?.throughApp && segmentsWidth(left) + segmentsWidth([THROUGH_APP]) <= total) {
    return [...padSegments(left, total - segmentsWidth([THROUGH_APP])), THROUGH_APP];
  }
  return truncSegments(left, total);
}

/** A thin rule across the width, in the `line` grey. */
export function ruleLine(width: number, theme: Theme): string {
  return paintSegments([["line", "─".repeat(Math.max(1, Math.floor(width)))]], theme);
}

/** The top bar and the rule under it, painted at the theme's tier. */
export function topBarLines(data: TopBarData | undefined, width: number, theme: Theme): string[] {
  return [paintSegments(topBarSegments(data, width), theme), ruleLine(width, theme)];
}

/** `─ Steps ─────`: the rule the Steps strip hangs from (the boot frame draws it with no steps). */
export function stepsRuleLine(width: number, theme: Theme): string {
  const total = Math.max(8, Math.floor(width));
  return paintSegments([["line", "─"], ["", " "], ["b", "Steps"], ["", " "], ["line", "─".repeat(total - 8)]], theme);
}

/**
 * The boot frame's body (D4): an empty answer area, then the Steps rule, at
 * most `rows` rows. An empty row is a single space: Ink draws an empty text
 * as no row at all.
 */
export function bootBodyLines(width: number, theme: Theme, rows: number = BOOT_BODY_ROWS): string[] {
  const answerRows = Math.max(0, Math.min(BOOT_ANSWER_ROWS, Math.floor(rows) - 1));
  const row = bootAnswerRow(width, theme);
  return [...Array.from({ length: answerRows }, () => row), stepsRuleLine(width, theme)];
}

/**
 * The split layout's threshold (River, 2026-10-02: the answer and its details
 * sit side by side at 120 columns and up). Mirrors R2's `SPLIT_MIN_COLUMNS` in
 * views/layout.ts; use that one once both lanes are merged.
 */
const BOOT_SPLIT_MIN_COLUMNS = 120;

/**
 * One row of the boot frame's empty answer area. In the split layout it is the
 * empty answer pane (28% of the width, clamped to 26–40 columns, as the
 * layout's `paneWidths`) and the separator's `│`; one column, a blank row.
 */
function bootAnswerRow(width: number, theme: Theme): string {
  const total = Math.max(1, Math.floor(width));
  if (total < BOOT_SPLIT_MIN_COLUMNS) {
    return " ";
  }
  const answerWidth = Math.max(26, Math.min(40, Math.floor(total * 0.28)));
  return paintSegments([["", " ".repeat(answerWidth + 1)], ["line", "│"]], theme);
}
