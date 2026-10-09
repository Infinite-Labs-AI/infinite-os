// The jobs' review through the REAL runner and the fake Codex / Claude CLIs: the strict schema Codex sends to OpenAI's
// strict structured outputs is accepted (the fake refuses a schema strict mode would refuse, with the service's own 400),
// the answers are parsed, and a jobs review never takes one of the step-9 review's scripted turns.
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner, records, runs } from "../../test/wizard/agents.js"
import { cleanup, runGit, tempDir, write } from "../../test/wizard/repo.js"
import { JOB_REVIEW_SCHEMA, agentArgvViolations } from "../wizard/contracts/agents.js"
import { parseJobReview, schemaErrors } from "./schema-check.js"

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

/** Every object in the schema, with its path. */
function objects(node: unknown, path = "schema", out: Array<{ path: string; node: Record<string, unknown> }> = []) {
  if (node === null || typeof node !== "object") return out
  const record = node as Record<string, unknown>
  if (record.properties) {
    out.push({ path, node: record })
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) objects(child, `${path}.properties.${key}`, out)
  }
  if (record.items) objects(record.items, `${path}.items`, out)
  return out
}

function reviewRepo() {
  const repo = tempDir("infinite-tag-jobs-review-repo-")
  runGit(repo, ["init", "-q", "-b", "main"])
  write(repo, "app/api/signup/route.ts", "export async function POST() {}\n")
  runGit(repo, ["add", "-A"])
  runGit(repo, ["commit", "-q", "-m", "init"])
  const head = runGit(repo, ["rev-parse", "HEAD"]).trim()
  const worktree = join(tempDir("infinite-tag-jobs-review-wt-"), "wt")
  runGit(repo, ["worktree", "add", "--detach", worktree, head])
  // What the jobs' review writes into the reviewer's worktree (`wizard/steps/jobs-review.ts`).
  mkdirSync(join(worktree, ".infinite", "review"), { recursive: true })
  writeFileSync(join(worktree, ".infinite", "review", "read-check.txt"), "nonce42\n")
  writeFileSync(join(worktree, ".infinite", "review", "jobs-questions.json"), JSON.stringify({
    jobs: [{ job: "server_conversions:signup", questions: [
      { question_id: "Q1", question: "Is the signup reported to Infinite only after it succeeded?" },
      { question_id: "Q2", question: "Does every signup report carry an id that stays the same?" }
    ] }]
  }))
  dirs.push(repo, worktree)
  return { repo, worktree }
}

describe("the jobs' review schema", () => {
  it("is strict-mode safe: every object closes additionalProperties and requires every key; optional values are nullable", () => {
    const found = objects(JOB_REVIEW_SCHEMA)
    expect(found.length).toBeGreaterThan(2)
    for (const { path, node } of found) {
      expect(node.additionalProperties, path).toBe(false)
      expect([...(node.required as string[])].sort(), path).toEqual(Object.keys(node.properties as object).sort())
    }
    expect(JOB_REVIEW_SCHEMA.properties.answers.items.properties.evidence.items.properties.line.type).toEqual(["integer", "null"])
  })

  it("reads an answer, in prose or a fence too; rejects a missing key, an unknown answer or an extra key", () => {
    const answer = { summary: "read-check: n ok", answers: [{ question_id: "Q1", answer: "fail", evidence: [{ path: "a.ts", line: null }], note: "too early" }] }
    expect(parseJobReview(JSON.stringify(answer))).toEqual(answer)
    expect(parseJobReview(`Here:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)).toEqual(answer)
    expect(schemaErrors(answer, JOB_REVIEW_SCHEMA as never)).toEqual([])
    expect(parseJobReview({ ...answer, answers: [{ ...answer.answers[0], answer: "maybe" }] })).toBeNull()
    expect(parseJobReview({ ...answer, answers: [{ ...answer.answers[0], note: undefined }] })).toBeNull()
    expect(parseJobReview({ ...answer, extra: 1 })).toBeNull()
  })
})

describe("the jobs' review through the runner", () => {
  it("Codex: the strict schema is accepted, the scripted answers come back parsed, and no step-9 review turn is used", async () => {
    const { repo, worktree } = reviewRepo()
    const fakes = fakeAgents({ jobsReview: [{ answers: [{ match: "only after it succeeded", answer: "fail", note: "Reported before the row is saved.", evidence: [{ path: "app/api/signup/route.ts", line: 1 }] }] }], turns: [{ final: { verdict: "looks_good", summary: "step 9", checklist: [], findings: [] } }] })
    dirs.push(fakes.home)
    const result = await makeRunner(fakes, repo).reviewJobs({ worktreeDir: worktree, reviewer: "codex", brief: "jobs brief" })
    expect(result).toEqual({
      summary: "read-check: nonce42 Answered every question.",
      answers: [
        { question_id: "Q1", answer: "fail", evidence: [{ path: "app/api/signup/route.ts", line: 1 }], note: "Reported before the row is saved." },
        { question_id: "Q2", answer: "pass", evidence: [], note: "Read the code: it does what the question asks." }
      ]
    })
    const jobsRun = records(fakes).find((entry) => entry.kind === "jobs_review")!
    expect(jobsRun.argv).toContain("--output-schema")
    expect(agentArgvViolations("codex", jobsRun.argv!)).toEqual([])
    expect(jobsRun.stdin).toContain("Answer every question in your instructions about the change in this folder")
    // The step-9 review's scripted turn is still unused.
    expect(runs(fakes, "codex")).toEqual([])
  })

  it("Codex: a schema strict mode would refuse is `rejected` (the fake refuses exactly like the service)", async () => {
    const { repo, worktree } = reviewRepo()
    const fakes = fakeAgents({ jobsReview: [{ schemaProblem: "'schema.properties.answers.items.required' is required to include every key in properties. Missing 'note'." }] })
    dirs.push(fakes.home)
    expect(await makeRunner(fakes, repo).reviewJobs({ worktreeDir: worktree, reviewer: "codex", brief: "jobs brief" })).toMatchObject({ error: "rejected" })
  })

  it("Claude Code: the same schema through --json-schema; its review prompt carries no worker-only owner instruction", async () => {
    const { repo, worktree } = reviewRepo()
    const fakes = fakeAgents({ jobsReview: [{}] })
    dirs.push(fakes.home)
    const result = await makeRunner(fakes, repo).reviewJobs({ worktreeDir: worktree, reviewer: "claude_code", brief: "jobs brief" })
    expect(result).toMatchObject({ summary: "read-check: nonce42 Answered every question.", answers: [{ question_id: "Q1", answer: "pass" }, { question_id: "Q2", answer: "pass" }] })
    const argv = records(fakes).find((entry) => entry.kind === "jobs_review")!.argv!
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!)).toEqual(JOB_REVIEW_SCHEMA)
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1]!
    expect(prompt).toContain("do not evaluate, grade or comment on the owner's choices there")
    expect(prompt).not.toContain("skip it with")
  })
})
