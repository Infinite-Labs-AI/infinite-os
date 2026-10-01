import React from "react";

import type { Theme } from "../theme.js";
import { type KeyHint, formatKeyBar } from "../keys/keymap.js";
import { Box, Text } from "./renderer.js";

// The bottom key bar (terminal-r4 "Keys"): only what works right now, rendered
// just above the composer. Purely presentational — key handling stays in the
// single `useInput` owner. Its wrapped rows are counted by `keyBarRowCount`
// (same text, same wrap), which the session adds to the composer-row prediction.
export function KeyBar({
  hints,
  theme,
  width
}: {
  hints: readonly KeyHint[];
  theme: Theme;
  width: number;
}) {
  if (hints.length === 0) {
    return null;
  }
  // One plain string, so the rendered wrap matches `keyBarRowCount` exactly.
  return (
    <Box width={width}>
      <Text color={theme.color.muted} wrap="wrap">{formatKeyBar(hints)}</Text>
    </Box>
  );
}
