import { isatty } from "node:tty";

import chalk from "chalk";

import type { Tier } from "./tokens.js";

// Stock Ink paints <Text color> through chalk's singleton, and chalk picks its
// level by sniffing the terminal itself (supports-color). That can sit below
// our tier: COLORTERM=24bit, TERM_PROGRAM vscode/WezTerm/ghostty or an
// INFINITE_COLOR override give us truecolor while chalk says 256, so it
// re-quantizes our hex (the dim grey turns lilac). FORCE_COLOR=0 or a
// non-TTY sniff gives chalk 0, which also drops bold and inverse. chalk is a
// dependency at the exact version Ink resolves, so this is Ink's own instance.

export type ColorLevel = 0 | 1 | 2 | 3;

/** The chalk level that paints a tier. mono keeps 1, so bold and inverse survive. */
export function inkColorLevel(tier: Tier): ColorLevel {
  switch (tier) {
    case "truecolor":
      return 3;
    case "256":
      return 2;
    case "16":
    case "mono":
      return 1;
    case "plain":
    default:
      return 0;
  }
}

/** Set Ink's chalk level from our tier; returns a function that restores the previous level. */
export function syncInkColorLevel(tier: Tier): () => void {
  const previous = chalk.level;
  chalk.level = inkColorLevel(tier);
  return () => {
    chalk.level = previous;
  };
}

/**
 * Whether a stream is a real terminal device. chalk sniffs the process's own
 * terminal, so only a session drawing to one should overwrite its level; a
 * caller's in-memory stream (a test, an embedder) keeps chalk's own choice.
 */
export function drawsToTerminal(stream: unknown): boolean {
  const fd = (stream as { fd?: unknown } | null | undefined)?.fd;
  return typeof fd === "number" && fd >= 0 && isatty(fd);
}
