// §3g of the wizard build plan (git and the PR loop) as code: the GitOps and GitHostAdapter interfaces
// lane O4 implements, the branch name, trailers, markers and loop limits.
//
// NORMATIVE. The wizard never pushes to the base, never force-pushes, never amends, never rebases,
// never `gh pr merge` / `--admin`, never `--no-verify` / `-n` / `--no-gpg-sign`, and never posts
// APPROVE or REQUEST_CHANGES (reviews are `event: COMMENT`). The user merges.
import type { GitHostKind } from "./state.js"
import { WIZARD_BRANCH_PREFIX } from "./state.js"

export const GIT_HOST_KINDS = ["github", "gitlab", "bitbucket", "other"] as const satisfies readonly GitHostKind[]

/** `infinite/tag/<YYYY-MM-DD>-<runId first 6 hex>`, created in `before` before any scan. */
export function wizardBranchName(date: Date, runId: string): string {
  const day = date.toISOString().slice(0, 10)
  const hex = runId.replace(/-/g, "").slice(0, 6).toLowerCase()
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error("runId must start with 6 hex characters")
  return `${WIZARD_BRANCH_PREFIX}${day}-${hex}`
}

export const COMMIT_TRAILERS = {
  run: "Infinite-Tag-Run",
  /** Fix rounds only. */
  reviewRound: "Infinite-Review-Round"
} as const

/** The one follow-up commit allowed when a hook rewrote a recorded file (at most 1). */
export const RECEIPT_REFRESH_COMMIT_MESSAGE = "infinite-tag: refresh edit receipt after hooks" as const

export const PR_LOOP_LIMITS = {
  maxFixRounds: 2,
  mergePollMs: 30_000,
  /** No preview deployment within this → `undetermined (no_preview)`. */
  previewWaitMs: 10 * 60_000,
  /** `gh pr list --limit 200` + the marker filter, so a user with >30 PRs is still found. */
  prListLimit: 200
} as const

/** Title prefix when the host refuses drafts (a 422 mentioning drafts). */
export const DRAFT_UNSUPPORTED_TITLE_PREFIX = "[review pending] " as const

/** §3g.3 markers. Statuses are plain text the wizard owns; a literal `- [ ]` is forbidden. */
export const PR_MARKERS = {
  pr: (runId: string) => `<!-- infinite-tag:pr v1 run=${runId} -->`,
  review: (i: { runId: string; round: number; head: string; reviewer: string }) =>
    `<!-- infinite-tag:review v1 run=${i.runId} round=${i.round} head=${i.head} reviewer=${i.reviewer} -->`,
  /** Replies are never re-read as feedback. */
  reply: "<!-- infinite-tag:reply v1 -->",
  final: (runId: string) => `<!-- infinite-tag:final v1 run=${runId} -->`,
  /** The printed one-agent brief ends with this. */
  briefReview: (runId: string) => `<!-- infinite-tag:review v1 run=${runId} -->`,
  /** §3z.12 §3d.1 (B4): `done`'s report comment. */
  report: (runId: string) => `<!-- infinite-tag:report v1 run=${runId} -->`
} as const

export const FORBIDDEN_CHECKBOX = "- [ ]" as const

/** §3g.1. Every method runs `git` with the wizard's env (GIT_TERMINAL_PROMPT=0; SSH BatchMode unless the TTY was handed over). */
export interface GitOps {
  isRepo(): Promise<boolean>
  cleanTree(): Promise<{ clean: boolean; dirtyPaths: string[] }>
  remoteUrl(): Promise<string | null>
  /** `git fetch origin <base> && git switch -c <branch> origin/<base>`. */
  createBranch(base: string, branch: string): Promise<{ baseSha: string }>
  head(): Promise<string>
  stage(paths: readonly string[]): Promise<void>
  /** Never `-n`, `--no-verify`, `--no-gpg-sign` or `--amend`. Hooks run. */
  commit(input: { message: string; trailers: Record<string, string> }): Promise<{ sha: string; hookRewrote: string[] }>
  /** Never `-f`; never the base. */
  push(branch: string, sha?: string): Promise<void>
  /** §3g.4 step 5: after `gh pr update-branch`, `git pull --ff-only origin <branch>` (never a merge commit or rebase). */
  pullFfOnly(branch: string): Promise<{ headSha: string }>
  worktreeAddDetached(sha: string, purpose?: "baseline"): Promise<{ dir: string }>
  worktreeRemove(dir: string): Promise<void>
  diff(from: string, to: string): Promise<string>
  isAncestor(ancestor: string, descendant: string): Promise<boolean>
  /**
   * `git fetch origin <branch>` then the SHA of `origin/<branch>` (null when it cannot be read). `prove`
   * fetches the production branch with it before `isAncestor(mergeSha, servingSha)`, so a serving commit
   * this clone has not seen yet is known (O1 fix round, O1-11; lane O4's implementation already has it).
   */
  remoteBranchSha(branch: string): Promise<string | null>
}

/** Every non-GitHub host returns this from the review/PR methods; the review then goes to `.infinite/wizard/REVIEW.md`. */
export type Unsupported = { unsupported: true }

export interface PrSummary {
  number: number
  url: string
  nodeId: string
  isDraft: boolean
  state: "OPEN" | "CLOSED" | "MERGED"
  headRefOid: string
  mergeCommitOid: string | null
  mergedAt: string | null
  mergeStateStatus: string | null
  reviewDecision: string | null
}

export interface ReviewThread {
  threadId: string
  author: string
  /** OWNER / MEMBER / COLLABORATOR are teammates; anyone else is shown and never acted on. */
  authorAssociation: string
  path: string | null
  line: number | null
  body: string
  isResolved: boolean
}

/** §3g.2. */
export interface GitHostAdapter {
  kind: GitHostKind
  auth(): Promise<{ ok: boolean; login: string | null }>
  /** `homepageUrl` (§3y.1, optional): the repo's homepage, a hint for the live-site ask only. */
  repoFacts(): Promise<{ isPrivate: boolean; defaultBranch: string | null; viewerPermission: string | null; homepageUrl?: string | null; allowForking?: boolean | null; nameWithOwner?: string | null } | Unsupported>
  /** Creates the viewer's fork only after the early shipping choice was approved. */
  createFork?(preferSsh: boolean): Promise<{ remoteUrl: string; headOwner: string }>
  findPr(branch: string, headOwner?: string | null): Promise<PrSummary | null | Unsupported>
  /** Read-only notice of this author's older marked wizard PRs on other branches. */
  olderWizardPrs?(branch: string): Promise<Array<{ number: number }>>
  createDraftPr(input: { base: string; head: string; title: string; bodyFile: string }): Promise<PrSummary | Unsupported>
  readPr(number: number): Promise<PrSummary | Unsupported>
  readThreads(number: number): Promise<ReviewThread[] | Unsupported>
  /** One review, `event: COMMENT`. A finding outside a hunk goes into the body. */
  postReview(
    number: number,
    review: { headSha: string; body: string; threads: Array<{ path: string; line: number; body: string }> }
  ): Promise<{ reviewId: string } | Unsupported>
  reply(threadId: string, body: string): Promise<void | Unsupported>
  resolve(threadId: string): Promise<void | Unsupported>
  markReady(number: number): Promise<void | Unsupported>
  checks(number: number): Promise<Array<{ name: string; bucket: string; state: string }> | Unsupported>
  comment(number: number, body: string): Promise<void | Unsupported>
  /** Merge-commit default; never `--rebase`. */
  updateBranch(number: number): Promise<void | Unsupported>
  previewUrl(sha: string): Promise<string | null | Unsupported>
  /** A terminal Vercel preview failure for this SHA; optional on non-GitHub hosts and older adapters. */
  previewFailure?(sha: string): Promise<{ reason: string; blocked: boolean } | null | Unsupported>
  rules(base: string): Promise<{ requiresReview: boolean; mergeQueue: boolean } | Unsupported>
}

// ---------------------------------------------------------------------------------------------
// §3z.12 §3g.1 / §3g.2 (B4): lane O4's additive surfaces, folded here so every fake and lane uses one type.
// ---------------------------------------------------------------------------------------------

/** One `git status --porcelain=v1 -z` entry. `x` = index, `y` = worktree; `??` untracked, `!!` ignored. */
export interface StatusEntry {
  x: string
  y: string
  path: string
  /** The source path of a rename or copy. */
  origPath?: string
}

/** `GitOps` plus what the PR loop, the fence and the resume need (lane O4's `createGitOps` implements it). */
export interface WizardGitOps extends GitOps {
  commitsBetween?(from: string, to: string): Promise<Array<{ sha: string; subject: string; runId: string | null }>>
  ownsBaselineWorktree?(dir: string, root: string): boolean
  worktreeList?(): Promise<string[]>
  isIgnored?(path: string): Promise<boolean>
  /** The validated fork destination for pushes and review fast-forwards; origin stays the production base. */
  setPushRemote?(remoteUrl: string | null): void
  pushCommand?(branch: string, sha?: string): string
  /** `git status --porcelain=v1 -z --untracked-files=all` (ignored files excluded). */
  statusEntries(): Promise<StatusEntry[]>
  /** The file at a revision (`git show <rev>:<path>`), or null when it does not exist there. */
  showFile(rev: string, path: string): Promise<string | null>
  /** `git restore --staged -- <paths>`: takes paths out of the index, leaves the worktree as is. */
  unstage(paths: readonly string[]): Promise<void>
  /** The staged diff (`git diff --cached`), for the commit scan. */
  stagedDiff(): Promise<string>
  /** `git config --get <key>`, or null. */
  configGet(key: string): Promise<string | null>
  /** `origin/HEAD`'s branch name, or null. */
  originHead(): Promise<string | null>
  /** Switch to an existing local branch (resume). */
  switchTo(branch: string): Promise<void>
  /** The current branch name, or null when detached. */
  currentBranch(): Promise<string | null>
  /** `git merge-base <a> <b>`, or null (no common commit). B25: a run rebuilt from its PR marker re-derives its base SHA. */
  mergeBase?(a: string, b: string): Promise<string | null>
  /** GitLab: push with merge-request push options (§3g.2). */
  pushWithOptions(branch: string, pushOptions: readonly string[], sha?: string): Promise<void>
  /** True once the user owns the terminal (SSH may then prompt for a passphrase). */
  setTtyHandedOver(handedOver: boolean): void
  /** The base recorded by `createBranch` (or `setBase` on resume): pushes to it are refused. */
  setBase(base: string): void
  /** The exact argv of every git call made (for tests and the `--json` debug trail). */
  readonly calls: ReadonlyArray<readonly string[]>
}

/** One comment in a review thread, oldest first. */
export interface ThreadComment {
  author: string
  authorAssociation: string
  body: string
  viewerDidAuthor: boolean
}

/** `ReviewThread` plus every comment and the viewer flags (the trust rules need them). */
export interface ReviewThreadDetail extends ReviewThread {
  comments: ThreadComment[]
  viewerCanReply: boolean
  viewerCanResolve: boolean
  isOutdated: boolean
}

/** A PR conversation comment or review body (a printed-brief review arrives as one of these). */
export interface PrComment {
  author: string
  authorAssociation: string
  body: string
}

/** The GitHub adapter's additions to `GitHostAdapter` (§3z.12 §3g.2). */
export interface GitHostAdapterExtras {
  /** The linked Vercel project, so a monorepo's several previews can be told apart. */
  setPreviewProject(projectName: string | null): void
  readThreadDetails(number: number): Promise<ReviewThreadDetail[]>
  readComments(number: number): Promise<PrComment[]>
}
