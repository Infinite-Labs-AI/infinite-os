import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  FINISH_LINE_IDS,
  REPORT_COLUMN_IDS,
  REPORT_ROW_IDS,
  type Cell,
  type ReportColumnId,
  type ReportColumnSnapshot,
  type ReportV2
} from "./contracts/report.js"
import {
  ReportRuleError,
  buildColumn,
  checksPassingCell,
  createReportBuilder,
  formatShare,
  renderMarkdown,
  renderTerminal,
  type ColumnFact
} from "./report.js"

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const AT = "2026-10-02T09:13:00.000Z"
const here = dirname(fileURLToPath(import.meta.url))
const example = JSON.parse(readFileSync(join(here, "../../contracts/tag-wizard-v1/report-v2.example.json"), "utf8")) as ReportV2

/** The example report's columns as the run state keeps them between steps. */
function snapshotsOf(report: ReportV2): Record<ReportColumnId, ReportColumnSnapshot> {
  const out = {} as Record<ReportColumnId, ReportColumnSnapshot>
  for (const column of REPORT_COLUMN_IDS) {
    out[column] = {
      meta: { measuredAt: report.columns[column].measuredAt, sha: report.columns[column].sha },
      cells: Object.fromEntries(report.rows.filter((row) => row.id !== "day7_checkin").map((row) => [row.id, row.cells[column]])),
      finishLine: Object.fromEntries(report.finishLine.map((line) => [line.id, line.cells[column]]))
    }
  }
  return out
}

const builder = createReportBuilder(() => new Date("2026-10-02T09:45:00.000Z"))
const buildFrom = (columns: Partial<Record<ReportColumnId, ReportColumnSnapshot | null>>) =>
  builder.build({
    runId: RUN,
    tagVersion: "0.12.0",
    site: { repoLabel: "github.com/acme/acme-store", productionHost: "www.acme-store.com" },
    columns: { live_today: columns.live_today ?? null, in_pr: columns.in_pr ?? null, proven_live: columns.proven_live ?? null },
    provenLivePending: null,
    day7: null,
    notes: []
  })

const fact = (input: ColumnFact["input"], state: ColumnFact["state"], extra: Partial<ColumnFact> = {}): ColumnFact => ({ input, state, at: AT, ...extra })

describe("ReportBuilder.build", () => {
  it("rebuilds the F0 example report from its column snapshots and passes every §3i.3 / §3i.7 rule", () => {
    const report = buildFrom(snapshotsOf(example))
    expect(report.rows.map((row) => row.id)).toEqual([...REPORT_ROW_IDS])
    expect(report.finishLine.map((line) => line.id)).toEqual([...FINISH_LINE_IDS])
    for (const row of example.rows) {
      if (row.id === "day7_checkin") continue
      for (const column of REPORT_COLUMN_IDS) {
        expect(report.rows.find((r) => r.id === row.id)!.cells[column]).toEqual(row.cells[column])
      }
    }
    expect(builder.payload(report)).toEqual(report)
  })

  it("a cell with an agent provenance throws (negative)", () => {
    const columns = snapshotsOf(example)
    const bad = structuredClone(columns.in_pr)
    bad.cells.posthog_route = { ...bad.cells.posthog_route!, provenance: { ...bad.cells.posthog_route!.provenance, source: "agent" as never } }
    expect(() => buildFrom({ ...columns, in_pr: bad })).toThrow(/agent output|not allowed/)
  })

  it('"verified" without a receiptAt throws, and another run\'s provenance throws (negatives)', () => {
    const columns = snapshotsOf(example)
    const noReceipt = structuredClone(columns.proven_live)
    const { receiptAt: _drop, ...provenance } = noReceipt.cells.live_test_per_tool!.provenance
    noReceipt.cells.live_test_per_tool = { ...noReceipt.cells.live_test_per_tool!, provenance }
    expect(() => buildFrom({ ...columns, proven_live: noReceipt })).toThrow(/verified/)

    const otherRun = structuredClone(columns.live_today)
    otherRun.cells.meta_pixel = { ...otherRun.cells.meta_pixel!, provenance: { ...otherRun.cells.meta_pixel!.provenance, runId: "00000000-0000-4000-8000-000000000000" } }
    expect(() => buildFrom({ ...columns, live_today: otherRun })).toThrow(/not this run/)
  })

  it("a finish-line cell with a source §3i.7 does not allow throws, and a not-measured cell must stay not measured (negatives)", () => {
    const columns = snapshotsOf(example)
    const wrongSource = structuredClone(columns.live_today)
    wrongSource.finishLine.each_tool_once = { ...wrongSource.finishLine.each_tool_once!, provenance: { ...wrongSource.finishLine.each_tool_once!.provenance, source: "plan_answer" } }
    expect(() => buildFrom({ ...columns, live_today: wrongSource })).toThrow(/§3i.7/)
    const filled = structuredClone(columns.proven_live)
    filled.finishLine.spa_page_views = { value: "pass", display: "pass", state: "pass", provenance: { source: "desktop_test", at: AT, runId: RUN } }
    expect(() => buildFrom({ ...columns, proven_live: filled })).toThrow(/not measured/)
  })

  it("an absent column renders every cell as \"—\" with a reason (the proven column waits for the deploy)", () => {
    const report = builder.build({
      runId: RUN,
      tagVersion: "0.12.0",
      site: { repoLabel: "github.com/acme/acme-store", productionHost: null },
      columns: { live_today: null, in_pr: null, proven_live: null },
      provenLivePending: "deploy",
      day7: null,
      notes: []
    })
    for (const row of report.rows) {
      for (const column of REPORT_COLUMN_IDS) {
        expect(row.cells[column].display).toBe("—")
        expect(row.cells[column].value).toBeNull()
        expect(row.cells[column].reason).toBeTruthy()
      }
    }
    expect(report.rows[0]!.cells.proven_live).toMatchObject({ state: "pending", reason: "pending_deploy" })
  })
})

describe("buildColumn (typed inputs → one column)", () => {
  it('null renders "—" with its reason, never 0', () => {
    const column = buildColumn("live_today", {
      runId: RUN,
      meta: { measuredAt: AT, sha: null },
      facts: [],
      rows: { server_conversions: { value: null, state: "not_measured", source: "cloud_read", at: AT, reason: "read_failed" } }
    })
    expect(column.cells.server_conversions).toMatchObject({ value: null, display: "—", reason: "read_failed" })
    expect(() =>
      buildColumn("live_today", { runId: RUN, meta: { measuredAt: AT, sha: null }, facts: [], rows: { server_conversions: { value: null, state: "not_measured", source: "cloud_read", at: AT } } })
    ).toThrow(/needs one reason/)
  })

  it("below 50 page views shows raw counts, never a percentage (negative: a % display below the floor throws)", () => {
    expect(formatShare(3, 41)).toBe("3 of 41")
    expect(formatShare(9, 100)).toBe("9%")
    const column = buildColumn("live_today", {
      runId: RUN,
      meta: { measuredAt: AT, sha: null },
      facts: [],
      rows: { preview_share: { value: "3 of 41", state: "problem", source: "cloud_read", at: AT, raw: { numerator: 3, denominator: 41 } } }
    })
    expect(column.cells.preview_share).toMatchObject({ display: "3 of 41", reason: "below_sample_floor" })
    expect(() =>
      buildColumn("live_today", {
        runId: RUN,
        meta: { measuredAt: AT, sha: null },
        facts: [],
        rows: { preview_share: { value: "7%", display: "7% of page views", state: "problem", source: "cloud_read", at: AT, raw: { numerator: 3, denominator: 41 } } }
      })
    ).toThrow(/percentage below/)
  })

  it("computes each finish-line cell ONLY from its §3i.7 inputs; an absent input is not measured and leaves N", () => {
    const column = buildColumn("live_today", {
      runId: RUN,
      meta: { measuredAt: AT, sha: null },
      facts: [
        fact("dry_live.graded", "pass"),
        fact("census", "problem", { display: "GA4 configured twice" }),
        fact("t1.csp", "pass"),
        // An input §3i.7 does not name for live_today's `no_pii` (rehearsal facts belong to in_pr): ignored there.
        fact("rehearsal.pii", "problem")
      ],
      rows: {}
    })
    expect(column.finishLine.each_tool_once).toMatchObject({ state: "problem", display: "GA4 configured twice", provenance: { source: "wizard_check" } })
    expect(column.finishLine.csp_allows).toMatchObject({ state: "pass", provenance: { source: "wizard_check" } })
    expect(column.finishLine.no_pii).toMatchObject({ state: "not_measured", value: null, display: "—" })
    expect(column.cells.checks_passing).toMatchObject({ value: "1/2", display: "1 pass · 1 problem · 0 unknown of 2 determinable", state: "problem" })
  })

  it("N determinable: undetermined and pending count as unknown; not measured and info do not count", () => {
    const cell = checksPassingCell(
      {
        each_tool_once: { value: "pass", display: "pass", state: "pass", provenance: { source: "desktop_test", at: AT, runId: RUN } },
        ids_match_connections: { value: "unknown", display: "unknown", state: "undetermined", provenance: { source: "desktop_test", at: AT, runId: RUN } },
        conversions_server_side: { value: null, display: "—", state: "pending", provenance: { source: "cloud_read", at: AT, runId: RUN }, reason: "needs_7_days" },
        ga4_key_events_received: { value: "info", display: "info", state: "info", provenance: { source: "cloud_read", at: AT, runId: RUN } },
        spa_page_views: { value: null, display: "—", state: "not_measured", provenance: { source: "wizard_check", at: AT, runId: RUN }, reason: "not_exercised" }
      } as Partial<Record<(typeof FINISH_LINE_IDS)[number], Cell>>,
      RUN,
      AT
    )
    expect(cell).toMatchObject({ value: "1/3", display: "1 pass · 0 problems · 2 unknown of 3 determinable", state: "undetermined" })
  })

  it("refuses an agent-shaped input: an unknown input id, or a 'verified' reading with no receipt (negatives)", () => {
    expect(() => buildColumn("live_today", { runId: RUN, meta: { measuredAt: AT, sha: null }, facts: [fact("agent.claim" as never, "pass")], rows: {} })).toThrow(/not a finish-line input/)
    expect(() =>
      buildColumn("proven_live", { runId: RUN, meta: { measuredAt: AT, sha: "f".repeat(40) }, facts: [fact("receipts.per_tool", "pass", { display: "verified" })], rows: {} })
    ).toThrow(/without a receipt/)
  })

  it("the in_pr column is keyed to the PR head (negative: no sha throws)", () => {
    expect(() => buildColumn("in_pr", { runId: RUN, meta: { measuredAt: AT, sha: null }, facts: [], rows: {} })).toThrow(ReportRuleError)
  })
})

describe("renderers", () => {
  const report = buildFrom(snapshotsOf(example))

  it("markdown uses plain-text statuses and never a checkbox, and escapes table pipes", () => {
    const markdown = renderMarkdown(report)
    expect(markdown).not.toContain("- [ ]")
    expect(markdown).toContain("| | Live site today | In this pull request | Proven live |")
    expect(markdown).toContain("**7 days later:**")
    expect(markdown).toContain("4 of 4 fire: 2 verified (receipts from this visit)")
    const piped = structuredClone(report)
    piped.rows[1]!.cells.live_today.display = "a | b"
    expect(renderMarkdown(piped)).toContain("a \\| b")
  })

  it("the terminal table fits the width: three columns at 120, stacked below 100", () => {
    const wide = renderTerminal(report, 120)
    for (const line of wide.split("\n")) expect(line.length).toBeLessThanOrEqual(120)
    expect(wide).toContain("Live site today")
    expect(wide.split("\n").find((line) => line.startsWith("GA4 page views per visit"))).toContain("2 (counts every visit twice)")
    const narrow = renderTerminal(report, 70)
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(70)
    expect(narrow).toContain("  Proven live: ")
    expect(narrow).toContain("7 days later: —")
  })
})
