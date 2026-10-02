import React from "react";

import type { Theme } from "../theme.js";
import { type KeyHint, keyBarLine } from "../keys/keymap.js";
import { AnsiLine } from "./transcript-app.js";

// The key bar (terminal-r4 "Keys"): the session's LAST row, under the
// composer. Key chips for what works right now, then `tab switch side` while
// the turn on screen has details to switch to (`sides`), then always
// `/ commands`, cut to the width with `…` (one row: `keyBarRowCount`).
// Purely presentational — key handling stays in the single `useInput` owner.
export function KeyBar({
  hints,
  sides,
  theme,
  width
}: {
  hints: readonly KeyHint[];
  /** The turn on screen has a details view or card (see `KeyBarOptions.sides`). */
  sides: boolean;
  theme: Theme;
  width: number;
}) {
  return <AnsiLine line={keyBarLine(hints, width, theme, { sides })} />;
}
