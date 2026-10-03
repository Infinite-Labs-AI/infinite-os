// `confirm` (§3d.3): a yes/no question. ENTER takes the highlighted choice (the default first), Y / N answer
// directly, ESC cancels.
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

export const confirmOverlay: Overlay<"confirm", { yes: boolean }> = {
  kind: "confirm",
  init: (payload) => ({ yes: payload.defaultYes }),
  render(payload, state, ctx) {
    const s = ctx.styles
    const yes = state.yes ? s.inverse(" Yes ") : " Yes "
    const no = state.yes ? " No " : s.inverse(" No ")
    return {
      heading: "Question",
      question: ctx.sanitize(payload.question, OVERLAY_TEXT_CAPS.question),
      body: [`${yes}  ${no}`],
      keys: ["ENTER choose", "Y yes", "N no", "ESC cancel"]
    }
  },
  onKey(_payload, state, key) {
    switch (key.name) {
      case "enter":
        return { state, answer: state.yes }
      case "left":
      case "right":
      case "tab":
      case "up":
      case "down":
        return { state: { yes: !state.yes } }
      case "escape":
        return { state, answer: ASK_CANCELLED }
      case "char": {
        const c = key.char.toLowerCase()
        if (c === "y") return { state: { yes: true }, answer: true }
        if (c === "n") return { state: { yes: false }, answer: false }
        return { state }
      }
      default:
        return { state }
    }
  }
}
