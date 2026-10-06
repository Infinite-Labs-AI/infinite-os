// `GitHostAdapter` for GitHub (§3g.2), over `gh`. The wizard does every GitHub write itself; agents never hold
// gh or git credentials.
import type { GitHostAdapter, GitHostAdapterExtras, PrComment, PrSummary } from "../wizard/contracts/git-host.js"
import { prChecks, type PrCheck } from "../github/checks.js"
import type { GhClient } from "../github/gh.js"
import { comment, createDraftPr, findPr, markReady, readPr, updateBranch, updateOwnComment } from "../github/pr.js"
import { previewUrlForSha } from "../github/preview.js"
import { latestProductionDeployment, productionDeploymentForSha, productionDeploymentUrl, vercelDeploymentSeen, type GhDeployState, type LatestProductionDeployment } from "../github/deployments.js"
import { createViewerFork, ghAuthStatus, ghRepoFacts, type GhRepoFacts } from "../github/repo.js"
import { postCommentReview } from "../github/review.js"
import { baseRules } from "../github/rules.js"
import { readThreads, replyToThread, resolveThread, type ReviewThreadDetail } from "../github/threads.js"

export interface GitHubHostAdapter extends GitHostAdapter, GitHostAdapterExtras {
  kind: "github"
  readonly gh: GhClient
  /** The linked Vercel project, so a monorepo's several previews can be told apart (§3g.2). */
  setPreviewProject(projectName: string | null): void
  /** `readThreads` with every comment and the viewer flags (the trust rules need them). */
  readThreadDetails(number: number): Promise<ReviewThreadDetail[]>
  /** The PR's conversation comments and review bodies (a printed-brief review arrives as one of these). */
  readComments(number: number): Promise<PrComment[]>
  /** R2-5: edits the wizard's own marked comment (author AND marker); false when there is none. */
  updateOwnComment(number: number, marker: string, edit: (body: string) => string): Promise<boolean>
  // GitHub supports every method: the return types narrow (never `{unsupported:true}`).
  readPr(number: number): Promise<PrSummary>
  findPr(branch: string, headOwner?: string | null): Promise<PrSummary | null>
  createDraftPr(input: { base: string; head: string; title: string; bodyFile: string }): Promise<PrSummary>
  createFork(preferSsh: boolean): Promise<{ remoteUrl: string; headOwner: string }>
  checks(number: number): Promise<PrCheck[]>
  rules(base: string): Promise<{ requiresReview: boolean; mergeQueue: boolean }>
  previewUrl(sha: string): Promise<string | null>
  /** §3y.4: the merge SHA's production deployment (GitHub Deployments; the linked project picks in a monorepo). */
  productionDeployment(sha: string): Promise<{ state: GhDeployState }>
  /** §3x.6: the merge SHA's production deployment's own preview-class address (`*.vercel.app`), or null. */
  productionDeploymentUrl(sha: string): Promise<string | null>
  /** §3y.4: the newest successful production deployment, or null. */
  latestProductionDeployment(): Promise<LatestProductionDeployment | null>
  /** §3y.4: the repo has a deployment by `vercel[bot]` (a Vercel signal without an Infinite connection). */
  vercelDeploymentSeen(): Promise<boolean>
}

/** The deploy reads a host offers (§3y.4): the GitHub adapter's, or none (another host, or a test fake). */
export interface DeploymentReader {
  productionDeployment(sha: string): Promise<{ state: GhDeployState }>
  /** §3x.6 the merge SHA's production deployment's own preview-class address, or null. */
  productionDeploymentUrl?(sha: string): Promise<string | null>
  latestProductionDeployment(): Promise<LatestProductionDeployment | null>
  vercelDeploymentSeen(): Promise<boolean>
  setPreviewProject?(projectName: string | null): void
}

/** R2-5: the comment editor a host offers (the GitHub adapter's), or none (another host, or a test fake). */
export interface CommentEditor {
  updateOwnComment(number: number, marker: string, edit: (body: string) => string): Promise<boolean>
}

export function commentEditor(host: GitHostAdapter): CommentEditor | null {
  const candidate = host as Partial<CommentEditor> & { kind?: string }
  return candidate.kind === "github" && typeof candidate.updateOwnComment === "function" ? (candidate as CommentEditor) : null
}

export function deploymentReader(host: GitHostAdapter): DeploymentReader | null {
  const candidate = host as Partial<DeploymentReader> & { kind?: string }
  return candidate.kind === "github" && typeof candidate.productionDeployment === "function" && typeof candidate.latestProductionDeployment === "function" && typeof candidate.vercelDeploymentSeen === "function"
    ? (candidate as DeploymentReader)
    : null
}

export type { PrComment } from "../wizard/contracts/git-host.js"

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
      return { isPrivate: value.isPrivate, defaultBranch: value.defaultBranch, viewerPermission: value.viewerPermission, homepageUrl: value.homepageUrl, allowForking: value.allowForking, nameWithOwner: value.nameWithOwner }
    },
    createFork: async (preferSsh) => createViewerFork(gh, await repo(), preferSsh),
    findPr: (branch, headOwner) => findPr(gh, branch, headOwner),
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
    async updateOwnComment(number, marker, edit) {
      const login = (await ghAuthStatus(gh)).login
      if (!login) return false
      return updateOwnComment(gh, { number, login, marker, edit })
    },
    updateBranch: (number) => updateBranch(gh, number),
    previewUrl: (sha) => previewUrlForSha(gh, sha, previewProject),
    productionDeployment: (sha) => productionDeploymentForSha(gh, sha, previewProject),
    productionDeploymentUrl: (sha) => productionDeploymentUrl(gh, sha, previewProject),
    latestProductionDeployment: () => latestProductionDeployment(gh, previewProject),
    vercelDeploymentSeen: () => vercelDeploymentSeen(gh),
    rules: (base) => baseRules(gh, base)
  }
  return adapter
}

export function isGitHubAdapter(host: GitHostAdapter): host is GitHubHostAdapter {
  return host.kind === "github" && typeof (host as Partial<GitHubHostAdapter>).readThreadDetails === "function"
}
