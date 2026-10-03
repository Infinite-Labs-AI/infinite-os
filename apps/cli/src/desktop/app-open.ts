// What the terminal says after `o` (T12, app.open.v1). The app's router opened
// the place, or said why not; the terminal never opens a browser instead.
import { boundedTerminalText } from "./terminal-text.js";

const MAX_LINE_CHARS = 240;
const CANNOT_OPEN = "The app can't open that place right now.";

const STATUS_WORDS: Record<string, string> = {
  opened: "↗ Opened in the app.",
  wrong_workspace: "! That place is in another workspace. Switch to it in the app first.",
  signed_out: "! Sign in to the app first.",
  unavailable: `! ${CANNOT_OPEN}`
};

/** One line for `/v1/open`'s answer, or for the error it threw. */
export function appOpenLines(outcome: unknown): string[] {
  if (outcome instanceof Error) {
    const message = boundedTerminalText(outcome.message, MAX_LINE_CHARS);
    return [`! ${message || CANNOT_OPEN}`];
  }
  const status = typeof outcome === "object" && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
  return [STATUS_WORDS[typeof status === "string" && Object.hasOwn(STATUS_WORDS, status) ? status : "unavailable"]!];
}
