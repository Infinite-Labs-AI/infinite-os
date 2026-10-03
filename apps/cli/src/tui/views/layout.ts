// The r4 turn layout (terminal-r4 `frame()`): the CURRENT turn, in a window
// at least 80 columns wide (r4's own `const wide=W>=80`, so an everyday
// window sees it; layout decision, 2026-10-03), puts the answer on the
// left, the view's details on the right and the Steps strip below. When wide
// it ALWAYS splits, as r4 does: a turn with nothing for the right pane shows
// r4's dim `steps only` there. Narrower, and for every turn committed to
// scrollback, the turn is ONE column: the question, the answer, a rule, the
// details underneath, then the Steps. The key bar and the composer are the
// session's, below all of it.
//
// One thing keeps a turn in ONE column from 80 columns too, a case r4 does
// not draw: its answer carries a markdown table that would not draw whole in
// the answer pane. The pane is 26 to 40 columns, where a wide table turns
// into `label: value` stacks or drops columns; at the whole width it stays a
// bordered table, and the details follow under it. A table small enough for
// the pane keeps the split.
//
// A turn TALLER than the window keeps the split too (layout decision,
// 2026-10-03): given the rows the live region has for it, the panes are held
// to them. The details pane shows the view from its top (or where ↓/↑ scrolled
// it, after tab; j/k scroll it just enough to keep the selected row on
// screen) and its last row says `↓ N more · tab, then ↓`; while the turn
// runs, an answer taller than the room shows its newest lines. FINISHED, the
// answer pane is held the same way (live L8: a finished tall turn kept the
// split and its keys only if it fit): it shows the question from the top (or
// where ↓/↑ scrolled it, once tab put the keys on it) with its own `↓ N more`
// / `↑ N above` line. A short pane is padded as r4's frame() pads it (16 rows,
// as the window allows), and a blank pane row always sits over the Steps rule.
// Committed to scrollback the turn is written whole, in one column, as before.
//
// Every line this returns fits its width: the panes are laid out to their own
// widths first, and each line is cut to fit as a last resort.
import type { AnswerViewV1 } from "@infinite-os/types";

import { holdOpenMarkers } from "../../formatting/markdown-inline.js";
import { markdownHasTable, markdownTablesFit } from "../../formatting/markdown-render.js";
import { answerTextWidth } from "../app/answer-column.js";
import { renderTurnBody, workingAnswerLines } from "../app/transcript-renderer.js";
import type { TurnState, TurnStep } from "../app/turn-store.js";
import type { KeyContext } from "../keys/keymap.js";
import { padEndCells } from "../lib/display-width.js";
import { DEFAULT_THEME, type Theme } from "../theme.js";
import type { Msg } from "../types.js";
import {
  focusedViewCtx,
  focusedViewIndex,
  foldedLookups,
  openingRow,
  NO_VIEW_CAPS,
  viewKeyFacts,
  type ViewFocusState,
  type ViewKeyFacts
} from "./focus.js";
import { turnRepeats } from "./meta-fold.js";
import { fitLine, paint } from "./primitives.js";
import { renderView } from "./registry.js";
import { stepHeader, stepRowLines, stepsFromTrail, unsettledStepLines } from "./steps.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

export { stepLabelWidth } from "./steps.js";

/** At this width and up, the current turn's answer and details sit side by side (r4 `frame()`: `wide=W>=80`). */
export const SPLIT_MIN_COLUMNS = 80;
export const PANE_SEPARATOR = " │ ";
/** The answer pane's widest (28% of the window, clamped to 26–40). */
export const ANSWER_PANE_MAX = 40;

/** The answer pane is 28% of the width, clamped to 26–40 columns; the details get the rest. */
export function paneWidths(width: number): { wide: boolean; left: number; right: number } {
  const total = Math.max(1, Math.floor(width));
  if (total < SPLIT_MIN_COLUMNS) {
    return { wide: false, left: total, right: total };
  }
  const left = Math.max(26, Math.min(ANSWER_PANE_MAX, Math.floor(total * 0.28)));
  return { wide: true, left, right: total - left - PANE_SEPARATOR.length };
}

/**
 * One drawn view as lines: head, source, a blank row, the details, then
 * footnotes right under them. A quiet view without a head is its step line only; lines with no
 * head and no source (a card handed in) are the details alone.
 */
export function viewLines(render: ViewRender, width: number, compact = false): string[] {
  if (!inDetailsPane(render)) {
    return render.detail.map((line) => fitLine(line, width));
  }
  // Footnotes sit right under what they note (r4: `¹ not measured: …` under the table).
  const body = [...render.detail, ...render.footnotes];
  const top = render.head || render.source !== null ? [render.head, ...(render.source !== null ? [render.source] : [])] : [];
  return [...top, ...(top.length && body.length && !compact ? [""] : []), ...body].map((line) => fitLine(line, width));
}

/**
 * Lay out one turn. `answer` is drawn at the answer pane's width when split
 * (see `paneWidths`), else at the full width; each view at its pane's width.
 * Several views stack in the details pane, a blank row apart. No view = the
 * answer alone, full width. A quiet view with no head never takes the details
 * pane: its step line prints with the Steps, so a turn whose views are all
 * quiet keeps its answer full width (one with a head, r4's `steps only`, is a
 * details pane like any other). `split: false` keeps one column at any width (a turn
 * committed to scrollback). `steps` is the Steps strip's rows (the header is
 * drawn here). `compact: true` leaves out the blank rows around the details
 * (over the rule, under the details' head, over the Steps): see
 * `LiveTurnInput.compact`.
 */
export function layoutTurn(
  answer: readonly string[],
  view: ViewRender | readonly ViewRender[] | null,
  steps: readonly string[],
  width: number,
  style: { color: boolean; theme: Theme } | null = null,
  options: LayoutOptions = {}
): string[] {
  return layoutTurnParts(answer, view, steps, width, style, options).lines;
}

export interface LayoutOptions {
  split?: boolean;
  steps?: boolean;
  compact?: boolean;
  /**
   * The rows the whole turn may take (the live region's room for it). When
   * split, the panes are held to it: the answer pane keeps its newest lines,
   * the details pane shows `paneScroll` onward with a dim `↓ N more` line, and
   * a short pane is padded as r4's `frame()` pads it (to 16 rows at most).
   * Undefined: no cap and no padding (only the blank pane row over the Steps).
   */
  maxRows?: number;
  /** The first details line shown when the details pane is cut (clamped). */
  paneScroll?: number;
  /** The keys are on the details pane (after tab): the more line names ↓ PgDn, not tab. */
  paneKeys?: boolean;
  /**
   * Keep this view's selected row (`selectedLines`) on screen in a cut pane
   * (j/k moved it): the pane scrolls from `paneScroll` just enough to show it.
   */
  follow?: ViewRender;
  /**
   * The turn is still running: an answer taller than the room keeps its newest
   * lines in the answer pane.
   */
  answerTail?: boolean;
  /**
   * A FINISHED answer taller than the room is held to it too (live L8): the
   * answer pane shows `answerScroll` onward with its own dim `↓ N more` /
   * `↑ N above` line, so the turn keeps the split and its keys. Off (a card
   * still waiting beside it): such an answer is drawn whole, as before.
   */
  answerCut?: boolean;
  /** The first answer line shown when the answer pane is cut (clamped). */
  answerScroll?: number;
  /** The keys are on the answer pane (after tab): its more line names ↓ PgDn, not tab. */
  answerKeys?: boolean;
}

/** r4 `frame()` pads the panes to this many rows (`while(wide&&body.length<16)`). */
export const PANE_MIN_ROWS = 16;
/** Fewer pane rows than this and a tall turn is drawn as it was, uncapped (the window is too short to split it usefully). */
const PANE_CAP_FLOOR = 4;

/** Where a cut details pane stands: lines above and below what it shows, and how many it shows. */
export interface PaneWindow {
  above: number;
  below: number;
  shown: number;
}

function layoutTurnParts(
  answer: readonly string[],
  view: ViewRender | readonly ViewRender[] | null,
  steps: readonly string[],
  width: number,
  style: { color: boolean; theme: Theme } | null,
  options: LayoutOptions
): { lines: string[]; pane: PaneWindow | null; answerPane: PaneWindow | null; natural: number } {
  const total = Math.max(1, Math.floor(width));
  const all: readonly ViewRender[] = view === null ? [] : isRenderList(view) ? view : [view];
  // A steps-only view speaks only when the turn has nothing else to show
  // (r4 view-12): beside another view or a card it prints nothing, and the
  // Steps strip says what it read (run-2 M6: no stray `steps only`).
  const renders = paneRenders(all);
  const quietSteps = all.every((render) => render.quiet)
    ? all.filter((render) => !inDetailsPane(render)).flatMap((render) => render.detail.map((line) => `  ${line}`))
    : [];
  const rule = (line: string) => (style ? paint(line, "line", style) : line);
  const out: string[] = [];
  const panes = paneWidths(total);
  const wide = panes.wide && options.split !== false;
  const compact = options.compact === true;
  // `steps: false` (a turn committed to scrollback, D1) draws no Steps strip at all.
  const strip = options.steps === false ? [] : [...steps, ...quietSteps];
  let pane: PaneWindow | null = null;
  let answerPane: PaneWindow | null = null;
  let natural = 0;

  if (!renders.length) {
    out.push(...answer.map((line) => fitLine(line, total)));
  } else {
    const details: string[] = [];
    // The followed row's lines in `details` (j/k in a cut pane).
    let followed: readonly [number, number] | null = null;
    for (const [index, render] of renders.entries()) {
      if (index > 0) details.push("");
      const drawnView = viewLines(render, wide ? panes.right : total, compact);
      if (render === options.follow && render.selectedLines) {
        // `viewLines` puts the head, the source and a blank row over the detail, and the footnotes under it.
        const bodyStart = inDetailsPane(render) ? drawnView.length - render.detail.length - render.footnotes.length : 0;
        followed = [details.length + bodyStart + render.selectedLines[0], render.selectedLines[1]];
      }
      details.push(...drawnView);
    }
    if (wide) {
      const separator = rule(PANE_SEPARATOR);
      const row = (left: string, right: string) => right
        ? `${padEndCells(fitLine(left, panes.left), panes.left)}${separator}${fitLine(right, panes.right)}`
        // r4 `side()`: the separator on every row; an empty details row ends at the bar.
        : `${padEndCells(fitLine(left, panes.left), panes.left)}${rule(PANE_SEPARATOR.trimEnd())}`;
      // r4 leaves a blank pane row over the Steps rule, so it never sits right under the last line.
      const gap = strip.length ? 1 : 0;
      natural = Math.max(answer.length, details.length) + gap;
      const capacity = options.maxRows === undefined ? undefined : Math.floor(options.maxRows) - (strip.length ? strip.length + 1 : 0);
      const capped = capacity !== undefined && capacity - gap >= PANE_CAP_FLOOR
        && (options.answerTail === true || options.answerCut === true || answer.length <= capacity - gap);
      const room = capped ? capacity - gap : Number.POSITIVE_INFINITY;
      let left: readonly string[] = answer;
      if (answer.length > room && options.answerTail !== true) {
        // Finished (live L8): the answer pane is cut like the details pane, from its top or where ↓/↑ scrolled it.
        const shown = room - 1;
        const above = Math.max(0, Math.min(answer.length - shown, Math.floor(options.answerScroll ?? 0)));
        answerPane = { above, below: answer.length - above - shown, shown };
        left = [...answer.slice(above, above + shown), paneMoreLine(answerPane, options.answerKeys === true, style)];
      } else if (answer.length > room) {
        // Running: a tall answer keeps its newest lines (what is arriving).
        left = answer.slice(answer.length - room);
      }
      let right = details;
      if (details.length > room) {
        const shown = room - 1;
        let from = Math.floor(options.paneScroll ?? 0);
        if (followed) {
          // Just enough to show the selected row: up to its first line, or down to its last.
          const [start, count] = followed;
          if (start < from) from = start;
          else if (start + Math.min(count, shown) > from + shown) from = start + Math.min(count, shown) - shown;
        }
        const above = Math.max(0, Math.min(details.length - shown, from));
        const below = details.length - above - shown;
        pane = { above, below, shown };
        right = [...details.slice(above, above + shown), paneMoreLine(pane, options.paneKeys === true, style)];
      }
      // r4 pads a short pane to 16 rows; never past the room the window gives.
      const rows = Math.max(left.length, right.length, capped ? Math.min(PANE_MIN_ROWS, room + gap) : 0);
      for (let index = 0; index < rows; index += 1) {
        out.push(row(left[index] ?? "", right[index] ?? ""));
      }
      if (gap && (left[rows - 1] ?? "") + (right[rows - 1] ?? "") !== "") {
        out.push(row("", ""));
      }
    } else {
      // The rule parts the answer from the details; a turn with no answer
      // (a card that arrived on its own) starts at its details.
      out.push(
        ...answer.map((line) => fitLine(line, total)),
        ...(answer.length ? [...(compact ? [] : [""]), rule("─".repeat(total))] : []),
        ...details
      );
    }
  }

  if (!(renders.length && wide)) {
    natural = out.length;
  }
  if (strip.length) {
    // One column: a blank row between the details and the Steps (r4 stacked frame).
    if (renders.length && !wide && !compact) {
      out.push("");
      natural += 1;
    }
    out.push(stepHeader(total, style ?? { color: false, theme: DEFAULT_THEME }), ...strip.map((line) => fitLine(line, total)));
    natural += strip.length + 1;
  }
  return { lines: out, pane, answerPane, natural };
}

/**
 * The dim last row of a cut details pane: how much is below and how to reach
 * it (`↓ 12 more · tab, then ↓`; once the keys are on the pane, `↓ PgDn`), or,
 * scrolled to its end, how much is above.
 */
function paneMoreLine(pane: PaneWindow, keysOnPane: boolean, style: { color: boolean; theme: Theme } | null): string {
  const words = pane.below > 0
    ? `↓ ${pane.below} more · ${keysOnPane ? "↓ PgDn" : "tab, then ↓"}`
    : `↑ ${pane.above} above · ↑ PgUp`;
  return style ? paint(words, "dim", style) : words;
}

/**
 * The answer column: the question (`❯`), then the answer (`∞`, markdown, with
 * its project label), diffs, the trail's thinking and todos, and any notes.
 * The tool calls are not here: they are the Steps strip. The same renderer as
 * the transcript (`renderTurnBody`), so a turn drawn here or committed to
 * scrollback keeps everything the transcript shows.
 */
export function renderAnswerColumn(
  messages: readonly Msg[],
  width: number,
  theme: Theme,
  color: boolean
): string[] {
  return renderTurnBody(messages, { columns: width, color, theme });
}

export interface LiveTurnInput {
  messages: readonly Msg[];
  views: readonly AnswerViewV1[];
  /** The latest turn's key focus (selection, tab, page, `?`, `→`); null = defaults. */
  focus: ViewFocusState | null;
  width: number;
  color: boolean;
  theme: Theme;
  caps?: KeyContext["caps"];
  timeZone?: string;
  /**
   * The rows the turn may take in the live region, when known (the session
   * passes `inkLatestTurnRows`). A document pages so the whole turn fits.
   */
  rows?: number;
  /** The live region has more lines below (lets `m` page it). */
  livePageNext?: boolean;
  /**
   * The turn's tool calls with their start and end (the turn store's `steps`),
   * for the Steps strip. Absent or empty: the strip comes from the tool trail
   * in `messages`, laid end to end.
   */
  steps?: readonly TurnStep[];
  /** Now (epoch ms), for a call still running. */
  nowMs?: number;
  /**
   * The running turn's state, for a question drawn with nothing in its details
   * pane but `steps only`: until something answers, the answer column ends on
   * the transcript's `⠋ Working…` line (at `nowMs`).
   */
  working?: TurnState;
  /**
   * The turn is still running (its answer may still be arriving): split and
   * held to `rows`, an answer taller than the room shows its newest lines. A
   * finished turn whose answer alone is taller is drawn whole (see `LayoutOptions.answerTail`).
   */
  running?: boolean;
  /**
   * Lines already drawn for the details pane, after the views: the turn's
   * pending write card (its head, source and box), so it takes the right pane
   * from 80 columns and follows the answer and a rule below that, with the
   * Steps under it, as r4 draws "Needs your OK". Draw them at
   * `detailsPaneWidth(width)` columns.
   */
  details?: readonly string[];
  /**
   * Views the turn holds but does not draw as views (the pending write card's
   * own view): a call's Steps status still follows them (needs_yes → ▣).
   */
  statusViews?: readonly AnswerViewV1[];
  /**
   * Draw the turn without the blank rows around its details: the one over the
   * rule (one column), the one under the details' head and source, and the one
   * over the Steps (one column). The session asks for it only when a FINISHED
   * turn misses the live region by those rows: it then stays live, under the
   * top bar, with its Steps and its keys, where it would otherwise go to
   * scrollback. Everything else is drawn as usual.
   */
  compact?: boolean;
}

/** The columns the details pane gives a view or a card at this width (the whole width when one column). */
export function detailsPaneWidth(width: number, split = true): number {
  const panes = paneWidths(width);
  return panes.wide && split ? panes.right : Math.max(1, Math.floor(width));
}

/**
 * Whether the answer column draws a markdown table: in the answer itself or
 * in a note the model wrote (the messages `renderTurnBody` draws as markdown;
 * never the question, a tool's own output or a diff). An answer still
 * arriving counts as soon as its table's header rule has come.
 */
export function answerCarriesTable(messages: readonly Msg[]): boolean {
  return messages.some((msg) =>
    msg.role !== "user" && msg.role !== "tool" && msg.kind !== "diff"
    && markdownHasTable(msg.partial ? holdOpenMarkers(msg.text) : msg.text));
}

/**
 * Whether a live turn with these messages may sit side by side at this width:
 * the window is at least 80 columns and every table of the answer's own
 * draws whole (bordered, no column dropped) in the answer pane.
 * The session draws a pending card at `detailsPaneWidth(width, turnMaySplit(…))`.
 */
export function turnMaySplit(messages: readonly Msg[], width: number): boolean {
  const panes = paneWidths(width);
  return panes.wide && answerTablesFit(messages, panes.left);
}

/**
 * Whether the live messages are a question to Infinite (a typed line that is
 * not a `/` command, and no command output with it): the turns r4 draws in its
 * frame, so the session draws one in the turn layout even with no view, its
 * details pane r4's `steps only`. A command's output stays the transcript's.
 * The question's own notes (its stop or error line, a line queued behind it:
 * `turnNote`) keep it a question, so it never jumps to one column as it ends.
 */
export function isQuestionTurn(messages: readonly Msg[]): boolean {
  return messages.some((msg) => msg.role === "user" && msg.kind === undefined && !msg.text.trimStart().startsWith("/"))
    && messages.every((msg) => (msg.kind !== "slash" || msg.turnNote === true) && msg.kind !== "intro" && msg.kind !== "panel");
}

/**
 * Whether every markdown table the answer column draws stays a bordered table
 * with all of its columns in a column `width` wide (true when it has none).
 */
function answerTablesFit(messages: readonly Msg[], width: number): boolean {
  return messages.every((msg) =>
    msg.role === "user" || msg.role === "tool" || msg.kind === "diff"
    || markdownTablesFit(msg.partial ? holdOpenMarkers(msg.text) : msg.text, answerTextWidth(width)));
}

export interface LiveTurnRender {
  lines: string[];
  /** The view the keys act on, as drawn now, and what it offers. */
  focused: { render: ViewRender; facts: ViewKeyFacts } | null;
  /**
   * The turn draws details (a view that takes the details pane, or a card):
   * right of the answer from 80 columns, under it below that. The key bar
   * offers `tab switch side` only then.
   */
  details: boolean;
  /** A view pages inside itself (a long document's `space next page`): the turn is not whole on screen. */
  paged: boolean;
  /**
   * The details pane is cut to the window (a split turn taller than it): what
   * it shows and what is above and below. Null when the pane is whole.
   */
  pane: PaneWindow | null;
  /** The answer pane is cut to the window (a finished split turn whose answer is taller than it). */
  answerPane: PaneWindow | null;
}

/** The latest turn with its views, laid out for the live region: side by side from 80 columns. */
export function renderLiveTurn(input: LiveTurnInput): LiveTurnRender {
  const width = Math.max(1, Math.floor(input.width));
  const budget = typeof input.rows === "number" && Number.isFinite(input.rows) ? Math.max(1, Math.floor(input.rows)) : undefined;
  let drawn = drawLiveTurn(input, width, budget, true, true, budget);
  // The views start from the whole budget; while the turn is taller than it,
  // give the views that many rows fewer (a document then pages smaller). Stops
  // when the turn fits or stops shrinking (a long answer, a page at its floor).
  // Measured uncapped (`natural`): a split turn is held to the budget anyway,
  // its details pane cut with `↓ N more`, but a document still pages to fit.
  for (let pass = 0; budget !== undefined && pass < 3; pass += 1) {
    const overflow = drawn.natural - budget;
    if (overflow <= 0 || drawn.rows === undefined || drawn.rows - overflow < 1) {
      break;
    }
    const next = drawLiveTurn(input, width, drawn.rows - overflow, true, true, budget);
    if (next.natural >= drawn.natural) {
      break;
    }
    drawn = next;
  }
  const { renders, lines, focusIndex, pane, answerPane } = drawn;
  const focusedRender = renders[focusIndex];
  return {
    lines,
    focused: focusedRender
      ? {
        render: focusedRender,
        facts: {
          ...viewKeyFacts(input.views[focusIndex], focusedRender, input.livePageNext ?? false),
          ...(pane ? { pane: { above: pane.above, below: pane.below, page: pane.shown } } : {}),
          ...(answerPane ? { answerPane: { above: answerPane.above, below: answerPane.below, page: answerPane.shown } } : {})
        }
      }
      : null,
    details: drawn.details,
    paged: renders.some((render) => (render.pages ?? 0) > 1),
    pane,
    answerPane
  };
}

/**
 * The rows a live turn shows WITH its pending card, besides the card, at
 * `width`: the other views in the details pane and the Steps (with the blank
 * pane row over them from 80 columns), plus, below
 * 80 columns, the blank and the rule over the details and the blank over
 * the Steps. The question and the answer are not counted: from 80 they sit
 * beside the card, and below it a tall answer pages away above it (the turn
 * opens on its card). The session holds the card to the rest of the live
 * budget, so the card's head, title and OK key stay on screen.
 */
export function rowsBesideCard(input: Omit<LiveTurnInput, "details" | "rows" | "livePageNext">): number {
  const width = Math.max(1, Math.floor(input.width));
  const drawn = drawLiveTurn({ ...input, details: [CARD_PLACEHOLDER] }, width, undefined, true);
  const around = drawn.stepRows + drawn.detailRows - 1;
  // Wide, r4's blank pane row over the Steps rule; one column, the blank and the rule over the details and the blank over the Steps.
  return drawn.wide ? around + (drawn.stepRows ? 1 : 0) : around + (drawn.answerRows ? 2 : 0) + (drawn.stepRows ? 1 : 0);
}

/** One details row standing in for the card while its neighbours are measured. */
const CARD_PLACEHOLDER = " ";

export interface CommittedTurnInput extends Omit<LiveTurnInput, "rows" | "livePageNext" | "compact"> {
  /**
   * The turn's calls stay live under a write card that still waits (the rest
   * of the turn goes to scrollback, the card keeps the Steps): print none of
   * them here. They print with what is committed once the card is answered.
   */
  stepsStayLive?: boolean;
}

/**
 * A finished turn as it is printed once into scrollback (D1): ONE column at
 * any width, the question, the answer and its details underneath, every page
 * of it (no row budget). No Steps strip: the calls belonged to the live turn.
 * The one thing kept of them is every call that did NOT end clean (failed, no
 * outcome, the thing had changed, an OK never answered): its row follows the
 * answer, a blank row apart, so why a step failed is still in scrollback.
 */
export function renderCommittedTurn(input: CommittedTurnInput): string[] {
  const width = Math.max(1, Math.floor(input.width));
  // No row budget: a document is one page as tall as its body (no page line,
  // which no key could act on in scrollback), whatever page the live turn showed.
  // No rule of its own: scrollback draws the ONE thin rule under each turn (D1,
  // transcript-app.tsx), so a rule here would print two.
  const lines = drawLiveTurn(input, width, ALL_ROWS, false, false).lines;
  if (input.stepsStayLive) {
    return lines;
  }
  const kept = unsettledStepLines(input.steps?.length ? input.steps : stepsFromTrail(input.messages), {
    width, color: input.color, theme: input.theme, views: [...input.views, ...(input.statusViews ?? [])]
  });
  return kept.length ? [...lines, ...(lines.length ? [""] : []), ...kept] : lines;
}

/** A row budget no view reaches: a committed turn is drawn whole. */
const ALL_ROWS = Number.MAX_SAFE_INTEGER;

/**
 * One draw of the turn, its views given at most `rows` rows; `split` allows the
 * side-by-side layout; `withSteps` draws the Steps strip; `frame` holds a split
 * turn to that many rows (see `LayoutOptions.maxRows`).
 */
function drawLiveTurn(input: LiveTurnInput, width: number, rows: number | undefined, split: boolean, withSteps = true, frame?: number) {
  const panes = paneWidths(width);
  // An answer with a table of its own keeps the whole width (see the header).
  const wide = split && turnMaySplit(input.messages, width);
  const caps = input.focus?.caps ?? input.caps ?? NO_VIEW_CAPS;
  const base = {
    width: wide ? panes.right : width, color: input.color, theme: input.theme, timeZone: input.timeZone,
    ...(rows === undefined ? {} : { rows })
  };
  const plainCtx: ViewRenderCtx = {
    ...base, selected: 0, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false, caps,
    ...(split ? {} : { scrollback: true })
  };
  // A lookup of the card's own target is that card's Steps row, not a view (live run-4 N11).
  const folded = foldedLookups(input.views, [...input.views, ...(input.statusViews ?? [])]);
  // The keys go to a view that is drawn, never to a folded lookup.
  const focusIndex = input.focus ? input.focus.viewIndex : focusedViewIndex(input.views, folded);
  // A view with no key focus yet (a turn still running, a committed turn) is drawn on its opening row.
  // `→` acts only on the view the keys are on, once the turn has finished (a
  // running turn's keys are the composer's): any other names what its tables
  // hid in words.
  // A later read of the same account repeats the earlier one's parts: it draws them once (N27).
  const repeats = turnRepeats(input.views);
  const folds = (index: number): Partial<ViewRenderCtx> => (repeats[index] ? { repeats: repeats[index]! } : {});
  // Committed to scrollback (`split` false), no view has the keys, the focused one included (TJ-9):
  // it is drawn as scrollback, so it never offers a key that no longer works there.
  // What the user already did on the focused view stays done there (R-IOV-1): an
  // approval answered (p or n) stays closed, an explanation opened stays open.
  const answered = (index: number): Partial<ViewRenderCtx> => {
    if (!input.focus || index !== focusIndex || input.views[index]?.kind === "quiet") return {};
    return {
      ...(input.focus.approvalClosed ? { approvalClosed: true } : {}),
      ...(input.focus.explainOpen ? { explainOpen: true } : {})
    };
  };
  const renders = input.views.map((view, index) =>
    renderView(view, view.kind !== "quiet" && index === focusIndex && input.focus && split
      ? { ...focusedViewCtx(input.focus, base), ...folds(index) }
      : {
        ...plainCtx, selected: openingRow(view), columnKey: false,
        ...(split && input.focus && focusIndex >= 0 && index !== focusIndex ? { keysElsewhere: true } : {}),
        ...answered(index), ...folds(index)
      }));
  // Scrollback has no keys, so nothing may stay behind one. A view with tabs
  // (a document's versions) prints every tab, in order, under the one head,
  // and a list or compare table that dropped columns (`→`) prints every row
  // with all of its columns. A numbers view keeps r4's ONE table there and
  // names what it hid in words (`+ CPM hidden`, run-2 M7): its records were
  // the ~150-line dump the live eval saw. No view names a key (`ctx.scrollback`).
  const drawn = split ? renders.filter((_render, index) => !folded.has(index)) : renders.flatMap((render, index) => {
    if (folded.has(index)) return [];
    const view = input.views[index]!;
    const whole = { ...plainCtx, selected: openingRow(view), showHiddenColumns: Boolean(render.hiddenColumns) && view.kind !== "numbers", ...answered(index), ...folds(index) };
    const tabs = render.tabs ?? 0;
    if (tabs < 2) return [whole.showHiddenColumns ? renderView(view, whole) : render];
    return Array.from({ length: tabs }, (_unused, tab) => {
      const at = renderView(view, { ...whole, tab });
      return tab === 0 ? at : { ...at, head: "", source: null };
    });
  });
  const card: ViewRender[] = input.details?.length
    ? [{ head: "", source: null, detail: [...input.details], footnotes: [], keys: [], okKey: null, rowCount: 0 }]
    : [];
  const steps = !withSteps ? [] : input.steps?.length ? input.steps : stepsFromTrail(input.messages);
  const stepRows = stepRowLines(steps, {
    width, color: input.color, theme: input.theme, nowMs: input.nowMs, views: [...input.views, ...(input.statusViews ?? [])]
  });
  const takesPane = paneRenders([...drawn, ...card]).length > 0;
  const answerAt = (columns: number): string[] => {
    const body = renderAnswerColumn(input.messages, columns, input.theme, input.color);
    const working = input.working
      ? workingAnswerLines(input.messages, input.working, { columns, color: input.color, theme: input.theme, nowMs: input.nowMs ?? 0 })
      : [];
    return working.length ? [...body, ...(body.length ? [""] : []), ...working] : body;
  };
  // When wide, r4 always splits: a turn with an answer and nothing for the
  // details pane shows r4's dim `steps only` there (its calls are the Steps).
  // A finished turn with no Steps at all leaves the pane empty (the separator
  // only), so the label never points at a strip that is not on screen.
  const leftAnswer = wide && !takesPane ? answerAt(panes.left) : [];
  const quietCalls = drawn.some((render) => !inDetailsPane(render) && render.detail.length > 0);
  const hasSteps = stepRows.length > 0 || quietCalls || input.working !== undefined;
  const stepsOnly: ViewRender[] = leftAnswer.length
    ? [hasSteps ? stepsOnlyRender({ color: input.color, theme: input.theme }) : EMPTY_PANE]
    : [];
  const sideBySide = wide && (takesPane || stepsOnly.length > 0);
  const answer = leftAnswer.length ? leftAnswer : answerAt(sideBySide ? panes.left : width);
  const compact = input.compact === true;
  const keysOnAnswer = Boolean(input.focus?.answerFocus);
  const keysOnPane = Boolean(input.focus && input.focus.engaged && input.focus.focus !== "composer") && !keysOnAnswer;
  // A finished answer is held to the window (live L8), except beside a card still waiting (it pages, as before).
  const answerCut = input.running !== true && !input.details?.length;
  const laid = layoutTurnParts(answer, [...drawn, ...card, ...stepsOnly], stepRows, width, { color: input.color, theme: input.theme }, {
    split: wide, steps: withSteps, compact,
    ...(split && frame !== undefined
      ? {
        maxRows: frame, paneScroll: input.focus?.paneScroll ?? 0, paneKeys: keysOnPane, answerTail: input.running === true,
        answerCut, answerScroll: input.focus?.answerScroll ?? 0, answerKeys: keysOnAnswer
      }
      : {}),
    ...(split && input.focus?.followRow && focusIndex >= 0 && !folded.has(focusIndex) && renders[focusIndex] ? { follow: renders[focusIndex] } : {})
  });
  const lines = laid.lines;
  const detailRows = paneRenders([...drawn, ...card])
    .reduce((sum, render, index) => sum + (index > 0 ? 1 : 0) + viewLines(render, sideBySide ? panes.right : width, compact).length, 0);
  return {
    renders, lines, focusIndex: folded.has(focusIndex) ? -1 : focusIndex, rows, wide: sideBySide, details: takesPane,
    stepRows: stepRows.length ? stepRows.length + 1 : 0, detailRows, answerRows: answer.length,
    pane: laid.pane, answerPane: laid.answerPane, natural: laid.natural
  };
}

/**
 * r4's `steps only` details pane (view-12's dim head) for a wide turn with
 * nothing else to show: the label alone, no source row and no sentence.
 */
function stepsOnlyRender(style: { color: boolean; theme: Theme }): ViewRender {
  return { head: paint("steps only", "dim", style), source: null, detail: [], footnotes: [], keys: [], okKey: null, rowCount: 0, quiet: true };
}

/** An empty details pane: a wide turn with no view, no card and no Steps keeps r4's split, the separator only. */
const EMPTY_PANE: ViewRender = { head: "", source: null, detail: [], footnotes: [], keys: [], okKey: null, rowCount: 0 };

/** The renders the details pane draws: a quiet one only when the turn has nothing else to show. */
function paneRenders(all: readonly ViewRender[]): ViewRender[] {
  const quietOnly = all.every((render) => render.quiet);
  return all.filter((render) => inDetailsPane(render) && (quietOnly || !render.quiet));
}

/** Whether a drawn view takes the details pane (every view but a quiet one without a head). */
function inDetailsPane(render: ViewRender): boolean {
  return !render.quiet || Boolean(render.head);
}

function isRenderList(view: ViewRender | readonly ViewRender[]): view is readonly ViewRender[] {
  return Array.isArray(view);
}
