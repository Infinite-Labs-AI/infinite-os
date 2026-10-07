// Run 4 timeout/accounting contracts through the real jobs step and fence. Archived inline consent
// is owner-only; ordinary job behavior uses a named minimal entry with a separate owner bootstrap.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner, runs } from "../../../test/wizard/agents.js"
import { baseState, fakeBridge, fakeChecks, fakeInstaller, fakeRegistry, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import { cleanup, runGit, tempDir, write } from "../../../test/wizard/repo.js"
import type { AgentRunnerImpl } from "../../agents/runner.js"
import { AGENT_LIMITS } from "../contracts/agents.js"
import type { CheckFn, ChecklistItem } from "../contracts/jobs.js"
import { approvedFixClauses, missingApprovedFixes } from "../verdict.js"
import { itemChecksFor } from "../../jobs/registry.js"
import { o9CheckFunctions } from "../../checks/o9.js"
import { jobStaticCheckFunctions } from "../../checks/job-static.js"
import { FIXED_NOW } from "../../../test/wizard/fixture-fetch.js"
import { notDoneLines, step } from "./jobs.js"
import { consentSeparatedEntry, OWNER_BOOTSTRAP, OWNER_BOOTSTRAP_PATH } from "../../../test/wizard/consent-separated-entry.js"

const FREE_ENTRY = consentSeparatedEntry("G-QWERT67890", true)

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

const JOB6 = "duplicates_remove:ga4_config:G-QWERT67890"
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

/** A pending item of another job, shaped like `like` (same files), that no round of the agent touches. */
function untouched(like: string, id: string, title: string, checks: ChecklistItem["checks"]): ChecklistItem {
  const [base] = run4Items([like])
  return { ...base!, id, jobId: id.split(":")[0] as ChecklistItem["jobId"], title, checks }
}

const claim = (jobId: string, files: string[]) => ({ tool: "job_claim", args: { job_id: jobId, status: "done", note: "done", files } })

/**
 * The world: the real runner and fence; the step's clock jumps to 1.5 s before the jobs budget ends while round 1's
 * checks run, so round 2 (a hanging agent) is ended by the real wall clock, exactly like run 4's 10-minute budget.
 */
function world(input: {
  round1Claims: string[]
  /** "absent" = what the real T0 says of a page with no capture at all (`no_fbc_capture`, the change missing). */
  fbcCapture: Array<"pass" | "problem" | "absent">
  extraItems?: ChecklistItem[]
  results?: Record<string, Array<"pass" | "problem">>
  /** Round 1's edit in the selected world (the free entry by default). */
  layout?: string
  /** LF4 close round 2: more checks that run as the REAL functions over the tree (O9 and the job-table S checks). */
  real?: string[]
  entry?: "consent-separated" | "archived"
}) {
  const root = tempDir("infinite-tag-run4-")
  runGit(root, ["init", "-q", "-b", "main"])
  write(root, ".gitignore", "node_modules/\n.env*\n.next/\n")
  const archived = input.entry === "archived"
  write(root, "app/layout.tsx", archived ? run4("site-b7c8347/app/layout.tsx") : FREE_ENTRY.base)
  if (!archived) write(root, OWNER_BOOTSTRAP_PATH, OWNER_BOOTSTRAP)
  write(root, "app/signup/page.tsx", run4("site-b7c8347/app/signup/page.tsx"))
  runGit(root, ["add", "-A"])
  runGit(root, ["commit", "-q", "-m", "b7c8347"])
  write(root, "app/layout.tsx", archived ? installedLayout() : FREE_ENTRY.installed)
  const merged = input.layout ?? (archived ? run4("merged-5e6f3f3/app/layout.tsx") : FREE_ENTRY.edited)
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
  const fbcStates = input.fbcCapture.map((state) => (state === "absent" ? "problem" : state))
  const { checks, calls } = fakeChecks({ results: { ...input.results, fbc_capture: fbcStates } })
  let fbcCalls = 0
  let t = Date.parse("2026-10-03T20:45:02.000Z")
  const started = t
  const clock = { now: () => new Date((t += 1)), sleep: async () => undefined }
  // Round 1's checks end 1.5 s before the jobs budget does (the live run's round 2 had 2.4 minutes).
  const nearTheEnd = () => (t = Math.max(t, started + AGENT_LIMITS.jobs.wallMs - 1_500))
  const run = checks.run.bind(checks)
  const t0 = checks.t0.bind(checks)
  // The autoConfig job's own check is the REAL O9 function over the tree (it reads only the job's files); a test may
  // name more real checks (`input.real`).
  const o9 = o9CheckFunctions({ version: "t", root })
  const jobStatic = jobStaticCheckFunctions({ root, run: () => ({ conversionNames: ["signup", "download"] }) })
  const realFns: Record<string, CheckFn> = { ...(o9 as Record<string, CheckFn>), ...(jobStatic as Record<string, CheckFn>) }
  const realIds = new Set(["meta_autoconfig_off", ...(input.real ?? [])])
  ;(checks as { run: typeof checks.run }).run = async (...args) => {
    nearTheEnd()
    const [checkId, checkInput] = args as [string, Parameters<CheckFn>[0]]
    if (!realIds.has(checkId)) return run(...args)
    calls.run.push({ checkId, input: checkInput })
    const [result] = (await realFns[checkId]!(checkInput, { runId: STEP_RUN_ID, now: FIXED_NOW })) as Awaited<ReturnType<typeof run>>[]
    return result!
  }
  ;(checks as { t0: typeof checks.t0 }).t0 = async (...args) => {
    nearTheEnd()
    const results = await t0(...args)
    return results.map((result) => {
      if (result.checkId !== "fbc_capture") return result
      const scripted = input.fbcCapture[Math.min(fbcCalls++, input.fbcCapture.length - 1)]
      return scripted === "absent" ? { ...result, reason: "no_fbc_capture — a landing with an fbclid wrote no _fbc cookie", absent: true as const } : result
    })
  }
  let runner: AgentRunnerImpl | null = null
  const { bridge } = fakeBridge({ agents: () => runner })
  runner = makeRunner(fakes, root, { connectionIds: () => [] })
  const { registry } = fakeRegistry()
  const { installer, recorded } = fakeInstaller()
  const state = baseState({
    root,
    runId: STEP_RUN_ID,
    agent: { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: [...run4Items([JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE]), ...(input.extraItems ?? [])]
  })
  const { ctx, recorded: events, state: current } = makeCtx({ root, state })
  const deps = { ...makeDeps({ root, bridge, agents: runner, checks, registry, installer, env: { HOME: fakes.home } }), clock }
  return { root, ctx, deps, current, calls, recorded, events, merged, fakes }
}

describe("consent-separated entry: the budget ends with kept edits in the tree", () => {
  it("job 5 (its capture shipped) is never 'undone': failed with the wizard's real reason, and its change is said to stay in the pull request", async () => {
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["problem"] })
    const outcome = await step.run(w.ctx, w.deps)
    const jobs = w.current().jobs
    const stateOf = (id: string) => jobs.find((item) => item.id === id)!

    // The tree the pull request commits holds job 5's capture (it shares app/layout.tsx's lines with kept jobs).
    const layout = readFileSync(join(w.root, "app/layout.tsx"), "utf8")
    expect(layout).toBe(w.merged)
    expect(readFileSync(join(w.root, OWNER_BOOTSTRAP_PATH), "utf8")).toBe(OWNER_BOOTSTRAP)
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
      "The agent ran out of time · 4 of 5 jobs done in code (checked by the wizard, not the agent) · 1 did not pass the wizard's checks"
    )
    // "Not done" names the job with its real reason and where its change is.
    expect(notDoneLines(jobs).join("\n")).toContain("! Not done: Improve the existing Meta pixel (The agent ran out of time before fixing it")
    // The merge card / headline clause: in the code, but it did not pass (never "not in the code").
    expect(approvedFixClauses(missingApprovedFixes(jobs))).toEqual([
      "1 approved fix is in the code but did not pass the wizard's checks (Improve the existing Meta pixel)"
    ])
  })

  it("LF4-P1-2 round 1 (the verifier's repro): job 5 never claimed its capture, which IS in the committed tree, so its own fbc_capture check runs on that tree: pass → done in code, claim-less, never 'not in the code'", async () => {
    // Round 1 claims only four; job 5's capture is in the tree, and the fence credited those hunks to the jobs that
    // claimed app/layout.tsx. Attribution says who claimed, never what the code does: job 5's OWN check decides.
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP], fbcCapture: ["pass"] })
    const outcome = await step.run(w.ctx, w.deps)
    const layout = readFileSync(join(w.root, "app/layout.tsx"), "utf8")
    expect(layout).toBe(w.merged)
    expect(layout).toContain('<Script id="meta-fbc-capture"')
    const jobs = w.current().jobs
    const capture = jobs.find((item) => item.id === CAPTURE)!
    expect(DONE).toContain(capture.state)
    expect(capture.claim).toBeUndefined()
    expect(w.calls.t0.flat().map((scenario) => scenario.checkId)).toContain("fbc_capture")
    expect((outcome as { message: string }).message).toBe("The agent ran out of time · 5 of 5 jobs done in code (checked by the wizard, not the agent)")
    // NEGATIVE: never run 4's false words on any surface.
    expect(approvedFixClauses(missingApprovedFixes(jobs))).toEqual([])
    expect(notDoneLines(jobs)).toEqual([])
    expect(JSON.stringify([outcome, jobs])).not.toContain("before finishing this job")
  })

  it("LF4-P1-2 round 1: an autoConfig job nobody claimed is decided by its own REAL check on the tree: the free entry turns autoConfig off before init → done; without the opt-out → blocked, not in the code", async () => {
    const autoconfig = () =>
      untouched(CAPTURE, "meta_improve:autoconfig_off_adopted", "Turn off autoConfig on the adopted pixel", itemChecksFor("meta_improve", "autoconfig_off_adopted", "next-app-router"))
    const optOut = "fbq('set', 'autoConfig', false, '7777000011112222');\n"
    expect(FREE_ENTRY.edited).toContain(optOut)

    const done = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["pass"], extraItems: [autoconfig()] })
    await step.run(done.ctx, done.deps)
    const ticked = done.current().jobs.find((item) => item.id === "meta_improve:autoconfig_off_adopted")!
    expect(done.calls.run.map((call) => call.checkId)).toContain("meta_autoconfig_off")
    expect(DONE).toContain(ticked.state)
    expect(ticked.claim).toBeUndefined()
    expect(ticked.checks.find((check) => check.id === "meta_autoconfig_off")).toMatchObject({ state: "pass" })

    // NEGATIVE: the same world with the opt-out gone from the tree. The real check finds the problem; nothing of the job
    // is in the code, so the verdict says so (never "done", never "in the code").
    const without = world({
      round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE],
      fbcCapture: ["pass"],
      extraItems: [autoconfig()],
      layout: FREE_ENTRY.edited.replace(optOut, "")
    })
    await step.run(without.ctx, without.deps)
    const job = without.current().jobs.find((item) => item.id === "meta_improve:autoconfig_off_adopted")!
    expect(job.state).toBe("blocked")
    expect(job.note).toContain("meta_autoconfig_off")
    expect(job.note).toContain("The agent ran out of time before finishing this job")
    expect(job.edits ?? []).toEqual([])
    expect(approvedFixClauses(missingApprovedFixes(without.current().jobs))).toEqual(["1 approved fix is not in the code (Turn off autoConfig on the adopted pixel)"])
  })

  it("LF4-P1-2 negative: an untouched GA4 page-change job is never 'in the code'", async () => {
    const spa = untouched(JOB6, "ga4_improve:spa_page_view", "Send a GA4 page_view on every page change", [
      { id: "ga4_spa_page_view", tier: "RH", state: "not_run" },
      { id: "ga4_one_page_view", tier: "RH", state: "not_run" },
      { id: "ga4_seen_leaving", tier: "PV", state: "not_run" }
    ])
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["pass"], extraItems: [spa] })
    await step.run(w.ctx, w.deps)
    const job = w.current().jobs.find((item) => item.id === spa.id)!
    expect(job.state).toBe("blocked")
    expect(job.note).toContain("before finishing this job")
    // Never "in the code but the wizard could not check it" / "did not pass": nothing of it is in the code.
    expect(approvedFixClauses(missingApprovedFixes(w.current().jobs))).toEqual(["1 approved fix is not in the code (Send a GA4 page_view on every page change)"])
  })

  it("LF4-P1-2 round 1 negative: an unclaimed job with nothing of it in the tree, whose own check FAILS there, is blocked with what that check found and listed as not in the code (other jobs' lines in its file never tick it)", async () => {
    // Round 1 keeps the other jobs' layout edits but no capture at all; job 5's own check finds the problem.
    const merged = FREE_ENTRY.edited
    const from = merged.indexOf('        <Script id="meta-fbc-capture"')
    const to = merged.indexOf("        </Script>\n", from) + "        </Script>\n".length
    // The real T0 on a page with no capture says `no_fbc_capture` (the change missing): "absent".
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP], fbcCapture: ["absent"], layout: merged.slice(0, from) + merged.slice(to) })
    const outcome = await step.run(w.ctx, w.deps)
    expect(readFileSync(join(w.root, "app/layout.tsx"), "utf8")).not.toContain("meta-fbc-capture")
    const jobs = w.current().jobs
    const capture = jobs.find((item) => item.id === CAPTURE)!
    expect(capture.state).toBe("blocked")
    expect(capture.note).toContain("The agent ran out of time before finishing this job")
    expect(capture.note).toContain("the wizard's check of the code found fbc_capture")
    expect(capture.note).not.toContain("before fixing it")
    expect(capture.claim).toBeUndefined()
    expect(approvedFixClauses(missingApprovedFixes(jobs))).toEqual(["1 approved fix is not in the code (Improve the existing Meta pixel)"])
    expect((outcome as { message: string }).message).toBe(
      "The agent ran out of time · 4 of 5 jobs done in code (checked by the wizard, not the agent) · 1 blocked"
    )
  })

  it("LF4-P1-2: no claim is made up — an unclaimed job whose OWN change is in the tree is decided by its own local checks only, and stays claim-less", async () => {
    // Round 1 claims only the signup page; nobody claims app/layout.tsx, so the fence credits each layout hunk to every
    // job covering that file. Each such job is checked on the tree as it stands, with no agent claim recorded on it.
    const w = world({ round1Claims: [SIGNUP], fbcCapture: ["pass"] })
    await step.run(w.ctx, w.deps)
    const jobs = w.current().jobs
    for (const id of [JOB6, GA4_GUARD, META_GUARD, CAPTURE]) {
      const job = jobs.find((item) => item.id === id)!
      expect(DONE, id).toContain(job.state)
      expect(job.claim, id).toBeUndefined()
    }
    expect(JSON.stringify(jobs)).not.toContain("the wizard checked the change it had left")
  })

  it("LF4-P1-2 negative: an unclaimed job with its own kept change but no check the wizard can run before the deploy is never 'done' (no made-up claim, no recorded diff standing in for a check)", async () => {
    const spa = untouched(JOB6, "ga4_improve:spa_page_view", "Send a GA4 page_view on every page change", itemChecksFor("ga4_improve", "spa_page_view", "next-app-router"))
    const w = world({ round1Claims: [SIGNUP], fbcCapture: ["pass"], extraItems: [spa] })
    await step.run(w.ctx, w.deps)
    const job = w.current().jobs.find((item) => item.id === spa.id)!
    expect(DONE).not.toContain(job.state)
    expect(job.state).toBe("blocked")
    expect(job.claim).toBeUndefined()
  })

  it("LF4-P1-2 negative: an unclaimed job whose own local check FAILS on the tree is failed with that check, never ticked", async () => {
    const w = world({ round1Claims: [SIGNUP], fbcCapture: ["problem"] })
    await step.run(w.ctx, w.deps)
    const capture = w.current().jobs.find((item) => item.id === CAPTURE)!
    expect(capture.state).toBe("failed")
    expect(capture.note).toContain("fbc_capture")
    expect(capture.claim).toBeUndefined()
  })
})

// LF4 close round 2: the verifier's repro (zz-cr1-jobs), asserted. At 709c10b `checkOpenOnTree` reported a job "done in
// code" when the PR held nothing of it: (a) a job whose only local check passes on absence (a click conversion on Next,
// the mirror) was ticked untouched; (b) a claim-less pass was decided BEFORE `settleEdits` put the layout back to the
// install's version (its hunks were credited only to a failing claimed job). And (P2-2) a never-claimed job whose own
// check failed on code that IS in the tree was called "not in the code".
describe("consent-separated entry: a job is done in code only when the committed tree holds its change", () => {
  it("(a) an untouched click conversion on Next (download) is never done: its only local check passes on absence; its own proof finds the call missing", async () => {
    const download = untouched(SIGNUP, "conversions_to_tools:download", "Send the download conversion to GA4 and PostHog", itemChecksFor("conversions_to_tools", "download", "next-app-router"))
    expect(download.checks.map((check) => `${check.tier}:${check.id}`)).toContain("S:conversion_tracked")
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["pass"], extraItems: [download], real: ["no_fbq_standard_on_click", "conversion_tracked"] })
    const outcome = await step.run(w.ctx, w.deps)
    const job = w.current().jobs.find((item) => item.id === download.id)!
    expect(readFileSync(join(w.root, "app/signup/page.tsx"), "utf8") + readFileSync(join(w.root, "app/layout.tsx"), "utf8")).not.toMatch(/download/i)
    expect(DONE).not.toContain(job.state)
    expect(job.state).toBe("blocked")
    expect(job.checks.find((check) => check.id === "conversion_tracked")).toMatchObject({ state: "problem" })
    expect((outcome as { message: string }).message).toBe("The agent ran out of time · 5 of 6 jobs done in code (checked by the wizard, not the agent) · 1 blocked")
    expect(approvedFixClauses(missingApprovedFixes(w.current().jobs))).toEqual(["1 approved fix is not in the code (Send the download conversion to GA4 and PostHog)"])
  })

  it("(a) an untouched mirror job is never done: the event-id check passes on a page with no Meta event; meta_mirror_wired finds no infiniteMetaMirror", async () => {
    const mirror = untouched(CAPTURE, "meta_improve:mirror", "Send Meta conversions through the server-instructed mirror", itemChecksFor("meta_improve", "mirror", "next-app-router"))
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["pass"], extraItems: [mirror], real: ["meta_event_id_from_helper", "meta_mirror_wired"] })
    await step.run(w.ctx, w.deps)
    const job = w.current().jobs.find((item) => item.id === mirror.id)!
    expect(readFileSync(join(w.root, "app/layout.tsx"), "utf8")).not.toContain("infiniteMetaMirror")
    expect(job.checks.find((check) => check.id === "meta_event_id_from_helper")).toMatchObject({ state: "pass" })
    expect(DONE).not.toContain(job.state)
    expect(job.state).toBe("blocked")
    expect(approvedFixClauses(missingApprovedFixes(w.current().jobs))).toContain("1 approved fix is not in the code (Send Meta conversions through the server-instructed mirror)")
  })

  it("(b) unclaimed jobs that pass on the tree keep the hunks they were checked on: the PR commits that tree, and the failing claimed capture says its change stays", async () => {
    const w = world({ round1Claims: [SIGNUP, CAPTURE], fbcCapture: ["problem"] })
    await step.run(w.ctx, w.deps)
    const layout = readFileSync(join(w.root, "app/layout.tsx"), "utf8")
    // At 709c10b: the layout went back to the installed version while the three jobs below were reported done.
    expect(layout).toBe(w.merged)
    const jobs = w.current().jobs
    for (const id of [JOB6, GA4_GUARD, META_GUARD]) {
      const job = jobs.find((item) => item.id === id)!
      expect(DONE, id).toContain(job.state)
      expect(job.claim, id).toBeUndefined()
      expect((job.edits ?? []).map((edit) => edit.file), id).toContain("app/layout.tsx")
    }
    const capture = jobs.find((item) => item.id === CAPTURE)!
    expect(capture.state).toBe("failed")
    // Final round (P3): its lines stay only because claim-less jobs were checked on the whole layout, not because a
    // passing job's own change shares them, and the note says which.
    expect(capture.note).toContain("Its change stays in the pull request (a job that passed was checked on the whole of app/layout.tsx, claiming no lines of its own)")
    expect(capture.note).not.toContain("shares lines")
    expect(approvedFixClauses(missingApprovedFixes(jobs))).toEqual(["1 approved fix is in the code but did not pass the wizard's checks (Improve the existing Meta pixel)"])
  })

  it("(b) the autoConfig job decided claim-less is done only on the tree the PR commits: the real O9 check passes again on the committed layout", async () => {
    const autoconfig = untouched(CAPTURE, "meta_improve:autoconfig_off_adopted", "Turn off autoConfig on the adopted pixel", itemChecksFor("meta_improve", "autoconfig_off_adopted", "next-app-router"))
    const w = world({ round1Claims: [SIGNUP, CAPTURE], fbcCapture: ["problem"], extraItems: [autoconfig] })
    await step.run(w.ctx, w.deps)
    const job = w.current().jobs.find((item) => item.id === autoconfig.id)!
    expect(DONE).toContain(job.state)
    const input = w.calls.run.find((call) => call.checkId === "meta_autoconfig_off")!.input as Parameters<CheckFn>[0]
    const again = (await o9CheckFunctions({ version: "t", root: w.root }).meta_autoconfig_off!(input, { runId: STEP_RUN_ID, now: FIXED_NOW })) as Array<{ state: string }>
    expect(again.map((result) => result.state)).toEqual(["pass"])
    expect(readFileSync(join(w.root, "app/layout.tsx"), "utf8")).toContain("fbq('set', 'autoConfig', false")
  })

  it("(P2-2) a never-claimed capture whose change IS in the tree and whose own check fails 'did not pass the wizard's checks on the code', never 'not in the code'", async () => {
    const w = world({ round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP], fbcCapture: ["problem"] })
    const outcome = await step.run(w.ctx, w.deps)
    expect(readFileSync(join(w.root, "app/layout.tsx"), "utf8")).toContain("meta-fbc-capture")
    const jobs = w.current().jobs
    const capture = jobs.find((item) => item.id === CAPTURE)!
    expect(capture.state).toBe("failed")
    expect(capture.claim).toBeUndefined()
    expect(capture.note).toContain("The agent never claimed it; it did not pass the wizard's checks on the code: fbc_capture")
    const clauses = approvedFixClauses(missingApprovedFixes(jobs))
    expect(clauses).toEqual(["1 approved fix did not pass the wizard's checks on the code (never claimed: Improve the existing Meta pixel)"])
    expect(clauses.join(" ")).not.toContain("not in the code")
    expect((outcome as { message: string }).message).toBe("The agent ran out of time · 4 of 5 jobs done in code (checked by the wizard, not the agent) · 1 did not pass the wizard's checks")
  })
})

describe("structured activity reports job progress and measured budget use", () => {
  it("a thinking activity updates measured status while narration stays verbatim", async () => {
    const root = tempDir("infinite-tag-run4-progress-")
    runGit(root, ["init", "-q", "-b", "main"])
    write(root, "app/layout.tsx", FREE_ENTRY.base)
    write(root, OWNER_BOOTSTRAP_PATH, OWNER_BOOTSTRAP)
    runGit(root, ["add", "-A"])
    runGit(root, ["commit", "-q", "-m", "base"])
    dirs.push(root)
    const runner = {
      isAgentAlive: () => false,
      killAll: async () => undefined,
      detect: async () => ({ worker: null, reviewer: null, available: [] }),
      review: async () => ({ error: "unparseable" as const }),
      runJobs: async (input: Parameters<AgentRunnerImpl["runJobs"]>[0]) => {
        await input.onClaim({ jobId: CAPTURE, status: "done", note: "", at: "2026-10-03T20:52:22.000Z" })
        input.onActivity?.({ kind: "thinking", seconds: 254 })
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
    await step.run(ctx, makeDeps({ root, bridge, agents: runner as never, env: { HOME: root } }))
    const beats = recorded.events.filter((event) => event.type === "narrate").map((event) => (event.fields as { text: string }).text)
    const status = recorded.events.filter(event => event.type === "step.status").map(event => String(event.fields.text))
    expect(status).toContainEqual(expect.stringContaining("1 of 5 claimed"))
    expect(status).toContainEqual(expect.stringContaining("thinking 254 s"))
    expect(status).toContainEqual(expect.stringContaining(`0 of ${AGENT_LIMITS.jobs.wallMs / 60_000} min`))
    expect(beats).toContain("Thinking · 254 s")
    expect(beats).toContain("Editing app/layout.tsx")
  })
})


it("the archived inline-consent entry stays byte-identical while the independent signup edit runs", async () => {
  const w = world({ entry: "archived", round1Claims: [JOB6, GA4_GUARD, META_GUARD, SIGNUP, CAPTURE], fbcCapture: ["pass"] })
  const before = readFileSync(join(w.root, "app/layout.tsx"), "utf8")
  expect(before).toBe(installedLayout())
  expect(before).toContain("gtag('consent', 'default'")
  await step.run(w.ctx, w.deps)
  expect(readFileSync(join(w.root, "app/layout.tsx"), "utf8")).toBe(before)
  for (const id of [JOB6, GA4_GUARD, META_GUARD, CAPTURE]) {
    const job = w.current().jobs.find(item => item.id === id)!
    expect(job).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "frozen_unit", file: "app/layout.tsx" } })
    expect(job.note).toContain("Not changed by us:")
    expect(job.ownerBoundary?.unitHash).toMatch(/^[a-f0-9]+$/)
    expect(job.claim).toBeUndefined()
    expect(job.edits ?? []).toEqual([])
  }
  expect(DONE).toContain(w.current().jobs.find(item => item.id === SIGNUP)?.state)
  expect(readFileSync(join(w.root, "app/signup/page.tsx"), "utf8")).toBe(run4("merged-5e6f3f3/app/signup/page.tsx"))
  expect(runs(w.fakes)).toHaveLength(1)
  expect(w.calls.t0.flat().map(scenario => scenario.checkId)).not.toContain("fbc_capture")
})
