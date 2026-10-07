import { buildPrBody } from "../review/post.js"
import { createScanner } from "../review/scan.js"
import { item } from "../../test/wizard/repo.js"
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

  it("an absent column renders every cell as \"—\" with a reason (the proven column waits for the deploy)", () => {
    const report = builder.build({
      runId: RUN,
      tagVersion: "0.12.0",
      site: { repoLabel: "github.com/acme/acme-store", productionHost: null },
      columns: { live_today: null, in_pr: null, proven_live: null },
      provenLivePending: "deploy",
      day7: null,
      notes: [], verdictFacts: null
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

  it("review-2 P3-7: a missing Proven live column pending rerun_tag reads \"—\" not exercised, never \"open Infinite\"", () => {
    const report = builder.build({
      runId: RUN,
      tagVersion: "0.12.0",
      site: { repoLabel: "github.com/acme/acme-store", productionHost: null },
      columns: { live_today: null, in_pr: null, proven_live: null },
      provenLivePending: "rerun_tag",
      day7: null,
      notes: [], verdictFacts: null
    })
    expect(report.columns.proven_live.pending).toBe("rerun_tag")
    for (const row of report.rows) {
      if (row.id === "day7_checkin") continue
      expect(row.cells.proven_live, row.id).toMatchObject({ display: "—", value: null, state: "not_measured", reason: "not_exercised" })
    }
    const each = report.finishLine.find((line) => line.id === "each_tool_once")!.cells.proven_live
    expect(each).toMatchObject({ display: "—", state: "not_measured", reason: "not_exercised" })
    // NEGATIVE: nothing in the report sends the user to the app.
    expect(JSON.stringify(report)).not.toContain("pending_open_infinite")
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
    expect(column.cells.checks_passing).toMatchObject({ value: "1/2", display: "1 pass · 1 problem · 11 not testable of 13", state: "problem" })
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
    expect(cell).toMatchObject({ value: "1/3", display: "1 pass · 0 problems · 2 unknown · 10 not testable of 13", state: "undetermined" })
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

  it("round 3: with no proven column yet, a pending-by-design cell keeps its own reason (the cloud refuses ga4 key events with any other)", () => {
    const snapshots = snapshotsOf(example)
    for (const pending of ["deploy", "open_infinite"] as const) {
      const report = builder.build({
        runId: RUN,
        tagVersion: "0.12.0",
        site: { repoLabel: "github.com/acme/acme-store", productionHost: "www.acme-store.com" },
        columns: { live_today: snapshots.live_today, in_pr: snapshots.in_pr, proven_live: null },
        provenLivePending: pending,
        day7: null,
        notes: [], verdictFacts: null
      })
      const proven = (id: string) => report.finishLine.find((line) => line.id === id)!.cells.proven_live
      expect(proven("ga4_key_events_received")).toMatchObject({ value: null, state: "pending", reason: "needs_7_days", provenance: { source: "cloud_read" } })
      expect(proven("conversions_server_side")).toMatchObject({ state: "pending", reason: "waiting_real_event" })
      // negative: a cell that is not pending by design still says what the column waits for.
      expect(proven("each_tool_once")).toMatchObject({ state: "pending", reason: pending === "deploy" ? "pending_deploy" : "pending_open_infinite" })
    }
  })

  it("F17: the live_today column has no commit SHA (§3i.1; the cloud refuses any other value)", () => {
    const base = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d"
    expect(buildColumn("live_today", { runId: RUN, meta: { measuredAt: AT, sha: null }, facts: [], rows: {} }).meta.sha).toBeNull()
    // negative: the branch's base commit in the column meta is refused by the column builder…
    expect(() => buildColumn("live_today", { runId: RUN, meta: { measuredAt: AT, sha: base }, facts: [], rows: {} })).toThrow(/live_today\.sha must be null/)
    // …and by the report rules, for a snapshot handed in from a state file and for a report edited after its build.
    const snapshots = snapshotsOf(example)
    expect(() => buildFrom({ ...snapshots, live_today: { ...snapshots.live_today, meta: { measuredAt: AT, sha: base } } })).toThrow(/live_today\.sha must be null/)
    const edited = structuredClone(buildFrom(snapshots))
    edited.columns.live_today.sha = base
    expect(() => builder.payload(edited)).toThrow(/live_today\.sha must be null/)
    // the PR and merge columns: a full 40-hex SHA or null (a short SHA is refused, as the cloud does).
    const short = structuredClone(buildFrom(snapshots))
    short.columns.in_pr.sha = "1a2b3c4"
    expect(() => builder.payload(short)).toThrow(/in_pr\.sha must be a 40-hex/)
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

  it("review P1-3: markdown opens with THE verdict's headline and one line per reason; ungraded says so", () => {
    expect(report.verdict).toBeNull()
    expect(renderMarkdown(report).split("\n")[0]).toBe("**www.acme-store.com: not graded yet · run npx infinite-tag to finish the live checks**")
    const graded = structuredClone(report)
    graded.verdict = {
      state: "problems",
      headline: "acme-store.com does not collect properly yet: 1 approved fix is not in the code (Remove duplicate tags) · Meta pixel sent nothing on the real visit",
      reasons: [
        { kind: "approved_fix_missing", count: 1, names: ["Remove duplicate tags"] },
        { kind: "tool_silent", count: 1, names: ["Meta pixel"] }
      ],
      installed: []
    }
    const lines = renderMarkdown(graded).split("\n")
    expect(lines.slice(0, 5)).toEqual([
      `**${graded.verdict.headline}**`,
      "",
      "- Approved fixes the wizard has not confirmed in the code: Remove duplicate tags",
      "- Sent nothing on the real visit: Meta pixel",
      ""
    ])
    graded.verdict = { state: "properly", headline: "acme-store.com collects analytics properly now", reasons: [], installed: [] }
    expect(renderMarkdown(graded).split("\n").slice(0, 3)).toEqual(["**acme-store.com collects analytics properly now**", "", "This run could not check its own commits against your consent code and policy pages (no wizard commits were measured); please review the changed files."])
  })

  it("the terminal table fits the width: three columns at 160, stacked below 140", () => {
    const wide = renderTerminal(report, 160)
    for (const line of wide.split("\n")) expect(line.length).toBeLessThanOrEqual(160)
    expect(wide).toContain("Live site today")
    expect(wide.split("\n").find((line) => line.startsWith("GA4 page views per visit"))).toContain("2 (counts every visit twice)")
    const narrow = renderTerminal(report, 70)
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(70)
    expect(narrow).toContain("  Proven live: ")
    expect(narrow).toContain("7 days later: —")
  })
})

describe("the before/after wording: 13 analytics checks, consent information excluded, footnotes that match what is shown", () => {
  const report = buildFrom(snapshotsOf(example))
  const outputs = () => [renderMarkdown(report), renderTerminal(report, 160), renderTerminal(report, 120), renderTerminal(report, 70)]

  it("the row is 'Checks passing' and every cell counts 13 analytics checks (never '(of 14)' over 'of 12 determinable')", () => {
    const row = report.rows.find((entry) => entry.id === "checks_passing")!
    expect(row.label).toBe("Checks passing")
    expect(row.cells.live_today.display).toBe("4 pass · 7 problems · 2 not testable of 13")
    expect(row.cells.proven_live.display).toBe("10 pass · 0 problems · 3 unknown of 13")
    // §3i semantics unchanged: the value is pass over the determinable count.
    expect(row.cells.live_today.value).toBe("4/11")
    for (const text of outputs()) {
      expect(text).not.toContain("(of 14)")
      expect(text).not.toContain("determinable")
    }
  })

  it("a raw count below 50 page views is footnoted as shown, once, never as '— / pending' or 'too few to say'", () => {
    const small = report.rows.flatMap((row) => REPORT_COLUMN_IDS.map((column) => row.cells[column])).filter((cell) => cell.reason === "below_sample_floor")
    expect(small.length, "the example shows a raw count below the floor").toBeGreaterThan(0)
    for (const cell of small) expect(cell.value).not.toBeNull()
    const withNote = structuredClone(report)
    withNote.notes = ["Below 50 page views: raw counts shown"]
    for (const text of [...outputs(), renderMarkdown(withNote), renderTerminal(withNote, 120)]) {
      expect(text.split("Below 50 page views: raw counts shown").length - 1, text).toBe(1)
      expect(text).not.toMatch(/pending: (fewer|below) .*50 page views/i)
      expect(text).not.toMatch(/too few page views/i)
    }
  })
})

describe("§3z.8: the tag refuses every cell the cloud parser refuses (review I1 P2-2)", () => {
  const cell = (overrides: Partial<Cell> = {}): Cell => ({ value: "pass", display: "pass", state: "pass", provenance: { source: "wizard_check", at: AT, runId: RUN }, ...overrides })
  const refused = (overrides: Partial<Cell>, startedAt: string | null = null) => cellViolations("c", cell(overrides), RUN, startedAt)

  it("an honest cell passes", () => {
    expect(refused({})).toEqual([])
    expect(refused({ value: "12%", display: "12%", raw: { numerator: 12, denominator: 100 } })).toEqual([])
  })

  it("ASCII arrows (->, <-, =>) and the other arrow blocks are refused, like the Unicode arrow", () => {
    for (const display of ["hop 1 (http://a => b)", "a -> b", "b <- a", "a → b", "a ⟶ b", "a ⤴ b", "a ⬆ b", "▲ 3"]) {
      expect(refused({ display }).join(" "), display).toMatch(/arrows/)
    }
  })

  it("a percentage needs its raw counts, and below 50 shows raw counts", () => {
    expect(refused({ display: "-> 50%" }).join(" ")).toMatch(/raw counts/)
    expect(refused({ display: "50%" }).join(" ")).toMatch(/raw counts/)
    expect(refused({ display: "50%", raw: { numerator: 5, denominator: 10 } }).join(" ")).toMatch(/floor/)
  })

  it("a receipt from before the run started never backs verified/proven", () => {
    const verified = { display: "1 verified", provenance: { source: "cloud_receipt" as const, at: AT, runId: RUN, receiptAt: "2026-10-02T08:00:00.000Z" } }
    expect(refused(verified, "2026-10-02T09:00:00.000Z").join(" ")).toMatch(/before this run started/)
    expect(refused({ ...verified, provenance: { ...verified.provenance, receiptAt: "2026-10-02T09:05:00.000Z" } }, "2026-10-02T09:00:00.000Z")).toEqual([])
  })

  it("lengths, control characters, check ids, and the null/— rules match the cloud", () => {
    expect(refused({ display: "x".repeat(201) }).join(" ")).toMatch(/1–200/)
    expect(refused({ display: "a\u0007b" }).join(" ")).toMatch(/control/)
    expect(refused({ value: "v".repeat(121) }).join(" ")).toMatch(/120/)
    expect(refused({ provenance: { source: "wizard_check", at: AT, runId: RUN, checkId: "Bad Id" } }).join(" ")).toMatch(/check id/)
    expect(refused({ value: "x", display: "—", reason: "not_exercised" }).join(" ")).toMatch(/null value/)
    expect(refused({ value: null, display: "—", reason: "not_exercised", state: "pass" }).join(" ")).toMatch(/never a pass/)
    expect(refused({ value: 3, display: "3", reason: "read_failed", state: "undetermined" }).join(" ")).toMatch(/read nothing/)
  })

  it("buildColumn throws on a fact display the cloud would refuse (so it never reaches the cloud)", () => {
    expect(() => buildColumn("proven_live", { runId: RUN, meta: { measuredAt: AT, sha: "a".repeat(40) }, facts: [{ input: "t1.redirect_walk", state: "pass", display: "hop 1 (http://a => b)", at: AT }], rows: {} })).toThrow(ReportRuleError)
  })
})


it.each(["frozen_unit", "policy_page", "unproven_wiring", "restored_unit"] as const)("describes %s owner work without inventing a restoration", kind => {
  const job = { ...item("unusual_layout:owner", ["app/layout.tsx"]), state: "left_for_you" as const, ownerBoundary: { kind, file: "app/layout.tsx", line: 1 } }
  const report = builder.build({
    runId: RUN, tagVersion: "0.12.0", site: example.site,
    columns: { live_today: null, in_pr: null, proven_live: null },
    provenLivePending: null, day7: null, notes: [],
    verdictFacts: { jobs: [job], openFindings: [], tools: null, installedUnknown: null }
  })
  const restored = kind === "restored_unit"
  expect(report.notes.some(note => note.startsWith("Put back:"))).toBe(restored)
  if (!restored) expect(report.notes).toContain("Not changed by us: app/layout.tsx is left for you.")
})

it("lists every explicit exclusion under You said no to in local and PR report markdown", () => {
  const excluded = Array.from({ length: 25 }, (_, i) => `Excluded action ${i}`)
  const markdown = renderMarkdown(example, undefined, [], excluded)
  expect(markdown).toContain("### You said no to")
  for (const line of excluded) expect(markdown).toContain(`- ${line}`)
  const body = buildPrBody({ reportMarkdown: markdown, howToReview: "Review the files", runId: RUN, isPrivate: true, diffText: "", connectionIds: [], scanner: createScanner({ literals: [], allowedIds: [] }) })
  expect(body).toContain("### You said no to")
  for (const line of excluded) expect(body).toContain(`- ${line}`)
})
