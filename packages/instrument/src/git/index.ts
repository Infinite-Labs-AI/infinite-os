// `GitOps` (§3g.1), lane O4's implementation over the real `git` binary. Every call goes through the argv
// guard in run.ts, so the wizard can never force-push, amend, rebase, skip hooks or signing, stage everything,
// or push to the base.
//
// `WizardGitOps` adds a few read helpers the O4 steps need beyond the §3g.1 list (the porcelain entries with
// their status codes, a file at a revision, unstaging, the staged diff, a config read, the push-option push
// for GitLab, the TTY hand-over switch). They are ADDITIVE: every §3g.1 method keeps its contract shape.
import type { WizardGitOps } from "../wizard/contracts/git-host.js"
import { constants, accessSync, mkdirSync } from "node:fs"
import { isAbsolute, join } from "node:path"

import type { GitOps } from "../wizard/contracts/git-host.js"
import { WIZARD_BRANCH_PREFIX } from "../wizard/contracts/state.js"
import { isSafeBranchName, originHeadToBranch } from "./branch.js"
import { buildCommitMessage, classifyCommitFailure } from "./commit.js"
import { classifyPushFailure, pushArgv } from "./push.js"
import { assertSafeGitArgv, gitChildEnv, spawnProcess, type ProcessResult, type ProcessRunner } from "./run.js"
import { parsePorcelainZ, type StatusEntry } from "./status.js"
import { defaultWorktreeRoot, worktreeDirFor } from "./worktree.js"

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: ProcessResult
  ) {
    super(`git ${args[0] ?? ""} failed${result.error ? ` (${result.error})` : ` with exit ${String(result.status)}`}`)
    this.name = "GitCommandError"
  }
}

export type { WizardGitOps } from "../wizard/contracts/git-host.js"

export interface CreateGitOpsOptions {
  /** The repo root (git's cwd). */
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  runner?: ProcessRunner
  /** Where reviewer worktrees go; default `~/Library/Caches/infinite-tag/<runKey>/worktrees`. */
  worktreeRoot?: string
  runKey?: string
  gitBin?: string
}

export function createGitOps(options: CreateGitOpsOptions): WizardGitOps {
  const runner = options.runner ?? spawnProcess
  const gitBin = options.gitBin ?? "git"
  const calls: string[][] = []
  let base: string | null = null
  let ttyHandedOver = false

  async function git(args: string[], extra: { input?: string; allowFail?: boolean } = {}): Promise<ProcessResult> {
    assertSafeGitArgv(args, { base })
    calls.push([...args])
    const result = await runner(gitBin, args, {
      cwd: options.cwd,
      env: gitChildEnv(options.env, { ttyHandedOver }),
      input: extra.input
    })
    if (!extra.allowFail && (result.status !== 0 || result.error)) throw new GitCommandError(args, result)
    return result
  }

  const trimmed = async (args: string[]): Promise<string> => (await git(args)).stdout.trim()

  async function commitHookInstalled(): Promise<boolean> {
    for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
      const result = await git(["rev-parse", "--git-path", `hooks/${hook}`], { allowFail: true })
      const path = result.stdout.trim()
      if (!path) continue
      try {
        accessSync(isAbsolute(path) ? path : join(options.cwd, path), constants.X_OK)
        return true
      } catch {
        // Not installed or not executable: git skips it.
      }
    }
    return false
  }

  async function blobsAt(rev: "INDEX" | "HEAD", paths: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (paths.length === 0) return map
    const result =
      rev === "INDEX" ? await git(["ls-files", "-s", "-z", "--", ...paths]) : await git(["ls-tree", "-r", "-z", "HEAD", "--", ...paths])
    for (const record of result.stdout.split("\0")) {
      if (!record) continue
      const tab = record.indexOf("\t")
      if (tab === -1) continue
      const meta = record.slice(0, tab).split(" ")
      // ls-files -s: "<mode> <blob> <stage>"; ls-tree: "<mode> blob <blob>".
      const blob = rev === "INDEX" ? meta[1] : meta[2]
      if (blob) map.set(record.slice(tab + 1), blob)
    }
    return map
  }

  const ops: WizardGitOps = {
    get calls() {
      return calls
    },
    setTtyHandedOver(handedOver) {
      ttyHandedOver = handedOver
    },
    setBase(value) {
      if (!isSafeBranchName(value)) throw new Error(`unsafe base branch ${JSON.stringify(value)}`)
      base = value
    },

    async isRepo() {
      const result = await git(["rev-parse", "--is-inside-work-tree"], { allowFail: true })
      return result.status === 0 && result.stdout.trim() === "true"
    },
    async cleanTree() {
      const entries = await ops.statusEntries()
      return { clean: entries.length === 0, dirtyPaths: entries.map((entry) => entry.path) }
    },
    async remoteUrl() {
      const result = await git(["remote", "get-url", "origin"], { allowFail: true })
      return result.status === 0 ? result.stdout.trim() || null : null
    },
    async createBranch(baseBranch, branch) {
      if (!isSafeBranchName(baseBranch)) throw new Error(`unsafe base branch ${JSON.stringify(baseBranch)}`)
      if (!isSafeBranchName(branch) || !branch.startsWith(WIZARD_BRANCH_PREFIX)) throw new Error(`unsafe PR branch ${JSON.stringify(branch)}`)
      if (branch === baseBranch) throw new Error("the PR branch cannot be the base")
      base = baseBranch
      await git(["fetch", "origin", baseBranch])
      await git(["switch", "--no-track", "-c", branch, `origin/${baseBranch}`])
      const head = await trimmed(["rev-parse", "HEAD"])
      const remoteBase = await trimmed(["rev-parse", `origin/${baseBranch}`])
      // §3g.1 / wf4 PR-03: before any scan or edit, HEAD is exactly origin/<base>.
      if (head !== remoteBase) throw new Error(`HEAD ${head} is not origin/${baseBranch} ${remoteBase}`)
      return { baseSha: head }
    },
    async head() {
      return trimmed(["rev-parse", "HEAD"])
    },
    async stage(paths) {
      if (paths.length === 0) return
      for (const path of paths) {
        if (path.startsWith("-") || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`unsafe path ${JSON.stringify(path)}`)
      }
      await git(["add", "--", ...paths])
    },
    async commit(input) {
      const staged = (await git(["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean)
      const before = await blobsAt("INDEX", staged)
      const message = buildCommitMessage(input.message, input.trailers)
      const result = await git(["commit", "-F", "-"], { input: message, allowFail: true })
      if (result.status !== 0 || result.error) {
        throw classifyCommitFailure(`${result.stdout}\n${result.stderr}`, staged, await commitHookInstalled())
      }
      const sha = await trimmed(["rev-parse", "HEAD"])
      const after = await blobsAt("HEAD", staged)
      // A hook that rewrote a staged file leaves a committed blob that differs from what was staged.
      const hookRewrote = staged.filter((path) => before.has(path) && before.get(path) !== after.get(path))
      return { sha, hookRewrote }
    },
    async push(branch) {
      const result = await git(pushArgv(branch), { allowFail: true })
      if (result.status !== 0 || result.error) throw classifyPushFailure(`${result.stderr}\n${result.error ?? ""}`)
    },
    async pushWithOptions(branch, pushOptions) {
      const result = await git(pushArgv(branch, pushOptions), { allowFail: true })
      if (result.status !== 0 || result.error) throw classifyPushFailure(`${result.stderr}\n${result.error ?? ""}`)
    },
    async pullFfOnly(branch) {
      if (!isSafeBranchName(branch)) throw new Error(`unsafe branch ${JSON.stringify(branch)}`)
      // fetch + merge --ff-only rather than `git pull`, so a user's pull.rebase setting can never rebase.
      await git(["fetch", "origin", branch])
      await git(["merge", "--ff-only", `origin/${branch}`])
      return { headSha: await trimmed(["rev-parse", "HEAD"]) }
    },
    async worktreeAddDetached(sha) {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("worktreeAddDetached needs a full SHA")
      const root = options.worktreeRoot ?? defaultWorktreeRoot(options.runKey ?? "run")
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const dir = worktreeDirFor(root, sha)
      await git(["worktree", "add", "--detach", dir, sha])
      return { dir }
    },
    async worktreeRemove(dir) {
      await git(["worktree", "remove", "--force", dir], { allowFail: true })
      await git(["worktree", "prune"], { allowFail: true })
    },
    async diff(from, to) {
      return (await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${from}...${to}`])).stdout
    },
    async isAncestor(ancestor, descendant) {
      const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true })
      if (result.status === 0) return true
      if (result.status === 1) return false
      throw new GitCommandError(["merge-base"], result)
    },

    async statusEntries() {
      const result = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      return parsePorcelainZ(result.stdout)
    },
    async showFile(rev, path) {
      if (path.startsWith("-") || path.split("/").includes("..")) throw new Error(`unsafe path ${JSON.stringify(path)}`)
      const result = await git(["show", `${rev}:${path}`], { allowFail: true })
      return result.status === 0 ? result.stdout : null
    },
    async unstage(paths) {
      if (paths.length === 0) return
      await git(["restore", "--staged", "--", ...paths])
    },
    async stagedDiff() {
      return (await git(["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0"])).stdout
    },
    async configGet(key) {
      if (!/^[A-Za-z0-9.-]+$/.test(key)) throw new Error("bad config key")
      const result = await git(["config", "--get", key], { allowFail: true })
      return result.status === 0 ? result.stdout.trim() : null
    },
    async originHead() {
      const result = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFail: true })
      return result.status === 0 ? originHeadToBranch(result.stdout) : null
    },
    async switchTo(branch) {
      if (!isSafeBranchName(branch)) throw new Error(`unsafe branch ${JSON.stringify(branch)}`)
      await git(["switch", branch])
    },
    async remoteBranchSha(branch) {
      if (!isSafeBranchName(branch)) throw new Error(`unsafe branch ${JSON.stringify(branch)}`)
      const fetched = await git(["fetch", "origin", branch], { allowFail: true })
      if (fetched.status !== 0) return null
      const result = await git(["rev-parse", `origin/${branch}`], { allowFail: true })
      return result.status === 0 ? result.stdout.trim() || null : null
    },
    async currentBranch() {
      const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true })
      return result.status === 0 ? result.stdout.trim() || null : null
    }
  }
  return ops
}

/** The extras, when `deps.git` is O4's implementation (I1 wires it); null for a contract-only fake. */
export function wizardGitExtras(git: GitOps): WizardGitOps | null {
  const candidate = git as Partial<WizardGitOps>
  return typeof candidate.statusEntries === "function" &&
    typeof candidate.showFile === "function" &&
    typeof candidate.unstage === "function" &&
    typeof candidate.stagedDiff === "function"
    ? (git as WizardGitOps)
    : null
}
