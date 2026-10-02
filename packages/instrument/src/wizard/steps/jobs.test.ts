// Step `jobs` with the REAL runner over the fake claude binary (real mcp-proxy, real fence on a real git
// fixture) and fake checks / registry / installer / bridge. No real agent, no model, no network.
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner, runs } from "../../../test/wizard/agents.js"
import { cleanup, makeFenceFixture, POST_INSTALL_LAYOUT, write } from "../../../test/wizard/repo.js"
import { agentItem, baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import type { AgentRunnerImpl } from "../../agents/runner.js"
import type { WizardOptions } from "../contracts/deps.js"
import type { CheckResult, ChecklistItem, CheckRunner } from "../contracts/jobs.js"
import { NESTED_BRIEF_PATH, step } from "./jobs.js"

// These spawn real node fakes, the built mcp-proxy and git for up to 4 rounds: the 5 s default is too
// tight under a loaded full-suite run (review O3 F15).
vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const PAGE_EDIT = "export default function Page() {\n  return <a href=\"/signup\" data-conversion=\"trial\">Start free trial</a>\n}\n"
const ITEMS: ChecklistItem[] = [
  agentItem("meta_improve:landing", ["app/layout.tsx", "next.config.mjs"]),
  agentItem("conversions_to_tools:trial", ["app/page.tsx"])
]
const claim = (jobId: string, status = "done", note = "done") => ({ tool: "job_claim", args: { job_id: jobId, status, note } })

function setup(input: {
  scenario: unknown
  checks?: Parameters<typeof fakeChecks>[0]
  options?: Partial<WizardOptions>
  answer?: (kind: string, payload: unknown) => unknown
  items?: ChecklistItem[]
  worker?: "claude_code" | "codex" | null
  notNeededAgrees?: boolean
}) {
  const { root } = makeFenceFixture()
  const fakes = fakeAgents(input.scenario)
  dirs.push(root, fakes.home)
  const { checks, calls: checkCalls } = fakeChecks(input.checks)
  let runner: AgentRunnerImpl | null = null
  const { bridge, calls: bridgeCalls } = fakeBridge({ agents: () => runner })
  runner = makeRunner(fakes, root, { checks: { turnGate: (diff, ctx) => checks.turnGate(diff, ctx) } })
  const { registry, briefs } = fakeRegistry({ notNeededAgrees: input.notNeededAgrees })
  const { installer, recorded: recordedEdits } = fakeInstaller()
  const worker = input.worker === undefined ? "claude_code" : input.worker
  const state = baseState({
    root,
    runId: STEP_RUN_ID,
    agent: worker ? { worker, reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } } : { worker: null, reviewer: "brief", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: structuredClone(input.items ?? ITEMS)
  })
  const { ctx, recorded, state: current } = makeCtx({ root, state, options: input.options, answer: input.answer as never })
  const deps = makeDeps({ bridge, agents: runner, checks, registry, installer, env: { HOME: fakes.home } })
  return { root, fakes, ctx, deps, recorded, current, checkCalls, bridgeCalls, briefs, recordedEdits, runner }
}

function stateOf(items: ChecklistItem[], id: string) {
  const item = items.find((entry) => entry.id === id)!
  return item.state === "blocked" ? `blocked:${item.blockedReason}` : item.state
}

describe("step jobs: claims are only claims; the wizard checks", () => {
  it("claimed + S/B/T0 pass → done_in_code; edits recorded; clickTested PATCHed once no agent is alive", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: PAGE_EDIT } }, claim("conversions_to_tools:trial"), claim("meta_improve:landing")] }] }
    })
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toEqual({ kind: "ok", status: "2 of 2 jobs done in code (checked by the wizard, not the agent)" })
    const items = t.current().jobs
    expect(stateOf(items, "conversions_to_tools:trial")).toBe("done_in_code")
    expect(stateOf(items, "meta_improve:landing")).toBe("done_in_code")
    expect(items.find((entry) => entry.id === "conversions_to_tools:trial")!.claim?.status).toBe("done")
    expect(items.find((entry) => entry.id === "conversions_to_tools:trial")!.edits).toEqual([{ editId: expect.stringMatching(/^agent-/), file: "app/page.tsx" }])
    expect(t.recordedEdits.flat().map((edit) => [edit.file, edit.by])).toEqual([["app/page.tsx", "agent"]])
    expect(t.bridgeCalls.patchRun).toEqual([{ runId: STEP_RUN_ID, patch: { clickTestedConversions: ["trial"] }, agentAlive: false }])
    expect(t.checkCalls.turnGate).toBe(1)
    expect(t.checkCalls.build).toBe(1)
    const states = t.recorded.events.filter((event) => event.type === "job.state").map((event) => [event.fields.itemId, event.fields.state, event.fields.by])
    expect(states).toContainEqual(["conversions_to_tools:trial", "claimed", "agent_claim"])
    expect(states).toContainEqual(["conversions_to_tools:trial", "done_in_code", "wizard"])
    expect(t.recorded.events.filter((event) => event.type === "check.result").every((event) => event.fields.runId === STEP_RUN_ID)).toBe(true)
  })

  it("a claim without a passing check is NOT done: a failed T0 click test goes back to the agent with the note (resume round)", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }, { steps: [claim("conversions_to_tools:trial", "done", "fixed the handler")] }] },
      checks: { results: { click_test: ["problem", "pass"] } },
      items: [ITEMS[1]!]
    })
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome.kind).toBe("ok")
    const [first, second] = runs(t.fakes, "claude")
    expect(second!.argv).toContain("--resume")
    expect(second!.argv![second!.argv!.indexOf("--resume") + 1]).toBe(first!.argv![first!.argv!.indexOf("--session-id") + 1])
    expect(second!.argv![second!.argv!.indexOf("--append-system-prompt") + 1]).toContain("the wizard's checks failed: click_test")
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("done_in_code")
    expect(t.bridgeCalls.patchRun).toHaveLength(1)
  })

  it("a check that keeps failing until the rounds run out → failed, never done (negative)", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }] }, checks: { results: { click_test: ["problem"] } }, items: [ITEMS[1]!] })
    const outcome = await step.run(t.ctx, t.deps)
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("failed")
    expect(runs(t.fakes, "claude")).toHaveLength(4)
    expect(t.bridgeCalls.patchRun).toEqual([])
    expect(outcome).toMatchObject({ kind: "ok" })
  })

  it("an undetermined check leaves the item claimed (undetermined never counts as pass)", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }] }, checks: { results: { click_test: ["undetermined"] } }, items: [ITEMS[1]!] })
    await step.run(t.ctx, t.deps)
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("claimed")
    expect(t.bridgeCalls.patchRun).toEqual([])
  })

  it("not_needed is re-checked by the detector: a disagreement sends it back", async () => {
    const disagree = setup({ scenario: { turns: [{ steps: [claim("meta_improve:landing", "not_needed", "already there")] }, { steps: [claim("meta_improve:landing")] }] }, items: [ITEMS[0]!] })
    await step.run(disagree.ctx, disagree.deps)
    const notes = disagree.recorded.events.filter((event) => event.type === "job.state").map((event) => String(event.fields.note ?? ""))
    expect(notes.some((note) => note.includes("the wizard found app/api/signup/route.ts:12"))).toBe(true)
    expect(stateOf(disagree.current().jobs, "meta_improve:landing")).toBe("done_in_code")
    const agree = setup({ scenario: { turns: [{ steps: [claim("meta_improve:landing", "not_needed", "already there")] }] }, items: [ITEMS[0]!], notNeededAgrees: true })
    await step.run(agree.ctx, agree.deps)
    expect(stateOf(agree.current().jobs, "meta_improve:landing")).toBe("not_needed")
  })
})

describe("step jobs: questions, usage, fence", () => {
  it("ask_user → ONE batched agent-questions ask after the turn, then a resume with the answer", async () => {
    const t = setup({
      scenario: {
        turns: [
          { steps: [{ tool: "ask_user", args: { job_id: "meta_improve:landing", question: "Is /pricing a landing page?", why: "Own layout." } }, { tool: "ask_user", args: { job_id: "conversions_to_tools:trial", question: "Which button starts the trial?", why: "Two candidates." } }] },
          { steps: [claim("meta_improve:landing"), claim("conversions_to_tools:trial")] }
        ]
      },
      answer: (kind) => (kind === "agent-questions" ? { answers: { "meta_improve:landing": "yes", "conversions_to_tools:trial": "the hero button" } } : "__cancelled__")
    })
    await step.run(t.ctx, t.deps)
    expect(t.recorded.asks).toHaveLength(1)
    expect(t.recorded.asks[0]!.kind).toBe("agent-questions")
    expect((t.recorded.asks[0]!.payload as { questions: unknown[] }).questions).toHaveLength(2)
    const second = runs(t.fakes, "claude")[1]!
    expect(second.argv![second.argv!.indexOf("--append-system-prompt") + 1]).toContain('the user answered "the hero button"')
  })

  it("under --yes nothing is asked: the item is blocked:needs_you (negative)", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [{ tool: "ask_user", args: { job_id: "meta_improve:landing", question: "Is /pricing a landing page?", why: "x" } }] }] },
      options: { yes: true },
      items: [ITEMS[0]!]
    })
    await step.run(t.ctx, t.deps)
    expect(t.recorded.asks).toEqual([])
    expect(stateOf(t.current().jobs, "meta_improve:landing")).toBe("blocked:needs_you")
  })

  it("out of usage → parked AGENT_OUT_OF_USAGE, edits undone, session kept in state for the resume", async () => {
    const t = setup({ scenario: { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: PAGE_EDIT } }, { replay: "claude-rate-limit-rejected.jsonl" }, { sleep: 5000 }] }] } })
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_AGENT_OUT_OF_USAGE" })
    expect((outcome as { reason: string }).reason).toMatch(/resets at .*; run `npx infinite-tag` again to resume/)
    expect(readFileSync(join(t.root, "app/page.tsx"), "utf8")).not.toContain("data-conversion")
    expect(t.current().agent?.workerSession).toMatchObject({ kind: "claude", sessionId: expect.any(String) })
    expect(t.checkCalls.build).toBe(0)
  })

  it("a new file under node_modules → blocked FENCE_TAMPER and NO build or T0 ran", async () => {
    const t = setup({ scenario: { turns: [{ steps: [{ edit: { path: "node_modules/next/x.js", content: "1" } }, claim("conversions_to_tools:trial")] }] } })
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_FENCE_TAMPER" })
    expect(t.checkCalls.build).toBe(0)
    expect(t.checkCalls.t0).toEqual([])
    expect(t.checkCalls.run).toEqual([])
  })

  it("a turn that adds child_process to next.config.mjs → reverted, job blocked, build never called", async () => {
    const gate: CheckRunner["turnGate"] = async (diff) =>
      diff.files.flatMap((file) =>
        file.added.filter((line) => line.text.includes("child_process")).map((line): CheckResult => ({ checkId: "turn_gate_exec", state: "problem", evidence: [{ file: file.path, line: line.line }], tier: "S", at: "x", runId: STEP_RUN_ID }))
      )
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "next.config.mjs", content: "const { exec } = require('child_process')\nexport default {}\n" } }, claim("meta_improve:landing")] }] },
      checks: { gate },
      items: [ITEMS[0]!]
    })
    await step.run(t.ctx, t.deps)
    expect(readFileSync(join(t.root, "next.config.mjs"), "utf8")).not.toContain("child_process")
    expect(stateOf(t.current().jobs, "meta_improve:landing")).toBe("blocked:outside_allowlist")
    expect(t.checkCalls.build).toBe(0)
  })

  it("a toolless agent → failed AGENT_TOOLLESS (continue), jobs blocked:toolless", async () => {
    const t = setup({ scenario: { turns: [{ mcp: "skip" }] } })
    expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "failed", code: "INF_WIZ_AGENT_TOOLLESS", next: "continue" })
    expect(t.current().jobs.map((item) => stateOf([item], item.id))).toEqual(["blocked:toolless", "blocked:toolless"])
  })

  it("no worker → the agent jobs are listed for the user and no agent is spawned", async () => {
    const t = setup({ scenario: {}, worker: null })
    expect(await step.run(t.ctx, t.deps)).toEqual({ kind: "ok", status: "No agent: 2 jobs listed for you" })
    expect(runs(t.fakes)).toEqual([])
    expect(t.current().jobs.map((item) => stateOf([item], item.id))).toEqual(["blocked:needs_you", "blocked:needs_you"])
  })
})

describe("step jobs: nested mode (§3d.7)", () => {
  it("seeds the jobs for the parent agent, parks, then fences and checks its edits on --resume", async () => {
    const t = setup({ scenario: {}, options: { nested: true, json: true } })
    const parked = await step.run(t.ctx, t.deps)
    expect(parked).toMatchObject({ kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS" })
    expect(t.recorded.events.filter((event) => event.type === "job.seeded")).toHaveLength(2)
    expect(existsSync(join(t.root, NESTED_BRIEF_PATH))).toBe(true)
    expect(statSync(join(t.root, NESTED_BRIEF_PATH)).mode & 0o777).toBe(0o600)
    const dir = t.current().snapshot!.dir
    expect(dir.startsWith(join(t.fakes.home, "Library/Caches/infinite-tag/snapshots/"))).toBe(true)
    expect(runs(t.fakes)).toEqual([])
    // The parent agent works…
    write(t.root, "app/page.tsx", PAGE_EDIT)
    write(t.root, "lib/stray.ts", "export const stray = 1\n")
    write(t.root, "app/layout.tsx", `${POST_INSTALL_LAYOUT}gtag('consent', 'update', {})\n`)
    // …then the user (or the parent) resumes.
    t.ctx.options.resume = true
    const resumed = await step.run(t.ctx, t.deps)
    expect(resumed.kind).toBe("ok")
    expect(readFileSync(join(t.root, "lib/stray.ts"), "utf8")).toBe("export const stray = 1\n")
    expect(t.recorded.events.some((event) => String(event.fields.text ?? "").includes("Left unstaged (outside every job's files): lib/stray.ts"))).toBe(true)
    expect(readFileSync(join(t.root, "app/layout.tsx"), "utf8")).toBe(POST_INSTALL_LAYOUT)
    expect(stateOf(t.current().jobs, "meta_improve:landing")).toBe("blocked:consent_touched")
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("done_in_code")
    expect(t.current().snapshot).toBeNull()
    expect(t.recordedEdits.flat().map((edit) => edit.file)).toEqual(["app/page.tsx"])
  })
})
