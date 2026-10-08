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
  cellViolations,
  createReportBuilder,
  formatShare,
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
    notes: [], verdictFacts: null
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
    // §3x.6: "SPA page views" and "previews silent" are measured after the deploy now; "proof from a real visit" is
    // still never measured on the live site TODAY.
    const filled = structuredClone(columns.live_today)
    filled.finishLine.proof_from_real_visit = { value: "pass", display: "pass", state: "pass", provenance: { source: "cloud_receipt", at: AT, runId: RUN } }
    expect(() => buildFrom({ ...columns, live_today: filled })).toThrow(/not measured/)
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

  it("refuses an agent-shaped input: an unknown input id, or a 'verified' reading with no receipt (negatives)", () => {
    expect(() => buildColumn("live_today", { runId: RUN, meta: { measuredAt: AT, sha: null }, facts: [fact("agent.claim" as never, "pass")], rows: {} })).toThrow(/not a finish-line input/)
    expect(() =>
      buildColumn("proven_live", { runId: RUN, meta: { measuredAt: AT, sha: "f".repeat(40) }, facts: [fact("receipts.per_tool", "pass", { display: "verified" })], rows: {} })
    ).toThrow(/without a receipt/)
  })
})

describe("§3z.8: the tag refuses every cell the cloud parser refuses (review I1 P2-2)", () => {
  const cell = (overrides: Partial<Cell> = {}): Cell => ({ value: "pass", display: "pass", state: "pass", provenance: { source: "wizard_check", at: AT, runId: RUN }, ...overrides })
  const refused = (overrides: Partial<Cell>, startedAt: string | null = null) => cellViolations("c", cell(overrides), RUN, startedAt)

  it("a receipt from before the run started never backs verified/proven", () => {
    const verified = { display: "1 verified", provenance: { source: "cloud_receipt" as const, at: AT, runId: RUN, receiptAt: "2026-10-02T08:00:00.000Z" } }
    expect(refused(verified, "2026-10-02T09:00:00.000Z").join(" ")).toMatch(/before this run started/)
    expect(refused({ ...verified, provenance: { ...verified.provenance, receiptAt: "2026-10-02T09:05:00.000Z" } }, "2026-10-02T09:00:00.000Z")).toEqual([])
  })

  it("buildColumn throws on a fact display the cloud would refuse (so it never reaches the cloud)", () => {
    expect(() => buildColumn("proven_live", { runId: RUN, meta: { measuredAt: AT, sha: "a".repeat(40) }, facts: [{ input: "t1.redirect_walk", state: "pass", display: "hop 1 (http://a => b)", at: AT }], rows: {} })).toThrow(ReportRuleError)
  })
})

