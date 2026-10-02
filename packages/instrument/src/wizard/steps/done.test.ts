import { describe, expect, it } from "vitest"

import { MERGE_SHA, RUN_ID, fakeContext, fakeDeps, keysFixture, realVisitResult, receiptsAll } from "../../../test/wizard/runtime-fakes.js"
import type { ReportV2 } from "../contracts/report.js"
import { createRunState } from "../run-state.js"
import { buildColumn } from "../report.js"
import { REAL_VISIT_DISCLOSURE, WIZARD_REPORT_PATHS, repoLabelFromRemote, step } from "./done.js"
import { buildProvenColumn } from "./prove.js"

const AT = "2026-10-02T09:13:00.000Z"

function finishedState() {
  const state = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "r-7f3c" })
  state.runId = RUN_ID
  state.pr = { host: "github", number: 42, url: "https://github.com/acme/acme-store/pull/42", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: MERGE_SHA }
  state.report.live_today = buildColumn("live_today", {
    runId: RUN_ID,
    meta: { measuredAt: AT, sha: null },
    facts: [{ input: "dry_live.graded", state: "problem", display: "GA4 twice", at: AT }],
    rows: { ga4_page_views_per_visit: { value: 2, display: "2 (counts every visit twice)", state: "problem", source: "desktop_test", at: AT } }
  })
  state.report.in_pr = buildColumn("in_pr", {
    runId: RUN_ID,
    meta: { measuredAt: AT, sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" },
    facts: [{ input: "rehearsal.graded", state: "pass", at: AT }],
    rows: {}
  })
  const pass = (id: string) => ({ checkId: id, state: "pass" as const, tier: "PV" as const, at: AT, runId: RUN_ID })
  state.report.proven_live = buildProvenColumn({
    runId: RUN_ID,
    mergeSha: MERGE_SHA,
    at: AT,
    keys: keysFixture(),
    expect: { ga4: ["G-ACME000001"], posthog: { projectKey: "phc", apiHost: "https://us.i.posthog.com" }, meta: ["1234567890123456"], infinite: { siteSourceKey: "s", collectPath: "/c" } },
    visit: { result: realVisitResult(), grades: { infinite: pass("a"), ga4: pass("b"), posthog: pass("c"), meta: pass("d") } },
    receipts: receiptsAll(),
    t1: [],
    serverLaneInstalled: true,
    conversionsWaiting: 0
  })
  state.markers.prove = { infiniteEventIds: ["evt_FAKE0301"], posthogDistinctId: "d", probePath: "/__infinite_probe/7f3c2a91b0de", metaEventIds: [] }
  return state
}

describe("done", () => {
  it("posts the report once per column phase, then PATCHes checkinOptIn (and `proven`), and says when the check-in is", async () => {
    const bundle = fakeDeps()
    const ctx = fakeContext(finishedState(), {}, bundle.clock)
    const outcome = await step.run(ctx, bundle.deps)
    expect(outcome).toEqual({ kind: "ok", status: "Report in Site Settings · 7-day check-in on 9 Oct" })
    const posts = bundle.log.calls.filter((call) => call.what === "postReport")
    expect(posts.map((call) => call.args[1])).toEqual(["live_today", "in_pr", "proven_live"])
    const report = posts[0]!.args[2] as ReportV2
    expect(report).toMatchObject({ schema: "infinite-tag.report.v2", runId: RUN_ID, site: { repoLabel: "github.com/Acme/acme-store", productionHost: "www.acme-store.com" } })
    expect(report.notes).toContain(REAL_VISIT_DISCLOSURE)
    const names = bundle.log.names("bridge")
    expect(names.indexOf("bridge.patchRun")).toBeGreaterThan(names.lastIndexOf("bridge.postReport"))
    expect(bundle.log.calls.find((call) => call.what === "patchRun")!.args[1]).toEqual({ checkinOptIn: true, phase: "proven" })
    expect(ctx.events.filter((event) => event.type === "report")).toHaveLength(3)
  })

  it("comments the same report on the PR (plain text, no checkbox) and writes it under .infinite/wizard/", async () => {
    const bundle = fakeDeps()
    await step.run(fakeContext(finishedState(), {}, bundle.clock), bundle.deps)
    const comment = bundle.log.calls.find((call) => call.who === "host" && call.what === "comment")!
    expect(comment.args[0]).toBe(42)
    expect(comment.args[1]).toContain("| | Live site today | In this pull request | Proven live |")
    expect(comment.args[1]).not.toContain("- [ ]")
    const files = (bundle.deps.fs as unknown as { files: Map<string, string> }).files
    expect(JSON.parse(files.get(`/repo/${WIZARD_REPORT_PATHS.json}`)!).runId).toBe(RUN_ID)
    expect(files.get(`/repo/${WIZARD_REPORT_PATHS.markdown}`)).toContain("Before and after")
  })

  it("negative: a stored report echoed under another run is not accepted (PROOF_INCOMPLETE) and the run is not PATCHed", async () => {
    const bundle = fakeDeps({ bridge: { reportEcho: () => ({ schema: "infinite-tag.report.v2", runId: "00000000-0000-4000-8000-000000000000" }) } })
    const outcome = await step.run(fakeContext(finishedState(), {}, bundle.clock), bundle.deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE" })
    expect(bundle.log.names("bridge")).not.toContain("bridge.patchRun")
  })

  it("an unproven run is never PATCHed as proven; with no proven column the report says the deploy is pending", async () => {
    const bundle = fakeDeps()
    const state = finishedState()
    state.report.proven_live = null
    await step.run(fakeContext(state, {}, bundle.clock), bundle.deps)
    expect(bundle.log.calls.find((call) => call.what === "patchRun")!.args[1]).toEqual({ checkinOptIn: true })
    const report = bundle.log.calls.find((call) => call.what === "postReport")!.args[2] as ReportV2
    expect(report.columns.proven_live.pending).toBe("deploy")
    expect(bundle.log.calls.filter((call) => call.what === "postReport").map((call) => call.args[1])).toEqual(["live_today", "in_pr"])
  })

  it("the repo label is the normalised remote, never the raw one (no credentials)", () => {
    expect(repoLabelFromRemote("https://user:ghp_FAKE@github.com/Acme/acme-store.git?x=1#y", "/r")).toBe("github.com/Acme/acme-store")
    expect(repoLabelFromRemote("git@GitHub.com:acme/site.git", "/r")).toBe("github.com/acme/site")
    expect(repoLabelFromRemote(null, "/Users/me/acme")).toBe("acme")
  })
})
