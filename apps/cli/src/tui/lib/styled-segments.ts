// A line as styled segments, the way terminal-r4 builds its chrome: each
// segment is a style (r4 tokens or a theme role) and its text. Lines are
// measured, cut and padded as segments, then painted once at the theme's
// tier, so a chip is never split from its escape codes.

import { ansi, type Theme, type ThemeStyle } from "../theme.js";
import { displayWidth, truncateCells } from "./display-width.js";

export type StyledSegment = readonly [style: ThemeStyle, text: string];

/** The cells a segment line takes. */
export function segmentsWidth(segments: readonly StyledSegment[]): number {
  return segments.reduce((total, [, text]) => total + displayWidth(text), 0);
}

/**
 * Cut a segment line to `width` cells (r4 `trunc()`): whole segments while
 * they fit; the first one that does not is cut to one cell short and ends in
 * `…`; a segment with no room left is dropped, and so is everything after it.
 */
export function truncSegments(segments: readonly StyledSegment[], width: number): StyledSegment[] {
  const out: StyledSegment[] = [];
  let used = 0;
  for (const [style, text] of segments) {
    const cells = displayWidth(text);
    if (used + cells <= width) {
      out.push([style, text]);
      used += cells;
      continue;
    }
    const room = width - used;
    if (room > 0) {
      out.push([style, truncateCells(text, room)]);
    }
    break;
  }
  return out;
}

/** Pad a segment line with unstyled spaces to `width` cells, or cut it there (r4 `pad()`). */
export function padSegments(segments: readonly StyledSegment[], width: number): StyledSegment[] {
  const cells = segmentsWidth(segments);
  if (cells > width) {
    return truncSegments(segments, width);
  }
  return cells < width ? [...segments, ["", " ".repeat(width - cells)]] : [...segments];
}

/** Paint a segment line at the theme's tier (no escape codes at `plain`, where a chip prints as `[k]`). */
export function paintSegments(segments: readonly StyledSegment[], theme: Theme): string {
  return segments.map(([style, text]) => ansi(theme, style, text)).join("");
}
