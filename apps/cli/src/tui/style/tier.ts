// Which colour tier this terminal gets. One function decides it for the whole
// CLI, so the string renderers, the Ink bridge and the old theme roles agree.

import type { Tier } from "./tokens.js";

export interface TierStream {
  isTTY?: boolean;
}

const TIER_NAMES: Readonly<Record<string, Tier>> = {
  truecolor: "truecolor",
  "24bit": "truecolor",
  "256": "256",
  "16": "16",
  mono: "mono",
  plain: "plain"
};

const TRUECOLOR_TERMS = new Set(["xterm-kitty", "xterm-ghostty", "wezterm"]);
const TRUECOLOR_PROGRAMS = new Set(["vscode", "WezTerm", "ghostty"]);

/**
 * The colour tier, in this order:
 * 1. `INFINITE_COLOR=truecolor|256|16|mono|plain` (an explicit override).
 * 2. Not a TTY, `TERM=dumb` or `INFINITE_PLAIN_OUTPUT` → `plain`. No escape
 *    code of any kind reaches a pipe or a dumb terminal, NO_COLOR or not.
 * 3. `NO_COLOR` set and non-empty → `mono` (bold, underline, inverse only).
 * 4. `FORCE_COLOR=0|1|2|3` → mono / 16 / 256 / truecolor.
 * 5. A light background (`COLORFGBG`) → `16`, so the user's palette keeps contrast.
 * 6. `COLORTERM=truecolor|24bit` → truecolor.
 * 7. `TMUX` (without step 6) → `256`: tmux drops truecolor backgrounds unless configured.
 * 8. `TERM` kitty/ghostty/wezterm, `TERM_PROGRAM` iTerm.app ≥ 3, vscode, WezTerm, ghostty → truecolor.
 * 9. `TERM_PROGRAM=Apple_Terminal` or `TERM=*-256color` → `256`; otherwise `16`.
 */
export function resolveTier(env: NodeJS.ProcessEnv, stream: TierStream): Tier {
  const requested = TIER_NAMES[env.INFINITE_COLOR?.trim().toLowerCase() ?? ""];
  if (requested) {
    return requested;
  }
  const term = env.TERM?.trim() ?? "";
  if (!stream.isTTY || term.toLowerCase() === "dumb" || isTruthy(env.INFINITE_PLAIN_OUTPUT)) {
    return "plain";
  }
  if (env.NO_COLOR) {
    return "mono";
  }
  const forced = env.FORCE_COLOR?.trim();
  if (forced === "0") {
    return "mono";
  }
  if (forced === "1") {
    return "16";
  }
  if (forced === "2") {
    return "256";
  }
  if (forced === "3") {
    return "truecolor";
  }
  if (hasLightBackground(env)) {
    return "16";
  }
  const colorterm = env.COLORTERM?.trim().toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") {
    return "truecolor";
  }
  if (env.TMUX) {
    return "256";
  }
  const program = env.TERM_PROGRAM?.trim() ?? "";
  if (TRUECOLOR_TERMS.has(term) || TRUECOLOR_PROGRAMS.has(program)) {
    return "truecolor";
  }
  if (program === "iTerm.app" && majorVersion(env.TERM_PROGRAM_VERSION) >= 3) {
    return "truecolor";
  }
  if (program === "Apple_Terminal" || term.endsWith("-256color")) {
    return "256";
  }
  return "16";
}

/** Whether a tier paints anything at all (only `plain` does not). */
export function tierPaints(tier: Tier): boolean {
  return tier !== "plain";
}

/** Whether a tier paints colour (not just bold, underline and inverse). */
export function tierHasColor(tier: Tier): boolean {
  return tier === "truecolor" || tier === "256" || tier === "16";
}

/**
 * `COLORFGBG` is `fg;bg` (or `fg;default;bg`), set by rxvt, Konsole and some
 * others. Background 7 or 9–15 is a light one.
 */
function hasLightBackground(env: NodeJS.ProcessEnv): boolean {
  const parts = env.COLORFGBG?.split(";") ?? [];
  const bg = Number.parseInt(parts.at(-1) ?? "", 10);
  return parts.length >= 2 && (bg === 7 || (bg >= 9 && bg <= 15));
}

function majorVersion(value: string | undefined): number {
  const major = Number.parseInt((value ?? "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
