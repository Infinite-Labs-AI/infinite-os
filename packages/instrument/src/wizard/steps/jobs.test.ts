// Step `jobs` with the REAL runner over the fake claude binary (real mcp-proxy, real fence on a real git
// fixture) and fake checks / registry / installer / bridge. No real agent, no model, no network.
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import ts from "typescript"

import { assertBuilt, fakeAgents, makeRunner, records, runs } from "../../../test/wizard/agents.js"
import { cleanup, makeFenceFixture, POST_INSTALL_LAYOUT, runGit, write } from "../../../test/wizard/repo.js"
import { agentItem, baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import type { AgentRunnerImpl } from "../../agents/runner.js"
import type { WizardOptions } from "../contracts/deps.js"
import type { CheckResult, ChecklistItem, CheckRunner } from "../contracts/jobs.js"
import { NESTED_BRIEF_PATH, step } from "./jobs.js"
import { verifyFinalSeal } from "../../agents/fence.js"
import { finalSealPath } from "../../agents/paths.js"

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
  const deps = makeDeps({ root, bridge, agents: runner, checks, registry, installer, env: { HOME: fakes.home } })
  return { root, fakes, ctx, deps, recorded, current, checkCalls, bridgeCalls, briefs, recordedEdits, runner }
}

function stateOf(items: ChecklistItem[], id: string) {
  const item = items.find((entry) => entry.id === id)!
  return item.state === "blocked" ? `blocked:${item.blockedReason}` : item.state
}

describe("step jobs: claims are only claims; the wizard checks", () => {
  it("frozen Meta jobs are withheld while unrelated same-file jobs pass with separate ambient declarations", async () => {
    const file = "src/common/tracking.ts"
    const ambient = [
      "declare const gtag: (...args: unknown[]) => void;",
      "declare const posthog: { init(key: string, options: object): void };",
      "declare const fbq: (...args: unknown[]) => void;",
      "declare function allowHost(): boolean;"
    ].join("\n")
    const base = [
      "export function ga() { gtag('config', 'G-FAKE00001'); }",
      "export function ph() { posthog.init('phc_FAKE', { api_host: 'https://us.i.posthog.com' }); }",
      "export function meta() {",
      "  fbq('init', '1234567890123456');",
      "  fbq('consent', 'grant');",
      "  fbq('track', 'PageView');",
      "}", ""
    ].join("\n")
    const gaGuarded = base.replace("gtag('config', 'G-FAKE00001');", "if (allowHost()) gtag('config', 'G-FAKE00001');")
    const phGuarded = gaGuarded.replace("posthog.init('phc_FAKE', { api_host: 'https://us.i.posthog.com' });", "if (allowHost()) posthog.init('phc_FAKE', { api_host: '/ingest' });")
    const sensitive = phGuarded.replace("api_host: '/ingest'", "api_host: '/ingest', mask_all_text: true")
    const ids = ["meta_improve:capture", "preview_guard:meta", "preview_guard:ga4", "preview_guard:posthog", "posthog_improve:sensitive_pages"]
    const t = setup({
      scenario: { turns: [{ steps: [
        { tool: "report_progress", args: { job_id: ids[0], text: "Capture" } },
        claim(ids[0]!),
        { tool: "report_progress", args: { job_id: ids[1], text: "Meta guard" } },
        claim(ids[1]!),
        { tool: "report_progress", args: { job_id: ids[2], text: "GA guard" } },
        { edit: { path: file, content: gaGuarded } }, claim(ids[2]!),
        { tool: "report_progress", args: { job_id: ids[3], text: "PostHog guard" } },
        { edit: { path: file, content: phGuarded } }, claim(ids[3]!),
        { tool: "report_progress", args: { job_id: ids[4], text: "Sensitive pages" } },
        { edit: { path: file, content: sensitive } }, claim(ids[4]!)
      ] }] },
      items: ids.map((id, index) => ({ ...agentItem(id, [file]), trigger: { finding: "Fixture edit place", evidence: [{ file, line: [4, 4, 1, 2, 2][index]! }] } }))
    })
    write(t.root, file, base)
    const declarations = "src/tracking-globals.d.ts"
    write(t.root, declarations, ambient)
    runGit(t.root, ["add", file, declarations])
    runGit(t.root, ["commit", "-m", "tracking fixture"])
    expect((await step.run(t.ctx, t.deps)).kind).toBe("ok")
    const jobs = t.current().jobs
    for (const id of ids.slice(0, 2)) expect(jobs.find((job) => job.id === id)).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "frozen_unit", file } })
    for (const id of ids.slice(2)) expect(jobs.find(job => job.id === id)?.state, id).toMatch(/done_in_code|waiting_deploy/)
    const final = readFileSync(join(t.root, file), "utf8")
    expect(final).toContain("mask_all_text: true")
    expect(final).not.toContain("  if (allowHost()) {")
    expect(final).toContain(base.slice(base.indexOf("export function meta()")))
    expect(readFileSync(join(t.root, declarations), "utf8")).toBe(ambient)
    const program = ts.createProgram([join(t.root, file), join(t.root, declarations)], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], skipLibCheck: true })
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    const metaReply = records(t.fakes).filter((entry) => entry.kind === "mcp" && entry.tool === "job_claim")[1]?.reply?.result?.structuredContent
    expect(metaReply).toMatchObject({ error: expect.stringContaining("unknown job_id preview_guard:meta") }) // Never offered to the agent.
  })

  it("claimed + S/B/T0 pass → done_in_code; edits recorded; clickTested PATCHed once no agent is alive", async () => {
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "app/page.tsx", content: PAGE_EDIT } }, claim("conversions_to_tools:trial"), claim("meta_improve:landing")] }] }
    })
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toEqual({ kind: "ok", status: "2 of 2 jobs done in code (checked by the wizard, not the agent)" })
    const items = t.current().jobs
    // §3e.5 done paths (the one state machine, B7): past done_in_code to the next waiting state.
    expect(stateOf(items, "conversions_to_tools:trial")).toBe("waiting_real_event")
    expect(stateOf(items, "meta_improve:landing")).toBe("waiting_deploy")
    expect(items.find((entry) => entry.id === "conversions_to_tools:trial")!.claim?.status).toBe("done")
    expect(items.find((entry) => entry.id === "conversions_to_tools:trial")!.edits).toEqual([{ editId: expect.stringMatching(/^agent-/), file: "app/page.tsx" }])
    expect(t.recordedEdits.flat().map((edit) => [edit.file, edit.by])).toEqual([["app/page.tsx", "agent"]])
    expect(t.bridgeCalls.patchRun).toEqual([{ runId: STEP_RUN_ID, patch: { clickTestedConversions: ["trial"] }, agentAlive: false }])
    expect(t.checkCalls.turnGate).toBe(1)
    expect(t.checkCalls.build).toBe(1)
    expect(t.recorded.events.filter((event) => event.type === "job.seeded")).toHaveLength(2)
    expect(t.recorded.events.filter((event) => event.type === "job.progress").map((event) => event.fields.state)).toEqual(["agent_claim", "checking", "agent_claim", "checking"])
    expect(t.recorded.events.some((event) => event.type === "step.status" && String(event.fields.text).includes("files read"))).toBe(true)
    expect(t.recorded.events.some((event) => event.type === "step.status" && String(event.fields.text).includes("1 edited"))).toBe(true)
    const states = t.recorded.events.filter((event) => event.type === "job.state").map((event) => [event.fields.itemId, event.fields.state, event.fields.by])
    expect(states).toContainEqual(["conversions_to_tools:trial", "claimed", "agent_claim"])
    // Review I1 P3-3: one `claimed` per claim (never once on the claim and again on apply).
    expect(states.filter(([id, state]) => id === "conversions_to_tools:trial" && state === "claimed")).toHaveLength(1)
    expect(states).toContainEqual(["conversions_to_tools:trial", "waiting_real_event", "wizard"])
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
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("waiting_real_event")
    expect(t.bridgeCalls.patchRun).toHaveLength(1)
  })

  it("a check that keeps failing until the rounds run out → failed, never done (negative)", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }] }, checks: { results: { click_test: ["problem"] } }, items: [ITEMS[1]!] })
    const outcome = await step.run(t.ctx, t.deps)
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("left_for_you")
    expect(t.recorded.events.filter((event) => event.type === "job.state").map((event) => event.fields)).toContainEqual(expect.objectContaining({
      itemId: "conversions_to_tools:trial",
      state: "left_for_you",
      by: "wizard",
      note: expect.stringContaining("click_test")
    }))
    expect(runs(t.fakes, "claude")).toHaveLength(4)
    expect(t.bridgeCalls.patchRun).toEqual([])
    expect(outcome).toMatchObject({ kind: "ok" })
  })

  it("an undetermined check leaves the job for the owner and removes its unverified edits", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }] }, checks: { results: { click_test: ["undetermined"] } }, items: [ITEMS[1]!] })
    await step.run(t.ctx, t.deps)
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("left_for_you")
    expect(t.bridgeCalls.patchRun).toEqual([])
  })

  it("not_needed is re-checked by the detector: a disagreement sends it back", async () => {
    const disagree = setup({ scenario: { turns: [{ steps: [claim("meta_improve:landing", "not_needed", "already there")] }, { steps: [claim("meta_improve:landing")] }] }, items: [ITEMS[0]!] })
    await step.run(disagree.ctx, disagree.deps)
    const notes = disagree.recorded.events.filter((event) => event.type === "job.state").map((event) => String(event.fields.note ?? ""))
    expect(notes.some((note) => note.includes("the wizard found app/api/signup/route.ts:12"))).toBe(true)
    expect(stateOf(disagree.current().jobs, "meta_improve:landing")).toBe("waiting_deploy")
    const agree = setup({ scenario: { turns: [{ steps: [claim("meta_improve:landing", "not_needed", "already there")] }] }, items: [ITEMS[0]!], notNeededAgrees: true })
    await step.run(agree.ctx, agree.deps)
    expect(stateOf(agree.current().jobs, "meta_improve:landing")).toBe("not_needed")
  })
})

describe("step jobs: check reasons are secret-scanned (review I1 P2-6)", () => {
  it("a build failure that prints a .env value never reaches the agent's next brief, a job note or an event", async () => {
    const leaked = "fixture-not-a-secret"
    const t = setup({
      scenario: { turns: [{ steps: [claim("server_conversions:signup")] }, { steps: [claim("server_conversions:signup")] }] },
      checks: {
        build: [
          { ok: false, failureSignature: [`Error: connect ECONNREFUSED postgres://app:${leaked}@db/prod`], durationMs: 1 },
          { ok: true, failureSignature: [], durationMs: 1 }
        ]
      },
      items: [agentItem("server_conversions:signup", ["app/api/signup/route.ts"])]
    })
    await step.run(t.ctx, t.deps)
    const [, second] = runs(t.fakes, "claude")
    const brief = second!.argv![second!.argv!.indexOf("--append-system-prompt") + 1]!
    expect(brief).toContain("the wizard's checks failed: build")
    expect(brief).not.toContain(leaked)
    expect(brief).toContain("[redacted: env_value]")
    expect(JSON.stringify(t.recorded.events)).not.toContain(leaked)
    expect(JSON.stringify(t.current().jobs)).not.toContain(leaked)
  })
})

describe("step jobs: the wizard's own build may write only its output (review I1 P1-3)", () => {
  async function runWithBuild(write: (root: string) => void) {
    const t = setup({ scenario: { turns: [{ steps: [claim("server_conversions:signup")] }] }, items: [agentItem("server_conversions:signup", ["app/api/signup/route.ts"])] })
    const build = t.deps.checks.build
    t.deps.checks.build = async () => {
      write(t.root)
      return build()
    }
    const outcome = await step.run(t.ctx, t.deps)
    return { t, outcome }
  }

  it("a build that writes a hook config (outside its output dirs) stops the step, and the rehearsal's seal refuses the tree", async () => {
    const { t, outcome } = await runWithBuild((root) => write(root, ".lintstagedrc", '{ "*": "curl https://e.example" }\n'))
    expect(outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_FENCE_TAMPER" })
    expect((outcome as { reason: string }).reason).toContain(".lintstagedrc")
    const verdict = await verifyFinalSeal(t.root, finalSealPath(t.fakes.home, STEP_RUN_ID))
    expect(verdict?.ok).toBe(false)
    expect(verdict?.changed).toContain(".lintstagedrc")
  })
})

describe("step jobs: a running dev server (§3z.12 B21)", () => {
  it("a write under node_modules in the 2-second quiet window parks DEV_SERVER_RUNNING before any agent turn", async () => {
    const t = setup({ scenario: { turns: [{ steps: [claim("conversions_to_tools:trial")] }] } })
    t.deps.clock.sleep = async () => {
      // the "dev server" writes while the wizard waits (after the marker)
      await new Promise((resolve) => setTimeout(resolve, 20))
      write(t.root, "node_modules/.cache/next-dev.json", "{}\n")
    }
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_DEV_SERVER_RUNNING" })
    expect(runs(t.fakes)).toEqual([])
  })
})

describe("step jobs: the fence", () => {
  it("a new file under node_modules → blocked FENCE_TAMPER and NO build or T0 ran", async () => {
    const t = setup({ scenario: { turns: [{ steps: [{ edit: { path: "node_modules/next/x.js", content: "1" } }, claim("conversions_to_tools:trial")] }] } })
    const outcome = await step.run(t.ctx, t.deps)
    expect(outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_FENCE_TAMPER" })
    expect(t.checkCalls.build).toBe(0)
    expect(t.checkCalls.t0).toEqual([])
    expect(t.checkCalls.run).toEqual([])
  })

  it("a turn that adds child_process to next.config.mjs → reverted, the job's turn_gate S check fails with the real reason, build never called (§3x.2)", async () => {
    const gate: CheckRunner["turnGate"] = async (diff) =>
      diff.files.flatMap((file) =>
        file.added
          .filter((line) => line.text.includes("child_process"))
          .map((line): CheckResult => ({ checkId: "turn_gate", state: "problem", reason: "child_process: the edit starts a child process", evidence: [{ file: file.path, line: line.line }], tier: "S", at: "x", runId: STEP_RUN_ID }))
      )
    const t = setup({
      scenario: { turns: [{ steps: [{ edit: { path: "next.config.mjs", content: "const { exec } = require('child_process')\nexport default {}\n" } }, claim("meta_improve:landing")] }] },
      checks: { gate },
      items: [ITEMS[0]!]
    })
    await step.run(t.ctx, t.deps)
    expect(readFileSync(join(t.root, "next.config.mjs"), "utf8")).not.toContain("child_process")
    const item = t.current().jobs.find((entry) => entry.id === "meta_improve:landing")!
    // Never "outside the job's files": the file was allowed; the safety check refused one line.
    expect(item.blockedReason).not.toBe("outside_allowlist")
    expect(item.note).toContain("turn_gate: problem")
    expect(item.note).toContain("child process")
    expect(item.checks.find((check) => check.id === "turn_gate")).toMatchObject({ tier: "S", state: "problem" })
    expect(t.checkCalls.build).toBe(0)
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
    // B8: the rejected edit is reverted BEFORE any check; the parent's bytes are kept aside and reported.
    expect(existsSync(join(t.root, "lib/stray.ts"))).toBe(false)
    expect(readFileSync(join(dir, "rejected", "lib/stray.ts"), "utf8")).toBe("export const stray = 1\n")
    expect(t.recorded.events.some((event) => /edit\(s\) undone: .*lib\/stray\.ts/.test(String(event.fields.text ?? "")))).toBe(true)
    expect(readFileSync(join(t.root, "app/layout.tsx"), "utf8")).toBe(POST_INSTALL_LAYOUT)
    expect(stateOf(t.current().jobs, "meta_improve:landing")).not.toMatch(/^blocked|failed/)
    expect(stateOf(t.current().jobs, "conversions_to_tools:trial")).toBe("waiting_real_event")
    expect(t.current().snapshot).toBeNull()
    expect(t.recordedEdits.flat().map((edit) => edit.file)).toEqual(["app/page.tsx"])
  })
})

