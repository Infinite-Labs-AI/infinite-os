// `GitHostAdapter` for GitHub (§3g.2), over `gh`. The wizard does every GitHub write itself; agents never hold
// gh or git credentials.
import type { GitHostAdapter, PrSummary } from "../wizard/contracts/git-host.js"
import { prChecks, type PrCheck } from "../github/checks.js"
import type { GhClient } from "../github/gh.js"
import { comment, createDraftPr, findPr, markReady, readPr, updateBranch } from "../github/pr.js"
import { previewUrlForSha } from "../github/preview.js"
import { ghAuthStatus, ghRepoFacts, type GhRepoFacts } from "../github/repo.js"
import { postCommentReview } from "../github/review.js"
import { baseRules } from "../github/rules.js"
import { readThreads, replyToThread, resolveThread, type ReviewThreadDetail } from "../github/threads.js"

export interface GitHubHostAdapter extends GitHostAdapter {
  kind: "github"
  readonly gh: GhClient
  /** The linked Vercel project, so a monorepo's several previews can be told apart (§3g.2). */
  setPreviewProject(projectName: string | null): void
  /** `readThreads` with every comment and the viewer flags (the trust rules need them). */
  readThreadDetails(number: number): Promise<ReviewThreadDetail[]>
  /** The PR's conversation comments and review bodies (a printed-brief review arrives as one of these). */
  readComments(number: number): Promise<PrComment[]>
  // GitHub supports every method: the return types narrow (never `{unsupported:true}`).
  readPr(number: number): Promise<PrSummary>
  findPr(branch: string): Promise<PrSummary | null>
  createDraftPr(input: { base: string; head: string; title: string; bodyFile: string }): Promise<PrSummary>
  checks(number: number): Promise<PrCheck[]>
  rules(base: string): Promise<{ requiresReview: boolean; mergeQueue: boolean }>
  previewUrl(sha: string): Promise<string | null>
}

export interface PrComment {
  author: string
  authorAssociation: string
  body: string
}

export function createGitHubAdapter(gh: GhClient): GitHubHostAdapter {
  let facts: GhRepoFacts | null = null
  let previewProject: string | null = null
  const repo = async (): Promise<GhRepoFacts> => {
    facts ??= await ghRepoFacts(gh)
    return facts
  }
  const adapter: GitHubHostAdapter = {
    kind: "github",
    gh,
    setPreviewProject(projectName) {
      previewProject = projectName
    },
    auth: () => ghAuthStatus(gh),
    async repoFacts() {
      const value = await repo()
      return { isPrivate: value.isPrivate, defaultBranch: value.defaultBranch, viewerPermission: value.viewerPermission }
    },
    findPr: (branch) => findPr(gh, branch),
    createDraftPr: (input): Promise<PrSummary> => createDraftPr(gh, input),
    readPr: (number) => readPr(gh, number),
    async readThreadDetails(number) {
      const value = await repo()
      return readThreads(gh, { owner: value.owner, name: value.name }, number)
    },
    async readComments(number) {
      const raw = await gh.json<{
        comments?: Array<{ author?: { login?: string } | null; authorAssociation?: string; body?: string }>
        reviews?: Array<{ author?: { login?: string } | null; authorAssociation?: string; body?: string }>
      }>(["pr", "view", String(number), "--json", "comments,reviews"])
      return [...(raw.comments ?? []), ...(raw.reviews ?? [])].map((entry) => ({
        author: entry.author?.login ?? "ghost",
        authorAssociation: entry.authorAssociation ?? "NONE",
        body: entry.body ?? ""
      }))
    },
    async readThreads(number) {
      return adapter.readThreadDetails(number)
    },
    async postReview(number, review) {
      const pr = await readPr(gh, number)
      const posted = await postCommentReview(gh, { prNodeId: pr.nodeId, headSha: review.headSha, body: review.body, threads: review.threads })
      return { reviewId: posted.reviewId }
    },
    reply: (threadId, body) => replyToThread(gh, threadId, body),
    resolve: (threadId) => resolveThread(gh, threadId),
    markReady: (number) => markReady(gh, number),
    checks: (number) => prChecks(gh, number),
    comment: (number, body) => comment(gh, number, body),
    updateBranch: (number) => updateBranch(gh, number),
    previewUrl: (sha) => previewUrlForSha(gh, sha, previewProject),
    rules: (base) => baseRules(gh, base)
  }
  return adapter
}

export function isGitHubAdapter(host: GitHostAdapter): host is GitHubHostAdapter {
  return host.kind === "github" && typeof (host as Partial<GitHubHostAdapter>).readThreadDetails === "function"
}
