// `teammate-comments` (§3d.3): review comments from the user's teammates. Nothing is acted on without the
// user's OK, so every comment starts UNticked. Author, path and excerpt are third-party text and go through
// the sanitiser.
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS, windowAround } from "./types.js"

export interface TeammateCommentsState {
  cursor: number
  picked: string[]
}

export const teammateCommentsOverlay: Overlay<"teammate-comments", TeammateCommentsState> = {
  kind: "teammate-comments",
  init: () => ({ cursor: 0, picked: [] }),
  render(payload, state, ctx) {
    const s = ctx.styles
    const per = 2
    const { start, end } = windowAround(payload.comments, state.cursor, Math.max(1, Math.floor(ctx.maxBodyLines / per)))
    const body: string[] = []
    for (let index = start; index < end; index++) {
      const comment = payload.comments[index]
      if (!comment) continue
      const box = state.picked.includes(comment.threadId) ? s.ok("[x]") : "[ ]"
      const where = comment.line === null ? ctx.sanitize(comment.path, OVERLAY_TEXT_CAPS.label) : `${ctx.sanitize(comment.path, OVERLAY_TEXT_CAPS.label)}:${comment.line}`
      const head = `${index === state.cursor ? s.accent("▸") : " "} ${box} @${ctx.sanitize(comment.author, 60)} · ${where}`
      body.push(index === state.cursor ? s.bold(head) : head)
      body.push(s.dim(`      ${ctx.sanitize(comment.excerpt, OVERLAY_TEXT_CAPS.excerpt)}`))
    }
    return {
      heading: "Teammate comments",
      question: `Your teammates left ${payload.comments.length} comment${payload.comments.length === 1 ? "" : "s"}. Tick the ones the wizard should act on; the rest are left for you.`,
      body,
      keys: ["SPACE tick", "ENTER confirm", "↑↓ move", "ESC later"]
    }
  },
  onKey(payload, state, key) {
    const count = payload.comments.length
    switch (key.name) {
      case "up":
        return { state: { ...state, cursor: count ? (state.cursor - 1 + count) % count : 0 } }
      case "down":
      case "tab":
        return { state: { ...state, cursor: count ? (state.cursor + 1) % count : 0 } }
      case "space": {
        const comment = payload.comments[state.cursor]
        if (!comment) return { state }
        const picked = state.picked.includes(comment.threadId)
          ? state.picked.filter((id) => id !== comment.threadId)
          : [...state.picked, comment.threadId]
        return { state: { ...state, picked } }
      }
      case "enter":
        return { state, answer: { actOn: payload.comments.map((c) => c.threadId).filter((id) => state.picked.includes(id)) } }
      case "escape":
        return { state, answer: ASK_CANCELLED }
      default:
        return { state }
    }
  }
}
