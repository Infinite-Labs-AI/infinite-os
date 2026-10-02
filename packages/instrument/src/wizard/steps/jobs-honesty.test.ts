// Step `jobs`: the honesty fixes from the O3 review (F4, F5, F6, F7, F8, F11, F14, F19), each with the
// case that went wrong before. The REAL runner over the fake claude binary (real mcp-proxy, real fence on
// a real git fixture); fake checks / registry / installer / bridge. No real agent, no network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner } from "../../../test/wizard/agents.js"
import { cleanup, makeFenceFixture, POST_INSTALL_LAYOUT, write } from "../../../test/wizard/repo.js"
import { agentItem, baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, FIXTURE_KEYS, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import { connectionIdsFromKeys } from "../../agents/connection-ids.js"
import { runExtras, type AgentRunnerImpl } from "../../agents/runner.js"
import type { AgentRunResult } from "../contracts/agents.js"
import type { WizardOptions } from "../contracts/deps.js"
import type { ChecklistItem, JobRegistry } from "../contracts/jobs.js"
import { CHECKED_NOTE, NOTHING_CHECKABLE_NOTE, step } from "./jobs.js"

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const claim = (jobId: string, status = "done", note = "done") => ({ tool: "job_claim", args: { job_id: jobId, status, note } })
const PAGE_BEFORE = "export default function Page() {\n  return <a href=\"/signup\">Start free trial</a>\n}\n"

function setup(input: {
  scenario: unknown
  items: ChecklistItem[]
  registry?: JobRegistry
  checks?: Parameters<typeof fakeChecks>[0]
  options?: Partial<WizardOptions>
  answer?: (kind: string, payload: unknown) => unknown
}) {
  const { root } = makeFenceFixture()
  const fakes = fakeAgents(input.scenario)
  dirs.push(root, fakes.home)
  const { checks, calls: checkCalls } = fakeChecks(input.checks)
  const gateIds: Array<readonly string[]> = []
  let runner: AgentRunnerImpl | null = null
  const { bridge, calls: bridgeCalls } = fakeBridge({ agents: () => runner })
  runner = makeRunner(fakes, root, { checks: { turnGate: (diff, ctx) => checks.turnGate(diff, ctx) } })
  const { installer, recorded: recordedEdits } = fakeInstaller()
  const state = baseState({
    root,
    runId: STEP_RUN_ID,
    agent: { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: structuredClone(input.items)
  })
  const { ctx, recorded, state: current } = makeCtx({ root, state, options: input.options, answer: input.answer as never })
  const spyChecks = {
    ...checks,
    turnGate: async (...args: Parameters<typeof checks.turnGate>) => {
      gateIds.push(args[1].connectionIds)
      return checks.turnGate(...args)
    }
  }
  const deps = makeDeps({ bridge, agents: runner, checks: spyChecks, registry: input.registry ?? fakeRegistry().registry, installer, env: { HOME: fakes.home } })
  return { root, ctx, deps, recorded, current, checkCalls, bridgeCalls, recordedEdits, gateIds, read: (rel: string) => readFileSync(join(root, rel), "utf8") }
}

/** F0's real tiers: ga4_improve has only T1/RH/PV checks, redirect_utms only T1 (nothing before deploy). */
function registryWithRealTiers(): JobRegistry {
  const base = fakeRegistry().registry
  return { ...base, checksFor: (item, tier) => (item.jobId === "ga4_improve" || item.jobId === "redirect_utms" ? [] : base.checksFor(item, tier)) }
}

describe("F4: a claim with nothing checkable before deploy is never 'checked by the wizard'", () => {
  it("ga4_improve claimed done with no S/B/T0 check → stays claimed, never 'later tests decide' (no later step ticks it)", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [claim("ga4_improve:spa_page_view", "done", "added the SPA page_view wiring")] }] },
      items: [agentItem("ga4_improve:spa_page_view", ["app/layout.tsx"])],
      registry: registryWithRealTiers()
    })
    const outcome = await step.run(t.ctx, t.deps)
    expect(t.current().jobs[0]!.state).toBe("claimed")
    expect(outcome).toEqual({ kind: "ok", status: "0 of 1 jobs done in code (checked by the wizard, not the agent) · 1 not checked by the wizard" })
    const notes = t.recorded.events.filter((event) => event.type === "job.state").map((event) => event.fields.note)
    expect(notes).toContain(NOTHING_CHECKABLE_NOTE)
    expect(notes).not.toContain(CHECKED_NOTE)
  })

  it("control: a job whose S check ran and passed is done_in_code with the 'checked' note", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("meta_improve:landing")] }] }, items: [agentItem("meta_improve:landing", ["app/layout.tsx"])] })
    await step.run(t.ctx, t.deps)
    // done_in_code, then the done path's next state (the one state machine, B7)
    expect(["done_in_code", "waiting_deploy", "waiting_real_event"]).toContain(t.current().jobs[0]!.state)
    expect(t.recorded.events.filter((event) => event.type === "job.state").map((event) => event.fields.note)).toContain(CHECKED_NOTE)
  })
})

describe("F5: a job the wizard's own check failed does not keep its agent edits", () => {
  const BAD = "export default function Page() {\n  return <a href=\"/signup\" onClick={() => fbq('track','StartTrial')}>Start</a>\n}\n"

  it("click_test keeps failing → failed, the edit undone, nothing in the receipt, no clickTested PATCH", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: BAD } }, claim("conversions_to_tools:trial")] }, { steps: [claim("conversions_to_tools:trial")] }] },
      items: [agentItem("conversions_to_tools:trial", ["app/page.tsx"])],
      checks: { results: { click_test: ["problem"], no_fbq_standard_on_click: ["problem"] } }
    })
    await step.run(t.ctx, t.deps)
    expect(t.current().jobs[0]!.state).toBe("failed")
    expect(t.read("app/page.tsx")).toBe(PAGE_BEFORE)
    expect(t.recordedEdits.flat()).toEqual([])
    expect(t.bridgeCalls.patchRun).toEqual([])
  })

  it("a click test that passes while the job still fails (its S check) adds nothing to clickTestedConversions", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: BAD } }, claim("conversions_to_tools:trial")] }, { steps: [claim("conversions_to_tools:trial")] }] },
      items: [agentItem("conversions_to_tools:trial", ["app/page.tsx"])],
      checks: { results: { click_test: ["pass"], no_fbq_standard_on_click: ["problem"] } }
    })
    await step.run(t.ctx, t.deps)
    expect(t.current().jobs[0]!.state).toBe("failed")
    expect(t.bridgeCalls.patchRun).toEqual([])
  })

  it("control: the passing job's edit stays and is recorded", async () => {
    const GOOD = "export default function Page() {\n  return <a href=\"/signup\" data-conversion=\"trial\">Start free trial</a>\n}\n"
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: GOOD } }, claim("conversions_to_tools:trial")] }] },
      items: [agentItem("conversions_to_tools:trial", ["app/page.tsx"])]
    })
    await step.run(t.ctx, t.deps)
    expect(t.read("app/page.tsx")).toBe(GOOD)
    expect(t.recordedEdits.flat().map((edit) => edit.file)).toEqual(["app/page.tsx"])
    expect(t.current().jobs[0]!.edits).toEqual([{ editId: expect.stringMatching(/^agent-/), file: "app/page.tsx" }])
  })
})

describe("F19: under --yes, a question and a done claim for one job in one turn", () => {
  it("the job stays blocked:needs_you and is never checked into done_in_code", async () => {
    const t = setup({
      scenario: {
        turns: [
          {
            steps: [
              { tool: "ask_user", args: { job_id: "meta_improve:landing", question: "Is /pricing a landing page?", why: "It has its own layout." } },
              claim("meta_improve:landing")
            ]
          }
        ]
      },
      items: [agentItem("meta_improve:landing", ["app/layout.tsx"])],
      options: { yes: true }
    })
    await step.run(t.ctx, t.deps)
    const item = t.current().jobs[0]!
    expect(item.state).toBe("blocked")
    expect(item.blockedReason).toBe("needs_you")
    expect(t.checkCalls.run).toEqual([])
    expect(t.checkCalls.build).toBe(0)
  })
})

describe("F11: a write after the turn settled stops the step before any build or T0", () => {
  it("a file changed while the user answers the batched question → blocked INF_WIZ_FENCE_TAMPER, nothing checked", async () => {
    let root = ""
    const t = setup({
      scenario: {
        turns: [
          {
            steps: [
              { tool: "ask_user", args: { job_id: "meta_improve:landing", question: "Is /pricing a landing page?", why: "It has its own layout." } },
              claim("conversions_to_tools:trial")
            ]
          }
        ]
      },
      items: [agentItem("meta_improve:landing", ["app/layout.tsx"]), agentItem("conversions_to_tools:trial", ["app/page.tsx"])],
      answer: (kind) => {
        // A process the agent left running writes while the pop-up is open.
        writeFileSync(join(root, "next.config.mjs"), "require('child_process')\n")
        return kind === "agent-questions" ? { answers: { "meta_improve:landing": "yes" } } : "__cancelled__"
      }
    })
    root = t.root
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_FENCE_TAMPER" })
    expect((outcome as { reason: string }).reason).toContain("next.config.mjs")
    expect(t.checkCalls.run).toEqual([])
    expect(t.checkCalls.build).toBe(0)
    expect(t.checkCalls.t0).toEqual([])
  })
})

describe("nested mode (F6, F7, F8)", () => {
  const nested = (items: ChecklistItem[]) => setup({ scenario: {}, items, options: { nested: true, json: true } })

  it("F6: the parent's own build (a .next write) ends the step blocked, and the next run starts clean (no ENOENT wedge)", async () => {
    const t = nested([agentItem("conversions_to_tools:trial", ["app/page.tsx"])])
    mkdirSync(join(t.root, ".next"), { recursive: true })
    writeFileSync(join(t.root, ".next/old.json"), "{}")
    expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "parked" })
    writeFileSync(join(t.root, ".next/BUILD_ID"), "x")
    t.ctx.options.resume = true
    expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_FENCE_TAMPER" })
    expect(t.current().snapshot).toBeNull()
    expect(t.current().jobs[0]!.state).toBe("blocked")
  })

  it("F6: a snapshot that vanished (cache purged) is reported, never an ENOENT crash", async () => {
    const t = nested([agentItem("conversions_to_tools:trial", ["app/page.tsx"])])
    expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "parked" })
    const { rmSync } = await import("node:fs")
    rmSync(t.current().snapshot!.dir, { recursive: true, force: true })
    t.ctx.options.resume = true
    expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_FENCE_TAMPER" })
    expect(t.current().snapshot).toBeNull()
  })

  it("F7: a second run WITHOUT --resume settles the open snapshot: the parent's consent edit is undone and blocks the job", async () => {
    const t = nested([agentItem("meta_improve:landing", ["app/layout.tsx"])])
    expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "parked" })
    write(t.root, "app/layout.tsx", `${POST_INSTALL_LAYOUT}gtag('consent', 'update', { ad_storage: 'granted' })\n`)
    const second = await step.run(t.ctx, t.deps) // no --resume
    expect(second.kind).toBe("ok")
    expect(t.read("app/layout.tsx")).toBe(POST_INSTALL_LAYOUT)
    expect(t.current().jobs[0]!.state).toBe("blocked")
    expect(t.current().jobs[0]!.blockedReason).toBe("consent_touched")
  })

  it("F8: the nested gate gets the connection's IDs from bridge.keys(), never an empty list", async () => {
    const t = nested([agentItem("meta_improve:landing", ["app/layout.tsx"])])
    await step.run(t.ctx, t.deps)
    write(t.root, "app/layout.tsx", `${POST_INSTALL_LAYOUT}// G-FIXTURE01\n`)
    t.ctx.options.resume = true
    await step.run(t.ctx, t.deps)
    expect(t.gateIds).toEqual([connectionIdsFromKeys(FIXTURE_KEYS)])
    expect(t.gateIds[0]).toEqual(["G-FIXTURE01", "ss_fixture"])
  })
})

describe("F14: a runner that returns only the §3f.1 shape cannot hide a fence block", () => {
  const base: AgentRunResult = { outcome: "completed", session: { kind: "claude", sessionId: "s" }, claims: [], questions: [], permissionDenials: 0, reverted: [], edits: [] }

  it("reverted paths with no `blocked` list → every item of the turn is blocked (fail closed)", () => {
    const extras = runExtras({ ...base, reverted: ["app/layout.tsx"] }, [{ id: "a:1" }, { id: "b:2" }])
    expect(extras.blocked.map((block) => [block.itemId, block.reason])).toEqual([
      ["a:1", "outside_allowlist"],
      ["b:2", "outside_allowlist"]
    ])
  })

  it("control: nothing reverted → nothing blocked; an explicit list is used as is", () => {
    expect(runExtras(base, [{ id: "a:1" }]).blocked).toEqual([])
    const explicit = [{ itemId: "a:1", reason: "consent_touched" as const, paths: ["x"], note: "n" }]
    expect(runExtras({ ...base, reverted: ["x"], blocked: explicit } as AgentRunResult, [{ id: "a:1" }, { id: "b:2" }]).blocked).toEqual(explicit)
  })
})

describe("I1b: a check this build cannot run keeps the job claimed, never crashes the step", () => {
  const notRegistered = (checkId: string) => Object.assign(new Error(`no check is registered under "${checkId}"`), { name: "CheckNotRegisteredError" })

  it("an S check with no implementation (e.g. identify_on_auth_success) → undetermined, the item stays claimed", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("identify_reset:auth")] }] }, items: [agentItem("identify_reset:auth", ["app/layout.tsx"])] })
    t.deps.checks.run = async (checkId: string) => {
      throw notRegistered(checkId)
    }
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome.kind).toBe("ok")
    expect(t.current().jobs[0]!.state).toBe("claimed")
    const results = t.recorded.events.filter((event) => event.type === "check.result").map((event) => event.fields)
    expect(results).toContainEqual(expect.objectContaining({ checkId: "identify_reset_static", state: "undetermined", reason: expect.stringContaining("cannot check identify_reset_static") }))
  })

  it("a T0 scenario the wizard cannot build for the item → undetermined for that item, still claimed", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }] }, items: [agentItem("conversions_to_tools:trial", ["app/page.tsx"])] })
    t.deps.checks.t0 = async () => {
      throw Object.assign(new Error("click_test: params.clicks must list at least one {selector, label, expect}"), { name: "T0ScenarioError" })
    }
    await step.run(t.ctx, t.deps)
    expect(t.current().jobs[0]!.state).toBe("claimed")
    expect(t.recorded.events.filter((event) => event.type === "check.result").map((event) => event.fields)).toContainEqual(
      expect.objectContaining({ checkId: "click_test", tier: "T0", state: "undetermined" })
    )
  })

  it("NEGATIVE: any other failure of a check still stops the step loudly (never read as fine)", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("identify_reset:auth")] }] }, items: [agentItem("identify_reset:auth", ["app/layout.tsx"])] })
    t.deps.checks.run = async () => {
      throw new Error("the census crashed")
    }
    await expect(step.run(t.ctx, t.deps)).rejects.toThrow("the census crashed")
  })
})
