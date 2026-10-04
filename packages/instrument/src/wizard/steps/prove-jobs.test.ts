import { expect, it } from "vitest"
import { MERGE_SHA, RUN_ID, fakeContext, fakeDeps, keysFixture, lane, realVisitResult, receiptsAll } from "../../../test/wizard/runtime-fakes.js"
import { CHECK_LABELS } from "../../jobs/check-words.js"
import { createCheckRunner } from "../../checks/registry.js"
import { createJobRegistry, itemChecksFor } from "../../jobs/registry.js"
import type { ChecklistItem, JobId } from "../contracts/jobs.js"
import { createRunState } from "../run-state.js"
import { step } from "./prove.js"

const DEPLOY = "2026-10-02T09:38:00.000Z"
const AT = "2026-10-02T09:43:00.000Z"
function job(jobId: JobId, checkId: string, tier: "PV" | "T1" = "PV", state: ChecklistItem["state"] = "waiting_deploy"): ChecklistItem {
  return { id: `${jobId}:${checkId}`, jobId, n: 1, title: jobId, owner: "agent", state,
    trigger: { finding: "test", evidence: [] }, allow: { files: [], create: [] },
    claim: { status: "done", note: "done", at: "2026-10-02T09:00:00.000Z" },
    checks: [{ id: checkId, tier, state: "not_run" }, { id: "local_verified", tier: "S", state: "pass", runId: RUN_ID, at: "2026-10-02T09:10:00.000Z" }] }
}
function world(jobs: ChecklistItem[], options: Parameters<typeof fakeDeps>[0] = {}) {
  const bundle = fakeDeps(options)
  const state = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "test" })
  state.runId = RUN_ID
  state.steps.merge = { outcome: "ok", inputHash: "merge", at: DEPLOY }
  state.pr = { host: "github", number: 42, url: "https://github.com/acme/site/pull/42", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: MERGE_SHA }
  state.jobs = jobs
  const checks = createCheckRunner({ root: "/repo", appRoot: ".", now: () => new Date(AT), runId: () => RUN_ID })
  bundle.deps.checks.gradeTestRun = checks.gradeTestRun
  bundle.deps.checks.gradeTestRunChecks = checks.gradeTestRunChecks
  bundle.deps.registry = createJobRegistry({ briefFacts: () => null, liveSince: () => DEPLOY })
  const ctx = fakeContext(state, {}, bundle.clock)
  return { ...bundle, ctx }
}

it("request 2 P2-1: a firing unconnected Meta pixel does not prevent duplicate-count proof", async () => {
  const t = world([job("duplicates_remove", "one_beacon_per_tool")], { bridge: { keys: keysFixture({ meta: { status: "not_connected", pixels: [] } }) } })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe("proven")
  expect(t.ctx.current().jobs[0]!.checks[0]!.state).toBe("pass")
})

it("request 2 P2-2: receipt and live-byte checks reach every waiting job", async () => {
  const t = world([job("posthog_improve", "posthog_distinct_id_receipt"), job("server_lane_mount", "server_lane_probe_receipt"), job("ga4_improve", "ga4_loader_id", "T1"), job("unusual_layout", "byte_census", "T1")])
  t.deps.checks.liveBytes = async () => ["byte_census", "ga4_loader_id"].map(checkId => ({ checkId, tier: "T1", state: "pass", at: AT, runId: RUN_ID }))
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs.map(item => item.state)).toEqual(["proven", "proven", "proven", "proven"])
})

it.each(["missing", "problem", "undetermined"] as const)("request 2 P2-2: a %s post-deploy check is never waiting for deploy", async (kind) => {
  const t = world([job("ga4_improve", "ga4_seen_leaving")])
  t.deps.checks.gradeTestRunChecks = async () => kind === "missing" ? [] : [{ checkId: "ga4_seen_leaving", tier: "PV", state: kind, at: AT, runId: RUN_ID }]
  await step.run(t.ctx, t.deps)
  const final = t.ctx.current().jobs[0]!
  expect(final.state).toBe(kind === "problem" ? "failed" : "done_in_code")
  expect(final.note).toContain(kind === "problem" ? "Failed after the deploy" : "Not checked after the deploy")
  expect(final.note).toContain("GA4 sent data from the visit")
})

it("request 2 P2-2: Meta domain checks remain explicitly unmeasured without new provider calls", async () => {
  const t = world([job("meta_improve", "meta_traffic_permissions", "T1"), job("preview_guard", "meta_host_matrix", "T1", "done_in_code")])
  t.deps.checks.metaDomains = async () => { throw new Error("must not add a provider call") }
  await step.run(t.ctx, t.deps)
  for (const final of t.ctx.current().jobs) {
    expect(final.state).toBe("done_in_code")
    expect(final.note).toContain("Not checked after the deploy")
    expect(final.note).toContain(CHECK_LABELS[final.checks[0]!.id]!)
  }
})

it.each(["delivering", "no_receipt", "old_receipt"] as const)("request 2 P2-2: %s never substitutes for a current receipt", async kind => {
  const receipt = kind === "old_receipt" ? lane("verified", "2026-10-02T08:00:00.000Z") : lane(kind)
  const t = world([job("posthog_improve", "posthog_distinct_id_receipt"), job("server_lane_mount", "server_lane_probe_receipt")], { bridge: { receipts: [receiptsAll({ posthog: receipt, server_lane: receipt })] } })
  await step.run(t.ctx, t.deps)
  for (const final of t.ctx.current().jobs) {
    expect(final.state).not.toBe("proven")
    expect(final.state).not.toBe("waiting_deploy")
    expect(final.note).toMatch(/Not checked after the deploy|Failed after the deploy/)
  }
})

it("request 2 P3-2: an old visit graded now cannot prove the deployed jobs", async () => {
  const result = realVisitResult({ startedAt: "2026-10-02T09:01:00.000Z", finishedAt: "2026-10-02T09:02:00.000Z" })
  const t = world([job("ga4_improve", "ga4_seen_leaving")], { bridge: { testPolls: [{ state: "done", progress: [], result }] } })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe("done_in_code")
  expect(t.ctx.current().jobs[0]!.note).toContain("Not checked after the deploy")
})

it("request 2 P3-2: prove refuses another run's actual visit facts", async () => {
  const result = realVisitResult({ runId: "11111111-2222-4333-8444-555555555555" })
  const t = world([job("ga4_improve", "ga4_seen_leaving")], { bridge: { testPolls: [{ state: "done", progress: [], result }] } })
  await expect(step.run(t.ctx, t.deps)).rejects.toThrow("stale facts are never this run's proof")
  expect(t.ctx.current().jobs[0]!.state).not.toBe("proven")
})


it.each([false, true])("request 2 P3-3: a rehearsal-only job needs measured production navigation (blocked=%s)", async blocked => {
  const dry = realVisitResult({ mode: "dry_live" })
  dry.meta.tr.push({ ...dry.meta.tr[0]!, afterNav: true })
  dry.environment.blockedBySiteBotRules = blocked
  const spa: ChecklistItem = { ...job("meta_improve", "unused"), checks: [{ id: "meta_spa_page_view", tier: "RH", state: "pass", runId: RUN_ID, at: "2026-10-02T09:10:00.000Z" }] }
  const t = world([spa], { bridge: { testPolls: [{ state: "done", progress: [], result: realVisitResult() }, { state: "done", progress: [], result: dry }] } })
  await t.deps.fs.writeTextAtomic("/repo/.infinite/wizard/before.json", JSON.stringify({ schema: "infinite-tag.before-facts.v1", runId: RUN_ID, measuredAt: "2026-10-02T09:00:00.000Z", facts: { census: { entries: [] }, keys: {}, hosting: {} }, spaNavigation: { path: "/pricing" } }))
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe(blocked ? "claimed" : "proven")
  if (blocked) expect(t.ctx.current().jobs[0]!.note).toContain("Not checked after the deploy")
})


function realJob(jobId: JobId, target: string): ChecklistItem {
  return { ...job(jobId, "unused"), id: `${jobId}:${target}`, title: `${jobId} ${target}`,
    checks: itemChecksFor(jobId, target, "next").map(check => ["S", "T0", "RH"].includes(check.tier)
      ? { ...check, state: "pass" as const, runId: RUN_ID, at: "2026-10-02T09:10:00.000Z" } : check) }
}

it.each(["history_change", "defaults", "proxy"])("request 3 P1-A: a direct PostHog route affects only the proxy target (%s)", async target => {
  const visit = realVisitResult()
  visit.posthog.events[0]!.sameOrigin = false
  visit.posthog.events[0]!.endpointHost = "us.i.posthog.com"
  const t = world([realJob("posthog_improve", target)], { bridge: { testPolls: [{ state: "done", progress: [], result: visit }] } })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe(target === "proxy" ? "failed" : "proven")
})

it.each(["ga4", "posthog"])("request 3 P1-B: a silent production-deployment preview proves its %s guard", async target => {
  const preview = realVisitResult({ mode: "dry_live", startedAt: "2026-10-02T09:42:00.000Z" })
  preview.loads = [{ ...preview.loads[0]!, label: "preview_self", url: "https://acme-git-abc.vercel.app/", finalUrl: "https://acme-git-abc.vercel.app/" }]
  preview.ga4.events = []; preview.posthog.events = []; preview.meta.tr = []; preview.meta.configRequests = []; preview.infinite.events = []
  const t = world([realJob("preview_guard", target)], { host: { deployments: { forSha: ["ready"], latest: [{ sha: MERGE_SHA, createdAt: DEPLOY }] } }, bridge: { testPolls: [{ state: "done", progress: [], result: realVisitResult() }, { state: "done", progress: [], result: preview }] } })
  Object.assign(t.deps.host, { productionDeploymentUrl: async () => "https://acme-git-abc.vercel.app/" })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe("proven")
  expect(t.ctx.current().jobs[0]!.checks.find(check => check.id === "preview_self_silent")).toMatchObject({ tier: "RH", state: "pass", at: preview.startedAt })
})

it.each([1, 2])("request 3 P2-A: unconnected Meta sends %s PageViews per load", async count => {
  const visit = realVisitResult()
  if (count === 2) visit.meta.tr.push({ ...visit.meta.tr[0]! })
  const t = world([realJob("duplicates_remove", "meta")], { bridge: { keys: keysFixture({ meta: { status: "not_connected", pixels: [] } }), testPolls: [{ state: "done", progress: [], result: visit }] } })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe(count === 1 ? "proven" : "failed")
})

it.each(["wrong_run", "before_deploy"])("request 3 P3-PV: prove rejects a derived PV result with %s", async variant => {
  const t = world([realJob("ga4_improve", "spa_page_view")])
  t.deps.checks.gradeTestRunChecks = async () => [{ checkId: "ga4_seen_leaving", tier: "PV", state: "pass", runId: variant === "wrong_run" ? "other-run" : RUN_ID, at: variant === "before_deploy" ? "2026-10-02T09:01:00.000Z" : AT }]
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).not.toBe("proven")
  expect(t.ctx.current().jobs[0]!.checks.find(check => check.tier === "PV")!.state).toBe("not_run")
})

it("request 3 P3-app: the app's unfinished visit is pending, not permanently unchecked", async () => {
  const t = world([realJob("posthog_improve", "history_change")], { bridge: { claim: { code: "claimed_by_other", state: "proving" }, receipts: [receiptsAll({ posthog: lane("pending"), infinite: lane("pending") })] } })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.note).toContain("Waiting for the Infinite app's results")
  expect(t.ctx.current().jobs[0]!.note).not.toContain("Not checked after the deploy")
})


it.each([
  [null, false],
  ["2026-10-02T09:20:00.000Z", false],
  ["2026-10-02T08:00:00.000Z", false],
  [DEPLOY, true],
  ["2026-10-02T09:40:06.000Z", true]
] as const)("request 5: only timestamped post-deploy app receipts prove jobs (receiptAt=%s)", async (at, fresh) => {
  const t = world([realJob("posthog_improve", "history_change"), realJob("server_lane_mount", "x"), realJob("ga4_improve", "id")], { bridge: { claim: { code: "claimed_by_other", state: "proving" }, receipts: [receiptsAll({ posthog: lane("verified", at, "posthog_query"), server_lane: lane("verified", at) })] } })
  await step.run(t.ctx, t.deps)
  const [posthog, server, ga4] = t.ctx.current().jobs
  for (const item of [posthog!, server!]) {
    expect(item.state === "proven").toBe(fresh)
    const receipt = item.checks.find(check => check.tier === "PV")!
    expect(receipt.state).toBe(fresh ? "pass" : "undetermined")
    if (!fresh) {
      expect(receipt.reason).toBe("no receipt timestamp for this visit")
      expect(item.note).toContain("no receipt timestamp for this visit")
    }
  }
  expect(ga4!.note).toContain("Waiting for the Infinite app's results: GA4 sent data from the visit")
  expect(ga4!.note).toContain("Not checked after the deploy: GA4 ID matches your connection")
  expect(t.log.calls.filter(call => call.what === "startTest")).toHaveLength(0)
})

it("request 5: a stale visit's missing receipt cannot fail a newer deployment", async () => {
  const t = world([job("posthog_improve", "posthog_distinct_id_receipt")], { bridge: {
    testPolls: [{ state: "done", progress: [], result: realVisitResult({ startedAt: "2026-10-02T09:01:00.000Z", finishedAt: "2026-10-02T09:02:00.000Z" }) }],
    receipts: [receiptsAll({ posthog: lane("no_receipt") })]
  } })
  await step.run(t.ctx, t.deps)
  expect(t.ctx.current().jobs[0]!.state).toBe("done_in_code")
  expect(t.ctx.current().jobs[0]!.checks.find(check => check.tier === "PV")!.state).toBe("not_run")
})
