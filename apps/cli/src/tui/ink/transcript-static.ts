// Scrollback that works: finished turns go to Ink's <Static>, the latest turn
// stays live, and the live region is capped so it never fills the window.
//
// Why: the session re-rendered the WHOLE transcript every frame. Once the frame was
// as tall as the terminal, Ink took its fullscreen branch (`clearTerminal` + redraw),
// which wipes the terminal's scrollback. Now:
//   - A finished turn is printed ONCE into <Static> (normal terminal scrollback).
//     One that fits the live region goes there only when the NEXT line is
//     submitted: until then it (its answer, its views) stays live, so the view
//     keys can still act on it.
//   - The live region is capped at `liveRegionCap(...)` rows. While a turn RUNS,
//     a taller one shows its tail, with a one-row hint saying what is above
//     (PgUp/PgDn page it). A FINISHED turn is never paged: one taller than the
//     cap goes whole into scrollback the moment it finishes, as a coding
//     harness prints it, and only the frame stays live. A write card still
//     waiting for its answer is the exception that stays: the rest of its turn
//     goes up and the card stays live (in a window too small for the card
//     alone, the pager still pages it).
//   - Committed rows never count toward the composer's native-cursor row
//     prediction (`inkTranscriptRowCount`): Ink positions the cursor inside the
//     live frame only.
// Committed lines are rendered at the width current when they were committed.
// When the window's width changes, the session clears the screen AND the
// scrollback and prints every committed entry again at the new width (its
// `redraw`), as Claude Code does: a terminal re-wraps the old frame into more
// rows than it can erase, and the torn copy would otherwise stay in scrollback
// (run-r2 MUST 4).
//
// Everything here is pure; the components only call it.
import type { Key } from "ink";
import type { ReactNode } from "react";

export interface CommittedEntry {
  id: string;
  /** Lines rendered once (ANSI allowed), at the width current when committed. */
  lines: string[];
  /**
   * Optional element drawn instead of `lines`, for a component committed once
   * (the home inventory). Committed rows are never counted, so it needs no lines.
   */
  node?: ReactNode;
  /** The entry drawn again at another width (a width change reprints scrollback). */
  redraw?: (columns: number) => Pick<CommittedEntry, "lines" | "node">;
}

/** Erase the screen, then the scrollback, then home the cursor (CSI 2J, CSI 3J, CSI H). */
export const CLEAR_SCREEN_AND_SCROLLBACK = "\u001b[2J\u001b[3J\u001b[H";

/** How long the width must hold still before the transcript is reprinted at it (a drag sends many resizes). */
export const RESIZE_REPRINT_MS = 150;

/**
 * Every committed entry drawn at `columns` (its `redraw`), in order; an entry
 * without one is kept as it is. Never mutates its input.
 */
export function redrawCommitted(committed: readonly CommittedEntry[], columns: number): CommittedEntry[] {
  return committed.map((entry) => (entry.redraw ? { ...entry, ...entry.redraw(columns) } : entry));
}

export interface TranscriptCommitState {
  committed: readonly CommittedEntry[];
  latest: CommittedEntry | null;
}

/**
 * The latest turn moves to `committed` only when a non-blank next line is
 * submitted. A blank line, or no latest turn, leaves the state untouched (the
 * same object is returned). Never mutates its input; `committed` only grows,
 * which `<Static>` relies on (it prints `items.slice(printedCount)`).
 */
export function commitOnSubmit<S extends TranscriptCommitState>(
  state: S,
  line: string
): Omit<S, keyof TranscriptCommitState> & TranscriptCommitState {
  if (!line.trim() || !state.latest) {
    return state;
  }
  return { ...state, committed: [...state.committed, state.latest], latest: null };
}

/** Rows reserved by default for the composer (it may wrap) and overlays. */
export const DEFAULT_COMPOSER_ROWS = 3;
/** Rows reserved by default for the key bar above the composer. */
export const DEFAULT_KEY_BAR_ROWS = 1;
/** The live region never shrinks below this, even in a tiny window. */
export const MIN_LIVE_REGION_ROWS = 4;

/**
 * The most rows the transcript part of the live frame (top rule, the latest
 * turn, the status rows) may take: the terminal height minus the composer, the
 * key bar and 2 rows of margin. Ink goes fullscreen (and clears the scrollback)
 * once a frame is `>= rows` tall, and `wouldTriggerInkFullscreen` trips one row
 * earlier still, so the margin keeps both false. `rows` undefined (not a TTY) =
 * no cap.
 */
export function liveRegionCap(rows: number | undefined, composerRows: number, keyBarRows: number): number {
  if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const reserved = Math.max(0, composerRows) + Math.max(0, keyBarRows) + 2;
  return Math.max(MIN_LIVE_REGION_ROWS, Math.floor(rows) - reserved);
}

/**
 * The rows the live region's content (the latest turn, then the transcript) may
 * take: the cap minus the top rule, the status rows and an in-app composer row.
 * Never below 2 (one content row plus the pager hint). Infinite when `rows` is
 * unknown. `liveLinesWindow` pages with it, and the session sizes a document's
 * page to it, so both sides count the same rows.
 */
export function liveBodyRows(
  rows: number | undefined,
  composerRows: number,
  keyBarRows: number,
  statusRowCount: number,
  showComposer: boolean
): number {
  const cap = liveRegionCap(rows, composerRows, keyBarRows);
  return Math.max(2, cap - 1 - Math.max(0, statusRowCount) - (showComposer ? 1 : 0));
}

export interface LiveWindow {
  /** The rows to draw now. */
  lines: readonly string[];
  total: number;
  start: number;
  /** Content rows per page (one row of the budget is kept for the hint). */
  pageSize: number;
  hiddenAbove: number;
  hiddenBelow: number;
  /** True when not everything fits and a hint row is drawn. */
  paged: boolean;
}

/**
 * Pick the visible slice of the live region. `budget` is the rows available for
 * the live lines (hint included). `offset` is the first visible line, or `null`
 * to follow the tail (a running turn, new content after a turn). An offset past
 * the end (e.g. after a resize) is clamped.
 */
export function liveWindow(lines: readonly string[], budget: number, offset: number | null): LiveWindow {
  const total = lines.length;
  if (!Number.isFinite(budget) || total <= budget) {
    return { lines, total, start: 0, pageSize: total, hiddenAbove: 0, hiddenBelow: 0, paged: false };
  }
  const pageSize = Math.max(1, Math.floor(budget) - 1);
  const lastStart = total - pageSize;
  const start = offset === null ? lastStart : Math.max(0, Math.min(lastStart, Math.floor(offset)));
  return {
    lines: lines.slice(start, start + pageSize),
    total,
    start,
    pageSize,
    hiddenAbove: start,
    hiddenBelow: total - start - pageSize,
    paged: true
  };
}

export type LivePageDirection = "next" | "previous";

/** The offset after one page in `direction`; `null` = at the end (follow the tail). */
export function pageLiveWindow(window: LiveWindow, direction: LivePageDirection): number | null {
  if (!window.paged) {
    return null;
  }
  const lastStart = window.total - window.pageSize;
  if (direction === "next") {
    const next = window.start + window.pageSize;
    return next >= lastStart ? null : next;
  }
  return Math.max(0, window.start - window.pageSize);
}

/**
 * Which paging key, if any, this keystroke is. PgDn / PgUp always page (they
 * never type). Space pages only on an EMPTY prompt and only when there is more
 * below — otherwise it types as usual. Letters (including `m`) always type: in
 * the composer they start a message. Paging never approves or declines a card.
 */
export function livePageKey(
  input: string,
  key: Pick<Key, "pageDown" | "pageUp">,
  ctx: { composerEmpty: boolean; canPageNext: boolean; canPagePrevious: boolean }
): LivePageDirection | null {
  if (key.pageDown) {
    return ctx.canPageNext ? "next" : null;
  }
  if (key.pageUp) {
    return ctx.canPagePrevious ? "previous" : null;
  }
  if (input === " " && ctx.composerEmpty && ctx.canPageNext) {
    return "next";
  }
  return null;
}

/**
 * The one-row hint under a paged live region (generic chrome, no product words).
 * `spacePages` is false while a write card or picker is open: it owns space
 * (see livePageKey's `composerEmpty`), so only PgDn pages and the hint says so.
 */
export function livePageHint(
  window: LiveWindow,
  options: { spacePages?: boolean } = {}
): string | null {
  if (!window.paged) {
    return null;
  }
  if (window.hiddenBelow > 0) {
    const keys = options.spacePages === false ? "PgDn" : "space or PgDn";
    return `▼ ${window.hiddenBelow} more ${window.hiddenBelow === 1 ? "line" : "lines"} · ${keys}`;
  }
  if (window.hiddenAbove > 0) {
    return `▲ ${window.hiddenAbove} ${window.hiddenAbove === 1 ? "line" : "lines"} above · PgUp`;
  }
  return null;
}
