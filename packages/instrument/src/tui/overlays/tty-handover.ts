// `tty-handover` (§3d.3): a child (gpg pinentry, an ssh passphrase, a git hook) needs the real terminal. The
// TTY UI suspends itself (raw mode off, alt screen left) while this ask is open and resumes when it closes;
// this overlay is the one line printed into the normal screen meanwhile. No keys: the child owns the terminal.
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

const REASON_LABEL = { gpg: "sign the commit (gpg)", ssh: "unlock your SSH key", hook: "run your git hook" } as const

export const ttyHandoverOverlay: Overlay<"tty-handover", Record<string, never>> = {
  kind: "tty-handover",
  init: () => ({}),
  render(payload, _state, ctx) {
    return {
      heading: "Your terminal, for a moment",
      question: `Handing the terminal to \`${ctx.sanitize(payload.command, OVERLAY_TEXT_CAPS.label)}\` to ${REASON_LABEL[payload.reason]}. The wizard comes back when it finishes.`,
      body: [],
      keys: []
    }
  },
  onKey: (_payload, state) => ({ state })
}

/** The plain line the TTY UI prints in the normal screen while the child runs. */
export function handoverLine(payload: { reason: "gpg" | "ssh" | "hook"; command: string }, sanitize: (text: string, max: number) => string): string {
  return `◆ infinite-tag: handing the terminal to \`${sanitize(payload.command, OVERLAY_TEXT_CAPS.label)}\` to ${REASON_LABEL[payload.reason]}; the wizard resumes when it finishes.`
}
