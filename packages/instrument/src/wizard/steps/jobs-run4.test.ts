// R4-1 (live run 4), replayed through the REAL jobs step: the real runner over the fake `claude`, the real fence, the
// run-4 site. Round 1 makes run 4's edit (the duplicate removed, both guards, the `_fbc` capture, the signup call) and
// claims the jobs; the wizard's own `fbc_capture` check fails; round 2 hangs until the wall clock ends it.
//
// Live run 4 then stamped job 5 "The agent ran out of time; its edits were undone." while its capture (kept from round
// 1) shipped, and the step line said the same of every job. Now each job's state is what its own checks say about the
// tree the pull request commits, and the words say where its change is.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner } from "../../../test/wizard/agents.js"
import { baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import { cleanup, runGit, tempDir, write } from "../../../test/wizard/repo.js"
import type { AgentRunnerImpl } from "../../agents/runner.js"
import { AGENT_LIMITS } from "../contracts/agents.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import { approvedFixClauses, missingApprovedFixes } from "../verdict.js"
import { notDoneLines, step } from "./jobs.js"

vi.setConfig({ testTimeout: 60_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const RUN4 = join(__dirname, "../../../test/wizard/fixtures/run4")
const run4 = (rel: string) => readFileSync(join(RUN4, rel), "utf8")
const MOUNT_IMPORT = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"\n'
const MOUNT = "        <InfiniteAnalyticsClient />\n"

/** `app/layout.tsx` as the install left it in run 4 (the base plus the managed client's import and mount). */
function installedLayout(): string {
  const base = run4("site-b7c8347/app/layout.tsx")
  const body = base.indexOf("      <body>\n") + "      <body>\n".length
  return MOUNT_IMPORT + base.slice(0, body) + MOUNT + base.slice(body)
}

const JOB6 = "duplicates_remove:ga4_config:G-8YB9G7SJE7"
const GA4_GUARD = "preview_guard:ga4"
const META_GUARD = "preview_guard:meta"
const SIGNUP = "conversions_to_tools:signup"
const CAPTURE = "meta_improve:capture"
const DONE = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven"]

/** Run 4's five agent items as `plan` left them (pending, nothing checked). */
function run4Items(ids: readonly string[]): ChecklistItem[] {
  const state = JSON.parse(run4("wizard/state.json")) as { jobs: ChecklistItem[] }
  return ids.map((id) => {
    const item = structuredClone(state.jobs.find((entry) => entry.id === id)!)
    delete item.blockedReason
    delete item.claim
    delete item.edits
    delete item.note
    item.state = "pending"
    item.checks = item.checks.map((check) => ({ id: check.id, tier: check.tier, state: "not_run" }))
    return item
  })
}

const claim = (jobId: string, files: string[]) => ({ tool: "job_claim", args: { job_id: jobId, status: "done", note: "done", files } })

/**
 * The world: the real runner and fence; the step's clock jumps to 1.5 s before the jobs budget ends while round 1's
 * checks run, so round 2 (a hanging agent) is ended by the real wall clock, exactly like run 4's 10-minute budget.
 */
function world(input: { round1Claims: string[]; fbcCapture: Array<"pass" | "problem"> }) {
  const root = tempDir("infinite-tag-run4-")
  runGit(root, ["init", "-q", "-b", "main"])
  write(root, ".gitignore", "node_modules/\n.env*\n.next/\n")
  write(root, "app/layout.tsx", run4("site-b7c8347/app/layout.tsx"))
  write(root, "app/signup/page.tsx", run4("site-b7c8347/app/signup/page.tsx"))
  runGit(root, ["add", "-A"])
  runGit(root, ["commit", "-q", "-m", "b7c8347"])
  write(root, "app/layout.tsx", installedLayout())
  const merged = run4("merged-5e6f3f3/app/layout.tsx")
  const fakes = fakeAgents({
    turns: [
      {
        steps: [
          { edit: { path: "app/layout.tsx", content: merged } },
          { edit: { path: "app/signup/page.tsx", content: run4("merged-5e6f3f3/app/signup/page.tsx") } },
          ...input.round1Claims.map((id) => claim(id, id === SIGNUP ? ["app/signup/page.tsx"] : ["app/layout.tsx"]))
        ]
      },
      // Round 2: run 4's agent re-read the checklist and grepped Infinite's module until the budget ended.
      { steps: [{ hang: true }] }
    ]
  })
  dirs.push(root, fakes.home)
  const { checks, calls } = fakeChecks({ results: { fbc_capture: input.fbcCapture } })
  let t = Date.parse("2026-10-03T20:45:02.000Z")
  const started = t
  const clock = { now: () => new Date((t += 1)), sleep: async () => undefined }
  // Round 1's checks end 1.5 s before the jobs budget does (the live run's round 2 had 2.4 minutes).
  const nearTheEnd = () => (t = Math.max(t, started + AGENT_LIMITS.jobs.wallMs - 1_500))
  const run = checks.run.bind(checks)
  const t0 = checks.t0.bind(checks)
  ;(checks as { run: typeof checks.run }).run = async (...args) => (nearTheEnd(), run(...args))
  ;(checks as { t0: typeof checks.t0 }).t0 = async (...args) => (nearTheEnd(), t0(...args))
  let runner: AgentRunnerImpl | null = null
  const { bridge } = fakeBridge({ agents: () => runner })
  runner = makeRunner(fakes, root, { connectionIds: () => [] })
  const { registry } = fakeRegistry()
  const { installer, recorded } = fakeInstaller()
  const state = baseState({
    root,
    runId: STEP_RUN_ID,
    agent: { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: run4Items([JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE])
  })
  const { ctx, recorded: events, state: current } = makeCtx({ root, state })
  const deps = { ...makeDeps({ bridge, agents: runner, checks, registry, installer, env: { HOME: fakes.home } }), clock }
  return { root, ctx, deps, current, calls, recorded, events, merged }
}

describe("R4-1 live run 4: the budget ends with kept edits in the tree", () => {
  it("job 5 (its capture shipped) is never 'undone': failed with the wizard's real reason, and its change is said to stay in the pull request", async () => {
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["problem"] })
    const outcome = await step.run(w.ctx, w.deps)
    const jobs = w.current().jobs
    const stateOf = (id: string) => jobs.find((item) => item.id === id)!

    // The tree the pull request commits holds job 5's capture (it shares app/layout.tsx's lines with kept jobs).
    const layout = readFileSync(join(w.root, "app/layout.tsx"), "utf8")
    expect(layout).toBe(w.merged)
    expect(layout).toContain('<Script id="meta-fbc-capture"')

    for (const id of [JOB6, GA4_GUARD, META_GUARD, SIGNUP]) expect(DONE, id).toContain(stateOf(id).state)
    const capture = stateOf(CAPTURE)
    expect(capture.state).toBe("failed")
    expect(capture.note).toContain("The agent ran out of time before fixing it")
    expect(capture.note).toContain("fbc_capture")
    expect(capture.note).toContain("Its change stays in the pull request (it shares lines in app/layout.tsx with a job that passed).")
    // Never the live run's false sentence, anywhere.
    const said = JSON.stringify([outcome, jobs, w.events.events])
    expect(said).not.toContain("its edits were undone")
    expect(said).not.toContain("edits were undone")
    // Its edit is recorded on it (the receipt and the verdict read that as "in the code").
    expect(capture.edits?.map((edit) => edit.file)).toEqual(["app/layout.tsx"])

    // The step line says what IS done, not that nothing survived.
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_AGENT_TIMEOUT", next: "continue" })
    expect((outcome as { message: string }).message).toBe(
      "The agent ran out of time · 4 of 5 jobs done in code (checked by the wizard, not the agent) · 1 blocked"
    )
    // "Not done" names the job with its real reason and where its change is.
    expect(notDoneLines(jobs).join("\n")).toContain("! Not done: Improve the existing Meta pixel (The agent ran out of time before fixing it")
    // The merge card / headline clause: in the code, but it did not pass (never "not in the code").
    expect(approvedFixClauses(missingApprovedFixes(jobs))).toEqual([
      "1 approved fix is in the code but did not pass the wizard's checks (Improve the existing Meta pixel)"
    ])
  })

  it("a job whose kept edit the wizard never checked is checked on the tree when the budget ends: its checks decide (done in code)", async () => {
    // Round 1 claims only four; job 5's capture is in the tree unclaimed. Its fbc_capture passes on that tree.
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP], fbcCapture: ["pass"] })
    const outcome = await step.run(w.ctx, w.deps)
    const capture = w.current().jobs.find((item) => item.id === CAPTURE)!
    expect(DONE).toContain(capture.state)
    expect(w.calls.t0.flat().map((scenario) => scenario.checkId)).toContain("fbc_capture")
    expect((outcome as { message: string }).message).toBe("The agent ran out of time · 5 of 5 jobs done in code (checked by the wizard, not the agent)")
    expect(approvedFixClauses(missingApprovedFixes(w.current().jobs))).toEqual([])
  })

  it("negative: the same kept change whose check fails on that tree is failed, never ticked", async () => {
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP], fbcCapture: ["problem"] })
    await step.run(w.ctx, w.deps)
    const capture = w.current().jobs.find((item) => item.id === CAPTURE)!
    expect(capture.state).toBe("failed")
    expect(capture.note).toContain("The wizard's check failed: fbc_capture")
  })
})

describe("R4-6: the thinking beat says how far the jobs are and how much of the budget is gone", () => {
  it("'Thinking · N s' carries the claims so far and the minutes used of the measured budget", async () => {
    const root = tempDir("infinite-tag-run4-progress-")
    runGit(root, ["init", "-q", "-b", "main"])
    write(root, "app/layout.tsx", run4("site-b7c8347/app/layout.tsx"))
    runGit(root, ["add", "-A"])
    runGit(root, ["commit", "-q", "-m", "base"])
    dirs.push(root)
    const runner = {
      isAgentAlive: () => false,
      killAll: async () => undefined,
      detect: async () => ({ worker: null, reviewer: null, available: [] }),
      review: async () => ({ error: "unparseable" as const }),
      runJobs: async (input: Parameters<AgentRunnerImpl["runJobs"]>[0]) => {
        input.onClaim({ jobId: CAPTURE, status: "done", note: "", at: "2026-10-03T20:52:22.000Z" })
        input.onNarrate({ agent: "claude_code", role: "worker", text: "Thinking · 254 s" })
        input.onNarrate({ agent: "claude_code", role: "worker", text: "Editing app/layout.tsx" })
        return { outcome: "timeout" as const, session: { kind: "claude" as const, sessionId: "s" }, claims: [], questions: [], permissionDenials: 0, reverted: [], edits: [] }
      }
    }
    const { bridge } = fakeBridge()
    const state = baseState({
      root,
      runId: STEP_RUN_ID,
      agent: { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
      jobs: run4Items([JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE])
    })
    const { ctx, recorded } = makeCtx({ root, state })
    await step.run(ctx, makeDeps({ bridge, agents: runner as never, env: { HOME: root } }))
    const beats = recorded.events.filter((event) => event.type === "narrate").map((event) => (event.fields as { text: string }).text)
    expect(beats).toContain(`Thinking · 254 s · 1 of 5 claimed · 0 of ${AGENT_LIMITS.jobs.wallMs / 60_000} min`)
    // Other beats are left as the runner said them.
    expect(beats).toContain("Editing app/layout.tsx")
    // NEGATIVE: the bare beat run 4 printed is gone.
    expect(beats).not.toContain("Thinking · 254 s")
  })
})
