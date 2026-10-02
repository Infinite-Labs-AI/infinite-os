import React from "react";

import type { Theme } from "../theme.js";
import { type KeyHint, keyBarLine } from "../keys/keymap.js";
import { AnsiLine } from "./transcript-app.js";

// The key bar (terminal-r4 "Keys"): the session's LAST row, under the
// composer. Key chips for what works right now, then always `tab switch side`
// and `/ commands`, cut to the width with `…` (one row: `keyBarRowCount`).
// Purely presentational — key handling stays in the single `useInput` owner.
export function KeyBar({
  hints,
  theme,
  width
}: {
  hints: readonly KeyHint[];
  theme: Theme;
  width: number;
}) {
  return <AnsiLine line={keyBarLine(hints, width, theme)} />;
}
