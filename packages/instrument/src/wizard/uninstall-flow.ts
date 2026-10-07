// `npx infinite-tag uninstall --pr` (`runWizardUninstall`): reverse everything the install did, as a pull
// request the user merges, then (after the merge, by default) the cloud pieces.
//
// Order (README §4 "uninstall opens a PR and revokes"; R1-17, R2-31):
// 1. The same clean-tree check as `before`; then the uninstall branch is created FIRST (from
//    `origin/<base>`), so no edit ever lands on the user's checked-out branch.
// 2. `installer.uninstall()` on that branch (it reverses every recorded edit, newest first, only where the
//    file still has the recorded hash); commit; push; draft PR through the git host.
// 3. One ask per cloud piece (revoke the link, remove the server-lane env, disable the site source). Each ask
//    states the consequence and offers "after the merge" as the default: removing them NOW stops
//    collection while the old code is still live. A later `uninstall --pr` that sees the uninstall PR
//    merged and deployed runs the deferred pieces, and retries a piece that failed. A declined (or
//    unanswered) piece is left untouched. The link is revoked LAST, only once every other piece is
//    finished (it is what lets the others run). With no saved link (a fresh clone, a teammate's machine)
//    the flow links first; if it cannot, it says the pieces are not reachable from here — never "nothing
//    to change".
// 4. One line per piece with its state. When nothing is left to do, `.infinite/wizard/` is cleared (the
//    uninstall PR removes its .gitignore line, so it would otherwise show up as untracked files).
import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import { join } from "node:path"

import { ASK_CANCELLED, ASK_TIMEOUT } from "./contracts/asks.js"
import { WIZARD_EXIT, exitCodeFor, type WizardCode } from "./contracts/codes.js"
import type { AskFn, WizardDeps } from "./contracts/deps.js"
import { WIZARD_PATHS, type WizardRunState } from "./contracts/state.js"
import { guardBridge } from "./engine.js"
import { buildScanner } from "../review/context.js"
import { safeText } from "../review/post.js"
import { mergeIsDeployed } from "./steps/prove.js"
import { HARNESS_OUTPUTS_RELATIVE_PATH } from "../harness/outputs.js"
import { canPush } from "../github/repo.js"
import type { WizardGitOps } from "./contracts/git-host.js"
import { forkTargetMatches } from "./push-target.js"
import { readOriginHead } from "./steps/before.js"
import { measureOwnerDiff, measureWizardCommits, unrecordedCommits, ownerBoundaryStop, type OwnerBoundaryMeasurement } from "../jobs/owner-diff.js"
import { gitlabMergeRequestPushOptions } from "../git/push.js"

export const UNINSTALL_RECORD_SCHEMA = "infinite-tag.wizard-uninstall.v1" as const
export const UNINSTALL_RECORD_PATH = `${WIZARD_PATHS.dir}/uninstall.json`
export const UNINSTALL_PR_BODY_PATH = `${WIZARD_PATHS.dir}/uninstall-pr-body.md`
export const UNINSTALL_PR_TITLE = "Remove Infinite analytics (infinite-tag uninstall)"
export const UNINSTALL_COMMIT_MESSAGE = "infinite-tag: remove the analytics install"

export const UNINSTALL_PIECES = ["server_lane_env", "site_source", "link"] as const
export type UninstallPiece = (typeof UNINSTALL_PIECES)[number]

/**
 * A piece's state: `after_merge` = deferred to the run that sees the uninstall merged and deployed;
 * `no_link` = this machine has no link to Infinite, so the piece could not be asked or changed;
 * `unsupported` = this Infinite app has no verb for it; `failed` = tried and retried on the next run.
 */
export type PieceState = "after_merge" | "done" | "kept" | "no_link" | "unsupported" | "failed"

/** Pieces a later `uninstall --pr` still has to do. */
const PENDING_STATES: ReadonlySet<PieceState> = new Set(["after_merge", "failed", "no_link"])

export const PIECE_COPY: Record<UninstallPiece, { label: string; question: string }> = {
  server_lane_env: {
    label: "Server-lane settings on Vercel",
    question:
      "Remove the server-lane settings from Vercel? Removing them now stops server-side collection while the old code is still live; after the merge is the safe default."
  },
  site_source: {
    label: "The site in Infinite",
    question:
      "Turn this site off in Infinite? Turning it off now stops collection while the old code is still live; after the merge is the safe default."
  },
  link: {
    label: "The link to Infinite",
    question:
      "Remove this site's link to Infinite? Removing it now means the deferred pieces cannot run after the merge; after the merge is the safe default."
  }
}

export interface UninstallRecord {
  schema: typeof UNINSTALL_RECORD_SCHEMA
  createdAt: string
  base: string
  branch: string
  pr: { number: number; url: string } | null
  linkId: string | null
  pieces: Record<UninstallPiece, PieceState>
  wizardCommits?: string[]
  approvedForeignCommits?: string[]
  ownerBoundary?: OwnerBoundaryMeasurement
  lastPush?: { sha: string; at: string }
}

/** The link step, run for an uninstall that has no saved link (a fresh clone, a teammate's machine). */
export type UninstallLinkFn = () => Promise<{ linkId: string } | { linkId: null; code: WizardCode | null; message: string }>

export interface UninstallContext {
  root: string
  /** Links this machine when no link is saved; absent = cannot link from here. */
  link?: UninstallLinkFn
  /** The run state (for the link, the base and the run id), or null when there is none. */
  state: Readonly<WizardRunState> | null
  /** `askUserOnly`: never `--yes`, never an answers file in nested mode. */
  ask: AskFn
  print(line: string): void
  now(): Date
  /** `--base <branch>`. */
  base: string | null
}

export interface UninstallResult {
  exitCode: number
  code: WizardCode | null
  record: UninstallRecord | null
  lines: string[]
}

async function readRecord(root: string): Promise<UninstallRecord | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(join(root, UNINSTALL_RECORD_PATH), "utf8")) as UninstallRecord
    return parsed.schema === UNINSTALL_RECORD_SCHEMA ? parsed : null
  } catch {
    return null
  }
}

async function writeRecord(deps: WizardDeps, root: string, record: UninstallRecord): Promise<void> {
  await deps.fs.writeTextAtomic(join(root, UNINSTALL_RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`, 0o600)
}

function stop(code: WizardCode, message: string, lines: string[], record: UninstallRecord | null = null): UninstallResult {
  lines.push(message)
  return { exitCode: exitCodeFor(code), code, record, lines }
}

const PIECE_WORDS: Record<PieceState, string> = {
  after_merge: "after the merge (run npx infinite-tag uninstall --pr again once it is merged and deployed)",
  done: "done",
  kept: "kept (unchanged)",
  no_link: "NOT changed: this machine is not linked to Infinite (open Infinite, then run npx infinite-tag uninstall --pr again)",
  unsupported: "not changed from here (this Infinite app cannot do it; turn it off in Infinite)",
  failed: "failed, unchanged (run npx infinite-tag uninstall --pr again to retry; see above)"
}

function pieceLines(record: UninstallRecord): string[] {
  return UNINSTALL_PIECES.map((piece) => `${PIECE_COPY[piece].label}: ${PIECE_WORDS[record.pieces[piece]]}`)
}

async function runPiece(deps: WizardDeps, piece: UninstallPiece, linkId: string, lines: string[]): Promise<PieceState> {
  try {
    if (piece === "server_lane_env") {
      const removed = await deps.bridge.removeServerLaneEnv()
      lines.push(`Removed from Vercel: ${removed.removed.join(", ") || "nothing was set"}`)
    } else if (piece === "site_source") {
      await deps.bridge.disableSiteSource()
    } else {
      await deps.bridge.revokeLink(linkId)
    }
    return "done"
  } catch (error) {
    lines.push(`${PIECE_COPY[piece].label}: ${error instanceof Error ? error.message : String(error)}`)
    return "failed"
  }
}

/**
 * Runs the due pieces in a safe order: env, then the site source, then the link. The link scopes every
 * other verb, so it is revoked only when no other piece is still pending (deferred, failed or unlinked);
 * otherwise it waits for the run that finishes them.
 */
async function runPieces(deps: WizardDeps, record: UninstallRecord, due: ReadonlySet<UninstallPiece>, lines: string[]): Promise<void> {
  if (!record.linkId || due.size === 0) return
  deps.bridge.setLinkId(record.linkId)
  for (const piece of UNINSTALL_PIECES) {
    if (!due.has(piece)) continue
    if (piece === "link") {
      const waiting = UNINSTALL_PIECES.filter((other) => other !== "link" && PENDING_STATES.has(record.pieces[other]))
      if (waiting.length > 0) {
        record.pieces.link = "after_merge"
        lines.push(`${PIECE_COPY.link.label}: kept until ${waiting.map((other) => PIECE_COPY[other].label.toLowerCase()).join(" and ")} ${waiting.length === 1 ? "is" : "are"} done (it is what lets them run).`)
        continue
      }
    }
    record.pieces[piece] = await runPiece(deps, piece, record.linkId, lines)
  }
}

function supportedPieces(deps: WizardDeps): Set<UninstallPiece> {
  const out = new Set<UninstallPiece>()
  if (deps.bridge.has("tag.uninstall.v1")) {
    out.add("server_lane_env")
    out.add("site_source")
  }
  if (deps.bridge.has("tag.link.v1")) out.add("link")
  return out
}

/** One ask per piece; returns the pieces to run now (the rest are recorded as deferred or kept). */
async function askPieces(ctx: UninstallContext, record: UninstallRecord, pieces: readonly UninstallPiece[], lines: string[]): Promise<Set<UninstallPiece>> {
  const now = new Set<UninstallPiece>()
  for (const piece of pieces) {
    const answer = await ctx.ask("single", {
      question: PIECE_COPY[piece].question,
      options: [
        { label: "After the merge (recommended)", value: "after_merge" },
        { label: "Now", value: "now" },
        { label: "Keep it", value: "keep" }
      ],
      default: "after_merge"
    })
    if (answer === "now") now.add(piece)
    else if (answer === "after_merge") record.pieces[piece] = "after_merge"
    else record.pieces[piece] = "kept"
    if (answer === ASK_TIMEOUT || answer === ASK_CANCELLED) lines.push(`${PIECE_COPY[piece].label}: not answered, so it was left as it is.`)
  }
  return now
}

/** Links this machine when no link is saved. Null link = the pieces stay `no_link` (with the reason). */
async function ensureLink(ctx: UninstallContext, record: UninstallRecord, lines: string[]): Promise<{ ok: true } | { ok: false; code: WizardCode | null }> {
  if (record.linkId) return { ok: true }
  if (!ctx.link) {
    lines.push("This machine has no saved link to Infinite, so the pieces in Infinite cannot be changed from here.")
    return { ok: false, code: null }
  }
  const linked = await ctx.link()
  if (linked.linkId === null) {
    lines.push(`Could not link this machine to Infinite: ${linked.message}`)
    return { ok: false, code: linked.code }
  }
  record.linkId = linked.linkId
  return { ok: true }
}

/** Removes the wizard's run files (never the lock this run holds) once nothing is left to do. */
async function clearWizardRunFiles(root: string): Promise<void> {
  const dir = join(root, WIZARD_PATHS.dir)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (`${WIZARD_PATHS.dir}/${name}` === WIZARD_PATHS.lock) continue
    await fsp.rm(join(dir, name), { recursive: true, force: true })
  }
}

/** Saves the record, or clears the run files when no piece is pending any more. */
async function settle(deps: WizardDeps, root: string, record: UninstallRecord, lines: string[]): Promise<void> {
  if (UNINSTALL_PIECES.some((piece) => PENDING_STATES.has(record.pieces[piece]))) {
    await writeRecord(deps, root, record)
    return
  }
  await clearWizardRunFiles(root)
  lines.push("Nothing is left to do: the wizard's run files in .infinite/wizard/ were removed.")
}

async function resolveBase(ctx: UninstallContext, deps: WizardDeps): Promise<string | null> {
  if (ctx.base) return ctx.base
  if (ctx.state?.git?.base) return ctx.state.git.base
  if (ctx.state?.link && deps.bridge.has("tag.hosting.v1")) {
    deps.bridge.setLinkId(ctx.state.link.linkId)
    const hosting = await deps.bridge.hosting().catch(() => null)
    if (hosting?.vercel?.productionBranch) return hosting.vercel.productionBranch
  }
  const facts = await deps.host.repoFacts().catch(() => null)
  if (facts && !("unsupported" in facts) && facts.defaultBranch) return facts.defaultBranch
  return readOriginHead(deps, ctx.root)
}

/**
 * The follow-up run: link first when the first run could not; then the deferred pieces (and the ones
 * that failed) run once the uninstall PR is merged and deployed.
 */
async function followUp(ctx: UninstallContext, deps: WizardDeps, record: UninstallRecord, lines: string[]): Promise<UninstallResult> {
  const unlinked = UNINSTALL_PIECES.filter((piece) => record.pieces[piece] === "no_link")
  if (unlinked.length > 0) {
    const linked = await ensureLink(ctx, record, lines)
    if (!linked.ok) {
      await writeRecord(deps, ctx.root, record)
      return { exitCode: linked.code ? exitCodeFor(linked.code) : WIZARD_EXIT.needsApp, code: linked.code, record, lines: [...lines, ...pieceLines(record)] }
    }
    const supported = supportedPieces(deps)
    for (const piece of unlinked) if (!supported.has(piece)) record.pieces[piece] = "unsupported"
    const now = await askPieces(ctx, record, unlinked.filter((piece) => supported.has(piece)), lines)
    await runPieces(deps, record, now, lines)
  }
  const deferred = new Set(UNINSTALL_PIECES.filter((piece) => record.pieces[piece] === "after_merge" || record.pieces[piece] === "failed"))
  if (deferred.size === 0) {
    await settle(deps, ctx.root, record, lines)
    return { exitCode: WIZARD_EXIT.done, code: null, record, lines: [...lines, ...pieceLines(record)] }
  }
  if (!record.pr) {
    return stop("INF_WIZ_MERGE_PARKED", `The uninstall branch ${record.branch} has no pull request here; merge it, then run this again.`, [...lines, ...pieceLines(record)], record)
  }
  const pr = await deps.host.readPr(record.pr.number)
  if ("unsupported" in pr) {
    return stop("INF_WIZ_MERGE_PARKED", "This git host cannot be read; run this again after the merge is deployed.", [...lines, ...pieceLines(record)], record)
  }
  if (pr.state === "CLOSED") {
    for (const piece of deferred) record.pieces[piece] = "kept"
    await settle(deps, ctx.root, record, lines)
    lines.push(`The uninstall pull request #${pr.number} was closed without merging; the deferred pieces were left as they are.`)
    return { exitCode: WIZARD_EXIT.done, code: null, record, lines: [...lines, ...pieceLines(record)] }
  }
  if (pr.state !== "MERGED" || !pr.mergeCommitOid) {
    return stop("INF_WIZ_MERGE_PARKED", `Waiting for you to merge the uninstall pull request #${pr.number} (${record.pr.url}).`, [...lines, ...pieceLines(record)], record)
  }
  if (record.linkId) deps.bridge.setLinkId(record.linkId)
  const deployed = record.linkId && deps.bridge.has("tag.hosting.v1") ? await mergeIsDeployed(deps, pr.mergeCommitOid, record.base) : { deployed: false as const }
  if (!deployed.deployed) {
    return stop("INF_WIZ_DEPLOY_TIMEOUT", `The uninstall is merged; waiting for its deploy before changing anything in Infinite.`, [...lines, ...pieceLines(record)], record)
  }
  await runPieces(deps, record, deferred, lines)
  await settle(deps, ctx.root, record, lines)
  return { exitCode: WIZARD_EXIT.done, code: null, record, lines: [...lines, ...pieceLines(record)] }
}

export async function runUninstallFlow(ctx: UninstallContext, rawDeps: WizardDeps): Promise<UninstallResult> {
  const deps: WizardDeps = { ...rawDeps, bridge: guardBridge(rawDeps.bridge, rawDeps.agents) }
  const lines: string[] = []

  const existing = await readRecord(ctx.root)
  // The commit record is saved before the boundary check and push. An interrupted/refused
  // publication is not a completed uninstall whose cloud cleanup can be resumed.
  if (existing?.wizardCommits?.length && !existing.lastPush) {
    return stop("INF_WIZ_PUSH_REFUSED", `The uninstall is paused: recorded commit${existing.wizardCommits.length === 1 ? "" : "s"} ${existing.wizardCommits.join(", ")} on branch ${existing.branch} ${existing.wizardCommits.length === 1 ? "has" : "have"} no confirmed measured push. Cloud settings and links were left alone. Review this branch and complete the uninstall explicitly.`, lines, existing)
  }
  if (existing && UNINSTALL_PIECES.some((piece) => PENDING_STATES.has(existing.pieces[piece]))) {
    return followUp(ctx, deps, existing, lines)
  }

  // 1. Clean tree, then the branch FIRST.
  if (!(await deps.git.isRepo())) return stop("INF_WIZ_NO_GIT", "This folder is not a git repository.", lines)
  const tree = await deps.git.cleanTree()
  // The wizard's own bookkeeping never blocks its uninstall: the run directory, and `.infinite/harness.json`
  // (the fence's record, written after `before` and never committed, §3z.12; I1b found that a finished run
  // left it untracked, so `uninstall --pr` refused every completed install).
  const dirty = tree.dirtyPaths.filter((path) => !path.startsWith(`${WIZARD_PATHS.dir}/`) && path !== HARNESS_OUTPUTS_RELATIVE_PATH)
  if (!tree.clean && dirty.length > 0) {
    return stop("INF_WIZ_DIRTY_TREE", `Commit or stash your changes first (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}).`, lines)
  }
  let headOwner: string | null = null
  if (deps.host.kind === "github") {
    const git = deps.git as Partial<WizardGitOps>
    const saved = ctx.state?.pushTarget
    if (saved?.kind === "fork") {
      if (!forkTargetMatches(saved)) return stop("INF_WIZ_PUSH_REFUSED", "The saved uninstall fork destination is invalid.", lines)
      if (!git.setPushRemote) return stop("INF_WIZ_PUSH_REFUSED", "The approved fork destination cannot be restored for uninstall.", lines)
      git.setPushRemote(saved.remoteUrl)
      headOwner = saved.headOwner
    } else {
      const facts = await deps.host.repoFacts().catch(() => null)
      if (!facts || "unsupported" in facts || facts.viewerPermission === null) lines.push("GitHub push access could not be checked early; the push will confirm it.")
      if (facts && !("unsupported" in facts) && facts.viewerPermission !== null && !canPush(facts.viewerPermission)) {
        if (facts.allowForking !== true || !deps.host.createFork || !git.setPushRemote) return stop("INF_WIZ_PUSH_REFUSED", "This repo cannot be pushed or forked by your account. Ask its owner for write access or fork permission.", lines)
        const approved = await ctx.ask("confirm", { question: "Create your fork and open the uninstall pull request from it?", defaultYes: false })
        if (approved !== true) return stop("INF_WIZ_PUSH_REFUSED", "The fork pull request was not approved.", lines)
        const origin = await deps.git.remoteUrl()
        try {
          const fork = await deps.host.createFork(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/.test(origin ?? ""))
          git.setPushRemote(fork.remoteUrl)
          headOwner = fork.headOwner
        } catch (error) {
          return stop("INF_WIZ_PUSH_REFUSED", `GitHub could not create the uninstall fork: ${error instanceof Error ? error.message : String(error)}`, lines)
        }
      }
    }
  }
  const base = await resolveBase(ctx, deps)
  if (!base) return stop("INF_WIZ_BRANCH_FAILED", "Cannot tell which branch ships to production; run again with --base <branch>.", lines)
  const day = ctx.now().toISOString().slice(0, 10)
  const branch = `infinite/tag/uninstall-${day}-${randomBytes(3).toString("hex")}`
  let baseSha: string
  try {
    baseSha = (await deps.git.createBranch(base, branch)).baseSha
  } catch (error) {
    return stop("INF_WIZ_BRANCH_FAILED", `Could not create ${branch} from origin/${base}: ${error instanceof Error ? error.message : String(error)}`, lines)
  }
  lines.push(`Branch ${branch} (from origin/${base})`)
  const record: UninstallRecord = {
    schema: UNINSTALL_RECORD_SCHEMA, createdAt: ctx.now().toISOString(), base, branch, pr: null,
    linkId: ctx.state?.link?.linkId ?? null, pieces: { server_lane_env: "no_link", site_source: "no_link", link: "no_link" },
    wizardCommits: [], approvedForeignCommits: []
  }

  // 2. Reverse the install on that branch; commit; push; PR.
  const reversal = await deps.installer.uninstall({ root: ctx.root, dryRun: false })
  for (const file of reversal.leftAsIs) lines.push(`Changed since the install, left as is: ${file}`)
  let pr: UninstallRecord["pr"] = null
  if (reversal.reversed.length === 0) {
    lines.push("Nothing in the code to reverse.")
  } else {
    const working = await measureOwnerDiff({ root: ctx.root, appRoot: ctx.state?.appRoot ?? ".", baseSha: await deps.git.head() })
    if (working.state !== "checked") return stop("INF_WIZ_PUSH_REFUSED", ownerBoundaryStop(working), lines)
    await deps.git.stage([...new Set([...reversal.reversed, WIZARD_PATHS.installManifest])])
    const runId = ctx.state?.runId ?? null
    const committed = await deps.git.commit({ message: UNINSTALL_COMMIT_MESSAGE, trailers: runId ? { "Infinite-Tag-Run": runId } : {} })
    record.wizardCommits!.push(committed.sha)
    await writeRecord(deps, ctx.root, record)
    const head = await deps.git.head()
    const scanner = buildScanner({ root: ctx.root, appRoot: ctx.state?.appRoot ?? "." }, deps, [])
    record.ownerBoundary = await measureWizardCommits({ root: ctx.root, appRoot: ctx.state?.appRoot ?? ".", baseSha, headSha: head, wizardCommits: record.wizardCommits! })
    await writeRecord(deps, ctx.root, record)
    if (record.ownerBoundary.state !== "checked") return stop("INF_WIZ_PUSH_REFUSED", ownerBoundaryStop(record.ownerBoundary), lines, record)
    const foreign = await unrecordedCommits({ root: ctx.root, baseSha, headSha: head, wizardCommits: record.wizardCommits!, approvedForeignCommits: [] })
    if (foreign === null) return stop("INF_WIZ_PUSH_REFUSED", "Nothing pushed: unrecorded uninstall-branch commits could not be listed.", lines, record)
    if (foreign.length) {
      const list = foreign.map(commit => `${commit.sha.slice(0, 12)} ${scanner.redact(commit.subject).text}`).join("\n")
      if (await ctx.ask("confirm", { question: `These commits are not in the uninstall's own commit record:\n${list}\nPush these owner commits too?`, defaultYes: false }) !== true) return stop("INF_WIZ_PUSH_REFUSED", "The additional commits were not approved for push.", lines, record)
      if (await deps.git.head() !== head) return stop("INF_WIZ_PUSH_REFUSED", "The branch changed while approving the push. Nothing pushed.", lines, record)
      record.approvedForeignCommits = foreign.map(commit => commit.sha)
      await writeRecord(deps, ctx.root, record)
    }
    try {
      const pushGit = deps.git as Partial<WizardGitOps>
      if (deps.host.kind === "gitlab" && pushGit.pushWithOptions) {
        try { await pushGit.pushWithOptions(branch, gitlabMergeRequestPushOptions(base, UNINSTALL_PR_TITLE), head) }
        catch { await deps.git.push(branch, head) }
      } else await deps.git.push(branch, head)
      record.lastPush = { sha: head, at: ctx.now().toISOString() }
      await writeRecord(deps, ctx.root, record)
    } catch (error) {
      return stop("INF_WIZ_PUSH_REFUSED", `Push refused: ${error instanceof Error ? error.message : String(error)}`, lines, record)
    }
    const body = [
      "This pull request removes the analytics install infinite-tag added, file by file.",
      "",
      ...reversal.reversed.map((file) => `Reversed: ${file}`),
      ...reversal.leftAsIs.map((file) => `Left as is (changed since the install): ${file}`),
      "",
      "Infinite's settings for this site stay as they are until this is merged and deployed."
    ].join("\n")
    // B29: the uninstall PR body passes the same §3g.5 secret scan as every other posted string.
    await deps.fs.writeTextAtomic(join(ctx.root, UNINSTALL_PR_BODY_PATH), `${safeText(scanner, body)}\n`, 0o600)
    try {
      const created = await deps.host.createDraftPr({ base, head: headOwner ? `${headOwner}:${branch}` : branch, title: UNINSTALL_PR_TITLE, bodyFile: join(ctx.root, UNINSTALL_PR_BODY_PATH) })
      if ("unsupported" in created) lines.push(`Pushed ${branch}; open a merge request for it on your git host.`)
      else {
        pr = { number: created.number, url: created.url }
        lines.push(`Pull request #${created.number}: ${created.url}`)
      }
    } catch (error) {
      return stop("INF_WIZ_PR_CREATE_FAILED", `Could not open the pull request: ${error instanceof Error ? error.message : String(error)}`, lines)
    }
  }

  // 3. The cloud pieces, one ask each; "after the merge" is the default. No saved link → link first.
  record.pr = pr
  const linked = await ensureLink(ctx, record, lines)
  if (!linked.ok) {
    await writeRecord(deps, ctx.root, record)
    return { exitCode: linked.code ? exitCodeFor(linked.code) : WIZARD_EXIT.needsApp, code: linked.code, record, lines: [...lines, ...pieceLines(record)] }
  }
  const supported = supportedPieces(deps)
  for (const piece of UNINSTALL_PIECES) if (!supported.has(piece)) record.pieces[piece] = "unsupported"
  const now = await askPieces(ctx, record, UNINSTALL_PIECES.filter((piece) => supported.has(piece)), lines)
  await runPieces(deps, record, now, lines)
  if (!pr && reversal.reversed.length > 0) {
    // No PR to watch: a deferred piece could never run, so say so instead of waiting forever.
    for (const piece of UNINSTALL_PIECES) if (record.pieces[piece] === "after_merge") lines.push(`${PIECE_COPY[piece].label}: run this again after you merge ${branch}.`)
  }
  await settle(deps, ctx.root, record, lines)
  return { exitCode: WIZARD_EXIT.done, code: null, record, lines: [...lines, ...pieceLines(record)] }
}
