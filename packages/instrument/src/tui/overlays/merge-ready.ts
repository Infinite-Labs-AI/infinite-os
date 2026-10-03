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
    const incomplete = payload.incomplete ? ctx.sanitize(payload.incomplete, OVERLAY_TEXT_CAPS.question) : null
    // §3x.6 (R3-6): a pull request without everything the plan approved never invites "Merge it to ship".
    const question = incomplete
      ? `Pull request #${payload.number} does not have everything the plan approved: ${incomplete}. Merging ships only what is in it. ${sentence}`
      : payload.number > 0
        ? `Pull request #${payload.number} is ready. ${sentence} Merge it to ship.`
        : sentence
    return {
      heading: incomplete ? "Ready to merge, but incomplete" : "Ready to ship",
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
