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

/**
 * The errors whose words are written for the user (the terminal's own, or the
 * app's readiness answer): an old desktop, nothing to open, the app not
 * running, not answering, not ready or signed out. Every other code
 * (`invalid_request`, `app_open_failed`, `capability_unavailable`, one added
 * later, or none) carries the bridge's developer words ("place must be a
 * registered app place."), so `o` says only that the app can't open it.
 */
const USER_WORD_CODES: ReadonlySet<string> = new Set([
  "desktop_update_required",
  "desktop_app_usage",
  "desktop_not_running",
  "desktop_unreachable",
  "desktop_not_ready",
  "desktop_auth_failed"
]);

/** One line for `/v1/open`'s answer, or for the error it threw. */
export function appOpenLines(outcome: unknown): string[] {
  if (outcome instanceof Error) {
    const code = (outcome as { code?: unknown }).code;
    const message = typeof code === "string" && USER_WORD_CODES.has(code)
      ? boundedTerminalText(outcome.message, MAX_LINE_CHARS)
      : "";
    return [`! ${message || CANNOT_OPEN}`];
  }
  const status = typeof outcome === "object" && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
  return [STATUS_WORDS[typeof status === "string" && Object.hasOwn(STATUS_WORDS, status) ? status : "unavailable"]!];
}
