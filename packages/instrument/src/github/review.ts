// Posting ONE review (lane O4, §3g.4 step 2): GraphQL `addPullRequestReview` with `event: COMMENT` and
// inline threads `{path, line, side: RIGHT, body}`. Without an event GitHub would create a PENDING review,
// so the event is always set, and it is always COMMENT (the guard in gh.ts refuses anything else). When
// GitHub refuses the inline threads (a 422), the same review is posted body-only with the threads folded in.
import { GhError, ghGraphql, type GhClient } from "./gh.js"

const ADD_REVIEW = `mutation($pr: ID!, $sha: GitObjectID!, $body: String!, $threads: [DraftPullRequestReviewThread]) {
  addPullRequestReview(input: {pullRequestId: $pr, commitOID: $sha, event: COMMENT, body: $body, threads: $threads}) {
    pullRequestReview { id url }
  }
}`

export interface ReviewThreadDraft {
  path: string
  line: number
  body: string
}

/** The body-only form: each refused inline thread becomes a located paragraph. */
export function foldThreadsIntoBody(body: string, threads: readonly ReviewThreadDraft[]): string {
  if (threads.length === 0) return body
  const folded = threads.map((thread) => `**${thread.path}:${thread.line}**\n\n${thread.body}`).join("\n\n---\n\n")
  return `${body}\n\n### Inline notes\n\n${folded}`
}

export async function postCommentReview(
  gh: GhClient,
  input: { prNodeId: string; headSha: string; body: string; threads: readonly ReviewThreadDraft[] }
): Promise<{ reviewId: string; inline: boolean }> {
  const send = async (body: string, threads: readonly ReviewThreadDraft[]) =>
    ghGraphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(gh, ADD_REVIEW, {
      pr: input.prNodeId,
      sha: input.headSha,
      body,
      threads: threads.map((thread) => ({ path: thread.path, line: thread.line, side: "RIGHT", body: thread.body }))
    })
  try {
    const result = await send(input.body, input.threads)
    return { reviewId: result.addPullRequestReview.pullRequestReview.id, inline: input.threads.length > 0 }
  } catch (error) {
    if (!(error instanceof GhError) || error.kind !== "unprocessable" || input.threads.length === 0) throw error
    const result = await send(foldThreadsIntoBody(input.body, input.threads), [])
    return { reviewId: result.addPullRequestReview.pullRequestReview.id, inline: false }
  }
}
