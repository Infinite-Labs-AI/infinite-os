// §3y.9 / IO-10 (P2-6): the "You merge" card notices a GitHub merge by itself. Polling (every 30 s) starts BEFORE the
// merge-ready ask; a merge seen while the card is up closes it through the ask's signal, with no keypress; ESC then
// a merge read once more is saved too. Fakes only (a fake clock, a fake adapter; no gh, no network).
import { describe, expect, it } from "vitest"

import { fakeBridge, initialState, RUN_ID, testContext, testDeps } from "../../../test/wizard/o4-fakes.js"
import type { AgentRunner } from "../contracts/agents.js"
import type { Clock } from "../contracts/deps.js"
import type { GitHostAdapter, GitOps, PrSummary } from "../contracts/git-host.js"
import { PR_LOOP_LIMITS } from "../contracts/git-host.js"
import { step } from "./merge.js"
import { run3Json } from "../../../test/wizard/run3-fixture.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import type { ReportV2 } from "../contracts/report.js"
import { buildColumn, createReportBuilder } from "../report.js"
import { mergeReadyOverlay } from "../../tui/overlays/merge-ready.js"

const MERGE = "f".repeat(40)

function pr(state: PrSummary["state"]): PrSummary {
  return {
    number: 2,
    url: "https://github.com/acme/site/pull/2",
    nodeId: "PR_x",
    isDraft: false,
    state,
    headRefOid: "b".repeat(40),
    headRefName: "infinite/tag/2026-10-03-f42a31",
    baseRefName: "main",
    mergeCommitOid: state === "MERGED" ? MERGE : null,
    mergedAt: state === "MERGED" ? "2026-10-03T05:47:00Z" : null,
    mergeStateStatus: "CLEAN",
    reviewDecision: ""
  } as PrSummary
}

/** A clock whose sleep advances time and yields (so the poller and the ask interleave like real time). */
function stepClock(): Clock & { slept: number[] } {
  let now = Date.parse("2026-10-03T05:40:00Z")
  const slept: number[] = []
  return {
    slept,
    now: () => new Date(now),
    sleep: async (ms, signal) => {
      slept.push(ms)
      if (signal?.aborted) return
      now += ms
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

function githubHost(states: Array<PrSummary["state"]>): GitHostAdapter & { reads: number } {
  const host = {
    kind: "github" as const,
    reads: 0,
    gh: { json: async (args: string[]) => args[1]?.includes("/check-runs") ? { check_runs: [] } : args[1]?.includes("/status?") ? { statuses: [] } : [] },
    auth: async () => ({ ok: true, login: "acme-dev" }),
    readThreadDetails: async () => [],
    readPr: async () => {
      const state = states[Math.min(host.reads, states.length - 1)]!
      host.reads += 1
      return pr(state)
    },
    rules: async () => ({ requiresReview: false, mergeQueue: false })
  }
  return host as unknown as GitHostAdapter & { reads: number }
}

function setup(states: Array<PrSummary["state"]>, answer: (signal: AbortSignal | undefined) => Promise<unknown>) {
  const clock = stepClock()
  const state = initialState({ runId: RUN_ID })
  state.git = { base: "main", baseSource: "default_branch", branch: "infinite/tag/2026-10-03-f42a31", baseSha: "a".repeat(40), headSha: "b".repeat(40) }
  state.pr = { host: "github", number: 2, url: "https://github.com/acme/site/pull/2", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: null }
  const ctx = testContext({ root: "/repo", state, clock, options: { json: false } })
  ctx.ask = (async (kind: string, _payload: unknown, options?: { signal?: AbortSignal }) => {
    ctx.asks.push({ kind: kind as never, payload: _payload })
    return answer(options?.signal)
  }) as typeof ctx.ask
  const bridge = fakeBridge()
  const host = githubHost(states)
  const git = { diff: async () => "" } as unknown as GitOps
  const deps = testDeps({ bridge, agents: { isAgentAlive: () => false } as unknown as AgentRunner, git, host, clock })
  return { ctx, deps, host, bridge, clock }
}

/** The user never presses a key: the card stays up until its signal closes it. */
const neverAnswer = (signal: AbortSignal | undefined) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve("__cancelled__")
    signal?.addEventListener("abort", () => resolve("__cancelled__"), { once: true })
  })

describe("the merge card polls GitHub while it is up (§3y.9)", () => {
  it("the PR flips to MERGED with no keypress → the card closes itself and the step ends ok within one poll", async () => {
    const { ctx, deps, host, bridge, clock } = setup(["OPEN", "MERGED"], neverAnswer)
    const outcome = await step.run(ctx, deps)
    expect(outcome).toMatchObject({ kind: "ok", status: "Merged · Vercel is deploying" })
    expect(ctx.state.get().pr?.mergeSha).toBe(MERGE)
    // The first readPr is the step's own check before the card; the poller's FIRST poll (30 s later) saw the merge.
    expect(host.reads).toBe(2)
    expect(clock.slept[0]).toBe(PR_LOOP_LIMITS.mergePollMs)
    expect(bridge.calls.find((call) => call.verb === "runs.patch")?.body).toMatchObject({ patch: { mergeSha: MERGE, phase: "merged" } })
    expect(ctx.events.some((event) => (event.fields as { text?: string }).text === "✓ Merged on GitHub")).toBe(true)
  })

  it("ESC while it is not merged, but merged by the time of the final read → saved, never parked", async () => {
    const { ctx, deps } = setup(["OPEN", "MERGED"], async () => "__cancelled__")
    const outcome = await step.run(ctx, deps)
    expect(outcome).toMatchObject({ kind: "ok" })
    expect(ctx.state.get().pr?.mergeSha).toBe(MERGE)
  })

  it("NEGATIVE: ESC and still open → parked MERGE_PARKED (exit 3), nothing saved", async () => {
    const { ctx, deps } = setup(["OPEN"], async () => "later")
    const outcome = await step.run(ctx, deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_MERGE_PARKED" })
    expect(ctx.state.get().pr?.mergeSha).toBeNull()
  })
})

describe("§3x.6 (W22) run 3 at merge-ready: the card says incomplete, and the in-PR report reaches Infinite first", () => {
  it("5 approved fixes not in the code → 'Ready to merge, but incomplete' with the verdict's words; the in_pr report is posted before PATCH mergeSha", async () => {
    const run3 = run3Json<{ jobs: ChecklistItem[] }>("wizard/state.json")
    const { ctx, deps, bridge } = setup(["OPEN", "MERGED"], (signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve("__cancelled__"))))
    deps.report = createReportBuilder(() => deps.clock.now())
    ;(deps.git as unknown as { remoteUrl: () => Promise<string> }).remoteUrl = async () => "https://github.com/acme/site.git"
    ctx.state.update((state) => {
      state.jobs = run3.jobs.filter((job) => job.jobId !== "review_comments")
      state.report.in_pr = buildColumn("in_pr", { runId: RUN_ID, meta: { measuredAt: "2026-10-03T05:30:00.000Z", sha: "b".repeat(40) }, facts: [{ input: "rehearsal.graded", state: "problem", at: "2026-10-03T05:30:00.000Z" }], rows: {} })
    })
    const outcome = await step.run(ctx, deps)
    expect(outcome.kind).toBe("ok")
    const payload = ctx.asks.find((ask) => ask.kind === "merge-ready")!.payload as { number: number; summary: string; incomplete?: string; prUrl: string }
    expect(payload.incomplete).toBe("5 approved fixes are not in the code (Remove duplicate tags, Keep previews silent (existing tags), Keep previews silent (existing tags) +2 more)")
    const view = mergeReadyOverlay.render(payload, {}, { sanitize: (text: string) => text, styles: { info: (text: string) => text } } as never)
    expect(view.heading).toBe("Ready to merge, but incomplete")
    expect(view.question).toMatch(/^Pull request #2 does not have everything the plan approved: 5 approved fixes are not in the code \(.*\)\. Merging ships only what is in it\./)
    expect(view.question).not.toContain("Merge it to ship")
    // The in-PR report (with its not_checked_live verdict) is posted BEFORE the merge is PATCHed.
    const order = bridge.calls.map((call) => call.verb)
    expect(order.indexOf("report")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("report")).toBeLessThan(order.indexOf("runs.patch"))
    const posted = bridge.calls.find((call) => call.verb === "report")!.body as { phase: string; report: ReportV2 }
    expect(posted.phase).toBe("in_pr")
    expect(posted.report.verdict).toMatchObject({ state: "not_checked_live" })
    expect(posted.report.verdict!.reasons.map((reason) => reason.kind)).toEqual(["not_live", "approved_fix_missing"])
  })

  it("negative: a PR with every approved fix done is 'Ready to ship' (no incomplete words)", async () => {
    const { ctx, deps } = setup(["OPEN", "MERGED"], (signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve("__cancelled__"))))
    deps.report = createReportBuilder(() => deps.clock.now())
    ;(deps.git as unknown as { remoteUrl: () => Promise<string> }).remoteUrl = async () => "https://github.com/acme/site.git"
    ctx.state.update((state) => {
      state.report.in_pr = buildColumn("in_pr", { runId: RUN_ID, meta: { measuredAt: "2026-10-03T05:30:00.000Z", sha: "b".repeat(40) }, facts: [{ input: "rehearsal.graded", state: "pass", at: "2026-10-03T05:30:00.000Z" }], rows: {} })
    })
    await step.run(ctx, deps)
    const payload = ctx.asks.find((ask) => ask.kind === "merge-ready")!.payload as { incomplete?: string }
    expect(payload.incomplete).toBeUndefined()
  })
})

describe("fresh merge-card checks", () => {
  it("does not invite a merge when a newly read check is failing", async () => {
    const { ctx, deps, host } = setup(["OPEN"], async () => "later")
    ;(host as unknown as { gh: { json: (args: string[]) => Promise<unknown> } }).gh.json = async args => args[1]!.includes("/check-runs") ? { check_runs: [{ name: "lint", head_sha: args[1]!.includes("a".repeat(40)) ? "a".repeat(40) : "b".repeat(40), status: "completed", conclusion: args[1]!.includes("a".repeat(40)) ? "success" : "failure" }] } : args[1]!.includes("/status?") ? { statuses: [] } : []
    expect(await step.run(ctx, deps)).toMatchObject({ kind: "parked", reason: expect.stringContaining("lint (failure)") })
    expect(ctx.asks).toEqual([])
  })
  it("shows the freshly read successful state on the merge card", async () => {
    const { ctx, deps, host } = setup(["OPEN"], async () => "later")
    ;(host as unknown as { gh: { json: (args: string[]) => Promise<unknown> } }).gh.json = async args => args[1]!.includes("/check-runs") ? { check_runs: [{ name: "lint", head_sha: args[1]!.includes("a".repeat(40)) ? "a".repeat(40) : "b".repeat(40), status: "completed", conclusion: "success" }] } : args[1]!.includes("/status?") ? { statuses: [] } : []
    await step.run(ctx, deps)
    expect((ctx.asks[0]!.payload as { summary: string }).summary).toContain("lint: success")
  })
})

it("keeps polling a resumed merge step inside the saved check window", async () => {
  const { ctx, deps, host, clock } = setup(["OPEN"], async () => "later")
  ctx.state.update(state => { state.lastPush = { sha: "b".repeat(40), at: new Date(clock.now().getTime() - 300_000).toISOString() } })
  let headReads = 0
  ;(host as unknown as { gh: { json: (args: string[]) => Promise<unknown> } }).gh.json = async args => {
    if (args[1]!.includes("/check-runs")) {
      const base = args[1]!.includes("a".repeat(40)); const pending = !base && ++headReads === 1
      return { check_runs: [{ name: "lint", head_sha: base ? "a".repeat(40) : "b".repeat(40), status: pending ? "in_progress" : "completed", conclusion: pending ? null : "success" }] }
    }
    return args[1]!.includes("/status?") ? { statuses: [] } : []
  }
  await step.run(ctx, deps)
  expect(headReads).toBe(2)
  expect((ctx.asks[0]!.payload as { summary: string }).summary).toContain("lint: success")
  expect(clock.slept[0]).toBe(30_000)
})
