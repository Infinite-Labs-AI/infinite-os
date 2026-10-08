// The jobs' review (`jobs-review.ts`), on a real git repo with a fake reviewer: who answers, what happens when no
// review can run, the one fix round, the re-review of only the failed questions, and that no answer reverts an edit.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runGit, tempDir, write } from "../../../test/wizard/repo.js"
import { createScanner } from "../../review/scan.js"
import type { AgentDetectResult, AgentKind, JobReviewResult, ReviewFailure, ReviewRunInput } from "../contracts/agents.js"
import type { WizardContext, WizardDeps } from "../contracts/deps.js"
import { JOB_TABLE, type ChecklistItem } from "../contracts/jobs.js"
import { JOBS_REVIEW_INPUTS, jobsReviewKeepsDraft, reviewJobsBeforeSettling, type JobsReviewHost } from "./jobs-review.js"

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const ROUTE = "app/api/signup/route.ts"
const BEFORE = "export async function POST(req: Request) {\n  const user = await createUser(req)\n  return Response.json({ ok: true })\n}\n"
const AFTER = 'import { reportInfiniteOutcome } from "../../../lib/infinite-outcome"\nexport async function POST(req: Request) {\n  const user = await createUser(req)\n  await reportInfiniteOutcome({ type: "sign_up", path: "/signup", eventId: user.id })\n  return Response.json({ ok: true })\n}\n'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo(): string {
  const root = tempDir("jobs-review-")
  dirs.push(root)
  runGit(root, ["init", "-q"])
  write(root, ROUTE, BEFORE)
  write(root, ".env.local", "SECRET=never-copied\n")
  write(root, ".gitignore", ".env*\n")
  runGit(root, ["add", "-A"])
  runGit(root, ["commit", "-qm", "site"])
  write(root, ROUTE, AFTER)
  return root
}

function job(id: string, state: ChecklistItem["state"] = "claimed"): ChecklistItem {
  const [jobId] = id.split(":") as [keyof typeof JOB_TABLE]
  return { id, jobId, n: JOB_TABLE[jobId].n, title: "Report the signup from the server", owner: "agent", trigger: { finding: "f", evidence: [{ file: ROUTE, line: 2 }] }, allow: { files: [ROUTE], create: [] }, checks: [{ id: "outcome_declared", tier: "S", state: "pass", runId: RUN, at: "2026-10-08T10:00:00.000Z" }], state, claim: { status: "done", note: "Reported after createUser.", at: "2026-10-08T10:00:00.000Z" } }
}

type Reviewer = (input: ReviewRunInput) => Promise<JobReviewResult | ReviewFailure>

/** Answers every question from the questions file the wizard wrote: `pick(question) → answer` (default "pass"). */
function answering(pick: (question: string) => "pass" | "fail" | "cant_tell" = () => "pass", note = "Read it.", blind = false): Reviewer {
  return async (input) => {
    const file = JSON.parse(readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.questions), "utf8")) as { jobs: Array<{ questions: Array<{ question_id: string; question: string }> }> }
    const nonce = readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.readCheck), "utf8").trim()
    return {
      summary: blind ? "I could not open anything." : `read-check: ${nonce} ok`,
      answers: file.jobs.flatMap((entry) => entry.questions.map((question) => ({ question_id: question.question_id, answer: pick(question.question), evidence: [{ path: ROUTE, line: 4 }], note })))
    }
  }
}

function host(root: string, items: ChecklistItem[], options: { reviewer?: AgentKind | "brief" | null; reviewers?: Partial<Record<AgentKind, Reviewer>>; noReviewJobs?: boolean; usable?: AgentKind[] } = {}) {
  let state = {
    runId: RUN,
    agent: options.reviewer === null ? null : { worker: "claude_code", reviewer: options.reviewer ?? "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: items
  }
  const calls: Array<{ reviewer: AgentKind; brief: string; dir: string; envCopied: boolean; diff: string; questions: string[] }> = []
  const lines: string[] = []
  const worktrees: string[] = []
  const reviewJobs = async (input: ReviewRunInput) => {
    const file = JSON.parse(readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.questions), "utf8")) as { jobs: Array<{ questions: Array<{ question: string }> }> }
    calls.push({ reviewer: input.reviewer, brief: input.brief, dir: input.worktreeDir, envCopied: existsSync(join(input.worktreeDir, ".env.local")), diff: readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.diff), "utf8"), questions: file.jobs.flatMap((entry) => entry.questions.map((question) => question.question)) })
    const answer = options.reviewers?.[input.reviewer]
    return answer ? answer(input) : { error: "error" as const, message: "no fake for this agent" }
  }
  const deps = {
    git: {
      head: async () => runGit(root, ["rev-parse", "HEAD"]).trim(),
      async worktreeAddDetached(sha: string) {
        const dir = join(tempDir("jobs-review-tree-"), "tree")
        dirs.push(dir)
        runGit(root, ["worktree", "add", "-q", "--detach", dir, sha])
        worktrees.push(dir)
        return { dir }
      },
      async worktreeRemove(dir: string) {
        runGit(root, ["worktree", "remove", "--force", dir])
      }
    },
    fs: {
      mkdirp: async (path: string) => {
        await mkdir(path, { recursive: true })
      },
      writeTextAtomic: async (path: string, text: string) => {
        await writeFile(path, text)
      }
    },
    registry: { brief: (list: readonly ChecklistItem[]) => list.map((item) => `### Job "${item.id}"`).join("\n") },
    clock: { now: () => new Date("2026-10-08T10:05:00.000Z") },
    agents: {
      ...(options.noReviewJobs ? {} : { reviewJobs }),
      detect: async (): Promise<AgentDetectResult> => {
        const usable = options.usable ?? ["codex"]
        const info = (kind: AgentKind) => ({ kind, binPath: `/bin/${kind}`, version: "1", whoPays: { payer: "plan" as const, label: "plan" } })
        return { worker: usable.includes("claude_code") ? info("claude_code") : null, reviewer: usable.includes("codex") ? info("codex") : null, nested: null }
      }
    }
  } as unknown as WizardDeps
  const ctx = { root, appRoot: ".", state: { get: () => state, update: (mutate: (draft: typeof state) => void) => { const next = structuredClone(state); mutate(next); state = next }, save: async () => undefined }, emit: { emit: () => undefined } } as unknown as WizardContext
  const reviewHost: JobsReviewHost = {
    ctx,
    deps,
    noteScanner: createScanner({ literals: [], allowedIds: [] }),
    items: () => state.jobs,
    item: (id) => state.jobs.find((item) => item.id === id),
    put: (transition) => { state = { ...state, jobs: state.jobs.map((item) => (item.id === transition.item.id ? transition.item : item)) } },
    runId: () => RUN,
    sub: (text) => void lines.push(text),
    editedFiles: () => [ROUTE],
    questionFacts: () => ({ metaInUse: false, conversionNames: ["sign_up"] })
  }
  return { reviewHost, calls, lines, worktrees, jobs: () => state.jobs, item: (id: string) => state.jobs.find((entry) => entry.id === id)!, setState: (id: string, next: ChecklistItem["state"]) => { state = { ...state, jobs: state.jobs.map((item) => (item.id === id ? { ...item, state: next } : item)) } } }
}

const SIGNUP = "server_conversions:signup"

describe("the jobs' review", () => {
  it("passes: the job is proven by the review; the reviewer reads the agent's diff in a worktree holding no .env, and the worktree is removed", async () => {
    const root = repo()
    const t = host(root, [job(SIGNUP)], { reviewers: { codex: answering() } })
    expect(await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })).toEqual({ kind: "done" })
    expect(t.item(SIGNUP)).toMatchObject({ state: "waiting_real_event", note: "Checked by the review agent.", review: { state: "pass", reviewer: "codex", runId: RUN } })
    expect(t.item(SIGNUP).review!.questions.map((question) => [question.id, question.answer])).toEqual([["after_success", "pass"], ["stable_id", "pass"], ["once", "pass"]])
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.envCopied).toBe(false)
    expect(t.calls[0]!.diff).toContain('+  await reportInfiniteOutcome({ type: "sign_up"')
    expect(t.calls[0]!.brief).toContain('begin your summary with "read-check: <its contents>"')
    expect(t.calls[0]!.brief).not.toContain("skip it with")
    expect(existsSync(t.worktrees[0]!)).toBe(false)
    // The agent's edit is untouched.
    expect(readFileSync(join(root, ROUTE), "utf8")).toBe(AFTER)
  })

  it("a fail with a fix round left: the job goes back to the agent (pending) with the reviewer's words; nothing is reverted", async () => {
    const root = repo()
    const t = host(root, [job(SIGNUP)], { reviewers: { codex: answering((question) => (question.includes("only after it succeeded") ? "fail" : "pass"), "It reports before the user row is saved.") } })
    const outcome = await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })
    expect(outcome.kind).toBe("fix")
    if (outcome.kind !== "fix") return
    expect(outcome.itemIds).toEqual([SIGNUP])
    expect(outcome.feedback).toEqual([expect.stringMatching(/^- server_conversions:signup: the review agent answered no to "Is the signup reported to Infinite.*" Its finding: It reports before the user row is saved\. \(app\/api\/signup\/route\.ts:4\)\. Fix it in this job's files, then claim the job again\.$/)])
    expect(t.item(SIGNUP)).toMatchObject({ state: "pending", note: "The review agent found: It reports before the user row is saved. (app/api/signup/route.ts:4)", review: { state: "fail", fixRound: true } })
    expect(outcome.restore.get(SIGNUP)?.state).toBe("claimed")
    expect(readFileSync(join(root, ROUTE), "utf8")).toBe(AFTER)
  })

  it("the re-review asks ONLY the failed question; still failing it NEEDS YOUR LOOK, kept in code with the finding", async () => {
    const root = repo()
    const failing = answering((question) => (question.includes("only after it succeeded") ? "fail" : "pass"), "It reports before the user row is saved.")
    const t = host(root, [job(SIGNUP)], { reviewers: { codex: failing } })
    const first = await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })
    // The agent's fix round claimed the job again but changed nothing.
    t.setState(SIGNUP, "claimed")
    expect(await reviewJobsBeforeSettling(t.reviewHost, { fixRound: false, reReview: first.kind === "fix" ? first.itemIds : [] })).toEqual({ kind: "done" })
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1]!.questions).toEqual([expect.stringMatching(/^Is the signup reported to Infinite in app\/api\/signup\/route\.ts only after it succeeded/)])
    expect(t.calls[1]!.brief).toContain("This is a RE-REVIEW after the agent's fix round")
    expect(t.item(SIGNUP)).toMatchObject({ state: "waiting_real_event", note: "Needs your look: It reports before the user row is saved. (app/api/signup/route.ts:4)", review: { state: "fail", fixRound: true } })
    // The earlier passes are kept; only the failed one was asked again.
    expect(t.item(SIGNUP).review!.questions.map((question) => question.answer)).toEqual(["fail", "pass", "pass"])
    expect(readFileSync(join(root, ROUTE), "utf8")).toBe(AFTER)
  })

  it("cant_tell keeps the job with why; a job a hard check failed (pending) is never reviewed", async () => {
    const root = repo()
    const t = host(root, [job(SIGNUP), { ...job("conversions_to_tools:signup", "pending"), id: "conversions_to_tools:signup" }], { reviewers: { codex: answering((question) => (question.includes("stays the same") ? "cant_tell" : "pass"), "The id comes from createUser, which is not in this repo.") } })
    await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })
    expect(t.item(SIGNUP)).toMatchObject({ note: "The review could not tell: The id comes from createUser, which is not in this repo.", review: { state: "cant_tell" } })
    expect(t.item("conversions_to_tools:signup").review).toBeUndefined()
  })

  it("no review possible — none chosen, a runner that cannot, or every reviewer refused — keeps the edits and keeps the pull request a draft", async () => {
    for (const [name, options, reason] of [
      ["none chosen", { reviewer: null }, "no review agent was chosen for this run"],
      ["printed brief only", { reviewer: "brief" as const }, "no review agent was chosen for this run"],
      ["no reviewJobs", { noReviewJobs: true }, "Codex cannot answer the jobs' questions in this version"],
      ["refused, and the other agent errored", { usable: ["codex", "claude_code"] as AgentKind[], reviewers: { codex: async () => ({ error: "rejected" as const }), claude_code: async () => ({ error: "timeout" as const }) } }, "Codex's service refused the request. Asked instead, Claude Code ran out of time (10 minutes)"]
    ] as const) {
      const root = repo()
      const t = host(root, [job(SIGNUP)], options as Parameters<typeof host>[2])
      expect(await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true }), name).toEqual({ kind: "done" })
      expect(t.item(SIGNUP), name).toMatchObject({ state: "waiting_real_event", note: `Not checked by a review agent: ${reason}`, review: { state: "not_run", reviewer: null } })
      expect(jobsReviewKeepsDraft(t.jobs(), RUN), name).toEqual({ keepDraft: true, reason: `No review agent checked the jobs' work: ${reason}` })
      expect(readFileSync(join(root, ROUTE), "utf8"), name).toBe(AFTER)
    }
  })

  it("a refused review is handed to the other installed agent once; its answer counts", async () => {
    const root = repo()
    const t = host(root, [job(SIGNUP)], { usable: ["codex", "claude_code"], reviewers: { codex: async () => ({ error: "rejected" }), claude_code: answering() } })
    await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })
    expect(t.calls.map((call) => call.reviewer)).toEqual(["codex", "claude_code"])
    expect(t.item(SIGNUP).review).toMatchObject({ state: "pass", reviewer: "claude_code" })
    expect(t.lines.join("\n")).toContain("Codex's service refused the request; asking Claude Code to check the jobs instead (read-only)")
  })

  it("a broken answer is asked again once; a review that shows it could not read the files is asked again, then counts as not run", async () => {
    const root = repo()
    let tries = 0
    const t = host(root, [job(SIGNUP)], { reviewers: { codex: async (input) => (++tries === 1 ? { error: "unparseable" } : answering()(input)) } })
    await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })
    expect(tries).toBe(2)
    expect(t.item(SIGNUP).review?.state).toBe("pass")
    const blind = host(repo(), [job(SIGNUP)], { reviewers: { codex: answering(undefined, "x", true) } })
    await reviewJobsBeforeSettling(blind.reviewHost, { fixRound: true })
    expect(blind.calls).toHaveLength(2)
    expect(blind.calls[1]!.brief).toContain("Your last answer shows you could not read the files")
    expect(blind.item(SIGNUP)).toMatchObject({ review: { state: "not_run" }, note: "Not checked by a review agent: Codex stopped with an error: it could not read the change" })
  })

  it("a re-review that cannot run leaves the earlier finding standing (needs your look), never 'not checked'", async () => {
    const root = repo()
    let call = 0
    const t = host(root, [job(SIGNUP)], { reviewers: { codex: async (input) => (++call === 1 ? answering((question) => (question.includes("only after it succeeded") ? "fail" : "pass"), "Reported too early.")(input) : { error: "timeout" }) } })
    const first = await reviewJobsBeforeSettling(t.reviewHost, { fixRound: true })
    t.setState(SIGNUP, "claimed")
    await reviewJobsBeforeSettling(t.reviewHost, { fixRound: false, reReview: first.kind === "fix" ? first.itemIds : [] })
    expect(t.item(SIGNUP)).toMatchObject({ note: "Needs your look: Reported too early. (app/api/signup/route.ts:4)", review: { state: "fail" } })
    expect(jobsReviewKeepsDraft(t.jobs(), RUN).keepDraft).toBe(false)
  })
})
