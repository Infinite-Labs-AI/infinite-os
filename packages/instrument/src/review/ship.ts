import { measureOwnerDiff, measureWizardCommits, unrecordedCommits, ownerBoundaryStop } from "../jobs/owner-diff.js"
import { gitlabMergeRequestPushOptions } from "../git/push.js"
// Commit → push → PR (lane O4, §3g.1–§3g.3), shared by the `rehearsal` step (the first commit) and the
// `review` step (fix rounds). Every commit is scanned (§3g.5) before it is made; a hit unstages that file and
// blocks the jobs that own it. Hooks run; a hook that rewrites a file re-runs the diff gate and refreshes the
// edit receipt in ONE follow-up commit. Signing or an SSH passphrase hands the terminal to the user.
import { join } from "node:path"

import type { StepOutcome, WizardContext, WizardDeps } from "../wizard/contracts/deps.js"
import { COMMIT_TRAILERS, RECEIPT_REFRESH_COMMIT_MESSAGE, type PrSummary } from "../wizard/contracts/git-host.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { WIZARD_PATHS, type GitHostKind } from "../wizard/contracts/state.js"
import type { WizardStepId } from "../wizard/contracts/steps.js"
import { allowEntryMatches, computeStageSet, GitCommitError, INSTALL_MANIFEST_PATH, type StageSet } from "../git/commit.js"
import type { WizardGitOps } from "../git/index.js"
import { GitPushError } from "../git/push.js"
import { gitignoreChangeIsFenceOnly } from "../git/status.js"
import { hostLinkFor, parseRemote } from "../hosts/index.js"
import { isUnsupported } from "../hosts/other.js"
import { parseUnifiedDiff } from "./diff.js"
import { safeDisplayText } from "./display.js"
import type { Scanner, ScanHit } from "./scan.js"
import { sub } from "./context.js"
import { DEPENDENCY_INSTALL_RECORD } from "../wizard/local-validation.js"
import { acknowledgeUnverifiedHistory, prepareCommitHistory } from "../wizard/commit-history.js"

export type CommitResult =
  | { kind: "committed"; sha: string; staged: string[]; leftOut: StageSet["leftOut"]; blocked: ScanHit[]; receiptRefreshSha: string | null }
  | { kind: "nothing"; leftOut: StageSet["leftOut"]; blocked: ScanHit[] }
  | { kind: "refused"; message: string }
  | { kind: "hook_failed"; ourFiles: string[]; output: string; /** The exact command that commits with the run's trailers (§3g.1). */ command: string }
  | { kind: "failed"; message: string }

export interface CommitInput {
  ctx: WizardContext
  deps: WizardDeps
  git: WizardGitOps
  step: WizardStepId
  scanner: Scanner
  runId: string
  message: string
  /** Set on review fix rounds (`Infinite-Review-Round: <k>`). */
  round: number | null
  allowlist: readonly string[]
  managed: readonly string[]
  npmFiles: readonly string[]
  connectionIds: readonly string[]
}

/** Marks the agent jobs whose allowlist covers a blocked file `blocked:needs_you`, with the scan kind as the note. */
export function blockJobsForFiles(ctx: WizardContext, files: ReadonlyArray<{ file: string; kind: string }>): void {
  if (files.length === 0) return
  ctx.state.update((state) => {
    state.jobs = state.jobs.map((job): ChecklistItem => {
      const hit = files.find((entry) => [...job.allow.files, ...job.allow.create].some((allow) => allowEntryMatches(allow, entry.file)))
      if (!hit || job.owner !== "agent") return job
      return { ...job, state: "blocked", blockedReason: "needs_you" }
    })
  })
  const jobs = ctx.state.get().jobs
  for (const entry of files) {
    for (const job of jobs.filter((candidate) => candidate.state === "blocked" && [...candidate.allow.files, ...candidate.allow.create].some((allow) => allowEntryMatches(allow, entry.file)))) {
      ctx.emit.emit("job.state", { itemId: job.id, state: "blocked", by: "wizard", note: `${entry.file}: [redacted: ${entry.kind}] would have been committed` })
    }
  }
}

async function headTexts(git: WizardGitOps, paths: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const path of paths) map.set(path, (await git.showFile("HEAD", path)) ?? "")
  return map
}

/** Scans the staged diff; unstages every file with a hit. Returns the hits. */
async function scanStaged(git: WizardGitOps, scanner: Scanner): Promise<ScanHit[]> {
  const files = parseUnifiedDiff(await git.stagedDiff())
  const heads = await headTexts(git, files.map((file) => file.path))
  const hits = scanner.findInCommit(files, (file, value) => (heads.get(file) ?? "").includes(value))
  const blockedFiles = [...new Set(hits.map((hit) => hit.file).filter((file): file is string => typeof file === "string"))]
  await git.unstage(blockedFiles)
  return hits
}

/**
 * Runs the post-turn gate over the staged, agent-touchable (non-managed) files; unstages each one with a hit.
 * §3y.8 (P2-5): `.infinite/install.json` is the wizard's OWN receipt — never turn-gated (its `textEdits` quote the
 * code an edit removed, e.g. a duplicate `G-…` id that is not a connection id), still secret-scanned.
 */
async function gateStaged(input: CommitInput): Promise<string[]> {
  const managed = new Set([...input.managed, INSTALL_MANIFEST_PATH])
  const files = parseUnifiedDiff(await input.git.stagedDiff()).filter((file) => !managed.has(file.path) && file.added.length > 0)
  if (files.length === 0) return []
  const results = await input.deps.checks.turnGate({ files: files.map((file) => ({ path: file.path, added: file.added, removed: file.removed })) }, { connectionIds: input.connectionIds })
  const hit = [...new Set(results.filter((result) => result.state === "problem").flatMap((result) => (result.evidence ?? []).flatMap((entry) => ("file" in entry ? [entry.file] : []))))]
  // A gate problem with no file (the gate itself crashed) holds back every gated file: fail closed.
  const crashed = results.some((result) => result.state === "problem" && !(result.evidence ?? []).some((entry) => "file" in entry))
  const out = crashed ? files.map((file) => file.path) : hit
  await input.git.unstage(out)
  return out
}

/** §3g.1: stage exactly the allowed set, scan it, commit with the run trailer. */
export async function stageAndCommit(input: CommitInput): Promise<CommitResult> {
  const { git, ctx } = input
  const parent = await git.head()
  await prepareCommitHistory(ctx, parent)
  const boundary = await measureOwnerDiff({ root: ctx.root, appRoot: ctx.appRoot, baseSha: parent })
  ctx.state.update(state => { state.ownerBoundary = boundary })
  await ctx.state.save()
  if (boundary.state !== "checked") return { kind: "refused", message: safeDisplayText(input.scanner, ownerBoundaryStop(boundary)) }
  const allEntries = await git.statusEntries()
  let createdLockfiles: string[] = []
  try {
    const record = JSON.parse(await input.deps.fs.readText(join(ctx.root, DEPENDENCY_INSTALL_RECORD)) ?? "null") as { createdLockfiles?: unknown } | null
    if (Array.isArray(record?.createdLockfiles)) createdLockfiles = record.createdLockfiles.filter((file): file is string => typeof file === "string" && !file.startsWith("/") && !file.split("/").includes("..") && /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(file))
  } catch { /* A malformed optional install record cannot add anything to the commit allowlist. */ }
  const omitted = new Set(createdLockfiles)
  const stagedNewLocks = allEntries.filter(entry => omitted.has(entry.path) && entry.x !== " " && entry.x !== "?").map(entry => entry.path)
  if (stagedNewLocks.length) await git.unstage(stagedNewLocks)
  const entries = allEntries.filter(entry => !omitted.has(entry.path))
  let fenceOnly = true
  if (entries.some((entry) => entry.path === ".gitignore")) {
    fenceOnly = gitignoreChangeIsFenceOnly(await git.showFile("HEAD", ".gitignore"), await input.deps.fs.readText(join(ctx.root, ".gitignore")))
  }
  const set = computeStageSet({ entries, allowlist: input.allowlist, managed: input.managed, npmFiles: input.npmFiles, gitignoreFenceOnly: fenceOnly })
  if (set.refusal) return { kind: "refused", message: set.refusal }
  // Anything already in the index that is not ours comes out (the wizard commits only its own set).
  const strayStaged = entries.filter((entry) => entry.x !== " " && entry.x !== "?" && entry.x !== "!" && !set.stage.includes(entry.path)).map((entry) => entry.path)
  await git.unstage(strayStaged)
  if (set.stage.length === 0) return { kind: "nothing", leftOut: set.leftOut, blocked: [] }
  await git.stage(set.stage)
  const blocked = await scanStaged(git, input.scanner)
  // Review I1 P1-3: the post-turn gate again, on what is about to be committed. Each turn's diff was gated, but
  // a later process (the wizard's own build running agent code) could have rewritten an agent file since.
  // Wizard-written (managed) files are its own bytes and are not re-gated here.
  const gated = await gateStaged(input)
  if (gated.length > 0) {
    blockJobsForFiles(ctx, gated.map((file) => ({ file, kind: "turn_gate" })))
    sub(ctx, input.step, `Held back ${gated.length} file(s): the post-turn gate refused what would have been committed`, "warn")
  }
  if (blocked.length > 0) {
    blockJobsForFiles(ctx, blocked.filter((hit) => hit.file).map((hit) => ({ file: hit.file!, kind: hit.kind })))
    sub(ctx, input.step, `Held back ${new Set(blocked.map((hit) => hit.file)).size} file(s): a secret or personal data would have been committed`, "warn")
  }
  const stillStaged = (await git.statusEntries()).filter((entry) => entry.x !== " " && entry.x !== "?" && entry.x !== "!")
  if (stillStaged.length === 0) return { kind: "nothing", leftOut: set.leftOut, blocked }
  // §3y.8: the commit line counts what IS in the commit (staged minus held back, minus scan-blocked).
  const committed = [...new Set(stillStaged.map((entry) => entry.path))].sort()
  const trailers: Record<string, string> = { [COMMIT_TRAILERS.run]: input.runId }
  if (input.round !== null) trailers[COMMIT_TRAILERS.reviewRound] = String(input.round)

  let sha: string
  let hookRewrote: string[] = []
  try {
    const committed = await git.commit({ message: input.message, trailers })
    sha = committed.sha
    await recordWizardCommit(ctx, sha)
    hookRewrote = committed.hookRewrote
  } catch (error) {
    if (!(error instanceof GitCommitError)) return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
    if (error.kind === "nothing_to_commit") return { kind: "nothing", leftOut: set.leftOut, blocked }
    if (error.kind === "hook_failed") {
      const ourFiles = error.pathsInOutput.filter((path) => set.stage.includes(path))
      // §3g.1: stop with the files staged and print the exact command (its message file carries the run trailer).
      const command = await writeCommitMessage(input, trailers)
      return { kind: "hook_failed", ourFiles, output: input.scanner.redact(error.stderr).text.slice(0, 2_000), command }
    }
    if (error.kind === "signing") {
      const handed = await handOverCommit(input, trailers)
      if (handed === null) return { kind: "failed", message: "Signing the commit needs your terminal, and the hand-over did not finish." }
      sha = handed
      await recordWizardCommit(ctx, sha)
    } else {
      return { kind: "failed", message: `git commit failed: ${input.scanner.redact(error.stderr).text.slice(0, 500)}` }
    }
  }

  let receiptRefreshSha: string | null = null
  if (hookRewrote.length > 0) {
    // §3g.1: a hook rewrote a file → the diff gate again (scan + the post-turn gate) on what the hook committed.
    sub(ctx, input.step, `A commit hook rewrote ${hookRewrote.length} file(s); checking them again`, "info")
    const committedFiles = parseUnifiedDiff(await git.diff(`${sha}~1`, sha)).filter((file) => hookRewrote.includes(file.path))
    const heads = await headTexts(git, committedFiles.map((file) => file.path))
    const hits = input.scanner.findInCommit(committedFiles, (file, value) => (heads.get(file) ?? "").includes(value))
    const gate = await input.deps.checks.turnGate({ files: committedFiles.map((file) => ({ path: file.path, added: file.added, removed: file.removed })) }, { connectionIds: input.connectionIds })
    const problems = gate.filter((result) => result.state === "problem")
    if (hits.length > 0 || problems.length > 0) {
      return {
        kind: "failed",
        message:
          "A commit hook rewrote files into something the wizard will not push (a secret, personal data or an unsafe change). " +
          "Nothing was pushed; review the last commit, then run `npx infinite-tag --resume`."
      }
    }
    const refreshed = await input.deps.installer.refreshEditReceiptFromHead()
    if (refreshed.refreshed) {
      await git.stage([INSTALL_MANIFEST_PATH])
      const follow = await git.commit({ message: RECEIPT_REFRESH_COMMIT_MESSAGE, trailers: { [COMMIT_TRAILERS.run]: input.runId } })
      receiptRefreshSha = follow.sha
      await recordWizardCommit(ctx, follow.sha)
      sha = follow.sha
    }
  }
  return { kind: "committed", sha, staged: committed, leftOut: set.leftOut, blocked, receiptRefreshSha }
}

async function recordWizardCommit(ctx: WizardContext, sha: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("The wizard commit did not return a full SHA")
  ctx.state.update(state => { state.wizardCommits = [...new Set([...(state.wizardCommits ?? []), sha])] })
  await ctx.state.save()
}

/** Writes the commit message (with the run trailers) to `.infinite/wizard/commit-message.txt`; returns the command. */
async function writeCommitMessage(input: CommitInput, trailers: Record<string, string>): Promise<string> {
  const messagePath = join(input.ctx.root, WIZARD_PATHS.dir, "commit-message.txt")
  const message = `${input.message.trim()}\n\n${Object.entries(trailers).map(([key, value]) => `${key}: ${value}`).join("\n")}\n`
  await input.deps.fs.mkdirp(join(input.ctx.root, WIZARD_PATHS.dir), 0o700)
  await input.deps.fs.writeTextAtomic(messagePath, message, 0o600)
  return `git commit -F ${WIZARD_PATHS.dir}/commit-message.txt`
}

/** Signing needs the user's terminal (pinentry / a passphrase): the UI runs the commit with the TTY. */
async function handOverCommit(input: CommitInput, trailers: Record<string, string>): Promise<string | null> {
  const { ctx, git } = input
  const command = await writeCommitMessage(input, trailers)
  ctx.emit.emit("tty.handover", { reason: "gpg" })
  const answer = await ctx.ask("tty-handover", { reason: "gpg", command })
  ctx.emit.emit("tty.resume", {})
  if (typeof answer !== "object" || answer.exitCode !== 0) return null
  return git.head()
}

export type PushResult = { kind: "pushed"; mergeRequestOpened: boolean } | { kind: "failed"; message: string }

/**
 * §3g.1 push. GitLab first tries the merge-request push options; a refusal falls back to a plain push. An SSH
 * key with a passphrase hands the terminal over once. Refusals are reported verbatim; a fork is chosen earlier.
 */
export async function pushBranch(input: {
  ctx: WizardContext
  deps: WizardDeps
  git: WizardGitOps
  scanner: Scanner
  hostKind: GitHostKind
  base: string
  branch: string
  title: string
}): Promise<PushResult> {
  const { ctx, git } = input
  const measuredSha = await git.head()
  await prepareCommitHistory(ctx, measuredSha)
  const state = ctx.state.get()
  const boundary = await measureWizardCommits({ root: ctx.root, appRoot: ctx.appRoot, baseSha: state.git?.baseSha ?? "", headSha: measuredSha, wizardCommits: state.wizardCommits, historyReason: state.commitHistory?.unverifiedReason })
  ctx.state.update(state => { state.ownerBoundary = boundary })
  await ctx.state.save()
  if (boundary.state === "changed" || boundary.issues.length > 0 || (boundary.state === "not_checked" && !boundary.unverifiedReason)) return { kind: "failed", message: safeDisplayText(input.scanner, ownerBoundaryStop(boundary)) }
  if (!await acknowledgeUnverifiedHistory(ctx, measuredSha, boundary)) return { kind: "failed", message: "Continuing with the unverified earlier history was declined. Nothing was pushed." }
  if (await git.head() !== measuredSha) return { kind: "failed", message: "The branch changed while reviewing its history. Run again to review the current commits." }
  const foreign = await unrecordedCommits({ root: ctx.root, baseSha: state.git?.baseSha ?? "", headSha: measuredSha, wizardCommits: state.wizardCommits ?? [], approvedForeignCommits: state.approvedForeignCommits ?? [], priorHistoryHeads: ctx.state.get().commitHistory?.priorHeads })
  if (foreign === null) return { kind: "failed", message: "Nothing pushed: the commits outside the wizard's record could not be listed." }
  if (foreign.length > 0) {
    const list = foreign.map(commit => `${commit.sha.slice(0, 12)} ${safeDisplayText(input.scanner, commit.subject)}`).join("\n")
    if (await ctx.ask("confirm", { question: `These commits are not in this wizard's own commit record or its saved earlier history and would be pushed:\n${list}\nPush these additional commits to the recorded branch?`, defaultYes: false }) !== true) return { kind: "failed", message: "The additional commits were not approved for push. They remain local." }
    if (await git.head() !== measuredSha) return { kind: "failed", message: "The branch changed while approving the push. Run again to review its current commits." }
    ctx.state.update(draft => { draft.approvedForeignCommits = [...new Set([...(draft.approvedForeignCommits ?? []), ...foreign.map(commit => commit.sha)])] })
    await ctx.state.save()
  }
  const pushed = async (mergeRequestOpened: boolean): Promise<PushResult> => {
    ctx.state.update(draft => { draft.lastPush = { sha: measuredSha, at: ctx.now().toISOString() } })
    await ctx.state.save()
    return { kind: "pushed", mergeRequestOpened }
  }
  const attempt = async (): Promise<void> => git.push(input.branch, measuredSha)
  try {
    if (input.hostKind === "gitlab") {
      try {
        await git.pushWithOptions(input.branch, gitlabMergeRequestPushOptions(input.base, input.title), measuredSha)
        return await pushed(true)
      } catch {
        // GitLab refused the push options: push plainly and print the link.
      }
    }
    await attempt()
    return await pushed(false)
  } catch (error) {
    if (!(error instanceof GitPushError)) return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
    if (error.kind === "ssh_passphrase") {
      ctx.emit.emit("tty.handover", { reason: "ssh" })
      git.setTtyHandedOver(true)
      const answer = await ctx.ask("tty-handover", { reason: "ssh", command: git.pushCommand?.(input.branch, measuredSha) ?? `git push -u origin ${measuredSha}:refs/heads/${input.branch}` })
      git.setTtyHandedOver(false)
      ctx.emit.emit("tty.resume", {})
      if (typeof answer === "object" && answer.exitCode === 0) return await pushed(false)
      return { kind: "failed", message: "The push needs your SSH key, and the hand-over did not finish." }
    }
    return { kind: "failed", message: `git push was refused: ${input.scanner.redact(error.stderr).text.trim().slice(0, 600)}` }
  }
}

export type EnsurePrResult =
  | { kind: "pr"; pr: PrSummary; adopted: boolean; draftFallback: boolean }
  | { kind: "link"; url: string | null; why: "not_github" | "gh_unavailable" }
  | { kind: "failed"; message: string; noPushAccess?: boolean; closed?: boolean }

/** §3g.2: adopt an open PR on the branch, else create a draft (or a ready `[review pending] ` PR). */
export async function ensurePr(input: {
  deps: WizardDeps
  remoteUrl: string | null
  base: string
  branch: string
  title: string
  body: string
  root: string
  ghReady: boolean
  headOwner?: string | null
}): Promise<EnsurePrResult> {
  const { deps } = input
  if (deps.host.kind !== "github" || !input.ghReady) {
    const link = hostLinkFor(deps.host.kind === "github" ? "github" : deps.host.kind, input.remoteUrl ? parseRemote(input.remoteUrl) : null, input.base, input.branch)
    return { kind: "link", url: link, why: deps.host.kind === "github" ? "gh_unavailable" : "not_github" }
  }
  const existing = await deps.host.findPr(input.branch, input.headOwner)
  if (!isUnsupported(existing) && existing !== null && existing.state === "OPEN") return { kind: "pr", pr: existing, adopted: true, draftFallback: false }
  if (!isUnsupported(existing) && existing !== null && existing.state === "CLOSED") {
    // §3d.6: a closed PR is never reopened or duplicated from the same branch: the user starts a fresh run.
    return { kind: "failed", message: `Pull request #${existing.number} on this branch was closed without merging. Run \`npx infinite-tag\` to start a fresh run.`, closed: true }
  }
  await deps.fs.mkdirp(join(input.root, WIZARD_PATHS.dir), 0o700)
  await deps.fs.writeTextAtomic(join(input.root, WIZARD_PATHS.prBody), input.body, 0o600)
  try {
    const created = await deps.host.createDraftPr({ base: input.base, head: input.headOwner ? `${input.headOwner}:${input.branch}` : input.branch, title: input.title, bodyFile: WIZARD_PATHS.prBody })
    if (isUnsupported(created)) return { kind: "link", url: null, why: "not_github" }
    return { kind: "pr", pr: created, adopted: false, draftFallback: !created.isDraft }
  } catch (error) {
    return { kind: "failed", message: `Opening the pull request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** A failed outcome for the O4 steps. */
export function failed(code: Extract<StepOutcome, { kind: "failed" }>["code"], message: string, next: "halt" | "continue" = "halt"): StepOutcome {
  return { kind: "failed", code, message, next }
}
