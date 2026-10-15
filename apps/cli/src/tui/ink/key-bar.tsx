import React from "react";

import type { Theme } from "../theme.js";
import { type KeyHint, keyBarLine } from "../keys/keymap.js";
import { AnsiLine } from "./transcript-app.js";

// The key bar (terminal-r4 "Keys"): the session's LAST row, under the
// composer. Key chips for what works right now, then `tab` while the turn on
// screen has details (`sides`: `tab to card` in one column, `tab switch side`
// on a turn drawn side by side, `twoColumns`), then always `/ commands`, cut
// to the width with `…` (one row: `keyBarRowCount`).
// Purely presentational — key handling stays in the single `useInput` owner.
export function KeyBar({
  hints,
  commands = true,
  sides,
  twoColumns = false,
  theme,
  width
}: {
  hints: readonly KeyHint[];
  commands?: boolean;
  /** A turn on screen with a details view or card (see `KeyBarOptions.sides`). */
  sides: boolean;
  /** The turn on screen is drawn side by side (see `KeyBarOptions.twoColumns`). */
  twoColumns?: boolean;
  theme: Theme;
  width: number;
}) {
  return <AnsiLine line={keyBarLine(hints, width, theme, { sides, commands, twoColumns })} />;
}
