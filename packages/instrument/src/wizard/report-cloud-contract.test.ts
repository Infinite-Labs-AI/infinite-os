// Final verify F17: the tag's report must pass the CLOUD's report parser, not only the tag's own builder.
//
// Until round 3 each side was tested only against its own fake: the tag put the base commit in
// `columns.live_today.sha`, the fake bridge answered 201, and the real cloud refused every report (step 12
// failed, no table). `test/wizard/cloud-rules.ts` ports the cloud's parser; this file holds it to the contract
// example (so the port is not vacuous), checks that every rule it refuses the tag refuses first, and posts every
// report the `done` step can build for the three phases through it.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { parseCloudReport, type CloudReportContext } from "../../test/wizard/cloud-rules.js"
import { census, fixtureBaseline, fixtureDryLive, fixtureKeys } from "../../test/wizard/o8/fixtures.js"
import { MERGE_SHA, RUN_ID, fakeContext, fakeDeps, keysFixture, lane, realVisitResult, receiptsAll } from "../../test/wizard/runtime-fakes.js"
import { liveTodayColumnInput, type LiveTodaySource } from "./before-column.js"
import type { CheckResult, ChecklistItem } from "./contracts/jobs.js"
import { REPORT_COLUMN_IDS, type ReportColumnId, type ReportColumnSnapshot, type ReportV2 } from "./contracts/report.js"
import type { WizardRunState } from "./contracts/state.js"
import { testExpectFromKeys, type TestTool } from "./contracts/test-engine.js"
import { assertReport, buildColumn, buildReport, renderMarkdown, renderTerminal } from "./report.js"
import { createRunState } from "./run-state.js"
import { buildLiveTodayColumn } from "./steps/before.js"
import { step as doneStep } from "./steps/done.js"
import { buildProvenColumn } from "./steps/prove.js"

const here = dirname(fileURLToPath(import.meta.url))
const contracts = join(here, "../../contracts/tag-wizard-v1")
const example = JSON.parse(readFileSync(join(contracts, "report-v2.example.json"), "utf8")) as ReportV2
const runStateExample = JSON.parse(readFileSync(join(contracts, "run-state.example.json"), "utf8")) as WizardRunState

/** The run's start on the cloud's clock (the fake bridge's `runs.start` answers the same instant). */
const STARTED_AT = "2026-10-02T09:02:00.000Z"
const AT = "2026-10-02T09:12:00.000Z"
const BASE_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d"
const tagPost = (phase: CloudReportContext["phase"]): CloudReportContext => ({ runId: example.runId, startedAt: STARTED_AT, phase, producer: "tag", partial: false })

describe("the cloud's report rules (test/wizard/cloud-rules.ts, a port of 1bu-1 parseReportV2)", () => {
  it("keeps long owner guards and wiring out of bounded cloud notes while rendering their exact copyable bytes", () => {
    const guard = `if (${Array.from({ length: 18 }, (_, i) => `location.hostname !== 'preview-${i}.example.test'`).join(" && ")}) {\n  // Existing analytics start-up statements go here.\n}`
    const wiring = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"\n\n<InfiniteAnalyticsClient />'
    const jobs: ChecklistItem[] = ["ga4", "meta", "posthog"].map(tool => ({ id: `preview_guard:${tool}`, jobId: "preview_guard", n: 7, title: `Guard ${tool}`, owner: "agent", state: "left_for_you", checks: [], allow: { files: [], create: [] }, note: `For you: add the preview guard to ${tool}'s start-up at src/tracking.ts:5; until then preview and local visits count in ${tool}.`, ownerBoundary: { kind: "frozen_unit", file: "src/tracking.ts", line: 5, guard }, trigger: { finding: `For you: ${tool}\n\n\`\`\`js\n${guard}\n\`\`\``, evidence: [] } }))
    jobs.push({ ...jobs[0]!, id: "unusual_layout:app/layout.tsx", jobId: "unusual_layout", owner: "code", title: "Owner wiring", ownerBoundary: { kind: "frozen_unit", file: "app/layout.tsx", line: 1, wiring }, trigger: { finding: `For you: owner wiring\n\n\`\`\`js\n${wiring}\n\`\`\``, evidence: [] } })
    const report = buildReport({ runId: example.runId, tagVersion: "0.0.0", site: example.site, columns: { live_today: null, in_pr: structuredClone(runStateExample.report.in_pr), proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs, openFindings: [], tools: null, installedUnknown: null, ownerPolicyFindings: Array.from({ length: 30 }, (_, i) => `Owner-only finding ${i}: ${"Owner controls this setting. ".repeat(20)}`) } })
    expect(parseCloudReport(report, tagPost("in_pr"))).toEqual({ ok: true })
    expect(report.notes.every(note => note.length > 0 && note.length <= 300 && !note.includes("```"))).toBe(true)
    expect(report.notes).toHaveLength(20)
    expect(report.notes.some(note => note.startsWith("NOT DONE for "))).toBe(true)
    expect(report.notes.some(note => note.includes("additional notes are omitted"))).toBe(true)
    expect(JSON.stringify(report)).not.toContain("preview-17.example.test")
    for (const rendered of [renderMarkdown(report, undefined, jobs)]) {
      expect(rendered).toContain(guard)
      expect(rendered).toContain(wiring)
      expect(rendered).toContain("src/tracking.ts:5")
    }
    const terminal = renderTerminal(report, 80, { ownerJobs: jobs })
    expect(terminal).toContain("Full text in the pull request and .infinite/wizard/report.md")
    expect(terminal).not.toContain(guard)
  })
  it("accepts the contract example under each column phase (the port is not vacuous)", () => {
    for (const phase of REPORT_COLUMN_IDS) expect(parseCloudReport(example, tagPost(phase))).toEqual({ ok: true })
  })

  // Each mutation is one rule the cloud refuses at the door. The tag must refuse it FIRST (assertReport), so a
  // report is never built only to be refused at step 12.
  const firstRow = (report: ReportV2) => report.rows.find((row) => row.id === "ga4_page_views_per_visit")!.cells.in_pr
  const MUTATIONS: Array<[string, (report: ReportV2) => void, string]> = [
    ["F17: the live_today column carries the base commit", (r) => void (r.columns.live_today.sha = BASE_SHA), "report.columns.live_today.sha"],
    ["the PR head is a short SHA", (r) => void (r.columns.in_pr.sha = "1a2b3c4"), "report.columns.in_pr.sha"],
    ["a cell computed from agent output", (r) => void ((firstRow(r).provenance as { source: string }).source = "agent"), "report.rows[1].cells.in_pr.provenance.source"],
    [
      '"verified" without a receipt',
      (r) => {
        const cell = firstRow(r)
        cell.display = "verified"
        delete cell.provenance.receiptAt
      },
      "report.rows[1].cells.in_pr.display"
    ],
    [
      "a percentage with no raw counts",
      (r) => {
        const cell = firstRow(r)
        cell.display = "12%"
        delete cell.raw
      },
      "report.rows[1].cells.in_pr.raw"
    ],
    ["an arrow across columns", (r) => void (firstRow(r).display = "2 -> 1"), "report.rows[1].cells.in_pr.display"],
    [
      "a 0 where nothing was measured",
      (r) => {
        const cell = firstRow(r)
        cell.value = 0
        cell.display = "0"
        cell.state = "not_measured"
      },
      "report.rows[1].cells.in_pr.value"
    ],
    [
      "a finish-line cell §3i.7 marks '—' given a value",
      (r) => {
        const cell = r.finishLine.find((line) => line.id === "proof_from_real_visit")!.cells.live_today
        Object.assign(cell, { value: "pass", display: "pass", state: "pass" })
        delete cell.reason
      },
      "report.finishLine[12].cells.live_today"
    ],
    ["an unknown report key", (r) => void ((r as unknown as Record<string, unknown>).extra = 1), "report.extra"]
  ]
  for (const [name, mutate, field] of MUTATIONS) {
    it(`refuses ${name} (field ${field}), and the tag's own rules refuse it first`, () => {
      const report = structuredClone(example)
      mutate(report)
      expect(parseCloudReport(report, tagPost("in_pr"))).toMatchObject({ ok: false, field })
      expect(() => assertReport(report, STARTED_AT)).toThrow()
    })
  }

  it("refuses the request pairings the route refuses: producer cloud, a partial tag report, another run's report", () => {
    expect(parseCloudReport(example, { ...tagPost("day7"), producer: "cloud" })).toMatchObject({ ok: false, field: "producer" })
    expect(parseCloudReport(example, { ...tagPost("in_pr"), partial: true })).toMatchObject({ ok: false, field: "partial" })
    expect(parseCloudReport(example, { ...tagPost("day7") })).toMatchObject({ ok: false, field: "producer" })
    expect(parseCloudReport(example, { ...tagPost("in_pr"), runId: "11111111-2222-4333-8444-555555555555" })).toMatchObject({ ok: false, field: "report.runId" })
    // rule 3: a receipt from before the run started is not this run's proof.
    expect(parseCloudReport(example, { ...tagPost("proven_live"), startedAt: "2026-10-02T09:50:00.000Z" })).toMatchObject({ ok: false, field: expect.stringMatching(/receiptAt$/) })
  })
})

// ---------------------------------------------------------------------------------------------
// Every report the wizard can build, for the three phases, through the cloud's parser
// ---------------------------------------------------------------------------------------------

const grade = (tool: TestTool, state: CheckResult["state"], reason?: string): CheckResult => ({ checkId: `dry_live_${tool}`, tier: "T1", state, at: AT, runId: RUN_ID, ...(reason ? { reason } : {}) })

function liveSource(overrides: Partial<LiveTodaySource> = {}): LiveTodaySource {
  const keys = fixtureKeys()
  return {
    runId: RUN_ID,
    measuredAt: AT,
    keys,
    expect: testExpectFromKeys(keys),
    census: census([{ tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 2 }]),
    dryLive: fixtureDryLive(),
    grades: { infinite: grade("infinite", "pass"), ga4: grade("ga4", "pass"), posthog: grade("posthog", "undetermined", "held_by_consent"), meta: grade("meta", "problem", "traffic_permissions_blocked") },
    liveChecks: [
      { checkId: "live_bytes", tier: "T1", state: "pass", at: AT, runId: RUN_ID },
      { checkId: "redirect_walk", tier: "T1", state: "problem", at: AT, runId: RUN_ID },
      { checkId: "csp_header", tier: "T1", state: "pass", at: AT, runId: RUN_ID }
    ],
    baseline: fixtureBaseline(),
    repeatedInits: [{ tool: "ga4", id: "G-FAKE00001", count: 2 }],
    loginFound: true,
    spaNavigationRequested: true,
    ...overrides
  }
}

/** The live_today column as `before` builds it, from several honest and dishonest live sites. */
const LIVE_TODAY: Record<string, () => ReportColumnSnapshot> = {
  "a live site with problems": () => buildLiveTodayColumn(liveColumnInput()),
  "no baseline (Infinite could not read GA4/PostHog)": () => buildLiveTodayColumn(liveColumnInput({ baseline: null })),
  "no test load (the app could not load the site)": () => buildLiveTodayColumn(liveColumnInput({ dryLive: null, grades: null, liveChecks: [] })),
  "every tool clean": () =>
    buildLiveTodayColumn(liveColumnInput({ grades: { infinite: grade("infinite", "pass"), ga4: grade("ga4", "pass"), posthog: grade("posthog", "pass"), meta: grade("meta", "pass") }, repeatedInits: [] }))
}
function liveColumnInput(overrides: Partial<LiveTodaySource> = {}) {
  return liveTodayColumnInput(liveSource(overrides))
}

const IN_PR: Record<string, () => ReportColumnSnapshot> = {
  "the contract's run-state in_pr": () => structuredClone(runStateExample.report.in_pr!),
  "a rehearsal that passed": () =>
    buildColumn("in_pr", { runId: RUN_ID, meta: { measuredAt: AT, sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" }, facts: [{ input: "rehearsal.graded", state: "pass", at: AT }], rows: {}, runStartedAt: STARTED_AT })
}

const pass = (id: string): CheckResult => ({ checkId: id, state: "pass", tier: "PV", at: AT, runId: RUN_ID })
const provenInput = (overrides: Partial<Parameters<typeof buildProvenColumn>[0]> = {}): Parameters<typeof buildProvenColumn>[0] => ({
  runId: RUN_ID,
  mergeSha: MERGE_SHA,
    installed: null,
  at: "2026-10-02T09:44:00.000Z",
  keys: keysFixture(),
  expect: { ga4: ["G-ACME000001"], posthog: { projectKey: "phc", apiHost: "https://us.i.posthog.com" }, meta: ["1234567890123456"], infinite: { siteSourceKey: "s", collectPath: "/c" } },
  visit: { result: realVisitResult(), grades: { infinite: pass("a"), ga4: pass("b"), posthog: pass("c"), meta: pass("d") } },
  receipts: receiptsAll(),
  t1: [],
  serverLaneInstalled: true,
  conversionsWaiting: 1,
  runStartedAt: STARTED_AT,
  ...overrides
})
const PROVEN: Record<string, () => ReportColumnSnapshot> = {
  "the real visit proved every tool": () => buildProvenColumn(provenInput()),
  "receipts missing (problems on the live site)": () => buildProvenColumn(provenInput({ receipts: receiptsAll({ infinite: lane("no_receipt"), posthog: lane("no_receipt", null, "posthog_query") }) })),
  "the proof claim was lost (no visit of its own)": () => buildProvenColumn(provenInput({ visit: null }))
}

function stateWith(columns: Partial<Record<ReportColumnId, ReportColumnSnapshot>>): WizardRunState {
  const state = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "r-7f3c" })
  state.runId = RUN_ID
  state.runStartedAt = STARTED_AT
  state.pr = { host: "github", number: 42, url: "https://github.com/acme/acme-store/pull/42", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: columns.proven_live ? MERGE_SHA : null }
  state.report = { live_today: columns.live_today ?? null, in_pr: columns.in_pr ?? null, proven_live: columns.proven_live ?? null }
  state.markers.prove = { infiniteEventIds: ["evt_FAKE0301"], posthogDistinctId: "d", probePath: "/__infinite_probe/7f3c2a91b0de", metaEventIds: [] }
  return state
}

/** Runs the real `done` step and returns every report it posted, with the phase it posted it under. */
async function postedReports(columns: Partial<Record<ReportColumnId, ReportColumnSnapshot>>, noProve: boolean): Promise<Array<{ phase: ReportColumnId; report: ReportV2 }>> {
  const bundle = fakeDeps()
  const outcome = await doneStep.run(fakeContext(stateWith(columns), { noProve }, bundle.clock), bundle.deps)
  expect(outcome.kind).toBe("ok")
  return bundle.log.calls.filter((call) => call.what === "postReport").map((call) => ({ phase: call.args[1] as ReportColumnId, report: call.args[2] as ReportV2 }))
}

describe("every report the wizard can build for the three phases passes the cloud's §3i rules (F17)", () => {
  const cases: Array<{ name: string; columns: Partial<Record<ReportColumnId, () => ReportColumnSnapshot>>; noProve: boolean }> = []
  for (const [liveName, live] of Object.entries(LIVE_TODAY)) {
    cases.push({ name: `live_today only · ${liveName}`, columns: { live_today: live }, noProve: false })
    for (const [prName, inPr] of Object.entries(IN_PR)) {
      cases.push({ name: `live_today + in_pr, waiting for the deploy · ${liveName} · ${prName}`, columns: { live_today: live, in_pr: inPr }, noProve: false })
      cases.push({ name: `live_today + in_pr, --no-prove · ${liveName} · ${prName}`, columns: { live_today: live, in_pr: inPr }, noProve: true })
      for (const [provenName, proven] of Object.entries(PROVEN)) {
        cases.push({ name: `all three · ${liveName} · ${prName} · ${provenName}`, columns: { live_today: live, in_pr: inPr, proven_live: proven }, noProve: false })
      }
    }
  }

  it(`${cases.length} column combinations: each report is posted once per measured column, and the cloud accepts every post`, async () => {
    let posts = 0
    const refused: string[] = []
    for (const entry of cases) {
      const columns = Object.fromEntries(Object.entries(entry.columns).map(([column, build]) => [column, build()])) as Partial<Record<ReportColumnId, ReportColumnSnapshot>>
      const reports = await postedReports(columns, entry.noProve)
      expect(reports.map((post) => post.phase)).toEqual(REPORT_COLUMN_IDS.filter((column) => columns[column]))
      for (const { phase, report } of reports) {
        posts += 1
        expect(report.columns.live_today.sha).toBeNull()
        const verdict = parseCloudReport(report, { runId: RUN_ID, startedAt: STARTED_AT, phase, producer: "tag", partial: false })
        if (!verdict.ok) refused.push(`${entry.name} [${phase}]: ${verdict.field}: ${verdict.reason}`)
      }
    }
    expect(refused).toEqual([])
    expect(posts).toBe(cases.reduce((sum, entry) => sum + Object.keys(entry.columns).length, 0))
  })
})

it("leads cloud and rendered reports with an unwired tag instead of a success claim", () => {
  const report = buildReport({ runId: example.runId, tagVersion: "0.0.0", site: example.site, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { tagNotInstalled: true, jobs: [], openFindings: [], tools: null, installedUnknown: null } })
  expect(report.verdict?.state).toBe("not_checked_live")
  expect(report.verdict?.headline).toContain("NOT installed")
  expect(renderMarkdown(report).split("\n")[0]).toContain("NOT installed")
  expect(renderTerminal(report, 80)).toContain("NOT installed")
})
