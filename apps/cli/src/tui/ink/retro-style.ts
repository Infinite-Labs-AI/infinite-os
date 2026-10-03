// The first-run identity's look (the INFINITE wordmark): a top-to-bottom
// dither of block glyphs (█ solid → ▓ → ▒ sparse), each level in an r4 token
// so it paints at the session's colour tier (mono and plain keep the glyph
// ramp, which carries the depth on its own). No hue: the wordmark stays
// black and white.

import type { Token } from "../style/tokens.js";

/** The dither ramp, brightest → dimmest: a block glyph and the token it paints in. */
export const DITHER: ReadonlyArray<{ glyph: string; token: Token }> = [
  { glyph: "█", token: "b" },
  { glyph: "█", token: "" },
  { glyph: "▓", token: "" },
  { glyph: "▓", token: "dim" },
  { glyph: "▒", token: "dim" },
  { glyph: "▒", token: "line" }
];
