// `c` copies through the terminal: an OSC 52 clipboard write, which iTerm2,
// kitty, WezTerm, Alacritty, Windows Terminal and xterm (when allowed) honour,
// over SSH too. No helper process and no dependency. A terminal that does not
// support it ignores the sequence (inside tmux it needs `set-clipboard on`).
//
// The text is scrubbed before it is encoded, so a view can never smuggle an
// escape sequence onto the user's clipboard.
import { terminalText } from "../../desktop/terminal-text.js";

/** The most a copy carries (a link, an id, an email address); longer text is cut. */
export const MAX_COPY_CHARS = 2_000;

/** The OSC 52 sequence that puts `text` (scrubbed) on the system clipboard. */
export function clipboardSequence(text: string): string {
  const clean = Array.from(terminalText(text)).slice(0, MAX_COPY_CHARS).join("");
  return `\u001b]52;c;${Buffer.from(clean, "utf8").toString("base64")}\u0007`;
}
