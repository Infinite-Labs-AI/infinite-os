// Run 3 job contracts through the real runner, fence and post-turn gate. The historical inline-consent
// entry is owner-only. Independent attribution/retry coverage uses an explicit consent-separated entry.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner, runs } from "../../../test/wizard/agents.js"
import { baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import { cleanup, runGit, tempDir, write } from "../../../test/wizard/repo.js"
import { RUN3_DIR, run3EditedLayout, run3File, run3Json } from "../../../test/wizard/run3-fixture.js"
import type { AgentRunnerImpl } from "../../agents/runner.js"
import { turnGate } from "../../checks/turn-gate.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import { notDoneLines, step } from "./jobs.js"
import { consentSeparatedEntry, OWNER_BOOTSTRAP, OWNER_BOOTSTRAP_PATH } from "../../../test/wizard/consent-separated-entry.js"

const rawFreeEntry = consentSeparatedEntry("G-TEST0000000")
const signupLink = '        <a href="/signup">Start free trial</a>\n'
const FREE_ENTRY = {
  base: rawFreeEntry.base.replace("      <body>\n", `      <body>\n${signupLink}`),
  installed: rawFreeEntry.installed.replace("      <body>\n", `      <body>\n${signupLink}`),
  edited: rawFreeEntry.edited.replace("      <body>\n", `      <body>\n${signupLink}`)
}

vi.setConfig({ testTimeout: 60_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const SITE_FILES = [
  "README.md",
  "app/account/logout-button.tsx",
  "app/account/page.tsx",
  "app/api/auth/login/route.ts",
  "app/api/auth/logout/route.ts",
  "app/api/signup/route.ts",
  "app/globals.css",
  "app/layout.tsx",
  "app/login/page.tsx",
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/signup/page.tsx",
  "lib/users.ts",
  "package.json",
  "tsconfig.json"
]
const INSTALL_FILES = ["app/layout.tsx", "lib/infinite-analytics-client.tsx", "lib/infinite-analytics.ts", "next.config.mjs"]

/** Archive replay or an explicit free-entry variant; install files remain uncommitted as the jobs step expects. */
function run3Repo(entry: "consent-separated" | "archived"): string {
  const root = tempDir("infinite-tag-run3-")
  runGit(root, ["init", "-q", "-b", "main"])
  write(root, ".gitignore", "node_modules/\n.env*\n.next/\n")
  for (const rel of SITE_FILES) write(root, rel, run3File(`site-6d16d8f/${rel}`))
  if (entry === "consent-separated") {
    write(root, "app/layout.tsx", FREE_ENTRY.base)
    write(root, OWNER_BOOTSTRAP_PATH, OWNER_BOOTSTRAP)
  }
  runGit(root, ["add", "-A"])
  runGit(root, ["commit", "-q", "-m", "6d16d8f"])
  for (const rel of INSTALL_FILES) write(root, rel, run3File(`install-f1abea9/${rel}`))
  if (entry === "consent-separated") write(root, "app/layout.tsx", FREE_ENTRY.installed)
  return root
}

/** Run 3's agent items as `plan` left them (pending, nothing checked yet). */
function run3Items(ids: readonly string[]): ChecklistItem[] {
  const state = run3Json<{ jobs: ChecklistItem[] }>("wizard/state.json")
  return ids.map((id) => {
    const item = structuredClone(state.jobs.find((entry) => entry.id === id)!)
    delete item.blockedReason
    delete item.claim
    delete item.edits
    item.state = "pending"
    item.checks = item.checks.map((check) => ({ id: check.id, tier: check.tier, state: "not_run" }))
    // Archived evidence is retained; setup supplies the corresponding locations for the synthetic free entry.
    return item
  })
}

const JOB6 = "duplicates_remove:ga4_config:G-TEST0000000"
const GA4_GUARD = "preview_guard:ga4"
const META_GUARD = "preview_guard:meta"
const SIGNUP = "conversions_to_tools:signup"
const claim = (jobId: string, status = "done", note = "done") => ({ tool: "job_claim", args: { job_id: jobId, status, note, files: ["app/layout.tsx"] } })

function setup(scenario: unknown, items: ChecklistItem[], entry: "consent-separated" | "archived" = "consent-separated") {
  const root = run3Repo(entry)
  if (entry === "consent-separated") for (const item of items) for (const evidence of item.trigger.evidence) {
    if ("file" in evidence && evidence.file === "app/layout.tsx") {
      const needle = item.id === META_GUARD ? "fbq('init'" : item.id === SIGNUP ? 'href="/signup"' : "gtag('config'"
      evidence.line = FREE_ENTRY.base.split("\n").findIndex(line => line.includes(needle)) + 1
    }
  }
  const fakes = fakeAgents(scenario)
  dirs.push(root, fakes.home)
  const { checks, calls } = fakeChecks()
  let runner: AgentRunnerImpl | null = null
  const { bridge } = fakeBridge({ agents: () => runner })
  // The REAL gate, as O9 registers it (connection ids from run 3's keys: none; a fresh workspace).
  runner = makeRunner(fakes, root, {
    connectionIds: () => [],
    checks: {
      turnGate: async (diff, gateCtx) =>
        turnGate(diff, { connectionIds: gateCtx.connectionIds, readFile: (path) => readFileSync(join(root, path), "utf8") }, { runId: STEP_RUN_ID, now: () => new Date("2026-10-03T14:47:00.000Z") })
    }
  })
  const { registry } = fakeRegistry()
  const { installer, recorded } = fakeInstaller()
  const state = baseState({
    root,
    runId: STEP_RUN_ID,
    agent: { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: items
  })
  const { ctx, recorded: events, state: current } = makeCtx({ root, state })
  const deps = makeDeps({ root, bridge, agents: runner, checks, registry, installer, env: { HOME: fakes.home } })
  return { root, fakes, ctx, deps, current, calls, recorded, events }
}

const DONE = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven"]

describe("consent-separated entry: approved ordinary edits keep the site's own ids", () => {
  it("jobs 6, 7 GA4 and 7 Meta are done in code; the edit is kept; no 'outside the job's files' line", async () => {
    const edited = FREE_ENTRY.edited
    const t = setup(
      {
        turns: [
          {
            steps: [
              { edit: { path: "app/layout.tsx", content: edited } },
              claim(JOB6),
              claim(GA4_GUARD),
              claim(META_GUARD),
              { tool: "job_claim", args: { job_id: SIGNUP, status: "blocked", note: "the helpers are not in the repo" } }
            ]
          }
        ]
      },
      run3Items([JOB6, GA4_GUARD, META_GUARD, SIGNUP])
    )
    await step.run(t.ctx, t.deps)
    const jobs = t.current().jobs
    const stateOf = (id: string) => jobs.find((item) => item.id === id)!
    for (const id of [JOB6, GA4_GUARD, META_GUARD]) expect(DONE, id).toContain(stateOf(id).state)
    expect(stateOf(SIGNUP)).toMatchObject({ state: "left_for_you", blockedReason: "agent_blocked" })
    // The edit is in the tree and in the receipt.
    const layout = readFileSync(join(t.root, "app/layout.tsx"), "utf8")
    expect(layout).toBe(edited)
    expect(readFileSync(join(t.root, OWNER_BOOTSTRAP_PATH), "utf8")).toBe(OWNER_BOOTSTRAP)
    expect(layout.match(/gtag\('config'/g)).toHaveLength(1)
    expect(layout.match(/\.vercel\.app/g)).toHaveLength(2)
    expect(t.recorded.flat().map((edit) => edit.file)).toEqual(["app/layout.tsx"])
    // Nobody is told the file was outside the job's files.
    const lines = notDoneLines(jobs)
    expect(lines.join("\n")).not.toContain("outside the job's files")
    expect(lines).toEqual([`! Not done, left for you: Send conversions to every tool — the agent said it was blocked: the helpers are not in the repo`])
  })
})

describe("consent-separated entry: a refused line fails only the job it belongs to, with the real reason; the rest is kept", () => {
  // Round 1: the dedupe (job 6) and the GA4 guard (job 7) are right; the Meta guard adds a FALLBACK pixel id.
  const metaFallback = (layout: string) => layout.replace("fbq('init', '7777000011112222');", "fbq('init', window.PIXEL || '7777000011112222');")

  it("the Meta guard's fallback is refused: only that job is pending, with the note; round 2 fixes it", async () => {
    const good = FREE_ENTRY.edited
    const bad = metaFallback(good)
    expect(bad).not.toBe(good)
    const t = setup(
      {
        turns: [
          { steps: [{ edit: { path: "app/layout.tsx", content: bad } }, claim(JOB6), claim(GA4_GUARD), claim(META_GUARD)] },
          { steps: [{ edit: { path: "app/layout.tsx", content: good } }, claim(META_GUARD, "done", "removed the fallback")] }
        ]
      },
      run3Items([JOB6, GA4_GUARD, META_GUARD])
    )
    // Stop after round 1 to look at it: the brief of round 2 carries the gate's feedback line.
    await step.run(t.ctx, t.deps)
    const jobs = t.current().jobs
    const stateOf = (id: string) => jobs.find((item) => item.id === id)!
    for (const id of [JOB6, GA4_GUARD, META_GUARD]) expect(DONE, id).toContain(stateOf(id).state)
    // Round 1's refusal was recorded on the Meta job only, with the real words (kept as its note until it passed).
    const notes = t.events.events.filter((event) => event.type === "job.state" && event.fields.state === "pending").map((event) => [event.fields.itemId, event.fields.note])
    expect(notes).toEqual([[META_GUARD, expect.stringMatching(/^the wizard's safety check refused app\/layout\.tsx:\d+: the edit uses a provider id as a default or fallback value \(\|\|, \?\? or \?:\)$/)]])
    // The second turn's brief told the agent what was refused and that the rest was kept.
    const second = runs(t.fakes, "claude")[1]!
    const brief = second.argv![second.argv!.indexOf("--append-system-prompt") + 1]!
    expect(brief).toContain(`- ${META_GUARD}: the wizard's safety check refused app/layout.tsx:`)
    expect(brief).toContain("That hunk was undone; the rest of your change was kept. Fix only that line and claim again.")
    expect(readFileSync(join(t.root, "app/layout.tsx"), "utf8")).toBe(good)
  })

  // DEVIATION (recorded in the build note): DECISIONS W3 expects job 6 done in round 1 while a GA4 fallback at the
  // config line is refused. Run 3's job 6 and job 7 GA4 both carry that config line as trigger evidence and both claim
  // app/layout.tsx, so §3x.2's attribution honestly gives the hunk to both; the unambiguous world is the Meta case above.
  it("a refused GA4 fallback at the duplicated config line is attributed to BOTH jobs with evidence there (6 and 7 GA4); the Meta job is unaffected", async () => {
    const good = FREE_ENTRY.edited
    const bad = good.replace("gtag('js', new Date());", "gtag('js', new Date());\nvar ga4Id = window.GA_ID || 'G-TEST0000000';")
    const t = setup({ turns: [{ steps: [{ edit: { path: "app/layout.tsx", content: bad } }, claim(JOB6), claim(GA4_GUARD), claim(META_GUARD)] }] }, run3Items([JOB6, GA4_GUARD, META_GUARD]))
    await step.run(t.ctx, t.deps)
    const jobs = t.current().jobs
    const stateOf = (id: string) => jobs.find((item) => item.id === id)!
    expect(DONE).toContain(stateOf(META_GUARD).state)
    // Out of rounds (the fake agent has one turn): left for the owner with the gate's words, never "outside the job's files".
    for (const id of [JOB6, GA4_GUARD]) {
      expect(stateOf(id).state).toBe("left_for_you")
      expect(stateOf(id).note).toBe("the wizard could not verify it (turn_gate: problem — fallback_provider_id: the edit uses a provider id as a default or fallback value (||, ?? or ?:)). Its own edits were put back.")
    }
    // The refused line is gone; the two unverified jobs' kept hunks are undone per item;
    // the Meta job's guard, attributed to it alone, stays.
    const layout = readFileSync(join(t.root, "app/layout.tsx"), "utf8")
    expect(layout).not.toContain("window.GA_ID")
    expect(layout).toContain("ga4-again")
    expect(layout).toContain("if (location.hostname === 'shop.examplebrand.com'")
    expect(layout).not.toContain("window.fbq =")
  })
})

describe("consent-separated entry: one stray file no longer throws away the turn's correct work", () => {
  it("a helper file no job may create is undone ALONE; jobs 6 and 7 stay done and their edit is kept; the agent is told", async () => {
    const edited = FREE_ENTRY.edited
    // An ordinary edit plus a helper file the agent invented (claims name app/layout.tsx only).
    const t = setup(
      {
        turns: [
          {
            steps: [
              { edit: { path: "app/layout.tsx", content: edited } },
              { edit: { path: "lib/guard-helper.ts", content: "export const guard = true\n" } },
              claim(JOB6),
              claim(GA4_GUARD),
              claim(META_GUARD)
            ]
          }
        ]
      },
      run3Items([JOB6, GA4_GUARD, META_GUARD])
    )
    await step.run(t.ctx, t.deps)
    const jobs = t.current().jobs
    for (const id of [JOB6, GA4_GUARD, META_GUARD]) expect(DONE, id).toContain(jobs.find((item) => item.id === id)!.state)
    expect(readFileSync(join(t.root, "app/layout.tsx"), "utf8")).toBe(edited)
    expect(() => readFileSync(join(t.root, "lib/guard-helper.ts"), "utf8")).toThrow()
    const said = t.events.events.filter((event) => event.type === "step.sub").map((event) => String(event.fields.text))
    expect(said).toContain("! Undid the change to lib/guard-helper.ts: a new file no job may create. No job was failed for it.")
  })
})

it("the fixture is the real run (sanity: the dir and the edit exist)", () => {
  expect(RUN3_DIR).toMatch(/fixtures\/run3$/)
  expect(run3EditedLayout()).toContain("shop.examplebrand.com")
})


it("the archived inline-consent entry is left for its owner before any worker starts", async () => {
  const t = setup({ turns: [{ steps: [{ edit: { path: "app/layout.tsx", content: run3EditedLayout() } }, claim(JOB6), claim(GA4_GUARD), claim(META_GUARD)] }] }, run3Items([JOB6, GA4_GUARD, META_GUARD]), "archived")
  const before = readFileSync(join(t.root, "app/layout.tsx"), "utf8")
  expect(before).toBe(run3File("install-f1abea9/app/layout.tsx"))
  expect(before).toContain("gtag('consent', 'default'")
  expect(await step.run(t.ctx, t.deps)).toMatchObject({ kind: "ok" })
  expect(t.current().jobs).toHaveLength(3)
  for (const job of t.current().jobs) {
    expect(job).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "frozen_unit", file: "app/layout.tsx" } })
    expect(job.note).toContain("For you:")
    expect(job.ownerBoundary?.unitHash).toMatch(/^[a-f0-9]+$/)
    expect(job.claim).toBeUndefined()
    expect(job.edits ?? []).toEqual([])
  }
  expect(t.calls.run).toEqual([])
  expect(readFileSync(join(t.root, "app/layout.tsx"), "utf8")).toBe(before)
  expect(runs(t.fakes)).toHaveLength(0)
  expect(t.recorded).toEqual([])
})
