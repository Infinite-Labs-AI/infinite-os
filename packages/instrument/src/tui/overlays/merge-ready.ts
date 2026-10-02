// `merge-ready` (§3d.3): the PR is ready; the user merges. ENTER → "open" (the merge step opens the PR),
// ESC → "later". The wizard never merges.
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

export const mergeReadyOverlay: Overlay<"merge-ready", Record<string, never>> = {
  kind: "merge-ready",
  init: () => ({}),
  render(payload, _state, ctx) {
    return {
      heading: "Ready to ship",
      question: `Pull request #${payload.number} is ready. ${ctx.sanitize(payload.summary, OVERLAY_TEXT_CAPS.question)} Merge it to ship.`,
      body: [ctx.styles.info(ctx.sanitize(payload.prUrl, OVERLAY_TEXT_CAPS.line))],
      keys: ["ENTER open on GitHub", "ESC later"]
    }
  },
  onKey(_payload, state, key) {
    if (key.name === "enter") return { state, answer: "open" }
    if (key.name === "escape") return { state, answer: "later" }
    return { state }
  }
}
