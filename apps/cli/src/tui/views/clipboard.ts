// `c` copies through the terminal: an OSC 52 clipboard write, which iTerm2,
// kitty, WezTerm, Alacritty, Windows Terminal and xterm (when allowed) honour,
// over SSH too. A terminal that does not support it ignores the sequence
// (inside tmux it needs `set-clipboard on`).
//
// macOS Terminal.app is one of those, and it is the default terminal on a Mac,
// so on a local Mac (not over SSH) the text also goes to `pbcopy`, the system's
// own clipboard tool. No dependency either way.
//
// The text is scrubbed before it is encoded or piped, so a view can never
// smuggle an escape sequence onto the user's clipboard.
import { spawn } from "node:child_process";

import { terminalText } from "../../desktop/terminal-text.js";

/** The most a copy carries (a link, an id, an email address); longer text is cut. */
export const MAX_COPY_CHARS = 2_000;

/** macOS's clipboard tool, by absolute path so PATH cannot swap it. */
const PBCOPY = "/usr/bin/pbcopy";

/** The text a copy puts on the clipboard: scrubbed, then cut to `MAX_COPY_CHARS`. */
export function copyPayload(text: string): string {
  return Array.from(terminalText(text)).slice(0, MAX_COPY_CHARS).join("");
}

/** The OSC 52 sequence that puts `text` (scrubbed) on the system clipboard. */
export function clipboardSequence(text: string): string {
  return `\u001b]52;c;${Buffer.from(copyPayload(text), "utf8").toString("base64")}\u0007`;
}

/**
 * Where a copy goes. OSC 52 always (the only path over SSH, and the one most
 * terminals honour); `pbcopy` as well on a local Mac, where Terminal.app
 * ignores OSC 52. Over SSH `pbcopy` would fill the remote Mac's clipboard, not
 * the user's, so it is skipped there.
 */
export function copyTargets(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): { osc52: boolean; pbcopy: boolean } {
  const overSsh = Boolean(env.SSH_TTY || env.SSH_CONNECTION);
  return { osc52: true, pbcopy: platform === "darwin" && !overSsh };
}

/** Pipe `text` (scrubbed) to `pbcopy`. A missing or failing pbcopy leaves the OSC 52 copy as the only one. */
export function copyThroughPbcopy(text: string): void {
  const child = spawn(PBCOPY, [], { stdio: ["pipe", "ignore", "ignore"] });
  // An `error` event with no listener would throw and end the session.
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(copyPayload(text));
}
