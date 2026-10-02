// Final verify F12: the report's "In this pull request" column says what the wizard's own pre-merge evidence
// shows (it was "—" for 6 of 9 rows, "Checks passing" among them). Each test builds the column the way the
// `rehearsal` step does and reads the report a reviewer sees; none of it comes from an agent's claim.
import { describe, expect, it } from "vitest"

import { fakeKeys, initialState, RUN_ID, testContext } from "../../test/wizard/o4-fakes.js"
import type { ChecklistItem, CheckResult } from "../wizard/contracts/jobs.js"
import { REPORT_ROWS, type ReportV2 } from "../wizard/contracts/report.js"
import type { TestTool } from "../wizard/contracts/test-engine.js"
import { buildReport, renderMarkdown, renderTerminal } from "../wizard/report.js"
import { preMergeCells } from "./in-pr-cells.js"
import { recordGa4KeyEventCells, recordRehearsalCells, type RehearsalOutcome } from "./rehearse.js"

const HEAD = "a".repeat(40)
const AT = "2026-10-02T10:00:00.000Z"

const grade = (tool: TestTool, state: CheckResult["state"], reason?: string): CheckResult => ({
  checkId: tool === "ga4" ? "ga4_one_page_view" : "one_beacon_per_tool",
  tier: "RH",
  state,
  ...(reason ? { reason } : {}),
  at: AT,
  runId: RUN_ID
})

function outcome(change: Partial<RehearsalOutcome> = {}): RehearsalOutcome {
  return {
    state: "graded",
    reason: null,
    previewUrl: "https://acme-store-git-x.vercel.app",
    grades: { infinite: grade("infinite", "pass"), ga4: grade("ga4", "pass"), posthog: grade("posthog", "pass"), meta: grade("meta", "pass") },
    previewGrades: { ga4: grade("ga4", "pass"), posthog: grade("posthog", "pass"), meta: grade("meta", "pass") },
    clickTested: ["sign_up"],
    ga4ClickTested: ["sign_up"],
    facts: { posthogSameOrigin: true, cspViolations: 0, ga4PageViewsPerLoad: 1 },
    expectedTools: ["infinite", "ga4", "posthog", "meta"],
    installedTools: ["infinite", "ga4", "posthog", "meta"],
    spaExercised: true,
    ...change
  }
}

const job = (jobId: ChecklistItem["jobId"], target: string, checks: ChecklistItem["checks"], state: ChecklistItem["state"] = "done_in_code"): ChecklistItem => ({
  id: `${jobId}:${target}`,
  jobId,
  n: 0,
  title: jobId,
  owner: "agent",
  trigger: { finding: "", evidence: [] },
  allow: { files: [], create: [] },
  checks,
  state
})

const passed = (id: string, tier: "S" | "T0" | "B" = "S", runId: string = RUN_ID): ChecklistItem["checks"][number] => ({ id: id as never, tier, state: "pass", at: AT, runId })

/** The jobs the wizard checked in code this run: two server conversions, identify/reset, the preview guard. */
const CHECKED_JOBS: ChecklistItem[] = [
  job("server_conversions", "sign_up", [passed("outcome_after_success"), passed("outcome_declared"), passed("event_id_stable"), passed("no_pii_in_outcome"), passed("build", "B")]),
  job("server_conversions", "purchase", [passed("outcome_after_success"), passed("outcome_declared"), passed("event_id_stable"), passed("no_pii_in_outcome"), passed("build", "B")]),
  job("identify_reset", "auth", [passed("identify_on_auth_success"), passed("reset_on_every_signout"), passed("build", "B")]),
  job("preview_guard", "ga4", [passed("adopted_init_guarded"), passed("host_matrix", "T0")])
]

const PLAN = { hash: "sha256:plan", answers: { consentMode: "not_required" as const, conversions: ["sign_up", "purchase"], privacyApproved: true, npmInstall: true, metaGoal: null }, lines: [{ id: "checkin", approved: null }] }

function column(options: { jobs?: ChecklistItem[]; plan?: typeof PLAN | null; outcome?: RehearsalOutcome; keys?: ReturnType<typeof fakeKeys> | null; marked?: number } = {}) {
  const ctx = testContext({ root: "/repo", state: initialState({ jobs: options.jobs ?? CHECKED_JOBS, plan: options.plan === undefined ? PLAN : options.plan }) })
  recordRehearsalCells(ctx, options.outcome ?? outcome(), { head: HEAD, runId: RUN_ID, keys: options.keys === undefined ? fakeKeys() : options.keys })
  if (options.marked !== undefined) recordGa4KeyEventCells(ctx, options.marked, RUN_ID, "all")
  return ctx
}

function report(ctx: ReturnType<typeof column>): ReportV2 {
  return buildReport(
    { runId: RUN_ID, tagVersion: "0.12.0", site: { repoLabel: "github.com/acme/acme-store", productionHost: "acme-store.com" }, columns: ctx.state.get().report, provenLivePending: "deploy", day7: null, notes: [] },
    () => new Date(AT)
  )
}

const inPr = (built: ReportV2) => Object.fromEntries(built.rows.map((row) => [row.id, row.cells.in_pr])) as Record<(typeof REPORT_ROWS)[number]["id"], ReportV2["rows"][number]["cells"]["in_pr"]>

describe("F12: the 'In this pull request' column is filled from the wizard's own pre-merge evidence", () => {
  it("every row with evidence has a value: 9 of 9 rows, each with a source the report allows (it was 3 of 9)", () => {
    const built = report(column({ marked: 1 }))
    const cells = inPr(built)
    expect(cells.checks_passing).toMatchObject({ state: "pass", display: "11 pass · 0 problems · 3 not testable of 14", value: "11/11", provenance: { source: "wizard_check" } })
    expect(cells.ga4_page_views_per_visit).toMatchObject({ state: "pass", display: "1", provenance: { source: "desktop_test" } })
    expect(cells.posthog_route).toMatchObject({ state: "pass", display: "through /ingest", provenance: { source: "desktop_test" } })
    expect(cells.meta_pixel).toMatchObject({ state: "pass", display: "fires once, right ID (nothing sent)", provenance: { source: "desktop_test" } })
    expect(cells.preview_share).toMatchObject({ state: "pass", display: "guard added · the preview link sent nothing", provenance: { source: "desktop_test" } })
    expect(cells.server_conversions).toMatchObject({ state: "pass", display: "2 wired (sign_up, purchase)", value: 2, provenance: { source: "wizard_check" } })
    expect(cells.ga4_key_events).toMatchObject({ state: "info", display: "1 marked as key event (click test passed)", provenance: { source: "cloud_read" } })
    expect(cells.consent_setting).toMatchObject({ state: "pass", display: '"collect by default" recorded', provenance: { source: "cloud_read" } })
    expect(cells.live_test_per_tool).toMatchObject({ state: "pass", display: "rehearsal: 4 of 4 tools fire once, right ID (nothing sent)", provenance: { source: "desktop_test" } })
    const filled = REPORT_ROWS.filter((row) => row.id !== "day7_checkin" && cells[row.id].value !== null)
    expect(filled).toHaveLength(9)
    // Every cell is this run's, and the terminal and the pull request comment show the same words.
    for (const row of filled) expect(cells[row.id].provenance.runId).toBe(RUN_ID)
    const terminal = renderTerminal(built, 100)
    expect(terminal).toMatch(/In this pull request:\s+11 pass · 0 problems · 3 not testable of 14/)
    expect(renderMarkdown(built)).toContain("| Conversions sent from the server | — | 2 wired (sign_up, purchase) |")
  })

  it("'Checks passing' is counted over all 14: the two it cannot test before the merge are named, never counted as passing", () => {
    const built = report(column({ marked: 1 }))
    const states = Object.fromEntries(built.finishLine.map((line) => [line.id, line.cells.in_pr.state]))
    expect(states).toMatchObject({
      conversions_server_side: "pass",
      identity_joined: "pass",
      consent_recorded: "pass",
      keeps_being_checked: "pass",
      ga4_key_events_received: "info",
      proof_from_real_visit: "not_measured",
      // No pre-merge evidence for the redirect walk (it runs on the live site): "—", and it leaves the count.
      utms_survive_redirects: "not_measured"
    })
    expect(built.finishLine.filter((line) => line.cells.in_pr.state === "pass")).toHaveLength(11)
    expect(inPr(built).checks_passing.display).toBe("11 pass · 0 problems · 3 not testable of 14")
  })

  it("negative: a job the wizard did not check is never 'wired' (a claim, another run's check, or a failing check)", () => {
    const claimedOnly = [job("server_conversions", "sign_up", [{ id: "outcome_after_success", tier: "S", state: "not_run" }], "claimed")]
    expect(inPr(report(column({ jobs: claimedOnly }))).server_conversions).toMatchObject({ value: null, display: "—", state: "undetermined", reason: "not_exercised" })
    const otherRun = [job("server_conversions", "sign_up", [passed("outcome_after_success", "S", "another-run")])]
    expect(inPr(report(column({ jobs: otherRun }))).server_conversions).toMatchObject({ value: null, display: "—" })
    const failing = [
      job("server_conversions", "sign_up", [passed("outcome_after_success"), { id: "no_pii_in_outcome", tier: "S", state: "problem", at: AT, runId: RUN_ID }]),
      job("server_conversions", "purchase", [passed("outcome_after_success")])
    ]
    const built = report(column({ jobs: failing }))
    expect(inPr(built).server_conversions).toMatchObject({ state: "problem", display: "1 of 2 wired in code" })
    expect(built.finishLine.find((line) => line.id === "conversions_server_side")!.cells.in_pr.state).toBe("problem")
    expect(inPr(built).checks_passing).toMatchObject({ state: "problem" })
    expect(inPr(built).checks_passing.display).toMatch(/^\d+ pass · 1 problem · /)
  })

  it("negative: a row with no pre-merge evidence stays '—' with its reason, never 0 and never a guess", () => {
    const built = report(column({ jobs: [], plan: null, keys: null }))
    const cells = inPr(built)
    for (const id of ["server_conversions", "ga4_key_events", "consent_setting"] as const) {
      expect(cells[id], id).toMatchObject({ value: null, display: "—", state: "not_measured", reason: "not_exercised" })
    }
    // The preview's own URL was still loaded, so that row says what the load showed, without "guard added".
    expect(cells.preview_share).toMatchObject({ state: "pass", display: "the preview link sent nothing" })
    expect(renderTerminal(built, 100)).toContain("— / pending: this run did not exercise it")
  })

  it("the consent setting says 'recorded' only when Infinite holds the plan's choice", () => {
    expect(preMergeCells({ jobs: [], plan: PLAN }, { at: AT, runId: RUN_ID, keys: fakeKeys() }).cells.consent_setting).toMatchObject({ state: "pass", display: '"collect by default" recorded', provenance: { source: "cloud_read" } })
    const unread = preMergeCells({ jobs: [], plan: PLAN }, { at: AT, runId: RUN_ID, keys: null })
    expect(unread.cells.consent_setting).toMatchObject({ state: "info", display: '"collect by default" chosen in the plan (not read back from Infinite)', provenance: { source: "plan_answer" } })
    expect(unread.finishLine.consent_recorded!.state).toBe("info")
    const keys = fakeKeys()
    const other = preMergeCells({ jobs: [], plan: PLAN }, { at: AT, runId: RUN_ID, keys: { ...keys, infinite: { ...keys.infinite, consentMode: "required" } } })
    expect(other.cells.consent_setting).toMatchObject({ state: "problem", display: 'the plan chose "collect by default"; Infinite has "ask first (consent required)"' })
  })

  it("the rehearsal's own numbers decide the tool rows: a duplicate GA4 tag reads '2', a direct PostHog is a problem", () => {
    const built = report(
      column({
        outcome: outcome({
          grades: { ga4: grade("ga4", "problem", "duplicate_page_view — 2 page views on one load"), posthog: grade("posthog", "pass"), meta: grade("meta", "undetermined", "held_by_consent") },
          facts: { posthogSameOrigin: false, cspViolations: 0, ga4PageViewsPerLoad: 2 },
          expectedTools: ["ga4", "posthog", "meta"],
          installedTools: ["ga4", "posthog", "meta"]
        })
      })
    )
    const cells = inPr(built)
    expect(cells.ga4_page_views_per_visit).toMatchObject({ state: "problem", display: "2" })
    expect(cells.posthog_route).toMatchObject({ state: "problem", display: "direct to PostHog (ad blockers drop it)" })
    expect(cells.meta_pixel).toMatchObject({ value: null, display: "—", state: "undetermined", reason: "held_by_consent" })
    expect(cells.live_test_per_tool).toMatchObject({ state: "problem", display: "rehearsal: 1 of 3 tools fire once, right ID (nothing sent)" })
  })

  it("an undetermined rehearsal leaves the tested rows '—' with why; the code and plan rows are still filled", () => {
    const built = report(column({ outcome: outcome({ state: "undetermined", reason: "preview_protected", grades: {}, previewGrades: {}, facts: { posthogSameOrigin: null, cspViolations: null } }) }))
    const cells = inPr(built)
    for (const id of ["ga4_page_views_per_visit", "posthog_route", "meta_pixel", "live_test_per_tool"] as const) expect(cells[id].value, id).toBeNull()
    expect(cells.preview_share).toMatchObject({ state: "info", display: "guard added (the preview link was not loaded)", provenance: { source: "wizard_check" } })
    expect(cells.server_conversions.display).toBe("2 wired (sign_up, purchase)")
    expect(cells.checks_passing).toMatchObject({ state: "undetermined", display: "4 pass · 0 problems · 7 unknown · 3 not testable of 14" })
  })

  it("a new head rebuilds the column: checks measured on the old head are gone, Infinite's answers stay", () => {
    const ctx = column({ marked: 1 })
    ctx.state.update((state) => {
      state.jobs = []
    })
    recordRehearsalCells(ctx, outcome(), { head: "b".repeat(40), runId: RUN_ID, keys: fakeKeys() })
    const cells = inPr(report(ctx))
    expect(ctx.state.get().report.in_pr!.meta.sha).toBe("b".repeat(40))
    expect(cells.server_conversions).toMatchObject({ value: null, display: "—" })
    expect(cells.preview_share.display).toBe("the preview link sent nothing")
    expect(cells.ga4_key_events.display).toBe("1 marked as key event (click test passed)")
    // The review step marks only the names a new rehearsal proved: its count adds; a re-run of the rehearsal step does not.
    recordGa4KeyEventCells(ctx, 2, RUN_ID, "new_names")
    expect(inPr(report(ctx)).ga4_key_events.display).toBe("3 marked as key events (click test passed)")
    recordGa4KeyEventCells(ctx, 3, RUN_ID, "all")
    expect(inPr(report(ctx)).ga4_key_events.display).toBe("3 marked as key events (click test passed)")
  })
})
