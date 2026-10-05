import React from "react";

import type { Theme } from "../theme.js";
import { type KeyHint, keyBarLine } from "../keys/keymap.js";
import { AnsiLine } from "./transcript-app.js";

// The key bar (terminal-r4 "Keys"): the session's LAST row, under the
// composer. Key chips for what works right now, then `tab switch side` on the
// boot frame (r4's frame as drawn) and while the turn on screen has details
// to switch to (`sides`), then always `/ commands`, cut to the width with `…`
// (one row: `keyBarRowCount`).
// Purely presentational — key handling stays in the single `useInput` owner.
export function KeyBar({
  hints,
  commands = true,
  sides,
  theme,
  width
}: {
  hints: readonly KeyHint[];
  commands?: boolean;
  /** The boot frame, or a turn on screen with a details view or card (see `KeyBarOptions.sides`). */
  sides: boolean;
  theme: Theme;
  width: number;
}) {
  return <AnsiLine line={keyBarLine(hints, width, theme, { sides, commands })} />;
}
