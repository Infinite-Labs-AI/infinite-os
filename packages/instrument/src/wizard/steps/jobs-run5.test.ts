// Live run 5 (P2), through the REAL jobs step (real runner over the fake claude, real fence):
//   - the failed job's note read "The wizard's check failed:." (empty): a job sent back by a check that did not run that
//     round now names that check;
//   - changing --reviewer never re-opens the jobs step.
// (A job whose Infinite bytes are in place when the rehearsal finds a problem is failed at the rehearsal itself:
// `review/rehearse-in-place.test.ts`.)
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner, runs } from "../../../test/wizard/agents.js"
import { agentItem, baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import { cleanup, makeFenceFixture, POST_INSTALL_LAYOUT, write } from "../../../test/wizard/repo.js"
import type { AgentRunnerImpl } from "../../agents/runner.js"
import { GA4_PAGE_CHANGE_SCRIPT } from "../../jobs/briefs.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import { step } from "./jobs.js"

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const SPA = "ga4_improve:spa_page_view"
const RH_PROBLEM = "ga4_spa_page_view_missing — no page_view after the page change"

function spaItem(rh: "problem" | "not_run"): ChecklistItem {
  const item = agentItem(SPA, ["app/layout.tsx"])
  item.title = "Improve the existing GA4"
  item.checks = [
    { id: "ga4_one_page_view", tier: "RH", state: rh === "problem" ? "pass" : "not_run" },
    rh === "problem" ? { id: "ga4_spa_page_view", tier: "RH", state: "problem", runId: STEP_RUN_ID, at: "2026-10-04T04:35:50.000Z", reason: RH_PROBLEM } : { id: "ga4_spa_page_view", tier: "RH", state: "not_run" },
    { id: "ga4_seen_leaving", tier: "PV", state: "not_run" }
  ]
  item.edits = [{ editId: "agent-run1-t1-0", file: "app/layout.tsx" }]
  return item
}

function setup(input: { pasted: boolean; rh: "problem" | "not_run" }) {
  const { root } = makeFenceFixture()
  // Run 1 pasted Infinite's bytes into the layout (kept, committed); run 2 re-opens the job.
  write(root, "app/layout.tsx", input.pasted ? `${POST_INSTALL_LAYOUT}\n/* ga4 */\n${GA4_PAGE_CHANGE_SCRIPT}\n` : POST_INSTALL_LAYOUT)
  // An agent that would edit the layout and claim the job if it were ever asked.
  const fakes = fakeAgents({ turns: [{ steps: [{ edit: { path: "app/layout.tsx", content: `${POST_INSTALL_LAYOUT}\n// agent\n` } }, { tool: "job_claim", args: { job_id: SPA, status: "done", note: "done" } }] }] })
  dirs.push(root, fakes.home)
  const { checks } = fakeChecks()
  let runner: AgentRunnerImpl | null = null
  const { bridge } = fakeBridge({ agents: () => runner })
  runner = makeRunner(fakes, root, { checks: { turnGate: (diff, ctx) => checks.turnGate(diff, ctx) } })
  const { registry, briefs } = fakeRegistry()
  const { installer } = fakeInstaller()
  const state = baseState({
    root,
    runId: STEP_RUN_ID,
    agent: { worker: "claude_code", reviewer: "brief", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: [spaItem(input.rh)]
  })
  const { ctx, state: current } = makeCtx({ root, state })
  const deps = makeDeps({ bridge, agents: runner, checks, registry, installer, env: { HOME: fakes.home } })
  return { ctx, deps, current, fakes, briefs }
}

const job = (current: () => { jobs: ChecklistItem[] }) => current().jobs.find((entry) => entry.id === SPA)!

describe("live run 5: the jobs step", () => {
  it("a job sent back by the rehearsal's check (no result this round) names that check, never an empty reason", async () => {
    const w = setup({ pasted: false, rh: "problem" })
    await step.run(w.ctx, w.deps)
    expect(runs(w.fakes).length).toBeGreaterThan(0)
    const item = job(w.current)
    expect(["pending", "failed"]).toContain(item.state)
    expect(item.note).toContain("ga4_spa_page_view: ga4_spa_page_view_missing")
    expect(item.note).not.toMatch(/check failed:\s*\./)
  })

  it("changing --reviewer never re-opens the jobs step: its inputs are its jobs and the plan, not who reviews", () => {
    const w = setup({ pasted: true, rh: "problem" })
    const codex = step.inputHash({ ...w.ctx, options: { ...w.ctx.options, reviewer: "codex" } } as never)
    const brief = step.inputHash({ ...w.ctx, options: { ...w.ctx.options, reviewer: "brief" } } as never)
    expect(brief).toBe(codex)
  })
})

