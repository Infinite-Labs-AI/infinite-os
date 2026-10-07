import { branchUpdateCommits } from "../../github/update-branch.js"
import { reviewReliabilityWarning } from "../../review/integrity.js"
import { safeDisplayText } from "../../review/display.js"
// Step 9 `review` (§3d.1, §3g.4, lane O4): the OTHER agent reviews the PR read-only in a detached worktree of
// the head → the wizard scans the review and posts it as ONE `event: COMMENT` review → reads the threads back
// under the trust rules → triages (FIX / DECLINE / ANSWER / ASK) → fixes through the worker (job 16, ≤ 2 rounds)
// → commits, pushes, proves the new head descends from the old → replies on its own threads (and on a
// teammate's only with the user's OK) → resolves only its own fixed threads → re-rehearses → `gh pr ready` + the
// final comment. With one agent it writes and prints the review brief instead.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentKind, AgentRunResult, ReviewFailure, ReviewResult } from "../contracts/agents.js"
import { AGENT_LIMITS, REVIEW_ITEMS } from "../contracts/agents.js"
import { agentStatusLine } from "../agent-status.js"
import { runExtras } from "../../agents/runner.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { PR_LOOP_LIMITS, PR_MARKERS } from "../contracts/git-host.js"
import type { CheckResult } from "../contracts/jobs.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { verdictFactsFor } from "../verdict-facts.js"
import { isGloballyDenied } from "../../git/commit.js"
import { commentEditor, isGitHubAdapter, type GitHubHostAdapter } from "../../hosts/github.js"
import { isUnsupported } from "../../hosts/other.js"
import { classifyReview, isReviewResult, parseBriefReview, printedReviewBrief, reviewerBrief, type ClassifiedReview } from "../../review/brief.js"
import { allowlistUnion, assertNoAgentAlive, bestEffortBridge, bridgeStop, manifestFiles, status, sub } from "../../review/context.js"
import { parseUnifiedDiff } from "../../review/diff.js"
import { ciFixItem, job16Item, restoreFiles, runFixRound, snapshotFiles, verifyFix } from "../../review/fix.js"
import { openFindings, parseLedger, recordDecisions, REVIEW_LEDGER_PATH, type ReviewLedger } from "../../review/ledger.js"
import { wizardOwnership, type WizardOwnership } from "../../review/ownership.js"
import { commentTrust, hasFinalMarker, hasReplyMarker, parseReviewMarker, stripMarkers } from "../../review/markers.js"
import { AGENT_LABEL, buildFinalComment, buildReply, buildReviewPost, excerpt, FIX_ROUND_MINUTES, notFixedReply, redactIdsNotInDiff, safeText, type FixReplyState, type NotFixedOutcome } from "../../review/post.js"
import { applyRehearsalToJobs, recordRehearsalCells, rehearse } from "../../review/rehearse.js"
import { mergeRequirementLine } from "../../github/rules.js"
import { checksSummary, checkPolicy, commitChecks, headCheckActivity, headPrWorkflows, withDeploymentStates, checkRunsOnPr, type PrCheck } from "../../github/checks.js"
import { DETERMINISTIC_CHECKS_BY_ITEM, fileRoleOf, isRepoRelativePath, leftByOwnerReason, pageHelperCalls, triage, triageKey, type FileRole, type PageHelperCall, type TriageDecision, type TriageItem } from "../../review/triage.js"
import { escapeRegExp } from "../../text-escape.js"
import { stageAndCommit, failed, pushBranch } from "../../review/ship.js"
import { provenPendingFor } from "./prove.js"
import { announceRehearsal, commitStop, isShipContext, prepareShip, recordClickTests, testPageUrls, type ShipContext } from "./rehearsal.js"

const meta = WIZARD_STEP_META.review
const REVIEW_INPUT_DIR = ".infinite/review"
/** §3y.7: the read-check nonce the reviewer must quote (16 random hex; never posted). */
export const READ_CHECK_PATH = `${REVIEW_INPUT_DIR}/read-check.txt`
export const BLIND_RETRY_NOTE = "Your last answer shows you could not read the files. Read them now with the read-only commands named above, then answer."
const HEAD_SYNC_ATTEMPTS = 5
const HEAD_SYNC_SLEEP_MS = 3_000

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

interface Session {
  ctx: WizardContext
  deps: WizardDeps
  ship: ShipContext
  github: GitHubHostAdapter | null
  number: number | null
  login: string | null
  ledger: ReviewLedger
  decisions: TriageDecision[]
  /** Comments from people outside the repo, keyed `<threadId>#<index>` so each is listed once across rounds. */
  untrusted: Array<{ key: string; author: string; path: string | null; excerpt: string }>
  notes: string[]
  reviewed: boolean
  reviewer: AgentKind | "brief" | null
  ciRepairAttempted?: boolean
  /** §3x.3 Whose code a finding is on (Infinite's runtime, the wizard's own change), and the wizard's own files. */
  ownership?: WizardOwnership
}

async function saveLedger(session: Session): Promise<void> {
  const path = join(session.ctx.root, REVIEW_LEDGER_PATH)
  // §3x.3 The findings that still stand, from the ONE definition (`openFindings`), on every save.
  session.ledger.openFindings = openFindings(session.ledger, session.ctx.state.get().jobs, session.ownership?.classify, session.ownership?.writtenByRun)
  await session.deps.fs.mkdirp(join(session.ctx.root, WIZARD_PATHS.dir), 0o700)
  await session.deps.fs.writeTextAtomic(path, `${JSON.stringify(session.ledger, null, 2)}\n`, 0o600)
}

/** The review inputs, written into the reviewer's own detached worktree (never into the user's repo). */
async function writeReviewInputs(session: Session, dir: string, diff: string): Promise<{ diff: string; plan: string; checks: string }> {
  const { deps, ctx } = session
  const state = ctx.state.get()
  const keys = session.ship.facts.keys
  const inputDir = join(dir, REVIEW_INPUT_DIR)
  await deps.fs.mkdirp(inputDir, 0o700)
  const ownership = await sessionOwnership(session)
  const plan = {
    approvedPlanLines: (state.plan?.lines ?? []).filter((line) => line.approved === true).map((line) => line.id),
    allowlist: allowlistUnion(state.jobs),
    // §3x.3 R1: the wizard's own files (Infinite's managed code, its proof file, .gitignore's Infinite block,
    // .infinite/install.json) are in scope too; run 3's reviewer flagged the wizard's own next.config.mjs (F1).
    wizardFiles: ownership.wizardFiles,
    connectedIds: keys
      ? {
          ga4: keys.ga4.streams.map((stream) => stream.measurementId),
          posthog: keys.posthog.projectKey,
          meta: keys.meta.pixels.map((pixel) => pixel.pixelId),
          infinite: keys.infinite.siteSourceKey
        }
      : null,
    consentMode: state.plan?.answers.consentMode ?? null,
    approvedConversions: state.plan?.answers.conversions ?? []
  }
  const checks = {
    jobs: state.jobs.map((job) => ({ id: job.id, title: job.title, state: job.state, checks: job.checks.map((check) => ({ id: check.id, tier: check.tier, state: check.state })) })),
    inPr: state.report.in_pr ? Object.fromEntries(Object.entries(state.report.in_pr.finishLine).map(([id, cell]) => [id, cell?.state ?? null])) : null
  }
  const names = { diff: `${REVIEW_INPUT_DIR}/diff.patch`, plan: `${REVIEW_INPUT_DIR}/plan.json`, checks: `${REVIEW_INPUT_DIR}/checks.json` }
  await deps.fs.writeTextAtomic(join(dir, names.diff), await stubManagedDiff(session, dir, diff), 0o600)
  await deps.fs.writeTextAtomic(join(dir, names.plan), `${JSON.stringify(plan, null, 2)}\n`, 0o600)
  await deps.fs.writeTextAtomic(join(dir, names.checks), `${JSON.stringify(checks, null, 2)}\n`, 0o600)
  return names
}

/** §3x.3 The run's ownership facts (read once per session from the install receipt and the PR's base commit). */
async function sessionOwnership(session: Session): Promise<WizardOwnership> {
  if (!session.ownership) {
    const base = session.ctx.state.get().git?.baseSha ?? null
    session.ownership = await wizardOwnership(session.deps, session.ctx.root, async (path) => {
      if (base === null) return null
      try {
        return (await session.ship.git.showFile(base, path)) !== null
      } catch {
        return null
      }
    })
  }
  return session.ownership
}

/**
 * LF4-P1-3: what triage needs to route a finding by what it asks to change and where, read from the code at the head:
 * each finding's file (its role, the names it already uses, its calls of the runtime's exported helpers) and the names
 * only Infinite's runtime defines.
 */
async function triageRouting(
  session: Session,
  items: readonly TriageItem[],
  ownership: WizardOwnership
): Promise<{
  internalsIn: (text: string, path: string | null) => string[]
  fileRole: (path: string) => FileRole | null
  pageHelperCallsIn: (path: string) => PageHelperCall[]
}> {
  const texts = new Map<string, string | null>()
  for (const item of items) {
    if (item.path === null || !isRepoRelativePath(item.path) || texts.has(item.path)) continue
    texts.set(item.path, await session.deps.fs.readText(join(session.ctx.root, item.path)))
  }
  const internals = [...ownership.runtimeInternals].map((name) => ({ name, pattern: new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`) }))
  return {
    internalsIn(text, path) {
      // A name the finding's own (customer) file also uses is that file's to change, never only Infinite's.
      const own = path === null ? null : (texts.get(path) ?? null)
      return internals.filter(({ name, pattern }) => pattern.test(text) && !(own !== null && pattern.test(own))).map(({ name }) => name)
    },
    fileRole(path) {
      const text = texts.get(path)
      return text === undefined || text === null ? null : fileRoleOf(path, text)
    },
    pageHelperCallsIn(path) {
      const text = texts.get(path)
      return text === undefined || text === null ? [] : pageHelperCalls(text, ownership.runtimeExports)
    }
  }
}

/**
 * §3x.3 (D3) The reviewer reads the CUSTOMER's change, not Infinite's runtime: each Infinite-owned file's hunks in
 * `diff.patch` become a stub (its path, the tag version, its sha256 and the per-site values it carries). Run 3's
 * diff was 87% one 31,040-character line of Infinite's runtime. R14 still sees the file in `install.json`.
 */
async function stubManagedDiff(session: Session, worktree: string, diff: string): Promise<string> {
  const ownership = await sessionOwnership(session)
  const keys = session.ship.facts.keys
  const site = keys?.infinite
  const masked = site?.siteSourceKey ? `${site.siteSourceKey.slice(0, 9)}…${site.siteSourceKey.slice(-4)}` : "none"
  const sections = diff.split(/(?=^diff --git )/m)
  return sections
    .map((section) => {
      const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(section)
      const path = header?.[2]
      if (!path || ownership.classify(path, null) !== "Infinite's own code") return section
      const hunk = section.search(/^@@ /m)
      const head = hunk < 0 ? section : section.slice(0, hunk)
      return `${head}@@ -0,0 +1,3 @@\n${managedStubLines(session, worktree, path, masked, site).join("\n")}\n`
    })
    .join("")
}

function managedStubLines(
  session: Session,
  worktree: string,
  path: string,
  maskedKey: string,
  site: { productionHosts: readonly string[]; consentMode: string | null; collectPath: string | null } | undefined
): string[] {
  let digest = "unreadable"
  try {
    digest = createHash("sha256").update(readFileSync(join(worktree, path))).digest("hex")
  } catch {
    // the stub still names the file; the reviewer is told the bytes are not shown
  }
  return [
    `+// [infinite-tag managed file ${path}: infinite-tag ${session.deps.tagVersion}, sha256 ${digest}]`,
    "+// Infinite's own runtime, reviewed in infinite-os; its bytes are not shown here.",
    `+// Per-site values: siteSourceKey ${maskedKey}, hosts ${(site?.productionHosts ?? []).join(", ") || "none"}, consentMode ${site?.consentMode ?? "unknown"}, collectPath ${site?.collectPath ?? "none"}`
  ]
}

/** What one reviewer run gave: a classified review, a blind one (after its one retry), or a failure. */
export type ReviewerRun = { review: ReviewResult; classified: ClassifiedReview } | { blind: true } | ReviewFailure

/**
 * Runs the reviewer agent on `head`: one retry when its JSON does not parse, and (§3y.7) one retry with a fresh
 * session when the review is BLIND (the read-check nonce missing or wrong, or every item `cant_tell`).
 */
async function runReviewer(session: Session, reviewer: AgentKind, round: number, head: string, fromSha: string, openItems: string[]): Promise<ReviewerRun> {
  const { ship, deps, ctx } = session
  const worktree = await ship.git.worktreeAddDetached(head)
  try {
    const inputs = await writeReviewInputs(session, worktree.dir, await ship.git.diff(fromSha, head))
    const nonce = randomBytes(8).toString("hex")
    await deps.fs.writeTextAtomic(join(worktree.dir, READ_CHECK_PATH), `${nonce}\n`, 0o600)
    const brief = reviewerBrief({
      reviewer,
      readCheck: READ_CHECK_PATH,
      prNumber: session.number,
      repoLabel: ship.repoLabel,
      tagVersion: deps.tagVersion,
      runId: ship.runId,
      reReview: round > 1 ? { fromSha, toSha: head, openItems } : null,
      inputs
    })
    sub(ctx, "review", `${AGENT_LABEL[reviewer]} is reviewing (read-only)…`, "pending")
    // The headline names who is working NOW (terminal QA #19: the worker's last line from the jobs or fix turn
    // stayed above "Codex is reviewing").
    ctx.emit.emit("narrate", { agent: reviewer, role: "reviewer", text: round > 1 ? "Reading the fix commit (read-only)" : "Reading the pull request (read-only)" })
    const started = deps.clock.now().getTime()
    const read = new Set<string>()
    const edited = new Set<string>()
    let thinking = 0
    let phase = "Reading the pull request"
    const showStatus = () => ctx.emit.emit("step.status", { step: "review", text: `${agentStatusLine({ phase, read: read.size, edited: edited.size, thinking, elapsedMs: deps.clock.now().getTime() - started, budgetMs: AGENT_LIMITS.reviewer.wallMs })} · ${REVIEW_ITEMS.filter(item => item !== "R6").length} checklist items` })
    showStatus()
    const once = async (text: string): Promise<ReviewResult | ReviewFailure> => {
      const onNarrate = (beat: { agent: AgentKind; role: "reviewer"; text: string }) => ctx.emit.emit("narrate", beat)
      const onActivity: NonNullable<Parameters<WizardDeps["agents"]["review"]>[0]["onActivity"]> = (activity) => {
        if (activity.kind === "thinking") thinking = activity.seconds
        else if (activity.kind === "read") { read.add(activity.path); phase = "Reading the pull request"; thinking = 0 }
        else { edited.add(activity.path); phase = "Writing the changes"; thinking = 0 }
        showStatus()
      }
      let result = await deps.agents.review({ worktreeDir: worktree.dir, reviewer, brief: text, onNarrate, onActivity })
      if ("error" in result && result.error === "unparseable") {
        result = await deps.agents.review({ worktreeDir: worktree.dir, reviewer, brief: `${text}\n\nYour previous answer did not match the JSON schema. Return JSON only, exactly matching it.`, onNarrate, onActivity })
      }
      // Belt and braces: whatever the runner parsed must match review.schema.json before anything is posted.
      if (!("error" in result) && !isReviewResult(result)) return { error: "unparseable" }
      return result
    }
    const first = await once(brief)
    if ("error" in first) return first
    let classified = classifyReview(first, nonce)
    if (classified.state === "blind") {
      sub(ctx, "review", `${AGENT_LABEL[reviewer]}'s review shows it could not read the files; asking once more`, "info")
      const retry = await once(`${brief}\n\n${BLIND_RETRY_NOTE}`)
      if ("error" in retry && (retry.error === "out_of_usage" || retry.error === "timeout")) return retry
      if (!("error" in retry)) classified = classifyReview(retry, nonce)
    }
    if (classified.state === "blind") return { blind: true }
    return { review: classified.review, classified }
  } finally {
    await ship.git.worktreeRemove(worktree.dir)
  }
}

/** Scans and posts one review round (GitHub: one COMMENT review; elsewhere: `.infinite/wizard/REVIEW.md`). */
async function postRound(session: Session, review: ReviewResult, reviewer: AgentKind, round: number, head: string, classified: ClassifiedReview | null = null): Promise<void> {
  const { ship, deps, ctx } = session
  const state = ctx.state.get()
  const fullDiff = await ship.git.diff(state.git!.baseSha, head)
  const unchecked = classified?.state === "incomplete" ? classified.unchecked : []
  const ownership = await sessionOwnership(session)
  const post = buildReviewPost({ isRunCode: ownership.writtenByRun, review, diffFiles: parseUnifiedDiff(fullDiff), scanner: ship.scanner, runId: ship.runId, round, head, reviewer, unchecked })
  const redact = (text: string) => (ship.isPrivate ? text : redactIdsNotInDiff(text, fullDiff, ship.facts.connectionIds))
  const body = redact(post.body)
  const threads = post.threads.map((thread) => ({ ...thread, body: redact(thread.body) }))
  if (session.github && session.number !== null) {
    await session.github.postReview(session.number, { headSha: head, body, threads })
  } else {
    const path = join(ctx.root, WIZARD_PATHS.review)
    const previous = (await deps.fs.readText(path)) ?? ""
    const located = threads.map((thread) => `- \`${thread.path}:${thread.line}\` ${thread.body.replace(/\n+/g, " ")}`).join("\n")
    await deps.fs.writeTextAtomic(path, `${previous}${previous ? "\n\n" : ""}${body}${located ? `\n\n${located}` : ""}\n`, 0o600)
  }
  for (const line of reviewFoundLines(AGENT_LABEL[reviewer], review, round, classified)) sub(ctx, "review", line.text, line.tone)
}

/**
 * §3y.7: what the reviewer found, with its completeness. "Nothing to change" ONLY for a complete review that approves
 * with no findings; an incomplete review names what it could not check; "changes suggested" with no finding says so.
 */
export function reviewFoundLines(reviewer: string, review: Pick<ReviewResult, "verdict" | "findings" | "checklist">, round: number, classified: Pick<ClassifiedReview, "state" | "unchecked"> | null): Array<{ text: string; tone: "ok" | "info" | "warn" }> {
  const lines: Array<{ text: string; tone: "ok" | "info" | "warn" }> = []
  const unreliable = reviewReliabilityWarning(review.findings)
  if (unreliable) lines.push({ text: `! ${reviewer}: ${unreliable}`, tone: "warn" })
  const complete = !unreliable && (classified === null || classified.state === "complete")
  const unchecked = classified?.unchecked.filter(item => !item.startsWith("review unreliable:")) ?? []
  if (classified?.state === "incomplete" && unchecked.length > 0) {
    const total = review.checklist.length
    lines.push({ text: `! ${reviewer}'s review is incomplete: it could not check ${unchecked.join(", ")} (${Math.max(0, total - unchecked.length)} of ${total} checked)`, tone: "warn" })
  }
  if (review.findings.length > 0) lines.push(reviewFoundLine(reviewer, review.findings.length, round))
  else if (review.verdict !== "looks_good") lines.push({ text: `! ${reviewer} suggested changes but named none`, tone: "warn" })
  else if (complete) lines.push(reviewFoundLine(reviewer, 0, round))
  return lines
}

/**
 * The review in a few words for the step's closing line (terminal QA #18: the round's own lines scroll out of the
 * kept sub-statuses behind the rehearsal re-run, so the closing line says what was found and what was fixed).
 */
export function reviewTally(rounds: ReadonlyArray<{ fixSha: string | null; review?: { findings: readonly unknown[] } }>): string {
  const comments = rounds.reduce((sum, round) => sum + (round.review?.findings.length ?? 0), 0)
  if (comments === 0) return "no comments"
  const fixRounds = rounds.filter((round) => round.fixSha !== null).length
  return `${comments} comment${comments === 1 ? "" : "s"}${fixRounds > 0 ? `, fixed in ${fixRounds} new commit${fixRounds === 1 ? "" : "s"}` : ", none fixed"}`
}

/**
 * What the reviewer found, said so a later round never reads as "found nothing at all" (terminal QA #18: after
 * a fix, the re-review's "Codex: no comments" was the only line left on screen about the review).
 */
export function reviewFoundLine(reviewer: string, findings: number, round: number): { text: string; tone: "ok" | "info" } {
  if (findings === 0) {
    return { text: round > 1 ? `${reviewer} re-checked the fix: no new comments` : `${reviewer} reviewed the pull request: nothing to change`, tone: "ok" }
  }
  return { text: `${reviewer} left ${findings} ${round > 1 ? "new " : ""}comment${findings === 1 ? "" : "s"}`, tone: "info" }
}

/** The review as the ledger keeps it: every reviewer string passed through the scan (paths included). */
function scannedReview(scanner: ShipContext["scanner"], review: ReviewResult): ReviewResult {
  const clean = (text: string) => safeText(scanner, text)
  return {
    verdict: review.verdict,
    summary: clean(review.summary),
    checklist: review.checklist.map((row) => ({ ...row, note: clean(row.note) })),
    findings: review.findings.map((finding) => ({
      ...finding,
      path: clean(finding.path),
      body: clean(finding.body),
      suggested_fix: finding.suggested_fix === null ? null : clean(finding.suggested_fix)
    }))
  }
}

const FINDING_LABEL = /\*\*\[R\d{1,2} [a-z]+\]\*\* (F\d{1,2})/

/** The most of a teammate's comment text the user is shown, and the exact text the worker then gets. */
const TEAMMATE_TEXT_MAX = 600

/** Reviewer findings + teammate threads (after the user's OK), as triage items; strangers' threads are listed only. */
async function gatherItems(session: Session, review: ReviewResult, round: number, head: string): Promise<{ items: TriageItem[]; teammateOk: Set<string>; ownThreadByFinding: Map<string, string> }> {
  const { ctx, ship } = session
  const ownThreadByFinding = new Map<string, string>()
  const teammateOk = new Set<string>()
  const items: TriageItem[] = review.findings.map((finding) => {
    // A path the scan would change (a token, an email, a private path) is not a file the wizard can scope.
    const path = safeText(ship.scanner, finding.path) === finding.path ? finding.path : null
    return {
      source: "reviewer",
      threadId: null,
      findingId: finding.id,
      category: finding.category,
      item: finding.item,
      severity: finding.severity,
      path,
      line: path === null ? null : finding.line,
      body: safeText(ship.scanner, finding.body),
      suggestedFix: finding.suggested_fix === null ? null : safeText(ship.scanner, finding.suggested_fix)
    }
  })
  if (!session.github || session.number === null) return { items, teammateOk, ownThreadByFinding }
  const threads = await session.github.readThreadDetails(session.number)
  const handled = new Set(ctx.state.get().pr?.handledThreadIds ?? [])
  const listed = new Set(session.untrusted.map((entry) => entry.key))
  const listUntrusted = (key: string, entry: { author: string; path: string | null; body: string }): void => {
    if (listed.has(key)) return
    listed.add(key)
    session.untrusted.push({ key, author: entry.author, path: entry.path, excerpt: safeText(ship.scanner, entry.body) })
  }
  const teammateThreads: Array<{ thread: (typeof threads)[number]; text: string; shown: string }> = []
  for (const thread of threads) {
    if (thread.isResolved) continue
    const first = thread.comments[0]
    if (!first) continue
    const trust = commentTrust(first, { login: session.login, runId: ship.runId })
    if (trust === "own") {
      const marker = parseReviewMarker(first.body)
      const label = FINDING_LABEL.exec(first.body)
      if (marker && marker.round === round && marker.head === head && label) ownThreadByFinding.set(label[1]!, thread.threadId)
      continue
    }
    if (handled.has(thread.threadId)) continue
    if (trust === "untrusted") {
      listUntrusted(`${thread.threadId}#0`, { author: first.author, path: thread.path, body: first.body })
      continue
    }
    // A teammate's thread: only comments by OWNER/MEMBER/COLLABORATOR count. A stranger's reply inside it is
    // listed, never acted on; the reply marker counts only on the user's own comments (anyone can paste it).
    const ownReply = (comment: (typeof thread.comments)[number]) => session.login !== null && comment.author === session.login && hasReplyMarker(comment.body)
    const trusted = thread.comments.filter((comment) => commentTrust(comment, { login: session.login, runId: ship.runId }) !== "untrusted")
    thread.comments.forEach((comment, index) => {
      if (commentTrust(comment, { login: session.login, runId: ship.runId }) === "untrusted") listUntrusted(`${thread.threadId}#${index}`, { author: comment.author, path: thread.path, body: comment.body })
    })
    const lastTrusted = trusted[trusted.length - 1]
    if (!lastTrusted || ownReply(lastTrusted)) continue
    // Everything the teammates wrote since the wizard's last reply on this thread: exactly what the user OKs.
    const lastOwn = trusted.map((comment) => ownReply(comment)).lastIndexOf(true)
    const text = trusted
      .slice(lastOwn + 1)
      .filter((comment) => !hasReplyMarker(comment.body))
      .map((comment) => `@${comment.author}: ${stripMarkers(comment.body)}`)
      .join("\n\n")
    const original = safeText(ship.scanner, text).slice(0, TEAMMATE_TEXT_MAX)
    const shown = safeDisplayText(ship.scanner, original)
    if (shown.trim().length > 0) teammateThreads.push({ thread, text: original, shown })
  }
  for (const item of items) item.threadId = ownThreadByFinding.get(item.findingId ?? "") ?? null
  const strangers = session.untrusted.length
  if (strangers > 0) sub(ctx, "review", `${strangers} comment${strangers === 1 ? "" : "s"} from people outside the repo ${strangers === 1 ? "is" : "are"} shown, not acted on`, "info")
  if (teammateThreads.length > 0) {
    const answer = await ctx.ask("teammate-comments", {
      comments: teammateThreads.map(({ thread, shown }) => ({
        threadId: thread.threadId,
        author: safeDisplayText(ship.scanner, thread.author),
        path: safeDisplayText(ship.scanner, thread.path ?? ""),
        line: thread.line,
        excerpt: shown
      }))
    })
    const actOn = typeof answer === "object" && answer !== null && Array.isArray(answer.actOn) ? answer.actOn : []
    for (const { thread, text } of teammateThreads) {
      if (!actOn.includes(thread.threadId)) {
        // Not OK'd: never acted on, never replied to, never asked again.
        ctx.state.update((state) => {
          if (state.pr && !state.pr.handledThreadIds.includes(thread.threadId)) state.pr.handledThreadIds.push(thread.threadId)
        })
        continue
      }
      teammateOk.add(thread.threadId)
      const path = thread.path !== null && safeText(ship.scanner, thread.path) === thread.path ? thread.path : null
      items.push({
        source: "teammate",
        threadId: thread.threadId,
        findingId: null,
        item: null,
        severity: "should",
        path,
        line: path === null ? null : thread.line,
        // The same approved excerpt, with source syntax preserved; job16Item fences it as data.
        body: text,
        suggestedFix: null
      })
    }
  }
  return { items, teammateOk, ownThreadByFinding }
}

function passingChecks(ctx: WizardContext, head: string): Set<string> {
  const state = ctx.state.get()
  const out = new Set<string>()
  for (const job of state.jobs) for (const check of job.checks) if (check.state === "pass") out.add(check.id)
  // R4-5: the rehearsal of THIS commit decides too, whether or not a job carries the check.
  for (const check of state.rehearsalChecks ?? []) if (check.state === "pass" && check.sha === head) out.add(check.checkId)
  for (const cell of Object.values(state.report.in_pr?.finishLine ?? {})) {
    if (cell?.state === "pass" && cell.provenance.checkId) out.add(cell.provenance.checkId)
  }
  return out
}

function answerFrom(ctx: WizardContext): (item: TriageItem) => string | null {
  const state = ctx.state.get()
  const byId = new Map<string, string>()
  for (const job of state.jobs) for (const check of job.checks) if (check.state !== "not_run") byId.set(check.id, check.state)
  return (item) => {
    const ids = item.item ? DETERMINISTIC_CHECKS_BY_ITEM[item.item] ?? [] : []
    const measured = ids.filter((id) => byId.has(id)).map((id) => `${id}: ${byId.get(id)}`)
    return measured.length > 0 ? `From this run's own checks on this commit: ${measured.join(", ")}.` : null
  }
}

/** ASK items the user can turn into a fix (widening, a conflict, a re-raised item); the rest stay open. */
async function resolveAsks(session: Session, decisions: TriageDecision[], workerAvailable: boolean): Promise<TriageDecision[]> {
  const out: TriageDecision[] = []
  for (const decision of decisions) {
    const askable =
      decision.action === "ASK" &&
      workerAvailable &&
      // A ruling (consent, a GA4 proxy, Meta's never-list, deletion) is never offered as a fix.
      decision.ruling === undefined &&
      decision.item.path !== null &&
      isRepoRelativePath(decision.item.path) &&
      !isGloballyDenied(decision.item.path) &&
      (decision.askReason === "allowlist_widening" ||
        decision.askReason === "reviewer_conflict" ||
        decision.askReason === "raised_after_decline" ||
        // LF4 close round 2 (P1-3): the user hears Infinite's server-only conversion rule and decides about the rest.
        decision.askReason === "infinite_design")
    if (!askable) {
      out.push(decision)
      continue
    }
    const who = decision.item.source === "teammate" ? "A teammate" : "The reviewer"
    const where = `${decision.item.path}${decision.item.line ? `:${decision.item.line}` : ""}`
    const answer = await session.ctx.ask("single", {
      question: safeDisplayText(session.ship.scanner, `${who} on ${where}: “${excerpt(decision.item.body, 140)}” ${decision.reason} Let the agent fix it?`),
      options: [
        { label: "Fix it", value: "fix" },
        { label: "Leave it", value: "leave" }
      ],
      default: "leave"
    })
    if (answer === "fix") {
      session.ledger.open = session.ledger.open.filter((entry) => entry.key !== triageKey(decision.item))
      out.push({ ...decision, action: "FIX", reason: "You approved this fix.", askReason: undefined })
    } else if (answer === "leave") {
      // Live-fix 4 final round (P3): the owner decided; the item is left (with Infinite's rule), never "waiting".
      out.push({ ...decision, leftByOwner: true, reason: leftByOwnerReason(decision) })
    } else {
      // No answer (a timeout under --yes / nested mode, or a cancel) is not the owner's decision: it stays waiting.
      out.push(decision)
    }
  }
  return out
}

/** Pushes the fix commit and proves the PR head moved forward (a descendant, never a rewrite). */
async function syncHead(session: Session, prevHead: string, newHead: string): Promise<{ head: string } | StepOutcome> {
  const { ship, deps, ctx } = session
  const gitState = ctx.state.get().git!
  // A plain push (on GitLab too: the merge request already exists).
  const pushed = await pushBranch({ ctx, deps, git: ship.git, scanner: ship.scanner, hostKind: "other", base: gitState.base, branch: gitState.branch, title: "" })
  if (pushed.kind === "failed") return failed("INF_WIZ_PUSH_REFUSED", pushed.message)
  if (!(await ship.git.isAncestor(prevHead, newHead))) return failed("INF_WIZ_PUSH_REFUSED", "The fix commit does not descend from the reviewed head; the wizard never rewrites history.")
  let head = newHead
  if (session.github && session.number !== null) {
    let pr = await session.github.readPr(session.number)
    for (let attempt = 1; attempt < HEAD_SYNC_ATTEMPTS && pr.headRefOid !== head; attempt += 1) {
      await deps.clock.sleep(HEAD_SYNC_SLEEP_MS, ctx.signal)
      pr = await session.github.readPr(session.number)
    }
    if (pr.headRefOid !== head) return failed("INF_WIZ_PUSH_REFUSED", `GitHub's pull request head (${pr.headRefOid.slice(0, 7)}) is not the pushed commit (${head.slice(0, 7)}).`)
    const conflict = (): void => {
      // A conflict cannot be merged by GitHub: the user resolves it; the wizard never rebases.
      const line = `The branch conflicts with ${gitState.base}. Resolve the conflict on GitHub or locally, then run \`npx infinite-tag\` again.`
      session.notes.push(line)
      sub(ctx, "review", line, "warn")
    }
    if (pr.mergeStateStatus === "DIRTY") {
      conflict()
    } else if (pr.mergeStateStatus === "BEHIND") {
      sub(ctx, "review", "The base moved: updating the branch with a merge commit…", "info")
      let updated = true
      try {
        await session.github.updateBranch(session.number)
      } catch {
        updated = false
        conflict()
      }
      if (updated) {
        const integrated = (await ship.git.pullFfOnly(gitState.branch)).headSha
        const baseHead = await ship.git.remoteBranchSha(gitState.base)
        const known = baseHead ? await branchUpdateCommits(ctx.root, ship.git, head, integrated, baseHead) : null
        if (known === null) return failed("INF_WIZ_PUSH_REFUSED", "The updated branch did not match the requested base merge; its new commits were not approved automatically.")
        head = integrated
        ctx.state.update(state => {
          state.approvedForeignCommits = [...new Set([...(state.approvedForeignCommits ?? []), ...known])]
          state.lastPush = { sha: head, at: ctx.now().toISOString() }
        })
        await ctx.state.save()
      }
    }
  }
  ctx.state.update((state) => {
    if (state.git) state.git.headSha = head
  })
  return { head }
}

/** Replies on the wizard's own threads (and teammates' OK'd threads); resolves only its own FIXED threads. */
async function replyAndResolve(
  session: Session,
  decisions: readonly TriageDecision[],
  teammateOk: ReadonlySet<string>,
  fixSha: string | null,
  fixState: ReadonlyMap<string, "fixed" | "unverified">,
  notFixed: ReadonlyMap<string, FixReplyState> = new Map()
): Promise<void> {
  if (!session.github) return
  for (const decision of decisions) {
    if (decision.action === "SKIP" || decision.action === "OWNER_INFO") continue
    const threadId = decision.item.threadId
    if (!threadId) continue
    const own = decision.item.source === "reviewer"
    if (!own && !teammateOk.has(threadId)) continue
    // A resumed round never replies twice on the same thread.
    if (session.ctx.state.get().pr?.handledThreadIds.includes(threadId)) continue
    const state = decision.action === "FIX" && fixSha !== null ? fixState.get(threadId) : undefined
    const fix: FixReplyState | null = decision.action !== "FIX" ? null : state && fixSha ? { kind: state, sha: fixSha } : (notFixed.get(threadId) ?? { kind: "not_fixed" })
    await session.github.reply(threadId, buildReply(session.ship.scanner, decision, fix))
    if (own && state === "fixed") await session.github.resolve(threadId)
    session.ctx.state.update((draft) => {
      if (draft.pr && !draft.pr.handledThreadIds.includes(threadId)) draft.pr.handledThreadIds.push(threadId)
    })
  }
}

class PrChecksStop extends Error {
  constructor(message: string, readonly failed: boolean) { super(message) }
}

/** One bounded CI repair, only for an actual base-green regression with a log naming this run's edits. */
async function repairCi(session: Session, checks: PrCheck[], base: PrCheck[] | null): Promise<boolean> {
  const { ctx, deps, ship, github } = session
  const worker = ctx.state.get().agent?.worker
  if (!github || !worker || session.ciRepairAttempted) return false
  session.ciRepairAttempted = true
  const receipt = JSON.parse((await deps.fs.readText(join(ctx.root, ".infinite/install.json"))) ?? "{}") as { edits?: Array<{ file: string; runId?: string }> }
  const { managed } = await manifestFiles(deps, ctx.root)
  const owned = [...new Set([...(receipt.edits ?? []).filter(edit => edit.runId === ship.runId).map(edit => edit.file), ...ctx.state.get().jobs.flatMap(job => (job.edits ?? []).map(edit => edit.file))])].filter(file => !managed.includes(file))
  const logs: string[] = []
  const files = new Set<string>()
  for (const check of checks) {
    if (!base?.some(previous => previous.name === check.name && previous.bucket === "pass")) return false
    const run = /\/actions\/runs\/(\d+)/.exec(check.link ?? "")?.[1]
    if (!run) return false
    const log = await github.gh.run(["run", "view", run, "--log-failed"]).then(value => value.stdout).catch(() => null)
    if (!log) return false
    const named = owned.filter(file => log.includes(file))
    if (named.length === 0) return false
    named.forEach(file => files.add(file))
    logs.push(`${check.name}:\n${ship.scanner.redact(log).text}`)
  }
  const item = ciFixItem([...files], logs.join("\n"))
  const snapshots = await snapshotFiles(deps, ctx.root, [...files, ".infinite/install.json"])
  const previous = await ship.git.head()
  const fix = await runFixRound(ctx, deps, { step: "review", worker, items: [item], scanner: ship.scanner })
  if (fix.run.outcome !== "completed") {
    await restoreFiles(deps, ctx.root, snapshots, fix.run.edits)
    return false
  }
  const restoreUncommitted = async () => {
    if (await ship.git.head() !== previous) return
    await restoreFiles(deps, ctx.root, snapshots, fix.run.edits)
    await ship.git.unstage(snapshots.map(snapshot => snapshot.path))
  }
  try {
    const verified = await verifyFix(ctx, deps, { runId: ship.runId, items: fix.items, editedFiles: fix.run.edits.map(edit => edit.file), edits: fix.run.edits })
    if (!verified.buildOk || fix.run.edits.length === 0 || fix.run.edits.some(edit => !files.has(edit.file))) {
      await restoreUncommitted()
      return false
    }
    await deps.installer.recordEdits(fix.run.edits)
    const commit = await stageAndCommit({ ctx, deps, git: ship.git, step: "review", scanner: ship.scanner, runId: ship.runId, message: "infinite-tag: fix PR checks", round: 1, allowlist: [...files], managed, npmFiles: [], connectionIds: ship.facts.connectionIds })
    if (commit.kind !== "committed") {
      await restoreUncommitted()
      return false
    }
    const synced = await syncHead(session, previous, commit.sha)
    if ("head" in synced) session.notes.push("The CI repair was committed after the review; it has not had a separate second review.")
    return "head" in synced
  } catch (error) {
    await restoreUncommitted()
    session.notes.push(ship.scanner.redact(`The CI repair could not be committed: ${error instanceof Error ? error.message : String(error)}`).text)
    return false
  }
}

const CHECKS_POLL_MS = 30_000
const CHECKS_WAIT_MS = 10 * 60_000
/** gh says "no required checks reported" both when none are required and before GitHub registers them. */
const CHECKS_EMPTY_GRACE_MS = 60_000

/**
 * Job 16's `pr_checks_pass` (S) on the pushed fix: polls all reported PR checks until they settle (every 30 s,
 * ≤ 10 minutes). Empty, cancelled, unreadable and blocked-preview checks remain unmeasured.
 * New failures get a bounded scoped repair; known base failures are reported without blocking.
 */
async function requiredChecksResult(session: Session, runId: string, repair = true): Promise<(CheckResult & { ready: boolean }) | null> {
  const { github, number, deps, ctx } = session
  if (!github || number === null) return null
  const started = deps.clock.now().getTime()
  const checkedHead = await session.ship.git.head()
  const registeredOnResume = session.ledger.checkRegistration?.sha === checkedHead
  const pushed = ctx.state.get().lastPush
  const pushedAt = pushed?.sha === checkedHead ? Date.parse(pushed.at) : started
  const registrationStart = Number.isFinite(pushedAt) ? Math.min(started, pushedAt) : started
  const result = (state: CheckResult["state"], reason: string, ready = false): CheckResult & { ready: boolean } => ({ checkId: "pr_checks_pass", tier: "S", state, reason: safeDisplayText(session.ship.scanner, reason), at: ctx.now().toISOString(), runId, ready })
  let waitingReason = "PR checks could not be read"
  const base = await commitChecks(github.gh, ctx.state.get().git!.baseSha).catch(() => null)
  const workflows = await headPrWorkflows(github.gh, checkedHead).catch(() => null)
  const triggers = new Map<string, boolean | null>()
  for (const check of base ?? []) if (check.bucket === "pass") {
    const next = await checkRunsOnPr(github.gh, check, checkedHead)
    const previous = triggers.get(check.name)
    // Distinct workflows may give their jobs the same name. Only infer push-only when every
    // matching workflow is known not to run on PRs; a PR trigger or unknown trigger keeps the wait.
    triggers.set(check.name, previous === undefined ? next : previous === true || next === true ? true : previous === null || next === null ? null : false)
  }
  sub(ctx, "review", "Checking the new commit's CI checks…", "pending")
  for (;;) {
    const elapsed = deps.clock.now().getTime() - started
    const registered = registeredOnResume || deps.clock.now().getTime() - registrationStart >= CHECKS_EMPTY_GRACE_MS
    if (registered && session.ledger.checkRegistration?.sha !== checkedHead) {
      session.ledger.checkRegistration = { sha: checkedHead, complete: true }
      await saveLedger(session)
    }
    const activity = await headCheckActivity(github.gh, checkedHead).catch(() => null)
    const rawChecks = await github.checks(number).catch(() => null)
    const checks = rawChecks === null ? null : await withDeploymentStates(github.gh, checkedHead, [...rawChecks, ...(activity?.results ?? []).filter(row => !rawChecks.some(current => current.name === row.name && current.bucket === row.bucket))]).catch(() => null)
    if (checks !== null && !isUnsupported(checks)) {
      const summary = checksSummary(checks)
      const policy = checkPolicy(checks, base)
      for (const check of policy.blocked) {
        const note = safeDisplayText(session.ship.scanner, `${check.name}: preview not measured. Ask a hosting team member to authorise the deployment or give this GitHub author access to the linked project.`)
        if (!session.notes.includes(note)) { session.notes.push(note); sub(ctx, "review", note, "warn") }
      }
      for (const check of policy.existing) {
        const note = safeDisplayText(session.ship.scanner, `${check.name} also fails on the base commit; it does not block this run.`)
        if (!session.notes.includes(note)) { session.notes.push(note); sub(ctx, "review", note, "warn") }
      }
      if (policy.failing.length > 0) {
        if (repair && await repairCi(session, policy.failing, base)) return requiredChecksResult(session, runId, false)
        return result("problem", `Failed PR checks: ${policy.failing.map(check => check.name).join(", ")}${base === null ? " (base checks could not be read)" : ""}`)
      }
      if (activity?.failed.length) return result("problem", `Failed CI suite or workflow: ${activity.failed.join(", ")}`)
      const missingWorkflows = workflows?.expected.filter(path => !activity?.workflowPaths.includes(path)) ?? []
      const absent = (base ?? []).filter(check => check.bucket === "pass" && !checks.some(current => current.name === check.name))
      const cancelled = checks.filter(check => check.bucket === "cancel")
      const pending = checks.filter(check => check.bucket === "pending")
      const unknown = checks.filter(check => !["pass", "fail", "pending", "cancel", "skipping"].includes(check.bucket))
      waitingReason = base === null ? "The base commit's checks could not be read" : cancelled.length > 0 ? `PR checks cancelled: ${cancelled.map(check => check.name).join(", ")}`
        : pending.length > 0 ? `PR checks are still pending: ${pending.map(check => check.name).join(", ")}`
        : unknown.length > 0 ? `PR check states could not be read: ${unknown.map(check => check.name).join(", ")}`
        : "No PR checks have been reported"
      const waitingForAbsent = absent.some(check => triggers.get(check.name) !== false) && deps.clock.now().getTime() - registrationStart < CHECKS_WAIT_MS
      if (absent.length > 0) waitingReason = `Missing PR checks: ${absent.map(check => check.name).join(", ")}; not measured`
      if (!activity) waitingReason = "The head commit's check suites or workflow runs could not be read"
      else if (activity.pending.length) waitingReason = `CI suites or workflows are still pending: ${activity.pending.join(", ")}`
      else if (!workflows || workflows.unknown) waitingReason = "The PR head's workflow triggers could not be determined"
      else if (missingWorkflows.length) waitingReason = `Expected PR workflows have not completed: ${missingWorkflows.join(", ")}; not measured`
      const registrationUnknown = !activity?.observed && checks.length === 0 && deps.clock.now().getTime() - registrationStart < CHECKS_WAIT_MS
      const activitySettled = activity !== null && activity.pending.length === 0 && workflows !== null && !workflows.unknown && missingWorkflows.length === 0
      if ((registered || (activitySettled && activity.observed)) && !registrationUnknown && activitySettled && !waitingForAbsent && base !== null && summary.pending === 0 && unknown.length === 0) {
        if (session.ledger.checkRegistration?.sha !== checkedHead) {
          session.ledger.checkRegistration = { sha: checkedHead, complete: true }
          await saveLedger(session)
        }
        for (const check of absent) {
          const note = safeDisplayText(session.ship.scanner, triggers.get(check.name) === false ? `${check.name} does not run on pull requests: not measured (workflow triggers checked).` : `${check.name} did not appear in the full check window: not measured.`)
          if (!session.notes.includes(note)) { session.notes.push(note); sub(ctx, "review", note, "info") }
        }
        if (checks.length === 0) return result("undetermined", base.length === 0 ? "no checks reported: not measured; the base commit also has no checks" : "No checks reported on this pull request after registration: not measured", true)
        return result(summary.pass > 0 && !checks.some(check => check.bucket === "skipping") && absent.length === 0 && policy.blocked.length === 0 ? "pass" : "undetermined", summary.pass > 0 ? `${summary.pass} PR check(s) pass; unavailable previews and base-only checks remain not measured` : "PR checks not measured; only skipped checks, blocked previews or existing failures reported", true)
      }
      if (registeredOnResume && activitySettled && !registrationUnknown && !waitingForAbsent && pending.length === 0) return result("undetermined", waitingReason)
    } else {
      waitingReason = "PR checks could not be read"
      if (registeredOnResume) return result("undetermined", waitingReason)
    }
    if (ctx.signal.aborted || elapsed >= CHECKS_WAIT_MS || deps.clock.now().getTime() - registrationStart >= CHECKS_WAIT_MS) return result("undetermined", waitingReason)
    await deps.clock.sleep(CHECKS_POLL_MS, ctx.signal)
  }
}

/** §3g.4 step 9: ready + the final comment (or REVIEW.md off GitHub). `once`: skip the comment when this run already posted one. */
async function finish(session: Session, options: { once?: boolean } = {}): Promise<void> {
  const { ctx, deps, ship } = session
  const state = ctx.state.get()
  if (session.github && session.number !== null && (await session.github.readPr(session.number)).state === "OPEN") {
    const verdict = await requiredChecksResult(session, ship.runId)
    if (verdict) session.notes.push(verdict.reason ?? "PR checks not measured")
    if (verdict && !verdict.ready) throw new PrChecksStop(ship.scanner.redact(verdict.reason ?? "PR checks were not measured").text, verdict.state === "problem")
  }
  if (options.once && session.github && session.number !== null) {
    const comments = await session.github.readComments(session.number).catch(() => [])
    if (comments.some((comment) => comment.author === session.login && hasFinalMarker(comment.body, ship.runId))) {
      const pr = await session.github.readPr(session.number)
      if (pr.isDraft && pr.state === "OPEN") {
        await session.github.markReady(session.number)
        ctx.state.update((draft) => {
          if (draft.pr) draft.pr.isDraft = false
        })
      }
      return
    }
  }
  if (session.github && session.number !== null) {
    const pr = await session.github.readPr(session.number)
    if (pr.isDraft && pr.state === "OPEN") {
      await session.github.markReady(session.number)
      ctx.state.update((draft) => {
        if (draft.pr) draft.pr.isDraft = false
      })
      sub(ctx, "review", "Marked the pull request ready for review", "ok")
    }
    const rules = await session.github.rules(state.git!.base)
    const line = isUnsupported(rules) ? null : mergeRequirementLine({ reviewDecision: pr.reviewDecision, ...rules })
    if (line) {
      session.notes.push(line)
      sub(ctx, "review", line, "warn")
    }
  }
  await saveLedger(session)
  const verdictFacts = await verdictFactsFor(ctx, deps)
  const report = deps.report.build({
    runId: ship.runId,
    tagVersion: deps.tagVersion,
    site: { repoLabel: ship.repoLabel, productionHost: ship.facts.productionHost },
    columns: ctx.state.get().report,
    provenLivePending: provenPendingFor({ state: ctx.state.get(), hostingVercel: ship.facts.hosting?.provider === "vercel", noProve: false, productionHost: ship.facts.productionHost }),
    day7: null,
    notes: [],
    // §3x.6 the ledger is saved first so the verdict reads this session's open findings.
    verdictFacts
  })
  const openFromLedger: TriageDecision[] = session.ledger.open
    .filter((entry) => !session.decisions.some((decision) => decision.action === "ASK" && triageKey(decision.item) === entry.key))
    .map((entry) => ({
      item: { source: "reviewer", threadId: null, findingId: null, item: null, severity: "should", path: entry.path, line: null, body: entry.excerpt, suggestedFix: null },
      action: "ASK",
      reason: entry.reason
    }))
  let comment = buildFinalComment({
    runId: ship.runId,
    reportMarkdown: deps.report.renderMarkdown(report, verdictFacts.ownerBoundary, verdictFacts.jobs, verdictFacts.excludedLines),
    ownerBoundary: verdictFacts.ownerBoundary,
    reviewer: session.reviewer,
    reviewed: session.reviewed,
    completeness: session.ledger.completeness ?? null,
    jobs: ctx.state.get().jobs,
    decisions: [...session.decisions, ...openFromLedger],
    untrusted: session.untrusted,
    notes: session.notes,
    scanner: ship.scanner
  })
  if (!ship.isPrivate) comment = redactIdsNotInDiff(comment, await ship.git.diff(state.git!.baseSha, await ship.git.head()), ship.facts.connectionIds)
  if (session.github && session.number !== null) {
    // Live run 5 (P3): one "what happened" comment per run. A re-run edits the wizard's own comment for this run (author
    // AND marker) instead of posting a second one.
    const editor = commentEditor(session.github)
    const edited = editor ? await editor.updateOwnComment(session.number, PR_MARKERS.final(ship.runId), () => comment) : false
    if (!edited) await session.github.comment(session.number, comment)
  } else {
    const path = join(ctx.root, WIZARD_PATHS.review)
    const previous = (await deps.fs.readText(path)) ?? ""
    await deps.fs.writeTextAtomic(path, `${previous}${previous ? "\n\n" : ""}${comment}`, 0o600)
  }
}

/**
 * §3y.7: a reviewer that still could not read the files after its retry. No review is posted; the printed brief is
 * written (the existing one-agent path) and every surface says there is no second review, and why.
 */
async function blindFallback(session: Session, reviewer: AgentKind, prepared: ShipContext): Promise<void> {
  const { ctx, deps } = session
  const state = ctx.state.get()
  const brief = printedReviewBrief({
    prNumber: session.number,
    prUrl: state.pr?.url ?? null,
    repoLabel: prepared.repoLabel,
    tagVersion: deps.tagVersion,
    runId: prepared.runId,
    inputs: { diff: "the pull request's diff", plan: "the pull request's description", checks: "the table in the pull request" }
  })
  await deps.fs.mkdirp(join(ctx.root, WIZARD_PATHS.dir), 0o700)
  await deps.fs.writeTextAtomic(join(ctx.root, WIZARD_PATHS.reviewBrief), brief, 0o600)
  sub(ctx, "review", `! ${AGENT_LABEL[reviewer]} could not read the pull request's files, so there is no second review.`, "warn")
  sub(ctx, "review", `The review brief is in ${WIZARD_PATHS.reviewBrief}.`, "warn")
  session.notes.push(`No second review yet: ${AGENT_LABEL[reviewer]} could not read the files. Paste ${WIZARD_PATHS.reviewBrief} into any agent; a re-run of \`npx infinite-tag\` reads its review back.`)
  session.ledger.completeness = { reviewer, state: "blind", unchecked: [] }
  session.reviewed = false
}

async function mergedEarly(session: Session): Promise<StepOutcome> {
  const { ctx } = session
  session.notes.push("You merged before the review finished. The open items are listed here; run `npx infinite-tag` again later for a follow-up pull request.")
  await finish(session)
  await saveLedger(session)
  await ctx.state.save()
  const line = `Merged before the review finished · ${session.ledger.open.length} open item(s) posted`
  status(ctx, "review", line)
  return { kind: "ok", status: line }
}

async function prState(session: Session): Promise<"OPEN" | "MERGED" | "CLOSED"> {
  if (!session.github || session.number === null) return "OPEN"
  return (await session.github.readPr(session.number)).state
}

/** Merged → post the open items and go on; closed without merging → stop with a fresh-run offer (§3d.6). */
async function stopIfNotOpen(session: Session): Promise<StepOutcome | null> {
  const state = await prState(session)
  if (state === "MERGED") return mergedEarly(session)
  if (state === "CLOSED") {
    await saveLedger(session)
    await session.ctx.state.save()
    return {
      kind: "parked",
      code: "INF_WIZ_MERGE_PARKED",
      reason: `Pull request #${session.number} was closed without merging, so the wizard stopped reviewing it.`,
      resumeHint: "Run `npx infinite-tag` to start a fresh run."
    }
  }
  return null
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  try {
    return await reviewRun(ctx, deps)
  } catch (error) {
    if (error instanceof PrChecksStop) { await ctx.state.save(); return { kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason: `${error.message}. The pull request stays draft.`, resumeHint: error.failed ? "Resolve the named checks, then run `npx infinite-tag` again." : "Run `npx infinite-tag` again when the checks have finished or can be read." } }
    const stop = bridgeStop(error)
    if (stop) {
      await ctx.state.save()
      return stop
    }
    throw error
  }
}

async function reviewRun(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const prepared = await prepareShip(ctx, deps)
  if (!isShipContext(prepared)) return prepared
  const state = ctx.state.get()
  if (!state.pr) return { kind: "skipped", reason: "No pull request: nothing was committed this run." }
  const github = isGitHubAdapter(deps.host) && prepared.ghReady && state.pr.number !== null ? deps.host : null
  const session: Session = {
    ctx,
    deps,
    ship: prepared,
    github,
    number: state.pr.number,
    login: github ? (await github.auth()).login : null,
    ledger: parseLedger(await deps.fs.readText(join(ctx.root, REVIEW_LEDGER_PATH)), prepared.runId),
    decisions: [],
    untrusted: [],
    notes: [],
    reviewed: false,
    reviewer: state.agent?.reviewer ?? null
  }
  const notOpen = await stopIfNotOpen(session)
  if (notOpen) return notOpen

  const worker = state.agent?.worker ?? null
  const agentReviewer: AgentKind | null = session.reviewer === "claude_code" || session.reviewer === "codex" ? session.reviewer : null
  let briefReview: ReviewResult | null = null
  if (agentReviewer === null) {
    const brief = printedReviewBrief({
      prNumber: session.number,
      prUrl: state.pr.url,
      repoLabel: prepared.repoLabel,
      tagVersion: deps.tagVersion,
      runId: prepared.runId,
      inputs: { diff: "the pull request's diff", plan: "the pull request's description", checks: "the table in the pull request" }
    })
    await deps.fs.mkdirp(join(ctx.root, WIZARD_PATHS.dir), 0o700)
    await deps.fs.writeTextAtomic(join(ctx.root, WIZARD_PATHS.reviewBrief), brief, 0o600)
    status(ctx, "review", `No second agent: the review brief is in ${WIZARD_PATHS.reviewBrief}`)
    if (github && session.number !== null) {
      for (const comment of await github.readComments(session.number)) {
        briefReview = parseBriefReview(comment, { login: session.login, runId: prepared.runId }) ?? briefReview
      }
    }
    if (!briefReview) {
      session.notes.push(`No second review yet. Paste ${WIZARD_PATHS.reviewBrief} into any agent; a re-run of \`npx infinite-tag\` reads its review back.`)
      // Each re-run until a review arrives: one final comment per run, never one per re-run.
      await finish(session, { once: true })
      await saveLedger(session)
      await ctx.state.save()
      return { kind: "skipped", reason: `No second agent: the review brief is in ${WIZARD_PATHS.reviewBrief}.` }
    }
    sub(ctx, "review", "Read back the review posted from the brief", "ok")
  }

  const gitState = state.git!
  let reviewedSha = state.pr.reviewedSha ?? gitState.baseSha
  let lastRoundFixedUnreviewed = false
  const { managed } = await manifestFiles(deps, ctx.root)
  // A resume continues where the ledger stopped: a round already reviewed (and posted) on this head is re-triaged
  // from its saved review, never re-run or re-posted; after a fix round the next round re-reviews the delta; the
  // round count never restarts, so a resume can never exceed the 2 rounds.
  const currentHead = await prepared.git.head()
  const last = session.ledger.rounds[session.ledger.rounds.length - 1]
  let firstRound = 1
  let savedReview: ReviewResult | null = null
  if (last) {
    if (last.fixSha === null && last.reviewedSha === currentHead && last.review) {
      firstRound = last.round
      savedReview = last.review
    } else {
      firstRound = last.round + 1
      lastRoundFixedUnreviewed = last.fixSha !== null && last.round >= PR_LOOP_LIMITS.maxFixRounds
    }
  }
  for (let round = firstRound; round <= PR_LOOP_LIMITS.maxFixRounds; round += 1) {
    const stop = await stopIfNotOpen(session)
    if (stop) return stop
    const head = await prepared.git.head()
    let review: ReviewResult
    const resumed = round === firstRound && savedReview !== null
    if (resumed) {
      review = savedReview!
      sub(ctx, "review", `Resuming round ${round} from its saved review`, "info")
    } else if (round === 1 && briefReview) {
      review = briefReview
    } else if (agentReviewer) {
      const openItems = session.ledger.open.map((entry) => `${entry.path ?? "general"}: ${entry.excerpt.slice(0, 120)}`)
      const result = await runReviewer(session, agentReviewer, round, head, round === 1 ? gitState.baseSha : reviewedSha, openItems)
      if ("blind" in result) {
        // §3y.7: still blind after its one retry: nothing is posted as a review, and the one-agent brief path runs.
        await blindFallback(session, agentReviewer, prepared)
        break
      }
      if ("error" in result) {
        await saveLedger(session)
        await ctx.state.save()
        if (result.error === "out_of_usage") {
          return { kind: "parked", code: "INF_WIZ_AGENT_OUT_OF_USAGE", reason: "The reviewer agent is out of usage.", resumeHint: "Run `npx infinite-tag` again when your plan resets; the pull request stays a draft." }
        }
        if (result.error === "timeout") {
          return failed("INF_WIZ_AGENT_TIMEOUT", "The second review timed out. The pull request stays a draft; run `npx infinite-tag` again to retry the review.")
        }
        session.notes.push("The second review could not be read (its answer did not match the schema twice). Nothing from it was acted on.")
        await finish(session)
        return failed("INF_WIZ_REVIEW_UNPARSEABLE", "The second review could not be read; the pull request was marked ready without it.", "continue")
      }
      review = result.review
      session.ledger.completeness = { reviewer: agentReviewer, state: result.classified.state, unchecked: result.classified.unchecked }
      await postRound(session, review, agentReviewer, round, head, result.classified)
    } else {
      break
    }
    const unreliable = reviewReliabilityWarning(review.findings)
    session.notes = session.notes.filter(note => !note.startsWith("review unreliable:"))
    if (unreliable) {
      session.ledger.completeness = { reviewer: agentReviewer ?? "brief", state: "incomplete", unchecked: [unreliable] }
      if (!session.notes.includes(unreliable)) session.notes.push(unreliable)
    }
    session.reviewed = true
    reviewedSha = head
    if (!resumed) session.ledger.rounds.push({ round, reviewedSha: head, reviewer: agentReviewer ?? "brief", fixSha: null, review: scannedReview(prepared.scanner, review) })
    ctx.state.update((draft) => {
      if (draft.pr) {
        draft.pr.reviewedSha = head
        draft.pr.round = round
      }
    })
    // Saved before triage: a park in this round resumes it without a second review post.
    await saveLedger(session)

    const gathered = await gatherItems(session, review, round, head)
    // Only a decline from an EARLIER round makes an item "raised again": a resumed round re-triages its own
    // review, and its own declines (saved before the park) must stay declines.
    const declinedKeys = new Set(session.ledger.declined.filter((entry) => entry.round < round).map((entry) => entry.key))
    const ownership = await sessionOwnership(session)
    const routing = await triageRouting(session, gathered.items, ownership)
    const appRoot = ctx.state.get().appRoot
    const triaged = triage(gathered.items, {
      appRoot,
      // §3x.3: the customer's agent works inside the jobs' allowlists only; Infinite's own files are never its.
      allowlist: allowlistUnion(ctx.state.get().jobs),
      ownership: ownership.classify,
      writtenByRun: ownership.writtenByRun,
      declinedKeys,
      passingChecks: passingChecks(ctx, head),
      answerFor: answerFrom(ctx),
      serverLaneInstalled: session.ship.facts.keys ? session.ship.facts.keys.serverLane.laneState !== "no_secret" : null,
      infiniteInternalsIn: routing.internalsIn,
      fileRole: routing.fileRole,
      pageHelperCallsIn: routing.pageHelperCallsIn
    })
    const decisions = await resolveAsks(session, triaged, worker !== null)
    recordDecisions(session.ledger, decisions, round)
    session.decisions.push(...decisions)
    // §3x.3 A finding on Infinite's own code reaches Infinite through the run's report, never through the agent.
    for (const decision of decisions.filter((entry) => entry.action === "INFINITE")) {
      const where = `${decision.item.path ?? "general"}${decision.item.line ? `:${decision.item.line}` : ""}`
      const note = safeDisplayText(prepared.scanner, `Review finding on ${decision.label ?? "Infinite's own code"}: ${decision.item.item ?? "review"} ${where} (${decision.item.severity})`).slice(0, 300)
      // The report's note is built from the ledger's open findings at `done` (one source); this is the PR's copy.
      session.notes.push(note)
    }
    const fixes = decisions.filter((decision) => decision.action === "FIX")
    let fixSha: string | null = null
    const fixState = new Map<string, "fixed" | "unverified">()
    const notFixed = new Map<string, FixReplyState>()

    if (fixes.length > 0 && worker === null) {
      session.notes.push("No worker agent was available, so the valid comments are listed for you to fix.")
    } else if (fixes.length > 0 && worker !== null) {
      const items = fixes.map((decision, index) => job16Item(decision, index))
      for (const item of items) ctx.emit.emit("job.seeded", { item })
      sub(ctx, "review", `${AGENT_LABEL[worker]} is fixing ${items.length} comment${items.length === 1 ? "" : "s"}…`, "pending")
      const prevHead = head
      // The files the round may change AND create (a created file is removed again if the round fails; B29).
      const snapshots = await snapshotFiles(deps, ctx.root, items.flatMap((item) => [...item.allow.files, ...item.allow.create]))
      const fix = await runFixRound(ctx, deps, { step: "review", worker, items, scanner: prepared.scanner })
      if (fix.run.outcome === "out_of_usage") {
        // Nothing half-done stays in the tree; the resume runs the round again.
        await restoreFiles(deps, ctx.root, snapshots, fix.run.edits)
        await saveLedger(session)
        await ctx.state.save()
        return {
          kind: "parked",
          code: "INF_WIZ_AGENT_OUT_OF_USAGE",
          reason: `The worker agent is out of usage${fix.run.resetsAt ? `; it resets at ${fix.run.resetsAt}` : ""}.`,
          resumeHint: "Run `npx infinite-tag` again to resume the review fixes."
        }
      }
      const edited = fix.run.edits.map((edit) => edit.file)
      for (const [index, decision] of fixes.entries()) {
        if (fix.items.find(item => item.id === items[index]!.id)?.state !== "left_for_you") continue
        decision.action = "ASK"
        decision.askReason = "owner_file"
        decision.reason = fix.items.find(item => item.id === items[index]!.id)?.note ?? "Not changed by us: this edit place belongs to the site owner."
        decision.reason += " This finding remains open for the site owner."
      }
      recordDecisions(session.ledger, fixes, round)
      if (edited.length === 0 && fixes.every(decision => decision.action === "ASK" && decision.askReason === "owner_file")) {
        sub(ctx, "review", "Left for you: these edits would touch owner-managed consent or policy code.", "info")
        await saveLedger(session)
        await ctx.state.save()
        break
      }
      // §3x.3 / DECISIONS §1.5 A round that kept no change is said as it happened: no build and no check ran, so
      // nothing "failed the checks". Review P1-4: the fence's own record decides whether the agent changed anything
      // the wizard then undid (a stop mid-change, the safety check, a file outside the job), never `edits` alone.
      if (edited.length === 0) {
        const { outcome, why } = noKeptChangeOutcome(fix.run)
        const safeWhy = why ? safeDisplayText(prepared.scanner, why) : null
        const words = notFixedReply(outcome, safeWhy)
        session.notes.push(`Round ${round}: ${words}`)
        sub(ctx, "review", `! ${words}`, "warn")
        for (const decision of fixes) if (decision.item.threadId) notFixed.set(decision.item.threadId, { kind: "not_fixed", outcome, why: safeWhy })
        await replyAndResolve(session, decisions, gathered.teammateOk, null, fixState, notFixed)
        await saveLedger(session)
        await ctx.state.save()
        break
      }
      const verified = await verifyFix(ctx, deps, { runId: prepared.runId, items: fix.items, editedFiles: edited, edits: fix.run.edits })
      let finalItems = verified.items
      // The real reason a fix did not pass, per thread (the first failing check of its item).
      for (const [index, decision] of fixes.entries()) {
        const item = finalItems.find((candidate) => candidate.id === items[index]!.id)
        const failing = item?.checks.find((check) => check.state === "problem")
        const why = !verified.buildOk ? `build: ${verified.buildReason ?? "validation failed"}` : failing ? `${failing.id}: ${failing.reason ?? "problem"}` : null
        if (decision.item.threadId) notFixed.set(decision.item.threadId, { kind: "not_fixed", outcome: "checks_failed", why: why ? safeDisplayText(prepared.scanner, why).slice(0, 160) : null })
      }
      if (!verified.buildOk) {
        // Put the files back: nothing uncommitted stays on the PR branch, and nothing reaches the receipt.
        const leftOver = await restoreFiles(deps, ctx.root, snapshots, fix.run.edits)
        session.notes.push(
          safeDisplayText(prepared.scanner, `Round ${round}: the wizard could not accept the fixes (${verified.buildReason ?? 'validation failed'}), so it put the files back and did not commit them.${leftOver.length > 0 ? ` Remove ${leftOver.join(", ")} (the agent created it).` : ""}`)
        )
      } else if (edited.length > 0) {
        await deps.installer.recordEdits(fix.run.edits)
        const commit = await stageAndCommit({
          ctx,
          deps,
          git: prepared.git,
          step: "review",
          scanner: prepared.scanner,
          runId: prepared.runId,
          message: `infinite-tag: review fixes (round ${round})`,
          round,
          allowlist: [...allowlistUnion(ctx.state.get().jobs), ...items.flatMap((item) => item.allow.files)],
          managed,
          npmFiles: [],
          connectionIds: prepared.facts.connectionIds
        })
        const stop = commitStop(commit)
        if (stop) return stop
        if (commit.kind === "committed") {
          const synced = await syncHead(session, prevHead, commit.sha)
          if (!("head" in synced)) return synced
          fixSha = synced.head
          sub(ctx, "review", `${AGENT_LABEL[worker]} fixed ${items.length} comment${items.length === 1 ? "" : "s"} · new commit ${commit.sha.slice(0, 7)}`, "ok")
          const checksResult = await requiredChecksResult(session, prepared.runId)
          fixSha = await prepared.git.head()
          if (checksResult) finalItems = deps.registry.apply(finalItems, [checksResult], prepared.runId)
          if (checksResult && !checksResult.ready) {
            ctx.state.update((draft) => {
              const known = new Set(draft.jobs.map((job) => job.id))
              draft.jobs = [...draft.jobs.map((job) => finalItems.find((item) => item.id === job.id) ?? job), ...finalItems.filter((item) => !known.has(item.id))]
            })
            session.ledger.rounds[session.ledger.rounds.length - 1]!.fixSha = fixSha
            await saveLedger(session)
            await ctx.state.save()
            const reason = safeDisplayText(prepared.scanner, checksResult.reason ?? "a PR check failed")
            sub(ctx, "review", `PR checks: ${reason}`, "warn")
            return { kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason: `The PR checks are not ready (${reason}). The pull request stays draft.`, resumeHint: checksResult.state === "problem" ? "Resolve the named checks, then run `npx infinite-tag` again." : "Run `npx infinite-tag` again when the checks have finished or can be read." }
          }
          for (const [index, decision] of fixes.entries()) {
            const item = finalItems.find((candidate) => candidate.id === items[index]!.id)
            const committedFile = item ? commit.staged.includes(item.allow.files[0] ?? "") : false
            if (!decision.item.threadId || !committedFile || !item) continue
            if (item.state === "done_in_code" || item.state === "waiting_deploy" || item.state === "proven") fixState.set(decision.item.threadId, "fixed")
            // Committed and pushed, the build passed, but the required checks have not settled: honest, not "fixed".
            else if (item.state === "claimed" && checksResult?.state === "undetermined") fixState.set(decision.item.threadId, "unverified")
          }
          const outcome = await rehearse(ctx, deps, {
            step: "review",
            runId: prepared.runId,
            head: fixSha,
            facts: prepared.facts,
            approvedConversions: ctx.state.get().plan?.answers.conversions ?? [],
            evidenceUrls: await testPageUrls(ctx, deps),
            consentRequired: ctx.state.get().plan?.answers.consentMode === "required",
            ghReady: prepared.ghReady
          })
          announceRehearsal(ctx, "review", outcome, prepared.runId)
          recordRehearsalCells(ctx, outcome, { head: fixSha, runId: prepared.runId, keys: prepared.facts.keys })
          await applyRehearsalToJobs(ctx, deps, outcome, prepared.runId, fixSha, "review")
          sub(ctx, "review", outcome.state === "graded" ? "✓ Rehearsal re-run on the new commit" : "Rehearsal on the new commit: undetermined", outcome.state === "graded" ? "ok" : "warn")
          // Only conversions not already sent this run are PATCHed (append-only), and only those get GA4 key events.
          const already = new Set(session.ledger.clickTested ?? [])
          const newNames = outcome.clickTested.filter((name) => !already.has(name))
          if (newNames.length > 0) {
            assertNoAgentAlive(deps, "runs PATCH")
            const patched = await bestEffortBridge(ctx, "review", "tell Infinite about the new click tests", () =>
              deps.bridge.patchRun(prepared.runId, { prHeadSha: fixSha!, clickTestedConversions: newNames })
            )
            if (patched) session.ledger.clickTested = [...already, ...newNames].sort()
            const fresh = new Set(newNames)
            await recordClickTests(ctx, deps, {
              step: "review",
              runId: prepared.runId,
              outcome: { ...outcome, ga4ClickTested: outcome.ga4ClickTested.filter((name) => fresh.has(name)) },
              approved: ctx.state.get().plan?.answers.conversions ?? []
            })
          }
          session.ledger.rounds[session.ledger.rounds.length - 1]!.fixSha = fixSha
        }
      }
      ctx.state.update((draft) => {
        const known = new Set(draft.jobs.map((job) => job.id))
        draft.jobs = [...draft.jobs.map((job) => finalItems.find((item) => item.id === job.id) ?? job), ...finalItems.filter((item) => !known.has(item.id))]
      })
    }
    await replyAndResolve(session, decisions, gathered.teammateOk, fixSha, fixState, notFixed)
    await saveLedger(session)
    await ctx.state.save()
    if (fixSha === null) break
    lastRoundFixedUnreviewed = round === PR_LOOP_LIMITS.maxFixRounds
  }
  if (lastRoundFixedUnreviewed) session.notes.push(`The round ${PR_LOOP_LIMITS.maxFixRounds} fixes were not re-reviewed (the review stops after ${PR_LOOP_LIMITS.maxFixRounds} rounds).`)
  await finish(session)
  await saveLedger(session)
  await ctx.state.save()
  const final = ctx.state.get()
  const once = final.report.in_pr?.finishLine.each_tool_once?.state
  const rehearsalText = once === "pass" ? "rehearsal passed on the latest commit" : once === "problem" ? "rehearsal found a problem" : "rehearsal undetermined"
  const blind = session.ledger.completeness?.state === "blind" && agentReviewer !== null
  const incomplete = session.ledger.completeness?.state === "incomplete"
  const unreliable = reviewReliabilityWarning(session.ledger.rounds.at(-1)?.review?.findings ?? [])
  const who = blind
    ? `no second review (${AGENT_LABEL[agentReviewer!]} could not read the files)`
    : session.reviewed
      ? `reviewed by ${agentReviewer ? AGENT_LABEL[agentReviewer] : "your agent (brief)"}${unreliable ? " (review unreliable)" : incomplete ? " (incomplete)" : ""}`
      : "no second review"
  const found = session.reviewed ? reviewTally(session.ledger.rounds) : null
  const line = [`${final.pr?.number ? `Pull request #${final.pr.number}` : "Branch"}`, who, ...(found ? [found] : []), rehearsalText].join(" · ")
  status(ctx, "review", line)
  return { kind: "ok", status: line }
}

/**
 * Review P1-4: why a fix round kept no change, read from the fence's record of the turn (`runExtras`):
 *   - stopped (timeout, error, no tools) after editing → `undone`, naming what it changed;
 *   - every change refused by the post-turn gate → `gate_refused`, with the gate's own note;
 *   - every change undone by the fence (outside the job's files, consent, a file no job owns) → `blocked`, with its note;
 *   - only when all three are empty → the plain outcome ("ran out of time before changing anything", "without
 *     changing anything").
 */
export function noKeptChangeOutcome(run: Omit<AgentRunResult, "session">): { outcome: NotFixedOutcome; why: string | null } {
  const extras = runExtras(run)
  const stopped = run.outcome === "timeout" ? `the agent ran out of its ${FIX_ROUND_MINUTES} minutes` : run.outcome === "error" ? "the agent stopped with an error" : run.outcome === "toolless" ? "the agent could not use its tools" : null
  const changed = [...new Set(run.reverted.filter((path) => !path.startsWith(".git/") && path !== ".git"))]
  if (stopped && changed.length > 0) return { outcome: "undone", why: `${stopped}; its unfinished change to ${listPaths(changed)} was undone` }
  if (extras.gateHits.length > 0) return { outcome: "gate_refused", why: [...new Set(extras.gateHits.map((hit) => hit.note))].join("; ") }
  if (extras.blocked.length > 0 || extras.strays.length > 0) {
    const notes = [...extras.blocked.map((block) => block.note), ...extras.strays.map((stray) => stray.note)]
    return { outcome: "blocked", why: [...new Set(notes.map((note) => `the wizard ${note.charAt(0).toLowerCase()}${note.slice(1).replace(/\.$/, "")}`))].join("; ") }
  }
  const outcome: NotFixedOutcome = run.outcome === "timeout" ? "timeout" : run.outcome === "toolless" ? "toolless" : run.outcome === "error" ? "error" : "no_change"
  return { outcome, why: null }
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ")
  return paths.length > 3 ? `${shown} +${paths.length - 3} more` : shown
}

export const step: WizardStep<"review"> = {
  id: "review",
  title: meta.title,
  who: [...meta.who],
  learn: meta.learn,
  requiredCapabilities: [...meta.requiredCapabilities],
  inputHash: (ctx) => {
    const state = ctx.state?.get?.()
    return sha256(`review:${state?.git?.headSha ?? ""}:${state?.agent?.reviewer ?? ""}:${state?.pr?.number ?? ""}`)
  },
  run
}
