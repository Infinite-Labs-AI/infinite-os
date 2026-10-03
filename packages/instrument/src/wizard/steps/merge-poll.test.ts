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
