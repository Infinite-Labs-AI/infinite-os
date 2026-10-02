// `multi` (§3d.3): pick any number of options. ↑↓ move, SPACE toggle, ENTER confirm, ESC cancel. Only the
// payload's `default` values start ticked.
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS, selectRow, windowAround } from "./types.js"

export interface MultiState {
  cursor: number
  picked: string[]
}

export const multiOverlay: Overlay<"multi", MultiState> = {
  kind: "multi",
  init(payload) {
    const values = new Set(payload.options.map((option) => option.value))
    return { cursor: 0, picked: (payload.default ?? []).filter((value) => values.has(value)) }
  },
  render(payload, state, ctx) {
    const s = ctx.styles
    const { start, end } = windowAround(payload.options, state.cursor, Math.max(1, ctx.maxBodyLines))
    const body = payload.options.slice(start, end).map((option, offset) => {
      const box = state.picked.includes(option.value) ? s.ok("[x]") : "[ ]"
      return selectRow(`${box} ${ctx.sanitize(option.label, OVERLAY_TEXT_CAPS.option)}`, start + offset === state.cursor, s)
    })
    return {
      heading: "Question 1 of 1",
      question: ctx.sanitize(payload.question, OVERLAY_TEXT_CAPS.question),
      body,
      keys: ["SPACE tick", "ENTER confirm", "↑↓ move", "ESC cancel"]
    }
  },
  onKey(payload, state, key) {
    const count = payload.options.length
    switch (key.name) {
      case "up":
        return { state: { ...state, cursor: count ? (state.cursor - 1 + count) % count : 0 } }
      case "down":
      case "tab":
        return { state: { ...state, cursor: count ? (state.cursor + 1) % count : 0 } }
      case "space": {
        const option = payload.options[state.cursor]
        if (!option) return { state }
        const picked = state.picked.includes(option.value)
          ? state.picked.filter((value) => value !== option.value)
          : [...state.picked, option.value]
        return { state: { ...state, picked } }
      }
      case "enter": {
        const order = payload.options.map((option) => option.value)
        return { state, answer: [...state.picked].sort((a, b) => order.indexOf(a) - order.indexOf(b)) }
      }
      case "escape":
        return { state, answer: ASK_CANCELLED }
      default:
        return { state }
    }
  }
}
