// The composer row when nothing is typed (terminal-r4): a cyan `❯`, the dim
// placeholder `Ask Infinite…`, and while a turn runs a dim note in brackets.
// No status line, no session id, no key words: the keys live in the key bar.

import type { Theme } from "../theme.js";
import { paintSegments, truncSegments, type StyledSegment } from "../lib/styled-segments.js";

/** The composer's placeholder. */
export const COMPOSER_PLACEHOLDER = "Ask Infinite…";

/** The prompt mark in front of the composer. */
export const COMPOSER_PROMPT = "❯";

/** The placeholder text with an optional busy note: `Ask Infinite… (note)`. */
export function composerPlaceholderText(placeholder: string = COMPOSER_PLACEHOLDER, note?: string | null): string {
  const trimmed = note?.trim();
  return trimmed ? `${placeholder} (${trimmed})` : placeholder;
}

/** The empty composer row's segments, cut to `width`. */
export function composerSegments(
  width: number,
  options: { placeholder?: string; note?: string | null; prompt?: string } = {}
): StyledSegment[] {
  const prompt = options.prompt ?? COMPOSER_PROMPT;
  return truncSegments(
    [["cyan", prompt], ["", " "], ["dim", composerPlaceholderText(options.placeholder, options.note)]],
    Math.max(1, Math.floor(width))
  );
}

/** The empty composer row, painted at the theme's tier. */
export function composerLine(
  width: number,
  theme: Theme,
  options: { placeholder?: string; note?: string | null; prompt?: string } = {}
): string {
  return paintSegments(composerSegments(width, options), theme);
}
