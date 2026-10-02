// The r4 turn layout (terminal-r4 `frame()`; River's layout decision of
// 2026-10-02): the CURRENT turn, in a window at least 120 columns wide, puts
// the answer on the left, the view's details on the right and the Steps strip
// below. Narrower, and for every turn committed to scrollback, the turn is ONE
// column: the question, the answer, a rule, the details underneath, then the
// Steps. The key bar and the composer are the session's, below all of it.
//
// Every line this returns fits its width: the panes are laid out to their own
// widths first, and each line is cut to fit as a last resort.
import type { AnswerViewV1 } from "@infinite-os/types";

import { renderTurnBody } from "../app/transcript-renderer.js";
import type { TurnStep } from "../app/turn-store.js";
import type { KeyContext } from "../keys/keymap.js";
import { padEndCells } from "../lib/display-width.js";
import { DEFAULT_THEME, type Theme } from "../theme.js";
import type { Msg } from "../types.js";
import {
  focusedViewCtx,
  focusedViewIndex,
  NO_VIEW_CAPS,
  viewKeyFacts,
  type ViewFocusState,
  type ViewKeyFacts
} from "./focus.js";
import { fitLine, paint } from "./primitives.js";
import { renderView } from "./registry.js";
import { stepHeader, stepRowLines, stepsFromTrail } from "./steps.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

export { stepLabelWidth } from "./steps.js";

/** At this width and up, the current turn's answer and details sit side by side (River, 2026-10-02). */
export const SPLIT_MIN_COLUMNS = 120;
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
 * footnotes. A quiet view without a head is its step line only; lines with no
 * head and no source (a card handed in) are the details alone.
 */
export function viewLines(render: ViewRender, width: number): string[] {
  if (!inDetailsPane(render)) {
    return render.detail.map((line) => fitLine(line, width));
  }
  const body = [...render.detail, ...(render.footnotes.length ? ["", ...render.footnotes] : [])];
  const top = render.head || render.source !== null ? [render.head, ...(render.source !== null ? [render.source] : [])] : [];
  return [...top, ...(top.length && body.length ? [""] : []), ...body].map((line) => fitLine(line, width));
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
 * drawn here).
 */
export function layoutTurn(
  answer: readonly string[],
  view: ViewRender | readonly ViewRender[] | null,
  steps: readonly string[],
  width: number,
  style: { color: boolean; theme: Theme } | null = null,
  options: { split?: boolean } = {}
): string[] {
  const total = Math.max(1, Math.floor(width));
  const all: readonly ViewRender[] = view === null ? [] : isRenderList(view) ? view : [view];
  const renders = all.filter(inDetailsPane);
  const quietSteps = all.filter((render) => !inDetailsPane(render)).flatMap((render) => render.detail.map((line) => `  ${line}`));
  const rule = (line: string) => (style ? paint(line, "line", style) : line);
  const out: string[] = [];
  const panes = paneWidths(total);
  const wide = panes.wide && options.split !== false;

  if (!renders.length) {
    out.push(...answer.map((line) => fitLine(line, total)));
  } else {
    const details = renders.flatMap((render, index) => [
      ...(index > 0 ? [""] : []),
      ...viewLines(render, wide ? panes.right : total)
    ]);
    if (wide) {
      const separator = rule(PANE_SEPARATOR);
      const rows = Math.max(answer.length, details.length);
      for (let index = 0; index < rows; index += 1) {
        const right = details[index] ?? "";
        // r4 `side()`: the separator on every row; an empty details row ends at the bar.
        out.push(right ? `${padEndCells(fitLine(answer[index] ?? "", panes.left), panes.left)}${separator}${fitLine(right, panes.right)}`
          : `${padEndCells(fitLine(answer[index] ?? "", panes.left), panes.left)}${rule(PANE_SEPARATOR.trimEnd())}`);
      }
    } else {
      out.push(
        ...answer.map((line) => fitLine(line, total)),
        ...(answer.length ? [""] : []),
        rule("─".repeat(total)),
        ...details
      );
    }
  }

  const strip = [...steps, ...quietSteps];
  if (strip.length) {
    // One column: a blank row between the details and the Steps (r4 stacked frame).
    if (renders.length && !wide) {
      out.push("");
    }
    out.push(stepHeader(total, style ?? { color: false, theme: DEFAULT_THEME }), ...strip.map((line) => fitLine(line, total)));
  }
  return out;
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
  color: boolean,
  options: { widenLimit?: number } = {}
): string[] {
  return renderTurnBody(messages, { columns: width, color, theme, widenLimit: options.widenLimit });
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
   * Lines already drawn for the details pane, after the views: the turn's
   * pending write card, so it sits right of the answer like r4 draws it. Draw
   * them at `detailsPaneWidth(width)` columns.
   */
  details?: readonly string[];
}

/** The columns the details pane gives a view or a card at this width (the whole width when one column). */
export function detailsPaneWidth(width: number, split = true): number {
  const panes = paneWidths(width);
  return panes.wide && split ? panes.right : Math.max(1, Math.floor(width));
}

export interface LiveTurnRender {
  lines: string[];
  /** The view the keys act on, as drawn now, and what it offers. */
  focused: { render: ViewRender; facts: ViewKeyFacts } | null;
}

/** The latest turn with its views, laid out for the live region: side by side from 120 columns. */
export function renderLiveTurn(input: LiveTurnInput): LiveTurnRender {
  const width = Math.max(1, Math.floor(input.width));
  const budget = typeof input.rows === "number" && Number.isFinite(input.rows) ? Math.max(1, Math.floor(input.rows)) : undefined;
  let drawn = drawLiveTurn(input, width, budget, true);
  // The views start from the whole budget; while the turn is taller than it,
  // give the views that many rows fewer (a document then pages smaller). Stops
  // when the turn fits or stops shrinking (a long answer, a page at its floor).
  for (let pass = 0; budget !== undefined && pass < 3; pass += 1) {
    const overflow = drawn.lines.length - budget;
    if (overflow <= 0 || drawn.rows === undefined || drawn.rows - overflow < 1) {
      break;
    }
    const next = drawLiveTurn(input, width, drawn.rows - overflow, true);
    if (next.lines.length >= drawn.lines.length) {
      break;
    }
    drawn = next;
  }
  const { renders, lines, focusIndex } = drawn;
  const focusedRender = renders[focusIndex];
  return {
    lines,
    focused: focusedRender
      ? { render: focusedRender, facts: viewKeyFacts(input.views[focusIndex], focusedRender, input.livePageNext ?? false) }
      : null
  };
}

/**
 * A finished turn as it is printed once into scrollback: ONE column at any
 * width (question, answer, then its details underneath and the Steps), every
 * page of it (no row budget), under a thin rule that separates it from the
 * turn before.
 */
export function renderCommittedTurn(input: Omit<LiveTurnInput, "rows" | "livePageNext">): string[] {
  const width = Math.max(1, Math.floor(input.width));
  // No row budget: a document is one page as tall as its body (no page line,
  // which no key could act on in scrollback), whatever page the live turn showed.
  const { lines } = drawLiveTurn(input, width, ALL_ROWS, false);
  if (!lines.length) {
    return [];
  }
  return [paint("─".repeat(width), "line", input), ...lines];
}

/** A row budget no view reaches: a committed turn is drawn whole. */
const ALL_ROWS = Number.MAX_SAFE_INTEGER;

/** One draw of the turn, its views given at most `rows` rows; `split` allows the side-by-side layout. */
function drawLiveTurn(input: LiveTurnInput, width: number, rows: number | undefined, split: boolean) {
  const panes = paneWidths(width);
  const wide = panes.wide && split;
  const caps = input.focus?.caps ?? input.caps ?? NO_VIEW_CAPS;
  const base = {
    width: wide ? panes.right : width, color: input.color, theme: input.theme, timeZone: input.timeZone,
    ...(rows === undefined ? {} : { rows })
  };
  const plainCtx: ViewRenderCtx = {
    ...base, selected: 0, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false, caps
  };
  // A quiet view without a head prints with the Steps (full width), not in the details pane.
  const stepCtx: ViewRenderCtx = { ...plainCtx, width: Math.max(1, width - 2) };
  const focusIndex = input.focus ? input.focus.viewIndex : focusedViewIndex(input.views);
  const renders = input.views.map((view, index) => {
    if (view.kind === "quiet") {
      const pane = renderView(view, plainCtx);
      return inDetailsPane(pane) ? pane : renderView(view, stepCtx);
    }
    return renderView(view, index === focusIndex && input.focus ? focusedViewCtx(input.focus, base) : plainCtx);
  });
  const card: ViewRender[] = input.details?.length
    ? [{ head: "", source: null, detail: [...input.details], footnotes: [], keys: [], okKey: null, rowCount: 0 }]
    : [];
  const steps = input.steps?.length ? input.steps : stepsFromTrail(input.messages);
  const stepRows = stepRowLines(steps, { width, color: input.color, theme: input.theme, nowMs: input.nowMs, views: input.views });
  const takesPane = renders.some(inDetailsPane) || card.length > 0;
  const sideBySide = wide && takesPane;
  // How wide a wider window redraws the answer: never for a committed turn
  // (printed once); at most the pane's cap when split; below 120 with details,
  // at most 119 (past it the turn splits and the answer gets narrower).
  const widenLimit = !split ? 0 : sideBySide ? ANSWER_PANE_MAX : takesPane ? SPLIT_MIN_COLUMNS - 1 : undefined;
  const answer = renderAnswerColumn(input.messages, sideBySide ? panes.left : width, input.theme, input.color, { widenLimit });
  const lines = layoutTurn(answer, [...renders, ...card], stepRows, width, { color: input.color, theme: input.theme }, { split });
  return { renders, lines, focusIndex, rows };
}

/** Whether a drawn view takes the details pane (every view but a quiet one without a head). */
function inDetailsPane(render: ViewRender): boolean {
  return !render.quiet || Boolean(render.head);
}

function isRenderList(view: ViewRender | readonly ViewRender[]): view is readonly ViewRender[] {
  return Array.isArray(view);
}
