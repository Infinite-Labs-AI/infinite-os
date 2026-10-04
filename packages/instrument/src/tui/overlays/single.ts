// `single` (§3d.3): pick one option. ↑↓ move, ENTER choose, ESC cancel. The payload's `default` is
// highlighted first (never auto-chosen).
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS, selectRow, windowAround } from "./types.js"

export const singleOverlay: Overlay<"single", { cursor: number }> = {
  kind: "single",
  init(payload) {
    const index = payload.default === undefined ? -1 : payload.options.findIndex((option) => option.value === payload.default)
    return { cursor: index >= 0 ? index : 0 }
  },
  render(payload, state, ctx) {
    const { start, end } = windowAround(payload.options, state.cursor, Math.max(1, ctx.maxBodyLines))
    const body = payload.options
      .slice(start, end)
      .map((option, offset) => selectRow(ctx.sanitize(option.label, OVERLAY_TEXT_CAPS.option), start + offset === state.cursor, ctx.styles))
    return {
      heading: "Question 1 of 1",
      question: ctx.sanitize(payload.question, OVERLAY_TEXT_CAPS.question),
      body,
      keys: ["ENTER choose", "↑↓ move", "ESC cancel"]
    }
  },
  onKey(payload, state, key) {
    const count = payload.options.length
    switch (key.name) {
      case "up":
        return { state: { cursor: count ? (state.cursor - 1 + count) % count : 0 } }
      case "down":
      case "tab":
        return { state: { cursor: count ? (state.cursor + 1) % count : 0 } }
      case "enter": {
        const option = payload.options[state.cursor]
        return option ? { state, answer: option.value } : { state }
      }
      case "escape":
        return { state, answer: ASK_CANCELLED }
      default:
        return { state }
    }
  }
}
