// Pure black-&-white retro palette + dither ramp for the startup identity
// (welcome wordmark + rocket banner). Neutral greys only — no hue — for the
// 1980s monochrome-CRT look. Kept independent of the active (neon) Theme so the
// startup screens stay B&W regardless of the running theme.
export const RETRO = {
  white: "#FFFFFF",
  bright: "#DCDCDC",
  light: "#B4B4B4",
  mid: "#8C8C8C",
  grey: "#646464",
  dim: "#484848"
} as const;

// Greyscale dither ramp, brightest → dimmest. Each level pairs a block glyph
// (█ solid → ▓ → ▒ sparse) with a grey, so a wordmark shaded top-to-bottom reads
// as chunky 3D depth with no colour at all (demoscene / BBS ANSI-art style).
export const DITHER: ReadonlyArray<{ glyph: string; color: string }> = [
  { glyph: "█", color: RETRO.white },
  { glyph: "█", color: RETRO.bright },
  { glyph: "▓", color: RETRO.light },
  { glyph: "▓", color: RETRO.mid },
  { glyph: "▒", color: RETRO.grey },
  { glyph: "▒", color: RETRO.dim }
];
