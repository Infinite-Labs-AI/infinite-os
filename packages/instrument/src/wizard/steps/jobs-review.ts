// The jobs' review: right after the coding agent's turns and BEFORE the edits settle, the same read-only reviewer as
// step 9 answers each job's questions (`review/questions.ts`): the judgements of meaning that used to be static checks
// and that regex read wrong in both directions.
//
//   - inputs (in a throwaway detached worktree holding the uncommitted tree, never `.env*`): the agent's diff, each job's
//     brief, the questions with the job's files, the agent's claim note and the wizard's own check results;
//   - each answer is pass / fail / cant_tell with file:line evidence (`JOB_REVIEW_SCHEMA`, strict-mode safe);
//   - a "fail" goes back to the coding agent as ONE normal fix round with the reviewer's words (the jobs step's resume
//     path), then ONE re-review of the failed questions;
//   - pass → the job is proven by the review ("checked by the review agent"); still failing → its edits are KEPT and it
//     "needs your look" with the reviewer's finding; cant_tell → kept, with why; no review possible (no reviewer, a
//     refused or timed-out request, nothing usable after the other agent was asked) → kept, and the pull request must stay
//     a draft (`jobsReviewKeepsDraft`, read by the PR's draft rule).
// A review answer NEVER reverts an edit: only the hard checks (S/B/T0) and the fence can put work back.
import { randomBytes } from "node:crypto"
import { copyFile, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import { git } from "../../agents/git-exec.js"
import { AGENT_LABEL } from "../../agents/narration.js"
import { sanitizeUntrusted } from "../../agents/sanitize.js"
import { CHECK_LABELS } from "../../jobs/check-words.js"
import { applyReview, withNote, type Transition } from "../../jobs/state-machine.js"
import { jobsReviewerBrief } from "../../review/brief.js"
import { reviewQuestionsFor, type QuestionFacts, type ReviewQuestion } from "../../review/questions.js"
import type { Scanner } from "../../review/scan.js"
import type { AgentKind, JobReviewResult, ReviewFailure } from "../contracts/agents.js"
import type { WizardContext, WizardDeps } from "../contracts/deps.js"
import type { ChecklistItem, Evidence, ItemReview, ItemReviewQuestion, JobItemState } from "../contracts/jobs.js"
import { jobStaticRunContext } from "../deps.js"
import { fallbackReviewer, reviewFailureWords, reviewOutcome, shouldAskAgain, usableReviewers, type ReviewAttempt } from "../review-outcome.js"

/** Where the jobs' review inputs go in the reviewer's worktree (the step-9 review's folder; the fake agents read it). */
export const JOBS_REVIEW_DIR = ".infinite/review"
export const JOBS_REVIEW_INPUTS = {
  readCheck: `${JOBS_REVIEW_DIR}/read-check.txt`,
  diff: `${JOBS_REVIEW_DIR}/jobs-diff.patch`,
  questions: `${JOBS_REVIEW_DIR}/jobs-questions.json`,
  briefs: `${JOBS_REVIEW_DIR}/jobs-briefs.md`
} as const

/** Item states a review answer applies to: the agent's work is in the tree and no hard check failed it. */
const REVIEWABLE: readonly JobItemState[] = ["claimed", "done_in_code", "waiting_deploy", "waiting_real_event"]

/** What the jobs step lends the review (its `JobsIo`). */
export interface JobsReviewHost {
  ctx: WizardContext
  deps: WizardDeps
  noteScanner: Scanner
  items(): ChecklistItem[]
  item(id: string): ChecklistItem | undefined
  put(transition: Transition, noteOverride?: string): void
  runId(): string | null
  sub(text: string, tone: "ok" | "warn" | "info" | "pending"): void
  /** The files the coding agent changed in this step (its kept, not yet settled, edits). */
  editedFiles(): string[]
  /** The question facts, when the host already holds them (else they are read from the run's hand-off files). */
  questionFacts?(): QuestionFacts
}

export interface JobsReviewOptions {
  /** One fix round may still go back to the agent (a worker session is there to resume). */
  fixRound: boolean
  /** A re-review after the fix round: only these items' failed questions are asked again. */
  reReview?: readonly string[]
}

export type JobsReviewOutcome =
  | { kind: "done" }
  /** Failing answers go back to the agent: these items are `pending` with the reviewer's words. */
  | { kind: "fix"; itemIds: string[]; feedback: string[]; restore: Map<string, ChecklistItem> }

/** The question facts for this run (its hand-off files: the inventory, the approved names, the production hosts). */
export function questionFacts(root: string, runId: string | null): QuestionFacts {
  try {
    const run = jobStaticRunContext(root, runId)
    return {
      ...(run.eventInventory ? { inventory: run.eventInventory } : {}),
      ...(run.metaInUse !== undefined ? { metaInUse: run.metaInUse } : {}),
      ...(run.conversionNames ? { conversionNames: run.conversionNames } : {}),
      ...(run.productionHosts ? { productionHosts: run.productionHosts } : {})
    }
  } catch {
    return {}
  }
}

/** Whether the pull request must stay a draft because a job's review did not run, and why (plain words). */
export function jobsReviewKeepsDraft(items: readonly ChecklistItem[], runId: string | null): { keepDraft: boolean; reason: string | null } {
  const missed = items.find((item) => item.review?.state === "not_run" && (runId === null || item.review.runId === runId))
  return missed ? { keepDraft: true, reason: `No review agent checked the jobs' work: ${missed.review!.reason ?? "it did not run"}` } : { keepDraft: false, reason: null }
}

interface Asked {
  question: ReviewQuestion
  /** `Q<n>`, the id the reviewer answers under. */
  qid: string
}

/** The questions to ask now, per item: all of them, or (re-review) only those answered "fail". */
function questionsToAsk(item: ChecklistItem, all: readonly ReviewQuestion[], reReview: boolean): ReviewQuestion[] {
  if (!reReview || !item.review) return [...all]
  const failed = new Set(item.review.questions.filter((question) => question.answer === "fail").map((question) => question.id))
  return all.filter((question) => failed.has(question.id))
}

/** The item's stored answers: this review's answers over the earlier ones (a re-review keeps the earlier passes). */
function mergedAnswers(item: ChecklistItem, all: readonly ReviewQuestion[], asked: readonly Asked[], answers: ReadonlyMap<string, JobReviewResult["answers"][number]>, scanner: Scanner): ItemReviewQuestion[] {
  return all.map((question) => {
    const ask = asked.find((entry) => entry.question.itemId === item.id && entry.question.id === question.id)
    const earlier = item.review?.questions.find((entry) => entry.id === question.id)
    if (!ask) return earlier ? { ...earlier, text: question.text } : { id: question.id, text: question.text, answer: "not_asked" }
    const answer = answers.get(ask.qid)
    if (!answer) return { id: question.id, text: question.text, answer: "cant_tell", note: "The review gave no answer to this question." }
    const evidence: Evidence[] = answer.evidence.filter((entry) => entry.path.trim() !== "").map((entry) => ({ file: sanitizeUntrusted(entry.path, 300), line: entry.line ?? 1 }))
    const note = sanitizeUntrusted(scanner.redact(answer.note).text, 500)
    return { id: question.id, text: question.text, answer: answer.answer, ...(note ? { note } : {}), ...(evidence.length > 0 ? { evidence } : {}) }
  })
}

const at = (entry: Evidence) => ("file" in entry ? `${entry.file}:${entry.line}` : entry.url)

/** The reviewer's finding on one question, in plain words (its note, then where). */
function findingWords(question: ItemReviewQuestion): string {
  const where = question.evidence?.length ? ` (${question.evidence.slice(0, 2).map(at).join(", ")})` : ""
  return `${question.note ?? "the review answered no"}${where}`
}

/** One item's verdict from its answers. */
function verdictOf(questions: readonly ItemReviewQuestion[]): { state: ItemReview["state"]; reason?: string } {
  const failed = questions.find((question) => question.answer === "fail")
  if (failed) return { state: "fail", reason: findingWords(failed) }
  const unsure = questions.find((question) => question.answer === "cant_tell" || question.answer === "not_asked")
  if (unsure) return { state: "cant_tell", reason: unsure.note ?? "the review did not answer every question" }
  return { state: "pass" }
}

/** The uncommitted tree in a throwaway detached worktree (only changed files are copied; never `.env*`). */
async function reviewTree(host: JobsReviewHost): Promise<{ dir: string; diff: string }> {
  const { ctx, deps } = host
  const { dir } = await deps.git.worktreeAddDetached(await deps.git.head())
  const status = await git(ctx.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const entries = status.stdout.toString("utf8").split("\0").filter(Boolean)
  const untracked: string[] = []
  const changed: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code.startsWith("R") || code.startsWith("C")) index += 1
    if (/(?:^|\/)\.env/.test(path) || /^(?:\.git|\.infinite|node_modules)\//.test(path) || path.includes("..")) continue
    changed.push(path)
    if (code === "??") untracked.push(path)
    const from = join(ctx.root, path)
    const to = join(dir, path)
    try {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    } catch {
      await rm(to, { force: true })
    }
  }
  if (untracked.length > 0) await git(dir, ["add", "--intent-to-add", "--", ...untracked])
  const edited = host.editedFiles().filter((file) => changed.includes(file))
  const diff = await git(dir, ["diff", "HEAD", "--", ...(edited.length > 0 ? edited : changed)])
  return { dir, diff: diff.stdout.toString("utf8") }
}

/** One reviewer run (its one re-ask for a broken answer, and one more when it shows it could not read the files). */
async function runJobsReviewer(host: JobsReviewHost, reviewer: AgentKind, dir: string, brief: string, nonce: string): Promise<JobReviewResult | ReviewFailure> {
  const reviewJobs = host.deps.agents.reviewJobs!.bind(host.deps.agents)
  const onNarrate = (beat: { agent: AgentKind; role: "reviewer"; text: string }) => host.ctx.emit.emit("narrate", beat)
  const once = async (text: string) => {
    let result = await reviewJobs({ worktreeDir: dir, reviewer, brief: text, schema: "jobs", onNarrate })
    if (shouldAskAgain(result)) result = await reviewJobs({ worktreeDir: dir, reviewer, brief: `${text}\n\nYour previous answer did not match the JSON schema. Return JSON only, exactly matching it.`, schema: "jobs", onNarrate })
    return result
  }
  const read = (result: JobReviewResult | ReviewFailure) => "error" in result || result.summary.trimStart().startsWith(`read-check: ${nonce}`)
  let result = await once(brief)
  if (!read(result)) result = await once(`${brief}\n\nYour last answer shows you could not read the files. Read them now with the read-only commands named above, then answer.`)
  if (!read(result)) return { error: "error", message: "it could not read the change" }
  return result
}

/**
 * Asks the jobs' questions, records each answer on its item and decides the item (`applyReview`), or sends the failing
 * ones back to the agent for the one fix round. Never reverts an edit.
 */
export async function reviewJobsBeforeSettling(host: JobsReviewHost, options: JobsReviewOptions): Promise<JobsReviewOutcome> {
  const runId = host.runId()
  if (!runId) return { kind: "done" }
  const facts = host.questionFacts?.() ?? questionFacts(host.ctx.root, runId)
  const reReview = new Set(options.reReview ?? [])
  const plan: Array<{ item: ChecklistItem; all: ReviewQuestion[]; ask: ReviewQuestion[] }> = []
  for (const item of host.items()) {
    if (item.owner !== "agent" || !REVIEWABLE.includes(item.state)) continue
    const all = reviewQuestionsFor(item, facts)
    if (all.length === 0) continue
    const decided = item.review?.runId === runId
    if (decided && !reReview.has(item.id)) continue
    const ask = questionsToAsk(item, all, reReview.has(item.id))
    if (ask.length > 0) plan.push({ item, all, ask })
  }
  if (plan.length === 0) return { kind: "done" }
  const now = () => host.deps.clock.now().toISOString()
  const notRun = (reason: string) => {
    for (const { item, all } of plan) {
      // A re-review that could not run leaves the earlier finding standing ("needs your look"), never "not checked".
      if (item.review?.runId === runId && item.review.state === "fail") {
        host.put(applyReview(item, { ...item.review, at: now() }, { scanner: host.noteScanner }))
        continue
      }
      const questions = all.map((question) => item.review?.questions.find((entry) => entry.id === question.id && entry.answer !== "not_asked") ?? { id: question.id, text: question.text, answer: "not_asked" as const })
      host.put(applyReview(item, { state: "not_run", runId, at: now(), reviewer: null, reason, questions, ...(item.review?.fixRound ? { fixRound: true } : {}) }, { scanner: host.noteScanner }))
    }
    host.sub(`No review agent checked the jobs: ${reason}. The edits are kept and the pull request stays a draft.`, "warn")
    return { kind: "done" as const }
  }
  const planned = host.ctx.state.get().agent?.reviewer ?? null
  if (planned !== "claude_code" && planned !== "codex") return notRun("no review agent was chosen for this run")
  if (!host.deps.agents.reviewJobs) return notRun(`${AGENT_LABEL[planned]} cannot answer the jobs' questions in this version`)

  const asked: Asked[] = plan.flatMap(({ ask }) => ask).map((question, index) => ({ question, qid: `Q${index + 1}` }))
  let tree: { dir: string; diff: string } | null = null
  let reviewer: AgentKind = planned
  let result: JobReviewResult | ReviewFailure
  try {
    tree = await reviewTree(host)
    const nonce = randomBytes(8).toString("hex")
    const write = (path: string, text: string) => host.deps.fs.writeTextAtomic(join(tree!.dir, path), text, 0o600)
    await host.deps.fs.mkdirp(join(tree.dir, JOBS_REVIEW_DIR), 0o700)
    await write(JOBS_REVIEW_INPUTS.readCheck, `${nonce}\n`)
    await write(JOBS_REVIEW_INPUTS.diff, tree.diff)
    await write(JOBS_REVIEW_INPUTS.briefs, host.deps.registry.brief(plan.map(({ item }) => item)))
    await write(JOBS_REVIEW_INPUTS.questions, `${JSON.stringify(questionsFile(plan, asked, facts, host.noteScanner), null, 2)}\n`)
    const brief = (agent: AgentKind) => jobsReviewerBrief({ reviewer: agent, readCheck: JOBS_REVIEW_INPUTS.readCheck, inputs: { diff: JOBS_REVIEW_INPUTS.diff, questions: JOBS_REVIEW_INPUTS.questions, briefs: JOBS_REVIEW_INPUTS.briefs }, reReview: reReview.size > 0 })
    host.sub(`${AGENT_LABEL[reviewer]} is checking the jobs' work (read-only, ${asked.length} question${asked.length === 1 ? "" : "s"})…`, "pending")
    host.ctx.emit.emit("narrate", { agent: reviewer, role: "reviewer", text: "Reading the jobs' changes (read-only)" })
    result = await runJobsReviewer(host, reviewer, tree.dir, brief(reviewer), nonce)
    // The shared rule for a review that did not run (`review-outcome.ts`): the other installed agent is asked once,
    // read-only; if none answers, nothing is decided by a review and the pull request stays a draft.
    const attempts: ReviewAttempt[] = []
    if ("error" in result) {
      attempts.push({ reviewer, result })
      const other = fallbackReviewer(reviewer, result, usableReviewers(await host.deps.agents.detect()), [reviewer])
      if (other) {
        host.sub(`${reviewFailureWords(reviewer, result)}; asking ${AGENT_LABEL[other]} to check the jobs instead (read-only)`, "info")
        reviewer = other
        result = await runJobsReviewer(host, reviewer, tree.dir, brief(reviewer), nonce)
        if ("error" in result) attempts.push({ reviewer, result })
      }
    }
    const outcome = reviewOutcome("error" in result ? attempts : [...attempts, { reviewer, result }])
    if (!outcome.ran) return notRun(outcome.reasonWords)
  } catch (error) {
    return notRun(`the review could not be prepared (${sanitizeUntrusted(error instanceof Error ? error.message : String(error), 120)})`)
  } finally {
    if (tree) await host.deps.git.worktreeRemove(tree.dir).catch(() => undefined)
  }
  if ("error" in result) return notRun(reviewFailureWords(reviewer, result))

  const answers = new Map(result.answers.map((answer) => [answer.question_id, answer]))
  const feedback: string[] = []
  const back: string[] = []
  const restore = new Map<string, ChecklistItem>()
  for (const { item, all } of plan) {
    const current = host.item(item.id) ?? item
    const questions = mergedAnswers(current, all, asked, answers, host.noteScanner)
    const verdict = verdictOf(questions)
    const review: ItemReview = { state: verdict.state, runId, at: now(), reviewer, ...(verdict.reason ? { reason: verdict.reason } : {}), questions, ...(current.review?.fixRound ? { fixRound: true } : {}) }
    if (verdict.state === "fail" && options.fixRound && !current.review?.fixRound) {
      // The one fix round: the item goes back to the agent with the reviewer's words; its edits stay in the tree.
      restore.set(current.id, structuredClone(current))
      const next: ChecklistItem = { ...structuredClone(current), state: "pending", review: { ...review, fixRound: true } }
      const note = `The review agent found: ${verdict.reason}`
      withNote(next, note, host.noteScanner)
      host.put({ item: next, changed: true, by: "wizard", note })
      back.push(current.id)
      for (const question of questions.filter((entry) => entry.answer === "fail")) {
        feedback.push(`- ${current.id}: the review agent answered no to "${question.text}" Its finding: ${findingWords(question)}. Fix it in this job's files, then claim the job again.`)
      }
      continue
    }
    host.put(applyReview(current, review, { scanner: host.noteScanner }))
  }
  const passed = plan.filter(({ item }) => host.item(item.id)?.review?.state === "pass").length
  host.sub(`${AGENT_LABEL[reviewer]} checked ${plan.length} job${plan.length === 1 ? "" : "s"}: ${passed} passed${back.length > 0 ? `, ${back.length} back to the agent for one fix round` : ""}`, back.length > 0 ? "info" : "ok")
  return back.length > 0 ? { kind: "fix", itemIds: back, feedback, restore } : { kind: "done" }
}

/** The reviewer's questions file: per job, its files, the agent's note, the wizard's own results and the questions. */
function questionsFile(plan: ReadonlyArray<{ item: ChecklistItem; ask: ReviewQuestion[] }>, asked: readonly Asked[], facts: QuestionFacts, scanner: Scanner) {
  return {
    jobs: plan.map(({ item }) => ({
      job: item.id,
      title: item.title,
      files: [...item.allow.files, ...item.allow.create],
      agentNote: item.claim?.note ? sanitizeUntrusted(scanner.redact(item.claim.note).text, 500) : null,
      wizardChecks: item.checks
        .filter((check) => ["S", "B", "T0"].includes(check.tier))
        .map((check) => ({ check: CHECK_LABELS[check.id] ?? check.id, state: check.state, reason: check.reason ? sanitizeUntrusted(check.reason, 300) : null })),
      ...(item.keptForReview ? { sharedWith: item.keptForReview } : {}),
      questions: asked
        .filter((entry) => entry.question.itemId === item.id)
        .map((entry) => {
          const earlier = item.review?.questions.find((question) => question.id === entry.question.id && question.answer !== "not_asked")
          return { question_id: entry.qid, question: entry.question.text, ...(earlier ? { earlierAnswer: { answer: earlier.answer, note: earlier.note ?? null } } : {}) }
        })
    })),
    eventInventory: facts.inventory ?? null
  }
}
