// The r4 palette as the golden harness reads it: `__goldens__/palette.json`, a
// stripped copy of the spec's palette.json (spec/terminal/tools/
// export-synthetic-goldens.mjs). Used only to map an emitted colour BACK to its
// r4 token; the CLI's own colours come from the theme, never from here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type GoldenTier = "truecolor" | "256" | "16" | "mono" | "plain";

export interface PaletteToken {
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
  fg_256?: { index: number; hex: string };
  bg_256?: { index: number; hex: string };
  sgr: Record<GoldenTier, string>;
}

export interface Palette {
  canvas: { bg: string; fg: string };
  tokens: Record<string, PaletteToken>;
}

export const PALETTE: Palette = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__goldens__/palette.json", import.meta.url)), "utf8")
) as Palette;

const FG_NAMES = ["dim", "line", "cyan", "green", "amber", "red", "mag", "hatch", "blue"] as const;

/** Foreground hex (truecolor value AND its 256-tier hex) → base token; `#ffffff` is "white" (bold white = `b`). */
export const FG_BASE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const name of FG_NAMES) {
    const token = PALETTE.tokens[name];
    if (!token?.fg) continue;
    map.set(token.fg.toLowerCase(), name);
    if (token.fg_256) map.set(token.fg_256.hex.toLowerCase(), name);
  }
  map.set("#ffffff", "white");
  return map;
})();

/** Bold of a base colour → its r4 bold token. */
export const BOLD_OF: Readonly<Record<string, string>> = { cyan: "cb", amber: "ab", green: "gb", red: "rb", blue: "bb", white: "b" };

/** Background hex (truecolor and 256-tier) → chip token. */
export const BG_BASE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const name of ["key", "pk", "inv", "tag", "sel"]) {
    const token = PALETTE.tokens[name];
    if (!token?.bg) continue;
    map.set(token.bg.toLowerCase(), name);
    if (token.bg_256) map.set(token.bg_256.hex.toLowerCase(), name);
  }
  return map;
})();

/** Body text's design foreground: a cell painted exactly this colour counts as default fg. */
export const BODY_FG = (PALETTE.tokens[""]?.fg ?? "#d3dae2").toLowerCase();

/** xterm 256-colour index → hex (16–255; the 16 system colours belong to the user's theme → null). */
export function xterm256Hex(index: number): string | null {
  if (!Number.isInteger(index) || index < 16 || index > 255) return null;
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  if (index < 232) {
    const n = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return `#${hex(steps[Math.floor(n / 36)]!)}${hex(steps[Math.floor(n / 6) % 6]!)}${hex(steps[n % 6]!)}`;
  }
  const v = 8 + (index - 232) * 10;
  return `#${hex(v)}${hex(v)}${hex(v)}`;
}
