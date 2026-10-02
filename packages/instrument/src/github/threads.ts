// Review threads (lane O4, §3g.4 steps 3 and 6): read them all (paginated), reply, resolve.
import type { ReviewThread, ReviewThreadDetail, ThreadComment } from "../wizard/contracts/git-host.js"
import { ghGraphql, type GhClient } from "./gh.js"


export type { ReviewThreadDetail, ThreadComment } from "../wizard/contracts/git-host.js"

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id isResolved isOutdated path line viewerCanResolve viewerCanReply
          comments(first: 50) { nodes { author { login } authorAssociation viewerDidAuthor body } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

interface RawThread {
  id: string
  isResolved: boolean
  isOutdated?: boolean
  path: string | null
  line: number | null
  viewerCanResolve?: boolean
  viewerCanReply?: boolean
  comments: { nodes: Array<{ author: { login: string } | null; authorAssociation: string; viewerDidAuthor?: boolean; body: string }> }
}

const MAX_PAGES = 20

export async function readThreads(gh: GhClient, repo: { owner: string; name: string }, number: number): Promise<ReviewThreadDetail[]> {
  const out: ReviewThreadDetail[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: {
      repository: { pullRequest: { reviewThreads: { nodes: RawThread[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } }
    } = await ghGraphql(gh, THREADS_QUERY, { owner: repo.owner, name: repo.name, number, cursor })
    const threads = data.repository.pullRequest.reviewThreads
    for (const node of threads.nodes) {
      const comments: ThreadComment[] = node.comments.nodes.map((comment) => ({
        author: comment.author?.login ?? "ghost",
        authorAssociation: comment.authorAssociation,
        body: comment.body,
        viewerDidAuthor: comment.viewerDidAuthor === true
      }))
      const first = comments[0]
      out.push({
        threadId: node.id,
        author: first?.author ?? "ghost",
        authorAssociation: first?.authorAssociation ?? "NONE",
        path: node.path,
        line: node.line,
        body: first?.body ?? "",
        isResolved: node.isResolved,
        isOutdated: node.isOutdated === true,
        viewerCanReply: node.viewerCanReply !== false,
        viewerCanResolve: node.viewerCanResolve !== false,
        comments
      })
    }
    if (!threads.pageInfo.hasNextPage || !threads.pageInfo.endCursor) break
    cursor = threads.pageInfo.endCursor
  }
  return out
}

const REPLY = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } }
}`

const RESOLVE = `mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } }
}`

export async function replyToThread(gh: GhClient, threadId: string, body: string): Promise<void> {
  await ghGraphql(gh, REPLY, { thread: threadId, body })
}

export async function resolveThread(gh: GhClient, threadId: string): Promise<void> {
  await ghGraphql(gh, RESOLVE, { thread: threadId })
}
