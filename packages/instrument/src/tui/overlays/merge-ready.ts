// `merge-ready` (§3d.3): the PR is ready; the user merges. ENTER → "open" (the merge step opens the PR),
// ESC → "later". The wizard never merges.
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

export const mergeReadyOverlay: Overlay<"merge-ready", Record<string, never>> = {
  kind: "merge-ready",
  init: () => ({}),
  render(payload, _state, ctx) {
    // `summary`: the first line is the sentence, every further line a detail row (see `mergeSummary`).
    const [sentence = "", ...details] = payload.summary.split("\n").map((line) => ctx.sanitize(line, OVERLAY_TEXT_CAPS.question)).filter(Boolean)
    // A host with no pull request (number 0) has nothing "ready" to name: the sentence is the whole question.
    const question = payload.number > 0 ? `Pull request #${payload.number} is ready. ${sentence} Merge it to ship.` : sentence
    return {
      heading: "Ready to ship",
      question: question.replace(/\s+/g, " ").trim(),
      body: [...details.map((line) => `· ${line}`), ctx.styles.info(ctx.sanitize(payload.prUrl, OVERLAY_TEXT_CAPS.line))],
      keys: payload.number > 0 ? ["ENTER open on GitHub", "ESC later"] : ["ENTER got it", "ESC later"]
    }
  },
  onKey(_payload, state, key) {
    if (key.name === "enter") return { state, answer: "open" }
    if (key.name === "escape") return { state, answer: "later" }
    return { state }
  }
}
