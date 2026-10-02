// The wizard's UI seam. Lane O1's engine owns the store (renderer-agnostic, `WizardStoreSnapshot` from the
// F0 contracts); a UI only READS snapshots and ANSWERS the one pending ask. Two UIs implement it: the TTY UI
// (`tty-ui.ts`, an ANSI renderer in the alternate screen) and the JSON UI (`json-ui.ts`, NDJSON events on
// stdout and `ask.answer` lines on stdin, for agents and CI).
//
// Every untrusted string a UI renders (agent narration, agent questions, report_progress, teammate-comment
// excerpts, third-party comments, page console text) goes through ONE sanitiser: lane O3's
// `sanitizeUntrusted(text, max)` (src/agents/sanitize.ts). The UI takes it as a REQUIRED option instead of
// importing it, so this lane never depends on a sibling's unmerged file and there is no second sanitiser.
import type { WizardStoreSnapshot } from "../wizard/contracts/state.js"

/** O3's `sanitizeUntrusted(text, max)`: strips ANSI/control/bidi characters and caps the length. */
export type UntrustedSanitizer = (text: string, max: number) => string

/**
 * What a UI needs from O1's `WizardStore`: snapshots, change notifications, and a way to answer the
 * pending ask. `answerAsk` with an id that is not the pending ask's id must throw (or be ignored by the
 * store); the JSON UI checks the id against the snapshot first and rejects an unknown one.
 */
export interface WizardStoreView {
  getSnapshot(): WizardStoreSnapshot
  subscribe(listener: () => void): () => void
  answerAsk(askId: string, answer: unknown): void
}

export interface WizardUi {
  /** Take over the terminal (TTY) or start the NDJSON streams (JSON) and follow the store. */
  start(store: WizardStoreView): void
  /** Give the terminal back: raw mode off, cursor on, alt screen left, the outro and exit line printed. Idempotent. */
  stop(): void
  /**
   * The outro slot: the before/after text (O1's `renderTerminal(report, width)`) shown at the end and left in
   * scrollback after `stop()`. The store's `snapshot.outro` fills it too; this setter wins when both are set.
   */
  setOutro(text: string | null): void
  /** Resolves once the user dismissed the outro (TTY: ENTER/Q/ESC); at once in the JSON UI or with no outro. */
  waitForDismiss(): Promise<void>
}
