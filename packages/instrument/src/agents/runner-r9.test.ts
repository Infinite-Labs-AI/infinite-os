// Real runner and MCP bridge, fake agent binaries only: no model invocation or external network.
import { afterEach, expect, it } from "vitest"
import { fakeAgents, makeRunner } from "../../test/wizard/agents.js"
import { cleanup, item, makeFenceFixture } from "../../test/wizard/repo.js"

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

it("R9 scans unfamiliar provider keys in agent progress, claims, questions and structured fallbacks", async () => {
  const token = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY"
  const examples = ["whsec_" + token, "sb_secret_" + token, "sk-ant-api03-" + token, "sk-proj-" + token, `AWS_SECRET_ACCESS_KEY=${token}/+xQ5R2Z`, `postgres://user:${token}@db.example/app`, `api_key=${token}`]
  const { root } = makeFenceFixture()
  const job = item("meta_improve:landing", ["app/page.tsx"])
  const fallback = item("posthog_improve:proxy", ["app/layout.tsx"])
  const fakes = fakeAgents({ turns: [{ steps: [{ tool: "job_list" }, ...examples.flatMap(text => [
    { tool: "report_progress", args: { job_id: job.id, text } },
    { tool: "job_claim", args: { job_id: job.id, status: "done", note: text } },
    { tool: "ask_user", args: { job_id: job.id, question: `Which server owns ${text}?`, why: text } }
  ])], structured: { claims: [{ job_id: fallback.id, status: "done", note: examples[0] }], questions: [{ job_id: fallback.id, question: examples[1], options: null, why: examples[2] }] } }] })
  dirs.push(root, fakes.home)
  const claims: string[] = []
  const questions: string[] = []
  const progress: string[] = []
  const narration: string[] = []
  const result = await makeRunner(fakes, root).runJobs({
    items: [job, fallback], brief: "BRIEF", budget: { maxTurns: 30, wallMs: 30_000 },
    onClaim: claim => { claims.push(claim.note) },
    onAsk: question => { questions.push(`${question.question} ${question.why}`) },
    onProgress: entry => { progress.push(entry.text) },
    onNarrate: beat => { narration.push(beat.text) }
  })
  expect(result.outcome).toBe("completed")
  expect(result.claims.some(claim => claim.jobId === fallback.id)).toBe(true)
  expect(result.questions.some(question => question.jobId === fallback.id)).toBe(true)
  expect(claims).toHaveLength(examples.length)
  expect(progress).toHaveLength(examples.length)
  expect(questions).toHaveLength(examples.length)
  for (const [surface, output] of Object.entries({ claims: claims.join("\n"), questions: questions.join("\n"), progress: progress.join("\n"), narration: narration.join("\n"), retained: JSON.stringify({ claims: result.claims, questions: result.questions }) })) {
    expect(output.includes(token), `${surface} leaked an unknown credential`).toBe(false)
    expect(output, `${surface} exercised redaction`).toContain("redacted")
  }
}, 30_000)
