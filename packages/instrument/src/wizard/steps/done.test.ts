import { describe, expect, it } from "vitest"

import { MERGE_SHA, RUN_ID, fakeContext, fakeDeps, keysFixture, lane, realVisitResult, receiptsAll, runPublic } from "../../../test/wizard/runtime-fakes.js"
import type { ReportV2 } from "../contracts/report.js"
import { createRunState } from "../run-state.js"
import { buildColumn, renderMarkdown, renderTerminal, verdictLine } from "../report.js"
import { buildFinalComment, FINAL_COMMENT_MERGE_LINE, FINAL_COMMENT_UPDATED_LINE, withFinalReport } from "../../review/post.js"
import { PR_MARKERS } from "../contracts/git-host.js"
import { createScanner } from "../../review/scan.js"
import { NO_PRODUCTION_HOST_NOTE, REAL_VISIT_DISCLOSURE, WIZARD_REPORT_PATHS, repoLabelFromRemote, step } from "./done.js"
import { buildProvenColumn, provenColumnHasEvidence, provenPendingFor } from "./prove.js"

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
  it("PATCHes checkinOptIn first, posts the report once per column phase, then PATCHes `proven`, and says when the check-in is", async () => {
    const bundle = fakeDeps()
    const ctx = fakeContext(finishedState(), {}, bundle.clock)
    const outcome = await step.run(ctx, bundle.deps)
    expect(outcome).toEqual({ kind: "ok", status: "Report in Site Settings · 7-day check-in on 9 Oct" })
    const posts = bundle.log.calls.filter((call) => call.what === "postReport")
    expect(posts.map((call) => call.args[1])).toEqual(["live_today", "in_pr", "proven_live"])
    const report = posts[0]!.args[2] as ReportV2
    expect(report).toMatchObject({ schema: "infinite-tag.report.v2", runId: RUN_ID, site: { repoLabel: "github.com/Acme/acme-store", productionHost: "www.acme-store.com" } })
    expect(report.notes).toContain(REAL_VISIT_DISCLOSURE)
    const order = bundle.log.calls.filter((call) => call.what === "patchRun" || call.what === "postReport").map((call) => (call.what === "patchRun" ? call.args[1] : `post ${call.args[1] as string}`))
    expect(order).toEqual([{ checkinOptIn: true }, "post live_today", "post in_pr", "post proven_live", { phase: "proven" }])
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

  it("negative: a stored report echoed under another run is not accepted (PROOF_INCOMPLETE) and the run is never PATCHed as proven", async () => {
    const bundle = fakeDeps({ bridge: { reportEcho: () => ({ schema: "infinite-tag.report.v2", runId: "00000000-0000-4000-8000-000000000000" }) } })
    const outcome = await step.run(fakeContext(finishedState(), {}, bundle.clock), bundle.deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE" })
    expect(bundle.log.calls.filter((call) => call.what === "patchRun").map((call) => call.args[1])).toEqual([{ checkinOptIn: true }])
  })

  it("a failed PR comment (gh down) is reported, never fatal: the check-in and the report are already saved (O1-15)", async () => {
    const bundle = fakeDeps()
    bundle.deps.host.comment = async () => {
      throw new Error("gh: HTTP 502")
    }
    const ctx = fakeContext(finishedState(), {}, bundle.clock)
    const outcome = await step.run(ctx, bundle.deps)
    expect(outcome.kind).toBe("ok")
    expect(bundle.log.calls.find((call) => call.what === "patchRun")!.args[1]).toEqual({ checkinOptIn: true })
    const subs = ctx.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs.some((text) => text.startsWith("Could not comment the report on the PR (gh: HTTP 502)"))).toBe(true)
  })

  it("the proven column's 'keeps being checked' reads the run's check-in date (O1-16), and is pending, never a pass (R2-2)", async () => {
    const scheduled = fakeDeps()
    const ctx = fakeContext(finishedState(), {}, scheduled.clock)
    await step.run(ctx, scheduled.deps)
    const cell = ctx.current().report.proven_live!.finishLine.keeps_being_checked!
    // A scheduled check-in is not a measurement of the live site: it is pending until the check-in runs.
    expect(cell).toMatchObject({ state: "pending", display: "7-day check-in on 9 Oct", reason: "needs_7_days", provenance: { source: "cloud_read" } })
    const posted = scheduled.log.calls.find((call) => call.what === "postReport" && call.args[1] === "proven_live")!.args[2] as ReportV2
    expect(JSON.stringify(posted)).toContain("7-day check-in on 9 Oct")

    const unscheduled = fakeDeps({ bridge: { patchRun: () => runPublic({ checkinOptIn: true, checkinDueAt: null }) } })
    const later = fakeContext(finishedState(), {}, unscheduled.clock)
    await step.run(later, unscheduled.deps)
    expect(later.current().report.proven_live!.finishLine.keeps_being_checked!.state).toBe("pending")
  })

  it("an unproven run is never PATCHed as proven; with no proven column the report says the deploy is pending", async () => {
    const bundle = fakeDeps()
    const state = finishedState()
    state.report.proven_live = null
    await step.run(fakeContext(state, {}, bundle.clock), bundle.deps)
    expect(bundle.log.calls.filter((call) => call.what === "patchRun").map((call) => call.args[1])).toEqual([{ checkinOptIn: true }])
    const report = bundle.log.calls.find((call) => call.what === "postReport")!.args[2] as ReportV2
    expect(report.columns.proven_live.pending).toBe("deploy")
    expect(bundle.log.calls.filter((call) => call.what === "postReport").map((call) => call.args[1])).toEqual(["live_today", "in_pr"])
  })

  it("§3y.4 (P2-7): 'deploy' only while Infinite can observe the deploy; 'rerun_tag' when nothing can; 'open_infinite' for a deployed claim", () => {
    const base = { report: { live_today: null, in_pr: null, proven_live: null }, steps: {}, site: undefined }
    expect(provenPendingFor({ state: base, hostingVercel: true, noProve: false })).toBe("deploy")
    expect(provenPendingFor({ state: base, hostingVercel: false, noProve: false })).toBe("rerun_tag")
    expect(provenPendingFor({ state: base, hostingVercel: false, noProve: true })).toBe("rerun_tag")
    const claim = { productionHost: "fresh-acme.com", source: "answer" as const, decidedAt: "t", claim: { hosts: ["fresh-acme.com"], siteSourceKey: "site_x", collectPath: "/c", consentStorageKey: "k", proofPath: "/.well-known/infinite-site-verification.txt" as const, state: "pending_proof" as const } }
    expect(provenPendingFor({ state: { ...base, site: claim }, hostingVercel: false, noProve: false })).toBe("deploy")
    expect(provenPendingFor({ state: { ...base, site: claim, steps: { prove: { outcome: "parked", inputHash: "h", at: "t", code: "INF_WIZ_HOST_UNCONFIRMED" } } }, hostingVercel: false, noProve: false })).toBe("open_infinite")
  })

  it("the repo label is the normalised remote, never the raw one (no credentials)", () => {
    expect(repoLabelFromRemote("https://user:ghp_FAKE@github.com/Acme/acme-store.git?x=1#y", "/r")).toBe("github.com/Acme/acme-store")
    expect(repoLabelFromRemote("git@GitHub.com:acme/site.git", "/r")).toBe("github.com/acme/site")
    expect(repoLabelFromRemote(null, "/Users/me/acme")).toBe("acme")
  })

  it("a folder name holding `\\|` stays one table cell (backslash escaped before the pipe)", () => {
    expect(repoLabelFromRemote(null, String.raw`/Users/me/acme\|store`)).toBe(String.raw`acme\\\|store`)
    // negative: pipes alone leave `\\|`, an escaped backslash then a live pipe
    expect(repoLabelFromRemote(null, String.raw`/Users/me/acme\|store`)).not.toBe(String.raw`acme\\|store`)
  })
})

/** Live run 2's world: merged and deployed, but no production host, so no real visit and 0 receipts. */
function noVisitState(unmeasured?: Parameters<typeof buildProvenColumn>[0]["unmeasured"]) {
  const state = finishedState()
  const none = lane("undetermined")
  state.report.proven_live = buildProvenColumn({
    runId: RUN_ID,
    mergeSha: MERGE_SHA,
    at: AT,
    // The workspace never recorded consent: with a visit this would be a problem; without one it is unmeasured.
    keys: { ...keysFixture(), infinite: { ...keysFixture().infinite, consentMode: null } },
    expect: {},
    visit: null,
    receipts: receiptsAll({ infinite: none, posthog: none, ga4: none, meta_pixel: none, server_lane: lane("no_receipt"), meta_capi: none }),
    t1: [{ checkId: "csp_header", tier: "T1", state: "problem", at: AT, runId: RUN_ID }],
    serverLaneInstalled: false,
    conversionsWaiting: 0,
    ...(unmeasured ? { unmeasured } : {})
  })
  state.markers.prove = { infiniteEventIds: [], posthogDistinctId: null, probePath: null, metaEventIds: [] }
  return state
}

describe("R2-2 / R2-4 (live run 2): Proven live with no real visit and no receipt", () => {
  it("counts no pass and no problem: not the consent (check 9), not the check-in (check 14), not a T1 read", async () => {
    const bundle = fakeDeps()
    const ctx = fakeContext(noVisitState(), {}, bundle.clock)
    const outcome = await step.run(ctx, bundle.deps)
    expect(outcome.kind).toBe("ok")
    const column = ctx.current().report.proven_live!
    expect(provenColumnHasEvidence(column)).toBe(false)
    expect(column.meta.measuredAt).toBeNull()
    for (const [id, cell] of Object.entries(column.finishLine)) {
      expect(cell!.state, id).not.toBe("pass")
      expect(cell!.state, id).not.toBe("problem")
    }
    expect(column.finishLine.consent_recorded).toMatchObject({ value: null, state: "not_measured", reason: "not_exercised" })
    expect(column.finishLine.keeps_being_checked).toMatchObject({ state: "pending", display: "7-day check-in on 9 Oct" })
    expect(column.cells.consent_setting).toMatchObject({ value: null, state: "not_measured" })
    expect(column.cells.checks_passing!.display).toMatch(/^0 pass · 0 problems · /)

    const report = bundle.log.calls.find((call) => call.what === "postReport" && call.args[1] === "proven_live")!.args[2] as ReportV2
    // Nothing in Infinite can finish it (this run held the claim, no live address): rerun_tag, never "open Infinite".
    expect(report.columns.proven_live.pending).toBe("rerun_tag")
    const headline = verdictLine(report)
    expect(headline).toContain("not checked live yet")
    expect(headline).not.toMatch(/problems? left on the live site/)
    const terminal = renderTerminal(report, 120)
    const markdown = renderMarkdown(report)
    for (const text of [terminal, markdown]) {
      expect(text).not.toContain("open Infinite")
      expect(text).not.toMatch(/Proven live[^\n]*1 pass/)
    }
    // The "Proven live" cell of the consent row is "—" (no visit measured it), never "not recorded (problem)".
    const consentRow = markdown.split("\n").find((line) => line.startsWith("| Consent setting |"))!
    expect(consentRow.split("|").map((cell) => cell.trim()).at(-2)).toBe("—")
  })

  it("NEGATIVE: the same facts WITH a real visit still count consent as a problem (the rule is about measurement)", () => {
    const visited = buildProvenColumn({
      runId: RUN_ID,
      mergeSha: MERGE_SHA,
      at: AT,
      keys: { ...keysFixture(), infinite: { ...keysFixture().infinite, consentMode: null } },
      expect: { ga4: ["G-ACME000001"] },
      visit: { result: realVisitResult(), grades: { infinite: { checkId: "a", state: "pass", tier: "PV", at: AT, runId: RUN_ID }, ga4: { checkId: "b", state: "pass", tier: "PV", at: AT, runId: RUN_ID }, posthog: { checkId: "c", state: "pass", tier: "PV", at: AT, runId: RUN_ID }, meta: { checkId: "d", state: "pass", tier: "PV", at: AT, runId: RUN_ID } } },
      receipts: receiptsAll(),
      t1: [],
      serverLaneInstalled: false,
      conversionsWaiting: 0
    })
    expect(provenColumnHasEvidence(visited)).toBe(true)
    expect(visited.finishLine.consent_recorded!.state).toBe("problem")
    expect(visited.meta.measuredAt).toBe(AT)
  })

  it("'open Infinite' only while the app is proving this run (its unmeasured cells say so)", () => {
    const proving = noVisitState({ reason: "pending_open_infinite", state: "pending" })
    expect(provenPendingFor({ state: proving, hostingVercel: false, noProve: false, productionHost: "acme.com" })).toBe("open_infinite")
    expect(provenPendingFor({ state: noVisitState(), hostingVercel: true, noProve: false, productionHost: "acme.com" })).toBe("rerun_tag")
    // A proven column with evidence is the answer itself.
    expect(provenPendingFor({ state: finishedState(), hostingVercel: false, noProve: false, productionHost: "acme.com" })).toBeNull()
  })

  it("no production host: rerun_tag whatever else Infinite could observe, and the report says how to finish it", async () => {
    const base = { report: { live_today: null, in_pr: null, proven_live: null }, steps: {}, site: undefined }
    expect(provenPendingFor({ state: base, hostingVercel: true, noProve: false, productionHost: null })).toBe("rerun_tag")
    const state = noVisitState()
    state.site = { productionHost: null, source: "answer", decidedAt: AT }
    const bundle = fakeDeps({ bridge: { keys: { protocolVersion: 1, requestId: "req-fake", ...keysFixture(), infinite: { ...keysFixture().infinite, status: "not_provisioned", siteSourceKey: null, productionHosts: [] } } } as never })
    const ctx = fakeContext(state, {}, bundle.clock)
    await step.run(ctx, bundle.deps)
    const report = bundle.log.calls.find((call) => call.what === "postReport" && call.args[1] === "proven_live")!.args[2] as ReportV2
    expect(report.notes).toContain(NO_PRODUCTION_HOST_NOTE)
  })
})

describe("R2-5 (live run 2): the PR's 'what happened' comment carries the final report", () => {
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const merged = (reportMarkdown: string) =>
    buildFinalComment({ runId: RUN_ID, reportMarkdown, reviewer: "codex", reviewed: false, completeness: { state: "blind", unchecked: [] } as never, jobs: [], decisions: [], untrusted: [], notes: ["Required checks: 1 pass · 0 fail · 0 pending."], scanner })

  it("withFinalReport swaps only the report table; the review sentence, notes and marker stay", () => {
    const before = merged("### Before and after · x\n\n| | Live site today | In this pull request | Proven live |\n|---|---|---|---|\n| Checks passing | a | b | — |")
    const after = withFinalReport(before, "### Before and after · x\n\n| | Live site today | In this pull request | Proven live |\n|---|---|---|---|\n| Checks passing | a | b | 3 pass · 0 problems of 14 |")!
    expect(after).toContain("3 pass · 0 problems of 14")
    expect(after).not.toContain("| b | — |")
    expect(after).toContain("No second review (Codex could not read the files).")
    expect(after).toContain("> Required checks: 1 pass · 0 fail · 0 pending.")
    expect(after).toContain(PR_MARKERS.final(RUN_ID))
    expect(after).toContain(FINAL_COMMENT_UPDATED_LINE)
    expect(after).not.toContain(FINAL_COMMENT_MERGE_LINE)
    // NEGATIVE: a body with no report table is never guessed at.
    expect(withFinalReport("**infinite-tag: what happened**\n\nno table", "### Before and after · x")).toBeNull()
  })

  it("done edits the wizard's own 'what happened' comment instead of posting a second report", async () => {
    const bundle = fakeDeps()
    let stored = merged("### Before and after · x\n\n| | a | b | c |\n|---|---|---|---|\n| Checks passing | 1 | 2 | — |")
    const edits: string[] = []
    Object.assign(bundle.deps.host, {
      async updateOwnComment(number: number, marker: string, edit: (body: string) => string) {
        expect(number).toBe(42)
        if (!stored.includes(marker)) return false
        stored = edit(stored)
        edits.push(stored)
        return true
      }
    })
    const ctx = fakeContext(finishedState(), {}, bundle.clock)
    await step.run(ctx, bundle.deps)
    expect(edits).toHaveLength(1)
    expect(stored).toContain("No second review (Codex could not read the files).")
    expect(stored).not.toContain("| Checks passing | 1 | 2 | — |")
    expect(stored).toMatch(/Proven live/)
    expect(bundle.log.calls.filter((call) => call.what === "comment")).toHaveLength(0)
    const subs = ctx.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs).toContain('✓ Updated the pull request\'s "what happened" comment with this report')
  })

  it("NEGATIVE: with no 'what happened' comment of its own, done posts the report as before", async () => {
    const bundle = fakeDeps()
    Object.assign(bundle.deps.host, { updateOwnComment: async () => false })
    await step.run(fakeContext(finishedState(), {}, bundle.clock), bundle.deps)
    const comments = bundle.log.calls.filter((call) => call.what === "comment")
    expect(comments).toHaveLength(1)
    expect(String(comments[0]!.args[1])).toContain(PR_MARKERS.report(RUN_ID))
  })
})
