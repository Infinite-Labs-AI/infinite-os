import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, gateSpy, makeRunner, records, RUN_ID, runs, type FakeSetup } from "../../test/wizard/agents.js"
import { cleanup, item, makeFenceFixture, POST_INSTALL_LAYOUT, runGit, tempDir, write } from "../../test/wizard/repo.js"
import { agentArgvViolations, type RunJobsInput } from "../wizard/contracts/agents.js"
import type { AgentQuestion, Claim } from "../wizard/contracts/jobs.js"
import { runScratchDir } from "./paths.js"
import { reviewInDetachedWorktree, SYSTEM_PROMPT_HEADER, WORKER_KICKOFF, WORKER_RESUME_KICKOFF, type AgentRunResultWithExtras } from "./runner.js"
import { assertReviewWorktree } from "./worktree-guard.js"

// These spawn real node fakes, the built mcp-proxy and git for up to 4 rounds: the 5 s default is too
// tight under a loaded full-suite run (review O3 F15).
vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const ITEMS = [
  item("meta_improve:landing", ["app/layout.tsx", "app/page.tsx", "next.config.mjs"], ["lib/meta-mirror.ts"]),
  item("privacy_paragraph:page", ["app/privacy/page.tsx"])
]
const PAGE_EDIT = "export default function Page() {\n  return <a href=\"/signup\" data-conversion=\"trial\">Start free trial</a>\n}\n"

function setup(scenario: unknown, extraEnv: Record<string, string> = {}) {
  const { root } = makeFenceFixture()
  const fakes = fakeAgents(scenario, extraEnv)
  dirs.push(root, fakes.home)
  return { root, fakes }
}

function jobsInput(over: Partial<RunJobsInput> = {}) {
  const claims: Claim[] = []
  const asks: AgentQuestion[] = []
  const beats: string[] = []
  const progress: string[] = []
  const input: RunJobsInput = {
    items: ITEMS,
    brief: "BRIEF: do the jobs",
    budget: { maxTurns: 30, wallMs: 60_000 },
    onClaim: (claim) => { claims.push(claim) },
    onAsk: (question) => asks.push(question),
    onProgress: (entry) => progress.push(entry.text),
    onNarrate: (beat) => beats.push(beat.text),
    ...over
  }
  return { input, claims, asks, beats, progress }
}

const CLAIM_DONE = { tool: "job_claim", args: { job_id: "meta_improve:landing", status: "done", note: "trial button wired" } }

describe("runJobs with Claude (fake)", () => {
  it("relays claims through the real mcp-proxy, keeps allowlisted edits, and narrates", async () => {
    const { root, fakes } = setup(
      {
        turns: [
          {
            steps: [
              { tool: "job_list" },
              { edit: { path: "app/page.tsx", content: PAGE_EDIT } },
              { tool: "report_progress", args: { job_id: "meta_improve:landing", text: "Wiring the trial button" } },
              CLAIM_DONE,
              { tool: "ask_user", args: { job_id: "meta_improve:landing", question: "Is /pricing a landing page too?", why: "It has its own layout." } }
            ],
            structured: { claims: [{ job_id: "privacy_paragraph:page", status: "not_needed", note: "already names the tools" }], questions: [] }
          }
        ]
      },
      { INFINITE_TAG_MCP_TOKEN: "stale-token-from-a-parent-run", INFINITE_TAG_MCP_URL: "http://127.0.0.1:1/mcp", CLAUDECODE: "1", ANTHROPIC_BASE_URL: "https://proxy.example" }
    )
    const gate = gateSpy()
    const runner = makeRunner(fakes, root, { checks: gate })
    const { input, claims, asks, beats, progress } = jobsInput()
    const result = (await runner.runJobs(input)) as AgentRunResultWithExtras
    expect(result.outcome).toBe("completed")
    expect(result.session.kind).toBe("claude")
    expect(result.claims.map((claim) => [claim.jobId, claim.status])).toEqual([
      ["meta_improve:landing", "done"],
      ["privacy_paragraph:page", "not_needed"]
    ])
    expect(claims).toHaveLength(1)
    expect(asks.map((question) => question.question)).toEqual(["Is /pricing a landing page too?"])
    expect(result.questions).toHaveLength(1)
    expect(progress).toEqual(["Wiring the trial button"])
    expect(result.edits.map((edit) => edit.file)).toEqual(["app/page.tsx"])
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).toBe(PAGE_EDIT)
    expect(gate.calls).toHaveLength(1)
    expect(beats).toContain("Claude Code says job 5 is done; checking…")
    expect(beats).toContain("Editing app/page.tsx")
    // The claim reply that reached the agent never says verified.
    const reply = records(fakes).find((entry) => entry.kind === "mcp" && entry.tool === "job_claim")!.reply!
    expect(reply.result?.structuredContent).toEqual({ recorded: true, next: "the wizard will run its own checks" })
    expect(JSON.stringify(reply)).not.toMatch(/verified/i)
    // Env: the stale token and the nesting marker are gone; Claude gets NO MCP vars (only tag.mcp.json); ANTHROPIC_* kept.
    const run = runs(fakes, "claude")[0]!
    expect(run.env!.INFINITE_TAG_KEYS).toEqual([])
    expect(run.env!.CLAUDECODE).toBeUndefined()
    expect(run.env!.ANTHROPIC_BASE_URL).toBe("https://proxy.example")
    expect(run.env!.ENABLE_TOOL_SEARCH).toBe("false")
    expect(run.stdin).toBe(WORKER_KICKOFF)
    expect(run.argv![run.argv!.indexOf("--append-system-prompt") + 1]).toBe(`${SYSTEM_PROMPT_HEADER}\n\nBRIEF: do the jobs`)
    // Live run 6: the brief opens with the owner boundary; the header never repeats it (the agent read it twice).
    expect(SYSTEM_PROMPT_HEADER).toBe("Infinite tag wizard: your instructions for this run.")
    expect(agentArgvViolations("claude_code", run.argv!)).toEqual([])
    // The token-bearing tag.mcp.json was 0600 in a 0700 dir under $HOME (never /tmp), and is gone once the turn ends.
    const config = records(fakes).find((entry) => entry.kind === "mcp-config")!
    expect([config.mode, config.dirMode]).toEqual([0o600, 0o700])
    expect(runScratchDir(fakes.home, RUN_ID).startsWith(join(fakes.home, "Library/Caches/infinite-tag/"))).toBe(true)
    expect(readdirSync(runScratchDir(fakes.home, RUN_ID)).filter((name) => name.startsWith("tag.mcp"))).toEqual([])
    expect(runner.isAgentAlive()).toBe(false)
  })

  it("aborts a toolless run (infinite_tag not connected at init) and undoes its edits", async () => {
    const { root, fakes } = setup({ turns: [{ mcp: "skip", steps: [{ edit: { path: "app/layout.tsx", content: "x\n" } }, { sleep: 3000 }] }] })
    const result = await makeRunner(fakes, root).runJobs(jobsInput().input)
    expect(result.outcome).toBe("toolless")
    expect(result.edits).toEqual([])
    expect(readFileSync(join(root, "app/layout.tsx"), "utf8")).toBe(POST_INSTALL_LAYOUT)
  })

  it("rate_limit_event rejected → out_of_usage, resetsAt kept, snapshot restored, session kept; resume carries --resume <id>", async () => {
    const { root, fakes } = setup({
      turns: [
        { steps: [{ edit: { path: "app/page.tsx", content: PAGE_EDIT } }, { replay: "claude-rate-limit-rejected.jsonl" }, { sleep: 5000 }] },
        { steps: [CLAIM_DONE] }
      ]
    })
    const runner = makeRunner(fakes, root)
    const first = await runner.runJobs(jobsInput().input)
    expect(first.outcome).toBe("out_of_usage")
    expect(first.resetsAt).toBe(new Date(1790000000 * 1000).toISOString())
    expect(first.reverted).toEqual(["app/page.tsx"])
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).toContain("Start free trial</a>")
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).not.toContain("data-conversion")
    const sessionId = runs(fakes, "claude")[0]!.argv![runs(fakes, "claude")[0]!.argv!.indexOf("--session-id") + 1]
    expect(first.session).toEqual({ kind: "claude", sessionId })
    const second = await runner.runJobs(jobsInput({ resume: first.session, brief: "BRIEF + notes" }).input)
    expect(second.outcome).toBe("completed")
    const resumed = runs(fakes, "claude")[1]!
    expect(resumed.argv!.slice(resumed.argv!.indexOf("--resume"), resumed.argv!.indexOf("--resume") + 2)).toEqual(["--resume", sessionId])
    expect(resumed.argv).not.toContain("--session-id")
    expect(resumed.stdin).toBe(WORKER_RESUME_KICKOFF)
  })

  it("counts permission denials and flags a denied .env read as an incident", async () => {
    const { root, fakes } = setup({ turns: [{ denials: ["/repo/.env.local", "/repo/README.md"], steps: [CLAIM_DONE] }] })
    const result = (await makeRunner(fakes, root).runJobs(jobsInput().input)) as AgentRunResultWithExtras
    expect(result.permissionDenials).toBe(2)
    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0]).toBe("Claude Code tried to read .env.local outside the repo (denied)")
  })

  it("reverts a gate hit (child_process in next.config.mjs) and blocks the job; the rest is kept", async () => {
    const { root, fakes } = setup({
      turns: [
        {
          steps: [
            { edit: { path: "next.config.mjs", content: "import { execSync } from 'child_process'\nconst nextConfig = {}\n\nexport default nextConfig\n" } },
            { edit: { path: "app/page.tsx", content: PAGE_EDIT } },
            CLAIM_DONE
          ]
        }
      ]
    })
    const result = (await makeRunner(fakes, root).runJobs(jobsInput().input)) as AgentRunResultWithExtras
    expect(readFileSync(join(root, "next.config.mjs"), "utf8")).not.toContain("child_process")
    expect(result.edits.map((edit) => edit.file)).toEqual(["app/page.tsx"])
    // §3x.2 A gate hit is reported, attributed to the item that claimed the file, never a block.
    expect(result.blocked).toEqual([])
    expect(result.gateHits.map((hit) => [hit.file, hit.itemIds])).toEqual([["next.config.mjs", ["meta_improve:landing"]]])
  })
})

describe("runJobs with Codex (fake)", () => {
  it("gives the Codex child THIS run's two MCP vars (never the stale ones) and relays claims", async () => {
    const { root, fakes } = setup(
      { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: PAGE_EDIT } }, CLAIM_DONE], final: { claims: [], questions: [] } }] },
      { INFINITE_TAG_MCP_TOKEN: "stale-token-from-a-parent-run" }
    )
    const { input, beats } = jobsInput()
    const result = await makeRunner(fakes, root, { preferWorker: "codex" }).runJobs(input)
    expect(result.outcome).toBe("completed")
    expect(result.session).toEqual({ kind: "codex", threadId: "thread-fake-0001" })
    expect(result.claims.map((claim) => claim.jobId)).toEqual(["meta_improve:landing"])
    expect(result.edits.map((edit) => edit.file)).toEqual(["app/page.tsx"])
    const run = runs(fakes, "codex")[0]!
    expect(run.env!.INFINITE_TAG_KEYS).toEqual(["INFINITE_TAG_MCP_TOKEN", "INFINITE_TAG_MCP_URL"])
    expect(run.env!.INFINITE_TAG_MCP_TOKEN).not.toBe("stale-token-from-a-parent-run")
    expect(run.env!.INFINITE_TAG_MCP_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(run.stdin).toContain("BRIEF: do the jobs")
    expect(agentArgvViolations("codex", run.argv!)).toEqual([])
    expect(beats).toContain("Loading its checklist tools")
  })
})

describe("killAll (SIGINT)", () => {
  it("kills the agent's whole process group and restores the snapshot", async () => {
    const { root, fakes } = setup({ turns: [{ steps: [{ edit: { path: "app/page.tsx", content: PAGE_EDIT } }, { grandchild: true }, { hang: true }] }] })
    const runner = makeRunner(fakes, root)
    const pending = runner.runJobs(jobsInput().input)
    const hanging = await waitFor(fakes, "hanging")
    const grandchild = records(fakes).find((entry) => entry.kind === "grandchild")!.pid!
    expect(runner.isAgentAlive()).toBe(true)
    await runner.killAll()
    const result = await pending
    expect(result.outcome).not.toBe("completed")
    expect(runner.isAgentAlive()).toBe(false)
    expect(await gone(hanging.pid!)).toBe(true)
    expect(await gone(grandchild)).toBe(true)
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).not.toContain("data-conversion")
  })
})

describe("review (read-only, detached worktree)", () => {
  const REVIEW = { verdict: "changes_suggested", summary: "One nit.", checklist: [{ item: "R6", status: "pass", note: "no consent edits" }], findings: [{ id: "F1", item: "R3", severity: "nit", path: "app/page.tsx", line: 2, body: "Name the event.", suggested_fix: null }] }

  function reviewRepo() {
    const repo = tempDir("infinite-tag-review-repo-")
    runGit(repo, ["init", "-q", "-b", "main"])
    write(repo, "app/page.tsx", "export default 1\n")
    runGit(repo, ["add", "-A"])
    runGit(repo, ["commit", "-q", "-m", "init"])
    write(repo, ".env", "SECRET_SITE_VALUE=fixture-not-a-secret\n")
    const head = runGit(repo, ["rev-parse", "HEAD"]).trim()
    const worktrees: string[] = []
    const git = {
      async worktreeAddDetached(sha: string) {
        const dir = join(tempDir("infinite-tag-review-wt-"), "wt")
        runGit(repo, ["worktree", "add", "--detach", dir, sha])
        worktrees.push(dir)
        return { dir }
      },
      async worktreeRemove(dir: string) {
        runGit(repo, ["worktree", "remove", "--force", dir])
      }
    }
    dirs.push(repo)
    return { repo, head, git, worktrees }
  }

  it.each(["claude_code",] as const)("%s reviews a worktree that holds no .env and returns the parsed review", async (reviewer) => {
    const { repo, head, git, worktrees } = reviewRepo()
    const fakes = fakeAgents(reviewer === "claude_code" ? { turns: [{ structured: REVIEW }] } : { turns: [{ final: REVIEW }] })
    dirs.push(fakes.home)
    const runner = makeRunner(fakes, repo)
    const result = await reviewInDetachedWorktree(runner, git, { headSha: head, reviewer, brief: "R1-R16 brief" })
    expect(result).toEqual(REVIEW)
    const run = runs(fakes, reviewer === "claude_code" ? "claude" : "codex").find((entry) => entry.role === "reviewer")!
    expect(run.cwd).toBe(worktrees[0])
    expect(run.cwdEntries).not.toContain(".env")
    expect(run.cwdEntries).toContain("app")
    expect(existsSync(worktrees[0]!)).toBe(false)
    expect(agentArgvViolations(reviewer, run.argv!)).toEqual([])
    expect(run.argv).not.toContain("--mcp-config")
    expect(run.argv!.join(" ")).not.toContain("mcp_servers")
  })

  // The answer a real Codex (codex-cli 0.160.1, strict `--output-schema`) wrote on 2026-10-08: every finding key
  // present, `category: null` where the finding has none.
  const CODEX_ANSWER = {
    verdict: "changes_suggested",
    summary: "Two findings.",
    checklist: [{ item: "R1", status: "pass", note: "ok" }],
    findings: [
      { id: "F1", category: "analytics", item: "R2", severity: "nit", path: "app/page.tsx", line: 1, body: "Name the event.", suggested_fix: null },
      { id: "F2", category: null, item: "R3", severity: "should", path: "app/page.tsx", line: null, body: "Send the value.", suggested_fix: "Add value." }
    ]
  }

  it("Codex: the review schema passes strict structured outputs, and a real answer (category null) is read", async () => {
    const { repo, head, git } = reviewRepo()
    const fakes = fakeAgents({ turns: [{ final: CODEX_ANSWER }] })
    dirs.push(fakes.home)
    const result = await reviewInDetachedWorktree(makeRunner(fakes, repo), git, { headSha: head, reviewer: "codex", brief: "R1-R16 brief" })
    const { category: _none, ...second } = CODEX_ANSWER.findings[1]!
    expect(result).toEqual({ ...CODEX_ANSWER, findings: [CODEX_ANSWER.findings[0], second] })
    const run = runs(fakes, "codex").find((entry) => entry.role === "reviewer")!
    expect(run.argv).toContain("--output-schema")
  })

  it("Codex: a request its service refused (400 invalid_json_schema) is `rejected`, never `unparseable`", async () => {
    const { repo, head, git } = reviewRepo()
    const fakes = fakeAgents({ turns: [{ schemaProblem: "'schema.properties.findings.items.required' is required to include every key in properties. Missing 'category'.", final: CODEX_ANSWER }] })
    dirs.push(fakes.home)
    const result = await reviewInDetachedWorktree(makeRunner(fakes, repo), git, { headSha: head, reviewer: "codex", brief: "R1-R16 brief" })
    // The service's own words are kept (from the JSON body's error.message), never the 400 JSON itself.
    expect(result).toMatchObject({ error: "rejected", message: expect.stringMatching(/^Invalid schema for response_format/) })
    expect((result as { message: string }).message.length).toBeLessThanOrEqual(200)
  })

  it("Codex: a failed turn (non-zero exit) is `error` with its last message, never `unparseable`", async () => {
    const { repo, head, git } = reviewRepo()
    const fakes = fakeAgents({ turns: [{ steps: [{ emit: { type: "error", message: "Reconnecting... 1/5" } }, { emit: { type: "turn.failed", error: { message: "stream disconnected before completion" } } }], final: null, exit: 1 }] })
    dirs.push(fakes.home)
    const result = await reviewInDetachedWorktree(makeRunner(fakes, repo), git, { headSha: head, reviewer: "codex", brief: "R1-R16 brief" })
    expect(result).toEqual({ error: "error", message: "stream disconnected before completion" })
  })

  it("Claude Code: an error result with no answer is `error` with its text; a non-zero exit with nothing said is `error` too", async () => {
    const { repo, head, git } = reviewRepo()
    const fakes = fakeAgents({ turns: [{ result: { subtype: "error_during_execution", is_error: true, result: "API Error: 500 internal server error" }, structured: null, exit: 1 }] })
    dirs.push(fakes.home)
    const result = await reviewInDetachedWorktree(makeRunner(fakes, repo), git, { headSha: head, reviewer: "claude_code", brief: "R1-R16 brief" })
    expect(result).toMatchObject({ error: "error", message: expect.stringContaining("API Error: 500") })
    const silent = fakeAgents({ turns: [{ structured: null, exit: 2 }] })
    dirs.push(silent.home)
    expect(await reviewInDetachedWorktree(makeRunner(silent, repo), git, { headSha: head, reviewer: "claude_code", brief: "R1-R16 brief" })).toEqual({ error: "error" })
  })

  it("a reviewer that is not usable here is `unavailable` with why, and no agent is spawned", async () => {
    const { repo, head, git } = reviewRepo()
    const fakes = fakeAgents({ claude: { authExit: 1 }, codex: {} })
    dirs.push(fakes.home)
    const result = await reviewInDetachedWorktree(makeRunner(fakes, repo), git, { headSha: head, reviewer: "claude_code", brief: "R1-R16 brief" })
    expect(result).toEqual({ error: "unavailable", message: "is not signed in" })
    expect(runs(fakes, "claude")).toEqual([])
  })

  it("refuses the repo itself, or a worktree holding an untracked .env (negatives)", async () => {
    const { repo, head, git } = reviewRepo()
    await expect(assertReviewWorktree(repo, repo)).rejects.toThrow(/detached worktree/)
    const { dir } = await git.worktreeAddDetached(head)
    writeFileSync(join(dir, ".env.production"), "X=1\n")
    await expect(assertReviewWorktree(dir, repo)).rejects.toThrow(/untracked env file/)
    await git.worktreeRemove(dir)
  })
})

async function waitFor(fakes: FakeSetup, kind: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const hit = records(fakes).find((entry) => entry.kind === kind)
    if (hit) return hit
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`no ${kind} record`)
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  return false
}
