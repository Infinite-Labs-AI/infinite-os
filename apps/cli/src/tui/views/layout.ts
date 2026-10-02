// The r4 turn layout: the answer on the left, the view's details on the right,
// the Steps strip below (terminal-r4 "Answer left, details right, steps and
// keys at the bottom"). Under 80 columns the two stack: answer, a rule, then
// the details. The key bar is drawn by the session, above the composer.
//
// Every line this returns fits its width: the panes are laid out to their own
// widths first, and each line is cut to fit as a last resort.
import type { AnswerViewV1 } from "@infinite-os/types";

import { renderMarkdown } from "../../formatting/markdown-render.js";
import type { KeyContext } from "../keys/keymap.js";
import { padEndCells, truncateCells } from "../lib/display-width.js";
import { parseToolTrailResultLine, splitToolDuration } from "../lib/text.js";
import type { Theme } from "../theme.js";
import type { Msg } from "../types.js";
import {
  focusedViewCtx,
  focusedViewIndex,
  NO_VIEW_CAPS,
  viewKeyFacts,
  type ViewFocusState,
  type ViewKeyFacts
} from "./focus.js";
import { fitLine, paint, viewText, wrapText } from "./primitives.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

/** At this width and up, the answer and the details sit side by side. */
export const SPLIT_MIN_COLUMNS = 80;
export const PANE_SEPARATOR = " │ ";

/** The answer pane is 28% of the width, clamped to 26–40 columns; the details get the rest. */
export function paneWidths(width: number): { wide: boolean; left: number; right: number } {
  const total = Math.max(1, Math.floor(width));
  if (total < SPLIT_MIN_COLUMNS) {
    return { wide: false, left: total, right: total };
  }
  const left = Math.max(26, Math.min(40, Math.floor(total * 0.28)));
  return { wide: true, left, right: total - left - PANE_SEPARATOR.length };
}

/** One drawn view as lines: head, source, a blank row, the details, then footnotes. */
export function viewLines(render: ViewRender, width: number): string[] {
  const body = [...render.detail, ...(render.footnotes.length ? ["", ...render.footnotes] : [])];
  return [
    render.head,
    ...(render.source ? [render.source] : []),
    ...(body.length ? ["", ...body] : [])
  ].map((line) => fitLine(line, width));
}

/**
 * Lay out one turn. `answer` is drawn at the answer pane's width (see
 * `paneWidths`), each view at the details pane's. Several views stack in the
 * details pane, a blank row apart. No view = the answer alone, full width.
 */
export function layoutTurn(
  answer: readonly string[],
  view: ViewRender | readonly ViewRender[] | null,
  steps: readonly string[],
  width: number,
  style: { color: boolean; theme: Theme } | null = null
): string[] {
  const total = Math.max(1, Math.floor(width));
  const renders: readonly ViewRender[] = view === null ? [] : isRenderList(view) ? view : [view];
  const rule = (line: string) => (style ? paint(line, "muted", style) : line);
  const out: string[] = [];

  if (!renders.length) {
    out.push(...answer.map((line) => fitLine(line, total)));
  } else {
    const { wide, left, right } = paneWidths(total);
    const details = renders.flatMap((render, index) => [
      ...(index > 0 ? [""] : []),
      ...viewLines(render, wide ? right : total)
    ]);
    if (wide) {
      const separator = rule(PANE_SEPARATOR);
      const rows = Math.max(answer.length, details.length);
      for (let index = 0; index < rows; index += 1) {
        out.push(`${padEndCells(fitLine(answer[index] ?? "", left), left)}${separator}${fitLine(details[index] ?? "", right)}`);
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

  if (steps.length) {
    out.push(rule(fitLine(`─ Steps ${"─".repeat(Math.max(0, total - 8))}`, total)), ...steps.map((line) => fitLine(line, total)));
  }
  return out;
}

/** One Steps row: the label column, then the glyph and the result (r4 order). */
export interface StepRow {
  label: string;
  mark: string;
  result: string;
}

/** The Steps rows from the turn's tool trail; a row that is not a finished tool (a stopped one) has only a label. */
export function stepRows(messages: readonly Msg[]): StepRow[] {
  return messages
    .filter((msg) => msg.kind === "trail")
    .flatMap((msg) => msg.tools ?? [])
    .map((line) => {
      const parsed = parseToolTrailResultLine(line);
      if (!parsed) {
        return { label: viewText(line), mark: "", result: "" };
      }
      const { label, duration } = splitToolDuration(parsed.call ?? "");
      return { label: viewText(label), mark: parsed.mark, result: `${viewText(parsed.detail)}${duration}`.trim() };
    });
}

/** The label column of the Steps strip: min(28, 26% of the width), narrower when stacked (r4). */
export function stepLabelWidth(width: number): number {
  const total = Math.max(1, Math.floor(width));
  return total < SPLIT_MIN_COLUMNS ? Math.max(8, Math.min(28, total - 34)) : Math.min(28, Math.floor(total * 0.26));
}

/**
 * The Steps strip, from the turn's tool trail, in r4's column order: the label
 * padded to a fixed column, then the glyph and the result (`label  ✓ 3 items
 * (0.6s)`), one row per tool. r4's timing bar between them waits for per-step
 * start times (the trail carries durations only).
 */
export function stepLines(messages: readonly Msg[], width: number, style: { color: boolean; theme: Theme } | null = null): string[] {
  const labelWidth = stepLabelWidth(width);
  return stepRows(messages).map((row) => {
    if (!row.mark) {
      return `  ${style ? paint(row.label, "muted", style) : row.label}`;
    }
    const label = padEndCells(truncateCells(row.label, labelWidth), labelWidth);
    const role = row.mark === "✓" ? "success" : row.mark === "✗" ? "error" : "muted";
    const outcome = `${row.mark}${row.result ? ` ${row.result}` : ""}`;
    return `  ${label} ${style ? paint(outcome, role, style) : outcome}`;
  });
}

/**
 * The answer pane: the question (`❯`), then the answer (`∞`, markdown) and any
 * notes (receipts, errors) in plain muted text. The tool trail is not here: it
 * is the Steps strip.
 */
export function renderAnswerColumn(
  messages: readonly Msg[],
  width: number,
  theme: Theme,
  color: boolean
): string[] {
  const inner = Math.max(1, Math.floor(width) - 2);
  const style = { color, theme };
  const lines: string[] = [];
  const block = (next: string[]) => {
    if (!next.length) {
      return;
    }
    if (lines.length) {
      lines.push("");
    }
    lines.push(...next);
  };

  for (const msg of messages) {
    if (msg.kind === "trail" || !msg.text.trim()) {
      continue;
    }
    if (msg.role === "user") {
      block(wrapText(viewText(msg.text), inner).map((line, index) =>
        index === 0 ? `${paint("❯", "primaryBright", style)} ${paint(line, "primaryBright", style, { bold: true })}` : `  ${paint(line, "primaryBright", style, { bold: true })}`
      ));
      continue;
    }
    if (msg.role === "assistant") {
      block(renderMarkdown(msg.text, { width: inner, color, theme }).map((line, index) =>
        index === 0 ? `${paint("∞", "primary", style)} ${line}` : `  ${line}`
      ));
      continue;
    }
    block(renderMarkdown(msg.text, { width: inner, color, theme, role: "muted", plain: true }).map((line) => `  ${line}`));
  }
  return lines;
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
  /** The terminal's rows, when known (a document pages by width × rows). */
  rows?: number;
  /** The live region has more lines below (lets `m` page it). */
  livePageNext?: boolean;
}

export interface LiveTurnRender {
  lines: string[];
  /** The view the keys act on, as drawn now, and what it offers. */
  focused: { render: ViewRender; facts: ViewKeyFacts } | null;
}

/** The latest turn with its views, laid out for the live region (and, once, for scrollback). */
export function renderLiveTurn(input: LiveTurnInput): LiveTurnRender {
  const width = Math.max(1, Math.floor(input.width));
  const { wide, left, right } = paneWidths(width);
  const caps = input.focus?.caps ?? input.caps ?? NO_VIEW_CAPS;
  const base = {
    width: wide ? right : width, color: input.color, theme: input.theme, timeZone: input.timeZone,
    ...(input.rows === undefined ? {} : { rows: input.rows })
  };
  const plainCtx: ViewRenderCtx = {
    ...base, selected: 0, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false, caps
  };
  const focusIndex = input.focus ? input.focus.viewIndex : focusedViewIndex(input.views);
  const renders = input.views.map((view, index) =>
    renderView(view, index === focusIndex && input.focus ? focusedViewCtx(input.focus, base) : plainCtx)
  );
  const steps = stepLines(input.messages, width, input);
  const answer = renderAnswerColumn(input.messages, wide && renders.length ? left : width, input.theme, input.color);
  const lines = layoutTurn(answer, renders, steps, width, { color: input.color, theme: input.theme });
  const focusedRender = renders[focusIndex];
  return {
    lines,
    focused: focusedRender
      ? { render: focusedRender, facts: viewKeyFacts(input.views[focusIndex], focusedRender, input.livePageNext ?? false) }
      : null
  };
}

function isRenderList(view: ViewRender | readonly ViewRender[]): view is readonly ViewRender[] {
  return Array.isArray(view);
}
