import { describe, expect, it } from "vitest"

import {
  HOST,
  MERGE_SHA,
  RUN_ID,
  SERVING_SHA,
  fakeContext,
  fakeDeps,
  keysFixture,
  lane,
  realVisitResult,
  receiptsAll,
  type FakeDepsBundle
} from "../../../test/wizard/runtime-fakes.js"
import type { TestRunRequest } from "../contracts/test-engine.js"
import { createRunState } from "../run-state.js"
import { PROVE_LIMITS, buildProvenColumn, ownReceipt, proofStateFrom, receiptMarkersFrom, step } from "./prove.js"

function mergedState() {
  const state = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "r-7f3c" })
  state.runId = RUN_ID
  state.pr = {
    host: "github",
    number: 42,
    url: "https://github.com/acme/acme-store/pull/42",
    nodeId: "PR_x",
    isDraft: false,
    round: 1,
    reviewedSha: null,
    handledThreadIds: [],
    mergeSha: MERGE_SHA
  }
  return state
}

async function runProve(bundle: FakeDepsBundle, options: Parameters<typeof fakeContext>[1] = {}) {
  const ctx = fakeContext(mergedState(), options, bundle.clock)
  const outcome = await step.run(ctx, bundle.deps)
  return { ctx, outcome }
}

const subs = (ctx: ReturnType<typeof fakeContext>) =>
  ctx.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)

describe("prove: waiting for the deploy of the MERGE commit", () => {
  it("waits while the merge build is building, then proceeds when it is ready", async () => {
    const bundle = fakeDeps({
      bridge: {
        deploy: [
          { mergeDeployment: { state: "building", readyAt: null }, serving: null, target: "production" },
          { mergeDeployment: { state: "building", readyAt: null }, serving: null, target: "production" },
          { mergeDeployment: { state: "ready", readyAt: "2026-10-02T09:38:00.000Z" }, serving: { sha: MERGE_SHA, readyAt: "2026-10-02T09:38:00.000Z", createdAt: "2026-10-02T09:36:00.000Z", ref: "main" }, target: "production" }
        ]
      }
    })
    const { outcome } = await runProve(bundle)
    expect(outcome.kind).toBe("ok")
    const names = bundle.log.names("bridge")
    expect(names.filter((name) => name === "bridge.deployStatus")).toHaveLength(3)
    expect(names.indexOf("bridge.claimProof")).toBeGreaterThan(names.lastIndexOf("bridge.deployStatus"))
    expect(bundle.log.calls.filter((call) => call.what === "deployStatus").every((call) => call.args[0] === MERGE_SHA)).toBe(true)
  })

  it("a canceled merge build plus a later serving SHA that DESCENDS from the merge → deployed (fetch the production branch, then merge-base --is-ancestor)", async () => {
    const bundle = fakeDeps({
      bridge: { deploy: [{ mergeDeployment: { state: "canceled", readyAt: null }, serving: { sha: SERVING_SHA, readyAt: "2026-10-02T09:39:00.000Z", createdAt: "2026-10-02T09:37:00.000Z", ref: "main" }, target: "production" }] },
      // The serving commit is not in this clone until the production branch is fetched (git exits 128).
      git: { ancestors: [[MERGE_SHA, SERVING_SHA]], unfetched: [SERVING_SHA] }
    })
    const { outcome, ctx } = await runProve(bundle)
    expect(outcome.kind).toBe("ok")
    expect(bundle.log.names("git")).toEqual(["git.remoteBranchSha", "git.isAncestor"])
    expect(bundle.log.calls.find((call) => call.what === "remoteBranchSha")!.args).toEqual(["main"])
    expect(subs(ctx).join(" ")).toContain(`a later commit, ${SERVING_SHA.slice(0, 7)}, includes it`)
  })

  it("negative: a serving SHA that does NOT descend keeps waiting, and the wait parks DEPLOY_TIMEOUT with 'open Infinite' (no claim, no visit)", async () => {
    const bundle = fakeDeps({
      bridge: { deploy: [{ mergeDeployment: { state: "canceled", readyAt: null }, serving: { sha: SERVING_SHA, readyAt: null, createdAt: "2026-10-02T09:37:00.000Z", ref: "main" }, target: "production" }] },
      git: { ancestors: [] }
    })
    const { outcome } = await runProve(bundle)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_DEPLOY_TIMEOUT" })
    expect((outcome as { resumeHint: string }).resumeHint).toMatch(/Open Infinite/)
    const polls = bundle.log.names("bridge").filter((name) => name === "bridge.deployStatus").length
    expect(polls).toBeGreaterThan(PROVE_LIMITS.deployWaitMs / PROVE_LIMITS.deployPollMs - 2)
    expect(bundle.log.names("bridge")).not.toContain("bridge.claimProof")
    expect(bundle.log.names("bridge")).not.toContain("bridge.startTest")
  })

  it("nothing merged → parked MERGE_PARKED; --no-prove → skipped (the app proves it)", async () => {
    const bundle = fakeDeps()
    const state = mergedState()
    state.pr!.mergeSha = null
    const outcome = await step.run(fakeContext(state, {}, bundle.clock), bundle.deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_MERGE_PARKED" })
    const skipped = await step.run(fakeContext(mergedState(), { noProve: true }, bundle.clock), bundle.deps)
    expect(skipped.kind).toBe("skipped")
    expect(bundle.log.names("bridge")).toEqual([])
  })
})

describe("prove: the proof claim and the ONE real visit", () => {
  it("wins the claim → exactly one real_visit to the production root with the probe, receipts from that visit, the column, PATCH proofState", async () => {
    const bundle = fakeDeps()
    const { outcome, ctx } = await runProve(bundle)
    expect(outcome).toMatchObject({ kind: "ok", status: "4 of 4 tools passed the live test" })
    const starts = bundle.log.calls.filter((call) => call.what === "startTest")
    expect(starts).toHaveLength(1)
    const request = starts[0]!.args[0] as TestRunRequest
    expect(request).toMatchObject({ mode: "real_visit", runId: RUN_ID, productionHost: HOST, targets: [{ url: `https://${HOST}/`, label: "home" }], serverLaneProbe: { path: "/__infinite_probe/7f3c2a91b0de" } })
    expect(request).not.toHaveProperty("fakeClickId")
    expect(request).not.toHaveProperty("clicks")
    expect(request.expect).toEqual({ ga4: ["G-ACME000001"], posthog: { projectKey: keysFixture().posthog.projectKey, apiHost: "https://us.i.posthog.com" }, meta: ["1234567890123456"], infinite: { siteSourceKey: "site_FAKEnotreal0001", collectPath: "/infinite/ledger" } })

    const order = bundle.log.names("bridge").filter((name) => ["bridge.claimProof", "bridge.startTest", "bridge.postReceipts", "bridge.patchRun"].includes(name))
    expect(order).toEqual(["bridge.claimProof", "bridge.startTest", "bridge.postReceipts", "bridge.patchRun"])
    const receipts = bundle.log.calls.find((call) => call.what === "postReceipts")!.args[1] as { markers: unknown; phase: string }
    expect(receipts.phase).toBe("proven_live")
    expect(receipts.markers).toEqual({
      infinite: { eventIds: ["evt_FAKE0301"] },
      posthog: { distinctId: "0192-fake-distinct-4c03" },
      ga4: { measurementId: "G-ACME000001", seenLeaving: true, httpStatus: 204 },
      metaPixel: { pixelId: "1234567890123456", seenLeaving: true, httpStatus: 200 },
      serverLane: { probePath: "/__infinite_probe/7f3c2a91b0de" }
    })
    expect(bundle.log.calls.find((call) => call.what === "patchRun")!.args[1]).toEqual({ proofState: "proven" })

    const column = ctx.current().report.proven_live!
    expect(column.meta.sha).toBe(MERGE_SHA)
    expect(column.finishLine.proof_from_real_visit).toMatchObject({ state: "pass", provenance: { source: "cloud_receipt" } })
    expect(column.cells.live_test_per_tool!.display).toBe("5 of 5 fire: 3 verified (receipts from this visit) · 2 seen leaving")
    expect(ctx.current().markers.prove.posthogDistinctId).toBe("0192-fake-distinct-4c03")
  })

  it("prints the run's PostHog distinct id so the user can filter the visitor out", async () => {
    const bundle = fakeDeps()
    const { ctx } = await runProve(bundle)
    expect(subs(ctx)).toContain("Filter this visitor out in PostHog: distinct_id = 0192-fake-distinct-4c03")
  })

  it("negative: losing the claim (claimed_by_other) runs NO real visit, reads the receipts, and never PATCHes proofState", async () => {
    const bundle = fakeDeps({ bridge: { claim: { code: "claimed_by_other", state: "proving" } } })
    const { outcome, ctx } = await runProve(bundle)
    expect(bundle.log.names("bridge").filter((name) => name === "bridge.startTest")).toHaveLength(0)
    expect(bundle.log.names("bridge").filter((name) => name === "bridge.pollTest")).toHaveLength(0)
    expect(bundle.log.names("bridge")).toContain("bridge.postReceipts")
    expect(bundle.log.calls.filter((call) => call.what === "patchRun")).toHaveLength(0)
    expect(outcome).toMatchObject({ kind: "ok" })
    expect((outcome as { status: string }).status).toContain("receipts from the Infinite app's visit")
    const column = ctx.current().report.proven_live!
    expect(column.finishLine.each_tool_once).toMatchObject({ state: "pending", reason: "pending_open_infinite" })
    expect(column.cells.ga4_page_views_per_visit).toMatchObject({ value: null, display: "—", reason: "pending_open_infinite" })
  })

  it("any other claim error is never a lost claim: a 402 blocks SUBSCRIPTION_REQUIRED (§3z.4) and no visit is made", async () => {
    const bundle = fakeDeps({ bridge: { claim: { code: "subscription_required" } } })
    expect((await runProve(bundle)).outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
    expect(bundle.log.names("bridge")).not.toContain("bridge.startTest")
  })

  it("negative: a claim error outside the §3z.4 table is not swallowed", async () => {
    const bundle = fakeDeps({ bridge: { claim: { code: "invalid_request" } } })
    await expect(runProve(bundle)).rejects.toMatchObject({ code: "invalid_request" })
    expect(bundle.log.names("bridge")).not.toContain("bridge.startTest")
  })

  it("re-polls receipts every 10 s while a lane is pending, within waitMs", async () => {
    const pending = receiptsAll({ infinite: lane("pending") })
    const bundle = fakeDeps({ bridge: { receipts: [pending, pending, receiptsAll()] } })
    const { ctx } = await runProve(bundle)
    expect(bundle.log.names("bridge").filter((name) => name === "bridge.postReceipts")).toHaveLength(3)
    expect(ctx.current().report.proven_live!.finishLine.proof_from_real_visit!.state).toBe("pass")
  })

  it("a failed real visit is never proof: proofState undetermined, PROOF_INCOMPLETE (continue)", async () => {
    const bundle = fakeDeps({ bridge: { testPolls: [{ state: "failed", progress: [], error: { code: "load_failed", message: "the page did not load" } }] } })
    const { outcome } = await runProve(bundle)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE", next: "continue" })
    expect(bundle.log.calls.find((call) => call.what === "patchRun")!.args[1]).toEqual({ proofState: "undetermined" })
  })
})

describe("prove: the proven_live column is honest", () => {
  const base = {
    runId: RUN_ID,
    mergeSha: MERGE_SHA,
    at: "2026-10-02T09:43:00.000Z",
    keys: keysFixture(),
    t1: [],
    serverLaneInstalled: true,
    conversionsWaiting: 1
  }
  const expect4 = { ga4: ["G-ACME000001"], posthog: { projectKey: "phc_x", apiHost: "https://us.i.posthog.com" }, meta: ["1234567890123456"], infinite: { siteSourceKey: "s", collectPath: "/c" } }
  const pass = (id: string) => ({ checkId: id, state: "pass" as const, tier: "PV" as const, at: base.at, runId: RUN_ID })

  it("a tool with no receipt is a problem, and the run is not proven", () => {
    const column = buildProvenColumn({
      ...base,
      expect: expect4,
      visit: { result: realVisitResult(), grades: { infinite: pass("a"), ga4: pass("b"), posthog: pass("c"), meta: pass("d") } },
      receipts: receiptsAll({ infinite: lane("no_receipt") })
    })
    expect(column.finishLine.proof_from_real_visit!.state).toBe("problem")
    expect(proofStateFrom(column)).toBe("problem")
  })

  it("PostHog seen but sent directly (not through the proxy) is a problem for 'survives ad blockers'", () => {
    const direct = realVisitResult()
    direct.posthog.events = direct.posthog.events.map((event) => ({ ...event, sameOrigin: false, endpointHost: "us.i.posthog.com" }))
    const column = buildProvenColumn({ ...base, expect: expect4, visit: { result: direct, grades: { infinite: pass("a"), ga4: pass("b"), posthog: pass("c"), meta: pass("d") } }, receipts: receiptsAll() })
    expect(column.finishLine.survives_ad_blockers).toMatchObject({ state: "problem" })
    expect(column.cells.posthog_route).toMatchObject({ value: "direct", state: "problem" })
  })

  it("a grader's wrong-id problem marks ids_match_connections, not each_tool_once; GA4 twice per visit is a problem", () => {
    const twice = realVisitResult()
    twice.ga4.events = [...twice.ga4.events, { ...twice.ga4.events[0]! }]
    const column = buildProvenColumn({
      ...base,
      expect: expect4,
      visit: { result: twice, grades: { infinite: pass("a"), ga4: { ...pass("b"), state: "problem", reason: "wrong_id" }, posthog: pass("c"), meta: pass("d") } },
      receipts: receiptsAll()
    })
    expect(column.finishLine.ids_match_connections!.state).toBe("problem")
    expect(column.finishLine.each_tool_once!.state).toBe("undetermined")
    expect(column.cells.ga4_page_views_per_visit).toMatchObject({ value: 2, state: "problem" })
  })

  it("markers name only what THIS visit observed (no dry-load ids, no unconnected tool)", () => {
    const markers = receiptMarkersFrom(realVisitResult(), { ga4: ["G-ACME000001"] })
    expect(markers).toEqual({ ga4: { measurementId: "G-ACME000001", seenLeaving: true, httpStatus: 204 }, serverLane: { probePath: "/__infinite_probe/7f3c2a91b0de" } })
  })
})

describe("prove: a resume finishes its OWN claim (O1-06)", () => {
  it("won, visited, then stopped before the PATCH: the resume (409 proving) rebuilds the column from the saved visit and PATCHes, with no second visit", async () => {
    const first = fakeDeps({
      bridge: {
        patchRun: () => {
          throw new Error("the laptop slept")
        }
      }
    })
    await expect(runProve(first)).rejects.toThrow("the laptop slept")
    expect(first.log.names("bridge").filter((name) => name === "bridge.startTest")).toHaveLength(1)

    const resumed = fakeDeps({ bridge: { claim: { code: "claimed_by_other", state: "proving" } } })
    resumed.deps.fs = first.deps.fs
    const { outcome, ctx } = await runProve(resumed)
    expect(resumed.log.names("bridge")).not.toContain("bridge.startTest")
    expect(resumed.log.calls.filter((call) => call.what === "patchRun").map((call) => call.args[1])).toEqual([{ proofState: "proven" }])
    expect(outcome).toMatchObject({ kind: "ok", status: "4 of 4 tools passed the live test" })
    expect((outcome as { status: string }).status).not.toContain("Infinite app")
    const column = ctx.current().report.proven_live!
    expect(column.finishLine.each_tool_once!.state).toBe("pass")
    expect(proofStateFrom(column)).toBe("proven")
    // The receipts are read with THIS visit's markers.
    const markers = (resumed.log.calls.find((call) => call.what === "postReceipts")!.args[1] as { markers: { infinite?: unknown } }).markers
    expect(markers.infinite).toEqual({ eventIds: ["evt_FAKE0301"] })
  })

  it("won, then stopped mid-visit (no facts saved): the resume makes no second visit and PATCHes undetermined", async () => {
    const first = fakeDeps({
      bridge: {
        testPolls: [
          {
            state: "running",
            progress: []
          }
        ]
      }
    })
    first.deps.bridge.pollTest = async () => {
      throw new Error("Ctrl+C")
    }
    await expect(runProve(first)).rejects.toThrow("Ctrl+C")

    const resumed = fakeDeps({ bridge: { claim: { code: "claimed_by_other", state: "proving" } } })
    resumed.deps.fs = first.deps.fs
    const { outcome } = await runProve(resumed)
    expect(resumed.log.names("bridge")).not.toContain("bridge.startTest")
    expect(resumed.log.calls.filter((call) => call.what === "patchRun").map((call) => call.args[1])).toEqual([{ proofState: "undetermined" }])
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE", next: "continue" })
  })

  it("the run state's own prove markers (written only by this run's visit) also mark the claim as ours: receipts by those markers, then the PATCH", async () => {
    const bundle = fakeDeps({ bridge: { claim: { code: "claimed_by_other", state: "proving" } } })
    const state = mergedState()
    state.markers.prove = { infiniteEventIds: ["evt_FAKE0301"], posthogDistinctId: "0192-fake-distinct-4c03", probePath: "/__infinite_probe/7f3c2a91b0de", metaEventIds: [] }
    const outcome = await step.run(fakeContext(state, {}, bundle.clock), bundle.deps)
    expect(bundle.log.names("bridge")).not.toContain("bridge.startTest")
    expect(bundle.log.calls.filter((call) => call.what === "patchRun")).toHaveLength(1)
    expect((bundle.log.calls.find((call) => call.what === "postReceipts")!.args[1] as { markers: unknown }).markers).toMatchObject({ infinite: { eventIds: ["evt_FAKE0301"] } })
    expect((outcome as { status: string }).status).not.toContain("Infinite app")
  })

  it("negative: a saved claim of ANOTHER run (or merge) is not this run's; the 409 stays someone else's and nothing is PATCHed", async () => {
    const first = fakeDeps({
      bridge: {
        patchRun: () => {
          throw new Error("the laptop slept")
        }
      }
    })
    await expect(runProve(first)).rejects.toThrow()
    const resumed = fakeDeps({ bridge: { claim: { code: "claimed_by_other", state: "proving" } } })
    resumed.deps.fs = first.deps.fs
    const state = mergedState()
    state.pr!.mergeSha = "a".repeat(40)
    const ctx = fakeContext(state, {}, resumed.clock)
    const outcome = await step.run(ctx, resumed.deps)
    expect(resumed.log.calls.filter((call) => call.what === "patchRun")).toHaveLength(0)
    expect((outcome as { status: string }).status).toContain("receipts from the Infinite app's visit")
  })
})

describe("prove: consent-held or unobserved tools are UNKNOWN, never problems (O1-07)", () => {
  const at = "2026-10-02T09:43:00.000Z"
  const held = (tool: string) => ({ checkId: `real_visit_${tool}`, state: "undetermined" as const, reason: "held_by_consent", tier: "PV" as const, at, runId: RUN_ID })
  const expect4 = { ga4: ["G-ACME000001"], posthog: { projectKey: "phc_x", apiHost: "https://us.i.posthog.com" }, meta: ["1234567890123456"], infinite: { siteSourceKey: "s", collectPath: "/c" } }

  function heldVisit() {
    const result = realVisitResult()
    result.environment.cmpDetected = "onetrust"
    result.ga4.events = []
    result.posthog.events = []
    result.meta.tr = []
    return result
  }

  it("a CMP holds every tool: GA4 page views and the PostHog route read unknown with the grader's reason, and 'survives ad blockers' is not a problem", () => {
    const column = buildProvenColumn({
      runId: RUN_ID,
      mergeSha: MERGE_SHA,
      at,
      keys: keysFixture(),
      expect: expect4,
      visit: { result: heldVisit(), grades: { infinite: held("infinite"), ga4: held("ga4"), posthog: held("posthog"), meta: held("meta") } },
      receipts: receiptsAll({ posthog: lane("verified", "2026-10-02T09:40:06.000Z", "posthog_query") }),
      t1: [],
      serverLaneInstalled: true,
      conversionsWaiting: 0
    })
    expect(column.cells.ga4_page_views_per_visit).toMatchObject({ value: null, display: "—", state: "undetermined", reason: "held_by_consent" })
    expect(column.cells.posthog_route).toMatchObject({ value: null, display: "—", state: "undetermined", reason: "held_by_consent" })
    expect(column.finishLine.survives_ad_blockers!.state).not.toBe("problem")
    expect(JSON.stringify(column)).not.toContain("sent directly")
  })

  it("negative: a graded GA4 with 0 page views IS a problem, and PostHog events seen leaving directly ARE 'direct'", () => {
    const pass = (tool: string) => ({ checkId: `real_visit_${tool}`, state: "pass" as const, tier: "PV" as const, at, runId: RUN_ID })
    const result = realVisitResult()
    result.ga4.events = []
    result.posthog.events = result.posthog.events.map((event) => ({ ...event, sameOrigin: false }))
    const column = buildProvenColumn({
      runId: RUN_ID,
      mergeSha: MERGE_SHA,
      at,
      keys: keysFixture(),
      expect: expect4,
      visit: { result, grades: { infinite: pass("infinite"), ga4: { ...pass("ga4"), state: "problem", reason: "no_beacon" }, posthog: pass("posthog"), meta: pass("meta") } },
      receipts: receiptsAll(),
      t1: [],
      serverLaneInstalled: true,
      conversionsWaiting: 0
    })
    expect(column.cells.ga4_page_views_per_visit).toMatchObject({ value: 0, state: "problem" })
    expect(column.cells.posthog_route).toMatchObject({ value: "direct", state: "problem" })
  })
})

describe("prove: a redirecting home page (review I1 P1-1)", () => {
  const hop = (state: "pass" | "problem") => ({
    checkId: "redirect_walk",
    state,
    tier: "T1" as const,
    // O9's real reason text: an arrow, and a %-encoded path.
    reason: `every hop keeps utm_* (1 hop: 301 → https://www.${HOST}/en%2Fhome -> /en => ok)`,
    at: "2026-10-02T09:43:00.000Z",
    runId: RUN_ID
  })

  it("an apex → www redirect builds the column with fixed words (never the check's free text) and PATCHes the proof", async () => {
    const bundle = fakeDeps()
    bundle.deps.checks.redirectWalk = async () => [hop("pass")]
    bundle.deps.checks.csp = async () => [{ ...hop("problem"), checkId: "csp_header", reason: "script-src → blocks https://connect.facebook.net (100% of loads)" }]
    const { outcome, ctx } = await runProve(bundle)
    expect(outcome.kind).toBe("ok")
    const column = ctx.current().report.proven_live!
    expect(column.finishLine.utms_survive_redirects).toMatchObject({ state: "pass", display: "campaign tags kept through every redirect" })
    expect(column.finishLine.csp_allows!.display).not.toMatch(/→|%|->/)
    expect(bundle.log.calls.find((call) => call.what === "patchRun")!.args[1]).toEqual({ proofState: "proven" })
  })

  it("an unexpected error after the claim was granted still settles proofState undetermined before it throws (never 24 h of 'proving')", async () => {
    const bundle = fakeDeps()
    bundle.deps.checks.redirectWalk = async () => {
      throw new Error("boom")
    }
    await expect(runProve(bundle)).rejects.toThrow("boom")
    const patches = bundle.log.calls.filter((call) => call.what === "patchRun").map((call) => call.args[1])
    expect(patches).toEqual([{ proofState: "undetermined" }])
  })

  it("negative: a lost claim (someone else's proof) never PATCHes on an error", async () => {
    const bundle = fakeDeps({ bridge: { claim: { code: "claimed_by_other", state: "proving" } } })
    bundle.deps.checks.redirectWalk = async () => {
      throw new Error("boom")
    }
    await expect(runProve(bundle)).rejects.toThrow("boom")
    expect(bundle.log.names("bridge")).not.toContain("bridge.patchRun")
  })
})

describe("prove: receipts from before the run started are not this run's (§3z.8 rule 3)", () => {
  it("a verified receipt older than runStartedAt reads undetermined, so nothing says verified/proven", () => {
    const at = "2026-10-02T09:43:00.000Z"
    const receipts = receiptsAll()
    const column = buildProvenColumn({
      runId: RUN_ID,
      mergeSha: MERGE_SHA,
      at,
      keys: keysFixture(),
      expect: { posthog: { projectKey: "phc_x", apiHost: "https://us.i.posthog.com" } },
      visit: null,
      receipts: { ...receipts, lanes: { ...receipts.lanes, posthog: lane("verified", "2026-10-02T08:00:00.000Z") } },
      t1: [],
      serverLaneInstalled: false,
      conversionsWaiting: 0,
      runStartedAt: "2026-10-02T09:00:00.000Z"
    })
    expect(column.finishLine.proof_from_real_visit!.state).not.toBe("pass")
    expect(column.cells.live_test_per_tool!.display).not.toContain("verified")
    expect(column.cells.live_test_per_tool!.provenance.receiptAt).toBeUndefined()
    expect(ownReceipt(lane("verified", "2026-10-02T09:30:00.000Z"), "2026-10-02T09:00:00.000Z").state).toBe("verified")
  })
})
