// Step 9 `review` (§3d.1, §3g.4, lane O4): the OTHER agent reviews the PR read-only in a detached worktree of
// the head → the wizard scans the review and posts it as ONE `event: COMMENT` review → reads the threads back
// under the trust rules → triages (FIX / DECLINE / ANSWER / ASK) → fixes through the worker (job 16, ≤ 2 rounds)
// → commits, pushes, proves the new head descends from the old → replies on its own threads (and on a
// teammate's only with the user's OK) → resolves only its own fixed threads → re-rehearses → `gh pr ready` + the
// final comment. With one agent it writes and prints the review brief instead.
import { createHash } from "node:crypto"
import { join } from "node:path"

import type { AgentKind, ReviewFailure, ReviewResult } from "../contracts/agents.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { PR_LOOP_LIMITS } from "../contracts/git-host.js"
import type { CheckResult } from "../contracts/jobs.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { isGloballyDenied } from "../../git/commit.js"
import { isGitHubAdapter, type GitHubHostAdapter } from "../../hosts/github.js"
import { isUnsupported } from "../../hosts/other.js"
import { parseBriefReview, printedReviewBrief, reviewerBrief } from "../../review/brief.js"
import { allowlistUnion, assertNoAgentAlive, manifestFiles, status, sub } from "../../review/context.js"
import { parseUnifiedDiff } from "../../review/diff.js"
import { job16Item, runFixRound, verifyFix } from "../../review/fix.js"
import { parseLedger, recordDecisions, REVIEW_LEDGER_PATH, type ReviewLedger } from "../../review/ledger.js"
import { commentTrust, hasReplyMarker, parseReviewMarker } from "../../review/markers.js"
import { AGENT_LABEL, buildFinalComment, buildReply, buildReviewPost, excerpt, redactIdsNotInDiff, safeText } from "../../review/post.js"
import { recordRehearsalCells, rehearse } from "../../review/rehearse.js"
import { mergeRequirementLine } from "../../github/rules.js"
import { checksSummary } from "../../github/checks.js"
import { DETERMINISTIC_CHECKS_BY_ITEM, triage, triageKey, type TriageDecision, type TriageItem } from "../../review/triage.js"
import { stageAndCommit, failed, pushBranch } from "../../review/ship.js"
import { announceRehearsal, commitStop, evidenceUrls, isShipContext, prepareShip, recordClickTests, type ShipContext } from "./rehearsal.js"

const meta = WIZARD_STEP_META.review
const REVIEW_INPUT_DIR = ".infinite/review"
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
  untrusted: Array<{ author: string; path: string | null; excerpt: string }>
  notes: string[]
  reviewed: boolean
  reviewer: AgentKind | "brief" | null
}

async function saveLedger(session: Session): Promise<void> {
  const path = join(session.ctx.root, REVIEW_LEDGER_PATH)
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
  const plan = {
    approvedPlanLines: (state.plan?.lines ?? []).filter((line) => line.approved === true).map((line) => line.id),
    allowlist: allowlistUnion(state.jobs),
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
  await deps.fs.writeTextAtomic(join(dir, names.diff), diff, 0o600)
  await deps.fs.writeTextAtomic(join(dir, names.plan), `${JSON.stringify(plan, null, 2)}\n`, 0o600)
  await deps.fs.writeTextAtomic(join(dir, names.checks), `${JSON.stringify(checks, null, 2)}\n`, 0o600)
  return names
}

/** Runs the reviewer agent on `head` (one retry when its JSON does not parse). */
async function runReviewer(session: Session, reviewer: AgentKind, round: number, head: string, fromSha: string, openItems: string[]): Promise<ReviewResult | ReviewFailure> {
  const { ship, deps, ctx } = session
  const worktree = await ship.git.worktreeAddDetached(head)
  try {
    const inputs = await writeReviewInputs(session, worktree.dir, await ship.git.diff(fromSha, head))
    const brief = reviewerBrief({
      prNumber: session.number,
      repoLabel: ship.repoLabel,
      tagVersion: deps.tagVersion,
      runId: ship.runId,
      reReview: round > 1 ? { fromSha, toSha: head, openItems } : null,
      inputs
    })
    sub(ctx, "review", `${AGENT_LABEL[reviewer]} is reviewing (read-only)…`, "pending")
    let result = await deps.agents.review({ worktreeDir: worktree.dir, reviewer, brief })
    if ("error" in result && result.error === "unparseable") {
      result = await deps.agents.review({
        worktreeDir: worktree.dir,
        reviewer,
        brief: `${brief}\n\nYour previous answer did not match the JSON schema. Return JSON only, exactly matching it.`
      })
    }
    return result
  } finally {
    await ship.git.worktreeRemove(worktree.dir)
  }
}

/** Scans and posts one review round (GitHub: one COMMENT review; elsewhere: `.infinite/wizard/REVIEW.md`). */
async function postRound(session: Session, review: ReviewResult, reviewer: AgentKind, round: number, head: string): Promise<void> {
  const { ship, deps, ctx } = session
  const state = ctx.state.get()
  const fullDiff = await ship.git.diff(state.git!.baseSha, head)
  const post = buildReviewPost({ review, diffFiles: parseUnifiedDiff(fullDiff), scanner: ship.scanner, runId: ship.runId, round, head, reviewer })
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
  const n = review.findings.length
  sub(ctx, "review", n === 0 ? `${AGENT_LABEL[reviewer]}: no comments` : `${AGENT_LABEL[reviewer]} left ${n} comment${n === 1 ? "" : "s"}`, n === 0 ? "ok" : "info")
}

const FINDING_LABEL = /\*\*\[R\d{1,2} [a-z]+\]\*\* (F\d{1,2})/

/** Reviewer findings + teammate threads (after the user's OK), as triage items; strangers' threads are listed only. */
async function gatherItems(session: Session, review: ReviewResult, round: number, head: string): Promise<{ items: TriageItem[]; teammateOk: Set<string>; ownThreadByFinding: Map<string, string> }> {
  const { ctx, ship } = session
  const ownThreadByFinding = new Map<string, string>()
  const teammateOk = new Set<string>()
  const items: TriageItem[] = review.findings.map((finding) => ({
    source: "reviewer",
    threadId: null,
    findingId: finding.id,
    item: finding.item,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    body: safeText(ship.scanner, finding.body),
    suggestedFix: finding.suggested_fix === null ? null : safeText(ship.scanner, finding.suggested_fix)
  }))
  if (!session.github || session.number === null) return { items, teammateOk, ownThreadByFinding }
  const threads = await session.github.readThreadDetails(session.number)
  const handled = new Set(ctx.state.get().pr?.handledThreadIds ?? [])
  const teammateThreads: typeof threads = []
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
    const last = thread.comments[thread.comments.length - 1]!
    if (hasReplyMarker(last.body)) continue
    if (trust === "teammate") teammateThreads.push(thread)
    else session.untrusted.push({ author: first.author, path: thread.path, excerpt: safeText(ship.scanner, first.body) })
  }
  for (const item of items) item.threadId = ownThreadByFinding.get(item.findingId ?? "") ?? null
  const strangers = session.untrusted.length
  if (strangers > 0) sub(ctx, "review", `${strangers} comment(s) from people outside the repo are shown, not acted on`, "info")
  if (teammateThreads.length > 0) {
    const answer = await ctx.ask("teammate-comments", {
      comments: teammateThreads.map((thread) => ({
        threadId: thread.threadId,
        author: thread.author,
        path: thread.path ?? "",
        line: thread.line,
        excerpt: excerpt(safeText(ship.scanner, thread.body), 200)
      }))
    })
    const actOn = typeof answer === "object" && answer !== null && Array.isArray(answer.actOn) ? answer.actOn : []
    for (const thread of teammateThreads) {
      if (!actOn.includes(thread.threadId)) {
        // Not OK'd: never acted on, never replied to, never asked again.
        ctx.state.update((state) => {
          if (state.pr && !state.pr.handledThreadIds.includes(thread.threadId)) state.pr.handledThreadIds.push(thread.threadId)
        })
        continue
      }
      teammateOk.add(thread.threadId)
      const lastHuman = [...thread.comments].reverse().find((comment) => !hasReplyMarker(comment.body)) ?? thread.comments[0]!
      items.push({
        source: "teammate",
        threadId: thread.threadId,
        findingId: null,
        item: null,
        severity: "should",
        path: thread.path,
        line: thread.line,
        body: safeText(ship.scanner, lastHuman.body),
        suggestedFix: null
      })
    }
  }
  return { items, teammateOk, ownThreadByFinding }
}

function passingChecks(ctx: WizardContext): Set<string> {
  const state = ctx.state.get()
  const out = new Set<string>()
  for (const job of state.jobs) for (const check of job.checks) if (check.state === "pass") out.add(check.id)
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
      decision.item.path !== null &&
      !isGloballyDenied(decision.item.path) &&
      (decision.askReason === "allowlist_widening" || decision.askReason === "reviewer_conflict" || decision.askReason === "raised_after_decline")
    if (!askable) {
      out.push(decision)
      continue
    }
    const who = decision.item.source === "teammate" ? "A teammate" : "The reviewer"
    const where = `${decision.item.path}${decision.item.line ? `:${decision.item.line}` : ""}`
    const answer = await session.ctx.ask("single", {
      question: `${who} on ${where}: “${excerpt(decision.item.body, 140)}” ${decision.reason} Let the agent fix it?`,
      options: [
        { label: "Fix it", value: "fix" },
        { label: "Leave it", value: "leave" }
      ],
      default: "leave"
    })
    if (answer === "fix") {
      session.ledger.open = session.ledger.open.filter((entry) => entry.key !== triageKey(decision.item))
      out.push({ ...decision, action: "FIX", reason: "You approved this fix.", askReason: undefined })
    } else {
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
    if (pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "DIRTY") {
      sub(ctx, "review", "The base moved: updating the branch with a merge commit…", "info")
      await session.github.updateBranch(session.number)
      head = (await ship.git.pullFfOnly(gitState.branch)).headSha
    }
  }
  ctx.state.update((state) => {
    if (state.git) state.git.headSha = head
  })
  return { head }
}

/** Replies on the wizard's own threads (and teammates' OK'd threads); resolves only its own FIXED threads. */
async function replyAndResolve(session: Session, decisions: readonly TriageDecision[], teammateOk: ReadonlySet<string>, fixSha: string | null, fixedIds: ReadonlySet<string>): Promise<void> {
  if (!session.github) return
  for (const decision of decisions) {
    const threadId = decision.item.threadId
    if (!threadId) continue
    const own = decision.item.source === "reviewer"
    if (!own && !teammateOk.has(threadId)) continue
    const fixed = decision.action === "FIX" && fixSha !== null && fixedIds.has(threadId)
    await session.github.reply(threadId, buildReply(session.ship.scanner, decision, fixed ? fixSha : null))
    if (own && fixed) await session.github.resolve(threadId)
    session.ctx.state.update((state) => {
      if (state.pr && !state.pr.handledThreadIds.includes(threadId)) state.pr.handledThreadIds.push(threadId)
    })
  }
}

/** §3g.4 step 9: ready + the final comment (or REVIEW.md off GitHub). */
async function finish(session: Session): Promise<void> {
  const { ctx, deps, ship } = session
  const state = ctx.state.get()
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
    const checks = await session.github.checks(session.number).catch(() => [])
    if (!isUnsupported(checks) && checks.length > 0) {
      const summary = checksSummary(checks)
      session.notes.push(`Required checks: ${summary.pass} pass · ${summary.fail} fail · ${summary.pending} pending.`)
    }
  }
  const report = deps.report.build({
    runId: ship.runId,
    tagVersion: deps.tagVersion,
    site: { repoLabel: ship.repoLabel, productionHost: ship.facts.productionHost },
    columns: ctx.state.get().report,
    provenLivePending: "deploy",
    day7: null,
    notes: []
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
    reportMarkdown: deps.report.renderMarkdown(report),
    reviewer: session.reviewer,
    reviewed: session.reviewed,
    jobs: ctx.state.get().jobs,
    decisions: [...session.decisions, ...openFromLedger],
    untrusted: session.untrusted,
    notes: session.notes,
    scanner: ship.scanner
  })
  if (!ship.isPrivate) comment = redactIdsNotInDiff(comment, await ship.git.diff(state.git!.baseSha, await ship.git.head()), ship.facts.connectionIds)
  if (session.github && session.number !== null) {
    await session.github.comment(session.number, comment)
  } else {
    const path = join(ctx.root, WIZARD_PATHS.review)
    const previous = (await deps.fs.readText(path)) ?? ""
    await deps.fs.writeTextAtomic(path, `${previous}${previous ? "\n\n" : ""}${comment}`, 0o600)
  }
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

async function prMerged(session: Session): Promise<boolean> {
  if (!session.github || session.number === null) return false
  const pr = await session.github.readPr(session.number)
  return pr.state === "MERGED"
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
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
  if (await prMerged(session)) return mergedEarly(session)

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
      await finish(session)
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
  for (let round = 1; round <= PR_LOOP_LIMITS.maxFixRounds; round += 1) {
    if (await prMerged(session)) return mergedEarly(session)
    const head = await prepared.git.head()
    let review: ReviewResult
    if (round === 1 && briefReview) {
      review = briefReview
    } else if (agentReviewer) {
      const openItems = session.ledger.open.map((entry) => `${entry.path ?? "general"}: ${entry.excerpt.slice(0, 120)}`)
      const result = await runReviewer(session, agentReviewer, round, head, round === 1 ? gitState.baseSha : reviewedSha, openItems)
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
      review = result
      await postRound(session, review, agentReviewer, round, head)
    } else {
      break
    }
    session.reviewed = true
    reviewedSha = head
    session.ledger.rounds.push({ round, reviewedSha: head, reviewer: agentReviewer ?? "brief", fixSha: null })
    ctx.state.update((draft) => {
      if (draft.pr) {
        draft.pr.reviewedSha = head
        draft.pr.round = round
      }
    })

    const gathered = await gatherItems(session, review, round, head)
    const declinedKeys = new Set(session.ledger.declined.map((entry) => entry.key))
    const triaged = triage(gathered.items, {
      allowlist: [...allowlistUnion(ctx.state.get().jobs), ...managed],
      declinedKeys,
      passingChecks: passingChecks(ctx),
      answerFor: answerFrom(ctx)
    })
    const decisions = await resolveAsks(session, triaged, worker !== null)
    recordDecisions(session.ledger, decisions, round)
    session.decisions.push(...decisions)
    const fixes = decisions.filter((decision) => decision.action === "FIX")
    let fixSha: string | null = null
    const fixedThreadIds = new Set<string>()

    if (fixes.length > 0 && worker === null) {
      session.notes.push("No worker agent was available, so the valid comments are listed for you to fix.")
    } else if (fixes.length > 0 && worker !== null) {
      const items = fixes.map((decision, index) => job16Item(decision, index))
      for (const item of items) ctx.emit.emit("job.seeded", { item })
      sub(ctx, "review", `${AGENT_LABEL[worker]} is fixing ${items.length} comment${items.length === 1 ? "" : "s"}…`, "pending")
      const prevHead = head
      const fix = await runFixRound(ctx, deps, { step: "review", worker, items, scanner: prepared.scanner })
      if (fix.run.outcome === "out_of_usage") {
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
      const verified = await verifyFix(ctx, deps, { runId: prepared.runId, items: fix.items, editedFiles: edited })
      let finalItems = verified.items
      if (!verified.buildOk) {
        session.notes.push(`Round ${round}: the agent's fixes broke the build, so the wizard did not commit them.`)
      } else if (edited.length > 0) {
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
          sub(ctx, "review", `${AGENT_LABEL[worker]} fixed ${items.length} · new commit ${commit.sha.slice(0, 7)}`, "ok")
          if (session.github && session.number !== null) {
            const checks = await session.github.checks(session.number)
            if (!isUnsupported(checks)) {
              const summary = checksSummary(checks)
              const result: CheckResult = {
                checkId: "pr_checks_pass",
                tier: "S",
                state: summary.fail > 0 ? "problem" : summary.pending > 0 || summary.total === 0 ? "undetermined" : "pass",
                ...(summary.fail > 0 ? { reason: `${summary.fail} required check(s) failing` } : summary.pending > 0 ? { reason: "checks pending" } : {}),
                at: ctx.now().toISOString(),
                runId: prepared.runId
              }
              finalItems = deps.registry.apply(finalItems, [result], prepared.runId)
            }
          }
          for (const [index, decision] of fixes.entries()) {
            const item = finalItems.find((candidate) => candidate.id === items[index]!.id)
            const committedFile = item ? commit.staged.includes(item.allow.files[0] ?? "") : false
            if (decision.item.threadId && committedFile && item && (item.state === "done_in_code" || item.state === "waiting_deploy" || item.state === "proven")) {
              fixedThreadIds.add(decision.item.threadId)
            }
          }
          const outcome = await rehearse(ctx, deps, {
            step: "review",
            runId: prepared.runId,
            head: fixSha,
            facts: prepared.facts,
            approvedConversions: ctx.state.get().plan?.answers.conversions ?? [],
            evidenceUrls: evidenceUrls(ctx),
            consentRequired: ctx.state.get().plan?.answers.consentMode === "required"
          })
          announceRehearsal(ctx, "review", outcome, prepared.runId)
          recordRehearsalCells(ctx, outcome, { head: fixSha, runId: prepared.runId })
          sub(ctx, "review", outcome.state === "graded" ? "✓ Rehearsal re-run on the new commit" : "Rehearsal on the new commit: undetermined", outcome.state === "graded" ? "ok" : "warn")
          const newNames = outcome.clickTested
          if (newNames.length > 0) {
            assertNoAgentAlive(deps, "runs PATCH")
            await deps.bridge.patchRun(prepared.runId, { prHeadSha: fixSha, clickTestedConversions: newNames })
            await recordClickTests(ctx, deps, { step: "review", runId: prepared.runId, outcome, approved: ctx.state.get().plan?.answers.conversions ?? [] })
          }
          session.ledger.rounds[session.ledger.rounds.length - 1]!.fixSha = fixSha
        }
      }
      ctx.state.update((draft) => {
        const known = new Set(draft.jobs.map((job) => job.id))
        draft.jobs = [...draft.jobs.map((job) => finalItems.find((item) => item.id === job.id) ?? job), ...finalItems.filter((item) => !known.has(item.id))]
      })
    }
    await replyAndResolve(session, decisions, gathered.teammateOk, fixSha, fixedThreadIds)
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
  const who = session.reviewed ? `reviewed by ${agentReviewer ? AGENT_LABEL[agentReviewer] : "your agent (brief)"}` : "no second review"
  const line = `${final.pr?.number ? `Pull request #${final.pr.number}` : "Branch"} · ${who} · ${rehearsalText}`
  status(ctx, "review", line)
  return { kind: "ok", status: line }
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
