// The session's chrome above and below the answer (terminal-r4 `frame()`):
// the top bar (` ∞ Infinite ` chip · workspace · connection dots · `through
// the Infinite app`), the thin rules, and the boot frame's empty answer area
// with its Steps rule. Pure: the session draws these lines through `AnsiLine`,
// and the golden tests call the same functions.

import type { AnswerViewV1 } from "@infinite-os/types";

import { terminalText } from "../../desktop/terminal-text.js";
import type { Theme } from "../theme.js";
import { paneWidths } from "../views/layout.js";
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
  /**
   * The source the turn on screen asked about and found not connected (the
   * name its view gives). Its amber mark is always drawn, first (r4's
   * not-connected frame), at any width.
   */
  asked?: string;
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
 * The top bar's segments (r4 row 0): the brand chip, the workspace (`<name>
 * workspace`), then one dot per source, missing and broken ones first.
 * `through the Infinite app` sits on the right only when the whole line fits;
 * otherwise whole sources drop from the right and are counted (`+3 more`)
 * when the count fits: a source name is never cut mid-word (run-2 N10).
 *
 * The source the turn asked about and found not connected (`asked`) is always
 * drawn, first, in amber: at 60 columns r4 still leads with it and cuts the
 * connected dots. When the bar knows no missing source by that name, the first
 * missing one stands for it; a name the bar knows as connected or broken
 * forces nothing.
 *
 * Any OTHER missing mark never costs a connected or a broken source its place:
 * those are drawn, in their order, only while they fit whole beside every
 * other source. A workspace with many sources never connected still shows
 * what IS connected.
 */
export function topBarSegments(data: TopBarData | undefined, width: number): StyledSegment[] {
  const workspace = workspaceWords(data?.workspace);
  const head: StyledSegment[] = [BRAND_CHIP, ["", workspace ? `  ${workspace}   ` : "  "]];
  const left: StyledSegment[] = [];
  const sources = [...(data?.sources ?? [])]
    .map((source, index) => ({ ...source, label: terminalText(source.label), index }))
    .filter((source) => source.label)
    .sort((a, b) => SOURCE_ORDER[a.state] - SOURCE_ORDER[b.state] || a.index - b.index);
  const total = Math.max(1, Math.floor(width));
  const segment = (source: { label: string; state: TopBarSourceState }): StyledSegment =>
    source.state === "connected"
      ? ["green", `● ${source.label} `]
      : [source.state === "missing" ? "amber" : "red", `⊘ ${source.label} `];
  const missing = sources.filter((source) => source.state === "missing");
  const asked = sourceKey(data?.asked);
  const known = asked ? sources.find((source) => sourceKey(source.label) === asked) : undefined;
  const lead = !asked ? undefined : known ? (known.state === "missing" ? known : undefined) : missing[0];
  if (lead) {
    left.push(segment(lead));
  }
  const kept = sources.filter((source) => source.state !== "missing").map(segment);
  let room = total - segmentsWidth(head) - segmentsWidth(left) - segmentsWidth(kept);
  for (const source of missing) {
    if (source === lead) continue;
    const mark = segment(source);
    room -= segmentsWidth([mark]);
    if (room < 0) break;
    left.push(mark);
  }
  left.push(...kept);
  const line = [...head, ...left];
  if (data?.throughApp && segmentsWidth(line) + segmentsWidth([THROUGH_APP]) <= total) {
    return [...padSegments(line, total - segmentsWidth([THROUGH_APP])), THROUGH_APP];
  }
  // Whole sources only (run-2 N10): a source that does not fit drops, with
  // every one after it. They are counted (`+3 more`, dim) when that fits;
  // else, with two cells left, the next one's mark and `…` say there is more
  // (r4's own cut, `●…`, which shows no letter of a name). A source name is
  // never cut mid-word; only a window too narrow for the chip and the
  // workspace cuts the line itself.
  let used = segmentsWidth(head);
  const shown: StyledSegment[] = [];
  for (const mark of left) {
    if (used + segmentsWidth([mark]) > total) break;
    shown.push(mark);
    used += segmentsWidth([mark]);
  }
  const next = left[shown.length];
  const more: StyledSegment[] = [];
  if (next) {
    const count: StyledSegment = ["dim", `+${left.length - shown.length} more`];
    if (used + segmentsWidth([count]) <= total) more.push(count);
    else if (total - used >= 2) more.push([next[0], `${Array.from(next[1])[0] ?? ""}…`]);
  }
  return truncSegments([...head, ...shown, ...more], total);
}

/**
 * The workspace as r4 names it: `<name> workspace` (`Infinite workspace`,
 * never `∞ Infinite  Infinite` beside the brand chip, run-2 N10). A name that
 * already ends in `workspace` is not said twice. Scrubbed; "" for none.
 */
function workspaceWords(name: string | undefined): string {
  const scrubbed = name ? terminalText(name).trim() : "";
  if (!scrubbed) return "";
  return /\bworkspace$/iu.test(scrubbed) ? scrubbed : `${scrubbed} workspace`;
}

/** A source's name as the bar compares it: scrubbed, lower case, single spaces. */
function sourceKey(name: string | undefined): string {
  return name ? terminalText(name).toLowerCase().replace(/\s+/gu, " ").trim() : "";
}

/**
 * The source a turn asked about and found not connected: the name its latest
 * not-connected view gives (`provenance.source`). Null when no view says so,
 * so the bar forces no mark.
 */
export function askedSource(views: readonly Pick<AnswerViewV1, "state" | "provenance">[]): string | null {
  for (let index = views.length - 1; index >= 0; index -= 1) {
    const view = views[index]!;
    if (view.state !== "not_connected") continue;
    const name = terminalText(view.provenance?.source ?? "");
    if (name) return name;
  }
  return null;
}

/** A thin rule across the width, in the `line` grey. */
export function ruleLine(width: number, theme: Theme, mark?: RuleMark | null): string {
  const total = Math.max(1, Math.floor(width));
  if (!mark) {
    return paintSegments([["line", "─".repeat(total)]], theme);
  }
  // The focused pane's part of the rule (live L8): heavy, in the accent, so it reads without colour too.
  const from = Math.max(0, Math.min(total, Math.floor(mark.from)));
  const to = Math.max(from, Math.min(total, Math.floor(mark.to)));
  return paintSegments([["line", "─".repeat(from)], ["cyan", "━".repeat(to - from)], ["line", "─".repeat(total - to)]], theme);
}

/** The columns of the rule under the top bar that mark the pane the keys are on. */
export interface RuleMark {
  from: number;
  to: number;
}

/** The top bar and the rule under it, painted at the theme's tier. */
export function topBarLines(data: TopBarData | undefined, width: number, theme: Theme, mark?: RuleMark | null): string[] {
  return [paintSegments(topBarSegments(data, width), theme), ruleLine(width, theme, mark)];
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
 * One row of the boot frame's empty answer area. In the split layout (from
 * 80 columns, as r4's `frame()` and the turn layout's `paneWidths`) it is the
 * empty answer pane (28% of the width, clamped to 26–40 columns) and the
 * separator's `│`; one column, a blank row.
 */
function bootAnswerRow(width: number, theme: Theme): string {
  const panes = paneWidths(width);
  if (!panes.wide) {
    return " ";
  }
  return paintSegments([["", " ".repeat(panes.left + 1)], ["line", "│"]], theme);
}
