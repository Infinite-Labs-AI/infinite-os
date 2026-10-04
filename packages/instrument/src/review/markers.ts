// The wizard's hidden markers (§3g.3) and the comment trust rules (§3g.4 step 3).
//
// Trust is ALWAYS author AND marker, never the marker alone: the marker is public text anyone can paste.
// - own: the gh user's own login AND our review marker for THIS run → acted on;
// - teammate: authorAssociation OWNER / MEMBER / COLLABORATOR (incl. the user's own unmarked comments) →
//   acted on only after the user's `teammate-comments` OK, per batch;
// - untrusted: everyone else → shown, never acted on.
// Our own replies (the reply marker) are never re-read as feedback.
import { PR_MARKERS } from "../wizard/contracts/git-host.js"

export { PR_MARKERS }

export interface ReviewMarker {
  runId: string
  round: number | null
  head: string | null
  reviewer: string | null
}

const REVIEW_MARKER_RE = /<!-- infinite-tag:review v1 run=([0-9A-Za-z-]{1,64})(?: round=(\d{1,2}))?(?: head=([0-9a-f]{7,40}))?(?: reviewer=([a-z_]{1,32}))? -->/

export function parseReviewMarker(body: string): ReviewMarker | null {
  const match = REVIEW_MARKER_RE.exec(body)
  if (!match) return null
  return {
    runId: match[1]!,
    round: match[2] === undefined ? null : Number(match[2]),
    head: match[3] ?? null,
    reviewer: match[4] ?? null
  }
}

export function hasReplyMarker(body: string): boolean {
  return body.includes(PR_MARKERS.reply)
}

export function hasFinalMarker(body: string, runId: string): boolean {
  return body.includes(PR_MARKERS.final(runId))
}

export const TEAMMATE_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const

export type CommentTrust = "own" | "teammate" | "untrusted"

/** One comment's trust class for THIS run. */
export function commentTrust(comment: { author: string; authorAssociation: string; body: string }, ctx: { login: string | null; runId: string }): CommentTrust {
  const marker = parseReviewMarker(comment.body)
  if (ctx.login !== null && comment.author === ctx.login && marker !== null && marker.runId === ctx.runId) return "own"
  if ((TEAMMATE_ASSOCIATIONS as readonly string[]).includes(comment.authorAssociation)) return "teammate"
  return "untrusted"
}

/** Strips our markers before a body is quoted to an agent or shown (they are machine text). */
export function stripMarkers(body: string): string {
  return body.replace(/<!-- infinite-tag:[a-z]+ v1[^>]*-->/g, "").trim()
}
