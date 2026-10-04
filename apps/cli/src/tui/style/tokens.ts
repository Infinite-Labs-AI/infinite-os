// The terminal style tokens: one name per look (a colour, a weight, a chip),
// each with how it paints at every colour tier. This table is the only place
// a colour is defined; `sgr.ts` turns tokens into escape codes and Ink props.
//
// `tokens.test.ts` pins every token, tier by tier, to
// `__fixtures__/palette.json` (the design palette), so the two cannot drift.

/** A style token. `""` is body text: the terminal's own default foreground. */
export type Token =
  | ""
  | "dim"
  | "line"
  | "cyan"
  | "b"
  | "green"
  | "amber"
  | "red"
  | "hatch"
  | "blue"
  | "cb"
  | "ab"
  | "gb"
  | "rb"
  | "bb"
  | "inv"
  | "key"
  | "pk"
  | "tag"
  | "sel"
  | "u";

/**
 * How much colour the terminal gets:
 * - `truecolor`: 24-bit hex;
 * - `256`: xterm-256 indices;
 * - `16`: the user's own 16-colour palette, chosen by meaning;
 * - `mono`: attributes only (bold, underline, inverse), for NO_COLOR;
 * - `plain`: no escape codes at all, for pipes and `TERM=dumb`.
 */
export type Tier = "truecolor" | "256" | "16" | "mono" | "plain";

export const TIERS: readonly Tier[] = ["truecolor", "256", "16", "mono", "plain"];

export interface TokenSpec {
  /** Foreground at the truecolor tier. */
  fg?: string;
  /** Background at the truecolor tier. */
  bg?: string;
  bold?: true;
  underline?: true;
  /** xterm-256 indices. Slots 0–15 are never used, so the user's palette cannot shift them. */
  c256?: { fg?: number; bg?: number };
  /** 16-colour SGR codes (30–37, 90–97; 40–47, 100–107). */
  c16?: { fg?: number; bg?: number };
  /** What survives without colour: chips turn inverse or bold. */
  mono?: { bold?: true; inverse?: true; underline?: true };
  /** Without escape codes a chip `" k "` prints as `"[k]"`, the same width. */
  brackets?: true;
}

const CYAN = "#56c8e8";
const AMBER = "#e9b44c";
const GREEN = "#6fd08c";
const RED = "#ef6b73";
const BLUE = "#7aa7ff";
const WHITE = "#ffffff";
const INK = "#0a0d11";

/** Every token except `""` (which only ever means "the default foreground"). */
export const R4_TOKENS: Readonly<Record<Exclude<Token, "">, TokenSpec>> = {
  dim: { fg: "#6d7986", c256: { fg: 243 }, c16: { fg: 90 } },
  line: { fg: "#3a4653", c256: { fg: 238 }, c16: { fg: 90 } },
  cyan: { fg: CYAN, c256: { fg: 81 }, c16: { fg: 36 } },
  b: { fg: WHITE, bold: true, c256: { fg: 231 }, c16: { fg: 97 }, mono: { bold: true } },
  green: { fg: GREEN, c256: { fg: 78 }, c16: { fg: 32 } },
  amber: { fg: AMBER, c256: { fg: 179 }, c16: { fg: 33 } },
  red: { fg: RED, c256: { fg: 203 }, c16: { fg: 31 } },
  hatch: { fg: "#46525e", c256: { fg: 239 }, c16: { fg: 90 } },
  blue: { fg: BLUE, c256: { fg: 111 }, c16: { fg: 94 } },
  cb: { fg: CYAN, bold: true, c256: { fg: 81 }, c16: { fg: 36 }, mono: { bold: true } },
  ab: { fg: AMBER, bold: true, c256: { fg: 179 }, c16: { fg: 33 }, mono: { bold: true } },
  gb: { fg: GREEN, bold: true, c256: { fg: 78 }, c16: { fg: 32 }, mono: { bold: true } },
  rb: { fg: RED, bold: true, c256: { fg: 203 }, c16: { fg: 31 }, mono: { bold: true } },
  bb: { fg: BLUE, bold: true, c256: { fg: 111 }, c16: { fg: 94 }, mono: { bold: true } },
  inv: {
    fg: INK,
    bg: CYAN,
    bold: true,
    c256: { fg: 232, bg: 81 },
    c16: { fg: 30, bg: 46 },
    mono: { bold: true, inverse: true },
    brackets: true
  },
  key: {
    fg: WHITE,
    bg: "#2a3440",
    c256: { fg: 231, bg: 237 },
    c16: { fg: 97, bg: 100 },
    mono: { inverse: true },
    brackets: true
  },
  pk: {
    fg: INK,
    bg: AMBER,
    bold: true,
    c256: { fg: 232, bg: 179 },
    c16: { fg: 30, bg: 43 },
    mono: { bold: true, inverse: true },
    brackets: true
  },
  tag: {
    fg: WHITE,
    bg: "#22303b",
    bold: true,
    c256: { fg: 231, bg: 236 },
    c16: { fg: 97, bg: 100 },
    mono: { bold: true },
    brackets: true
  },
  sel: { bg: "#1b2f3a", c256: { bg: 235 }, c16: { bg: 100 } },
  u: { underline: true, mono: { underline: true } }
};

/** r4's terminal window. Painted only on opt-in; the user's profile owns the background. */
export const R4_CANVAS = { bg: INK, fg: "#d3dae2" } as const;

/** Is this string a token name? (`""` is one: body text.) */
export function isToken(value: string): value is Token {
  return value === "" || Object.prototype.hasOwnProperty.call(R4_TOKENS, value);
}

/** A state or status tone, as the answer views name them. */
export type Tone = "ok" | "ask" | "warn" | "bad" | "busy" | "muted" | "cmdl_only";

/** The token each tone paints in. "ask" (needs you) is the only bold one. */
export const TONE_TOKENS: Readonly<Record<Tone, Token>> = {
  ok: "green",
  ask: "ab",
  warn: "amber",
  bad: "red",
  busy: "cyan",
  muted: "dim",
  cmdl_only: "bb"
};
