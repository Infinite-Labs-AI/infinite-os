// `text` (§3d.3): a one-line answer, at most `maxLength` characters. Typing edits, BACKSPACE deletes,
// ENTER submits, ESC cancels.
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import { charsWidth } from "../ansi.js"
import type { Key } from "../keys.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

/** Apply one key to a text buffer (shared with the plan and agent-question overlays). */
export function editBuffer(buffer: string, key: Key, maxLength: number): string {
  if (key.name === "backspace") return Array.from(buffer).slice(0, -1).join("")
  if (key.name === "space") return Array.from(buffer).length < maxLength ? `${buffer} ` : buffer
  if (key.name === "char") return Array.from(buffer).length < maxLength ? buffer + key.char : buffer
  return buffer
}

/** The input line, scrolled so its end (and the caret) stays visible. */
export function inputLine(buffer: string, width: number, caret = "▍"): string {
  const room = Math.max(1, width - 3)
  let shown = buffer
  while (charsWidth(shown) > room) shown = Array.from(shown).slice(1).join("")
  return `› ${shown}${caret}`
}

export const textOverlay: Overlay<"text", { buffer: string }> = {
  kind: "text",
  init: () => ({ buffer: "" }),
  render(payload, state, ctx) {
    return {
      heading: "Question 1 of 1",
      question: ctx.sanitize(payload.question, OVERLAY_TEXT_CAPS.question),
      body: [inputLine(state.buffer, ctx.width), ctx.styles.dim(`${Array.from(state.buffer).length}/${payload.maxLength}`)],
      keys: ["ENTER submit", "ESC cancel"]
    }
  },
  onKey(payload, state, key) {
    if (key.name === "enter") return { state, answer: state.buffer }
    if (key.name === "escape") return { state, answer: ASK_CANCELLED }
    return { state: { buffer: editBuffer(state.buffer, key, payload.maxLength) } }
  }
}
